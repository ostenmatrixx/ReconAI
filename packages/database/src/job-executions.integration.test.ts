import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  CsvImportJobEnvelopeSchema,
  durableJobId,
  durableQueueName,
  type CsvImportJobEnvelope,
} from "@workspace/connectors";
import { OrganizationIdSchema } from "@workspace/domain";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresJobExecutionRepository, type RecoverableQueueEvent } from "./job-executions.js";

const organizationId = OrganizationIdSchema.parse(randomUUID());
const foreignOrganizationId = OrganizationIdSchema.parse(randomUUID());
const queueName = durableQueueName("integration");
const staleBefore = "2026-07-28T10:00:00.000Z";
const recoveryReason = "Rebuild classified synthetic work after isolated Redis loss.";
const recoveryRequestedBy = "integration-recovery-operator";
const keys = {
  lifecycle: `csv-import:${randomUUID()}:commit:v1`,
  unpublished: `csv-import:${randomUUID()}:commit:v1`,
  neverStarted: `csv-import:${randomUUID()}:commit:v1`,
  retryable: `csv-import:${randomUUID()}:commit:v1`,
  staleRunning: `csv-import:${randomUUID()}:commit:v1`,
  activeRunning: `csv-import:${randomUUID()}:commit:v1`,
  deadLettered: `csv-import:${randomUUID()}:commit:v1`,
  legacyUnclassified: `csv-import:${randomUUID()}:commit:v1`,
} as const;
const envelopes = Object.fromEntries(
  Object.entries(keys).map(([name, idempotencyKey]) => [name, envelope(idempotencyKey)]),
) as Record<keyof typeof keys, CsvImportJobEnvelope>;
const outboxIds = Object.fromEntries(
  Object.keys(keys).map((name) => [name, randomUUID()]),
) as Record<keyof typeof keys, string>;
let administrator: Sql | undefined;
let application: Sql | undefined;
let worker: Sql | undefined;

