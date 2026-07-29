import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  durableJobId,
  durableQueueName,
  type CsvImportJobEnvelope,
  type DurableJobEnvelope,
} from "@workspace/connectors";
import {
  PostgresOutboxRelayRepository,
  type OutboxRelayRepository,
  type PendingOutboxEvent,
} from "@workspace/database";
import { OrganizationIdSchema } from "@workspace/domain";
import { Job, Queue } from "bullmq";
import { Redis } from "ioredis";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { relayOutboxBatch } from "./outbox-relay.js";

const environment = "recovery";
const organizationId = OrganizationIdSchema.parse(randomUUID());
const envelope: CsvImportJobEnvelope = {
  schemaVersion: 1,
  type: "csv.import.commit",
  organizationId,
  connectionId: randomUUID(),
  importId: randomUUID(),
  correlationId: randomUUID(),
  idempotencyKey: `csv-import:${randomUUID()}:commit:v1`,
  requestedBy: randomUUID(),
  createdAt: "2026-07-28T12:00:00.000Z",
};
let administrator: Sql | undefined;
let workerDatabase: Sql | undefined;
let redis: Redis | undefined;
let queue: Queue<DurableJobEnvelope> | undefined;

describe("empty Redis reconstruction from the durable outbox", { concurrent: false }, () => {
  beforeAll(async () => {
    const adminUrl = requiredEnvironment("DATABASE_ADMIN_URL");
    const migrationUrl = requiredEnvironment("DATABASE_MIGRATION_URL");
    const workerUrl = requiredEnvironment("DATABASE_WORKER_URL");
    administrator = postgres(adminUrl, { max: 1 });
    await ensureLocalTestRoles(administrator);
    execFileSync("pnpm", ["--filter", "@workspace/database", "db:migrate"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl },
      stdio: "pipe",
    });
    await seedOutbox(administrator);
    workerDatabase = postgres(workerUrl, { max: 1 });

    redis = new Redis(isolatedRedisUrl(requiredEnvironment("REDIS_URL")), {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    await redis.flushdb();
    queue = new Queue<DurableJobEnvelope>(durableQueueName(environment), {
      connection: redis,
    });
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true });
    await queue?.close();
    await redis?.quit();
    await workerDatabase?.end({ timeout: 5 });
    await administrator?.end({ timeout: 5 });
  });

  it("publishes one tenant-bound stable job and does not duplicate it on replay", async () => {
    const durableQueue = requiredQueue();
    const repository = new TenantRecoveryOutboxRepository(
      new PostgresOutboxRelayRepository(requiredConnection(workerDatabase)),
    );
    await expect(durableQueue.getJobCounts()).resolves.toMatchObject({
      active: 0,
      completed: 0,
      delayed: 0,
      failed: 0,
      paused: 0,
      prioritized: 0,
      waiting: 0,
      "waiting-children": 0,
    });

    const first = await relayOutboxBatch(repository, publisher(durableQueue));
    expect(first).toEqual({ examined: 1, published: 1, retried: 0, deadLettered: 0 });

    const jobId = durableJobId(envelope);
    const job = await Job.fromId<DurableJobEnvelope>(durableQueue, jobId);
    expect(job?.id).toBe(jobId);
    expect(job?.data).toEqual(envelope);
    expect(job?.data.organizationId).toBe(organizationId);
    await expect(durableQueue.getJobCounts("wait")).resolves.toEqual({ wait: 1 });

    const second = await relayOutboxBatch(repository, publisher(durableQueue));
    expect(second).toEqual({ examined: 0, published: 0, retried: 0, deadLettered: 0 });
    const duplicate = await durableQueue.add(envelope.type, envelope, { jobId });
    expect(duplicate.id).toBe(jobId);
    await expect(durableQueue.getJobCounts("wait")).resolves.toEqual({ wait: 1 });

    const rows = await requiredConnection(administrator)`
      select attempts, published_at, dead_lettered_at, last_error_code
      from outbox_events
      where organization_id = ${organizationId}
        and idempotency_key = ${envelope.idempotencyKey}
    `;
    expect(rows[0]).toMatchObject({
      attempts: 1,
      dead_lettered_at: null,
      last_error_code: null,
    });
    expect(rows[0]?.["published_at"]).toBeInstanceOf(Date);
  });
});

function publisher(durableQueue: Queue<DurableJobEnvelope>) {
  return {
    publish: async (job: DurableJobEnvelope) => {
      await durableQueue.add(job.type, job, { jobId: durableJobId(job) });
    },
  };
}

class TenantRecoveryOutboxRepository implements OutboxRelayRepository {
  public constructor(private readonly repository: PostgresOutboxRelayRepository) {}

  public async loadPending(limit: number): Promise<readonly PendingOutboxEvent[]> {
    const pending = await this.repository.loadPending(500);
    return pending.filter((event) => event.organizationId === organizationId).slice(0, limit);
  }

  public markPublished(
    requestedOrganizationId: typeof organizationId,
    idempotencyKey: string,
    publishedAt: string,
  ): Promise<boolean> {
    return this.repository.markPublished(requestedOrganizationId, idempotencyKey, publishedAt);
  }

  public markFailed(
    requestedOrganizationId: typeof organizationId,
    idempotencyKey: string,
    errorCode: string,
    nextAttemptAt: string,
    maximumAttempts: number,
  ): Promise<boolean> {
    return this.repository.markFailed(
      requestedOrganizationId,
      idempotencyKey,
      errorCode,
      nextAttemptAt,
      maximumAttempts,
    );
  }
}

function isolatedRedisUrl(value: string): string {
  const url = new URL(value);
  url.pathname = "/14";
  return url.href;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the recovery integration suite`);
  return value;
}

function requiredQueue(): Queue<DurableJobEnvelope> {
  if (!queue) throw new Error("recovery queue was not initialized");
  return queue;
}

function requiredConnection(value: Sql | undefined): Sql {
  if (!value) throw new Error("recovery database connection was not initialized");
  return value;
}

async function seedOutbox(sql: Sql): Promise<void> {
  await sql`
    insert into organizations (id, name)
    values (${organizationId}, 'Outbox Recovery Integration Tenant')
  `;
  await sql`
    insert into outbox_events (
      id, organization_id, event_type, schema_version, idempotency_key, payload, correlation_id
    ) values (
      ${randomUUID()}, ${organizationId}, ${envelope.type}, ${envelope.schemaVersion},
      ${envelope.idempotencyKey}, ${sql.json(envelope)}, ${envelope.correlationId}
    )
  `;
}

async function ensureLocalTestRoles(sql: Sql): Promise<void> {
  const existing = await sql`
    select rolname from pg_roles
    where rolname in ('reconai_migrator', 'reconai_worker')
  `;
  const names = new Set(
    Array.from(existing, (row: unknown) => {
      if (typeof row !== "object" || row === null) throw new Error("invalid role row");
      const value = (row as Record<string, unknown>)["rolname"];
      if (typeof value !== "string") throw new Error("invalid role name");
      return value;
    }),
  );
  if (!names.has("reconai_migrator")) {
    await sql.unsafe(
      "create role reconai_migrator login password 'local-migrator-only' nosuperuser nocreatedb nocreaterole noinherit",
    );
  }
  if (!names.has("reconai_worker")) {
    await sql.unsafe(
      "create role reconai_worker login password 'local-worker-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
    );
  }
  await sql.unsafe("grant connect on database reconai to reconai_migrator, reconai_worker");
  await sql.unsafe("grant create, usage on schema public to reconai_migrator");
  await sql.unsafe("grant usage on schema public to reconai_worker");
}
