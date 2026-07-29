import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  EnvironmentConnectorSecretResolver,
  createConnectorCredentialKeyring,
  createProviderAuthorizationState,
} from "@workspace/connectors";
import {
  MembershipIdSchema,
  OrganizationIdSchema,
  UserIdSchema,
  tenantContextFromMembership,
} from "@workspace/domain";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PostgresConnectorCredentialService } from "./connector-credentials.js";
import {
  PostgresProviderAuthorizationService,
  ProviderAuthorizationConflictError,
  ProviderAuthorizationExpiredError,
  ProviderAuthorizationNotFoundError,
} from "./provider-authorization.js";
import { PostgresStripeAppDeauthorizationRepository } from "./provider-deauthorization.js";

const organizationId = OrganizationIdSchema.parse(randomUUID());
const otherOrganizationId = OrganizationIdSchema.parse(randomUUID());
const userId = UserIdSchema.parse(randomUUID());
const otherUserId = UserIdSchema.parse(randomUUID());
const membershipId = MembershipIdSchema.parse(randomUUID());
const otherMembershipId = MembershipIdSchema.parse(randomUUID());
const expiredConnectionId = randomUUID();
const key = Buffer.alloc(32, 41).toString("base64url");
const keyReferences = "v1=env:RECONAI_CONNECTOR_ENCRYPTION_KEY_PROVIDER_AUTHORIZATION_TEST";
const keyEnvironment = { RECONAI_CONNECTOR_ENCRYPTION_KEY_PROVIDER_AUTHORIZATION_TEST: key };
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

