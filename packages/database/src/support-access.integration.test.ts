import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  MembershipIdSchema,
  OrganizationIdSchema,
  SupportAccessGrantIdSchema,
  SupportAccessRequestCodeSchema,
  SupportIdentityDigestSchema,
  UserIdSchema,
  tenantContextFromMembership,
} from "@workspace/domain";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresSupportAccessRepository, SupportAccessNotFoundError } from "./support-access.js";

const organizationId = OrganizationIdSchema.parse(randomUUID());
const foreignOrganizationId = OrganizationIdSchema.parse(randomUUID());
const ownerUserId = UserIdSchema.parse(randomUUID());
const analystUserId = UserIdSchema.parse(randomUUID());
const foreignOwnerUserId = UserIdSchema.parse(randomUUID());
const ownerMembershipId = MembershipIdSchema.parse(randomUUID());
const analystMembershipId = MembershipIdSchema.parse(randomUUID());
const foreignOwnerMembershipId = MembershipIdSchema.parse(randomUUID());
const supportIdentityDigest = SupportIdentityDigestSchema.parse("a".repeat(64));
const otherSupportIdentityDigest = SupportIdentityDigestSchema.parse("b".repeat(64));
let administrator: Sql | undefined;
let application: Sql | undefined;
let worker: Sql | undefined;

const ownerTenant = tenantContextFromMembership({
  id: ownerMembershipId,
  organizationId,
  userId: ownerUserId,
  role: "owner",
  status: "active",
});
const analystTenant = tenantContextFromMembership({
  id: analystMembershipId,
  organizationId,
  userId: analystUserId,
  role: "analyst",
  status: "active",
});
const foreignOwnerTenant = tenantContextFromMembership({
  id: foreignOwnerMembershipId,
  organizationId: foreignOrganizationId,
  userId: foreignOwnerUserId,
  role: "owner",
  status: "active",
});

