import { randomUUID } from "node:crypto";

import {
  ConnectorCredentialEnvelopeSchema,
  ConnectorCredentialPurposeSchema,
  ConnectorError,
  connectorCredentialEnvelopeSha256,
  openConnectorCredential,
  parseProviderOAuthTokenBundle,
  sealConnectorCredential,
  serializeProviderOAuthTokenBundle,
  type ConnectorCredentialEnvelope,
  type ConnectorCredentialKeyring,
  type ConnectorCredentialPurpose,
  type ConnectorSecretRequest,
  type ConnectorSecretResolver,
  type EnvironmentConnectorSecretResolver,
  type ProviderOAuthTokenBundle,
} from "@workspace/connectors";
import { OrganizationIdSchema, type TenantContext } from "@workspace/domain";
import type { JSONValue, Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { insertTenantAuditEvent, insertUserAuditEvent } from "./audit.js";

const credentialStatusSchema = z.enum(["active", "superseded", "revoked"]);
const connectionStatusSchema = z.enum([
  "healthy",
  "backfilling",
  "degraded",
  "stale",
  "disconnected",
  "action_required",
]);
const sealedReferenceSchema = z
  .string()
  .regex(/^sealed:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u);

export interface ConnectorCredentialMetadata {
  readonly id: string;
  readonly connectionId: string;
  readonly purpose: ConnectorCredentialPurpose;
  readonly status: "active" | "superseded" | "revoked";
  readonly keyVersion: string;
  readonly createdByMembershipId?: string;
  readonly createdByService?: string;
  readonly rotatedFromCredentialId?: string;
  readonly supersededAt?: string;
  readonly revokedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConnectorCredentialRotationResult {
  readonly credential: ConnectorCredentialMetadata;
  readonly replayed: boolean;
}

export interface ConnectorDisconnectAuthority {
  readonly connectionId: string;
  readonly provider: "shopify" | "stripe";
  readonly externalAccountId: string;
  readonly status:
    "healthy" | "backfilling" | "degraded" | "stale" | "disconnected" | "action_required";
  readonly apiCredentialReference?: string;
  readonly apiVersion?: string;
}

export interface ConnectorProviderDisconnectStore {
  loadDisconnectAuthority(
    tenant: TenantContext,
    connectionId: string,
  ): Promise<ConnectorDisconnectAuthority>;
  markProviderActionRequired(
    tenant: TenantContext,
    input: {
      readonly connectionId: string;
      readonly confirmConnectionId: string;
      readonly reason: string;
      readonly correlationId: string;
    },
  ): Promise<{
    readonly status: "provider_action_required" | "disconnected";
    readonly replayed: boolean;
  }>;
  disconnect: ConnectorCredentialLifecycleManager["disconnect"];
}

export interface ConnectorCredentialLifecycleManager {
  list(
    tenant: TenantContext,
    connectionId: string,
  ): Promise<readonly ConnectorCredentialMetadata[]>;
  rotate(
    tenant: TenantContext,
    input: {
      readonly connectionId: string;
      readonly confirmConnectionId: string;
      readonly purpose: ConnectorCredentialPurpose;
      readonly envelope: ConnectorCredentialEnvelope;
      readonly reason: string;
      readonly correlationId: string;
    },
  ): Promise<ConnectorCredentialRotationResult>;
  disconnect(
    tenant: TenantContext,
    input: {
      readonly connectionId: string;
      readonly confirmConnectionId: string;
      readonly reason: string;
      readonly correlationId: string;
    },
  ): Promise<{
    readonly connectionId: string;
    readonly status: "disconnected";
    readonly revoked: number;
  }>;
}

type ShopifyOAuthTokenBundle = Extract<ProviderOAuthTokenBundle, { provider: "shopify" }>;
type StripeOAuthTokenBundle = Extract<ProviderOAuthTokenBundle, { provider: "stripe" }>;

export interface ConnectorOAuthRefreshers {
  readonly shopify?: {
    refresh(bundle: ShopifyOAuthTokenBundle): Promise<ShopifyOAuthTokenBundle>;
  };
  readonly stripe?: {
    refresh(bundle: StripeOAuthTokenBundle): Promise<StripeOAuthTokenBundle>;
  };
}

export interface ConnectorCredentialServiceOptions {
  readonly oauthRefreshers?: ConnectorOAuthRefreshers;
  readonly now?: () => Date;
  readonly refreshLeewayMs?: number;
}

export class ConnectorCredentialNotFoundError extends Error {
  public constructor() {
    super("connector connection was not found");
    this.name = "ConnectorCredentialNotFoundError";
  }
}

export class ConnectorCredentialConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConnectorCredentialConflictError";
  }
}

