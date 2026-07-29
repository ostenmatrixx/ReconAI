import { createHash, randomUUID } from "node:crypto";

import {
  DurableJobEnvelopeSchema,
  durableJobId,
  durableQueueName,
  type DurableJobEnvelope,
} from "@workspace/connectors";
import {
  PostgresJobExecutionRepository,
  type QueueRecoveryClassification,
  type RecoverableQueueEvent,
} from "@workspace/database";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import postgres from "postgres";
import { z } from "zod";

const confirmation = "REBUILD-RECOVERABLE-IN-ISOLATED-REDIS";
const inputSchema = z.object({
  DATABASE_WORKER_URL: z.url(),
  REDIS_URL: z.url(),
  QUEUE_RECOVERY_ENVIRONMENT: z.string(),
  QUEUE_RECOVERY_EXPECTED_DATABASE_SYSTEM_IDENTIFIER: z.string().regex(/^[1-9][0-9]{0,19}$/u),
  QUEUE_RECOVERY_STALE_BEFORE: z.iso.datetime({ offset: true }),
  QUEUE_RECOVERY_REQUESTED_BY: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9@._:/-]{2,99}$/u),
  QUEUE_RECOVERY_REASON: z
    .string()
    .min(20)
    .max(500)
    .refine(
      (value) => !containsControlCharacter(value),
      "recovery reason contains a control character",
    ),
  QUEUE_RECOVERY_CONFIRMATION: z.literal(confirmation),
  QUEUE_RECOVERY_MAXIMUM_EVENTS: z.coerce.number().int().min(1).max(499).optional().default(100),
  QUEUE_RECOVERY_ALLOW_NON_LOOPBACK: z.enum(["true", "false"]).optional().default("false"),
});

const input = inputSchema.parse(process.env);
const databaseUrl = validatedDatabaseUrl(input.DATABASE_WORKER_URL);
const redisUrl = validatedRedisUrl(input.REDIS_URL);
const staleBefore = validatedStaleBefore(input.QUEUE_RECOVERY_STALE_BEFORE);
const allowNonLoopback = input.QUEUE_RECOVERY_ALLOW_NON_LOOPBACK === "true";
if (!allowNonLoopback) {
  assertLoopback(databaseUrl);
  assertLoopback(redisUrl);
} else if (
  redisUrl.protocol !== "rediss:" ||
  databaseUrl.searchParams.get("sslmode") !== "verify-full"
) {
  throw new Error(
    "approved non-loopback queue recovery requires Redis TLS and PostgreSQL verify-full",
  );
}

const queueName = durableQueueName(input.QUEUE_RECOVERY_ENVIRONMENT);
const database = postgres(databaseUrl.href, {
  max: 1,
  connect_timeout: 5,
  idle_timeout: 5,
});
const redis = new Redis(redisUrl.href, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: true,
  connectTimeout: 5000,
  commandTimeout: 5000,
  enableOfflineQueue: false,
});
const repository = new PostgresJobExecutionRepository(database);
let queue: Queue<DurableJobEnvelope> | undefined;

try {
  const systemIdentifier = await databaseSystemIdentifier(database);
  if (systemIdentifier !== input.QUEUE_RECOVERY_EXPECTED_DATABASE_SYSTEM_IDENTIFIER) {
    throw new Error(
      "queue recovery database system identifier does not match the approved restore",
    );
  }

  await redis.connect();
  const redisKeysBefore = await redis.dbsize();
  if (redisKeysBefore !== 0) {
    throw new Error("queue recovery requires a completely empty isolated Redis database");
  }

  const summary = await repository.summarizeRecovery(staleBefore);
  const candidates = await repository.loadRecoverable(
    input.QUEUE_RECOVERY_MAXIMUM_EVENTS + 1,
    staleBefore,
  );
  if (candidates.length === 0) {
    throw new Error("restored database has no safely classified queue work eligible for recovery");
  }
  if (candidates.length > input.QUEUE_RECOVERY_MAXIMUM_EVENTS) {
    throw new Error("recoverable queue work exceeds the approved recovery batch limit");
  }

  const envelopes = candidates.map(validateRecoveryAuthority);
  const jobIds = envelopes.map((envelope) => durableJobId(envelope));
  if (new Set(jobIds).size !== jobIds.length) {
    throw new Error("recoverable queue work does not have unique stable queue identities");
  }

  queue = new Queue<DurableJobEnvelope>(queueName, {
    connection: redis,
    defaultJobOptions: {
      attempts: 6,
      backoff: { type: "custom" },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: false,
    },
  });
  const recoveryRunId = randomUUID();
  for (const [index, event] of candidates.entries()) {
    const envelope = requiredEnvelope(envelopes[index]);
    const jobId = requiredJobId(jobIds[index]);
    await requiredQueue(queue).add(envelope.type, envelope, { jobId });
    const recorded = await repository.recordRecovery({
      recoveryRunId,
      event,
      jobId,
      requestedBy: input.QUEUE_RECOVERY_REQUESTED_BY,
      reason: input.QUEUE_RECOVERY_REASON,
      staleBefore,
    });
    if (!recorded) {
      throw new Error("queue recovery event could not be recorded exactly once");
    }
  }

  for (const envelope of envelopes) {
    const duplicate = await requiredQueue(queue).add(envelope.type, envelope, {
      jobId: durableJobId(envelope),
    });
    if (duplicate.id !== durableJobId(envelope)) {
      throw new Error("stable queue identity was not preserved during duplicate recovery replay");
    }
  }

  const queueCounts = await requiredQueue(queue).getJobCounts(
    "wait",
    "active",
    "completed",
    "delayed",
    "failed",
    "paused",
    "prioritized",
    "waiting-children",
  );
  assertRecoveredQueueCounts(queueCounts, candidates.length);
  const classificationCounts = countClassifications(candidates);
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        queueName,
        restoredDatabaseSystemIdentifier: systemIdentifier,
        redisDatabase: redisUrl.pathname.slice(1),
        redisKeysBefore,
        preflight: {
          approvedEvents: candidates.length,
          classificationCounts,
          ledgerSummary: summary,
        },
        stableJobIdSetSha256: sha256([...jobIds].sort().join("\n")),
        recoveryRunIdSha256: sha256(recoveryRunId),
        recordedRecoveryEvents: candidates.length,
        duplicateReplayCount: envelopes.length,
        queueCounts,
        organizationIdsRecorded: false,
        jobIdsRecorded: false,
        payloadsRecorded: false,
        requestedByRecordedInOutput: false,
        reasonRecordedInOutput: false,
        credentialsRecorded: false,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await queue?.close();
  await Promise.all([
    redis.status === "end" || redis.status === "wait" ? Promise.resolve() : redis.quit(),
    database.end({ timeout: 5 }),
  ]);
}

