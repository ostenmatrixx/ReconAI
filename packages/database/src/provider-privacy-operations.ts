import type { TenantContext } from "@workspace/domain";
import type { Sql } from "postgres";
import { z } from "zod";

import { withTenantTransaction } from "./tenant-transaction.js";

const listOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,1024}$/u)
      .optional(),
  })
  .strict();

const privacyRequestCursorSchema = z
  .object({
    version: z.literal(1),
    organizationId: z.uuid(),
    dueAt: z.iso.datetime({ offset: true }),
    receivedAt: z.iso.datetime({ offset: true }),
    id: z.uuid(),
  })
  .strict();

const privacyRequestRowSchema = z
  .object({
    id: z.uuid(),
    connectionId: z.uuid(),
    provider: z.literal("shopify"),
    topic: z.enum(["customers/data_request", "customers/redact", "shop/redact"]),
    apiVersion: z.string().regex(/^\d{4}-(?:01|04|07|10)$/u),
    externalAccountId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/u),
    status: z.literal("action_required"),
    objectIdentifierCount: z.number().int().min(0).max(10_000),
    receivedAt: z.iso.datetime({ offset: true }),
    dueAt: z.iso.datetime({ offset: true }),
    deadlineAlert: z
      .object({
        stage: z.enum(["due_7_days", "due_24_hours", "overdue"]),
        observedAt: z.iso.datetime({ offset: true }),
      })
      .strict()
      .optional(),
    deletionProgress: z
      .object({
        total: z.number().int().min(0),
        pending: z.number().int().min(0),
        processing: z.number().int().min(0),
        retry: z.number().int().min(0),
        deleted: z.number().int().min(0),
        alreadyMissing: z.number().int().min(0),
        deadLettered: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();

export type ProviderPrivacyRequestOperationsItem = z.infer<typeof privacyRequestRowSchema>;

export interface ProviderPrivacyRequestOperationsPage {
  readonly items: readonly ProviderPrivacyRequestOperationsItem[];
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export interface ProviderPrivacyOperationsRepository {
  list(
    tenant: TenantContext,
    options: { readonly limit: number; readonly cursor?: string },
  ): Promise<ProviderPrivacyRequestOperationsPage>;
}

export class ProviderPrivacyOperationsCursorError extends Error {
  public constructor() {
    super("provider privacy operations cursor is invalid");
    this.name = "ProviderPrivacyOperationsCursorError";
  }
}

/**
 * Lists minimized privacy-request operations metadata under a validated PostgreSQL tenant context.
 * Customer, order, webhook, digest, and object-store identifiers are deliberately not selected.
 */
export class PostgresProviderPrivacyOperationsRepository implements ProviderPrivacyOperationsRepository {
  public constructor(private readonly sql: Sql) {}

  public async list(
    tenant: TenantContext,
    optionsInput: { readonly limit: number; readonly cursor?: string },
  ): Promise<ProviderPrivacyRequestOperationsPage> {
    const options = listOptionsSchema.parse(optionsInput);
    const cursor = options.cursor
      ? decodeProviderPrivacyOperationsCursor(options.cursor, tenant.organizationId)
      : undefined;
    const cursorEnabled = cursor !== undefined;
    const cursorDueAt = cursor?.dueAt ?? "1970-01-01T00:00:00.000Z";
    const cursorReceivedAt = cursor?.receivedAt ?? "1970-01-01T00:00:00.000Z";
    const cursorId = cursor?.id ?? "00000000-0000-4000-8000-000000000000";
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select
          requests.id,
          requests.connection_id,
          requests.provider,
          requests.topic,
          requests.api_version,
          requests.external_account_id,
          requests.status,
          jsonb_array_length(requests.external_object_ids)::integer
            as object_identifier_count,
          requests.received_at,
          requests.due_at,
          deadline_alert.stage as deadline_alert_stage,
          deadline_alert.observed_at as deadline_alert_observed_at,
          count(jobs.id)::integer as deletion_total,
          (count(jobs.id) filter (where jobs.status = 'pending'))::integer
            as deletion_pending,
          (count(jobs.id) filter (where jobs.status = 'processing'))::integer
            as deletion_processing,
          (count(jobs.id) filter (where jobs.status = 'retry'))::integer
            as deletion_retry,
          (count(jobs.id) filter (where jobs.status = 'deleted'))::integer
            as deletion_deleted,
          (count(jobs.id) filter (where jobs.status = 'already_missing'))::integer
            as deletion_already_missing,
          (count(jobs.id) filter (where jobs.status = 'dead_lettered'))::integer
            as deletion_dead_lettered
        from provider_privacy_requests as requests
        left join provider_privacy_object_deletion_jobs as jobs
          on jobs.organization_id = requests.organization_id
         and jobs.request_id = requests.id
        left join lateral (
          select alerts.stage, alerts.observed_at
          from provider_privacy_request_deadline_alerts as alerts
          where alerts.organization_id = requests.organization_id
            and alerts.request_id = requests.id
          order by
            case alerts.stage
              when 'overdue' then 3
              when 'due_24_hours' then 2
              when 'due_7_days' then 1
              else 0
            end desc,
            alerts.observed_at desc
          limit 1
        ) as deadline_alert on true
        where requests.organization_id = ${tenant.organizationId}
          and (
            ${cursorEnabled}::boolean = false
            or (
              requests.due_at,
              requests.received_at,
              requests.id
            ) > (
              ${cursorDueAt}::timestamptz,
              ${cursorReceivedAt}::timestamptz,
              ${cursorId}::uuid
            )
          )
        group by
          requests.organization_id,
          requests.id,
          requests.connection_id,
          requests.provider,
          requests.topic,
          requests.api_version,
          requests.external_account_id,
          requests.status,
          requests.external_object_ids,
          requests.received_at,
          requests.due_at,
          deadline_alert.stage,
          deadline_alert.observed_at
        order by requests.due_at, requests.received_at, requests.id
        limit ${options.limit + 1}
      `;
      const items = rows.slice(0, options.limit).map(parsePrivacyRequestRow);
      const truncated = rows.length > options.limit;
      const lastItem = items.at(-1);
      return {
        items,
        truncated,
        ...(truncated && lastItem
          ? {
              nextCursor: encodeProviderPrivacyOperationsCursor(lastItem, tenant.organizationId),
            }
          : {}),
      };
    });
  }
}

export function encodeProviderPrivacyOperationsCursor(
  item: Pick<ProviderPrivacyRequestOperationsItem, "id" | "dueAt" | "receivedAt">,
  organizationId: string,
): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      organizationId: z.uuid().parse(organizationId),
      dueAt: item.dueAt,
      receivedAt: item.receivedAt,
      id: item.id,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeProviderPrivacyOperationsCursor(
  encoded: string,
  organizationId: string,
): z.infer<typeof privacyRequestCursorSchema> {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded)) {
      throw new ProviderPrivacyOperationsCursorError();
    }
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.byteLength(decoded, "utf8") > 768) {
      throw new ProviderPrivacyOperationsCursorError();
    }
    const cursor = privacyRequestCursorSchema.parse(JSON.parse(decoded) as unknown);
    if (cursor.organizationId !== z.uuid().parse(organizationId)) {
      throw new ProviderPrivacyOperationsCursorError();
    }
    return cursor;
  } catch (error) {
    if (error instanceof ProviderPrivacyOperationsCursorError) throw error;
    throw new ProviderPrivacyOperationsCursorError();
  }
}

function parsePrivacyRequestRow(value: unknown): ProviderPrivacyRequestOperationsItem {
  const row = databaseRow(value);
  return privacyRequestRowSchema.parse({
    id: row["id"],
    connectionId: row["connection_id"],
    provider: row["provider"],
    topic: row["topic"],
    apiVersion: row["api_version"],
    externalAccountId: row["external_account_id"],
    status: row["status"],
    objectIdentifierCount: row["object_identifier_count"],
    receivedAt: timestamp(row["received_at"]),
    dueAt: timestamp(row["due_at"]),
    ...(row["deadline_alert_stage"]
      ? {
          deadlineAlert: {
            stage: row["deadline_alert_stage"],
            observedAt: timestamp(row["deadline_alert_observed_at"]),
          },
        }
      : {}),
    deletionProgress: {
      total: row["deletion_total"],
      pending: row["deletion_pending"],
      processing: row["deletion_processing"],
      retry: row["deletion_retry"],
      deleted: row["deletion_deleted"],
      alreadyMissing: row["deletion_already_missing"],
      deadLettered: row["deletion_dead_lettered"],
    },
  });
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new TypeError("provider privacy request timestamp is invalid");
}

function databaseRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("provider privacy request row is invalid");
  }
  return value as Readonly<Record<string, unknown>>;
}
