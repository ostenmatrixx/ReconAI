import { randomUUID } from "node:crypto";

import {
  ProviderOAuthTokenBundleSchema,
  connectorCredentialEnvelopeSha256,
  createProviderAuthorizationState,
  providerAuthorizationStateSha256,
  sealConnectorCredential,
  serializeProviderOAuthTokenBundle,
  type ConnectorCredentialKeyring,
  type ProviderOAuthTokenBundle,
} from "@workspace/connectors";
import type { TenantContext } from "@workspace/domain";
import type { JSONValue, Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { insertUserAuditEvent } from "./audit.js";

const providerSchema = z.enum(["shopify", "stripe"]);
const authorizationStatusSchema = z.enum([
  "pending",
  "exchanging",
  "succeeded",
  "denied",
  "failed",
  "expired",
]);
const shopifyAccountSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/u);
const stripeAccountSchema = z.string().regex(/^acct_[A-Za-z0-9]{1,250}$/u);
const versionSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._:/+-]+$/u);
const authorizationErrorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,99}$/u);

export type ProviderAuthorizationProvider = z.infer<typeof providerSchema>;
export type ProviderAuthorizationStatus = z.infer<typeof authorizationStatusSchema>;

export interface ProviderAuthorizationBeginResult {
  readonly attemptId: string;
  readonly connectionId: string;
  readonly provider: ProviderAuthorizationProvider;
  readonly state: string;
  readonly expiresAt: string;
  readonly requestedAccountId?: string;
}

export interface ClaimedProviderAuthorization {
  readonly attemptId: string;
  readonly connectionId: string;
  readonly provider: ProviderAuthorizationProvider;
  readonly requestedAccountId?: string;
  readonly claimedAt: string;
}

export type ProviderAuthorizationClaimResult =
  | {
      readonly kind: "claimed";
      readonly claim: ClaimedProviderAuthorization;
    }
  | {
      readonly kind: "replayed";
      readonly attemptId: string;
      readonly connectionId: string;
      readonly provider: ProviderAuthorizationProvider;
      readonly status: "succeeded";
    };

export interface ProviderAuthorizationCompletionResult {
  readonly attemptId: string;
  readonly connectionId: string;
  readonly provider: ProviderAuthorizationProvider;
  readonly externalAccountId: string;
  readonly credentialId: string;
  readonly connectionStatus: "backfilling";
  readonly completedAt: string;
}

export interface ProviderAuthorizationManager {
  begin(
    tenant: TenantContext,
    input: {
      readonly provider: ProviderAuthorizationProvider;
      readonly connectionId?: string;
      readonly requestedAccountId?: string;
      readonly connectorVersion: string;
      readonly apiVersion?: string;
      readonly correlationId: string;
    },
  ): Promise<ProviderAuthorizationBeginResult>;
  claim(
    tenant: TenantContext,
    input: {
      readonly attemptId: string;
      readonly provider: ProviderAuthorizationProvider;
      readonly state: string;
    },
  ): Promise<ProviderAuthorizationClaimResult>;
  complete(
    tenant: TenantContext,
    input: {
      readonly claim: ClaimedProviderAuthorization;
      readonly tokenBundle: ProviderOAuthTokenBundle;
      readonly correlationId: string;
    },
  ): Promise<ProviderAuthorizationCompletionResult>;
  deny(
    tenant: TenantContext,
    input: {
      readonly attemptId: string;
      readonly provider: ProviderAuthorizationProvider;
      readonly state: string;
      readonly errorCode: string;
      readonly correlationId: string;
    },
  ): Promise<{ readonly attemptId: string; readonly status: "denied" | "succeeded" }>;
  fail(
    tenant: TenantContext,
    input: {
      readonly claim: ClaimedProviderAuthorization;
      readonly errorCode: string;
      readonly correlationId: string;
    },
  ): Promise<{ readonly attemptId: string; readonly status: "failed" }>;
}

export class ProviderAuthorizationNotFoundError extends Error {
  public constructor() {
    super("provider authorization was not found");
    this.name = "ProviderAuthorizationNotFoundError";
  }
}

export class ProviderAuthorizationConflictError extends Error {
  public constructor(message = "provider authorization cannot be continued") {
    super(message);
    this.name = "ProviderAuthorizationConflictError";
  }
}

export class ProviderAuthorizationExpiredError extends Error {
  public constructor() {
    super("provider authorization has expired");
    this.name = "ProviderAuthorizationExpiredError";
  }
}

