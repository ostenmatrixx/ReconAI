import { createHash, randomUUID } from "node:crypto";

import {
  ConnectorJobEnvelopeSchema,
  SourceObjectFamilySchema,
  type SourceObjectFamily,
} from "@workspace/connectors";
import {
  OrganizationIdSchema,
  serializeCanonicalRecord,
  type CanonicalRecord,
  type OrganizationId,
} from "@workspace/domain";
import {
  providerMetadata,
  type ProviderName,
  type ProviderWebhookAuthority,
  type ProviderWebhookJobEnvelope,
  type ProviderWebhookReceipt,
  type ProviderWebhookRepository,
} from "@workspace/ingestion";
import type { JSONValue, Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { insertTenantAuditEvent } from "./audit.js";
import { insertCanonicalFieldProvenance } from "./canonical-provenance.js";

const providerSchema = z.enum(["shopify", "stripe"]);
const processableConnectionStatusSchema = z.enum([
  "healthy",
  "backfilling",
  "degraded",
  "action_required",
]);
const receiptStatusSchema = z.enum(["received", "processed", "failed", "privacy_pending"]);
const sourceObjectFamiliesSchema = z
  .array(SourceObjectFamilySchema)
  .min(1)
  .max(3)
  .refine((families) => new Set(families).size === families.length, {
    message: "source object families must be unique",
  });

export class PostgresProviderWebhookRepository implements ProviderWebhookRepository {
  public constructor(private readonly sql: Sql) {}

  public async loadIngressAuthority(
    organizationId: OrganizationId,
    connectionId: string,
    provider: ProviderName,
  ): Promise<ProviderWebhookAuthority | undefined> {
    return withOrganizationTransaction(this.sql, organizationId, async (transaction) => {
      const rows = await transaction`
        select
          organization_id, id, provider, status, api_version, credential_reference
        from data_source_connections
        where organization_id = ${organizationId}
          and id = ${connectionId}::uuid
          and provider = ${provider}
          and status in ('healthy', 'backfilling', 'degraded', 'action_required')
          and credential_reference is not null
        limit 1
      `;
      return rows[0] ? mapAuthority(rows[0]) : undefined;
    });
  }

  public async loadExistingReceipt(
    organizationId: OrganizationId,
    connectionId: string,
    provider: ProviderName,
    externalEventId: string,
  ): Promise<ProviderWebhookReceipt | undefined> {
    return withOrganizationTransaction(this.sql, organizationId, async (transaction) => {
      const rows = await transaction`
        select *
        from source_events
        where organization_id = ${organizationId}
          and connection_id = ${connectionId}::uuid
          and source = ${provider}
          and external_event_id = ${externalEventId}
        limit 1
      `;
      return rows[0] ? mapReceipt(rows[0]) : undefined;
    });
  }

  public async saveReceiptAndOutbox(
    receipt: ProviderWebhookReceipt,
    envelope: ProviderWebhookJobEnvelope,
    objectFamiliesInput: readonly SourceObjectFamily[],
  ): Promise<{
    readonly receipt: ProviderWebhookReceipt;
    readonly envelope: ProviderWebhookJobEnvelope;
    readonly inserted: boolean;
  }> {
    return withOrganizationTransaction(this.sql, receipt.organizationId, async (transaction) => {
      const objectFamilies = parseProviderObjectFamilies(receipt.provider, objectFamiliesInput);
      const authority = await requireActiveAuthority(
        transaction,
        receipt.organizationId,
        receipt.connectionId,
        receipt.provider,
      );
      const metadata = providerMetadata(receipt.provider);
      const inserted = await transaction`
        insert into source_events (
          id, organization_id, connection_id, source, external_event_id, external_object_type,
          external_object_id, source_timestamp, received_at, connector_version, api_version,
          payload_object_key, payload_sha256, status
        ) values (
          ${receipt.sourceEventId}, ${receipt.organizationId}, ${receipt.connectionId},
          ${receipt.provider}, ${receipt.externalEventId}, ${receipt.eventType},
          ${receipt.externalObjectId}, ${receipt.sourceTimestamp}, ${receipt.receivedAt},
          ${metadata.connectorVersion}, ${receipt.apiVersion ?? authority.apiVersion ?? null},
          ${receipt.objectKey},
          ${receipt.payloadSha256}, 'received'
        )
        on conflict (organization_id, connection_id, source, external_event_id) do nothing
        returning *
      `;
      const persisted =
        inserted[0] ??
        (
          await transaction`
            select *
            from source_events
            where organization_id = ${receipt.organizationId}
              and connection_id = ${receipt.connectionId}::uuid
              and source = ${receipt.provider}
              and external_event_id = ${receipt.externalEventId}
            limit 1
          `
        )[0];
      if (!persisted) throw new Error("provider webhook receipt could not be persisted");

      const insertedClassification = await transaction`
        insert into source_event_object_classifications (
          organization_id, source_event_id, object_families, classifier_version
        ) values (
          ${receipt.organizationId}, ${receipt.sourceEventId}::uuid, ${objectFamilies}::text[],
          'source-object-family-v1'
        )
        on conflict (organization_id, source_event_id) do nothing
        returning object_families
      `;
      const persistedClassification =
        insertedClassification[0] ??
        (
          await transaction`
            select object_families
            from source_event_object_classifications
            where organization_id = ${receipt.organizationId}
              and source_event_id = ${receipt.sourceEventId}::uuid
            limit 1
          `
        )[0];
      if (!persistedClassification) {
        throw new Error("provider source-object classification could not be persisted");
      }
      const persistedFamilies = sourceObjectFamiliesSchema.parse(
        databaseRow(persistedClassification)["object_families"],
      );
      if (
        persistedFamilies.length !== objectFamilies.length ||
        persistedFamilies.some((family, index) => family !== objectFamilies[index])
      ) {
        throw new Error("provider source-object classification conflicts with immutable evidence");
      }

      const existingOutbox = await transaction`
        select payload
        from outbox_events
        where organization_id = ${receipt.organizationId}
          and idempotency_key = ${envelope.idempotencyKey}
        limit 1
      `;
      let durableEnvelope = envelope;
      if (existingOutbox[0]) {
        durableEnvelope = parseProviderEnvelope(existingOutbox[0]["payload"]);
      } else {
        await transaction`
          insert into outbox_events (
            id, organization_id, event_type, schema_version, idempotency_key,
            payload, correlation_id, execution_tracking_version
          ) values (
            ${randomUUID()}, ${receipt.organizationId}, ${envelope.type},
            ${envelope.schemaVersion}, ${envelope.idempotencyKey},
            ${transaction.json(toJsonValue(envelope))}, ${envelope.correlationId}, 1
          )
        `;
      }
      await transaction`
        update data_source_connections
        set last_verified_webhook_at = greatest(
              coalesce(last_verified_webhook_at, ${receipt.receivedAt}),
              ${receipt.receivedAt}
            ),
            updated_at = now()
        where organization_id = ${receipt.organizationId}
          and id = ${receipt.connectionId}::uuid
      `;
      if (inserted.length > 0) {
        await insertTenantAuditEvent(transaction, {
          organizationId: receipt.organizationId,
          actorType: "system",
          actorId: `${receipt.provider}-webhook-ingress`,
          action: "provider_webhook.received",
          resourceType: "source_event",
          resourceId: receipt.sourceEventId,
          correlationId: envelope.correlationId,
          reason: "Authenticated provider webhook stored and durably queued",
          newValue: {
            provider: receipt.provider,
            eventType: receipt.eventType,
            status: "received",
            payloadSha256: receipt.payloadSha256,
          },
          versionContext: {
            connectorVersion: metadata.connectorVersion,
            normalizerVersion: metadata.normalizerVersion,
            apiVersion: authority.apiVersion,
          },
          occurredAt: receipt.receivedAt,
        });
      }
      return {
        receipt: mapReceipt(persisted),
        envelope: durableEnvelope,
        inserted: inserted.length > 0,
      };
    });
  }

  public async markOutboxPublished(
    organizationId: OrganizationId,
    idempotencyKey: string,
    publishedAt: string,
  ): Promise<void> {
    await withOrganizationTransaction(this.sql, organizationId, async (transaction) => {
      await transaction`
        update outbox_events
        set published_at = coalesce(published_at, ${publishedAt}),
            attempts = attempts + 1,
            last_error_code = null
        where organization_id = ${organizationId}
          and idempotency_key = ${idempotencyKey}
          and published_at is null
          and dead_lettered_at is null
      `;
    });
  }

  public async loadForProcessing(
    envelope: ProviderWebhookJobEnvelope,
  ): Promise<ProviderWebhookReceipt | undefined> {
    return withOrganizationTransaction(this.sql, envelope.organizationId, async (transaction) => {
      const rows = await transaction`
        select *
        from source_events
        where organization_id = ${envelope.organizationId}
          and connection_id = ${envelope.connectionId}::uuid
          and source = ${envelope.provider}
          and external_event_id = ${envelope.externalEventId}
        limit 1
      `;
      return rows[0] ? mapReceipt(rows[0]) : undefined;
    });
  }

  public async completeWebhook(
    envelope: ProviderWebhookJobEnvelope,
    records: readonly CanonicalRecord[],
    completedAt: string,
  ): Promise<"processed" | "already_processed"> {
    return withOrganizationTransaction(this.sql, envelope.organizationId, async (transaction) => {
      await transaction`
        select pg_advisory_xact_lock(hashtextextended(${envelope.organizationId}, 2))
      `;
      const locked = await transaction`
        select *
        from source_events
        where organization_id = ${envelope.organizationId}
          and connection_id = ${envelope.connectionId}::uuid
          and source = ${envelope.provider}
          and external_event_id = ${envelope.externalEventId}
        limit 1
        for update
      `;
      const source = locked[0] ? mapReceipt(locked[0]) : undefined;
      if (!source) throw new Error("provider webhook receipt disappeared");
      if (source.status === "processed" || source.status === "privacy_pending") {
        return "already_processed";
      }

      const isPrivacyRequest =
        source.provider === "shopify" &&
        ["customers/data_request", "customers/redact", "shop/redact"].includes(source.eventType);
      if (isPrivacyRequest) {
        await transaction`
          update source_events
          set status = 'privacy_pending', last_error_code = null
          where organization_id = ${source.organizationId}
            and id = ${source.sourceEventId}::uuid
        `;
        await transaction`
          update data_source_connections
          set status = 'action_required', updated_at = now()
          where organization_id = ${source.organizationId}
            and id = ${source.connectionId}::uuid
        `;
      } else {
        for (const record of records) {
          assertRecordAuthority(source, record);
          const latest = await transaction`
            select coalesce(max(version), 0)::integer as version
            from canonical_records
            where organization_id = ${source.organizationId}
              and id = ${record.id}::uuid
          `;
          const version = Number(latest[0]?.["version"] ?? 0) + 1;
          if (!Number.isSafeInteger(version) || version < 1) {
            throw new Error("canonical record version overflow");
          }
          const versioned = { ...record, version } as CanonicalRecord;
          const serialized = serializeCanonicalRecord(versioned);
          const contentSha256 = createHash("sha256")
            .update(stableStringify(serialized))
            .digest("hex");
          await transaction`
            insert into canonical_records (
              id, organization_id, version, kind, source_event_id, source,
              external_object_type, external_object_id, source_timestamp,
              ingestion_timestamp, effective_at, connector_version, normalizer_version,
              amount_minor, currency, order_reference, customer_reference, normalized_data,
              content_sha256, is_incomplete
            ) values (
              ${versioned.id}, ${source.organizationId}, ${versioned.version}, ${versioned.kind},
              ${versioned.provenance.sourceEventId}, ${versioned.provenance.sourceSystem},
              ${versioned.provenance.externalObjectType},
              ${versioned.provenance.externalObjectId}, ${versioned.provenance.sourceTimestamp},
              ${versioned.provenance.ingestionTimestamp}, ${versioned.effectiveAt},
              ${versioned.provenance.connectorVersion},
              ${versioned.provenance.normalizerVersion}, ${versioned.amount.minor.toString()},
              ${versioned.amount.currency}, ${versioned.orderReference ?? null},
              ${versioned.customerReference ?? null},
              ${transaction.json(toJsonValue(serialized))}, ${contentSha256},
              ${(versioned.incompleteReasons?.length ?? 0) > 0}
            )
          `;
          await insertCanonicalFieldProvenance(transaction, [versioned]);
        }
        await transaction`
          update source_events
          set status = 'processed', last_error_code = null
          where organization_id = ${source.organizationId}
            and id = ${source.sourceEventId}::uuid
        `;
        await transaction`
          update data_source_connections
          set status = case when status = 'action_required' then status else 'healthy' end,
              last_successful_sync_at = greatest(
                coalesce(last_successful_sync_at, ${completedAt}),
                ${completedAt}
              ),
              updated_at = now()
          where organization_id = ${source.organizationId}
            and id = ${source.connectionId}::uuid
        `;
      }

      const metadata = providerMetadata(source.provider);
      await insertTenantAuditEvent(transaction, {
        organizationId: source.organizationId,
        actorType: "worker",
        actorId: `${source.provider}-webhook-worker`,
        action: isPrivacyRequest
          ? "provider_privacy_request.received"
          : "provider_webhook.completed",
        resourceType: "source_event",
        resourceId: source.sourceEventId,
        correlationId: envelope.correlationId,
        reason: isPrivacyRequest
          ? "Authenticated provider privacy request requires controlled operator handling"
          : "Durable provider webhook normalization completed",
        newValue: {
          status: isPrivacyRequest ? "privacy_pending" : "processed",
          canonicalRecordCount: records.length,
          eventType: source.eventType,
        },
        versionContext: {
          connectorVersion: metadata.connectorVersion,
          normalizerVersion: metadata.normalizerVersion,
        },
        occurredAt: completedAt,
      });
      return "processed";
    });
  }

  public async markWebhookFailed(
    envelope: ProviderWebhookJobEnvelope,
    errorCode: string,
    failedAt: string,
  ): Promise<void> {
    await withOrganizationTransaction(this.sql, envelope.organizationId, async (transaction) => {
      const updated = await transaction`
        update source_events
        set status = 'failed', last_error_code = ${errorCode}
        where organization_id = ${envelope.organizationId}
          and connection_id = ${envelope.connectionId}::uuid
          and source = ${envelope.provider}
          and external_event_id = ${envelope.externalEventId}
          and status not in ('processed', 'privacy_pending')
          and (status <> 'failed' or last_error_code is distinct from ${errorCode})
        returning id
      `;
      if (updated.length > 0) {
        const metadata = providerMetadata(envelope.provider);
        await insertTenantAuditEvent(transaction, {
          organizationId: envelope.organizationId,
          actorType: "worker",
          actorId: `${envelope.provider}-webhook-worker`,
          action: "provider_webhook.failed",
          resourceType: "source_event",
          resourceId: databaseString(updated[0]?.["id"], "source_events.id"),
          correlationId: envelope.correlationId,
          reason: errorCode,
          newValue: { status: "failed", errorCode, eventType: envelope.eventType },
          versionContext: {
            connectorVersion: metadata.connectorVersion,
            normalizerVersion: metadata.normalizerVersion,
          },
          occurredAt: failedAt,
        });
      }
    });
  }
}

async function requireActiveAuthority(
  transaction: TransactionSql,
  organizationId: OrganizationId,
  connectionId: string,
  provider: ProviderName,
): Promise<ProviderWebhookAuthority> {
  const rows = await transaction`
    select organization_id, id, provider, status, api_version, credential_reference
    from data_source_connections
    where organization_id = ${organizationId}
      and id = ${connectionId}::uuid
      and provider = ${provider}
      and status in ('healthy', 'backfilling', 'degraded', 'action_required')
      and credential_reference is not null
    limit 1
    for update
  `;
  if (!rows[0]) throw new Error("provider connection is no longer active");
  return mapAuthority(rows[0]);
}

function mapAuthority(value: unknown): ProviderWebhookAuthority {
  const row = databaseRow(value);
  return {
    organizationId: OrganizationIdSchema.parse(row["organization_id"]),
    connectionId: z.uuid().parse(row["id"]),
    provider: providerSchema.parse(row["provider"]),
    status: processableConnectionStatusSchema.parse(row["status"]),
    signingSecretReference: z
      .string()
      .regex(
        /^(?:env:RECONAI_CONNECTOR_[A-Z0-9_]{1,100}|sealed:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u,
      )
      .parse(row["credential_reference"]),
    ...(row["api_version"]
      ? { apiVersion: databaseString(row["api_version"], "connection.api_version") }
      : {}),
  };
}

function parseProviderObjectFamilies(
  provider: ProviderName,
  value: readonly SourceObjectFamily[],
): readonly SourceObjectFamily[] {
  const families = sourceObjectFamiliesSchema.parse(value);
  const providerShapeMatches =
    provider === "shopify"
      ? (families.length === 1 &&
          (families[0] === "order" || families[0] === "refund_transaction")) ||
        (families.length === 2 && families[0] === "order" && families[1] === "refund_transaction")
      : families.length === 1 &&
        (families[0] === "payment_intent" ||
          families[0] === "refund" ||
          families[0] === "balance_transaction");
  if (!providerShapeMatches) {
    throw new Error("provider source-object classification does not match its provider");
  }
  return families;
}

function mapReceipt(value: unknown): ProviderWebhookReceipt {
  const row = databaseRow(value);
  return {
    sourceEventId: z.uuid().parse(row["id"]),
    organizationId: OrganizationIdSchema.parse(row["organization_id"]),
    connectionId: z.uuid().parse(row["connection_id"]),
    provider: providerSchema.parse(row["source"]),
    eventType: z.string().min(1).max(100).parse(row["external_object_type"]),
    externalEventId: z.string().min(1).max(255).parse(row["external_event_id"]),
    externalObjectId: z.string().min(1).max(255).parse(row["external_object_id"]),
    sourceTimestamp: databaseTimestamp(row["source_timestamp"], "source_events.source_timestamp"),
    receivedAt: databaseTimestamp(row["received_at"], "source_events.received_at"),
    objectKey: databaseString(row["payload_object_key"], "source_events.payload_object_key"),
    payloadSha256: databaseString(row["payload_sha256"], "source_events.payload_sha256").trim(),
    ...(row["api_version"]
      ? { apiVersion: databaseString(row["api_version"], "source_events.api_version") }
      : {}),
    status: receiptStatusSchema.parse(row["status"]),
  };
}

function parseProviderEnvelope(value: unknown): ProviderWebhookJobEnvelope {
  const envelope = ConnectorJobEnvelopeSchema.parse(value);
  if (envelope.type !== "connector.webhook.received") {
    throw new Error("outbox payload is not a provider webhook envelope");
  }
  return envelope;
}

function assertRecordAuthority(source: ProviderWebhookReceipt, record: CanonicalRecord): void {
  if (
    record.organizationId !== source.organizationId ||
    record.provenance.sourceSystem !== source.provider ||
    record.provenance.sourceEventId !== source.sourceEventId
  ) {
    throw new Error("normalized provider record does not match its source authority");
  }
}

async function withOrganizationTransaction<T>(
  sql: Sql,
  organizationId: OrganizationId,
  operation: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
    return operation(transaction);
  }) as Promise<T>;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      return item;
    }),
  ) as JSONValue;
}

function databaseRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("database returned an invalid provider webhook row");
  }
  return value as Record<string, unknown>;
}

function databaseString(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  throw new Error(`database returned an invalid ${field}`);
}

function databaseTimestamp(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(databaseString(value, field));
  if (Number.isNaN(date.getTime())) throw new Error(`database returned an invalid ${field}`);
  return date.toISOString();
}
