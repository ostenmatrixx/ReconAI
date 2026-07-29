import type { TenantContext } from "@workspace/domain";
import {
  PROVIDER_PRIVACY_DATA_PACKAGE_RECEIPT_TTL_MS,
  type ProviderPrivacyDataPackageAuthority,
  type ProviderPrivacyDataPackageReceipt,
  type ProviderPrivacyDataPackageRepository,
  type ProviderPrivacyDataPackageSourceRecord,
} from "@workspace/ingestion";
import type { Sql } from "postgres";
import { z } from "zod";

import { insertUserAuditEvent } from "./audit.js";
import { withTenantTransaction } from "./tenant-transaction.js";

const timestampSchema = z.iso.datetime({ offset: true });
const sourceSchema = z.enum(["shopify", "stripe"]);
const requestRowSchema = z
  .object({
    id: z.uuid(),
    connectionId: z.uuid(),
    shopDomain: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/u),
    customerId: z.string().regex(/^[0-9]{1,40}$/u),
    externalRequestId: z.string().regex(/^[0-9]{1,40}$/u),
    orderIds: z.array(z.string().regex(/^[0-9]{1,40}$/u)).max(10_000),
    apiVersion: z.string().regex(/^\d{4}-(?:01|04|07|10)$/u),
    receivedAt: timestampSchema,
    dueAt: timestampSchema,
  })
  .strict();
const sourceRowSchema = z
  .object({
    sourceEventId: z.uuid(),
    source: sourceSchema,
    eventType: z.string().min(1).max(100),
    externalEventId: z.string().min(1).max(255),
    externalObjectId: z.string().min(1).max(255),
    sourceTimestamp: timestampSchema,
    receivedAt: timestampSchema,
    connectorVersion: z.string().min(1).max(100),
    apiVersion: z.string().min(1).max(50).optional(),
    objectKey: z.string().min(1).max(1024),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    canonicalRecords: z.array(z.unknown()),
  })
  .strict();
const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const receiptOutcomeRowSchema = z
  .object({
    outcome: z.enum(["acknowledged", "already_acknowledged", "expired"]),
    contentSha256: checksumSchema,
    byteCount: z
      .number()
      .int()
      .min(1)
      .max(5 * 1024 * 1024),
    preparedAt: timestampSchema,
    receiptExpiresAt: timestampSchema,
    receivedAt: timestampSchema.optional(),
  })
  .strict();

/**
 * Resolves only provider evidence that is tenant-bound and linked to the order identifiers supplied
 * in an authenticated Shopify customers/data_request payload.
 */
export class PostgresProviderPrivacyDataPackageRepository implements ProviderPrivacyDataPackageRepository {
  public constructor(private readonly sql: Sql) {}