function validateRecoveryAuthority(event: RecoverableQueueEvent): DurableJobEnvelope {
  const parsed = DurableJobEnvelopeSchema.safeParse(event.payload);
  if (
    !parsed.success ||
    parsed.data.organizationId !== event.organizationId ||
    parsed.data.type !== event.eventType ||
    parsed.data.schemaVersion !== event.schemaVersion ||
    parsed.data.idempotencyKey !== event.idempotencyKey ||
    parsed.data.correlationId !== event.correlationId
  ) {
    throw new Error("recoverable queue event failed its tenant-bound durable authority check");
  }
  return parsed.data;
}

function countClassifications(
  events: readonly RecoverableQueueEvent[],
): Readonly<Record<QueueRecoveryClassification, number>> {
  const counts: Record<QueueRecoveryClassification, number> = {
    unpublished: 0,
    never_started: 0,
    retryable: 0,
    stale_running: 0,
  };
  for (const event of events) counts[event.classification] += 1;
  return counts;
}

function assertRecoveredQueueCounts(
  counts: Readonly<Record<string, number>>,
  expectedWaiting: number,
): void {
  if (
    counts["wait"] !== expectedWaiting ||
    ["active", "completed", "delayed", "failed", "paused", "prioritized", "waiting-children"].some(
      (status) => counts[status] !== 0,
    )
  ) {
    throw new Error("recovered queue state does not match the approved waiting-job set");
  }
}

async function databaseSystemIdentifier(sql: ReturnType<typeof postgres>): Promise<string> {
  const rows = await sql`select system_identifier::text from pg_control_system()`;
  return z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/u)
    .parse(rows[0]?.["system_identifier"]);
}

function validatedDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.hash) {
    throw new Error("queue recovery database URL must use PostgreSQL");
  }
  if (!url.pathname || url.pathname === "/") {
    throw new Error("queue recovery database URL must identify an isolated restored database");
  }
  return url;
}

function validatedRedisUrl(value: string): URL {
  const url = new URL(value);
  if (!["redis:", "rediss:"].includes(url.protocol) || !url.hostname || url.hash || url.search) {
    throw new Error("queue recovery Redis URL must use Redis without query or fragment data");
  }
  if (!/^\/(?:[1-9]|1[0-5])$/u.test(url.pathname)) {
    throw new Error(
      "queue recovery requires an explicit isolated Redis database from 1 through 15",
    );
  }
  return url;
}

function validatedStaleBefore(value: string): string {
  const parsed = z.iso.datetime({ offset: true }).parse(value);
  if (Date.parse(parsed) > Date.now() - 15 * 60 * 1000) {
    throw new Error("queue recovery stale boundary must be at least 15 minutes old");
  }
  return parsed;
}

function assertLoopback(url: URL): void {
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(
      "queue recovery defaults to loopback; explicitly allow an approved non-loopback drill",
    );
  }
}

function requiredQueue(value: Queue<DurableJobEnvelope> | undefined): Queue<DurableJobEnvelope> {
  if (!value) throw new Error("queue recovery queue was not initialized");
  return value;
}

function requiredEnvelope(value: DurableJobEnvelope | undefined): DurableJobEnvelope {
  if (!value) throw new Error("queue recovery envelope index was unavailable");
  return value;
}

function requiredJobId(value: string | undefined): string {
  if (!value) throw new Error("queue recovery job identity index was unavailable");
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) return true;
  }
  return false;
}
