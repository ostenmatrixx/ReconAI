import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { MembershipIdSchema, OrganizationIdSchema, UserIdSchema } from "@workspace/domain";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApi, type ApiApplication, type ApiDependencies } from "./app.js";
import {
  AuthenticationError,
  PostgresMembershipDirectory,
  type IdentityVerifier,
  type VerifiedIdentity,
} from "./auth.js";
import { PostgresReconciliationRepository } from "./repository.js";

const issuer = "https://organization-profile.example.test";
const organizationId = OrganizationIdSchema.parse(randomUUID());
const foreignOrganizationId = OrganizationIdSchema.parse(randomUUID());
const administratorOneId = UserIdSchema.parse(randomUUID());
const administratorTwoId = UserIdSchema.parse(randomUUID());
const analystId = UserIdSchema.parse(randomUUID());
const foreignOwnerId = UserIdSchema.parse(randomUUID());
const administratorOneMembershipId = MembershipIdSchema.parse(randomUUID());
const administratorTwoMembershipId = MembershipIdSchema.parse(randomUUID());
const analystMembershipId = MembershipIdSchema.parse(randomUUID());
const foreignOwnerMembershipId = MembershipIdSchema.parse(randomUUID());

const identities = {
  administratorOne: verifiedIdentity("profile-administrator-one"),
  administratorTwo: verifiedIdentity("profile-administrator-two"),
  analyst: verifiedIdentity("profile-analyst"),
  foreignOwner: verifiedIdentity("profile-foreign-owner"),
} as const;

const authorizationHeaders = {
  administratorOne: "Bearer profile-administrator-one",
  administratorTwo: "Bearer profile-administrator-two",
  analyst: "Bearer profile-analyst",
  foreignOwner: "Bearer profile-foreign-owner",
} as const;

let administrator: Sql | undefined;
let application: Sql | undefined;
let api: ApiApplication | undefined;

