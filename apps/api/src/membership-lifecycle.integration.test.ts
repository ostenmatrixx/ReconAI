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

const issuer = "https://membership-lifecycle.example.test";
const organizationId = OrganizationIdSchema.parse(randomUUID());
const foreignOrganizationId = OrganizationIdSchema.parse(randomUUID());
const administratorOneId = UserIdSchema.parse(randomUUID());
const administratorTwoId = UserIdSchema.parse(randomUUID());
const targetUserId = UserIdSchema.parse(randomUUID());
const foreignOwnerId = UserIdSchema.parse(randomUUID());
const administratorOneMembershipId = MembershipIdSchema.parse(randomUUID());
const administratorTwoMembershipId = MembershipIdSchema.parse(randomUUID());
const targetMembershipId = MembershipIdSchema.parse(randomUUID());
const foreignOwnerMembershipId = MembershipIdSchema.parse(randomUUID());

const identities = {
  administratorOne: verifiedIdentity("administrator-one"),
  administratorTwo: verifiedIdentity("administrator-two"),
  target: verifiedIdentity("target-member"),
  foreignOwner: verifiedIdentity("foreign-owner"),
} as const;

const authorizationHeaders = {
  administratorOne: "Bearer concurrent-administrator-one",
  administratorTwo: "Bearer concurrent-administrator-two",
  foreignOwner: "Bearer foreign-organization-owner",
} as const;

let administrator: Sql | undefined;
let application: Sql | undefined;
let api: ApiApplication | undefined;

describe("live membership lifecycle API", { concurrent: false }, () => {
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
    await seedMemberships(admin);
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

  it("serializes two administrators, preserves an audit chain, and re-resolves directory authority", async () => {
    const app = requiredApi(api);
    const admin = requiredConnection(administrator, "administrator");
    const directory = new PostgresMembershipDirectory(
      requiredConnection(application, "application"),
    );

    const [deactivateResponse, retainResponse] = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/v1/organizations/${organizationId}/members/${targetMembershipId}`,
        headers: {
          authorization: authorizationHeaders.administratorOne,
          "content-type": "application/json",
        },
        payload: {
          role: "reviewer",
          status: "deactivated",
          reason: "Concurrent control removes target access pending review",
        },
      }),
      app.inject({
        method: "PATCH",
        url: `/v1/organizations/${organizationId}/members/${targetMembershipId}`,
        headers: {
          authorization: authorizationHeaders.administratorTwo,
          "content-type": "application/json",
        },
        payload: {
          role: "auditor",
          status: "active",
          reason: "Concurrent control assigns bounded auditor access",
        },
      }),
    ]);

    expect(deactivateResponse.statusCode).toBe(200);
    expect(retainResponse.statusCode).toBe(200);

    const concurrentEvents = await membershipAuditEvents(admin);
    expect(concurrentEvents).toHaveLength(2);
    const genesis = concurrentEvents.find((event) => event.previous_event_hash === null);
    if (!genesis) throw new Error("concurrent membership audit genesis was not found");
    const successor = concurrentEvents.find(
      (event) => event.previous_event_hash === genesis.event_hash,
    );
    if (!successor) throw new Error("concurrent membership audit successor was not found");
    expect(new Set(concurrentEvents.map((event) => event.actor_id))).toEqual(
      new Set([administratorOneId, administratorTwoId]),
    );
    expect(genesis.hash_version).toBe(2);
    expect(successor.hash_version).toBe(2);
    expect(genesis.event_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(successor.event_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(successor.previous_value).toEqual(genesis.new_value);

    const terminalMembership = requiredRow(
      await admin`
        select role, status
        from memberships
        where organization_id = ${organizationId}
          and id = ${targetMembershipId}
      `,
      "terminal target membership",
    );
    expect({
      role: databaseString(terminalMembership, "role"),
      status: databaseString(terminalMembership, "status"),
    }).toEqual({
      role: databaseString(successor.new_value, "role"),
      status: databaseString(successor.new_value, "status"),
    });

    const exactAfterConcurrentWrites = await directory.list(identities.target, {
      limit: 1,
      organizationId,
    });
    if (databaseString(terminalMembership, "status") === "active") {
      expect(exactAfterConcurrentWrites.items).toEqual([
        expect.objectContaining({
          id: organizationId,
          membershipId: targetMembershipId,
          role: databaseString(terminalMembership, "role"),
        }),
      ]);
    } else {
      expect(exactAfterConcurrentWrites).toEqual({ items: [] });
    }

    const restoreResponse = await app.inject({
      method: "PATCH",
      url: `/v1/organizations/${organizationId}/members/${targetMembershipId}`,
      headers: {
        authorization: authorizationHeaders.administratorOne,
        "content-type": "application/json",
      },
      payload: {
        role: "reviewer",
        status: "active",
        reason: "Restore reviewed access to the bounded reviewer role",
      },
    });
    expect(restoreResponse.statusCode).toBe(200);
    await expect(directory.list(identities.target, { limit: 1, organizationId })).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: organizationId,
          membershipId: targetMembershipId,
          role: "reviewer",
        }),
      ],
    });

    const auditCountBeforeForeignRequest = (await membershipAuditEvents(admin)).length;
    const foreignResponse = await app.inject({
      method: "PATCH",
      url: `/v1/organizations/${organizationId}/members/${targetMembershipId}`,
      headers: {
        authorization: authorizationHeaders.foreignOwner,
        "content-type": "application/json",
      },
      payload: {
        role: "analyst",
        status: "active",
        reason: "A foreign tenant must not mutate this membership",
      },
    });
    expect(foreignResponse.statusCode).toBe(404);

    const terminalEvents = await membershipAuditEvents(admin);
    expect(terminalEvents).toHaveLength(auditCountBeforeForeignRequest);
    expect(terminalEvents).toHaveLength(3);
    expect(new Set(terminalEvents.map((event) => event.event_hash)).size).toBe(3);
    const orderedTerminalEvents = orderedAuditChain(terminalEvents);
    expect(orderedTerminalEvents).toHaveLength(3);
    expect(orderedTerminalEvents[2]?.previous_value).toEqual(orderedTerminalEvents[1]?.new_value);
    expect(orderedTerminalEvents[2]?.new_value).toMatchObject({
      role: "reviewer",
      status: "active",
    });
    expect(orderedTerminalEvents[2]?.actor_id).toBe(administratorOneId);

    const finalMembership = requiredRow(
      await admin`
        select role, status
        from memberships
        where organization_id = ${organizationId}
          and id = ${targetMembershipId}
      `,
      "restored target membership",
    );
    expect(finalMembership).toMatchObject({ role: "reviewer", status: "active" });
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
  const byAuthorizationHeader = new Map<string, VerifiedIdentity>([
    [authorizationHeaders.administratorOne, identities.administratorOne],
    [authorizationHeaders.administratorTwo, identities.administratorTwo],
    [authorizationHeaders.foreignOwner, identities.foreignOwner],
  ]);
  return {
    verifyAuthorizationHeader: async (header) => {
      const identity = header ? byAuthorizationHeader.get(header) : undefined;
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

async function membershipAuditEvents(sql: Sql): Promise<
  readonly {
    readonly actor_id: string;
    readonly previous_event_hash: string | null;
    readonly event_hash: string;
    readonly hash_version: number;
    readonly previous_value: Readonly<Record<string, unknown>>;
    readonly new_value: Readonly<Record<string, unknown>>;
  }[]
> {
  const rows = await sql`
    select
      actor_id,
      previous_event_hash,
      event_hash,
      hash_version,
      previous_value,
      new_value
    from audit_events
    where organization_id = ${organizationId}
      and action = 'organization.membership.updated'
      and resource_id = ${targetMembershipId}
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
    };
  });
}

