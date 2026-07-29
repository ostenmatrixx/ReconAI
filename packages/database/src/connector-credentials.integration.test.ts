import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  EnvironmentConnectorSecretResolver,
  createConnectorCredentialKeyring,
  sealConnectorCredential,
} from "@workspace/connectors";
import {
  MembershipIdSchema,
  OrganizationIdSchema,
  UserIdSchema,
  tenantContextFromMembership,
} from "@workspace/domain";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ConnectorCredentialConflictError,
  PostgresConnectorCredentialService,
} from "./connector-credentials.js";

const organizationId = OrganizationIdSchema.parse(randomUUID());
const otherOrganizationId = OrganizationIdSchema.parse(randomUUID());
const userId = UserIdSchema.parse(randomUUID());
const otherUserId = UserIdSchema.parse(randomUUID());
const membershipId = MembershipIdSchema.parse(randomUUID());
const otherMembershipId = MembershipIdSchema.parse(randomUUID());
const connectionId = randomUUID();
const otherConnectionId = randomUUID();
const keyV1 = Buffer.alloc(32, 11).toString("base64url");
const keyV2 = Buffer.alloc(32, 29).toString("base64url");
const environment = {
  RECONAI_CONNECTOR_ENCRYPTION_KEY_V1_TEST: keyV1,
  RECONAI_CONNECTOR_ENCRYPTION_KEY_V2_TEST: keyV2,
  RECONAI_CONNECTOR_LEGACY_TEST: "synthetic-legacy-provider-credential",
};
const references =
  "v1=env:RECONAI_CONNECTOR_ENCRYPTION_KEY_V1_TEST,v2=env:RECONAI_CONNECTOR_ENCRYPTION_KEY_V2_TEST";
let administrator: Sql | undefined;
let application: Sql | undefined;
let worker: Sql | undefined;

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

