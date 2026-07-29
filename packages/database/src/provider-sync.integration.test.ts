import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { ProviderSyncJobEnvelopeSchema, type ProviderSyncJobEnvelope } from "@workspace/connectors";
import {
  MembershipIdSchema,
  OrganizationIdSchema,
  UserIdSchema,
  tenantContextFromMembership,
} from "@workspace/domain";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresProviderActiveSyncObservabilityRepository } from "./provider-active-sync-observability.js";
import { PostgresProviderSyncRepository } from "./provider-sync.js";

const organizationId = OrganizationIdSchema.parse(randomUUID());
const otherOrganizationId = OrganizationIdSchema.parse(randomUUID());
const userId = UserIdSchema.parse(randomUUID());
const otherUserId = UserIdSchema.parse(randomUUID());
const membershipId = MembershipIdSchema.parse(randomUUID());
const otherMembershipId = MembershipIdSchema.parse(randomUUID());
const connectionId = randomUUID();
const shopifyConnectionId = randomUUID();
const otherConnectionId = randomUUID();
const externalAccountId = `acct_${connectionId.replaceAll("-", "")}`;
const shopifyExternalAccountId = "reconai-recovery-test.myshopify.com";
const otherExternalAccountId = `acct_${otherConnectionId.replaceAll("-", "")}`;
let administrator: Sql | undefined;
let application: Sql | undefined;
let worker: Sql | undefined;
const traceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";

const tenant = tenantContextFromMembership({
  id: membershipId,
  organizationId,
  userId,
  role: "administrator",
  status: "active",
});
const otherTenant = tenantContextFromMembership({
  id: otherMembershipId,
  organizationId: otherOrganizationId,
  userId: otherUserId,
  role: "administrator",
  status: "active",
});

