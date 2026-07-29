import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  MembershipIdSchema,
  OrganizationIdSchema,
  UserIdSchema,
  tenantContextFromMembership,
} from "@workspace/domain";
import { CsvImportService, type ConnectorJobPublisher } from "@workspace/ingestion";
import { InMemoryImmutableObjectStore } from "@workspace/object-storage";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresCsvImportRepository } from "./csv-imports.js";
import { createDatabase } from "./index.js";
import type { CsvImportJobEnvelope } from "@workspace/connectors";

const organizationId = OrganizationIdSchema.parse(randomUUID());
const otherOrganizationId = OrganizationIdSchema.parse(randomUUID());
const userId = UserIdSchema.parse(randomUUID());
const membershipId = MembershipIdSchema.parse(randomUUID());
const connectionId = randomUUID();
const tenant = tenantContextFromMembership({
  id: membershipId,
  organizationId,
  userId,
  role: "administrator",
  status: "active",
});
const csv = Buffer.from(
  [
    "id,reference,order,amount,currency,effective_at,type",
    "entry-1,refund-1,order-1,25.00,USD,2026-07-27T00:00:00.000Z,refund",
  ].join("\n"),
);
const metadata = {
  connectionId,
  templateVersion: "accounting-v1",
  mappingVersion: "mapping-v1",
  mapping: {
    externalId: "id",
    transactionReference: "reference",
    orderReference: "order",
    amount: "amount",
    currency: "currency",
    effectiveAt: "effective_at",
    entryType: "type",
  },
} as const;
const traceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";

let administrator: Sql | undefined;
let application: Sql | undefined;

describe("live durable CSV import", { concurrent: false }, () => {
  beforeAll(async () => {
    const adminUrl = requiredEnvironment("DATABASE_ADMIN_URL");
    const migrationUrl = requiredEnvironment("DATABASE_MIGRATION_URL");
    const applicationUrl = requiredEnvironment("DATABASE_URL");
    const admin = postgres(adminUrl, { max: 1 });
    administrator = admin;
    await ensureLocalTestRoles(admin);
    execFileSync("pnpm", ["--filter", "@workspace/database", "db:migrate"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl },
      stdio: "pipe",
    });
    await seedImportTenant(admin);
    application = createDatabase(applicationUrl, 1).sql;
  });

  afterAll(async () => {
    await application?.end({ timeout: 5 });
    await administrator?.end({ timeout: 5 });
  });

  it("persists receipt, outbox, source event, canonical record, and audit exactly once", async () => {
    const database = requiredConnection(application);
    const publisher = new CapturingPublisher();
    const service = new CsvImportService({
      environment: "integration",
      repository: new PostgresCsvImportRepository(database),
      objectStore: new InMemoryImmutableObjectStore(),
      publisher,
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });
    const preview = await service.createPreview(tenant, {
      filename: "ledger.csv",
      contentType: "text/csv",
      body: csv,
      metadata,
    });
    const committed = await service.commitImport(tenant, {
      importId: preview.receipt.id,
      correlationId: "71000000-0000-4000-8000-000000000001",
      reason: "Integration verification of the approved close file",
      traceparent,
    });
    expect(committed.status).toBe("queued");
    const envelope = publisher.envelopes[0];
    if (!envelope) throw new Error("CSV job was not published");
    expect(envelope.traceContext).toEqual({ schemaVersion: 1, traceparent });
    await expect(service.processImport(envelope)).resolves.toBe("processed");
    await expect(service.processImport(envelope)).resolves.toBe("already_processed");

    const counts = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
      return transaction`
        select
          (select count(*)::integer from imports where id = ${preview.receipt.id}::uuid
             and status = 'succeeded') as imports,
          (select count(*)::integer from outbox_events
             where idempotency_key = ${envelope.idempotencyKey}) as outbox,
          (select count(*)::integer from source_events
             where import_id = ${preview.receipt.id}::uuid) as sources,
          (select count(*)::integer from source_event_object_classifications
             where object_families = ARRAY['csv_row']::text[]) as classifications,
          (select count(*)::integer from canonical_records
             where source = 'accounting_csv') as canonical,
          (select count(*)::integer from canonical_field_provenance) as provenance,
          (select count(*)::integer from audit_events
             where resource_id = ${preview.receipt.id}) as audits
      `;
    });
    expect(counts[0]).toMatchObject({
      imports: 1,
      outbox: 1,
      sources: 1,
      classifications: 1,
      canonical: 1,
      provenance: 7,
      audits: 3,
    });

    const rolledBack = await service.rollbackImport(tenant, {
      importId: preview.receipt.id,
      confirmImportId: preview.receipt.id,
      correlationId: "71000000-0000-4000-8000-000000000002",
      reason: "Exclude the duplicate accounting close file from future reconciliation runs",
    });
    await expect(
      service.rollbackImport(tenant, {
        importId: preview.receipt.id,
        confirmImportId: preview.receipt.id,
        correlationId: "71000000-0000-4000-8000-000000000003",
        reason: "Exclude the duplicate accounting close file from future reconciliation runs",
      }),
    ).resolves.toEqual(rolledBack);
    expect(rolledBack).toMatchObject({
      status: "rolled_back",
      supersededRecordCount: 1,
    });

    const rollbackEvidence = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
      return transaction`
        select
          (select count(*)::integer from canonical_record_supersessions
             where source_import_id = ${preview.receipt.id}::uuid) as supersessions,
          (select count(*)::integer from canonical_records
             where source = 'accounting_csv') as retained_canonical,
          (select count(*)::integer
             from canonical_records as candidate
             where candidate.source = 'accounting_csv'
               and not exists (
                 select 1 from canonical_record_supersessions
                 where organization_id = candidate.organization_id
                   and record_id = candidate.id
                   and record_version = candidate.version
               )) as active_canonical,
          (select count(*)::integer from source_events
             where import_id = ${preview.receipt.id}::uuid) as retained_sources,
          (select count(*)::integer from audit_events
             where resource_id = ${preview.receipt.id}) as audits
      `;
    });
    expect(rollbackEvidence[0]).toMatchObject({
      supersessions: 1,
      retained_canonical: 1,
      active_canonical: 0,
      retained_sources: 1,
      audits: 4,
    });

    const hidden = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${otherOrganizationId}, true)`;
      return transaction`
        select
          (select count(*)::integer from imports
             where id = ${preview.receipt.id}::uuid) as imports,
          (select count(*)::integer from canonical_record_supersessions
             where source_import_id = ${preview.receipt.id}::uuid) as supersessions,
          (select count(*)::integer from source_event_object_classifications)
            as classifications
      `;
    });
    expect(hidden[0]).toMatchObject({ imports: 0, supersessions: 0, classifications: 0 });

    await expect(
      database.begin(async (transaction) => {
        await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
        await transaction`delete from source_event_object_classifications`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      database.begin(async (transaction) => {
        await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
        await transaction`delete from canonical_record_supersessions
          where source_import_id = ${preview.receipt.id}::uuid`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      database.begin(async (transaction) => {
        await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
        await transaction`
          insert into canonical_records (
            id, organization_id, version, kind, source_event_id, source,
            external_object_type, external_object_id, source_timestamp,
            ingestion_timestamp, effective_at, connector_version, normalizer_version,
            amount_minor, currency, order_reference, customer_reference, normalized_data,
            content_sha256, is_incomplete
          )
          select
            id, organization_id, version + 1, kind, source_event_id, source,
            external_object_type, external_object_id, source_timestamp,
            ingestion_timestamp, effective_at, connector_version, 'csv-replay-v2',
            amount_minor, currency, order_reference, customer_reference, normalized_data,
            content_sha256, is_incomplete
          from canonical_records
          where source = 'accounting_csv'
          limit 1
        `;
      }),
    ).rejects.toMatchObject({ code: "P0001" });

    await expect(
      database.begin(async (transaction) => {
        await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
        await transaction`
          update imports
          set object_key = 'integration/tampered/import.csv'
          where id = ${preview.receipt.id}::uuid
        `;
      }),
    ).rejects.toMatchObject({ code: "P0001" });
    await expect(
      database.begin(async (transaction) => {
        await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
        await transaction`
          update canonical_records
          set amount_minor = 1
          where source = 'accounting_csv'
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