describe("live organization profile API", { concurrent: false }, () => {
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
    await seedOrganizations(admin);
    const appSql = postgres(applicationUrl, { max: 8 });
    application = appSql;
    api = await buildApi({
      identityVerifier: identityVerifier(),
      memberships: new PostgresMembershipDirectory(appSql),
      repository: new PostgresReconciliationRepository(appSql),
      csvImports: unavailableCsvImports(),
      providerWebhooks: unavailableProviderWebhooks(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
  });

  afterAll(async () => {
    await api?.close();
    await application?.end({ timeout: 5 });
    await administrator?.end({ timeout: 5 });
  });

  it("serializes profile versions, refreshes directory names, and denies cross-role or cross-tenant writes", async () => {
    const app = requiredApi(api);
    const admin = requiredConnection(administrator, "administrator");
    const appSql = requiredConnection(application, "application");
    const directory = new PostgresMembershipDirectory(appSql);
    const endpoint = `/v1/organizations/${organizationId}`;

    const initial = await app.inject({
      method: "GET",
      url: endpoint,
      headers: { authorization: authorizationHeaders.administratorOne },
    });
    expect(initial.statusCode).toBe(200);
    expect(responseProfile(initial.json())).toMatchObject({
      name: "Initial Operations",
      businessTimeZone: "America/New_York",
      profileVersion: 1,
    });

    const [northResponse, centralResponse] = await Promise.all([
      app.inject({
        method: "PATCH",
        url: endpoint,
        headers: {
          authorization: authorizationHeaders.administratorOne,
          "content-type": "application/json",
        },
        payload: {
          name: "North Operations",
          expectedProfileVersion: 1,
          reason: "Adopt the approved northern operating name",
        },
      }),
      app.inject({
        method: "PATCH",
        url: endpoint,
        headers: {
          authorization: authorizationHeaders.administratorTwo,
          "content-type": "application/json",
        },
        payload: {
          name: "Central Operations",
          expectedProfileVersion: 1,
          reason: "Adopt the approved central operating name",
        },
      }),
    ]);
    expect([northResponse.statusCode, centralResponse.statusCode].sort()).toEqual([200, 409]);

    const winningResponse = northResponse.statusCode === 200 ? northResponse : centralResponse;
    const losingResponse = northResponse.statusCode === 409 ? northResponse : centralResponse;
    const winningName =
      northResponse.statusCode === 200 ? "North Operations" : "Central Operations";
    const winningProfile = responseProfile(winningResponse.json());
    expect(winningProfile).toMatchObject({ name: winningName, profileVersion: 2 });
    expect(losingResponse.json()).toMatchObject({ code: "CONFLICT" });

    await expect(
      directory.list(identities.administratorOne, { limit: 1, organizationId }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: organizationId,
          name: winningName,
          role: "administrator",
        }),
      ],
    });

    const staleRetry = await app.inject({
      method: "PATCH",
      url: endpoint,
      headers: {
        authorization: authorizationHeaders.administratorOne,
        "content-type": "application/json",
      },
      payload: {
        name: "Stale Operations",
        expectedProfileVersion: 1,
        reason: "A stale mutation must not replace current authority",
      },
    });
    expect(staleRetry.statusCode).toBe(409);
    expect(await profileAuditEvents(admin)).toHaveLength(1);

    const refreshed = await app.inject({
      method: "GET",
      url: endpoint,
      headers: { authorization: authorizationHeaders.administratorOne },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(responseProfile(refreshed.json())).toMatchObject({
      name: winningName,
      profileVersion: 2,
    });

    const finalUpdate = await app.inject({
      method: "PATCH",
      url: endpoint,
      headers: {
        authorization: authorizationHeaders.administratorOne,
        "content-type": "application/json",
      },
      payload: {
        name: "Final Operations",
        expectedProfileVersion: 2,
        reason: "Apply the final approved operating name after refresh",
      },
    });
    expect(finalUpdate.statusCode).toBe(200);
    expect(responseProfile(finalUpdate.json())).toMatchObject({
      name: "Final Operations",
      businessTimeZone: "America/New_York",
      profileVersion: 3,
    });
    await expect(
      directory.list(identities.administratorOne, { limit: 1, organizationId }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: organizationId,
          name: "Final Operations",
          role: "administrator",
        }),
      ],
    });

    const noOp = await app.inject({
      method: "PATCH",
      url: endpoint,
      headers: {
        authorization: authorizationHeaders.administratorOne,
        "content-type": "application/json",
      },
      payload: {
        name: "  Final Operations  ",
        expectedProfileVersion: 3,
        reason: "Confirm the canonical name without changing state",
      },
    });
    expect(noOp.statusCode).toBe(200);
    expect(responseProfile(noOp.json())).toMatchObject({
      name: "Final Operations",
      profileVersion: 3,
    });
    expect(await profileAuditEvents(admin)).toHaveLength(2);

    const analystRead = await app.inject({
      method: "GET",
      url: endpoint,
      headers: { authorization: authorizationHeaders.analyst },
    });
    expect(analystRead.statusCode).toBe(404);
    const analystWrite = await app.inject({
      method: "PATCH",
      url: endpoint,
      headers: {
        authorization: authorizationHeaders.analyst,
        "content-type": "application/json",
      },
      payload: {
        name: "Analyst Operations",
        expectedProfileVersion: 3,
        reason: "An analyst must not mutate organization authority",
      },
    });
    expect(analystWrite.statusCode).toBe(404);

    const foreignWrite = await app.inject({
      method: "PATCH",
      url: endpoint,
      headers: {
        authorization: authorizationHeaders.foreignOwner,
        "content-type": "application/json",
      },
      payload: {
        name: "Foreign Operations",
        expectedProfileVersion: 3,
        reason: "A foreign owner must not mutate another tenant",
      },
    });
    expect(foreignWrite.statusCode).toBe(404);

    const invalidName = await app.inject({
      method: "PATCH",
      url: endpoint,
      headers: {
        authorization: authorizationHeaders.administratorOne,
        "content-type": "application/json",
      },
      payload: {
        name: "Invalid\nOperations",
        expectedProfileVersion: 3,
        reason: "Reject a control character before repository mutation",
      },
    });
    expect(invalidName.statusCode).toBe(400);
    const expandedMutation = await app.inject({
      method: "PATCH",
      url: endpoint,
      headers: {
        authorization: authorizationHeaders.administratorOne,
        "content-type": "application/json",
      },
      payload: {
        name: "Expanded Operations",
        expectedProfileVersion: 3,
        reason: "Reject fields outside the bounded profile contract",
        aiEnabled: true,
      },
    });
    expect(expandedMutation.statusCode).toBe(400);

    const terminal = requiredRow(
      await admin`
        select name, business_time_zone, profile_version
        from organizations
        where id = ${organizationId}
      `,
      "terminal organization profile",
    );
    expect(terminal).toMatchObject({
      name: "Final Operations",
      business_time_zone: "America/New_York",
      profile_version: 3,
    });

    const auditEvents = await profileAuditEvents(admin);
    expect(auditEvents).toHaveLength(2);
    const orderedEvents = orderedAuditChain(auditEvents);
    expect(orderedEvents[0]).toMatchObject({
      previous_event_hash: null,
      hash_version: 2,
      previous_value: { name: "Initial Operations", profileVersion: 1 },
      new_value: { name: winningName, profileVersion: 2 },
      version_context: { organizationProfileSchemaVersion: 1 },
    });
    expect(orderedEvents[1]).toMatchObject({
      previous_event_hash: orderedEvents[0]?.event_hash,
      hash_version: 2,
      previous_value: { name: winningName, profileVersion: 2 },
      new_value: { name: "Final Operations", profileVersion: 3 },
      version_context: { organizationProfileSchemaVersion: 1 },
    });
    expect(new Set(auditEvents.map((event) => event.event_hash)).size).toBe(2);
    for (const event of auditEvents) {
      expect(event.event_hash).toMatch(/^[0-9a-f]{64}$/u);
    }

    const tenantlessOrganizations = requiredRow(
      await appSql`select count(*)::integer as count from organizations`,
      "tenantless organization count",
    );
    const tenantlessAudits = requiredRow(
      await appSql`select count(*)::integer as count from audit_events`,
      "tenantless audit count",
    );
    expect(databaseInteger(tenantlessOrganizations, "count")).toBe(0);
    expect(databaseInteger(tenantlessAudits, "count")).toBe(0);
  });
});

