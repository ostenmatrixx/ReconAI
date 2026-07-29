import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { DurableJobEnvelope } from "@workspace/connectors";
import { DurableJobEnvelopeSchema } from "@workspace/connectors";
import { OrganizationIdSchema, type OrganizationId } from "@workspace/domain";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const queueNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,99}$/u);
const executionOutcomeSchema = z.enum(["acquired", "already_succeeded", "dead_lettered", "busy"]);
const executionFailureStatusSchema = z.enum(["retryable", "dead_lettered"]);
const recoveryClassificationSchema = z.enum([
  "unpublished",
  "never_started",
  "retryable",
  "stale_running",
]);
const requestedBySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9@._:/-]{2,99}$/u);
const recoveryReasonSchema = z
  .string()
  .min(20)
  .max(500)
  .refine((value) => !containsControlCharacter(value), "reason contains a control character");
const errorCodeSchema = z.string().regex(/^[A-Z0-9_]{1,100}$/u);
const leaseSecondsSchema = z.number().int().min(60).max(3600);
const maximumAttemptsSchema = z.number().int().min(1).max(100);
const recoveryLimitSchema = z.number().int().min(1).max(500);
const canonicalTimestampSchema = z.iso.datetime({ offset: true });

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) return true;
  }
  return false;
}

export type JobExecutionBeginOutcome = z.infer<typeof executionOutcomeSchema>;
export type JobExecutionFailureStatus = z.infer<typeof executionFailureStatusSchema>;
export type QueueRecoveryClassification = z.infer<typeof recoveryClassificationSchema>;

export interface JobExecutionAuthority {
  readonly envelope: DurableJobEnvelope;
  readonly queueName: string;
  readonly jobId: string;
  readonly maximumAttempts: number;
  readonly leaseSeconds: number;
}

export interface AcquiredJobExecution {
  readonly outcome: "acquired";
  readonly token: string;
}

export interface NonAcquiredJobExecution {
  readonly outcome: Exclude<JobExecutionBeginOutcome, "acquired">;
}

export type JobExecutionBeginResult = AcquiredJobExecution | NonAcquiredJobExecution;

export interface RecoverableQueueEvent {
  readonly organizationId: OrganizationId;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly correlationId: string;
  readonly classification: QueueRecoveryClassification;
}

export interface QueueRecoverySummary {
  readonly recoverableUnpublished: number;
  readonly recoverableNeverStarted: number;
  readonly recoverableRetryable: number;
  readonly recoverableStaleRunning: number;
  readonly legacyUnclassified: number;
  readonly activeRunning: number;
  readonly succeeded: number;
  readonly deadLettered: number;
}

export interface QueueRecoveryEvidenceInput {
  readonly recoveryRunId: string;
  readonly event: RecoverableQueueEvent;
  readonly jobId: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly staleBefore: string;
}

export interface JobExecutionLedger {
  begin(input: JobExecutionAuthority): Promise<JobExecutionBeginResult>;
  heartbeat(input: {
    readonly organizationId: OrganizationId;
    readonly idempotencyKey: string;
    readonly token: string;
    readonly leaseSeconds: number;
  }): Promise<boolean>;
  succeed(input: {
    readonly organizationId: OrganizationId;
    readonly idempotencyKey: string;
    readonly token: string;
  }): Promise<boolean>;
  fail(input: {
    readonly organizationId: OrganizationId;
    readonly idempotencyKey: string;
    readonly token: string;
    readonly errorCode: string;
    readonly terminal: boolean;
  }): Promise<JobExecutionFailureStatus>;
}

export class PostgresJobExecutionRepository implements JobExecutionLedger {
  public constructor(private readonly sql: Sql) {}

