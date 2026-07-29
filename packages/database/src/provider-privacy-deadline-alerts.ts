import { createHash } from "node:crypto";

import { OrganizationIdSchema } from "@workspace/domain";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { insertTenantAuditEvent } from "./audit.js";

const deadlineAlertStageSchema = z.enum(["due_7_days", "due_24_hours", "overdue"]);
const scanInputSchema = z
  .object({
    now: z.iso.datetime({ offset: true }),
    batchSize: z.number().int().min(1).max(500),
  })
  .strict();
const candidateSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    requestId: z.uuid(),
    stage: deadlineAlertStageSchema,
    dueAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type ProviderPrivacyDeadlineAlertStage = z.infer<typeof deadlineAlertStageSchema>;

export interface ProviderPrivacyDeadlineAlertScanInput {
  readonly now: string;
  readonly batchSize: number;
}

export interface ProviderPrivacyDeadlineAlertScanResult {
  readonly examined: number;
  readonly created: number;
  readonly skipped: number;
  readonly due7Days: number;
  readonly due24Hours: number;
  readonly overdue: number;
}

export interface ProviderPrivacyDeadlineAlertRepository {
  scanDueDeadlineAlerts(
    input: ProviderPrivacyDeadlineAlertScanInput,
  ): Promise<ProviderPrivacyDeadlineAlertScanResult>;
}

/**
 * Creates append-only deadline escalation and audit evidence through worker-only database
 * functions. The cross-tenant candidate query is fixed and each write re-enters an exact tenant
 * transaction before the database recomputes request and threshold authority.
 */
export class PostgresProviderPrivacyDeadlineAlertRepository implements ProviderPrivacyDeadlineAlertRepository {
  public constructor(private readonly sql: Sql) {}

  public async scanDueDeadlineAlerts(
    input: ProviderPrivacyDeadlineAlertScanInput,
  ): Promise<ProviderPrivacyDeadlineAlertScanResult> {
    const parsed = scanInputSchema.parse(input);
    const observedAt = new Date(parsed.now).toISOString();
    const rows = await this.sql`
      select *
      from reconai_due_provider_privacy_deadline_alerts(
        ${observedAt}::timestamptz,
        ${parsed.batchSize}
      )
    `;
    let due7Days = 0;
    let due24Hours = 0;
    let overdue = 0;
    for (const value of rows) {
      const row = databaseRow(value);
      const candidate = candidateSchema.parse({
        organizationId: row["organization_id"],
        requestId: row["request_id"],
        stage: row["stage"],
        dueAt: timestamp(row["due_at"]),
      });
      if (classifyProviderPrivacyDeadlineStage(candidate.dueAt, observedAt) !== candidate.stage) {
        throw new Error("privacy deadline candidate threshold is invalid");
      }
      const authorityKey = [
        "provider-privacy-deadline-alert-v1",
        candidate.organizationId,
        candidate.requestId,
        candidate.stage,
      ].join("\0");
      const created = await withOrganizationTransaction(
        this.sql,
        candidate.organizationId,
        async (transaction) => {
          const result = await transaction`
            select reconai_create_provider_privacy_deadline_alert(
              ${candidate.organizationId}::uuid,
              ${candidate.requestId}::uuid,
              ${stableUuid(`alert\0${authorityKey}`)}::uuid,
              ${candidate.stage},
              ${candidate.dueAt}::timestamptz,
              ${observedAt}::timestamptz
            ) as created
          `;
          if (databaseRow(result[0])["created"] !== true) return false;
          await insertTenantAuditEvent(transaction, {
            organizationId: candidate.organizationId,
            actorType: "system",
            actorId: "provider-privacy-deadline-monitor",
            action: "provider_privacy.deadline_alerted",
            resourceType: "provider_privacy_request",
            resourceId: candidate.requestId,
            correlationId: stableUuid(`correlation\0${authorityKey}`),
            reason: deadlineReason(candidate.stage),
            newValue: {
              stage: candidate.stage,
              dueAt: candidate.dueAt,
              status: "action_required",
            },
            versionContext: { schemaVersion: 1, deadlineMonitorVersion: "1" },
            occurredAt: observedAt,
          });
          return true;
        },
      );
      if (!created) continue;
      if (candidate.stage === "due_7_days") due7Days += 1;
      if (candidate.stage === "due_24_hours") due24Hours += 1;
      if (candidate.stage === "overdue") overdue += 1;
    }
    const created = due7Days + due24Hours + overdue;
    return {
      examined: rows.length,
      created,
      skipped: rows.length - created,
      due7Days,
      due24Hours,
      overdue,
    };
  }
}

export function classifyProviderPrivacyDeadlineStage(
  dueAtInput: string,
  observedAtInput: string,
): ProviderPrivacyDeadlineAlertStage | undefined {
  const dueAt = new Date(z.iso.datetime({ offset: true }).parse(dueAtInput)).getTime();
  const observedAt = new Date(z.iso.datetime({ offset: true }).parse(observedAtInput)).getTime();
  if (observedAt >= dueAt) return "overdue";
  if (observedAt >= dueAt - 24 * 60 * 60 * 1000) return "due_24_hours";
  if (observedAt >= dueAt - 7 * 24 * 60 * 60 * 1000) return "due_7_days";
  return undefined;
}

function deadlineReason(stage: ProviderPrivacyDeadlineAlertStage): string {
  switch (stage) {
    case "due_7_days":
      return "Shopify privacy request entered its final seven-day response window";
    case "due_24_hours":
      return "Shopify privacy request entered its final 24-hour response window";
    case "overdue":
      return "Shopify privacy request crossed its recorded response deadline";
  }
}

async function withOrganizationTransaction<T>(
  sql: Sql,
  organizationId: string,
  operation: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
    const context =
      await transaction`select current_setting('app.organization_id', true) as organization_id`;
    if (databaseRow(context[0])["organization_id"] !== organizationId) {
      throw new Error("privacy deadline alert tenant context was not established");
    }
    return operation(transaction);
  }) as Promise<T>;
}

function stableUuid(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new TypeError("privacy deadline alert timestamp is invalid");
}

function databaseRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("privacy deadline alert database row is invalid");
  }
  return value as Readonly<Record<string, unknown>>;
}
