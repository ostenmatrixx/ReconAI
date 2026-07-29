import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresMembershipDirectory,
  PostgresOrganizationBootstrapper,
  type OrganizationBootstrapRequest,
  type VerifiedIdentity,
} from "./auth.js";

let administrator: Sql | undefined;
let application: Sql | undefined;

describe("live PostgreSQL organization bootstrap service", { concurrent: false }, () => {
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
    application = postgres(applicationUrl, { max: 4 });
  });

  afterAll(async () => {
    await application?.end({ timeout: 5 });
    await administrator?.end({ timeout: 5 });
  });

  it("creates one AI-disabled owner tenant and exactly replays its atomic audit evidence", async () => {
    const app = requiredConnection(application, "application");
    const admin = requiredConnection(administrator, "administrator");
    const bootstrapper = new PostgresOrganizationBootstrapper(app);
    const identity = verifiedIdentity("service-owner");
    const request = bootstrapRequest("Service Bootstrap Tenant");

    const created = await bootstrapper.bootstrap(identity, request);
    expect(created).toMatchObject({
      status: "created",
      access: {
        name: request.name,
        role: "owner",
      },
      businessTimeZone: request.businessTimeZone,
    });
    const createdAccess = created.access;
    if (!createdAccess) throw new Error("created bootstrap did not return organization access");

    const replayed = await bootstrapper.bootstrap(identity, request);
    expect(replayed).toEqual({ ...created, status: "replayed" });

    const state = requiredRow(
      await admin`
        select
          users.id as user_id,
          organizations.id as organization_id,
          organizations.ai_enabled,
          memberships.id as membership_id,
          memberships.role,
          memberships.status as membership_status,
          (select count(*)::integer
             from organization_bootstrap_requests requests
             where requests.user_id = users.id) as request_count,
          (select count(*)::integer
             from audit_events events
             where events.organization_id = organizations.id
               and events.action = 'organization.created') as audit_count
        from users
        inner join memberships on memberships.user_id = users.id
        inner join organizations on organizations.id = memberships.organization_id
        where users.issuer = ${identity.issuer}
          and users.subject = ${identity.subject}
      `,
      "created bootstrap state",
    );
    expect(state).toMatchObject({
      ai_enabled: false,
      role: "owner",
      membership_status: "active",
      request_count: 1,
      audit_count: 1,
    });
    expect(databaseString(state, "organization_id")).toBe(createdAccess.id);
    expect(databaseString(state, "membership_id")).toBe(createdAccess.membershipId);

    const audit = requiredRow(
      await admin`
        select
          actor_type,
          actor_id,
          correlation_id,
          reason,
          previous_event_hash,
          event_hash,
          hash_version,
          new_value,
          version_context
        from audit_events
        where organization_id = ${createdAccess.id}
          and action = 'organization.created'
      `,
      "organization.created audit event",
    );
    expect(audit).toMatchObject({
      actor_type: "user",
      actor_id: databaseString(state, "user_id"),
      correlation_id: request.correlationId,
      reason: "Initial organization created by verified owner",
      previous_event_hash: null,
      hash_version: 2,
      new_value: {
        businessTimeZone: request.businessTimeZone,
        name: request.name,
        ownerMembershipId: createdAccess.membershipId,
        status: "active",
      },
      version_context: { organizationBootstrapSchemaVersion: 1 },
    });
    expect(databaseString(audit, "event_hash")).toMatch(/^[0-9a-f]{64}$/u);

    const directory = new PostgresMembershipDirectory(app);
    await expect(directory.list(identity, { limit: 10 })).resolves.toMatchObject({
      items: [
        {
          id: createdAccess.id,
          membershipId: createdAccess.membershipId,
          name: request.name,
          role: "owner",
        },
      ],
    });
    await expect(
      directory.list(verifiedIdentity("foreign-service-owner"), { limit: 10 }),
    ).resolves.toEqual({ items: [] });
    await expect(app`select * from organization_bootstrap_requests`).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("serializes concurrent service retries into one organization, membership, request, and audit", async () => {
    const app = requiredConnection(application, "application");
    const admin = requiredConnection(administrator, "administrator");
    const bootstrapper = new PostgresOrganizationBootstrapper(app);
    const identity = verifiedIdentity("concurrent-service-owner");
    const request = bootstrapRequest("Concurrent Service Tenant");

    const outcomes = await Promise.all([
      bootstrapper.bootstrap(identity, request),
      bootstrapper.bootstrap(identity, request),
    ]);
    expect(outcomes.map(({ status }) => status).sort()).toEqual(["created", "replayed"]);
    expect(new Set(outcomes.map(({ access }) => access?.id)).size).toBe(1);
    expect(new Set(outcomes.map(({ access }) => access?.membershipId)).size).toBe(1);

    const counts = requiredRow(
      await admin`
        select
          count(distinct organizations.id)::integer as organization_count,
          count(distinct memberships.id)::integer as membership_count,
          count(distinct requests.id)::integer as request_count,
          count(distinct events.id)::integer as audit_count
        from users
        inner join memberships on memberships.user_id = users.id
        inner join organizations on organizations.id = memberships.organization_id
        inner join organization_bootstrap_requests requests on requests.user_id = users.id
        inner join audit_events events on events.organization_id = organizations.id
          and events.action = 'organization.created'
        where users.issuer = ${identity.issuer}
          and users.subject = ${identity.subject}
      `,
      "concurrent bootstrap counts",
    );
    expect(counts).toMatchObject({
      organization_count: 1,
      membership_count: 1,
      request_count: 1,
      audit_count: 1,
    });
  });

  it("rolls back all bootstrap authority when the first audit append fails", async () => {
    const app = requiredConnection(application, "application");
    const admin = requiredConnection(administrator, "administrator");
    const bootstrapper = new PostgresOrganizationBootstrapper(app);
    const identity = verifiedIdentity("audit-rollback-service-owner");
    const request = bootstrapRequest("Audit Rollback Service Tenant");

    await expect(
      bootstrapper.bootstrap(identity, { ...request, correlationId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "22P02" });

    const rolledBack = requiredRow(
      await admin`
        select
          (select count(*)::integer
             from users
             where issuer = ${identity.issuer} and subject = ${identity.subject}) as user_count,
          (select count(*)::integer
             from organizations
             where name = ${request.name}) as organization_count,
          (select count(*)::integer
             from organization_bootstrap_requests requests
             inner join users on users.id = requests.user_id
             where users.issuer = ${identity.issuer}
               and users.subject = ${identity.subject}) as request_count,
          (select count(*)::integer
             from audit_events
             where correlation_id::text = 'not-a-uuid') as audit_count
      `,
      "rolled-back bootstrap state",
    );
    expect(rolledBack).toEqual({
      user_count: 0,
      organization_count: 0,
      request_count: 0,
      audit_count: 0,
    });

    await expect(bootstrapper.bootstrap(identity, request)).resolves.toMatchObject({
      status: "created",
      access: { name: request.name, role: "owner" },
    });
  });
});

function verifiedIdentity(subject: string): VerifiedIdentity {
  return {
    issuer: "https://bootstrap-live.example.test",
    subject,
    email: `${subject}@example.test`,
    emailVerified: true,
  };
}

function bootstrapRequest(name: string): OrganizationBootstrapRequest {
  return {
    name,
    businessTimeZone: "Asia/Manila",
    idempotencyKey: randomUUID(),
    correlationId: randomUUID(),
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required; start the documented PostgreSQL integration environment`);
  }
  return value;
}

function requiredConnection(value: Sql | undefined, name: string): Sql {
  if (!value) throw new Error(`${name} database connection was not initialized`);
  return value;
}

function requiredRow(
  rows: readonly unknown[],
  description: string,
): Readonly<Record<string, unknown>> {
  const row = rows[0];
  if (typeof row !== "object" || row === null) throw new Error(`${description} was not found`);
  return row as Readonly<Record<string, unknown>>;
}

function databaseString(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new Error(`database field ${field} was not a string`);
  return value;
}

async function ensureLocalTestRoles(sql: Sql): Promise<void> {
  const existing = await sql`
    select rolname from pg_roles
    where rolname in ('reconai_migrator', 'reconai_app', 'reconai_worker')
  `;
  const roleNames = new Set(
    Array.from(existing, (row: unknown) =>
      databaseString(row as Readonly<Record<string, unknown>>, "rolname"),
    ),
  );
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
  await sql.unsafe(`
    alter default privileges for role reconai_migrator in schema public
    grant usage, select on sequences to reconai_app
  `);
}