describe("live encrypted connector credential lifecycle", { concurrent: false }, () => {
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
    application = postgres(requiredEnvironment("DATABASE_URL"), { max: 1 });
    worker = postgres(requiredEnvironment("DATABASE_WORKER_URL"), { max: 1 });
  });

  afterAll(async () => {
    await worker?.end({ timeout: 5 });
    await application?.end({ timeout: 5 });
    await administrator?.end({ timeout: 5 });
  });

  it("rotates tenant-bound ciphertext, resolves it server-side, and rejects retired replay", async () => {
    const appDatabase = requiredConnection(application, "application");
    const workerDatabase = requiredConnection(worker, "worker");
    const v1Keyring = createConnectorCredentialKeyring({
      references,
      activeVersion: "v1",
      environment,
      production: true,
    });
    const v2Keyring = createConnectorCredentialKeyring({
      references,
      activeVersion: "v2",
      environment,
      production: true,
    });
    const environmentResolver = new EnvironmentConnectorSecretResolver(environment);
    const managerV1 = new PostgresConnectorCredentialService(
      appDatabase,
      v1Keyring,
      environmentResolver,
    );
    const managerV2 = new PostgresConnectorCredentialService(
      appDatabase,
      v2Keyring,
      environmentResolver,
    );
    const workerResolver = new PostgresConnectorCredentialService(
      workerDatabase,
      v2Keyring,
      environmentResolver,
    );
    const firstEnvelope = sealConnectorCredential(
      {
        organizationId,
        connectionId,
        provider: "stripe",
        purpose: "api_read",
        secret: "synthetic-stripe-read-credential-v1",
      },
      v1Keyring,
    );
    const first = await managerV1.rotate(tenant, {
      connectionId,
      confirmConnectionId: connectionId,
      purpose: "api_read",
      envelope: firstEnvelope,
      reason: "Install the initial encrypted read credential",
      correlationId: randomUUID(),
    });
    expect(first).toMatchObject({ replayed: false, credential: { status: "active" } });
    await expect(
      managerV1.rotate(tenant, {
        connectionId,
        confirmConnectionId: connectionId,
        purpose: "api_read",
        envelope: firstEnvelope,
        reason: "Replay the identical active installation request",
        correlationId: randomUUID(),
      }),
    ).resolves.toMatchObject({ replayed: true, credential: { id: first.credential.id } });
    await expect(
      workerResolver.resolve({
        reference: `sealed:${first.credential.id}`,
        organizationId,
        connectionId,
        provider: "stripe",
        purpose: "api_read",
      }),
    ).resolves.toBe("synthetic-stripe-read-credential-v1");

    const secondEnvelope = sealConnectorCredential(
      {
        organizationId,
        connectionId,
        provider: "stripe",
        purpose: "api_read",
        secret: "synthetic-stripe-read-credential-v2",
      },
      v2Keyring,
    );
    const second = await managerV2.rotate(tenant, {
      connectionId,
      confirmConnectionId: connectionId,
      purpose: "api_read",
      envelope: secondEnvelope,
      reason: "Rotate the provider credential and active encryption key",
      correlationId: randomUUID(),
    });
    expect(second).toMatchObject({
      replayed: false,
      credential: {
        status: "active",
        keyVersion: "v2",
        rotatedFromCredentialId: first.credential.id,
      },
    });
    await expect(
      workerResolver.resolve({
        reference: `sealed:${second.credential.id}`,
        organizationId,
        connectionId,
        provider: "stripe",
        purpose: "api_read",
      }),
    ).resolves.toBe("synthetic-stripe-read-credential-v2");
    await expect(
      managerV2.rotate(tenant, {
        connectionId,
        confirmConnectionId: connectionId,
        purpose: "api_read",
        envelope: firstEnvelope,
        reason: "Attempt to replay a superseded ciphertext envelope",
        correlationId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConnectorCredentialConflictError);

    const metadata = await managerV2.list(tenant, connectionId);
    expect(metadata).toHaveLength(2);
    expect(metadata.map(({ status }) => status).sort()).toEqual(["active", "superseded"]);
    await expect(
      appDatabase.begin(async (transaction) => {
        await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
        await transaction`
          update connector_credentials
          set status = 'superseded',
              superseded_at = now(),
              updated_at = now()
          where organization_id = ${organizationId}
            and id = ${second.credential.id}::uuid
        `;
      }),
    ).rejects.toThrow(/remains referenced/u);
    await expect(
      appDatabase.begin(async (transaction) => {
        await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
        await transaction`
          update data_source_connections
          set api_credential_reference = ${`sealed:${randomUUID()}`}
          where organization_id = ${organizationId}
            and id = ${connectionId}::uuid
        `;
      }),
    ).rejects.toThrow(/not active for this connection/u);
    await expect(managerV2.list(otherTenant, connectionId)).rejects.toThrow(/not found/u);
    await expect(
      workerResolver.resolve({
        reference: `sealed:${second.credential.id}`,
        organizationId: otherOrganizationId,
        connectionId: otherConnectionId,
        provider: "stripe",
        purpose: "api_read",
      }),
    ).rejects.toThrow(/unavailable/u);
  });

  it("revokes active credentials and removes all ReconAI provider authority on disconnect", async () => {
    const appDatabase = requiredConnection(application, "application");
    const workerDatabase = requiredConnection(worker, "worker");
    const keyring = createConnectorCredentialKeyring({
      references,
      activeVersion: "v2",
      environment,
      production: true,
    });
    const environmentResolver = new EnvironmentConnectorSecretResolver(environment);
    const manager = new PostgresConnectorCredentialService(
      appDatabase,
      keyring,
      environmentResolver,
    );
    const resolver = new PostgresConnectorCredentialService(
      workerDatabase,
      keyring,
      environmentResolver,
    );
    const webhookEnvelope = sealConnectorCredential(
      {
        organizationId,
        connectionId,
        provider: "stripe",
        purpose: "webhook_signing",
        secret: "synthetic-stripe-webhook-signing-secret",
      },
      keyring,
    );
    const installed = await manager.rotate(tenant, {
      connectionId,
      confirmConnectionId: connectionId,
      purpose: "webhook_signing",
      envelope: webhookEnvelope,
      reason: "Install encrypted webhook verification authority",
      correlationId: randomUUID(),
    });
    await expect(
      resolver.resolve({
        reference: `sealed:${installed.credential.id}`,
        organizationId,
        connectionId,
        provider: "stripe",
        purpose: "webhook_signing",
      }),
    ).resolves.toBe("synthetic-stripe-webhook-signing-secret");

    await expect(
      manager.disconnect(tenant, {
        connectionId,
        confirmConnectionId: otherConnectionId,
        reason: "Mismatched confirmation must be rejected",
        correlationId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConnectorCredentialConflictError);
    const disconnected = await manager.disconnect(tenant, {
      connectionId,
      confirmConnectionId: connectionId,
      reason: "Revoke all ReconAI access for this provider connection",
      correlationId: randomUUID(),
    });
    expect(disconnected).toEqual({ connectionId, status: "disconnected", revoked: 2 });
    await expect(
      resolver.resolve({
        reference: `sealed:${installed.credential.id}`,
        organizationId,
        connectionId,
        provider: "stripe",
        purpose: "webhook_signing",
      }),
    ).rejects.toThrow(/unavailable/u);

    const admin = requiredConnection(administrator, "administrator");
    const connection = await admin`
      select
        status, credential_reference, api_credential_reference, encrypted_credential,
        credential_key_version, cursor
      from data_source_connections
      where organization_id = ${organizationId}
        and id = ${connectionId}::uuid
    `;
    expect(connection[0]).toMatchObject({
      status: "disconnected",
      credential_reference: null,
      api_credential_reference: null,
      encrypted_credential: null,
      credential_key_version: null,
      cursor: null,
    });
    await expect(
      admin`
        delete from connector_credentials
        where organization_id = ${organizationId}
          and id = ${installed.credential.id}::uuid
      `,
    ).rejects.toThrow(/append-only/u);
  });
});

async function seedTenants(sql: Sql): Promise<void> {
  await sql`
    insert into organizations (id, name) values
      (${organizationId}, 'Connector Credential Integration Tenant'),
      (${otherOrganizationId}, 'Other Connector Credential Integration Tenant')
  `;
  await sql`
    insert into users (id, issuer, subject, email) values
      (${userId}, 'https://issuer.example.test', ${`credential-${userId}`}, 'credential@example.test'),
      (${otherUserId}, 'https://issuer.example.test', ${`credential-${otherUserId}`}, 'other-credential@example.test')
  `;
  await sql`
    insert into memberships (id, organization_id, user_id, role, status) values
      (${membershipId}, ${organizationId}, ${userId}, 'administrator', 'active'),
      (${otherMembershipId}, ${otherOrganizationId}, ${otherUserId}, 'administrator', 'active')
  `;
  await sql`
    insert into data_source_connections (
      id, organization_id, provider, external_account_id, status, connector_version,
      api_version, credential_reference, api_credential_reference, created_at, updated_at
    ) values
      (
        ${connectionId}, ${organizationId}, 'stripe',
        ${`acct_${connectionId.replaceAll("-", "")}`}, 'healthy', '1.0.0',
        '2025-06-30.basil', 'env:RECONAI_CONNECTOR_LEGACY_TEST',
        'env:RECONAI_CONNECTOR_LEGACY_TEST', now(), now()
      ),
      (
        ${otherConnectionId}, ${otherOrganizationId}, 'stripe',
        ${`acct_${otherConnectionId.replaceAll("-", "")}`}, 'healthy', '1.0.0',
        '2025-06-30.basil', 'env:RECONAI_CONNECTOR_LEGACY_TEST',
        'env:RECONAI_CONNECTOR_LEGACY_TEST', now(), now()
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
