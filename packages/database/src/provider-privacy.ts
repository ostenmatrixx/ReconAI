import { randomUUID } from "node:crypto";

import {
  ProviderWebhookConflictError,
  ShopifyPrivacyTopicSchema,
  type ShopifyPrivacyRequestRecord,
  type ShopifyPrivacyRequestRepository,
} from "@workspace/ingestion";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { insertTenantAuditEvent } from "./audit.js";

const shopifyDomainSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/u);
const identifierSchema = z.string().regex(/^[0-9]{1,40}$/u);
const eventIdSchema = z.string().regex(/^[A-Za-z0-9._:/-]{1,255}$/u);
const apiVersionSchema = z.string().regex(/^\d{4}-(?:01|04|07|10)$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

/**
 * Resolves a signed app-level Shopify privacy request through a narrowly granted shop resolver,
 * then writes only minimized request authority under the resolved PostgreSQL tenant context.
 */
export class PostgresShopifyPrivacyRequestRepository implements ShopifyPrivacyRequestRepository {
  public constructor(private readonly sql: Sql) {}

  public async recordShopifyPrivacyRequest(
    recordInput: ShopifyPrivacyRequestRecord,
  ): Promise<{ readonly matched: boolean; readonly duplicate: boolean }> {
    const record = parseRecord(recordInput);
    const resolved = await this.sql`
      select organization_id, connection_id
      from reconai_resolve_shopify_privacy_request(${record.shopDomain})
    `;
    const authority = resolved[0] ? databaseRow(resolved[0]) : undefined;
    if (!authority) return { matched: false, duplicate: false };
    const organizationId = z.uuid().parse(authority["organization_id"]);
    const connectionId = z.uuid().parse(authority["connection_id"]);

    return withOrganizationTransaction(this.sql, organizationId, async (transaction) => {
      const existing = await transaction`
        select *
        from provider_privacy_requests
        where organization_id = ${organizationId}
          and provider = 'shopify'
          and external_event_id = ${record.externalEventId}
        limit 1
      `;
      if (existing[0]) {
        assertSameRequest(databaseRow(existing[0]), record, connectionId);
        return { matched: true, duplicate: true };
      }

      const requestId = randomUUID();
      await transaction`
        insert into provider_privacy_requests (
          id,
          organization_id,
          connection_id,
          provider,
          external_event_id,
          topic,
          api_version,
          external_shop_id,
          external_account_id,
          external_subject_id,
          external_request_id,
          external_object_ids,
          payload_sha256,
          status,
          due_at,
          received_at
        ) values (
          ${requestId}::uuid,
          ${organizationId}::uuid,
          ${connectionId}::uuid,
          'shopify',
          ${record.externalEventId},
          ${record.topic},
          ${record.apiVersion},
          ${record.shopId},
          ${record.shopDomain},
          ${record.customerId ?? null},
          ${record.externalRequestId ?? null},
          ${transaction.json(record.orderIds)},
          ${record.payloadSha256},
          'action_required',
          ${record.dueAt}::timestamptz,
          ${record.receivedAt}::timestamptz
        )
      `;
      await transaction`
        update data_source_connections
        set status = 'action_required',
            updated_at = ${record.receivedAt}::timestamptz
        where organization_id = ${organizationId}
          and id = ${connectionId}::uuid
          and provider = 'shopify'
          and external_account_id = ${record.shopDomain}
      `;
      const deletionJobs =
        record.topic === "customers/data_request"
          ? []
          : await transaction`
              with eligible_sources as (
                select distinct
                  events.id,
                  events.payload_object_key,
                  events.payload_sha256
                from source_events as events
                left join canonical_records as records
                  on records.organization_id = events.organization_id
                 and records.source_event_id = events.id
                where events.organization_id = ${organizationId}
                  and events.connection_id = ${connectionId}::uuid
                  and events.source = 'shopify'
                  and (
                    ${record.topic} = 'shop/redact'
                    or (
                      ${record.topic} = 'customers/redact'
                      and (
                        events.external_object_id = any(${record.orderIds}::text[])
                        or records.external_object_id = any(${record.orderIds}::text[])
                        or records.order_reference = any(${record.orderIds}::text[])
                      )
                    )
                  )
              )
              insert into provider_privacy_object_deletion_jobs (
                id,
                organization_id,
                request_id,
                source_event_id,
                object_key,
                payload_sha256,
                status,
                attempts,
                next_attempt_at
              )
              select
                gen_random_uuid(),
                ${organizationId}::uuid,
                ${requestId}::uuid,
                eligible_sources.id,
                eligible_sources.payload_object_key,
                eligible_sources.payload_sha256,
                'pending',
                0,
                ${record.receivedAt}::timestamptz
              from eligible_sources
              order by eligible_sources.id
              on conflict (organization_id, request_id, source_event_id) do nothing
              returning source_event_id
            `;
      await insertTenantAuditEvent(transaction, {
        organizationId,
        actorType: "system",
        actorId: "shopify-privacy-webhook-v1",
        action: "provider_privacy_request.received",
        resourceType: "provider_privacy_request",
        resourceId: requestId,
        correlationId: record.correlationId,
        reason: "Authenticated Shopify mandatory privacy request requires controlled handling",
        newValue: {
          provider: "shopify",
          topic: record.topic,
          status: "action_required",
          externalEventId: record.externalEventId,
          payloadSha256: record.payloadSha256,
          objectIdentifierCount: record.orderIds.length,
          rawObjectDeletionCount: deletionJobs.length,
          dueAt: record.dueAt,
        },
        versionContext: {
          privacyRequestSchemaVersion: 1,
          apiVersion: record.apiVersion,
        },
        occurredAt: record.receivedAt,
      });
      return { matched: true, duplicate: false };
    });
  }
}

function parseRecord(input: ShopifyPrivacyRequestRecord): ShopifyPrivacyRequestRecord {
  const topic = ShopifyPrivacyTopicSchema.parse(input.topic);
  const orderIds = z.array(identifierSchema).max(10_000).parse(input.orderIds);
  if (new Set(orderIds).size !== orderIds.length) {
    throw new TypeError("Shopify privacy order identifiers must be unique");
  }
  const receivedAt = z.iso.datetime({ offset: true }).parse(input.receivedAt);
  const dueAt = z.iso.datetime({ offset: true }).parse(input.dueAt);
  if (Date.parse(dueAt) !== Date.parse(receivedAt) + 30 * 24 * 60 * 60 * 1000) {
    throw new TypeError("Shopify privacy request deadline must be exactly 30 days");
  }
  if (
    (topic === "shop/redact" &&
      (input.customerId !== undefined ||
        input.externalRequestId !== undefined ||
        orderIds.length > 0)) ||
    (topic === "customers/redact" &&
      (input.customerId === undefined || input.externalRequestId !== undefined)) ||
    (topic === "customers/data_request" &&
      (input.customerId === undefined || input.externalRequestId === undefined))
  ) {
    throw new TypeError("Shopify privacy request identifiers do not match the topic");
  }
  return {
    provider: z.literal("shopify").parse(input.provider),
    externalEventId: eventIdSchema.parse(input.externalEventId),
    topic,
    apiVersion: apiVersionSchema.parse(input.apiVersion),
    shopId: identifierSchema.parse(input.shopId),
    shopDomain: shopifyDomainSchema.parse(input.shopDomain),
    ...(input.customerId ? { customerId: identifierSchema.parse(input.customerId) } : {}),
    ...(input.externalRequestId
      ? { externalRequestId: identifierSchema.parse(input.externalRequestId) }
      : {}),
    orderIds,
    payloadSha256: sha256Schema.parse(input.payloadSha256),
    receivedAt,
    dueAt,
    correlationId: z.uuid().parse(input.correlationId),
  };
}

function assertSameRequest(
  row: Readonly<Record<string, unknown>>,
  expected: ShopifyPrivacyRequestRecord,
  connectionId: string,
): void {
  const objectIds = z.array(identifierSchema).parse(row["external_object_ids"]);
  if (
    row["connection_id"] !== connectionId ||
    row["topic"] !== expected.topic ||
    row["api_version"] !== expected.apiVersion ||
    row["external_shop_id"] !== expected.shopId ||
    row["external_account_id"] !== expected.shopDomain ||
    (row["external_subject_id"] ?? undefined) !== expected.customerId ||
    (row["external_request_id"] ?? undefined) !== expected.externalRequestId ||
    JSON.stringify(objectIds) !== JSON.stringify(expected.orderIds) ||
    row["payload_sha256"] !== expected.payloadSha256 ||
    databaseTimestamp(row["received_at"]) !== expected.receivedAt ||
    databaseTimestamp(row["due_at"]) !== expected.dueAt
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
