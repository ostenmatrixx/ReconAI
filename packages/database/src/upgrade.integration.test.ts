import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const firstPendingMigration = "0042_identity_bound_organization_bootstrap.sql";
const pendingMigrations = [
  firstPendingMigration,
  "0043_reconciliation_occurrence_snapshots.sql",
  "0044_exception_queue_observability_index.sql",
  "0045_exception_queue_observability_authority.sql",
  "0046_provider_active_sync_observability_index.sql",
  "0047_provider_active_sync_observability_authority.sql",
  "0048_source_event_object_watermark_index.sql",
  "0049_source_event_object_classifications.sql",
  "0050_provider_privacy_data_package_receipts.sql",
  "0051_source_event_classification_repair_authority.sql",
  "0052_source_event_classification_writer_fence.sql",
  "0053_restricted_support_access.sql",
  "0054_support_access_request_grant_integrity.sql",
] as const;
const currentMigration = "0054_support_access_request_grant_integrity.sql";
const organizationA = "11000000-0000-4000-8000-000000000001";
const organizationB = "11000000-0000-4000-8000-000000000002";
const userId = "22000000-0000-4000-8000-000000000001";
const membershipA = "33000000-0000-4000-8000-000000000001";
const membershipB = "33000000-0000-4000-8000-000000000002";
const connectionA = "44000000-0000-4000-8000-000000000001";
const providerSyncRunA = "55000000-0000-4000-8000-000000000001";
const auditEventA = "77000000-0000-4000-8000-000000000001";
const auditEventB = "77000000-0000-4000-8000-000000000002";
const auditEventHashA = "a".repeat(64);
const auditEventHashB = "b".repeat(64);

let control: Sql | undefined;
let upgradeAdmin: Sql | undefined;
let upgradeApplication: Sql | undefined;
let upgradeDatabaseName: string | undefined;
let beforeUpgrade: readonly Readonly<Record<string, string>>[] = [];
let afterUpgrade: readonly Readonly<Record<string, string>>[] = [];
let beforeAuditUpgrade: readonly AuditSnapshot[] = [];
let afterAuditUpgrade: readonly AuditSnapshot[] = [];
let migrationOutput = "";