function orderedAuditChain<T extends { previous_event_hash: string | null; event_hash: string }>(
  events: readonly T[],
): readonly T[] {
  const byPreviousHash = new Map(events.map((event) => [event.previous_event_hash, event]));
  const ordered: T[] = [];
  let current = byPreviousHash.get(null);
  while (current) {
    ordered.push(current);
    current = byPreviousHash.get(current.event_hash);
  }
  if (ordered.length !== events.length) {
    throw new Error("membership audit events do not form one complete linear chain");
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

async function seedMemberships(sql: Sql): Promise<void> {
  await sql`
    insert into organizations (id, name) values
      (${organizationId}, 'Concurrent Membership Tenant'),
      (${foreignOrganizationId}, 'Foreign Membership Tenant')
  `;
  await sql`
    insert into users (id, issuer, subject, email) values
      (${administratorOneId}, ${issuer}, ${identities.administratorOne.subject},
        ${identities.administratorOne.email ?? null}),
      (${administratorTwoId}, ${issuer}, ${identities.administratorTwo.subject},
        ${identities.administratorTwo.email ?? null}),
      (${targetUserId}, ${issuer}, ${identities.target.subject}, ${identities.target.email ?? null}),
      (${foreignOwnerId}, ${issuer}, ${identities.foreignOwner.subject},
        ${identities.foreignOwner.email ?? null})
  `;
  await sql`
    insert into memberships (id, organization_id, user_id, role, status) values
      (${administratorOneMembershipId}, ${organizationId}, ${administratorOneId},
        'administrator', 'active'),
      (${administratorTwoMembershipId}, ${organizationId}, ${administratorTwoId},
        'administrator', 'active'),
      (${targetMembershipId}, ${organizationId}, ${targetUserId}, 'analyst', 'active'),
      (${foreignOwnerMembershipId}, ${foreignOrganizationId}, ${foreignOwnerId}, 'owner', 'active')
  `;
}
