import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresRetentionDeletionRepository,
  RetentionDeletionError,
  type RetentionDeletionCandidate,
} from "./retention.js";

const enabledOrganizationId = randomUUID();
const heldOrganizationId = randomUUID();
const disabledOrganizationId = randomUUID();
const userId = randomUUID();
const enabledMembershipId = randomUUID();
const heldMembershipId = randomUUID();
const disabledMembershipId = randomUUID();
const enabledCsvConnectionId = randomUUID();
const enabledProviderConnectionId = randomUUID();
const heldCsvConnectionId = randomUUID();
const disabledCsvConnectionId = randomUUID();
const completedImportId = randomUUID();
const previewImportId = randomUUID();
const heldImportId = randomUUID();
const disabledImportId = randomUUID();
const processedProviderEventId = randomUUID();
const failedProviderEventId = randomUUID();
const failedDeletionEventId = randomUUID();

let administrator: Sql | undefined;
let application: Sql | undefined;
let worker: Sql | undefined;

describe("live retention deletion authority", { concurrent: false }, () => {
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
    await seedRetentionFixtures(admin);
    application = postgres(applicationUrl, { max: 1 });
    worker = postgres(workerUrl, { max: 1 });
  });

  afterAll(async () => {
    await worker?.end({ timeout: 5 });
    await application?.end({ timeout: 5 });
    await administrator?.end({ timeout: 5 });
  });

  it("deletes only explicitly eligible terminal evidence and writes append-only tombstones", async () => {
    const workerDatabase = requiredConnection(worker, "worker");
    const appDatabase = requiredConnection(application, "application");
    const admin = requiredConnection(administrator, "administrator");
    const repository = new PostgresRetentionDeletionRepository(workerDatabase);
    const candidates: RetentionDeletionCandidate[] = [];

    await expect(
      appDatabase`select * from reconai_claim_retention_candidate(${randomUUID()}::uuid)`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(workerDatabase`select * from retention_deletion_jobs`).rejects.toMatchObject({
      code: "42501",
    });

    for (const outcome of ["deleted", "already_missing"] as const) {
      const result = await repository.processNext(async (candidate) => {
        candidates.push(candidate);
        return outcome;
      });
      expect(result).toMatchObject({ kind: "completed", outcome });
    }
    await expect(repository.processNext(async () => "deleted")).resolves.toEqual({ kind: "none" });

    expect(candidates.map((candidate) => candidate.sourceKind).sort()).toEqual([
      "provider_event",
      "raw_import",
    ]);
    expect(candidates.every((candidate) => candidate.attempt === 1)).toBe(true);

    const tombstones = await admin`
      select source_kind, source_id, outcome, payload_sha256, deleted_at, eligible_at
      from retention_deletion_tombstones
      where organization_id = ${enabledOrganizationId}
      order by source_kind
    `;
    expect(tombstones).toHaveLength(2);
    expect(tombstones.map((row) => databaseString(row, "source_id"))).toEqual([
      processedProviderEventId,
      completedImportId,
    ]);
    expect(tombstones.map((row) => databaseString(row, "outcome"))).toEqual([
      "already_missing",
      "deleted",
    ]);
    expect(
      tombstones.every(
        (row) =>
          row["deleted_at"] instanceof Date &&
          row["eligible_at"] instanceof Date &&
          row["deleted_at"].getTime() >= row["eligible_at"].getTime(),
      ),
    ).toBe(true);

    await expect(
      admin`
        update retention_deletion_tombstones
        set outcome = 'deleted'
        where organization_id = ${enabledOrganizationId}
      `,
    ).rejects.toMatchObject({ code: "P0001" });
  });

  it("records bounded retry state without exposing held, disabled, or nonterminal sources", async () => {
    const repository = new PostgresRetentionDeletionRepository(
      requiredConnection(worker, "worker"),
    );
    const admin = requiredConnection(administrator, "administrator");

    await insertProviderEvent(admin, failedDeletionEventId, "processed", "5 days");
    await expect(
      repository.processNext(async () => {
        throw new RetentionDeletionError("RETENTION_OBJECT_INTEGRITY_FAILED");
      }),
    ).resolves.toEqual({
      kind: "failed",
      terminal: false,
      sourceKind: "provider_event",
      errorCode: "RETENTION_OBJECT_INTEGRITY_FAILED",
    });
    await expect(repository.processNext(async () => "deleted")).resolves.toEqual({ kind: "none" });

    const retry = await admin`
      select status, attempts, last_error_code, next_attempt_at, completed_at
      from retention_deletion_jobs
      where organization_id = ${enabledOrganizationId}
        and source_id = ${failedDeletionEventId}
    `;
    expect(retry[0]).toMatchObject({
      status: "retry",
      attempts: 1,
      last_error_code: "RETENTION_OBJECT_INTEGRITY_FAILED",
      completed_at: null,
    });
    expect(retry[0]?.["next_attempt_at"]).toBeInstanceOf(Date);

    const excluded = await admin`
      select
        (select count(*)::integer from retention_deletion_tombstones
          where organization_id = ${heldOrganizationId}) as held,
        (select count(*)::integer from retention_deletion_tombstones
          where organization_id = ${disabledOrganizationId}) as disabled,
        (select count(*)::integer from retention_deletion_tombstones
          where organization_id = ${enabledOrganizationId}
            and source_id in (${previewImportId}, ${failedProviderEventId})) as nonterminal
    `;
    expect(excluded[0]).toMatchObject({ held: 0, disabled: 0, nonterminal: 0 });
  });

  it("applies tenant RLS to policies and deletion receipts", async () => {
    const app = requiredConnection(application, "application");
    const enabled = await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${enabledOrganizationId}, true)`;
      const policies =
        await transaction`select organization_id from organization_retention_policies`;
      const tombstones =
        await transaction`select organization_id from retention_deletion_tombstones`;
      return { policies, tombstones };
    });
    expect(enabled.policies).toHaveLength(1);
    expect(enabled.tombstones).toHaveLength(2);
    expect(
      enabled.tombstones.every((row) => row["organization_id"] === enabledOrganizationId),
    ).toBe(true);

    const disabled = await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${disabledOrganizationId}, true)`;
      return transaction`select organization_id from organization_retention_policies`;
    });
    expect(disabled).toHaveLength(0);
  });
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the PostgreSQL integration suite`);
  return value;
}

function requiredConnection(value: Sql | undefined, name: string): Sql {
  if (!value) throw new Error(`${name} database connection was not initialized`);
  return value;
}

function databaseString(row: unknown, field: string): string {
  if (typeof row !== "object" || row === null) {
    throw new Error("database returned an invalid row");
  }
  const value = (row as Record<string, unknown>)[field];
  if (typeof value !== "string") {
    throw new Error(`database returned an invalid ${field}`);
  }
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

async function seedRetentionFixtures(sql: Sql): Promise<void> {
  await sql`
    insert into organizations (id, name) values
      (${enabledOrganizationId}, 'Retention Enabled Tenant'),
      (${heldOrganizationId}, 'Retention Held Tenant'),
      (${disabledOrganizationId}, 'Retention Disabled Tenant')
  `;
  await sql`
    insert into users (id, issuer, subject, email)
    values (
      ${userId},
      'https://issuer.example.test',
      ${`retention-owner-${userId}`},
      ${`retention-owner-${userId}@example.test`}
    )
  `;
  await sql`
    insert into memberships (id, organization_id, user_id, role, status) values
      (${enabledMembershipId}, ${enabledOrganizationId}, ${userId}, 'owner', 'active'),
      (${heldMembershipId}, ${heldOrganizationId}, ${userId}, 'owner', 'active'),
      (${disabledMembershipId}, ${disabledOrganizationId}, ${userId}, 'owner', 'active')
  `;
  await sql`
    insert into data_source_connections (
      id, organization_id, provider, external_account_id, status, connector_version
    ) values
      (
        ${enabledCsvConnectionId}, ${enabledOrganizationId}, 'accounting_csv',
        ${`retention-csv-${enabledOrganizationId}`}, 'healthy', '1.0.0'
      ),
      (
        ${enabledProviderConnectionId}, ${enabledOrganizationId}, 'shopify',
        ${`retention-provider-${enabledOrganizationId}`}, 'healthy', '1.0.0'
      ),
      (
        ${heldCsvConnectionId}, ${heldOrganizationId}, 'accounting_csv',
        ${`retention-csv-${heldOrganizationId}`}, 'healthy', '1.0.0'
      ),
      (
        ${disabledCsvConnectionId}, ${disabledOrganizationId}, 'accounting_csv',
        ${`retention-csv-${disabledOrganizationId}`}, 'healthy', '1.0.0'
      )
  `;
  await insertImport(sql, {
    id: completedImportId,
    organizationId: enabledOrganizationId,
    connectionId: enabledCsvConnectionId,
    status: "succeeded",
    completed: true,
  });
  await insertImport(sql, {
    id: previewImportId,
    organizationId: enabledOrganizationId,
    connectionId: enabledCsvConnectionId,
    status: "previewed",
    completed: false,
  });
  await insertImport(sql, {
    id: heldImportId,
    organizationId: heldOrganizationId,
    connectionId: heldCsvConnectionId,
    status: "succeeded",
    completed: true,
  });
  await insertImport(sql, {
    id: disabledImportId,
    organizationId: disabledOrganizationId,
    connectionId: disabledCsvConnectionId,
    status: "succeeded",
    completed: true,
  });
  await insertProviderEvent(sql, processedProviderEventId, "processed", "5 days");
  await insertProviderEvent(sql, failedProviderEventId, "failed", "5 days");
  await sql`
    insert into organization_retention_policies (
      organization_id,
      raw_import_retention_days,
      provider_event_retention_days,
      legal_hold_enabled,
      legal_hold_reason,
      updated_by_membership_id
    ) values
      (
        ${enabledOrganizationId}, 1, 1, false, null, ${enabledMembershipId}
      ),
      (
        ${heldOrganizationId}, 1, null, true,
        'Synthetic legal hold blocks destructive processing',
        ${heldMembershipId}
      )
  `;
}

async function insertImport(
  sql: Sql,
  input: {
    readonly id: string;
    readonly organizationId: string;
    readonly connectionId: string;
    readonly status: "previewed" | "succeeded";
    readonly completed: boolean;
  },
): Promise<void> {
  await sql`
    insert into imports (
      id, organization_id, connection_id, source, object_key, payload_sha256, byte_count,
      content_type, original_filename, template_version, mapping_version, mapping, status,
      idempotency_key, row_count, valid_row_count, invalid_row_count, preview_rows,
      preview_errors, uploaded_by, uploaded_at, committed_at, completed_at
    ) values (
      ${input.id},
      ${input.organizationId},
      ${input.connectionId},
      'accounting_csv',
      ${`integration/${input.organizationId}/imports/${input.id}/payload.csv`},
      ${"a".repeat(64)},
      128,
      'text/csv',
      'ledger.csv',
      'template-v1',
      'mapping-v1',
      ${sql.json({
        externalId: "id",
        transactionReference: "reference",
        amount: "amount",
        currency: "currency",
        effectiveAt: "effective_at",
        entryType: "type",
      })},
      ${input.status},
      ${input.id.replaceAll("-", "").padEnd(64, "0").slice(0, 64)},
      1,
      1,
      0,
      '[]'::jsonb,
      '[]'::jsonb,
      ${userId},
      statement_timestamp() - interval '10 days',
      ${input.completed ? sql`statement_timestamp() - interval '10 days'` : null},
      ${input.completed ? sql`statement_timestamp() - interval '10 days'` : null}
    )
  `;
}

async function insertProviderEvent(
  sql: Sql,
  id: string,
  status: "processed" | "failed",
  age: "5 days" | "12 hours",
): Promise<void> {
  await sql`
    insert into source_events (
      id, organization_id, connection_id, source, external_event_id, external_object_type,
      external_object_id, source_timestamp, received_at, connector_version, api_version,
      payload_object_key, payload_sha256, status
    ) values (
      ${id},
      ${enabledOrganizationId},
      ${enabledProviderConnectionId},
      'shopify',
      ${`event-${id}`},
      'order',
      ${`order-${id}`},
      statement_timestamp() - ${age}::interval,
      statement_timestamp() - ${age}::interval,
      '1.0.0',
      '2026-07',
      ${`integration/${enabledOrganizationId}/provider-events/${id}/payload.json`},
      ${"b".repeat(64)},
      ${status}
    )
  `;
}