class CapturingPublisher implements ConnectorJobPublisher {
  public readonly envelopes: CsvImportJobEnvelope[] = [];

  public async publish(envelope: CsvImportJobEnvelope): Promise<void> {
    this.envelopes.push(envelope);
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the PostgreSQL integration suite`);
  return value;
}

function requiredConnection(value: Sql | undefined): Sql {
  if (!value) throw new Error("application database connection was not initialized");
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
    grant select, insert, update, delete on tables to reconai_app
  `);
  await sql.unsafe(`
    alter default privileges for role reconai_migrator in schema public
    grant select, insert, update, delete on tables to reconai_worker
  `);
}

async function seedImportTenant(sql: Sql): Promise<void> {
  await sql`
    insert into organizations (id, name) values
      (${organizationId}, 'CSV Integration Tenant'),
      (${otherOrganizationId}, 'Other CSV Integration Tenant')
    on conflict (id) do nothing
  `;
  await sql`
    insert into users (id, issuer, subject, email) values (
      ${userId}, 'https://issuer.example.test', ${`csv-operator-${userId}`},
      'csv-operator@example.test'
    )
    on conflict (id) do nothing
  `;
  await sql`
    insert into memberships (id, organization_id, user_id, role, status) values (
      ${membershipId}, ${organizationId}, ${userId}, 'administrator', 'active'
    )
    on conflict (organization_id, id) do nothing
  `;
  await sql`
    insert into data_source_connections (
      id, organization_id, provider, external_account_id, status, connector_version
    ) values (
      ${connectionId}, ${organizationId}, 'accounting_csv',
      ${`csv-integration-ledger-${connectionId}`}, 'healthy', '1.0.0'
    )
    on conflict (organization_id, id) do nothing
  `;
}