  public async begin(input: JobExecutionAuthority): Promise<JobExecutionBeginResult> {
    const envelope = DurableJobEnvelopeSchema.parse(input.envelope);
    const queueName = queueNameSchema.parse(input.queueName);
    const jobId = sha256Schema.parse(input.jobId);
    const maximumAttempts = maximumAttemptsSchema.parse(input.maximumAttempts);
    const leaseSeconds = leaseSecondsSchema.parse(input.leaseSeconds);
    const token = randomBytes(32).toString("base64url");
    const tokenSha256 = sha256(token);
    const outcome = await withOrganizationTransaction(
      this.sql,
      envelope.organizationId,
      async (transaction) => {
        const rows = await transaction`
          select reconai_begin_job_execution(
            ${envelope.organizationId},
            ${envelope.idempotencyKey},
            ${envelope.type},
            ${envelope.schemaVersion},
            ${queueName},
            ${jobId},
            ${envelope.correlationId},
            ${tokenSha256},
            ${maximumAttempts},
            ${leaseSeconds}
          ) as outcome
        `;
        return executionOutcomeSchema.parse(rows[0]?.["outcome"]);
      },
    );
    return outcome === "acquired" ? { outcome, token } : { outcome };
  }

  public async heartbeat(input: {
    readonly organizationId: OrganizationId;
    readonly idempotencyKey: string;
    readonly token: string;
    readonly leaseSeconds: number;
  }): Promise<boolean> {
    const organizationId = OrganizationIdSchema.parse(input.organizationId);
    const idempotencyKey = z.string().min(1).max(500).parse(input.idempotencyKey);
    const tokenSha256 = sha256(validatedToken(input.token));
    const leaseSeconds = leaseSecondsSchema.parse(input.leaseSeconds);
    return withOrganizationTransaction(this.sql, organizationId, async (transaction) => {
      const rows = await transaction`
        select reconai_heartbeat_job_execution(
          ${organizationId},
          ${idempotencyKey},
          ${tokenSha256},
          ${leaseSeconds}
        ) as changed
      `;
      return databaseBoolean(rows[0]?.["changed"], "job execution heartbeat result");
    });
  }

  public async succeed(input: {
    readonly organizationId: OrganizationId;
    readonly idempotencyKey: string;
    readonly token: string;
  }): Promise<boolean> {
    const organizationId = OrganizationIdSchema.parse(input.organizationId);
    const idempotencyKey = z.string().min(1).max(500).parse(input.idempotencyKey);
    const tokenSha256 = sha256(validatedToken(input.token));
    return withOrganizationTransaction(this.sql, organizationId, async (transaction) => {
      const rows = await transaction`
        select reconai_complete_job_execution(
          ${organizationId},
          ${idempotencyKey},
          ${tokenSha256}
        ) as changed
      `;
      return databaseBoolean(rows[0]?.["changed"], "job execution completion result");
    });
  }

  public async fail(input: {
    readonly organizationId: OrganizationId;
    readonly idempotencyKey: string;
    readonly token: string;
    readonly errorCode: string;
    readonly terminal: boolean;
  }): Promise<JobExecutionFailureStatus> {
    const organizationId = OrganizationIdSchema.parse(input.organizationId);
    const idempotencyKey = z.string().min(1).max(500).parse(input.idempotencyKey);
    const tokenSha256 = sha256(validatedToken(input.token));
    const errorCode = errorCodeSchema.parse(input.errorCode);
    return withOrganizationTransaction(this.sql, organizationId, async (transaction) => {
      const rows = await transaction`
        select reconai_fail_job_execution(
          ${organizationId},
          ${idempotencyKey},
          ${tokenSha256},
          ${errorCode},
          ${input.terminal}
        ) as status
      `;
      return executionFailureStatusSchema.parse(rows[0]?.["status"]);
    });
  }

  public async loadRecoverable(
    limitInput: number,
    staleBeforeInput: string,
  ): Promise<readonly RecoverableQueueEvent[]> {
    const limit = recoveryLimitSchema.parse(limitInput);
    const staleBefore = validatedStaleBefore(staleBeforeInput);
    const rows = await this.sql`
      select *
      from reconai_recoverable_queue_events(
        ${limit},
        ${staleBefore}::timestamptz
      )
    `;
    return rows.map((value) => {
      const row = databaseRow(value);
      return {
        organizationId: OrganizationIdSchema.parse(row["organization_id"]),
        eventType: z
          .string()
          .regex(/^[a-z0-9._/-]{1,100}$/u)
          .parse(row["event_type"]),
        schemaVersion: databaseInteger(row["schema_version"], "queue recovery schema version"),
        idempotencyKey: z.string().min(1).max(500).parse(row["idempotency_key"]),
        payload: row["payload"],
        correlationId: z.uuid().parse(row["correlation_id"]),
        classification: recoveryClassificationSchema.parse(row["classification"]),
      };
    });
  }

