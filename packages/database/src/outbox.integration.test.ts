import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { OrganizationIdSchema } from "@workspace/domain";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresOutboxRelayRepository } from "./outbox.js";

const organizationId = OrganizationIdSchema.parse(randomUUID());
const connectionId = randomUUID();
const importId = randomUUID();
const firstKey = `csv-import:${importId}:commit:v1`;
const secondKey = `csv-import:${randomUUID()}:commit:v1`;
let administrator: Sql | undefined;
let application: Sql | undefined;
let worker: Sql | undefined;

describe("live least-privilege outbox relay", { concurrent: false }, () => {
  beforeAll(async () => {
    const adminUrl = requiredEnvironment("DATABASE_ADMIN_URL");
    const migrationUrl = requiredEnvironment("DATABASE_MIGRATION_URL");
    const applicationUrl = requiredEnvironment("DATABASE_URL");
    const workerUrl = requiredEnvironment("DATABASE_WORKER_URL");
    const admin = postgres(adminUrl, { max: 1 });
    administrator = admin;
    await ensureLocalTestRoles(admin);
    execFileSync("pnpm", ["--filter", "@workspace/database", "db:migrate"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl },
      stdio: "pipe",
    });
    await seedOutbox(admin);
    application = postgres(applicationUrl, { max: 1 });
    worker = postgres(workerUrl, { max: 1 });
  });

  afterAll(async () => {
    await worker?.end({ timeout: 5 });
    await application?.end({ timeout: 5 });
    await administrator?.end({ timeout: 5 });
  });

  it("lets only the worker relay retry, dead-letter, and publish pending events", async () => {
    const workerDatabase = requiredConnection(worker, "worker");
    const appDatabase = requiredConnection(application, "application");
    const admin = requiredConnection(administrator, "administrator");
    const repository = new PostgresOutboxRelayRepository(workerDatabase);

    await expect(appDatabase`select * from reconai_pending_outbox(10)`).rejects.toMatchObject({
      code: "42501",
    });
    await expect(pendingForFixture(repository)).resolves.toHaveLength(2);

    await expect(
      repository.markFailed(
        organizationId,
        firstKey,
        "QUEUE_DISPATCH_FAILED",
        "2026-07-27T00:00:00.000Z",
        2,
      ),
    ).resolves.toBe(true);
    await expect(pendingForFixture(repository)).resolves.toHaveLength(2);
    await expect(
      repository.markFailed(
        organizationId,
        firstKey,
        "QUEUE_DISPATCH_FAILED",
        "2026-07-27T00:00:00.000Z",
        2,
      ),
    ).resolves.toBe(true);
    await expect(
      repository.markPublished(organizationId, secondKey, "2026-07-27T12:00:00.000Z"),
    ).resolves.toBe(true);
    await expect(pendingForFixture(repository)).resolves.toEqual([]);

    const state = await admin`
      select idempotency_key, attempts, published_at, dead_lettered_at, last_error_code
      from outbox_events
      where organization_id = ${organizationId}
      order by idempotency_key
    `;
    const failed = state.find((row) => row["idempotency_key"] === firstKey);
    const published = state.find((row) => row["idempotency_key"] === secondKey);
    expect(failed).toMatchObject({ attempts: 2, last_error_code: "QUEUE_DISPATCH_FAILED" });
    expect(failed?.["dead_lettered_at"]).toBeInstanceOf(Date);
    expect(published).toMatchObject({ attempts: 1, last_error_code: null });
    expect(published?.["published_at"]).toBeInstanceOf(Date);
  });
});

async function pendingForFixture(repository: PostgresOutboxRelayRepository) {
  return (await repository.loadPending(500)).filter(
    (event) => event.organizationId === organizationId,
  );
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

async function seedOutbox(sql: Sql): Promise<void> {
  await sql`
    insert into organizations (id, name)
    values (${organizationId}, 'Outbox Relay Integration Tenant')
  `;
  const firstPayload = envelope(firstKey, importId);
  const secondImportId = secondKey.split(":")[1];
  if (!secondImportId) throw new Error("second import identity missing");
  const secondPayload = envelope(secondKey, secondImportId);
  await sql`
    insert into outbox_events (
      id, organization_id, event_type, schema_version, idempotency_key, payload, correlation_id
    ) values
      (
        ${randomUUID()}, ${organizationId}, 'csv.import.commit', 1, ${firstKey},
        ${sql.json(firstPayload)}, ${firstPayload.correlationId}
      ),
      (
        ${randomUUID()}, ${organizationId}, 'csv.import.commit', 1, ${secondKey},
        ${sql.json(secondPayload)}, ${secondPayload.correlationId}
      )
  `;
}

function envelope(idempotencyKey: string, requestedImportId: string) {
  return {
    schemaVersion: 1,
    type: "csv.import.commit",
    organizationId,
    connectionId,
    importId: requestedImportId,
    correlationId: randomUUID(),
    idempotencyKey,
    requestedBy: randomUUID(),
    createdAt: "2026-07-27T00:00:00.000Z",
  };
}