describe("live provider authorization lifecycle", { concurrent: false }, () => {
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
    application = postgres(requiredEnvironment("DATABASE_URL"), { max: 5 });
    worker = postgres(requiredEnvironment("DATABASE_WORKER_URL"), { max: 1 });
  });

  afterAll(async () => {
    await worker?.end({ timeout: 5 });
    await application?.end({ timeout: 5 });
    await administrator?.end({ timeout: 5 });
  });

  it("consumes state once, installs only encrypted rotating tokens, and safely replays success", async () => {
    const appDatabase = requiredConnection(application, "application");
    const workerDatabase = requiredConnection(worker, "worker");
    const adminDatabase = requiredConnection(administrator, "administrator");
    const keyring = createConnectorCredentialKeyring({
      references: keyReferences,
      activeVersion: "v1",
      environment: keyEnvironment,
      production: true,
    });
    const manager = new PostgresProviderAuthorizationService(appDatabase, keyring);
    const resolver = new PostgresConnectorCredentialService(
      workerDatabase,
      keyring,
      new EnvironmentConnectorSecretResolver({}),
    );
    const started = await manager.begin(tenant, {
      provider: "stripe",
      connectorVersion: "1.1.0",
      apiVersion: "2025-06-30.basil",
      correlationId: randomUUID(),
    });
    const durableStart = await adminDatabase`
      select state_sha256, status, requested_by_membership_id
      from provider_authorization_attempts
      where organization_id = ${organizationId}
        and id = ${started.attemptId}::uuid
    `;
    expect(durableStart[0]).toMatchObject({
      status: "pending",
      requested_by_membership_id: membershipId,
    });
    expect(databaseString(durableStart[0], "state_sha256")).toMatch(/^[a-f0-9]{64}$/u);
    expect(databaseString(durableStart[0], "state_sha256")).not.toContain(started.state);

    const unrelatedState = createProviderAuthorizationState();
    await expect(
      manager.claim(tenant, {
        attemptId: started.attemptId,
        provider: "stripe",
        state: unrelatedState.value,
      }),
    ).rejects.toBeInstanceOf(ProviderAuthorizationNotFoundError);
    await expect(
      manager.claim(otherTenant, {
        attemptId: started.attemptId,
        provider: "stripe",
        state: started.state,
      }),
    ).rejects.toBeInstanceOf(ProviderAuthorizationNotFoundError);

    const claimed = await manager.claim(tenant, {
      attemptId: started.attemptId,
      provider: "stripe",
      state: started.state,
    });
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") throw new Error("authorization was not claimed");

    const issuedAt = new Date();
    const accessToken = "synthetic-access-token-value-0001";
    const refreshToken = "synthetic-refresh-token-value-0001";
    const completed = await manager.complete(tenant, {
      claim: claimed.claim,
      tokenBundle: {
        schemaVersion: 1,
        credentialType: "oauth_refreshable",
        provider: "stripe",
        externalAccountId: `acct_${randomUUID().replaceAll("-", "")}`,
        livemode: false,
        authorizationGrantedAt: issuedAt.toISOString(),
        accessToken,
        refreshToken,
        accessTokenExpiresAt: new Date(issuedAt.getTime() + 60 * 60 * 1000).toISOString(),
        refreshTokenExpiresAt: new Date(
          issuedAt.getTime() + 365 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        scopes: ["stripe_apps"],
        issuedAt: issuedAt.toISOString(),
      },
      correlationId: randomUUID(),
    });
    expect(completed).toMatchObject({
      attemptId: started.attemptId,
      connectionId: started.connectionId,
      provider: "stripe",
      connectionStatus: "backfilling",
    });

    const resolvedAccessToken = await resolver.resolve({
      reference: `sealed:${completed.credentialId}`,
      organizationId,
      connectionId: started.connectionId,
      provider: "stripe",
      purpose: "api_read",
    });
    expect(resolvedAccessToken).toBe(accessToken);
    expect(resolvedAccessToken).not.toContain(refreshToken);
    const durableCompletion = await adminDatabase`
      select
        attempts.status,
        connections.status as connection_status,
        connections.api_credential_reference,
        credentials.encrypted_envelope::text as encrypted_envelope
      from provider_authorization_attempts as attempts
      join data_source_connections as connections
        on connections.organization_id = attempts.organization_id
       and connections.id = attempts.connection_id
      join connector_credentials as credentials
        on credentials.organization_id = connections.organization_id
       and credentials.id = substring(connections.api_credential_reference from 8)::uuid
      where attempts.organization_id = ${organizationId}
        and attempts.id = ${started.attemptId}::uuid
    `;
    expect(durableCompletion[0]).toMatchObject({
      status: "succeeded",
      connection_status: "backfilling",
      api_credential_reference: `sealed:${completed.credentialId}`,
    });
    const encryptedEnvelope = databaseString(durableCompletion[0], "encrypted_envelope");
    expect(encryptedEnvelope).not.toContain(accessToken);
    expect(encryptedEnvelope).not.toContain(refreshToken);

    await expect(
      manager.claim(tenant, {
        attemptId: started.attemptId,
        provider: "stripe",
        state: started.state,
      }),
    ).resolves.toEqual({
      kind: "replayed",
      attemptId: started.attemptId,
      connectionId: started.connectionId,
      provider: "stripe",
      status: "succeeded",
    });
    const auditRows = await adminDatabase`
      select previous_value::text as previous_value, new_value::text as new_value
      from audit_events
      where organization_id = ${organizationId}
        and resource_id = ${started.attemptId}
      order by occurred_at, id
    `;
    const auditEvidence = JSON.stringify(auditRows);
    expect(auditEvidence).not.toContain(started.state);
    expect(auditEvidence).not.toContain(accessToken);
    expect(auditEvidence).not.toContain(refreshToken);
  });

  it("allows exactly one concurrent callback claim", async () => {
    const appDatabase = requiredConnection(application, "application");
    const keyring = createConnectorCredentialKeyring({
      references: keyReferences,
      activeVersion: "v1",
      environment: keyEnvironment,
      production: true,
    });
    const manager = new PostgresProviderAuthorizationService(appDatabase, keyring);
    const started = await manager.begin(tenant, {
      provider: "stripe",
      connectorVersion: "1.1.0",
      correlationId: randomUUID(),
    });
    const outcomes = await Promise.allSettled([
      manager.claim(tenant, {
        attemptId: started.attemptId,
        provider: "stripe",
        state: started.state,
      }),
      manager.claim(tenant, {
        attemptId: started.attemptId,
        provider: "stripe",
        state: started.state,
      }),
    ]);
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof manager.claim>>> =>
        outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value.kind).toBe("claimed");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ProviderAuthorizationConflictError);
    const result = fulfilled[0]?.value;
    if (result?.kind !== "claimed") throw new Error("authorization was not claimed");
    await expect(
      manager.fail(tenant, {
        claim: result.claim,
        errorCode: "TEST_EXCHANGE_ABORTED",
        correlationId: randomUUID(),
      }),
    ).resolves.toEqual({ attemptId: started.attemptId, status: "failed" });
  });

  it("serializes an expiring token refresh and rotates ciphertext under worker-only authority", async () => {
    const appDatabase = requiredConnection(application, "application");
    const workerDatabase = requiredConnection(worker, "worker");
    const adminDatabase = requiredConnection(administrator, "administrator");
    const keyring = createConnectorCredentialKeyring({
      references: keyReferences,
      activeVersion: "v1",
      environment: keyEnvironment,
      production: true,
    });
    const authorizationManager = new PostgresProviderAuthorizationService(appDatabase, keyring);
    const started = await authorizationManager.begin(tenant, {
      provider: "stripe",
      connectorVersion: "1.1.0",
      apiVersion: "2025-06-30.basil",
      correlationId: randomUUID(),
    });
    const claimed = await authorizationManager.claim(tenant, {
      attemptId: started.attemptId,
      provider: "stripe",
      state: started.state,
    });
    if (claimed.kind !== "claimed") throw new Error("authorization was not claimed");
    const issuedAt = new Date();
    const externalAccountId = `acct_${randomUUID().replaceAll("-", "")}`;
    const initialAccessToken = "synthetic-expiring-access-token";
    const initialRefreshToken = "synthetic-expiring-refresh-token";
    const installed = await authorizationManager.complete(tenant, {
      claim: claimed.claim,
      tokenBundle: {
        schemaVersion: 1,
        credentialType: "oauth_refreshable",
        provider: "stripe",
        externalAccountId,
        livemode: false,
        authorizationGrantedAt: issuedAt.toISOString(),
        accessToken: initialAccessToken,
        refreshToken: initialRefreshToken,
        accessTokenExpiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
        refreshTokenExpiresAt: new Date(
          issuedAt.getTime() + 365 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        scopes: ["stripe_apps"],
        issuedAt: issuedAt.toISOString(),
      },
      correlationId: randomUUID(),
    });

    const refreshNow = new Date(issuedAt.getTime() + 2_000);
    const refreshedAccessToken = "synthetic-rotated-access-token";
    const refreshedRefreshToken = "synthetic-rotated-refresh-token";
    const refresh = vi.fn(async () => ({
      schemaVersion: 1 as const,
      credentialType: "oauth_refreshable" as const,
      provider: "stripe" as const,
      externalAccountId,
      livemode: false,
      authorizationGrantedAt: issuedAt.toISOString(),
      accessToken: refreshedAccessToken,
      refreshToken: refreshedRefreshToken,
      accessTokenExpiresAt: new Date(refreshNow.getTime() + 60 * 60 * 1000).toISOString(),
      refreshTokenExpiresAt: new Date(
        refreshNow.getTime() + 365 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      scopes: ["stripe_apps"],
      issuedAt: refreshNow.toISOString(),
    }));
    const scopeDriftResolver = new PostgresConnectorCredentialService(
      workerDatabase,
      keyring,
      new EnvironmentConnectorSecretResolver({}),
      {
        oauthRefreshers: {
          stripe: {
            refresh: vi.fn(async () => ({
              ...(await refresh()),
              scopes: ["stripe_apps", "stripe_apps_expanded"],
            })),
          },
        },
        now: () => refreshNow,
      },
    );
    const request = {
      reference: `sealed:${installed.credentialId}`,
      organizationId,
      connectionId: started.connectionId,
      provider: "stripe" as const,
      purpose: "api_read" as const,
    };
    await expect(scopeDriftResolver.resolve(request)).rejects.toMatchObject({
      kind: "authentication",
    });

    refresh.mockClear();
    const resolver = new PostgresConnectorCredentialService(
      workerDatabase,
      keyring,
      new EnvironmentConnectorSecretResolver({}),
      {
        oauthRefreshers: { stripe: { refresh } },
        now: () => refreshNow,
      },
    );
    await expect(
      Promise.all([resolver.resolve(request), resolver.resolve(request)]),
    ).resolves.toEqual([refreshedAccessToken, refreshedAccessToken]);
    expect(refresh).toHaveBeenCalledTimes(1);

    const durable = await adminDatabase`
      select api_credential_reference
      from data_source_connections
      where organization_id = ${organizationId}
        and id = ${started.connectionId}::uuid
    `;
    const rotatedReference = databaseString(durable[0], "api_credential_reference");
    expect(rotatedReference).not.toBe(request.reference);
    await expect(resolver.resolve({ ...request, reference: rotatedReference })).resolves.toBe(
      refreshedAccessToken,
    );
    expect(refresh).toHaveBeenCalledTimes(1);

    const lifecycle = new PostgresConnectorCredentialService(
      appDatabase,
      keyring,
      new EnvironmentConnectorSecretResolver({}),
    );
    const credentials = await lifecycle.list(tenant, started.connectionId);
    expect(credentials).toHaveLength(2);
    expect(credentials[0]).toMatchObject({
      status: "active",
      createdByService: "provider-token-refresh-v1",
      rotatedFromCredentialId: installed.credentialId,
    });
    const auditRows = await adminDatabase`
      select previous_value::text as previous_value, new_value::text as new_value
      from audit_events
      where organization_id = ${organizationId}
        and action = 'connector_credential.oauth_refreshed'
        and resource_id = ${credentials[0]?.id ?? ""}
    `;
    expect(auditRows).toHaveLength(1);
    const auditEvidence = JSON.stringify(auditRows);
    expect(auditEvidence).not.toContain(initialAccessToken);
    expect(auditEvidence).not.toContain(initialRefreshToken);
    expect(auditEvidence).not.toContain(refreshedAccessToken);
    expect(auditEvidence).not.toContain(refreshedRefreshToken);

    await expect(
      appDatabase`
        select reconai_lock_oauth_credential(
          ${organizationId}::uuid,
          ${started.connectionId}::uuid,
          'stripe',
          ${rotatedReference}
        )
      `,
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("commits expiration evidence before returning an expired callback error", async () => {
    const appDatabase = requiredConnection(application, "application");
    const adminDatabase = requiredConnection(administrator, "administrator");
    const keyring = createConnectorCredentialKeyring({
      references: keyReferences,
      activeVersion: "v1",
      environment: keyEnvironment,
      production: true,
    });
    const manager = new PostgresProviderAuthorizationService(appDatabase, keyring);
    const state = createProviderAuthorizationState();
    const attemptId = randomUUID();
    await adminDatabase`
      insert into provider_authorization_attempts (
        id, organization_id, connection_id, provider, state_sha256, status,
        requested_account_id, requested_by_membership_id, expires_at, created_at, updated_at
      ) values (
        ${attemptId}, ${organizationId}, ${expiredConnectionId}, 'stripe', ${state.sha256},
        'pending', null, ${membershipId}, now() - interval '1 minute',
        now() - interval '11 minutes', now() - interval '11 minutes'
      )
    `;
    await expect(
      manager.claim(tenant, {
        attemptId,
        provider: "stripe",
        state: state.value,
      }),
    ).rejects.toBeInstanceOf(ProviderAuthorizationExpiredError);
    const durable = await adminDatabase`
      select status, error_code, completed_at
      from provider_authorization_attempts
      where organization_id = ${organizationId}
        and id = ${attemptId}::uuid
    `;
    expect(durable[0]).toMatchObject({
      status: "expired",
      error_code: "AUTHORIZATION_EXPIRED",
    });
    expect(durable[0]?.["completed_at"]).not.toBeNull();
  });

  it("stops Stripe reads before provider action and finalizes only an exact signed-event authority", async () => {
    const appDatabase = requiredConnection(application, "application");
    const workerDatabase = requiredConnection(worker, "worker");
    const adminDatabase = requiredConnection(administrator, "administrator");
    const keyring = createConnectorCredentialKeyring({
      references: keyReferences,
      activeVersion: "v1",
      environment: keyEnvironment,
      production: true,
    });
    const authorization = new PostgresProviderAuthorizationService(appDatabase, keyring);
    const lifecycle = new PostgresConnectorCredentialService(
      appDatabase,
      keyring,
      new EnvironmentConnectorSecretResolver({}),
    );
    const started = await authorization.begin(tenant, {
      provider: "stripe",
      connectorVersion: "1.1.0",
      apiVersion: "2025-06-30.basil",
      correlationId: randomUUID(),
    });
    const claimed = await authorization.claim(tenant, {
      attemptId: started.attemptId,
      provider: "stripe",
      state: started.state,
    });
    if (claimed.kind !== "claimed") throw new Error("authorization was not claimed");
    const externalAccountId = `acct_${randomUUID().replaceAll("-", "")}`;
    const issuedAt = new Date();
    const accessToken = "synthetic-deauthorization-access-token";
    const refreshToken = "synthetic-deauthorization-refresh-token";
    const installed = await authorization.complete(tenant, {
      claim: claimed.claim,
      tokenBundle: {
        schemaVersion: 1,
        credentialType: "oauth_refreshable",
        provider: "stripe",
        externalAccountId,
        livemode: false,
        authorizationGrantedAt: issuedAt.toISOString(),
        accessToken,
        refreshToken,
        accessTokenExpiresAt: new Date(issuedAt.getTime() + 60 * 60 * 1000).toISOString(),
        refreshTokenExpiresAt: new Date(
          issuedAt.getTime() + 365 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        scopes: ["stripe_apps"],
        issuedAt: issuedAt.toISOString(),
      },
      correlationId: randomUUID(),
    });
    await expect(
      lifecycle.markProviderActionRequired(tenant, {
        connectionId: started.connectionId,
        confirmConnectionId: started.connectionId,
        reason: "Operator requested Stripe app uninstall",
        correlationId: randomUUID(),
      }),
    ).resolves.toEqual({ status: "provider_action_required", replayed: false });
    const workerResolver = new PostgresConnectorCredentialService(
      workerDatabase,
      keyring,
      new EnvironmentConnectorSecretResolver({}),
    );
    await expect(
      workerResolver.resolve({
        reference: `sealed:${installed.credentialId}`,
        organizationId,
        connectionId: started.connectionId,
        provider: "stripe",
        purpose: "api_read",
      }),
    ).rejects.toMatchObject({ kind: "authentication" });

    const repository = new PostgresStripeAppDeauthorizationRepository(appDatabase, keyring);
    const occurredAt = new Date().toISOString();
    const eventSuffix = randomUUID().replaceAll("-", "");
    const wrongModeEventId = `evt_WrongMode${eventSuffix}`;
    const staleInstallationEventId = `evt_StaleInstallation${eventSuffix}`;
    const deauthorizedEventId = `evt_Deauthorized${eventSuffix}`;
    const baseEvent = {
      externalAccountId,
      payloadSha256: "a".repeat(64),
      occurredAt,
      receivedAt: occurredAt,
      correlationId: randomUUID(),
    };
    await expect(
      repository.finalizeStripeDeauthorization({
        ...baseEvent,
        externalEventId: wrongModeEventId,
        livemode: true,
      }),
    ).resolves.toEqual({ matched: false, duplicate: false });
    await expect(
      repository.finalizeStripeDeauthorization({
        ...baseEvent,
        externalEventId: staleInstallationEventId,
        livemode: false,
        occurredAt: new Date(issuedAt.getTime() - 1000).toISOString(),
      }),
    ).resolves.toEqual({ matched: false, duplicate: false });
    await expect(
      repository.finalizeStripeDeauthorization({
        ...baseEvent,
        externalEventId: deauthorizedEventId,
        livemode: false,
      }),
    ).resolves.toEqual({ matched: true, duplicate: false });
    await expect(
      repository.finalizeStripeDeauthorization({
        ...baseEvent,
        externalEventId: deauthorizedEventId,
        livemode: false,
      }),
    ).resolves.toEqual({ matched: true, duplicate: true });

    const evidence = await adminDatabase`
      select
        connections.status,
        connections.api_credential_reference,
        credentials.status as credential_status,
        (select count(*)::integer
          from provider_deauthorization_events
          where organization_id = ${organizationId}
            and connection_id = ${started.connectionId}::uuid) as event_count,
        (select new_value::text
          from audit_events
          where organization_id = ${organizationId}
            and action = 'connector.provider_deauthorization_confirmed'
            and resource_id = ${started.connectionId}
          limit 1) as audit_value
      from data_source_connections as connections
      join connector_credentials as credentials
        on credentials.organization_id = connections.organization_id
       and credentials.connection_id = connections.id
      where connections.organization_id = ${organizationId}
        and connections.id = ${started.connectionId}::uuid
    `;
    expect(evidence[0]).toMatchObject({
      status: "disconnected",
      api_credential_reference: null,
      credential_status: "revoked",
      event_count: 1,
    });
    const auditValue = databaseString(evidence[0], "audit_value");
    expect(auditValue).not.toContain(accessToken);
    expect(auditValue).not.toContain(refreshToken);
    await expect(
      workerDatabase`select id from provider_deauthorization_events limit 1`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      workerDatabase`select * from reconai_resolve_stripe_deauthorization(${externalAccountId})`,
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps authorization evidence append-only and unavailable to workers", async () => {
    const appDatabase = requiredConnection(application, "application");
    const adminDatabase = requiredConnection(administrator, "administrator");
    const workerDatabase = requiredConnection(worker, "worker");
    const keyring = createConnectorCredentialKeyring({
      references: keyReferences,
      activeVersion: "v1",
      environment: keyEnvironment,
      production: true,
    });
    const manager = new PostgresProviderAuthorizationService(appDatabase, keyring);
    const started = await manager.begin(tenant, {
      provider: "shopify",
      requestedAccountId: `${randomUUID().replaceAll("-", "")}.myshopify.com`,
      connectorVersion: "1.0.0",
      apiVersion: "2026-07",
      correlationId: randomUUID(),
    });
    await expect(
      adminDatabase`
        delete from provider_authorization_attempts
        where organization_id = ${organizationId}
          and id = ${started.attemptId}::uuid
      `,
    ).rejects.toThrow(/append-only/u);
    await expect(
      workerDatabase`select id from provider_authorization_attempts limit 1`,
    ).rejects.toMatchObject({ code: "42501" });
  });
});

async function seedTenants(sql: Sql): Promise<void> {
  await sql`
    insert into organizations (id, name) values
      (${organizationId}, 'Provider Authorization Integration Tenant'),
      (${otherOrganizationId}, 'Other Provider Authorization Integration Tenant')
  `;
  await sql`
    insert into users (id, issuer, subject, email) values
      (${userId}, 'https://issuer.example.test', ${`authorization-${userId}`}, 'authorization@example.test'),
      (${otherUserId}, 'https://issuer.example.test', ${`authorization-${otherUserId}`}, 'other-authorization@example.test')
  `;
  await sql`
    insert into memberships (id, organization_id, user_id, role, status) values
      (${membershipId}, ${organizationId}, ${userId}, 'administrator', 'active'),
      (${otherMembershipId}, ${otherOrganizationId}, ${otherUserId}, 'administrator', 'active')
  `;
  await sql`
    insert into data_source_connections (
      id, organization_id, provider, external_account_id, status, connector_version,
      api_version, created_at, updated_at
    ) values (
      ${expiredConnectionId}, ${organizationId}, 'stripe',
      ${`acct_${expiredConnectionId.replaceAll("-", "")}`}, 'action_required', '1.0.0',
      '2025-06-30.basil', now(), now()
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

function databaseString(value: unknown, field: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`database returned an invalid ${field}`);
  }
  const item = (value as Record<string, unknown>)[field];
  if (typeof item !== "string") throw new Error(`database returned an invalid ${field}`);
  return item;
}

async function ensureLocalTestRoles(sql: Sql): Promise<void> {
  const existing = await sql`
    select rolname from pg_roles
    where rolname in ('reconai_migrator', 'reconai_app', 'reconai_worker')
  `;
  const names = new Set(Array.from(existing, (row: unknown) => databaseString(row, "rolname")));
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