export class PostgresProviderAuthorizationService implements ProviderAuthorizationManager {
  public constructor(
    private readonly sql: Sql,
    private readonly keyring: ConnectorCredentialKeyring,
  ) {}

  public async begin(
    tenant: TenantContext,
    input: {
      readonly provider: ProviderAuthorizationProvider;
      readonly connectionId?: string;
      readonly requestedAccountId?: string;
      readonly connectorVersion: string;
      readonly apiVersion?: string;
      readonly correlationId: string;
    },
  ): Promise<ProviderAuthorizationBeginResult> {
    const provider = providerSchema.parse(input.provider);
    const suppliedConnectionId = input.connectionId
      ? z.uuid().parse(input.connectionId)
      : undefined;
    const suppliedAccountId = parseRequestedAccount(provider, input.requestedAccountId);
    const connectorVersion = versionSchema.parse(input.connectorVersion);
    const apiVersion = input.apiVersion ? versionSchema.parse(input.apiVersion) : undefined;
    const correlationId = z.uuid().parse(input.correlationId);
    const state = createProviderAuthorizationState();
    const attemptId = randomUUID();
    const connectionId = suppliedConnectionId ?? randomUUID();
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();

    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const existingConnectionRows = suppliedConnectionId
        ? await transaction`
            select id, provider, external_account_id
            from data_source_connections
            where organization_id = ${tenant.organizationId}
              and id = ${connectionId}::uuid
            limit 1
            for update
          `
        : [];
      const existingConnection = existingConnectionRows[0]
        ? databaseRow(existingConnectionRows[0])
        : undefined;
      if (suppliedConnectionId && !existingConnection) {
        throw new ProviderAuthorizationNotFoundError();
      }

      let requestedAccountId = suppliedAccountId;
      if (existingConnection) {
        const existingProvider = providerSchema.parse(existingConnection["provider"]);
        if (existingProvider !== provider) {
          throw new ProviderAuthorizationConflictError(
            "provider does not match the connection being authorized",
          );
        }
        const existingAccountId = z.string().parse(existingConnection["external_account_id"]);
        if (provider === "shopify") {
          requestedAccountId = shopifyAccountSchema.parse(suppliedAccountId ?? existingAccountId);
          if (requestedAccountId !== existingAccountId) {
            throw new ProviderAuthorizationConflictError(
              "Shopify shop does not match the connection being authorized",
            );
          }
        } else if (existingAccountId.startsWith("acct_")) {
          const knownAccountId = stripeAccountSchema.parse(existingAccountId);
          if (suppliedAccountId && suppliedAccountId !== knownAccountId) {
            throw new ProviderAuthorizationConflictError(
              "Stripe account does not match the connection being authorized",
            );
          }
          requestedAccountId = knownAccountId;
        }
      } else {
        if (provider === "shopify" && !requestedAccountId) {
          throw new ProviderAuthorizationConflictError(
            "a canonical Shopify shop is required to begin authorization",
          );
        }
        const externalAccountId =
          requestedAccountId ?? `oauth_pending_${attemptId.replaceAll("-", "")}`;
        await transaction`
          insert into data_source_connections (
            id, organization_id, provider, external_account_id, status,
            connector_version, api_version, created_at, updated_at
          ) values (
            ${connectionId}, ${tenant.organizationId}, ${provider}, ${externalAccountId},
            'action_required', ${connectorVersion}, ${apiVersion ?? null}, ${nowIso}, ${nowIso}
          )
        `;
      }

      const activeAttempts = await transaction`
        select id, status, expires_at
        from provider_authorization_attempts
        where organization_id = ${tenant.organizationId}
          and connection_id = ${connectionId}::uuid
          and status in ('pending', 'exchanging')
        order by created_at desc
        limit 1
        for update
      `;
      const activeAttempt = activeAttempts[0] ? databaseRow(activeAttempts[0]) : undefined;
      if (activeAttempt) {
        const activeStatus = authorizationStatusSchema.parse(activeAttempt["status"]);
        const activeExpiresAt = databaseTimestamp(
          activeAttempt["expires_at"],
          "authorization.expires_at",
        );
        if (activeStatus === "pending" && Date.parse(activeExpiresAt) <= now.getTime()) {
          await transaction`
            update provider_authorization_attempts
            set status = 'expired',
                completed_at = ${nowIso},
                error_code = 'AUTHORIZATION_EXPIRED',
                updated_at = ${nowIso}
            where organization_id = ${tenant.organizationId}
              and id = ${z.uuid().parse(activeAttempt["id"])}::uuid
              and status = 'pending'
          `;
        } else {
          throw new ProviderAuthorizationConflictError(
            "an authorization attempt is already active for this connection",
          );
        }
      }

      await transaction`
        insert into provider_authorization_attempts (
          id, organization_id, connection_id, provider, state_sha256, status,
          requested_account_id, requested_by_membership_id, expires_at, created_at, updated_at
        ) values (
          ${attemptId}, ${tenant.organizationId}, ${connectionId}, ${provider}, ${state.sha256},
          'pending', ${requestedAccountId ?? null}, ${tenant.membershipId}, ${expiresAt},
          ${nowIso}, ${nowIso}
        )
      `;
      await insertUserAuditEvent(transaction, tenant, {
        action: "connector_authorization.started",
        resourceType: "provider_authorization_attempt",
        resourceId: attemptId,
        correlationId,
        reason: "User started read-only provider authorization",
        newValue: {
          connectionId,
          provider,
          requestedAccountId: requestedAccountId ?? null,
          status: "pending",
          expiresAt,
        },
        versionContext: {
          authorizationState: "sha256-only",
          connectorVersion,
          apiVersion: apiVersion ?? null,
        },
      });

      return {
        attemptId,
        connectionId,
        provider,
        state: state.value,
        expiresAt,
        ...(requestedAccountId ? { requestedAccountId } : {}),
      };
    });
  }

  public async claim(
    tenant: TenantContext,
    input: {
      readonly attemptId: string;
      readonly provider: ProviderAuthorizationProvider;
      readonly state: string;
    },
  ): Promise<ProviderAuthorizationClaimResult> {
    const attemptId = z.uuid().parse(input.attemptId);
    const provider = providerSchema.parse(input.provider);
    const stateSha256 = providerAuthorizationStateSha256(input.state);
    const now = new Date();
    const nowIso = now.toISOString();

    const outcome = await withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select
          id, connection_id, provider, requested_account_id, requested_by_membership_id,
          state_sha256, status, expires_at, claimed_at
        from provider_authorization_attempts
        where organization_id = ${tenant.organizationId}
          and id = ${attemptId}::uuid
          and provider = ${provider}
          and state_sha256 = ${stateSha256}
          and exists (
            select 1
            from memberships
            where memberships.organization_id = ${tenant.organizationId}
              and memberships.id = ${tenant.membershipId}::uuid
              and memberships.status = 'active'
          )
        limit 1
        for update
      `;
      const row = rows[0] ? databaseRow(rows[0]) : undefined;
      if (row?.["requested_by_membership_id"] !== tenant.membershipId) {
        throw new ProviderAuthorizationNotFoundError();
      }
      const status = authorizationStatusSchema.parse(row["status"]);
      const connectionId = z.uuid().parse(row["connection_id"]);
      if (status === "succeeded") {
        return { kind: "replayed" as const, attemptId, connectionId, provider, status };
      }
      if (status !== "pending") {
        throw new ProviderAuthorizationConflictError();
      }
      const expiresAt = databaseTimestamp(row["expires_at"], "authorization.expires_at");
      if (Date.parse(expiresAt) <= now.getTime()) {
        await transaction`
          update provider_authorization_attempts
          set status = 'expired',
              completed_at = ${nowIso},
              error_code = 'AUTHORIZATION_EXPIRED',
              updated_at = ${nowIso}
          where organization_id = ${tenant.organizationId}
            and id = ${attemptId}::uuid
            and status = 'pending'
        `;
        return { kind: "expired" as const };
      }
      await transaction`
        update provider_authorization_attempts
        set status = 'exchanging',
            claimed_at = ${nowIso},
            updated_at = ${nowIso}
        where organization_id = ${tenant.organizationId}
          and id = ${attemptId}::uuid
          and status = 'pending'
      `;
      const requestedAccountId = optionalString(row["requested_account_id"]);
      return {
        kind: "claimed" as const,
        claim: {
          attemptId,
          connectionId,
          provider,
          ...(requestedAccountId ? { requestedAccountId } : {}),
          claimedAt: nowIso,
        },
      };
    });
    if (outcome.kind === "expired") throw new ProviderAuthorizationExpiredError();
    return outcome;
  }

  public async complete(
    tenant: TenantContext,
    input: {
      readonly claim: ClaimedProviderAuthorization;
      readonly tokenBundle: ProviderOAuthTokenBundle;
      readonly correlationId: string;
    },
  ): Promise<ProviderAuthorizationCompletionResult> {
    const claim = claimedAuthorizationSchema.parse(input.claim);
    const tokenBundle = ProviderOAuthTokenBundleSchema.parse(input.tokenBundle);
    const correlationId = z.uuid().parse(input.correlationId);
    if (claim.provider !== tokenBundle.provider) {
      throw new ProviderAuthorizationConflictError(
        "provider token authority does not match the authorization claim",
      );
    }
    if (claim.requestedAccountId && claim.requestedAccountId !== tokenBundle.externalAccountId) {
      throw new ProviderAuthorizationConflictError(
        "provider account does not match the authorization claim",
      );
    }

    const serializedBundle = serializeProviderOAuthTokenBundle(tokenBundle);
    const envelope = sealConnectorCredential(
      {
        organizationId: tenant.organizationId,
        connectionId: claim.connectionId,
        provider: claim.provider,
        purpose: "api_read",
        secret: serializedBundle,
      },
      this.keyring,
    );
    const envelopeSha256 = connectorCredentialEnvelopeSha256(envelope);
    const credentialId = randomUUID();
    const completedAt = new Date().toISOString();

    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const attemptRows = await transaction`
        select
          connection_id, provider, requested_account_id, requested_by_membership_id,
          status, claimed_at
        from provider_authorization_attempts
        where organization_id = ${tenant.organizationId}
          and id = ${claim.attemptId}::uuid
        limit 1
        for update
      `;
      const attempt = attemptRows[0] ? databaseRow(attemptRows[0]) : undefined;
      if (
        attempt?.["status"] !== "exchanging" ||
        attempt["connection_id"] !== claim.connectionId ||
        attempt["provider"] !== claim.provider ||
        attempt["requested_by_membership_id"] !== tenant.membershipId ||
        databaseTimestamp(attempt["claimed_at"], "authorization.claimed_at") !== claim.claimedAt
      ) {
        throw new ProviderAuthorizationConflictError();
      }
      const requestedAccountId = optionalString(attempt["requested_account_id"]);
      if (requestedAccountId && requestedAccountId !== tokenBundle.externalAccountId) {
        throw new ProviderAuthorizationConflictError(
          "provider account does not match the durable authorization request",
        );
      }

      const connectionRows = await transaction`
        select external_account_id, status
        from data_source_connections
        where organization_id = ${tenant.organizationId}
          and id = ${claim.connectionId}::uuid
          and provider = ${claim.provider}
        limit 1
        for update
      `;
      const connection = connectionRows[0] ? databaseRow(connectionRows[0]) : undefined;
      if (!connection) throw new ProviderAuthorizationNotFoundError();

      const activeCredentialRows = await transaction`
        select id, key_version
        from connector_credentials
        where organization_id = ${tenant.organizationId}
          and connection_id = ${claim.connectionId}::uuid
          and purpose = 'api_read'
          and status = 'active'
        limit 1
        for update
      `;
      const activeCredential = activeCredentialRows[0]
        ? databaseRow(activeCredentialRows[0])
        : undefined;
      const rotatedFromCredentialId = activeCredential
        ? z.uuid().parse(activeCredential["id"])
        : undefined;
      if (rotatedFromCredentialId) {
        await transaction`
          update connector_credentials
          set status = 'superseded',
              superseded_at = ${completedAt},
              updated_at = ${completedAt}
          where organization_id = ${tenant.organizationId}
            and id = ${rotatedFromCredentialId}::uuid
            and status = 'active'
        `;
      }

      await transaction`
        insert into connector_credentials (
          id, organization_id, connection_id, purpose, encrypted_envelope, key_version,
          envelope_sha256, status, created_by_membership_id, rotated_from_credential_id,
          created_at, updated_at
        ) values (
          ${credentialId}, ${tenant.organizationId}, ${claim.connectionId}, 'api_read',
          ${transaction.json(toJsonValue(envelope))}, ${envelope.keyVersion}, ${envelopeSha256},
          'active', ${tenant.membershipId}, ${rotatedFromCredentialId ?? null},
          ${completedAt}, ${completedAt}
        )
      `;
      const credentialReference = `sealed:${credentialId}`;
      await transaction`
        update data_source_connections
        set external_account_id = ${tokenBundle.externalAccountId},
            api_credential_reference = ${credentialReference},
            encrypted_credential = null,
            credential_key_version = null,
            status = 'backfilling',
            cursor = null,
            updated_at = ${completedAt}
        where organization_id = ${tenant.organizationId}
          and id = ${claim.connectionId}::uuid
      `;
      await transaction`
        update provider_authorization_attempts
        set status = 'succeeded',
            completed_at = ${completedAt},
            updated_at = ${completedAt}
        where organization_id = ${tenant.organizationId}
          and id = ${claim.attemptId}::uuid
          and status = 'exchanging'
      `;
      await insertUserAuditEvent(transaction, tenant, {
        action: "connector_authorization.succeeded",
        resourceType: "provider_authorization_attempt",
        resourceId: claim.attemptId,
        correlationId,
        reason: "Provider granted read-only connector authorization",
        previousValue: {
          connectionId: claim.connectionId,
          status: "exchanging",
          previousExternalAccountId: z.string().parse(connection["external_account_id"]),
          previousCredentialId: rotatedFromCredentialId ?? null,
          previousKeyVersion: activeCredential
            ? z.string().parse(activeCredential["key_version"])
            : null,
        },
        newValue: {
          connectionId: claim.connectionId,
          provider: claim.provider,
          externalAccountId: tokenBundle.externalAccountId,
          status: "succeeded",
          connectionStatus: "backfilling",
          credentialId,
          keyVersion: envelope.keyVersion,
          scopes: tokenBundle.scopes,
          accessTokenExpiresAt: tokenBundle.accessTokenExpiresAt,
          refreshTokenExpiresAt: tokenBundle.refreshTokenExpiresAt,
        },
        versionContext: {
          authorizationAttemptSchemaVersion: 1,
          credentialEnvelopeSchemaVersion: envelope.schemaVersion,
          tokenBundleSchemaVersion: tokenBundle.schemaVersion,
          algorithm: envelope.algorithm,
        },
      });

      return {
        attemptId: claim.attemptId,
        connectionId: claim.connectionId,
        provider: claim.provider,
        externalAccountId: tokenBundle.externalAccountId,
        credentialId,
        connectionStatus: "backfilling",
        completedAt,
      };
    });
  }

  public async deny(
    tenant: TenantContext,
    input: {
      readonly attemptId: string;
      readonly provider: ProviderAuthorizationProvider;
      readonly state: string;
      readonly errorCode: string;
      readonly correlationId: string;
    },
  ): Promise<{ readonly attemptId: string; readonly status: "denied" | "succeeded" }> {
    const attemptId = z.uuid().parse(input.attemptId);
    const provider = providerSchema.parse(input.provider);
    const stateSha256 = providerAuthorizationStateSha256(input.state);
    const errorCode = authorizationErrorCodeSchema.parse(input.errorCode);
    const correlationId = z.uuid().parse(input.correlationId);
    const completedAt = new Date().toISOString();

    const outcome = await withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select connection_id, requested_by_membership_id, status
        from provider_authorization_attempts
        where organization_id = ${tenant.organizationId}
          and id = ${attemptId}::uuid
          and provider = ${provider}
          and state_sha256 = ${stateSha256}
          and exists (
            select 1
            from memberships
            where memberships.organization_id = ${tenant.organizationId}
              and memberships.id = ${tenant.membershipId}::uuid
              and memberships.status = 'active'
          )
        limit 1
        for update
      `;
      const row = rows[0] ? databaseRow(rows[0]) : undefined;
      if (row?.["requested_by_membership_id"] !== tenant.membershipId) {
        throw new ProviderAuthorizationNotFoundError();
      }
      if (row["status"] === "succeeded") {
        return { attemptId, status: "succeeded" as const };
      }
      if (row["status"] !== "pending") throw new ProviderAuthorizationConflictError();
      const expiryRows = await transaction`
        select expires_at
        from provider_authorization_attempts
        where organization_id = ${tenant.organizationId}
          and id = ${attemptId}::uuid
        limit 1
      `;
      const expiry = expiryRows[0] ? databaseRow(expiryRows[0]) : undefined;
      if (
        !expiry ||
        Date.parse(databaseTimestamp(expiry["expires_at"], "authorization.expires_at")) <=
          Date.parse(completedAt)
      ) {
        await transaction`
          update provider_authorization_attempts
          set status = 'expired',
              completed_at = ${completedAt},
              error_code = 'AUTHORIZATION_EXPIRED',
              updated_at = ${completedAt}
          where organization_id = ${tenant.organizationId}
            and id = ${attemptId}::uuid
            and status = 'pending'
        `;
        return { attemptId, status: "expired" as const };
      }
      await transaction`
        update provider_authorization_attempts
        set status = 'denied',
            completed_at = ${completedAt},
            error_code = ${errorCode},
            updated_at = ${completedAt}
        where organization_id = ${tenant.organizationId}
          and id = ${attemptId}::uuid
          and status = 'pending'
      `;
      await insertUserAuditEvent(transaction, tenant, {
        action: "connector_authorization.denied",
        resourceType: "provider_authorization_attempt",
        resourceId: attemptId,
        correlationId,
        reason: "Provider authorization was denied or cancelled",
        previousValue: { status: "pending" },
        newValue: {
          connectionId: z.uuid().parse(row["connection_id"]),
          provider,
          status: "denied",
          errorCode,
        },
        versionContext: { authorizationAttemptSchemaVersion: 1 },
      });
      return { attemptId, status: "denied" as const };
    });
    if (outcome.status === "expired") throw new ProviderAuthorizationExpiredError();
    return outcome;
  }

  public async fail(
    tenant: TenantContext,
    input: {
      readonly claim: ClaimedProviderAuthorization;
      readonly errorCode: string;
      readonly correlationId: string;
    },
  ): Promise<{ readonly attemptId: string; readonly status: "failed" }> {
    const claim = claimedAuthorizationSchema.parse(input.claim);
    const errorCode = authorizationErrorCodeSchema.parse(input.errorCode);
    const correlationId = z.uuid().parse(input.correlationId);
    const completedAt = new Date().toISOString();
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select connection_id, provider, requested_by_membership_id, status, claimed_at
        from provider_authorization_attempts
        where organization_id = ${tenant.organizationId}
          and id = ${claim.attemptId}::uuid
        limit 1
        for update
      `;
      const row = rows[0] ? databaseRow(rows[0]) : undefined;
      if (
        row?.["status"] !== "exchanging" ||
        row["connection_id"] !== claim.connectionId ||
        row["provider"] !== claim.provider ||
        row["requested_by_membership_id"] !== tenant.membershipId ||
        databaseTimestamp(row["claimed_at"], "authorization.claimed_at") !== claim.claimedAt
      ) {
        throw new ProviderAuthorizationConflictError();
      }
      await transaction`
        update provider_authorization_attempts
        set status = 'failed',
            completed_at = ${completedAt},
            error_code = ${errorCode},
            updated_at = ${completedAt}
        where organization_id = ${tenant.organizationId}
          and id = ${claim.attemptId}::uuid
          and status = 'exchanging'
      `;
      await insertUserAuditEvent(transaction, tenant, {
        action: "connector_authorization.failed",
        resourceType: "provider_authorization_attempt",
        resourceId: claim.attemptId,
        correlationId,
        reason: "Provider authorization could not be completed",
        previousValue: { status: "exchanging" },
        newValue: {
          connectionId: claim.connectionId,
          provider: claim.provider,
          status: "failed",
          errorCode,
        },
        versionContext: { authorizationAttemptSchemaVersion: 1 },
      });
      return { attemptId: claim.attemptId, status: "failed" };
    });
  }
}

const claimedAuthorizationSchema = z
  .object({
    attemptId: z.uuid(),
    connectionId: z.uuid(),
    provider: providerSchema,
    requestedAccountId: z.string().min(1).max(255).optional(),
    claimedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

function parseRequestedAccount(
  provider: ProviderAuthorizationProvider,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return provider === "shopify"
    ? shopifyAccountSchema.parse(value.trim().toLowerCase())
    : stripeAccountSchema.parse(value.trim());
}

async function withTenantTransaction<T>(
  sql: Sql,
  tenant: TenantContext,
  operation: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${tenant.organizationId}, true)`;
    return operation(transaction);
  }) as Promise<T>;
}

function databaseRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("database returned an invalid provider authorization row");
  }
  return value as Record<string, unknown>;
}

function databaseTimestamp(value: unknown, field: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new Error(`database returned an invalid ${field}`);
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return z.string().min(1).max(255).parse(value);
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}