export class PostgresConnectorCredentialService
  implements
    ConnectorCredentialLifecycleManager,
    ConnectorProviderDisconnectStore,
    ConnectorSecretResolver
{
  public constructor(
    private readonly sql: Sql,
    private readonly keyring: ConnectorCredentialKeyring,
    private readonly environmentSecrets: EnvironmentConnectorSecretResolver,
    private readonly options: ConnectorCredentialServiceOptions = {},
  ) {}

  public async list(
    tenant: TenantContext,
    connectionIdInput: string,
  ): Promise<readonly ConnectorCredentialMetadata[]> {
    const connectionId = z.uuid().parse(connectionIdInput);
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const connection = await transaction`
        select id
        from data_source_connections
        where organization_id = ${tenant.organizationId}
          and id = ${connectionId}::uuid
        limit 1
      `;
      if (!connection[0]) throw new ConnectorCredentialNotFoundError();
      const rows = await transaction`
        select
          id, connection_id, purpose, status, key_version, created_by_membership_id,
          created_by_service,
          rotated_from_credential_id, superseded_at, revoked_at, created_at, updated_at
        from connector_credentials
        where organization_id = ${tenant.organizationId}
          and connection_id = ${connectionId}::uuid
        order by created_at desc, id desc
        limit 100
      `;
      return rows.map(mapCredentialMetadata);
    });
  }

  public async loadDisconnectAuthority(
    tenant: TenantContext,
    connectionIdInput: string,
  ): Promise<ConnectorDisconnectAuthority> {
    const connectionId = z.uuid().parse(connectionIdInput);
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select
          id,
          provider,
          external_account_id,
          status,
          api_credential_reference,
          api_version
        from data_source_connections
        where organization_id = ${tenant.organizationId}
          and id = ${connectionId}::uuid
          and provider in ('shopify', 'stripe')
        limit 1
      `;
      const row = rows[0] ? databaseRow(rows[0]) : undefined;
      if (!row) throw new ConnectorCredentialNotFoundError();
      const reference = row["api_credential_reference"];
      const apiVersion = row["api_version"];
      return {
        connectionId,
        provider: z.enum(["shopify", "stripe"]).parse(row["provider"]),
        externalAccountId: z.string().min(1).max(255).parse(row["external_account_id"]),
        status: connectionStatusSchema.parse(row["status"]),
        ...(reference === null || reference === undefined
          ? {}
          : { apiCredentialReference: z.string().min(1).max(255).parse(reference) }),
        ...(apiVersion === null || apiVersion === undefined
          ? {}
          : { apiVersion: z.string().min(1).max(50).parse(apiVersion) }),
      };
    });
  }

  public async markProviderActionRequired(
    tenant: TenantContext,
    input: {
      readonly connectionId: string;
      readonly confirmConnectionId: string;
      readonly reason: string;
      readonly correlationId: string;
    },
  ): Promise<{
    readonly status: "provider_action_required" | "disconnected";
    readonly replayed: boolean;
  }> {
    const connectionId = z.uuid().parse(input.connectionId);
    if (connectionId !== z.uuid().parse(input.confirmConnectionId)) {
      throw new ConnectorCredentialConflictError(
        "connection confirmation does not match the disconnect target",
      );
    }
    const reason = z.string().trim().min(3).max(2000).parse(input.reason);
    const correlationId = z.uuid().parse(input.correlationId);
    const now = new Date().toISOString();
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select provider, status, api_credential_reference
        from data_source_connections
        where organization_id = ${tenant.organizationId}
          and id = ${connectionId}::uuid
          and provider = 'stripe'
        limit 1
        for update
      `;
      const connection = rows[0] ? databaseRow(rows[0]) : undefined;
      if (!connection) throw new ConnectorCredentialNotFoundError();
      const previousStatus = connectionStatusSchema.parse(connection["status"]);
      if (previousStatus === "disconnected") {
        return { status: "disconnected", replayed: true };
      }
      const replayed =
        previousStatus === "action_required" &&
        (connection["api_credential_reference"] === null ||
          connection["api_credential_reference"] === undefined);
      if (replayed) return { status: "provider_action_required", replayed: true };

      await transaction`
        update data_source_connections
        set status = 'action_required',
            api_credential_reference = null,
            cursor = null,
            updated_at = ${now}
        where organization_id = ${tenant.organizationId}
          and id = ${connectionId}::uuid
      `;
      await insertUserAuditEvent(transaction, tenant, {
        action: "connector.provider_disconnect_requested",
        resourceType: "data_source_connection",
        resourceId: connectionId,
        correlationId,
        reason,
        previousValue: {
          provider: "stripe",
          status: previousStatus,
          readAuthorityActive: connection["api_credential_reference"] !== null,
        },
        newValue: {
          provider: "stripe",
          status: "action_required",
          readAuthorityActive: false,
          providerConfirmation: "pending",
        },
        versionContext: { providerDisconnectSchemaVersion: 1 },
        occurredAt: now,
      });
      return { status: "provider_action_required", replayed: false };
    });
  }

  public async rotate(
    tenant: TenantContext,
    input: {
      readonly connectionId: string;
      readonly confirmConnectionId: string;
      readonly purpose: ConnectorCredentialPurpose;
      readonly envelope: ConnectorCredentialEnvelope;
      readonly reason: string;
      readonly correlationId: string;
    },
  ): Promise<ConnectorCredentialRotationResult> {
    const connectionId = z.uuid().parse(input.connectionId);
    const confirmConnectionId = z.uuid().parse(input.confirmConnectionId);
    const purpose = ConnectorCredentialPurposeSchema.parse(input.purpose);
    const reason = z.string().trim().min(3).max(2000).parse(input.reason);
    const correlationId = z.uuid().parse(input.correlationId);
    const envelope = ConnectorCredentialEnvelopeSchema.parse(input.envelope);
    if (connectionId !== confirmConnectionId) {
      throw new ConnectorCredentialConflictError(
        "connection confirmation does not match the credential target",
      );
    }
    if (
      envelope.organizationId !== tenant.organizationId ||
      envelope.connectionId !== connectionId ||
      envelope.purpose !== purpose
    ) {
      throw new ConnectorCredentialConflictError(
        "sealed credential context does not match the requested target",
      );
    }
    // Authenticate and decrypt before acquiring a database lock. The plaintext is neither
    // persisted nor returned from this lifecycle boundary.
    openConnectorCredential(envelope, this.keyring);
    const envelopeSha256 = connectorCredentialEnvelopeSha256(envelope);
    const credentialId = randomUUID();
    const now = new Date().toISOString();

    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const connections = await transaction`
        select id, provider, status, credential_reference, api_credential_reference
        from data_source_connections
        where organization_id = ${tenant.organizationId}
          and id = ${connectionId}::uuid
          and provider in ('shopify', 'stripe')
        limit 1
        for update
      `;
      const connection = connections[0] ? databaseRow(connections[0]) : undefined;
      if (!connection) throw new ConnectorCredentialNotFoundError();
      const provider = z.enum(["shopify", "stripe"]).parse(connection["provider"]);
      if (envelope.provider !== provider) {
        throw new ConnectorCredentialConflictError(
          "sealed credential provider does not match the connection",
        );
      }

      const replays = await transaction`
        select
          id, connection_id, purpose, status, key_version, created_by_membership_id,
          created_by_service,
          rotated_from_credential_id, superseded_at, revoked_at, created_at, updated_at
        from connector_credentials
        where organization_id = ${tenant.organizationId}
          and envelope_sha256 = ${envelopeSha256}
        limit 1
      `;
      if (replays[0]) {
        const replay = mapCredentialMetadata(replays[0]);
        const expectedReference = `sealed:${replay.id}`;
        const connectionReference =
          purpose === "webhook_signing"
            ? connection["credential_reference"]
            : connection["api_credential_reference"];
        if (
          replay.connectionId === connectionId &&
          replay.purpose === purpose &&
          replay.status === "active" &&
          connectionReference === expectedReference
        ) {
          return { credential: replay, replayed: true };
        }
        throw new ConnectorCredentialConflictError(
          "sealed credential envelope has already been retired or used for another target",
        );
      }

      const activeRows = await transaction`
        select id, key_version
        from connector_credentials
        where organization_id = ${tenant.organizationId}
          and connection_id = ${connectionId}::uuid
          and purpose = ${purpose}
          and status = 'active'
        limit 1
        for update
      `;
      const active = activeRows[0] ? databaseRow(activeRows[0]) : undefined;
      const rotatedFromCredentialId = active ? z.uuid().parse(active["id"]) : undefined;
      const previousKeyVersion = active ? z.string().parse(active["key_version"]) : undefined;
      if (rotatedFromCredentialId) {
        await transaction`
          update connector_credentials
          set status = 'superseded',
              superseded_at = ${now},
              updated_at = ${now}
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
          ${credentialId}, ${tenant.organizationId}, ${connectionId}, ${purpose},
          ${transaction.json(toJsonValue(envelope))}, ${envelope.keyVersion},
          ${envelopeSha256}, 'active', ${tenant.membershipId},
          ${rotatedFromCredentialId ?? null}, ${now}, ${now}
        )
      `;
      const credentialReference = `sealed:${credentialId}`;
      const status = connectionStatusSchema.parse(connection["status"]);
      if (purpose === "webhook_signing") {
        await transaction`
          update data_source_connections
          set credential_reference = ${credentialReference},
              encrypted_credential = null,
              credential_key_version = null,
              status = case when status = 'disconnected' then 'action_required' else status end,
              updated_at = ${now}
          where organization_id = ${tenant.organizationId}
            and id = ${connectionId}::uuid
        `;
      } else {
        await transaction`
          update data_source_connections
          set api_credential_reference = ${credentialReference},
              encrypted_credential = null,
              credential_key_version = null,
              status = case when status = 'disconnected' then 'action_required' else status end,
              updated_at = ${now}
          where organization_id = ${tenant.organizationId}
            and id = ${connectionId}::uuid
        `;
      }
      await insertUserAuditEvent(transaction, tenant, {
        action: rotatedFromCredentialId
          ? "connector_credential.rotated"
          : "connector_credential.installed",
        resourceType: "connector_credential",
        resourceId: credentialId,
        correlationId,
        reason,
        previousValue: rotatedFromCredentialId
          ? {
              connectionId,
              purpose,
              credentialId: rotatedFromCredentialId,
              keyVersion: previousKeyVersion,
              status: "active",
            }
          : undefined,
        newValue: {
          connectionId,
          provider,
          purpose,
          keyVersion: envelope.keyVersion,
          status: "active",
          connectionStatus: status === "disconnected" ? "action_required" : status,
        },
        versionContext: {
          credentialEnvelopeSchemaVersion: envelope.schemaVersion,
          algorithm: envelope.algorithm,
        },
      });
      return {
        credential: {
          id: credentialId,
          connectionId,
          purpose,
          status: "active",
          keyVersion: envelope.keyVersion,
          createdByMembershipId: tenant.membershipId,
          ...(rotatedFromCredentialId ? { rotatedFromCredentialId } : {}),
          createdAt: now,
          updatedAt: now,
        },
        replayed: false,
      };
    });
  }

  public async disconnect(
    tenant: TenantContext,
    input: {
      readonly connectionId: string;
      readonly confirmConnectionId: string;
      readonly reason: string;
      readonly correlationId: string;
    },
  ): Promise<{
    readonly connectionId: string;
    readonly status: "disconnected";
    readonly revoked: number;
  }> {
    const connectionId = z.uuid().parse(input.connectionId);
    if (connectionId !== z.uuid().parse(input.confirmConnectionId)) {
      throw new ConnectorCredentialConflictError(
        "connection confirmation does not match the disconnect target",
      );
    }
    const reason = z.string().trim().min(3).max(2000).parse(input.reason);
    const correlationId = z.uuid().parse(input.correlationId);
    const now = new Date().toISOString();
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const connections = await transaction`
        select id, provider, status
        from data_source_connections
        where organization_id = ${tenant.organizationId}
          and id = ${connectionId}::uuid
        limit 1
        for update
      `;
      const connection = connections[0] ? databaseRow(connections[0]) : undefined;
      if (!connection) throw new ConnectorCredentialNotFoundError();
      const revokedRows = await transaction`
        update connector_credentials
        set status = 'revoked',
            revoked_at = ${now},
            updated_at = ${now}
        where organization_id = ${tenant.organizationId}
          and connection_id = ${connectionId}::uuid
          and status = 'active'
        returning id
      `;
      await transaction`
        update data_source_connections
        set status = 'disconnected',
            credential_reference = null,
            api_credential_reference = null,
            encrypted_credential = null,
            credential_key_version = null,
            cursor = null,
            updated_at = ${now}
        where organization_id = ${tenant.organizationId}
          and id = ${connectionId}::uuid
      `;
      await insertUserAuditEvent(transaction, tenant, {
        action: "connector.disconnected",
        resourceType: "data_source_connection",
        resourceId: connectionId,
        correlationId,
        reason,
        previousValue: {
          provider: z.string().parse(connection["provider"]),
          status: connectionStatusSchema.parse(connection["status"]),
          activeCredentialCount: revokedRows.length,
        },
        newValue: {
          status: "disconnected",
          revokedCredentialCount: revokedRows.length,
        },
        versionContext: { credentialEnvelopeSchemaVersion: 1 },
      });
      return { connectionId, status: "disconnected", revoked: revokedRows.length };
    });
  }

  public async resolve(requestInput: ConnectorSecretRequest): Promise<string> {
    const request = connectorSecretRequestSchema.parse(requestInput);
    if (request.reference.startsWith("env:")) {
      return this.environmentSecrets.resolve(request);
    }
    const match = sealedReferenceSchema.safeParse(request.reference);
    const credentialId = match.success ? /^sealed:(.+)$/u.exec(match.data)?.[1] : undefined;
    if (!credentialId) {
      throw new ConnectorError("authentication", "sealed connector credential is unavailable");
    }
    const secret = await withOrganizationTransaction(
      this.sql,
      request.organizationId,
      async (transaction) => {
        const rows = await transaction`
        select credentials.encrypted_envelope
        from connector_credentials as credentials
        join data_source_connections as connections
          on connections.organization_id = credentials.organization_id
         and connections.id = credentials.connection_id
        where credentials.organization_id = ${request.organizationId}
          and credentials.connection_id = ${request.connectionId}::uuid
          and credentials.purpose = ${request.purpose}
          and credentials.status = 'active'
          and connections.provider = ${request.provider}
          and (
            (
              credentials.purpose = 'webhook_signing'
              and credentials.id = ${credentialId}::uuid
              and connections.credential_reference = ${request.reference}
            )
            or
            (
              credentials.purpose = 'api_read'
              and connections.api_credential_reference = 'sealed:' || credentials.id::text
              and (
                credentials.id = ${credentialId}::uuid
                or (
                  credentials.created_by_service = 'provider-token-refresh-v1'
                  and credentials.rotated_from_credential_id = ${credentialId}::uuid
                )
              )
            )
          )
        limit 1
      `;
        const row = rows[0] ? databaseRow(rows[0]) : undefined;
        if (!row) {
          throw new ConnectorError("authentication", "sealed connector credential is unavailable");
        }
        const envelope = ConnectorCredentialEnvelopeSchema.parse(row["encrypted_envelope"]);
        if (
          envelope.organizationId !== request.organizationId ||
          envelope.connectionId !== request.connectionId ||
          envelope.provider !== request.provider ||
          envelope.purpose !== request.purpose
        ) {
          throw new ConnectorError("authentication", "sealed credential context is invalid");
        }
        return openConnectorCredential(envelope, this.keyring);
      },
    );
    if (request.purpose !== "api_read") return secret;
    const bundle = parseOAuthBundleIfPresent(secret);
    if (!bundle) return secret;
    if (this.isAccessTokenFresh(bundle)) return bundle.accessToken;
    return this.refreshOAuthCredential(request);
  }

  private isAccessTokenFresh(bundle: ProviderOAuthTokenBundle): boolean {
    const now = (this.options.now ?? (() => new Date()))().getTime();
    const leeway = z
      .number()
      .int()
      .min(30_000)
      .max(15 * 60 * 1000)
      .parse(this.options.refreshLeewayMs ?? 5 * 60 * 1000);
    return Date.parse(bundle.accessTokenExpiresAt) - now > leeway;
  }

  private async refreshOAuthCredential(request: z.infer<typeof connectorSecretRequestSchema>) {
    const newCredentialId = randomUUID();
    return withOrganizationTransaction(this.sql, request.organizationId, async (transaction) => {
      const lockedRows = await transaction`
          select *
          from reconai_lock_oauth_credential(
            ${request.organizationId}::uuid,
            ${request.connectionId}::uuid,
            ${request.provider},
            ${request.reference}
          )
        `;
      const locked = lockedRows[0] ? databaseRow(lockedRows[0]) : undefined;
      if (!locked) {
        throw new ConnectorError("authentication", "sealed connector credential is unavailable");
      }
      const credentialId = z.uuid().parse(locked["credential_id"]);
      const envelope = ConnectorCredentialEnvelopeSchema.parse(locked["encrypted_envelope"]);
      if (
        envelope.organizationId !== request.organizationId ||
        envelope.connectionId !== request.connectionId ||
        envelope.provider !== request.provider ||
        envelope.purpose !== "api_read"
      ) {
        throw new ConnectorError("authentication", "sealed credential context is invalid");
      }
      const bundle = parseProviderOAuthTokenBundle(openConnectorCredential(envelope, this.keyring));
      if (
        bundle.provider !== request.provider ||
        bundle.externalAccountId !== z.string().min(1).max(255).parse(locked["external_account_id"])
      ) {
        throw new ConnectorError(
          "authentication",
          "provider OAuth credential authority is invalid",
        );
      }
      if (this.isAccessTokenFresh(bundle)) return bundle.accessToken;

      const refreshed = await this.refreshProviderBundle(bundle);
      if (
        refreshed.provider !== bundle.provider ||
        refreshed.externalAccountId !== bundle.externalAccountId ||
        !sameScopeSet(refreshed.scopes, bundle.scopes) ||
        (bundle.provider === "stripe" &&
          refreshed.provider === "stripe" &&
          refreshed.livemode !== bundle.livemode)
      ) {
        throw new ConnectorError(
          "authentication",
          "provider OAuth refresh changed account authority",
        );
      }
      const serialized = serializeProviderOAuthTokenBundle(refreshed);
      const nextEnvelope = sealConnectorCredential(
        {
          organizationId: request.organizationId,
          connectionId: request.connectionId,
          provider: request.provider,
          purpose: "api_read",
          secret: serialized,
        },
        this.keyring,
      );
      const envelopeSha256 = connectorCredentialEnvelopeSha256(nextEnvelope);
      const rotatedAt = (this.options.now ?? (() => new Date()))().toISOString();
      const rotated = await transaction`
          select reconai_rotate_oauth_credential(
            ${request.organizationId}::uuid,
            ${request.connectionId}::uuid,
            ${request.provider},
            ${credentialId}::uuid,
            ${newCredentialId}::uuid,
            ${transaction.json(toJsonValue(nextEnvelope))}::jsonb,
            ${nextEnvelope.keyVersion},
            ${envelopeSha256},
            ${rotatedAt}::timestamptz
          ) as credential_id
        `;
      if (!rotated[0] || z.uuid().parse(rotated[0]["credential_id"]) !== newCredentialId) {
        throw new ConnectorError(
          "provider_unavailable",
          "provider OAuth credential rotation could not be persisted",
        );
      }
      await insertTenantAuditEvent(transaction, {
        organizationId: request.organizationId,
        actorType: "worker",
        actorId: "provider-token-refresh-v1",
        action: "connector_credential.oauth_refreshed",
        resourceType: "connector_credential",
        resourceId: newCredentialId,
        correlationId: randomUUID(),
        reason: "Expiring provider access token refreshed before read API use",
        previousValue: {
          connectionId: request.connectionId,
          provider: request.provider,
          credentialId,
          keyVersion: envelope.keyVersion,
          accessTokenExpiresAt: bundle.accessTokenExpiresAt,
          refreshTokenExpiresAt: bundle.refreshTokenExpiresAt,
        },
        newValue: {
          connectionId: request.connectionId,
          provider: request.provider,
          credentialId: newCredentialId,
          keyVersion: nextEnvelope.keyVersion,
          accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
          refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
          scopes: refreshed.scopes,
        },
        versionContext: {
          credentialEnvelopeSchemaVersion: nextEnvelope.schemaVersion,
          tokenBundleSchemaVersion: refreshed.schemaVersion,
          refreshService: "provider-token-refresh-v1",
        },
        occurredAt: rotatedAt,
      });
      return refreshed.accessToken;
    });
  }

  private async refreshProviderBundle(
    bundle: ProviderOAuthTokenBundle,
  ): Promise<ProviderOAuthTokenBundle> {
    if (bundle.provider === "shopify") {
      const refresher = this.options.oauthRefreshers?.shopify;
      if (!refresher) {
        throw new ConnectorError("authentication", "Shopify OAuth refresh is not configured");
      }
      return refresher.refresh(bundle);
    }
    const refresher = this.options.oauthRefreshers?.stripe;
    if (!refresher) {
      throw new ConnectorError("authentication", "Stripe OAuth refresh is not configured");
    }
    return refresher.refresh(bundle);
  }
}