describe("durable job execution and queue recovery ledger", { concurrent: false }, () => {
  beforeAll(async () => {
    const adminUrl = requiredEnvironment("DATABASE_ADMIN_URL");
    const migrationUrl = requiredEnvironment("DATABASE_MIGRATION_URL");
    const applicationUrl = requiredEnvironment("DATABASE_URL");
    const workerUrl = requiredEnvironment("DATABASE_WORKER_URL");
    administrator = postgres(adminUrl, { max: 1 });
    await ensureLocalTestRoles(administrator);
    execFileSync("pnpm", ["--filter", "@workspace/database", "db:migrate"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl },
      stdio: "pipe",
    });
    await seedRecoveryStates(administrator);
    application = postgres(applicationUrl, { max: 1 });
    worker = postgres(workerUrl, { max: 1 });
  });

  afterAll(async () => {
    await worker?.end({ timeout: 5 });
    await application?.end({ timeout: 5 });
    await administrator?.end({ timeout: 5 });
  });

  it("acquires one tenant lease and makes successful execution terminal", async () => {
    const repository = new PostgresJobExecutionRepository(requiredConnection(worker, "worker"));
    const authority = {
      envelope: envelopes.lifecycle,
      queueName,
      jobId: durableJobId(envelopes.lifecycle),
      maximumAttempts: 6,
      leaseSeconds: 3600,
    } as const;
    const acquired = await repository.begin(authority);
    expect(acquired.outcome).toBe("acquired");
    if (acquired.outcome !== "acquired") throw new Error("execution lease was not acquired");
    await expect(repository.begin(authority)).resolves.toEqual({ outcome: "busy" });
    await expect(
      repository.heartbeat({
        organizationId,
        idempotencyKey: envelopes.lifecycle.idempotencyKey,
        token: acquired.token,
        leaseSeconds: 3600,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.succeed({
        organizationId,
        idempotencyKey: envelopes.lifecycle.idempotencyKey,
        token: acquired.token,
      }),
    ).resolves.toBe(true);
    await expect(repository.begin(authority)).resolves.toEqual({
      outcome: "already_succeeded",
    });
    await expect(
      repository.succeed({
        organizationId,
        idempotencyKey: envelopes.lifecycle.idempotencyKey,
        token: acquired.token,
      }),
    ).resolves.toBe(false);

    const rows = await requiredConnection(administrator, "administrator")`
      select status, attempts, execution_token_sha256, completed_at
      from job_executions
      where organization_id = ${organizationId}
        and idempotency_key = ${envelopes.lifecycle.idempotencyKey}
    `;
    expect(rows[0]).toMatchObject({
      status: "succeeded",
      attempts: 1,
      execution_token_sha256: null,
    });
    expect(rows[0]?.["completed_at"]).toBeInstanceOf(Date);
  });

  it("records retryable failure and rejects forged tenant authority", async () => {
    const repository = new PostgresJobExecutionRepository(requiredConnection(worker, "worker"));
    const retryable = envelopes.retryable;
    const acquired = await repository.begin({
      envelope: retryable,
      queueName,
      jobId: durableJobId(retryable),
      maximumAttempts: 6,
      leaseSeconds: 3600,
    });
    expect(acquired.outcome).toBe("acquired");
    if (acquired.outcome !== "acquired") throw new Error("retryable lease was not acquired");
    await expect(
      repository.fail({
        organizationId,
        idempotencyKey: retryable.idempotencyKey,
        token: acquired.token,
        errorCode: "SYNTHETIC_RETRYABLE",
        terminal: false,
      }),
    ).resolves.toBe("retryable");

    const forged = {
      ...envelopes.neverStarted,
      organizationId: foreignOrganizationId,
    };
    await expect(
      repository.begin({
        envelope: CsvImportJobEnvelopeSchema.parse(forged),
        queueName,
        jobId: durableJobId(CsvImportJobEnvelopeSchema.parse(forged)),
        maximumAttempts: 6,
        leaseSeconds: 3600,
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("classifies only unpublished, tracked, retryable, or stale-running work", async () => {
    const repository = new PostgresJobExecutionRepository(requiredConnection(worker, "worker"));
    const fixture = (await repository.loadRecoverable(500, staleBefore)).filter(
      (event) => event.organizationId === organizationId,
    );
    expect(
      Object.fromEntries(fixture.map((event) => [event.idempotencyKey, event.classification])),
    ).toMatchObject({
      [keys.unpublished]: "unpublished",
      [keys.neverStarted]: "never_started",
      [keys.retryable]: "retryable",
      [keys.staleRunning]: "stale_running",
    });
    expect(fixture.map((event) => event.idempotencyKey)).not.toContain(keys.lifecycle);
    expect(fixture.map((event) => event.idempotencyKey)).not.toContain(keys.activeRunning);
    expect(fixture.map((event) => event.idempotencyKey)).not.toContain(keys.deadLettered);
    expect(fixture.map((event) => event.idempotencyKey)).not.toContain(keys.legacyUnclassified);

    const summary = await repository.summarizeRecovery(staleBefore);
    expect(Object.values(summary).every((value) => Number.isSafeInteger(value) && value >= 0)).toBe(
      true,
    );
    expect(summary.legacyUnclassified).toBeGreaterThanOrEqual(1);
  });

  it("appends exact recovery evidence and publishes an unpublished event once", async () => {
    const repository = new PostgresJobExecutionRepository(requiredConnection(worker, "worker"));
    const fixture = (await repository.loadRecoverable(500, staleBefore)).filter(
      (event) => event.organizationId === organizationId,
    );
    const unpublished = requiredCandidate(fixture, keys.unpublished);
    const recoveryRunId = randomUUID();
    const evidence = {
      recoveryRunId,
      event: unpublished,
      jobId: durableJobId(durableEnvelope(unpublished)),
      requestedBy: recoveryRequestedBy,
      reason: recoveryReason,
      staleBefore,
    } as const;
    await expect(repository.recordRecovery(evidence)).resolves.toBe(true);
    await expect(repository.recordRecovery(evidence)).resolves.toBe(false);
    const reclassified = (await repository.loadRecoverable(500, staleBefore)).filter(
      (event) => event.organizationId === organizationId,
    );
    expect(requiredCandidate(reclassified, keys.unpublished).classification).toBe("never_started");

    const admin = requiredConnection(administrator, "administrator");
    const rows = await admin`
      select event.classification, event.requested_by, outbox.published_at, outbox.attempts
      from queue_recovery_events event
      join outbox_events outbox
        on outbox.organization_id = event.organization_id
       and outbox.idempotency_key = event.idempotency_key
      where event.organization_id = ${organizationId}
        and event.recovery_run_id = ${recoveryRunId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      classification: "unpublished",
      requested_by: recoveryRequestedBy,
      attempts: 1,
    });
    expect(rows[0]?.["published_at"]).toBeInstanceOf(Date);
    await expect(
      admin`
        update queue_recovery_events
        set reason = 'This mutation must be rejected by the append-only trigger.'
        where organization_id = ${organizationId}
          and recovery_run_id = ${recoveryRunId}
      `,
    ).rejects.toThrow("queue recovery events are append-only");
  });

  it("keeps application and foreign worker tenant reads out of the execution ledger", async () => {
    const app = requiredConnection(application, "application");
    await expect(app`select id from job_executions limit 1`).rejects.toMatchObject({
      code: "42501",
    });

    const workerDatabase = requiredConnection(worker, "worker");
    const hidden = await workerDatabase.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${foreignOrganizationId}, true)`;
      return transaction`
        select id
        from job_executions
        where organization_id = ${organizationId}
      `;
    });
    expect(hidden).toHaveLength(0);
  });
});

function requiredCandidate(
  events: readonly RecoverableQueueEvent[],
  idempotencyKey: string,
): RecoverableQueueEvent {
  const found = events.find((event) => event.idempotencyKey === idempotencyKey);
  if (!found) throw new Error("expected queue recovery candidate was not found");
  return found;
}

function durableEnvelope(event: RecoverableQueueEvent): CsvImportJobEnvelope {
  return CsvImportJobEnvelopeSchema.parse(event.payload);
}

function envelope(idempotencyKey: string): CsvImportJobEnvelope {
  return CsvImportJobEnvelopeSchema.parse({
    schemaVersion: 1,
    type: "csv.import.commit",
    organizationId,
    connectionId: randomUUID(),
    importId: idempotencyKey.split(":")[1],
    correlationId: randomUUID(),
    idempotencyKey,
    requestedBy: randomUUID(),
    createdAt: "2026-07-28T08:00:00.000Z",
  });
}

async function seedRecoveryStates(sql: Sql): Promise<void> {
  await sql`
    insert into organizations (id, name)
    values
      (${organizationId}, 'Job Recovery Integration Tenant'),
      (${foreignOrganizationId}, 'Foreign Job Recovery Tenant')
  `;
  for (const [name, item] of Object.entries(envelopes) as [
    keyof typeof keys,
    CsvImportJobEnvelope,
  ][]) {
    const published = name !== "unpublished";
    const trackingVersion = name === "legacyUnclassified" || name === "unpublished" ? null : 1;
    await sql`
      insert into outbox_events (
        id,
        organization_id,
        event_type,
        schema_version,
        idempotency_key,
        payload,
        correlation_id,
        published_at,
        execution_tracking_version,
        created_at
      ) values (
        ${outboxIds[name]},
        ${organizationId},
        ${item.type},
        ${item.schemaVersion},
        ${item.idempotencyKey},
        ${sql.json(item)},
        ${item.correlationId},
        ${published ? "2026-07-28T08:01:00.000Z" : null},
        ${trackingVersion},
        ${item.createdAt}
      )
    `;
  }

  await insertExecution(sql, "staleRunning", {
    status: "running",
    attempts: 1,
    token: "a".repeat(64),
    startedAt: "2026-07-28T08:05:00.000Z",
    heartbeatAt: "2026-07-28T08:06:00.000Z",
    leaseExpiresAt: "2026-07-28T09:06:00.000Z",
    completedAt: null,
    errorCode: null,
  });
  await insertExecution(sql, "activeRunning", {
    status: "running",
    attempts: 1,
    token: "b".repeat(64),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    completedAt: null,
    errorCode: null,
  });
  await insertExecution(sql, "deadLettered", {
    status: "dead_lettered",
    attempts: 6,
    token: null,
    startedAt: "2026-07-28T08:05:00.000Z",
    heartbeatAt: "2026-07-28T08:06:00.000Z",
    leaseExpiresAt: "2026-07-28T09:06:00.000Z",
    completedAt: "2026-07-28T09:07:00.000Z",
    errorCode: "SYNTHETIC_TERMINAL",
  });
}

async function insertExecution(
  sql: Sql,
  name: "staleRunning" | "activeRunning" | "deadLettered",
  state: {
    readonly status: "running" | "dead_lettered";
    readonly attempts: number;
    readonly token: string | null;
    readonly startedAt: string;
    readonly heartbeatAt: string;
    readonly leaseExpiresAt: string;
    readonly completedAt: string | null;
    readonly errorCode: string | null;
  },
): Promise<void> {
  const item = envelopes[name];
  await sql`
    insert into job_executions (
      id,
      organization_id,
      outbox_event_id,
      idempotency_key,
      event_type,
      schema_version,
      queue_name,
      job_id,
      correlation_id,
      status,
      attempts,
      maximum_attempts,
      execution_token_sha256,
      started_at,
      last_heartbeat_at,
      lease_expires_at,
      completed_at,
      last_error_code,
      created_at,
      updated_at
    ) values (
      ${randomUUID()},
      ${organizationId},
      ${outboxIds[name]},
      ${item.idempotencyKey},
      ${item.type},
      ${item.schemaVersion},
      ${queueName},
      ${durableJobId(item)},
      ${item.correlationId},
      ${state.status},
      ${state.attempts},
      6,
      ${state.token},
      ${state.startedAt},
      ${state.heartbeatAt},
      ${state.leaseExpiresAt},
      ${state.completedAt},
      ${state.errorCode},
      ${state.startedAt},
      ${state.completedAt ?? state.heartbeatAt}
    )
  `;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the PostgreSQL integration suite`);
  return value;
}

function requiredConnection(value: Sql | undefined, name: string): Sql {
  if (!value) throw new Error(`${name} database connection was not initialized`);
  return value;
}

async function ensureLocalTestRoles(sql: Sql): Promise<void> {
  const existing = await sql`
    select rolname from pg_roles
    where rolname in ('reconai_migrator', 'reconai_app', 'reconai_worker')
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
  if (!names.has("reconai_app")) {
    await sql.unsafe(
      "create role reconai_app login password 'local-app-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
    );
  }
  if (!names.has("reconai_worker")) {
    await sql.unsafe(
      "create role reconai_worker login password 'local-worker-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
    );
  }
  await sql.unsafe(
    "grant connect on database reconai to reconai_migrator, reconai_app, reconai_worker",
  );
  await sql.unsafe("grant create, usage on schema public to reconai_migrator");
  await sql.unsafe("grant usage on schema public to reconai_app, reconai_worker");
  await sql.unsafe(`
    alter default privileges for role reconai_migrator in schema public
    grant select, insert, update, delete on tables to reconai_app, reconai_worker
  `);
}