function verifiedIdentity(subject: string): VerifiedIdentity {
  return {
    issuer,
    subject,
    email: `${subject}@example.test`,
    emailVerified: true,
  };
}

function identityVerifier(): IdentityVerifier {
  const identitiesByAuthorization = new Map<string, VerifiedIdentity>([
    [authorizationHeaders.administratorOne, identities.administratorOne],
    [authorizationHeaders.administratorTwo, identities.administratorTwo],
    [authorizationHeaders.analyst, identities.analyst],
    [authorizationHeaders.foreignOwner, identities.foreignOwner],
  ]);
  return {
    verifyAuthorizationHeader: async (header) => {
      const identity = header ? identitiesByAuthorization.get(header) : undefined;
      if (!identity) throw new AuthenticationError();
      return identity;
    },
  };
}

function unavailableCsvImports(): ApiDependencies["csvImports"] {
  return {
    createPreview: async () => unavailable("CSV imports"),
    getImport: async () => unavailable("CSV imports"),
    listImports: async () => unavailable("CSV imports"),
    commitImport: async () => unavailable("CSV imports"),
    rollbackImport: async () => unavailable("CSV imports"),
  };
}

function unavailableProviderWebhooks(): ApiDependencies["providerWebhooks"] {
  return {
    receiveShopify: async () => unavailable("provider webhooks"),
    receiveStripe: async () => unavailable("provider webhooks"),
  };
}

function unavailable(component: string): never {
  throw new Error(`${component} are outside this focused integration test`);
}

function responseProfile(body: unknown): Readonly<Record<string, unknown>> {
  const response = databaseObject(body as Readonly<Record<string, unknown>>, "data");
  return response;
}

async function profileAuditEvents(sql: Sql): Promise<
  readonly {
    readonly actor_id: string;
    readonly previous_event_hash: string | null;
    readonly event_hash: string;
    readonly hash_version: number;
    readonly previous_value: Readonly<Record<string, unknown>>;
    readonly new_value: Readonly<Record<string, unknown>>;
    readonly version_context: Readonly<Record<string, unknown>>;
  }[]