describe("live restricted support access", { concurrent: false }, () => {
  beforeAll(async () => {
    const admin = postgres(requiredEnvironment("DATABASE_ADMIN_URL"), { max: 1 });
    administrator = admin;
    await ensureLocalTestRoles(admin);
    execFileSync("pnpm", ["--filter", "@workspace/database", "db:migrate"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_MIGRATION_URL: requiredEnvironment("DATABASE_MIGRATION_URL"),
      },
      stdio: "pipe",
    });
    await seedTenants(admin);
    application = postgres(requiredEnvironment("DATABASE_URL"), { max: 4 });
    worker = postgres(requiredEnvironment("DATABASE_WORKER_URL"), { max: 1 });
  });

  afterAll(async () => {
    await worker?.end({ timeout: 5 });
    await application?.end({ timeout: 5 });
    await administrator?.end({ timeout: 5 });
  });

  it("requires support request plus tenant-owner approval and audits bounded diagnostic use", async () => {
    const appDatabase = requiredConnection(application, "application");
    const adminDatabase = requiredConnection(administrator, "administrator");
    const repository = new PostgresSupportAccessRepository(appDatabase);
    const request = await repository.createRequest(supportIdentityDigest, {
      requestedDurationMinutes: 30,
    });
    expect(request.requestCode).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const durableRequest = await adminDatabase`
      select
        support_identity_digest,
        request_token_sha256,
        requested_duration_minutes,
        status,
        request_expires_at,
        created_at
      from support_access_requests
      where request_token_sha256 = ${sha256(request.requestCode)}
    `;
    expect(durableRequest[0]).toMatchObject({
      support_identity_digest: supportIdentityDigest,
      requested_duration_minutes: 30,
      status: "pending",
    });
    expect(databaseString(durableRequest[0], "request_token_sha256")).not.toBe(request.requestCode);
    expect(
      new Date(databaseTimestamp(durableRequest[0], "request_expires_at")).getTime() -
        new Date(databaseTimestamp(durableRequest[0], "created_at")).getTime(),
    ).toBe(15 * 60 * 1000);

    await expect(
      repository.approve(analystTenant, {
        requestCode: request.requestCode,
        ticketReference: "SUP-2001",
        reason: "Investigate synthetic connector lag",
        correlationId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(SupportAccessNotFoundError);

    const approved = await repository.approve(ownerTenant, {
      requestCode: request.requestCode,
      ticketReference: "SUP-2001",
      reason: "Investigate synthetic connector lag",
      correlationId: randomUUID(),
    });
    expect(approved).toMatchObject({
      supportIdentityReference: "a".repeat(12),
      capability: "diagnostics:view",
      ticketReference: "SUP-2001",
      status: "active",
    });
    expect(new Date(approved.expiresAt).getTime() - new Date(approved.approvedAt).getTime()).toBe(
      30 * 60 * 1000,
    );
    await expect(
      repository.approve(ownerTenant, {
        requestCode: request.requestCode,
        ticketReference: "SUP-2001",
        reason: "Replay must not create another support grant",
        correlationId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(SupportAccessNotFoundError);

    expect(await repository.list(ownerTenant, 20)).toContainEqual(approved);
    expect(await repository.list(analystTenant, 20)).toEqual([]);

    const diagnostics = await repository.diagnostics(
      organizationId,
      approved.id,
      supportIdentityDigest,
      randomUUID(),
    );
    expect(diagnostics).toMatchObject({
      schemaVersion: "support-diagnostics-v1",
      countsCapped: false,
      connections: { total: 2, nonHealthy: 1 },
      providerSyncs: { active: 0, failed: 0 },
      reconciliations: { active: 0, failedOrPartial: 0 },
      exceptions: { unresolved: 0 },
      outbox: { unpublished: 1, deadLettered: 1 },
    });
    expect(diagnostics).not.toHaveProperty("externalAccountId");
    expect(diagnostics).not.toHaveProperty("amountMinor");

    for (const denied of [
      repository.diagnostics(organizationId, approved.id, otherSupportIdentityDigest, randomUUID()),
      repository.diagnostics(
        foreignOrganizationId,
        approved.id,
        supportIdentityDigest,
        randomUUID(),
      ),
      repository.revoke(foreignOwnerTenant, {
        grantId: approved.id,
        reason: "Foreign tenant must not see this grant",
        correlationId: randomUUID(),
      }),
    ]) {
      await expect(denied).rejects.toBeInstanceOf(SupportAccessNotFoundError);
    }

    const auditBeforeRevocation = await adminDatabase`
      select actor_type, actor_id, action, resource_id, new_value
      from audit_events
      where organization_id = ${organizationId}
      order by occurred_at, id
    `;
    expect(auditBeforeRevocation.map((row: unknown) => databaseString(row, "action"))).toEqual([
      "support.access.approved",
      "support.diagnostics.viewed",
    ]);
    expect(auditBeforeRevocation[1]).toMatchObject({
      actor_type: "support",
      actor_id: supportIdentityDigest,
      resource_id: approved.id,
    });

    const revoked = await repository.revoke(ownerTenant, {
      grantId: approved.id,
      reason: "Customer owner ended the synthetic support session",
      correlationId: randomUUID(),
    });
    expect(revoked.outcome).toBe("revoked");
    const replayed = await repository.revoke(ownerTenant, {
      grantId: approved.id,
      reason: "Retry the same completed revocation",
      correlationId: randomUUID(),
    });
    expect(replayed.outcome).toBe("already_revoked");
    await expect(
      repository.diagnostics(organizationId, approved.id, supportIdentityDigest, randomUUID()),
    ).rejects.toBeInstanceOf(SupportAccessNotFoundError);
    const revocationAudit = await adminDatabase`
      select count(*)::integer as count
      from audit_events
      where organization_id = ${organizationId}
        and action = 'support.access.revoked'
        and resource_id = ${approved.id}
    `;
    expect(revocationAudit[0]).toMatchObject({ count: 1 });
  });

  it("rejects expired authority, direct table access, mutation, and worker function calls", async () => {
    const appDatabase = requiredConnection(application, "application");
    const workerDatabase = requiredConnection(worker, "worker");
    const adminDatabase = requiredConnection(administrator, "administrator");
    const repository = new PostgresSupportAccessRepository(appDatabase);
    const expiredRequestCode = SupportAccessRequestCodeSchema.parse(
      randomBytes(32).toString("base64url"),
    );
    const expiredRequestId = randomUUID();
    const expiredCreatedAt = new Date(Date.now() - 20 * 60 * 1000);
    await adminDatabase`
      insert into support_access_requests (
        id,
        support_identity_digest,
        request_token_sha256,
        requested_duration_minutes,
        status,
        request_expires_at,
        created_at
      ) values (
        ${expiredRequestId}::uuid,
        ${supportIdentityDigest},
        ${sha256(expiredRequestCode)},
        5,
        'pending',
        ${new Date(expiredCreatedAt.getTime() + 15 * 60 * 1000).toISOString()}::timestamptz,
        ${expiredCreatedAt.toISOString()}::timestamptz
      )
    `;
    await expect(
      repository.approve(ownerTenant, {
        requestCode: expiredRequestCode,
        ticketReference: "SUP-EXPIRED",
        reason: "Expired requests cannot create support authority",
        correlationId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(SupportAccessNotFoundError);

    const expiredGrantId = SupportAccessGrantIdSchema.parse(randomUUID());
    const expiredApprovedAt = new Date(Date.now() - 10 * 60 * 1000);
    await adminDatabase`
      insert into support_access_grants (
        id,
        organization_id,
        support_identity_digest,
        capability,
        ticket_reference,
        reason,
        approved_by_membership_id,
        approved_at,
        expires_at,
        status,
        created_at
      ) values (
        ${expiredGrantId}::uuid,
        ${organizationId}::uuid,
        ${supportIdentityDigest},
        'diagnostics:view',
        'SUP-EXPIRED-GRANT',
        'Synthetic expired support grant',
        ${ownerMembershipId}::uuid,
        ${expiredApprovedAt.toISOString()}::timestamptz,
        ${new Date(expiredApprovedAt.getTime() + 5 * 60 * 1000).toISOString()}::timestamptz,
        'active',
        ${expiredApprovedAt.toISOString()}::timestamptz
      )
    `;
    await expect(
      repository.diagnostics(organizationId, expiredGrantId, supportIdentityDigest, randomUUID()),
    ).rejects.toBeInstanceOf(SupportAccessNotFoundError);

    await expect(
      appDatabase.begin(async (transaction) => {
        await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
        await transaction`select * from support_access_grants`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      workerDatabase`select * from public.reconai_support_diagnostics(
        ${organizationId}::uuid,
        ${expiredGrantId}::uuid,
        ${supportIdentityDigest}
      )`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      adminDatabase`
        update support_access_requests
        set request_expires_at = request_expires_at + interval '1 hour'
        where id = ${expiredRequestId}::uuid
      `,
    ).rejects.toThrow(/transition is not permitted/u);
    await expect(
      adminDatabase`
        update support_access_grants
        set expires_at = expires_at + interval '1 hour'
        where organization_id = ${organizationId}::uuid
          and id = ${expiredGrantId}::uuid
      `,
    ).rejects.toThrow(/transition is not permitted/u);
  });
});

async function seedTenants(sql: Sql): Promise<void> {
  await sql`
    insert into organizations (id, name, status)
    values
      (${organizationId}, 'Support Access Integration', 'active'),
      (${foreignOrganizationId}, 'Foreign Support Access Integration', 'active')
  `;
  await sql`
    insert into users (id, issuer, subject, email, status)
    values
      (${ownerUserId}, 'https://issuer.test', ${`owner-${ownerUserId}`}, 'owner@example.test', 'active'),
      (${analystUserId}, 'https://issuer.test', ${`analyst-${analystUserId}`}, 'analyst@example.test', 'active'),
      (${foreignOwnerUserId}, 'https://issuer.test', ${`foreign-${foreignOwnerUserId}`}, 'foreign@example.test', 'active')
  `;
  await sql`
    insert into memberships (id, organization_id, user_id, role, status)
    values
      (${ownerMembershipId}, ${organizationId}, ${ownerUserId}, 'owner', 'active'),
      (${analystMembershipId}, ${organizationId}, ${analystUserId}, 'analyst', 'active'),
      (
        ${foreignOwnerMembershipId},
        ${foreignOrganizationId},
        ${foreignOwnerUserId},
        'owner',
        'active'
      )
  `;
  await sql`
    insert into data_source_connections (
      id,
      organization_id,
      provider,
      external_account_id,
      status,
      connector_version
    ) values
      (
        ${randomUUID()},
        ${organizationId},
        'shopify',
        ${`shop-${randomUUID()}`},
        'healthy',
        '1.0.0'
      ),
      (
        ${randomUUID()},
        ${organizationId},
        'stripe',
        ${`acct-${randomUUID()}`},
        'degraded',
        '1.0.0'
      )
  `;
  await sql`
    insert into outbox_events (
      id,
      organization_id,
      event_type,
      schema_version,
      idempotency_key,
      payload,
      correlation_id,
      dead_lettered_at
    ) values
      (
        ${randomUUID()},
        ${organizationId},
        'synthetic.support.pending',
        1,
        ${`support-pending-${randomUUID()}`},
        ${sql.json({ schemaVersion: 1 })},
        ${randomUUID()},
        null
      ),
      (
        ${randomUUID()},
        ${organizationId},
        'synthetic.support.dead',
        1,
        ${`support-dead-${randomUUID()}`},
        ${sql.json({ schemaVersion: 1 })},
        ${randomUUID()},
        now()
      )
  `;
}

async function ensureLocalTestRoles(sql: Sql): Promise<void> {
  const existing = await sql`
    select rolname from pg_roles
    where rolname in ('reconai_migrator', 'reconai_app', 'reconai_worker')
  `;
  const names = new Set(Array.from(existing, (row) => databaseString(row, "rolname")));
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for database integration tests`);
  return value;
}

function requiredConnection(value: Sql | undefined, name: string): Sql {
  if (!value) throw new Error(`${name} database connection was not initialized`);
  return value;
}

function databaseString(value: unknown, field: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`database returned an invalid ${field}`);
  }
  const item = (value as Record<string, unknown>)[field];
  if (typeof item !== "string") throw new Error(`database returned an invalid ${field}`);
  return item;
}

function databaseTimestamp(value: unknown, field: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`database returned an invalid ${field}`);
  }
  const item = (value as Record<string, unknown>)[field];
  if (item instanceof Date && Number.isFinite(item.getTime())) return item.toISOString();
  if (typeof item === "string" && Number.isFinite(new Date(item).getTime())) {
    return new Date(item).toISOString();
  }
  throw new Error(`database returned an invalid ${field}`);
}