  public async summarizeRecovery(staleBeforeInput: string): Promise<QueueRecoverySummary> {
    const staleBefore = validatedStaleBefore(staleBeforeInput);
    const rows = await this.sql`
      select *
      from reconai_queue_recovery_summary(${staleBefore}::timestamptz)
    `;
    const row = databaseRow(rows[0]);
    return {
      recoverableUnpublished: databaseCount(
        row["recoverable_unpublished"],
        "recoverable unpublished count",
      ),
      recoverableNeverStarted: databaseCount(
        row["recoverable_never_started"],
        "recoverable never-started count",
      ),
      recoverableRetryable: databaseCount(
        row["recoverable_retryable"],
        "recoverable retryable count",
      ),
      recoverableStaleRunning: databaseCount(
        row["recoverable_stale_running"],
        "recoverable stale-running count",
      ),
      legacyUnclassified: databaseCount(row["legacy_unclassified"], "legacy unclassified count"),
      activeRunning: databaseCount(row["active_running"], "active running count"),
      succeeded: databaseCount(row["succeeded"], "succeeded count"),
      deadLettered: databaseCount(row["dead_lettered"], "dead-lettered count"),
    };
  }

  public async recordRecovery(input: QueueRecoveryEvidenceInput): Promise<boolean> {
    const recoveryRunId = z.uuid().parse(input.recoveryRunId);
    const event = recoverableQueueEventSchema.parse(input.event);
    const jobId = sha256Schema.parse(input.jobId);
    const requestedBy = requestedBySchema.parse(input.requestedBy);
    const reason = recoveryReasonSchema.parse(input.reason);
    const staleBefore = validatedStaleBefore(input.staleBefore);
    const rows = await this.sql`
      select reconai_record_queue_recovery(
        ${randomUUID()},
        ${recoveryRunId},
        ${event.organizationId},
        ${event.idempotencyKey},
        ${event.classification},
        ${jobId},
        ${requestedBy},
        ${reason},
        ${staleBefore}::timestamptz
      ) as inserted
    `;
    return databaseBoolean(rows[0]?.["inserted"], "queue recovery evidence result");
  }
}

const recoverableQueueEventSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    eventType: z.string().regex(/^[a-z0-9._/-]{1,100}$/u),
    schemaVersion: z.number().int().min(1).max(100),
    idempotencyKey: z.string().min(1).max(500),
    payload: z.unknown(),
    correlationId: z.uuid(),
    classification: recoveryClassificationSchema,
  })
  .strict();

async function withOrganizationTransaction<T>(
  sql: Sql,
  organizationIdInput: OrganizationId,
  operation: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  const organizationId = OrganizationIdSchema.parse(organizationIdInput);
  return sql.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
    const established =
      await transaction`select current_setting('app.organization_id', true) as organization_id`;
    if (established[0]?.["organization_id"] !== organizationId) {
      throw new Error("database tenant context was not established for job execution");
    }
    return operation(transaction);
  }) as Promise<T>;
}

function validatedToken(value: string): string {
  return z
    .string()
    .length(43)
    .regex(/^[A-Za-z0-9_-]{43}$/u)
    .parse(value);
}

function validatedStaleBefore(value: string): string {
  const parsed = canonicalTimestampSchema.parse(value);
  if (Date.parse(parsed) > Date.now() - 15 * 60 * 1000) {
    throw new TypeError("queue recovery stale boundary must be at least 15 minutes old");
  }
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function databaseRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("database returned an invalid queue recovery row");
  }
  return value as Record<string, unknown>;
}

function databaseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`database returned an invalid ${field}`);
  return value;
}

function databaseInteger(value: unknown, field: string): number {
  const parsed = z.coerce.number().int().min(1).max(100).safeParse(value);
  if (!parsed.success) throw new Error(`database returned an invalid ${field}`);
  return parsed.data;
}

function databaseCount(value: unknown, field: string): number {
  const parsed = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).safeParse(value);
  if (!parsed.success) throw new Error(`database returned an invalid ${field}`);
  return parsed.data;
}