> {
  const rows = await sql`
    select
      actor_id,
      previous_event_hash,
      event_hash,
      hash_version,
      previous_value,
      new_value,
      version_context
    from audit_events
    where organization_id = ${organizationId}
      and action = 'organization.profile.updated'
      and resource_id = ${organizationId}
  `;
  return rows.map((row) => {
    const record = row as Readonly<Record<string, unknown>>;
    const previousEventHash = record["previous_event_hash"];
    if (previousEventHash !== null && typeof previousEventHash !== "string") {
      throw new Error("database field previous_event_hash was not a nullable string");
    }
    return {
      actor_id: databaseString(record, "actor_id"),
      previous_event_hash: previousEventHash,
      event_hash: databaseString(record, "event_hash"),
      hash_version: databaseInteger(record, "hash_version"),
      previous_value: databaseObject(record, "previous_value"),
      new_value: databaseObject(record, "new_value"),
      version_context: databaseObject(record, "version_context"),
    };
  });
}

function orderedAuditChain<
  T extends { readonly previous_event_hash: string | null; readonly event_hash: string },
>(events: readonly T[]): readonly T[] {
  const byPreviousHash = new Map(events.map((event) => [event.previous_event_hash, event]));
  const ordered: T[] = [];
  let current = byPreviousHash.get(null);
  while (current) {
    ordered.push(current);
    current = byPreviousHash.get(current.event_hash);
  }
  if (ordered.length !== events.length) {
    throw new Error("organization profile audit events do not form one complete linear chain");
  }
  return ordered;
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

function requiredApi(value: ApiApplication | undefined): ApiApplication {
  if (!value) throw new Error("API application was not initialized");
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

function databaseInteger(row: Readonly<Record<string, unknown>>, field: string): number {
  const value = row[field];
  if (!Number.isInteger(value)) throw new Error(`database field ${field} was not an integer`);
  return value as number;
}

function databaseObject(
  row: Readonly<Record<string, unknown>>,
  field: string,
): Readonly<Record<string, unknown>> {
  const value = row[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`database field ${field} was not an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

async function ensureLocalTestRoles(sql: Sql): Promise<void> {
  const existing = await sql`
    select rolname
    from pg_roles
    where rolname in (
      'reconai_migrator',
      'reconai_app',
      'reconai_worker',
      'reconai_maintenance'
    )
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
  if (!roleNames.has("reconai_maintenance")) {
    await sql.unsafe(
      "create role reconai_maintenance login password 'local-maintenance-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
    );
  }
  await sql.unsafe(
    "grant connect on database reconai to reconai_migrator, reconai_app, reconai_worker, reconai_maintenance",
  );
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
    grant select, insert, update, delete on tables to reconai_worker
  `);
  await sql.unsafe(`
    alter default privileges for role reconai_migrator in schema public
    grant usage, select on sequences to reconai_app
  `);
}

async function seedOrganizations(sql: Sql): Promise<void> {
  await sql`
    insert into organizations (id, name, business_time_zone) values
      (${organizationId}, 'Initial Operations', 'America/New_York'),
      (${foreignOrganizationId}, 'Foreign Operations', 'UTC')
  `;
  await sql`
    insert into users (id, issuer, subject, email) values
      (${administratorOneId}, ${issuer}, ${identities.administratorOne.subject},
        ${identities.administratorOne.email ?? null}),
      (${administratorTwoId}, ${issuer}, ${identities.administratorTwo.subject},
        ${identities.administratorTwo.email ?? null}),
      (${analystId}, ${issuer}, ${identities.analyst.subject}, ${identities.analyst.email ?? null}),
      (${foreignOwnerId}, ${issuer}, ${identities.foreignOwner.subject},
        ${identities.foreignOwner.email ?? null})
  `;
  await sql`
    insert into memberships (id, organization_id, user_id, role, status) values
      (${administratorOneMembershipId}, ${organizationId}, ${administratorOneId},
        'administrator', 'active'),
      (${administratorTwoMembershipId}, ${organizationId}, ${administratorTwoId},
        'administrator', 'active'),
      (${analystMembershipId}, ${organizationId}, ${analystId}, 'analyst', 'active'),
      (${foreignOwnerMembershipId}, ${foreignOrganizationId}, ${foreignOwnerId}, 'owner', 'active')
  `;
}