describe("live bounded provider sync persistence", { concurrent: false }, () => {
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
    await seedTenants(admin);
    application = postgres(applicationUrl, { max: 1 });
    worker = postgres(workerUrl, { max: 1 });
  });

  afterAll(async () => {
    await worker?.end({ timeout: 5 });
    await application?.end({ timeout: 5 });
    await administrator?.end({ timeout: 5 });
  });

  it("creates one tenant-bound outbox authority and preserves terminal progress evidence", async () => {
    const appDatabase = requiredConnection(application, "application");
    const workerDatabase = requiredConnection(worker, "worker");
    const admin = requiredConnection(administrator, "administrator");
    const manager = new PostgresProviderSyncRepository(appDatabase);
    const processor = new PostgresProviderSyncRepository(workerDatabase);
    const activeSyncObserver = new PostgresProviderActiveSyncObservabilityRepository(
      workerDatabase,
    );
    const input = {
      connectionId,
      mode: "gap_repair" as const,
      windowStart: "2026-07-26T00:00:00.000Z",
      windowEnd: "2026-07-27T00:00:00.000Z",
      maximumPages: 3,
      reason: "Repair the bounded provider integration gap",
      correlationId: randomUUID(),
      traceparent,
    };

    const created = await manager.start(tenant, input);
    await expect(manager.start(tenant, input)).resolves.toEqual(created);
    await expect(manager.list(tenant, connectionId)).resolves.toEqual([created]);
    await expect(manager.list(otherTenant, connectionId)).resolves.toEqual([]);
    await expect(
      appDatabase`select * from reconai_observe_provider_active_syncs()`,
    ).rejects.toMatchObject({ code: "42501" });
    const queuedObservation = await activeSyncObserver.observeProviderActiveSyncs();
    expect(queuedObservation).toMatchObject([
      { provider: "shopify", activityState: "empty" },
      {
        provider: "stripe",
        activityState: "active",
        syncStatus: "queued",
      },
    ]);
    const stripeQueued = queuedObservation[1];
    if (stripeQueued?.activityState !== "active") {
      throw new Error("expected an active Stripe sync observation");
    }
    expect(stripeQueued.oldestAgeSeconds).toBeGreaterThanOrEqual(0);
    await expect(workerDatabase`select id from provider_sync_runs limit 1`).resolves.toHaveLength(
      0,
    );

    const envelope = await loadSyncEnvelope(admin, created.id);
    expect(envelope.traceContext).toEqual({ schemaVersion: 1, traceparent });
    const authority = await processor.loadForProcessing(envelope);
    expect(authority).toMatchObject({
      runId: created.id,
      organizationId,
      connectionId,
      provider: "stripe",
      externalAccountId,
      apiCredentialReference: "env:RECONAI_CONNECTOR_STRIPE_READ_INTEGRATION",
      status: "running",
    });
    await expect(activeSyncObserver.observeProviderActiveSyncs()).resolves.toMatchObject([
      { provider: "shopify", activityState: "empty" },
      {
        provider: "stripe",
        activityState: "active",
        syncStatus: "running",
      },
    ]);
    await expect(
      processor.loadForProcessing({
        ...envelope,
        organizationId: otherOrganizationId,
        connectionId: otherConnectionId,
      }),
    ).resolves.toBeUndefined();

    const afterFirst = await processor.advancePage(envelope, {
      nextCursor: "evt_provider_sync_cursor_1",
      hasMore: true,
      itemCount: 2,
      duplicateCount: 1,
      completedAt: "2026-07-27T12:01:00.000Z",
    });
    expect(afterFirst).toMatchObject({
      status: "running",
      cursor: "evt_provider_sync_cursor_1",
      pageCount: 1,
      itemCount: 2,
      duplicateCount: 1,
    });
    const completed = await processor.advancePage(envelope, {
      expectedCursor: "evt_provider_sync_cursor_1",
      hasMore: false,
      itemCount: 1,
      duplicateCount: 0,
      completedAt: "2026-07-27T12:02:00.000Z",
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      pageCount: 2,
      itemCount: 3,
      duplicateCount: 1,
    });
    await expect(activeSyncObserver.observeProviderActiveSyncs()).resolves.toEqual([
      { provider: "shopify", activityState: "empty" },
      { provider: "stripe", activityState: "empty" },
    ]);

    const evidence = await admin`
      select
        (select count(*)::integer from provider_sync_runs
          where organization_id = ${organizationId}) as runs,
        (select count(*)::integer from outbox_events
          where organization_id = ${organizationId}
            and event_type = 'connector.sync.requested') as outbox,
        (select count(*)::integer from audit_events
          where organization_id = ${organizationId}
            and resource_type = 'provider_sync_run') as audits
    `;
    expect(evidence[0]).toMatchObject({ runs: 1, outbox: 1, audits: 2 });

    await expect(
      workerDatabase.begin(async (transaction) => {
        await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
        await transaction`
          update provider_sync_runs
          set maximum_pages = 4
          where organization_id = ${organizationId}
            and id = ${created.id}::uuid
        `;
      }),
    ).rejects.toThrow(/provider sync authority is immutable/u);
    await expect(
      admin`
        delete from provider_sync_runs
        where organization_id = ${organizationId}
          and id = ${created.id}::uuid
      `,
    ).rejects.toThrow(/provider sync runs are append-only/u);
  });

  it("caps transient execution failures and marks the connection degraded", async () => {
    const appDatabase = requiredConnection(application, "application");
    const workerDatabase = requiredConnection(worker, "worker");
    const admin = requiredConnection(administrator, "administrator");
    const manager = new PostgresProviderSyncRepository(appDatabase);
    const processor = new PostgresProviderSyncRepository(workerDatabase);
    const run = await manager.start(tenant, {
      connectionId,
      mode: "backfill",
      windowStart: "2026-07-25T00:00:00.000Z",
      windowEnd: "2026-07-26T00:00:00.000Z",
      maximumPages: 1,
      reason: "Exercise the bounded provider retry ceiling",
      correlationId: randomUUID(),
    });
    const envelope = await loadSyncEnvelope(admin, run.id);
    await processor.loadForProcessing(envelope);

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await expect(
        processor.recordFailure(envelope, {
          errorCode: "PROVIDER_SYNC_RATE_LIMITED",
          terminalRequested: false,
          failedAt: `2026-07-27T12:0${String(attempt)}:00.000Z`,
        }),
      ).resolves.toEqual({ terminal: attempt === 6 });
    }
    const failed = await manager.list(tenant, connectionId);
    expect(failed[0]).toMatchObject({
      id: run.id,
      status: "failed",
      failedAttempts: 6,
      lastErrorCode: "PROVIDER_SYNC_RATE_LIMITED",
    });
    const connection = await admin`
      select status
      from data_source_connections
      where organization_id = ${organizationId}
        and id = ${connectionId}::uuid
    `;
    expect(connection[0]?.["status"]).toBe("degraded");
  });

  it("schedules one replay-safe system-authorized repair per due connection", async () => {
    const workerDatabase = requiredConnection(worker, "worker");
    const admin = requiredConnection(administrator, "administrator");
    const scheduler = new PostgresProviderSyncRepository(workerDatabase);
    const input = {
      now: "2026-07-27T15:07:00.000Z",
      cadenceMs: 900_000,
      lookbackMs: 86_400_000,
      overlapMs: 300_000,
      maximumPages: 5,
      batchSize: 100,
    };

    const scheduled = await scheduler.scheduleDueGapRepairs(input);
    expect(scheduled).toMatchObject({
      examined: 3,
      scheduled: 3,
      skipped: 0,
    });
    expect(scheduled.candidateObservations).toHaveLength(3);
    expect(
      scheduled.candidateObservations.filter(
        (candidate) => candidate.freshnessReference === "never_succeeded",
      ),
    ).toHaveLength(2);
    expect(
      scheduled.candidateObservations.filter(
        (candidate) => candidate.freshnessReference === "last_successful_sync",
      ),
    ).toEqual([
      {
        provider: "stripe",
        freshnessReference: "last_successful_sync",
        disposition: "scheduled",
        ageSeconds: 11_100,
      },
    ]);
    await expect(scheduler.scheduleDueGapRepairs(input)).resolves.toEqual({
      examined: 0,
      scheduled: 0,
      skipped: 0,
      candidateObservations: [],
    });

    const systemRuns = await admin`
      select
        organization_id,
        connection_id,
        provider,
        mode,
        requester_type,
        requested_by_membership_id,
        requested_by_service,
        window_start,
        window_end,
        maximum_pages
      from provider_sync_runs
      where requester_type = 'system'
      order by organization_id, connection_id
    `;
    expect(systemRuns).toHaveLength(3);
    expect(
      Array.from(systemRuns, (row: unknown) => {
        if (typeof row !== "object" || row === null) throw new Error("invalid system run row");
        const value = row as Record<string, unknown>;
        return {
          requesterType: value["requester_type"],
          membershipId: value["requested_by_membership_id"],
          service: value["requested_by_service"],
          mode: value["mode"],
          maximumPages: value["maximum_pages"],
        };
      }),
    ).toEqual([
      {
        requesterType: "system",
        membershipId: null,
        service: "provider-gap-repair-scheduler",
        mode: "gap_repair",
        maximumPages: 5,
      },
      {
        requesterType: "system",
        membershipId: null,
        service: "provider-gap-repair-scheduler",
        mode: "gap_repair",
        maximumPages: 5,
      },
      {
        requesterType: "system",
        membershipId: null,
        service: "provider-gap-repair-scheduler",
        mode: "gap_repair",
        maximumPages: 5,
      },
    ]);
    const evidence = await admin`
      select
        (select count(*)::integer
          from outbox_events
          where event_type = 'connector.sync.requested'
            and payload ->> 'requestedBy' = 'provider-gap-repair-scheduler') as outbox,
        (select count(*)::integer
          from outbox_events
          where event_type = 'connector.sync.requested'
            and payload ->> 'requestedBy' = 'provider-gap-repair-scheduler'
            and execution_tracking_version = 1) as tracked_outbox,
        (select count(*)::integer
          from audit_events
          where action = 'provider_sync.scheduled'
            and actor_type = 'system'
            and actor_id = 'provider-gap-repair-scheduler') as audits
    `;
    expect(evidence[0]).toMatchObject({ outbox: 3, tracked_outbox: 3, audits: 3 });

    const tenantRuns = await new PostgresProviderSyncRepository(
      requiredConnection(application, "application"),
    ).list(tenant, connectionId);
    expect(tenantRuns.find((run) => run.requesterType === "system")).toMatchObject({
      requesterType: "system",
      mode: "gap_repair",
    });
    expect(tenantRuns.every((run) => run.organizationId === organizationId)).toBe(true);

    const scheduledEnvelopes = await admin`
      select payload
      from outbox_events
      where event_type = 'connector.sync.requested'
        and payload ->> 'requestedBy' = 'provider-gap-repair-scheduler'
    `;
    for (const row of scheduledEnvelopes) {
      const scheduledEnvelope = ProviderSyncJobEnvelopeSchema.parse(row["payload"]);
      expect(scheduledEnvelope.traceContext).toBeUndefined();
      await scheduler.recordFailure(scheduledEnvelope, {
        errorCode: "PROVIDER_SYNC_SCHEDULED_TEST_CLOSED",
        terminalRequested: true,
        failedAt: "2026-07-27T15:08:00.000Z",
      });
    }
  });

  it("loads a tenant-bound Shopify snapshot recovery authority", async () => {
    const appDatabase = requiredConnection(application, "application");
    const workerDatabase = requiredConnection(worker, "worker");
    const admin = requiredConnection(administrator, "administrator");
    const manager = new PostgresProviderSyncRepository(appDatabase);
    const processor = new PostgresProviderSyncRepository(workerDatabase);
    const created = await manager.start(tenant, {
      connectionId: shopifyConnectionId,
      mode: "gap_repair",
      windowStart: "2026-07-26T00:00:00.000Z",
      windowEnd: "2026-07-27T00:00:00.000Z",
      maximumPages: 2,
      reason: "Repair the bounded Shopify order snapshot gap",
      correlationId: randomUUID(),
    });

    const envelope = await loadSyncEnvelope(admin, created.id);
    await expect(processor.loadForProcessing(envelope)).resolves.toMatchObject({
      runId: created.id,
      organizationId,
      connectionId: shopifyConnectionId,
      provider: "shopify",
      externalAccountId: shopifyExternalAccountId,
      apiCredentialReference: "env:RECONAI_CONNECTOR_SHOPIFY_READ_INTEGRATION",
      configuredApiVersion: "2026-07",
      status: "running",
    });
  });
});