const connectorSecretRequestSchema = z
  .object({
    reference: z.string().min(1).max(255),
    organizationId: OrganizationIdSchema,
    connectionId: z.uuid(),
    provider: z.enum(["shopify", "stripe"]),
    purpose: ConnectorCredentialPurposeSchema,
  })
  .strict();

function mapCredentialMetadata(value: unknown): ConnectorCredentialMetadata {
  const row = databaseRow(value);
  return {
    id: z.uuid().parse(row["id"]),
    connectionId: z.uuid().parse(row["connection_id"]),
    purpose: ConnectorCredentialPurposeSchema.parse(row["purpose"]),
    status: credentialStatusSchema.parse(row["status"]),
    keyVersion: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,31}$/u)
      .parse(row["key_version"]),
    ...(row["created_by_membership_id"]
      ? { createdByMembershipId: z.uuid().parse(row["created_by_membership_id"]) }
      : {}),
    ...(row["created_by_service"]
      ? {
          createdByService: z
            .string()
            .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/u)
            .parse(row["created_by_service"]),
        }
      : {}),
    ...(row["rotated_from_credential_id"]
      ? { rotatedFromCredentialId: z.uuid().parse(row["rotated_from_credential_id"]) }
      : {}),
    ...(row["superseded_at"]
      ? { supersededAt: databaseTimestamp(row["superseded_at"], "credential.superseded_at") }
      : {}),
    ...(row["revoked_at"]
      ? { revokedAt: databaseTimestamp(row["revoked_at"], "credential.revoked_at") }
      : {}),
    createdAt: databaseTimestamp(row["created_at"], "credential.created_at"),
    updatedAt: databaseTimestamp(row["updated_at"], "credential.updated_at"),
  };
}

async function withOrganizationTransaction<T>(
  sql: Sql,
  organizationId: string,
  operation: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  const parsedOrganizationId = OrganizationIdSchema.parse(organizationId);
  return sql.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${parsedOrganizationId}, true)`;
    return operation(transaction);
  }) as Promise<T>;
}

async function withTenantTransaction<T>(
  sql: Sql,
  tenant: TenantContext,
  operation: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return withOrganizationTransaction(sql, tenant.organizationId, operation);
}

function databaseRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("database returned an invalid connector credential row");
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

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

function parseOAuthBundleIfPresent(value: string): ProviderOAuthTokenBundle | undefined {
  if (!value.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>)["credentialType"] !== "oauth_refreshable"
  ) {
    return undefined;
  }
  return parseProviderOAuthTokenBundle(value);
}

function sameScopeSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((scope) => expected.has(scope));
}