  public async loadAuthority(
    tenant: TenantContext,
    requestIdValue: string,
    maximumRecordsValue: number,
  ): Promise<ProviderPrivacyDataPackageAuthority | undefined> {
    const requestId = z.uuid().parse(requestIdValue);
    const maximumRecords = z.number().int().min(1).max(500).parse(maximumRecordsValue);
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const requestRows = await transaction`
        select
          id,
          connection_id,
          external_account_id,
          external_subject_id,
          external_request_id,
          external_object_ids,
          api_version,
          received_at,
          due_at
        from provider_privacy_requests
        where organization_id = ${tenant.organizationId}
          and id = ${requestId}::uuid
          and provider = 'shopify'
          and topic = 'customers/data_request'
          and status = 'action_required'
        limit 1
      `;
      if (!requestRows[0]) return undefined;
      const request = parseRequestRow(requestRows[0]);
      const sourceRows = await transaction`
        select
          events.id as source_event_id,
          events.source,
          events.external_object_type,
          events.external_event_id,
          events.external_object_id,
          events.source_timestamp,
          events.received_at,
          events.connector_version,
          events.api_version,
          events.payload_object_key,
          events.payload_sha256,
          coalesce(
            jsonb_agg(
              (
                records.normalized_data
                  - 'organizationId'
                  - 'id'
                  - 'contentSha256'
              ) #- '{provenance,sourceEventId}'
              order by records.effective_at, records.id, records.version
            ) filter (where records.id is not null),
            '[]'::jsonb
          ) as canonical_records
        from source_events as events
        left join canonical_records as records
          on records.organization_id = events.organization_id
         and records.source_event_id = events.id
        where events.organization_id = ${tenant.organizationId}
          and events.source in ('shopify', 'stripe')
          and (
            (
              events.source = 'shopify'
              and events.connection_id = ${request.connectionId}::uuid
              and (
                events.external_object_id = any(${request.orderIds}::text[])
                or exists (
                  select 1
                  from canonical_records as shopify_records
                  where shopify_records.organization_id = events.organization_id
                    and shopify_records.source_event_id = events.id
                    and (
                      shopify_records.external_object_id = any(${request.orderIds}::text[])
                      or shopify_records.order_reference = any(${request.orderIds}::text[])
                    )
                )
              )
            )
            or exists (
              select 1
              from canonical_records as linked_records
              where linked_records.organization_id = events.organization_id
                and linked_records.source_event_id = events.id
                and linked_records.order_reference = any(${request.orderIds}::text[])
            )
          )
        group by
          events.organization_id,
          events.id,
          events.source,
          events.external_object_type,
          events.external_event_id,
          events.external_object_id,
          events.source_timestamp,
          events.received_at,
          events.connector_version,
          events.api_version,
          events.payload_object_key,
          events.payload_sha256
        order by events.received_at, events.id
        limit ${maximumRecords + 1}
      `;
      const sourceRecords = sourceRows.slice(0, maximumRecords).map(parseSourceRow);
      return {
        requestId: request.id,
        shopDomain: request.shopDomain,
        customerId: request.customerId,
        externalRequestId: request.externalRequestId,
        orderIds: request.orderIds,
        receivedAt: request.receivedAt,
        dueAt: request.dueAt,
        apiVersion: request.apiVersion,
        sourceRecords,
        truncated: sourceRows.length > maximumRecords,
      };
    });
  }

  public async recordPreparation(
    tenant: TenantContext,
    inputValue: {
      readonly requestId: string;
      readonly packageId: string;
      readonly reason: string;
      readonly correlationId: string;
      readonly preparedAt: string;
      readonly sourceRecordCount: number;
      readonly canonicalRecordCount: number;
      readonly byteCount: number;
      readonly sourceCounts: Readonly<Record<"shopify" | "stripe", number>>;
      readonly contentSha256: string;
      readonly receiptTokenSha256: string;
      readonly receiptExpiresAt: string;
    },
  ): Promise<boolean> {
    const input = z
      .object({
        requestId: z.uuid(),
        packageId: z.uuid(),
        reason: z.string().trim().min(3).max(2000),
        correlationId: z.uuid(),
        preparedAt: timestampSchema,
        sourceRecordCount: z.number().int().min(0).max(100),
        canonicalRecordCount: z.number().int().min(0).max(10_000),
        byteCount: z
          .number()
          .int()
          .min(1)
          .max(5 * 1024 * 1024),
        sourceCounts: z
          .object({
            shopify: z.number().int().min(0).max(100),
            stripe: z.number().int().min(0).max(100),
          })
          .strict(),
        contentSha256: checksumSchema,
        receiptTokenSha256: checksumSchema,
        receiptExpiresAt: timestampSchema,
      })
      .strict()
      .superRefine((value, context) => {
        if (
          Date.parse(value.receiptExpiresAt) - Date.parse(value.preparedAt) !==
          PROVIDER_PRIVACY_DATA_PACKAGE_RECEIPT_TTL_MS
        ) {
          context.addIssue({
            code: "custom",
            path: ["receiptExpiresAt"],
            message: "receipt authority must expire exactly ten minutes after preparation",
          });
        }
      })
      .parse(inputValue);
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const requests = await transaction`
        select id
        from provider_privacy_requests
        where organization_id = ${tenant.organizationId}
          and id = ${input.requestId}::uuid
          and provider = 'shopify'
          and topic = 'customers/data_request'
          and status = 'action_required'
        limit 1
      `;
      if (!requests[0]) return false;
      await transaction`
        insert into provider_privacy_data_packages (
          id,
          organization_id,
          request_id,
          prepared_by_membership_id,
          content_sha256,
          byte_count,
          receipt_token_sha256,
          prepared_at,
          receipt_expires_at,
          created_at
        ) values (
          ${input.packageId}::uuid,
          ${tenant.organizationId}::uuid,
          ${input.requestId}::uuid,
          ${tenant.membershipId}::uuid,
          ${input.contentSha256},
          ${input.byteCount},
          ${input.receiptTokenSha256},
          ${input.preparedAt}::timestamptz,
          ${input.receiptExpiresAt}::timestamptz,
          ${input.preparedAt}::timestamptz
        )
      `;
      await insertUserAuditEvent(transaction, tenant, {
        action: "provider_privacy.data_package_prepared",
        resourceType: "provider_privacy_request",
        resourceId: input.requestId,
        correlationId: input.correlationId,
        reason: input.reason,
        newValue: {
          packageId: input.packageId,
          schemaVersion: 1,
          format: "json",
          sourceRecordCount: input.sourceRecordCount,
          canonicalRecordCount: input.canonicalRecordCount,
          byteCount: input.byteCount,
          sourceCounts: input.sourceCounts,
          deliveryStatus: "not_delivered",
          browserReceiptStatus: "pending",
          receiptExpiresAt: input.receiptExpiresAt,
        },
        versionContext: {
          dataPackageSchemaVersion: 1,
          scope: "linked_provider_evidence",
        },
        occurredAt: input.preparedAt,
      });
      return true;
    });
  }

  public async acknowledgeReceipt(
    tenant: TenantContext,
    inputValue: {
      readonly requestId: string;
      readonly packageId: string;
      readonly receiptId: string;
      readonly receiptTokenSha256: string;
      readonly correlationId: string;
      readonly receivedAt: string;
    },
  ): Promise<ProviderPrivacyDataPackageReceipt | undefined> {
    const input = z
      .object({
        requestId: z.uuid(),
        packageId: z.uuid(),
        receiptId: z.uuid(),
        receiptTokenSha256: checksumSchema,
        correlationId: z.uuid(),
        receivedAt: timestampSchema,
      })
      .strict()
      .parse(inputValue);
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select
          outcome,
          content_sha256,
          byte_count,
          prepared_at,
          receipt_expires_at,
          received_at
        from reconai_acknowledge_provider_privacy_data_package(
          ${tenant.organizationId}::uuid,
          ${input.requestId}::uuid,
          ${input.packageId}::uuid,
          ${input.receiptId}::uuid,
          ${tenant.membershipId}::uuid,
          ${input.receiptTokenSha256},
          ${input.receivedAt}::timestamptz
        )
      `;
      if (!rows[0]) return undefined;
      const receipt = parseReceiptOutcome(rows[0], input.packageId);
      if (receipt.status === "acknowledged") {
        await insertUserAuditEvent(transaction, tenant, {
          action: "provider_privacy.data_package_received_by_browser",
          resourceType: "provider_privacy_request",
          resourceId: input.requestId,
          correlationId: input.correlationId,
          reason: "Authenticated browser verified complete privacy package bytes",
          newValue: {
            packageId: receipt.packageId,
            schemaVersion: 1,
            format: "json",
            contentSha256: receipt.contentSha256,
            byteCount: receipt.byteCount,
            browserReceiptStatus: "verified",
            deliveryStatus: "not_delivered",
            limitation:
              "Browser receipt does not prove merchant or customer delivery, review, fulfillment, or control of downloaded copies.",
          },
          versionContext: {
            dataPackageSchemaVersion: 1,
            browserReceiptSchemaVersion: 1,
            scope: "linked_provider_evidence",
          },
          occurredAt: receipt.receivedAt,
        });
      }
      return receipt;
    });
  }
}

function parseRequestRow(value: unknown): z.infer<typeof requestRowSchema> & {
  readonly connectionId: string;
} {
  const row = databaseRow(value);
  return requestRowSchema.parse({
    id: row["id"],
    connectionId: row["connection_id"],
    shopDomain: row["external_account_id"],
    customerId: row["external_subject_id"],
    externalRequestId: row["external_request_id"],
    orderIds: row["external_object_ids"],
    apiVersion: row["api_version"],
    receivedAt: timestamp(row["received_at"]),
    dueAt: timestamp(row["due_at"]),
  });
}

function parseSourceRow(value: unknown): ProviderPrivacyDataPackageSourceRecord {
  const row = databaseRow(value);
  const parsed = sourceRowSchema.parse({
    sourceEventId: row["source_event_id"],
    source: row["source"],
    eventType: row["external_object_type"],
    externalEventId: row["external_event_id"],
    externalObjectId: row["external_object_id"],
    sourceTimestamp: timestamp(row["source_timestamp"]),
    receivedAt: timestamp(row["received_at"]),
    connectorVersion: row["connector_version"],
    ...(row["api_version"] ? { apiVersion: row["api_version"] } : {}),
    objectKey: row["payload_object_key"],
    payloadSha256:
      typeof row["payload_sha256"] === "string"
        ? row["payload_sha256"].trim()
        : row["payload_sha256"],
    canonicalRecords: row["canonical_records"],
  });
  return {
    sourceEventId: parsed.sourceEventId,
    source: parsed.source,
    eventType: parsed.eventType,
    externalEventId: parsed.externalEventId,
    externalObjectId: parsed.externalObjectId,
    sourceTimestamp: parsed.sourceTimestamp,
    receivedAt: parsed.receivedAt,
    connectorVersion: parsed.connectorVersion,
    ...(parsed.apiVersion ? { apiVersion: parsed.apiVersion } : {}),
    objectKey: parsed.objectKey,
    payloadSha256: parsed.payloadSha256,
    canonicalRecords: parsed.canonicalRecords,
  };
}

function parseReceiptOutcome(value: unknown, packageId: string): ProviderPrivacyDataPackageReceipt {
  const row = databaseRow(value);
  const parsed = receiptOutcomeRowSchema.parse({
    outcome: row["outcome"],
    contentSha256:
      typeof row["content_sha256"] === "string"
        ? row["content_sha256"].trim()
        : row["content_sha256"],
    byteCount: row["byte_count"],
    preparedAt: timestamp(row["prepared_at"]),
    receiptExpiresAt: timestamp(row["receipt_expires_at"]),
    ...(row["received_at"] ? { receivedAt: timestamp(row["received_at"]) } : {}),
  });
  const base = {
    packageId,
    contentSha256: parsed.contentSha256,
    byteCount: parsed.byteCount,
    preparedAt: parsed.preparedAt,
    receiptExpiresAt: parsed.receiptExpiresAt,
  };
  if (parsed.outcome === "expired") {
    return { ...base, status: "expired" };
  }
  if (!parsed.receivedAt) {
    throw new Error("acknowledged provider privacy package receipt is missing received_at");
  }
  return {
    ...base,
    status: parsed.outcome,
    receivedAt: parsed.receivedAt,
  };
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return timestampSchema.parse(value);
}

function databaseRow(value: unknown): Readonly<Record<string, unknown>> {
  return z.record(z.string(), z.unknown()).parse(value);
}