describe("live previous-release database upgrade", { concurrent: false }, () => {
  beforeAll(async () => {
    const adminUrl = requiredEnvironment("DATABASE_ADMIN_URL");
    const migrationUrl = requiredEnvironment("DATABASE_MIGRATION_URL");
    const applicationUrl = requiredEnvironment("DATABASE_URL");
    control = postgres(adminUrl, { max: 1 });
    await ensureLocalTestRoles(control);

    upgradeDatabaseName = `reconai_upgrade_test_${randomUUID().replaceAll("-", "")}`;
    await control`create database ${control(upgradeDatabaseName)}`;
    await control`
      grant connect on database ${control(upgradeDatabaseName)}
      to reconai_migrator, reconai_app, reconai_worker, reconai_maintenance
    `;

    const isolatedAdminUrl = withDatabase(adminUrl, upgradeDatabaseName);
    const isolatedMigrationUrl = withDatabase(migrationUrl, upgradeDatabaseName);
    const isolatedApplicationUrl = withDatabase(applicationUrl, upgradeDatabaseName);
    upgradeAdmin = postgres(isolatedAdminUrl, { max: 1 });
    await prepareIsolatedDatabase(upgradeAdmin);

    const previousMigrationConnection = postgres(isolatedMigrationUrl, { max: 1 });
    try {
      await applyPreviousRelease(previousMigrationConnection);
    } finally {
      await previousMigrationConnection.end({ timeout: 5 });
    }

    await seedPreviousRelease(upgradeAdmin);
    beforeUpgrade = await membershipSnapshot(upgradeAdmin);
    beforeAuditUpgrade = await auditSnapshot(upgradeAdmin);
    migrationOutput = execFileSync("pnpm", ["--filter", "@workspace/database", "db:migrate"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_MIGRATION_URL: isolatedMigrationUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    afterUpgrade = await membershipSnapshot(upgradeAdmin);
    afterAuditUpgrade = await auditSnapshot(upgradeAdmin);
    upgradeApplication = postgres(isolatedApplicationUrl, { max: 1 });
  });

  afterAll(async () => {
    await upgradeApplication?.end({ timeout: 5 });
    await upgradeAdmin?.end({ timeout: 5 });
    if (control && upgradeDatabaseName?.startsWith("reconai_upgrade_test_")) {
      await control`drop database ${control(upgradeDatabaseName)} with (force)`;
    }
    await control?.end({ timeout: 5 });
  });

  it("applies current additive expansions while preserving pre-bootstrap data", async () => {
    const database = requiredConnection(upgradeAdmin, "upgrade administrator");
    expect(migrationOutput.trim()).toBe(
      pendingMigrations.map((migration) => `Applied ${migration}`).join("\n"),
    );
    expect(afterUpgrade).toEqual(beforeUpgrade);
    expect(afterAuditUpgrade).toEqual(beforeAuditUpgrade);

    const ledger = await database`
      select version, checksum_sha256
      from reconai_schema_migrations
      order by version
    `;
    expect(ledger).toHaveLength(55);
    expect(databaseString(ledger.at(-1), "version")).toBe(currentMigration);
    expect(databaseString(ledger.at(-1), "checksum_sha256")).toMatch(/^[a-f0-9]{64}$/u);

    const currentExpansion = await database`
      select
        classes.relrowsecurity as classifications_rls,
        classes.relforcerowsecurity as classifications_forced_rls,
        packages.relrowsecurity as packages_rls,
        packages.relforcerowsecurity as packages_forced_rls,
        receipts.relrowsecurity as receipts_rls,
        receipts.relforcerowsecurity as receipts_forced_rls,
        support_requests.relrowsecurity as support_requests_rls,
        support_requests.relforcerowsecurity as support_requests_forced_rls,
        support_grants.relrowsecurity as support_grants_rls,
        support_grants.relforcerowsecurity as support_grants_forced_rls,
        to_regclass(
          'public.source_events_org_connection_object_watermark_idx'
        )::text as watermark_index,
        has_function_privilege(
          'reconai_maintenance',
          'reconai_claim_source_event_classification_repair_candidate()',
          'EXECUTE'
        ) as maintenance_repair_execute,
        has_function_privilege(
          'reconai_app',
          'reconai_claim_source_event_classification_repair_candidate()',
          'EXECUTE'
        ) as application_repair_execute,
        to_regclass(
          'public.source_event_classification_writer_fence_activations'
        )::text as writer_fence_activations,
        has_function_privilege(
          'reconai_maintenance',
          'reconai_activate_source_event_classification_writer_fence(uuid,text,text,text)',
          'EXECUTE'
        ) as maintenance_writer_fence_execute,
        has_function_privilege(
          'reconai_app',
          'reconai_activate_source_event_classification_writer_fence(uuid,text,text,text)',
          'EXECUTE'
        ) as application_writer_fence_execute,
        has_function_privilege(
          'reconai_app',
          'reconai_create_support_access_request(uuid,text,text,integer,timestamptz)',
          'EXECUTE'
        ) as application_support_request_execute,
        has_function_privilege(
          'reconai_worker',
          'reconai_create_support_access_request(uuid,text,text,integer,timestamptz)',
          'EXECUTE'
        ) as worker_support_request_execute,
        has_function_privilege(
          'reconai_app',
          'reconai_support_diagnostics(uuid,uuid,text)',
          'EXECUTE'
        ) as application_support_diagnostics_execute,
        has_table_privilege(
          'reconai_app',
          'public.support_access_requests',
          'SELECT'
        ) as application_support_request_select,
        has_table_privilege(
          'reconai_worker',
          'public.support_access_grants',
          'SELECT'
        ) as worker_support_grant_select,
        exists (
          select 1
          from pg_constraint
          where conname = 'support_access_requests_claimed_grant_fk'
            and conrelid = 'public.support_access_requests'::regclass
        ) as support_request_grant_fk
      from pg_class as classes
      cross join pg_class as packages
      cross join pg_class as receipts
      cross join pg_class as support_requests
      cross join pg_class as support_grants
      where classes.oid = 'public.source_event_object_classifications'::regclass
        and packages.oid = 'public.provider_privacy_data_packages'::regclass
        and receipts.oid = 'public.provider_privacy_data_package_receipts'::regclass
        and support_requests.oid = 'public.support_access_requests'::regclass
        and support_grants.oid = 'public.support_access_grants'::regclass
    `;
    expect(currentExpansion).toEqual([
      {
        classifications_rls: true,
        classifications_forced_rls: true,
        packages_rls: true,
        packages_forced_rls: true,
        receipts_rls: true,
        receipts_forced_rls: true,
        support_requests_rls: true,
        support_requests_forced_rls: true,
        support_grants_rls: true,
        support_grants_forced_rls: true,
        watermark_index: "source_events_org_connection_object_watermark_idx",
        maintenance_repair_execute: true,
        application_repair_execute: false,
        writer_fence_activations: "source_event_classification_writer_fence_activations",
        maintenance_writer_fence_execute: true,
        application_writer_fence_execute: false,
        application_support_request_execute: true,
        worker_support_request_execute: false,
        application_support_diagnostics_execute: true,
        application_support_request_select: false,
        worker_support_grant_select: false,
        support_request_grant_fk: true,
      },
    ]);

    const auditVersions = await database`
      select id, hash_version
      from audit_events
      order by id
    `;
    expect(auditVersions).toEqual([
      { id: auditEventA, hash_version: 1 },
      { id: auditEventB, hash_version: 1 },
    ]);
  });

  it("keeps pre-bootstrap tenant surfaces compatible and installs the first-owner boundary", async () => {
    const database = requiredConnection(upgradeApplication, "upgrade application");
    const legacyMemberships = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationA}, true)`;
      return transaction`
        select id, organization_id, user_id, role
        from memberships
        where user_id = ${userId}::uuid
        order by id
      `;
    });
    expect(legacyMemberships).toHaveLength(1);
    expect(databaseString(legacyMemberships[0], "id")).toBe(membershipA);

    const directory = await database`
      select organization_id, organization_name, membership_id, membership_role
      from reconai_list_active_organizations(
        'https://issuer.example.test',
        'upgrade-operator'
      )
    `;
    expect(
      directory.map((row: unknown) => ({
        organizationId: databaseString(row, "organization_id"),
        membershipId: databaseString(row, "membership_id"),
        role: databaseString(row, "membership_role"),
      })),
    ).toEqual([
      { organizationId: organizationA, membershipId: membershipA, role: "analyst" },
      { organizationId: organizationB, membershipId: membershipB, role: "reviewer" },
    ]);

    const paginatedDirectory = await database`
      select organization_id, membership_id, membership_role
      from reconai_list_active_organization_page(
        'https://issuer.example.test',
        'upgrade-operator',
        null,
        ${organizationB}::uuid,
        null,
        null,
        2
      )
    `;
    expect(
      paginatedDirectory.map((row: unknown) => ({
        organizationId: databaseString(row, "organization_id"),
        membershipId: databaseString(row, "membership_id"),
        role: databaseString(row, "membership_role"),
      })),
    ).toEqual([{ organizationId: organizationB, membershipId: membershipB, role: "reviewer" }]);

    const policies = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationA}, true)`;
      return transaction`select organization_id from organization_retention_policies`;
    });
    expect(policies).toHaveLength(0);
    const syncState = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationA}, true)`;
      const connections = await transaction`
        select api_credential_reference
        from data_source_connections
      `;
      const runs = await transaction`
        select
          id,
          requester_type,
          requested_by_membership_id,
          requested_by_service
        from provider_sync_runs
      `;
      const credentials = await transaction`
        select id from connector_credentials
      `;
      return { connections, runs, credentials };
    });
    expect(syncState.connections).toHaveLength(1);
    expect(syncState.connections[0]?.["api_credential_reference"]).toBeNull();
    expect(syncState.runs).toHaveLength(1);
    expect(syncState.runs[0]).toMatchObject({
      id: providerSyncRunA,
      requester_type: "user",
      requested_by_membership_id: membershipA,
      requested_by_service: null,
    });
    expect(syncState.credentials).toHaveLength(0);

    const bootstrapped = await database`
      select *
      from reconai_bootstrap_first_organization(
        'https://issuer.example.test',
        'post-upgrade-bootstrap-owner',
        'post-upgrade-bootstrap-owner@example.test',
        '11000000-0000-4000-8000-000000000003',
        '33000000-0000-4000-8000-000000000003',
        '99000000-0000-4000-8000-000000000001',
        '99000000-0000-4000-8000-000000000002',
        ${"c".repeat(64)},
        'Post-upgrade Bootstrap Tenant',
        'Asia/Manila',
        '22000000-0000-4000-8000-000000000002'
      )
    `;
    expect(bootstrapped).toMatchObject([
      {
        bootstrap_status: "created",
        organization_id: "11000000-0000-4000-8000-000000000003",
        membership_id: "33000000-0000-4000-8000-000000000003",
        user_id: "22000000-0000-4000-8000-000000000002",
        membership_role: "owner",
      },
    ]);
  });
});

async function applyPreviousRelease(sql: Sql): Promise<void> {
  const directory = resolve(import.meta.dirname, "../migrations");
  const files = (await readdir(directory))
    .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(file) && file < firstPendingMigration)
    .sort();
  if (files.length !== 42 || files.at(-1) !== "0041_paginated_organization_access_directory.sql") {
    throw new Error("previous release migration boundary is unexpected");
  }

  await sql`
    create table reconai_schema_migrations (
      version text primary key,
      checksum_sha256 char(64) not null,
      applied_at timestamptz not null default now()
    )
  `;
  for (const file of files) {
    const contents = await readFile(resolve(directory, file), "utf8");
    const checksum = createHash("sha256").update(contents).digest("hex");
    await sql.begin(async (transaction) => {
      await transaction.unsafe(contents);
      await transaction`
        insert into reconai_schema_migrations (version, checksum_sha256)
        values (${file}, ${checksum})
      `;
    });
  }
}

async function seedPreviousRelease(sql: Sql): Promise<void> {
  await sql`
    insert into organizations (id, name) values
      (${organizationA}, 'Upgrade Tenant A'),
      (${organizationB}, 'Upgrade Tenant B')
  `;
  await sql`
    insert into users (id, issuer, subject, email)
    values (
      ${userId},
      'https://issuer.example.test',
      'upgrade-operator',
      'upgrade-operator@example.test'
    )
  `;
  await sql`
    insert into memberships (id, organization_id, user_id, role, status) values
      (${membershipA}, ${organizationA}, ${userId}, 'analyst', 'active'),
      (${membershipB}, ${organizationB}, ${userId}, 'reviewer', 'active')
  `;
  await sql`
    insert into data_source_connections (
      id,
      organization_id,
      provider,
      external_account_id,
      status,
      connector_version,
      api_version
    ) values (
      ${connectionA},
      ${organizationA},
      'stripe',
      'acct_previous_release',
      'healthy',
      '1.0.0',
      '2025-06-30.basil'
    )
  `;
  await sql`
    insert into provider_sync_runs (
      id,
      organization_id,
      connection_id,
      provider,
      mode,
      window_start,
      window_end,
      status,
      maximum_pages,
      idempotency_key,
      correlation_id,
      requested_by_membership_id,
      started_at,
      completed_at
    ) values (
      ${providerSyncRunA},
      ${organizationA},
      ${connectionA},
      'stripe',
      'gap_repair',
      '2026-07-26T00:00:00.000Z',
      '2026-07-27T00:00:00.000Z',
      'succeeded',
      5,
      ${"a".repeat(64)},
      '66000000-0000-4000-8000-000000000001',
      ${membershipA},
      '2026-07-27T00:00:01.000Z',
      '2026-07-27T00:00:02.000Z'
    )
  `;
  await sql`
    insert into audit_events (
      id,
      organization_id,
      actor_type,
      actor_id,
      action,
      resource_type,
      resource_id,
      occurred_at,
      correlation_id,
      reason,
      version_context,
      previous_event_hash,
      event_hash
    ) values (
      ${auditEventA},
      ${organizationA},
      'user',
      ${userId},
      'upgrade.audit_genesis',
      'organization',
      ${organizationA},
      '2026-07-27T00:00:03.000Z',
      '88000000-0000-4000-8000-000000000001',
      'synthetic previous-release audit genesis',
      '{"schemaVersion":"1"}'::jsonb,
      null,
      ${auditEventHashA}
    ), (
      ${auditEventB},
      ${organizationA},
      'system',
      'upgrade-fixture',
      'upgrade.audit_child',
      'data_source_connection',
      ${connectionA},
      '2026-07-27T00:00:04.000Z',
      '88000000-0000-4000-8000-000000000002',
      'synthetic previous-release audit child',
      '{"schemaVersion":"1"}'::jsonb,
      ${auditEventHashA},
      ${auditEventHashB}
    )
  `;
}

interface AuditSnapshot {
  readonly id: string;
  readonly organizationId: string;
  readonly eventHash: string;
  readonly previousEventHash: string | null;
}

async function auditSnapshot(sql: Sql): Promise<readonly AuditSnapshot[]> {
  const rows = await sql`
    select id, organization_id, event_hash, previous_event_hash
    from audit_events
    order by id
  `;
  return rows.map((row: unknown) => ({
    id: databaseString(row, "id"),
    organizationId: databaseString(row, "organization_id"),
    eventHash: databaseString(row, "event_hash"),
    previousEventHash: databaseNullableString(row, "previous_event_hash"),
  }));
}

async function membershipSnapshot(sql: Sql): Promise<readonly Readonly<Record<string, string>>[]> {
  const rows = await sql`
    select
      organizations.id as organization_id,
      organizations.name as organization_name,
      users.id as user_id,
      users.issuer,
      users.subject,
      memberships.id as membership_id,
      memberships.role,
      memberships.status
    from organizations
    inner join memberships on memberships.organization_id = organizations.id
    inner join users on users.id = memberships.user_id
    order by organizations.id, memberships.id
  `;
  return rows.map((row: unknown) => ({
    organizationId: databaseString(row, "organization_id"),
    organizationName: databaseString(row, "organization_name"),
    userId: databaseString(row, "user_id"),
    issuer: databaseString(row, "issuer"),
    subject: databaseString(row, "subject"),
    membershipId: databaseString(row, "membership_id"),
    role: databaseString(row, "role"),
    status: databaseString(row, "status"),
  }));
}

async function ensureLocalTestRoles(sql: Sql): Promise<void> {
  const existing = await sql`
    select rolname from pg_roles
    where rolname in ('reconai_migrator', 'reconai_app', 'reconai_worker', 'reconai_maintenance')
  `;
  const roleNames = new Set(Array.from(existing, (row: unknown) => databaseString(row, "rolname")));
  if (!roleNames.has("reconai_migrator")) {
    await sql.unsafe(
      "create role reconai_migrator login password 'local-migrator-only' nosuperuser nocreatedb nocreaterole noinherit",
    );
  }
  if (!roleNames.has("reconai_app")) {
    await sql.unsafe(
      "create role reconai_app login password 'local-app-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
    );
  }
  if (!roleNames.has("reconai_worker")) {
    await sql.unsafe(
      "create role reconai_worker login password 'local-worker-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
    );
  }
  if (!roleNames.has("reconai_maintenance")) {
    await sql.unsafe(
      "create role reconai_maintenance login password 'local-maintenance-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
    );
  }
}

async function prepareIsolatedDatabase(sql: Sql): Promise<void> {
  await sql.unsafe("grant create, usage on schema public to reconai_migrator");
  await sql.unsafe(
    "grant usage on schema public to reconai_app, reconai_worker, reconai_maintenance",
  );
  await sql.unsafe(`
    alter default privileges for role reconai_migrator in schema public
    grant select, insert, update, delete on tables to reconai_app
  `);
  await sql.unsafe(`
    alter default privileges for role reconai_migrator in schema public
    grant usage, select on sequences to reconai_app
  `);
}

function withDatabase(value: string, databaseName: string): string {
  const url = new URL(value);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the live previous-release upgrade test`);
  return value;
}

function requiredConnection(value: Sql | undefined, name: string): Sql {
  if (!value) throw new Error(`${name} database connection was not initialized`);
  return value;
}

function databaseString(row: unknown, field: string): string {
  if (typeof row !== "object" || row === null) throw new Error(`database row missing ${field}`);
  const value = (row as Readonly<Record<string, unknown>>)[field];
  if (typeof value !== "string") throw new Error(`database field ${field} was not a string`);
  return value;
}

function databaseNullableString(row: unknown, field: string): string | null {
  if (typeof row !== "object" || row === null) throw new Error(`database row missing ${field}`);
  const value = (row as Readonly<Record<string, unknown>>)[field];
  if (value !== null && typeof value !== "string") {
    throw new Error(`database field ${field} was not nullable text`);
  }
  return value;
}
