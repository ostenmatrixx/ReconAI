import { randomUUID } from "node:crypto";

import {
  ConnectorCredentialEnvelopeSchema,
  openConnectorCredential,
  parseProviderOAuthTokenBundle,
  type ConnectorCredentialKeyring,
} from "@workspace/connectors";
import {
  ProviderWebhookConflictError,
  type StripeAppDeauthorizationRecord,
  type StripeAppDeauthorizationRepository,
} from "@workspace/ingestion";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { insertTenantAuditEvent } from "./audit.js";

const accountSchema = z.string().regex(/^acct_[A-Za-z0-9]{1,250}$/u);
const eventIdSchema = z.string().regex(/^evt_[A-Za-z0-9]{1,250}$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

/**
 * Resolves the globally unique Stripe account through a narrowly granted function, then performs
 * all credential revocation and evidence writes under that connection's PostgreSQL tenant context.
 */
export class PostgresStripeAppDeauthorizationRepository implements StripeAppDeauthorizationRepository {
  public constructor(
    private readonly sql: Sql,
    private readonly keyring: ConnectorCredentialKeyring,
  ) {}

  public async finalizeStripeDeauthorization(
    recordInput: StripeAppDeauthorizationRecord,
  ): Promise<{ readonly matched: boolean; readonly duplicate: boolean }> {
    const record = parseRecord(recordInput);
    const resolved = await this.sql`
      select organization_id, connection_id
      from reconai_resolve_stripe_deauthorization(${record.externalAccountId})
    `;
    const authority = resolved[0] ? databaseRow(resolved[0]) : undefined;
    if (!authority) return { matched: false, duplicate: false };
    const organizationId = z.uuid().parse(authority["organization_id"]);
    const connectionId = z.uuid().parse(authority["connection_id"]);

    return withOrganizationTransaction(this.sql, organizationId, async (transaction) => {
      const existing = await transaction`
        select *
        from provider_deauthorization_events
        where organization_id = ${organizationId}
          and provider = 'stripe'
          and external_event_id = ${record.externalEventId}
        limit 1
      `;
      if (existing[0]) {
        assertSameEvent(databaseRow(existing[0]), record, connectionId);
        return { matched: true, duplicate: true };
      }

      const connections = await transaction`
        select
          connections.id,
          connections.external_account_id,
          connections.status,
          credentials.encrypted_envelope
        from data_source_connections as connections
        left join connector_credentials as credentials
          on credentials.organization_id = connections.organization_id
         and credentials.connection_id = connections.id
         and credentials.purpose = 'api_read'
         and credentials.status = 'active'
        where connections.organization_id = ${organizationId}
          and connections.id = ${connectionId}::uuid
          and connections.provider = 'stripe'
          and connections.external_account_id = ${record.externalAccountId}
        limit 1
        for update of connections
      `;
      const connection = connections[0] ? databaseRow(connections[0]) : undefined;
      if (!connection?.["encrypted_envelope"]) {
        return { matched: false, duplicate: false };
      }
      const envelope = ConnectorCredentialEnvelopeSchema.parse(connection["encrypted_envelope"]);
      const bundle = parseProviderOAuthTokenBundle(openConnectorCredential(envelope, this.keyring));
      if (
        bundle.provider !== "stripe" ||
        bundle.externalAccountId !== record.externalAccountId ||
        bundle.livemode !== record.livemode ||
        Date.parse(record.occurredAt) < Date.parse(bundle.authorizationGrantedAt)
      ) {
        return { matched: false, duplicate: false };
      }

      const eventId = randomUUID();
      await transaction`
        insert into provider_deauthorization_events (
          id,
          organization_id,
          connection_id,
          provider,
          external_event_id,
          external_account_id,
          payload_sha256,
          livemode,
          occurred_at,
          received_at
        ) values (
          ${eventId}::uuid,
          ${organizationId}::uuid,
          ${connectionId}::uuid,
          'stripe',
          ${record.externalEventId},
          ${record.externalAccountId},
          ${record.payloadSha256},
          ${record.livemode},
          ${record.occurredAt}::timestamptz,
          ${record.receivedAt}::timestamptz
        )
      `;
      const revoked = await transaction`
        update connector_credentials
        set status = 'revoked',
            revoked_at = ${record.receivedAt}::timestamptz,
            updated_at = ${record.receivedAt}::timestamptz
        where organization_id = ${organizationId}
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
            updated_at = ${record.receivedAt}::timestamptz
        where organization_id = ${organizationId}
          and id = ${connectionId}::uuid
      `;
      await insertTenantAuditEvent(transaction, {
        organizationId,
        actorType: "system",
        actorId: "stripe-app-deauthorization-v1",
        action: "connector.provider_deauthorization_confirmed",
        resourceType: "data_source_connection",
        resourceId: connectionId,
        correlationId: record.correlationId,
        reason: "Authenticated Stripe app uninstall event confirmed provider revocation",
        previousValue: {
          provider: "stripe",
          status: z.string().min(1).max(100).parse(connection["status"]),
          externalAccountId: record.externalAccountId,
          activeCredentialCount: revoked.length,
        },
        newValue: {
          status: "disconnected",
          revokedCredentialCount: revoked.length,
          externalEventId: record.externalEventId,
          payloadSha256: record.payloadSha256,
          livemode: record.livemode,
        },
        versionContext: {
          deauthorizationEventSchemaVersion: 1,
          credentialEnvelopeSchemaVersion: envelope.schemaVersion,
          tokenBundleSchemaVersion: bundle.schemaVersion,
        },
        occurredAt: record.receivedAt,
      });
      return { matched: true, duplicate: false };
    });
  }
}

function parseRecord(input: StripeAppDeauthorizationRecord): StripeAppDeauthorizationRecord {
  return {
    externalEventId: eventIdSchema.parse(input.externalEventId),
    externalAccountId: accountSchema.parse(input.externalAccountId),
    payloadSha256: sha256Schema.parse(input.payloadSha256),
    livemode: z.boolean().parse(input.livemode),
    occurredAt: z.iso.datetime({ offset: true }).parse(input.occurredAt),
    receivedAt: z.iso.datetime({ offset: true }).parse(input.receivedAt),
    correlationId: z.uuid().parse(input.correlationId),
  };
}

function assertSameEvent(
  row: Readonly<Record<string, unknown>>,
  expected: StripeAppDeauthorizationRecord,
  connectionId: string,
): void {
  if (
    row["connection_id"] !== connectionId ||
    row["external_account_id"] !== expected.externalAccountId ||
    row["payload_sha256"] !== expected.payloadSha256 ||
    row["livemode"] !== expected.livemode ||
    databaseTimestamp(row["occurred_at"]) !== expected.occurredAt
  ) {
    throw new ProviderWebhookConflictError();
  }
}

async function withOrganizationTransaction<T>(
  sql: Sql,
  organizationId: string,
  operation: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
    return operation(transaction);
  }) as Promise<T>;
}

function databaseTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return z.iso.datetime({ offset: true }).parse(value);
}

function databaseRow(value: unknown): Readonly<Record<string, unknown>> {
  return z.record(z.string(), z.unknown()).parse(value);
}