async function loadSyncEnvelope(
  sql: Sql,
  requestedRunId: string,
): Promise<ProviderSyncJobEnvelope> {
  const rows = await sql`
    select payload
    from outbox_events
    where organization_id = ${organizationId}
      and event_type = 'connector.sync.requested'
      and payload ->> 'syncRunId' = ${requestedRunId}
    limit 1
  `;
  return ProviderSyncJobEnvelopeSchema.parse(rows[0]?.["payload"]);
}

async function seedTenants(sql: Sql): Promise<void> {
  await sql`
    insert into organizations (id, name) values
      (${organizationId}, 'Provider Sync Integration Tenant'),
      (${otherOrganizationId}, 'Other Provider Sync Integration Tenant')
  `;
  await sql`
    insert into users (id, issuer, subject, email) values
      (${userId}, 'https://issuer.example.test', ${`sync-${userId}`}, 'sync@example.test'),
      (${otherUserId}, 'https://issuer.example.test', ${`sync-${otherUserId}`}, 'other-sync@example.test')
  `;
  await sql`
    insert into memberships (id, organization_id, user_id, role, status) values
      (${membershipId}, ${organizationId}, ${userId}, 'administrator', 'active'),
      (${otherMembershipId}, ${otherOrganizationId}, ${otherUserId}, 'administrator', 'active')
  `;
  await sql`
    insert into data_source_connections (
      id, organization_id, provider, external_account_id, status, connector_version,
      api_version, credential_reference, credential_key_version, api_credential_reference,
      created_at, updated_at
    ) values
      (
        ${connectionId}, ${organizationId}, 'stripe', ${externalAccountId},
        'healthy', '1.0.0', '2025-06-30.basil',
        'env:RECONAI_CONNECTOR_STRIPE_WEBHOOK_INTEGRATION', 'env-v1',
        'env:RECONAI_CONNECTOR_STRIPE_READ_INTEGRATION',
        '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z'
      ),
      (
        ${shopifyConnectionId}, ${organizationId}, 'shopify', ${shopifyExternalAccountId},
        'healthy', '1.0.0', '2026-07',
        'env:RECONAI_CONNECTOR_SHOPIFY_WEBHOOK_INTEGRATION', 'env-v1',
        'env:RECONAI_CONNECTOR_SHOPIFY_READ_INTEGRATION',
        '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z'
      ),
      (
        ${otherConnectionId}, ${otherOrganizationId}, 'stripe', ${otherExternalAccountId},
        'healthy', '1.0.0', '2025-06-30.basil',
        'env:RECONAI_CONNECTOR_STRIPE_WEBHOOK_INTEGRATION', 'env-v1',
        'env:RECONAI_CONNECTOR_STRIPE_READ_INTEGRATION',
        '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z'
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
