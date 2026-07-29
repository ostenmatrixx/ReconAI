import { createHash } from "node:crypto";

import {
  DurableTraceContextSchema,
  ProviderSyncJobEnvelopeSchema,
  createDurableTraceContext,
  type ProviderSyncJobEnvelope,
} from "@workspace/connectors";
import { OrganizationIdSchema, type TenantContext } from "@workspace/domain";
import {
  type ProviderSyncManager,
  type ProviderSyncRepository,
  type ProviderSyncRun,
  type ProviderSyncRunAuthority,
  type ProviderSyncStartInput,
} from "@workspace/ingestion";
import type { JSONValue, Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { insertTenantAuditEvent } from "./audit.js";

const startInputSchema = z.object({
  connectionId: z.uuid(),
  mode: z.enum(["backfill", "gap_repair"]),
  windowStart: z.iso.datetime({ offset: true }),
  windowEnd: z.iso.datetime({ offset: true }),
  maximumPages: z.number().int().min(1).max(100),
  reason: z.string().trim().min(3).max(2000),
  correlationId: z.uuid(),
  traceparent: DurableTraceContextSchema.shape.traceparent.optional(),
});
const runStatusSchema = z.enum(["queued", "running", "partial", "succeeded", "failed"]);
const providerSchema = z.enum(["shopify", "stripe"]);
const modeSchema = z.enum(["backfill", "gap_repair"]);
const requesterTypeSchema = z.enum(["user", "system"]);
const errorCodeSchema = z.string().regex(/^[A-Z0-9_]{1,100}$/u);
const scheduledGapRepairInputSchema = z
  .object({
    now: z.iso.datetime({ offset: true }),
    cadenceMs: z.number().int().min(60_000).max(86_400_000),
    lookbackMs: z
      .number()
      .int()
      .min(60_000)
      .max(30 * 24 * 60 * 60 * 1000),
    overlapMs: z
      .number()
      .int()
      .min(0)
      .max(60 * 60 * 1000),
    maximumPages: z.number().int().min(1).max(25),
    batchSize: z.number().int().min(1).max(100),
  })
  .refine((value) => value.overlapMs < value.lookbackMs, {
    message: "provider gap repair overlap must be smaller than its lookback",
  });

export interface ScheduledProviderGapRepairInput {
  readonly now: string;
  readonly cadenceMs: number;
  readonly lookbackMs: number;
  readonly overlapMs: number;
  readonly maximumPages: number;
  readonly batchSize: number;
}

export interface ScheduledProviderGapRepairResult {
  readonly examined: number;
  readonly scheduled: number;
  readonly skipped: number;
  readonly candidateObservations: readonly ScheduledProviderGapRepairCandidateObservation[];
}

export interface ScheduledProviderGapRepairCandidateObservation {
  readonly provider: "shopify" | "stripe";
  readonly freshnessReference: "last_successful_sync" | "never_succeeded";
  readonly disposition: "scheduled" | "skipped";
  readonly ageSeconds?: number;
}

export class PostgresProviderSyncRepository implements ProviderSyncManager, ProviderSyncRepository {
  public constructor(private readonly sql: Sql) {}

  public async scheduleDueGapRepairs(
    input: ScheduledProviderGapRepairInput,
  ): Promise<ScheduledProviderGapRepairResult> {
    const parsed = scheduledGapRepairInputSchema.parse(input);
    const now = new Date(parsed.now);
    const nowMs = now.getTime();
    const normalizedNow = now.toISOString();
    const dueBefore = new Date(nowMs - parsed.cadenceMs).toISOString();
    const slotStart = new Date(
      Math.floor(nowMs / parsed.cadenceMs) * parsed.cadenceMs,
    ).toISOString();
    const rows = await this.sql`
      select *
      from reconai_due_provider_gap_repairs(
        ${dueBefore}::timestamptz,
        ${parsed.batchSize}
      )
    `;
    let scheduled = 0;
    const candidateObservations: ScheduledProviderGapRepairCandidateObservation[] = [];
    for (const value of rows) {
      const candidate = scheduledGapRepairCandidateSchema.parse({
        organizationId: databaseRow(value)["organization_id"],
        connectionId: databaseRow(value)["connection_id"],
        provider: databaseRow(value)["provider"],
        ...(databaseRow(value)["last_successful_sync_at"]
          ? {
              lastSuccessfulSyncAt: databaseTimestamp(
                databaseRow(value)["last_successful_sync_at"],
                "connection.last_successful_sync_at",
              ),
            }
          : {}),
      });
      const earliestWindowStart = nowMs - parsed.lookbackMs;
      const overlappedSuccessfulSync = candidate.lastSuccessfulSyncAt
        ? new Date(candidate.lastSuccessfulSyncAt).getTime() - parsed.overlapMs
        : earliestWindowStart;
      const windowStart = new Date(
        Math.max(earliestWindowStart, overlappedSuccessfulSync),
      ).toISOString();
      const authorityKey = createHash("sha256")
        .update(
          [
            "scheduled-provider-gap-repair-v1",
            candidate.organizationId,
            candidate.connectionId,
            slotStart,
          ].join("\0"),
        )
        .digest("hex");
      const runId = stableUuid(`scheduled-provider-sync-run\0${authorityKey}`);
      const correlationId = stableUuid(`scheduled-provider-sync-correlation\0${authorityKey}`);
      const outboxIdempotencyKey = `${candidate.provider}:sync:${runId}:dispatch:1`;
      const envelope = ProviderSyncJobEnvelopeSchema.parse({
        schemaVersion: 1,
        type: "connector.sync.requested",
        organizationId: candidate.organizationId,
        connectionId: candidate.connectionId,
        provider: candidate.provider,
        syncRunId: runId,
        executionAttempt: 1,
        correlationId,
        idempotencyKey: outboxIdempotencyKey,
        requestedBy: "provider-gap-repair-scheduler",
        createdAt: normalizedNow,
      });
      const created = await withOrganizationTransaction(
        this.sql,
        candidate.organizationId,
        async (transaction) => {
          await transaction`
            select set_config('app.execution_tracking_version', '1', true)
          `;
          const result = await transaction`
            select reconai_create_scheduled_provider_gap_repair(
              ${candidate.organizationId}::uuid,
              ${candidate.connectionId}::uuid,
              ${candidate.provider},
              ${runId}::uuid,
              ${authorityKey},
              ${correlationId}::uuid,
              ${stableUuid(`scheduled-provider-sync-outbox\0${authorityKey}`)}::uuid,
              ${outboxIdempotencyKey},
              ${windowStart}::timestamptz,
              ${normalizedNow}::timestamptz,
              ${parsed.maximumPages},
              ${dueBefore}::timestamptz,
              ${normalizedNow}::timestamptz,
              ${transaction.json(toJsonValue(envelope))}
            ) as created
          `;
          if (databaseRow(result[0])["created"] !== true) return false;
          await insertTenantAuditEvent(transaction, {
            organizationId: candidate.organizationId,
            actorType: "system",
            actorId: "provider-gap-repair-scheduler",
            action: "provider_sync.scheduled",
            resourceType: "provider_sync_run",
            resourceId: runId,
            correlationId,
            reason: "Periodic bounded provider gap repair",
            newValue: {
              connectionId: candidate.connectionId,
              provider: candidate.provider,
              mode: "gap_repair",
              requesterType: "system",
              windowStart,
              windowEnd: normalizedNow,
              maximumPages: parsed.maximumPages,
              cadenceSlot: slotStart,
              status: "queued",
            },
            versionContext: { schemaVersion: 1, schedulerVersion: "1" },
            occurredAt: normalizedNow,
          });
          return true;
        },
      );
      if (created) scheduled += 1;
      candidateObservations.push({
        provider: candidate.provider,
        freshnessReference: candidate.lastSuccessfulSyncAt
          ? "last_successful_sync"
          : "never_succeeded",
        disposition: created ? "scheduled" : "skipped",
        ...(candidate.lastSuccessfulSyncAt
          ? {
              ageSeconds: (nowMs - new Date(candidate.lastSuccessfulSyncAt).getTime()) / 1_000,
            }
          : {}),
      });
    }
    return {
      examined: rows.length,
      scheduled,
      skipped: rows.length - scheduled,
      candidateObservations,
    };
  }

  public async start(
    tenant: TenantContext,
    input: ProviderSyncStartInput,
  ): Promise<ProviderSyncRun> {
    const parsed = startInputSchema.parse(input);
    const traceContext = createDurableTraceContext(parsed.traceparent);
    const windowStart = new Date(parsed.windowStart);
    const windowEnd = new Date(parsed.windowEnd);
    if (
      windowEnd.getTime() <= windowStart.getTime() ||
      windowEnd.getTime() - windowStart.getTime() > 30 * 24 * 60 * 60 * 1000
    ) {
      throw new TypeError("provider sync window must be positive and at most 30 days");
    }
    const normalizedStart = windowStart.toISOString();
    const normalizedEnd = windowEnd.toISOString();
    const idempotencyKey = createHash("sha256")
      .update(
        [
          "provider-sync",
          tenant.organizationId,
          parsed.connectionId,
          parsed.mode,
          normalizedStart,
          normalizedEnd,
          String(parsed.maximumPages),
          parsed.correlationId,
        ].join("\0"),
      )
      .digest("hex");
    const runId = stableUuid(`provider-sync-run\0${idempotencyKey}`);
    const createdAt = new Date().toISOString();

    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      await transaction`
        select pg_advisory_xact_lock(
          hashtextextended(
            ${`${tenant.organizationId}:${parsed.connectionId}`},
            0
          )
        )
      `;
      const replayed = await transaction`
        select *
        from provider_sync_runs
        where organization_id = ${tenant.organizationId}
          and idempotency_key = ${idempotencyKey}
        limit 1
      `;
      if (replayed[0]) return mapRun(replayed[0]);
      const connections = await transaction`
        select id, provider
        from data_source_connections
        where organization_id = ${tenant.organizationId}
          and id = ${parsed.connectionId}::uuid
          and provider in ('shopify', 'stripe')
          and status in ('healthy', 'backfilling', 'degraded', 'stale')
          and api_credential_reference is not null
        limit 1
        for update
      `;
      const connection = connections[0] ? databaseRow(connections[0]) : undefined;
      if (!connection) throw new Error("provider connection is not sync-enabled");
      const active = await transaction`
        select id
        from provider_sync_runs
        where organization_id = ${tenant.organizationId}
          and connection_id = ${parsed.connectionId}::uuid
          and status in ('queued', 'running')
        limit 1
      `;
      if (active.length > 0) throw new Error("provider connection already has an active sync");
      const provider = providerSchema.parse(connection["provider"]);
      const envelope = ProviderSyncJobEnvelopeSchema.parse({
        schemaVersion: 1,
        type: "connector.sync.requested",
        organizationId: tenant.organizationId,
        connectionId: parsed.connectionId,
        provider,
        syncRunId: runId,
        executionAttempt: 1,
        correlationId: parsed.correlationId,
        idempotencyKey: `${provider}:sync:${runId}:dispatch:1`,
        requestedBy: tenant.membershipId,
        createdAt,
        ...(traceContext ? { traceContext } : {}),
      });
      const inserted = await transaction`
        insert into provider_sync_runs (
          id, organization_id, connection_id, provider, mode, window_start, window_end,
          status, maximum_pages, idempotency_key, correlation_id,
          requested_by_membership_id, created_at, updated_at
        ) values (
          ${runId}, ${tenant.organizationId}, ${parsed.connectionId}::uuid, ${provider},
          ${parsed.mode}, ${normalizedStart}, ${normalizedEnd}, 'queued',
          ${parsed.maximumPages}, ${idempotencyKey}, ${parsed.correlationId},
          ${tenant.membershipId}, ${createdAt}, ${createdAt}
        )
        on conflict (organization_id, idempotency_key) do nothing
        returning *
      `;
      let row = inserted[0] ? databaseRow(inserted[0]) : undefined;
      if (!row) {
        const existing = await transaction`
          select *
          from provider_sync_runs
          where organization_id = ${tenant.organizationId}
            and idempotency_key = ${idempotencyKey}
          limit 1
        `;
        row = existing[0] ? databaseRow(existing[0]) : undefined;
      } else {
        await transaction`
          insert into outbox_events (
            id, organization_id, event_type, schema_version, idempotency_key,
            payload, correlation_id, execution_tracking_version
          ) values (
            ${stableUuid(`provider-sync-outbox\0${idempotencyKey}`)},
            ${tenant.organizationId}, ${envelope.type}, ${envelope.schemaVersion},
            ${envelope.idempotencyKey}, ${transaction.json(toJsonValue(envelope))},
            ${parsed.correlationId}, 1
          )
        `;
        await insertTenantAuditEvent(transaction, {
          organizationId: tenant.organizationId,
          actorType: "user",
          actorId: tenant.actorId,
          action: "provider_sync.requested",
          resourceType: "provider_sync_run",
          resourceId: runId,
          correlationId: parsed.correlationId,
          reason: parsed.reason,
          newValue: {
            connectionId: parsed.connectionId,
            provider,
            mode: parsed.mode,
            windowStart: normalizedStart,
            windowEnd: normalizedEnd,
            maximumPages: parsed.maximumPages,
            status: "queued",
          },
          versionContext: { schemaVersion: 1 },
          occurredAt: createdAt,
        });
      }
      if (!row) throw new Error("provider sync run could not be persisted");
      return mapRun(row);
    });
  }

  public async list(
    tenant: TenantContext,
    connectionId?: string,
  ): Promise<readonly ProviderSyncRun[]> {
    const requestedConnectionId = connectionId ? z.uuid().parse(connectionId) : undefined;
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select *
        from provider_sync_runs
        where organization_id = ${tenant.organizationId}
          and (
            ${requestedConnectionId ?? null}::uuid is null
            or connection_id = ${requestedConnectionId ?? null}::uuid
          )
        order by created_at desc, id desc
        limit 50
      `;
      return Array.from(rows, mapRun);
    });
  }

  public async loadForProcessing(
    envelopeInput: ProviderSyncJobEnvelope,
  ): Promise<ProviderSyncRunAuthority | undefined> {
    const envelope = ProviderSyncJobEnvelopeSchema.parse(envelopeInput);
    return withOrganizationTransaction(this.sql, envelope.organizationId, async (transaction) => {
      const rows = await transaction`
        select
          runs.*,
          connections.external_account_id,
          connections.api_credential_reference,
          connections.api_version as configured_api_version
        from provider_sync_runs as runs
        inner join data_source_connections as connections
          on connections.organization_id = runs.organization_id
          and connections.id = runs.connection_id
        where runs.organization_id = ${envelope.organizationId}
          and runs.id = ${envelope.syncRunId}::uuid
          and connections.status in ('healthy', 'backfilling', 'degraded', 'stale')
          and connections.api_credential_reference is not null
        limit 1
        for update of runs
      `;
      const row = rows[0] ? databaseRow(rows[0]) : undefined;
      if (!row) return undefined;
      if (row["status"] === "queued") {
        const startedAt = new Date().toISOString();
        const updated = await transaction`
          update provider_sync_runs
          set status = 'running',
              started_at = ${startedAt},
              updated_at = ${startedAt}
          where organization_id = ${envelope.organizationId}
            and id = ${envelope.syncRunId}::uuid
            and status = 'queued'
          returning *
        `;
        const updatedRow = updated[0] ? databaseRow(updated[0]) : row;
        return mapAuthority({
          ...updatedRow,
          external_account_id: row["external_account_id"],
          api_credential_reference: row["api_credential_reference"],
          configured_api_version: row["configured_api_version"],
        });
      }
      return mapAuthority(row);
    });
  }

  public async advancePage(
    envelopeInput: ProviderSyncJobEnvelope,
    input: {
      readonly expectedCursor?: string;
      readonly nextCursor?: string;
      readonly hasMore: boolean;
      readonly itemCount: number;
      readonly duplicateCount: number;
      readonly completedAt: string;
    },
  ): Promise<ProviderSyncRunAuthority> {
    const envelope = ProviderSyncJobEnvelopeSchema.parse(envelopeInput);
    const itemCount = z.number().int().min(0).max(100).parse(input.itemCount);
    const duplicateCount = z.number().int().min(0).max(itemCount).parse(input.duplicateCount);
    const nextCursor = input.nextCursor
      ? z.string().min(1).max(1024).parse(input.nextCursor)
      : undefined;
    const expectedCursor = input.expectedCursor
      ? z.string().min(1).max(1024).parse(input.expectedCursor)
      : undefined;
    const completedAt = z.iso.datetime({ offset: true }).parse(input.completedAt);

    return withOrganizationTransaction(this.sql, envelope.organizationId, async (transaction) => {
      const locked = await transaction`
        select *
        from provider_sync_runs
        where organization_id = ${envelope.organizationId}
          and id = ${envelope.syncRunId}::uuid
          and status = 'running'
        limit 1
        for update
      `;
      const row = locked[0] ? databaseRow(locked[0]) : undefined;
      if (!row) throw new Error("provider sync run is not active");
      const currentCursor =
        row["cursor"] === null ? undefined : databaseString(row["cursor"], "provider_sync.cursor");
      if (currentCursor !== expectedCursor) {
        throw new Error("provider sync cursor authority changed");
      }
      const currentPageCount = databaseInteger(row["page_count"], "provider_sync.page_count");
      const maximumPages = databaseInteger(row["maximum_pages"], "provider_sync.maximum_pages");
      const reachesLimit = input.hasMore && currentPageCount + 1 >= maximumPages;
      const status = reachesLimit ? "partial" : input.hasMore ? "running" : "succeeded";
      const updated = await transaction`
        update provider_sync_runs
        set cursor = ${input.hasMore ? (nextCursor ?? null) : null},
            status = ${status},
            page_count = page_count + 1,
            item_count = item_count + ${itemCount},
            duplicate_count = duplicate_count + ${duplicateCount},
            last_error_code = ${reachesLimit ? "PROVIDER_SYNC_PAGE_LIMIT_REACHED" : null},
            completed_at = ${status === "running" ? null : completedAt},
            updated_at = ${completedAt}
        where organization_id = ${envelope.organizationId}
          and id = ${envelope.syncRunId}::uuid
          and status = 'running'
        returning *
      `;
      const updatedRow = updated[0] ? databaseRow(updated[0]) : undefined;
      if (!updatedRow) throw new Error("provider sync progress could not be persisted");
      if (status === "succeeded") {
        await transaction`
          update data_source_connections
          set status = case when status = 'action_required' then status else 'healthy' end,
              last_successful_sync_at = greatest(
                coalesce(last_successful_sync_at, ${completedAt}),
                ${completedAt}
              ),
              updated_at = ${completedAt}
          where organization_id = ${envelope.organizationId}
            and id = ${envelope.connectionId}::uuid
        `;
      }
      if (status !== "running") {
        await insertTenantAuditEvent(transaction, {
          organizationId: envelope.organizationId,
          actorType: "worker",
          actorId: `${envelope.provider}-sync-worker`,
          action:
            status === "succeeded" ? "provider_sync.completed" : "provider_sync.page_limit_reached",
          resourceType: "provider_sync_run",
          resourceId: envelope.syncRunId,
          correlationId: envelope.correlationId,
          reason:
            status === "succeeded"
              ? "Bounded provider event capture completed"
              : "Provider sync stopped at the configured page ceiling",
          newValue: {
            status,
            pageCount: currentPageCount + 1,
            itemCount: databaseInteger(row["item_count"], "provider_sync.item_count") + itemCount,
            duplicateCount:
              databaseInteger(row["duplicate_count"], "provider_sync.duplicate_count") +
              duplicateCount,
          },
          versionContext: { schemaVersion: 1 },
          occurredAt: completedAt,
        });
      }
      return this.loadAuthorityFromRow(transaction, updatedRow);
    });
  }

  public async recordFailure(
    envelopeInput: ProviderSyncJobEnvelope,
    input: {
      readonly errorCode: string;
      readonly terminalRequested: boolean;
      readonly failedAt: string;
    },
  ): Promise<{ readonly terminal: boolean }> {
    const envelope = ProviderSyncJobEnvelopeSchema.parse(envelopeInput);
    const errorCode = errorCodeSchema.parse(input.errorCode);
    const failedAt = z.iso.datetime({ offset: true }).parse(input.failedAt);
    return withOrganizationTransaction(this.sql, envelope.organizationId, async (transaction) => {
      const rows = await transaction`
        select failed_attempts, status
        from provider_sync_runs
        where organization_id = ${envelope.organizationId}
          and id = ${envelope.syncRunId}::uuid
        limit 1
        for update
      `;
      const row = rows[0] ? databaseRow(rows[0]) : undefined;
      if (!row) return { terminal: true };
      const currentStatus = runStatusSchema.parse(row["status"]);
      if (["partial", "succeeded", "failed"].includes(currentStatus)) {
        return { terminal: true };
      }
      const attempts = databaseInteger(row["failed_attempts"], "provider_sync.failed_attempts") + 1;
      const terminal = input.terminalRequested || attempts >= 6;
      await transaction`
        update provider_sync_runs
        set status = ${terminal ? "failed" : "running"},
            failed_attempts = ${attempts},
            last_error_code = ${errorCode},
            started_at = coalesce(started_at, ${failedAt}),
            completed_at = ${terminal ? failedAt : null},
            updated_at = ${failedAt}
        where organization_id = ${envelope.organizationId}
          and id = ${envelope.syncRunId}::uuid
          and status in ('queued', 'running')
      `;
      if (terminal) {
        await transaction`
          update data_source_connections
          set status = case when status = 'action_required' then status else 'degraded' end,
              updated_at = ${failedAt}
          where organization_id = ${envelope.organizationId}
            and id = ${envelope.connectionId}::uuid
        `;
        await insertTenantAuditEvent(transaction, {
          organizationId: envelope.organizationId,
          actorType: "worker",
          actorId: `${envelope.provider}-sync-worker`,
          action: "provider_sync.failed",
          resourceType: "provider_sync_run",
          resourceId: envelope.syncRunId,
          correlationId: envelope.correlationId,
          reason: errorCode,
          newValue: { status: "failed", failedAttempts: attempts, errorCode },
          versionContext: { schemaVersion: 1 },
          occurredAt: failedAt,
        });
      }
      return { terminal };
    });
  }

  private async loadAuthorityFromRow(
    transaction: TransactionSql,
    runRow: Record<string, unknown>,
  ): Promise<ProviderSyncRunAuthority> {
    const organizationId = OrganizationIdSchema.parse(runRow["organization_id"]);
    const connectionId = z.uuid().parse(runRow["connection_id"]);
    const connection = await transaction`
      select external_account_id, api_credential_reference, api_version
      from data_source_connections
      where organization_id = ${organizationId}
        and id = ${connectionId}::uuid
      limit 1
    `;
    const connectionRow = connection[0] ? databaseRow(connection[0]) : undefined;
    if (!connectionRow) throw new Error("provider sync connection disappeared");
    return mapAuthority({
      ...runRow,
      external_account_id: connectionRow["external_account_id"],
      api_credential_reference: connectionRow["api_credential_reference"],
      configured_api_version: connectionRow["api_version"],
    });
  }
}

function mapRun(value: unknown): ProviderSyncRun {
  const row = databaseRow(value);
  return {
    id: z.uuid().parse(row["id"]),
    organizationId: OrganizationIdSchema.parse(row["organization_id"]),
    connectionId: z.uuid().parse(row["connection_id"]),
    provider: providerSchema.parse(row["provider"]),
    mode: modeSchema.parse(row["mode"]),
    windowStart: databaseTimestamp(row["window_start"], "provider_sync.window_start"),
    windowEnd: databaseTimestamp(row["window_end"], "provider_sync.window_end"),
    status: runStatusSchema.parse(row["status"]),
    pageCount: databaseInteger(row["page_count"], "provider_sync.page_count"),
    itemCount: databaseInteger(row["item_count"], "provider_sync.item_count"),
    duplicateCount: databaseInteger(row["duplicate_count"], "provider_sync.duplicate_count"),
    maximumPages: databaseInteger(row["maximum_pages"], "provider_sync.maximum_pages"),
    failedAttempts: databaseInteger(row["failed_attempts"], "provider_sync.failed_attempts"),
    requesterType: requesterTypeSchema.parse(row["requester_type"]),
    ...(row["last_error_code"]
      ? { lastErrorCode: errorCodeSchema.parse(row["last_error_code"]) }
      : {}),
    ...(row["started_at"]
      ? { startedAt: databaseTimestamp(row["started_at"], "provider_sync.started_at") }
      : {}),
    ...(row["completed_at"]
      ? { completedAt: databaseTimestamp(row["completed_at"], "provider_sync.completed_at") }
      : {}),
    createdAt: databaseTimestamp(row["created_at"], "provider_sync.created_at"),
  };
}

function mapAuthority(value: unknown): ProviderSyncRunAuthority {
  const row = databaseRow(value);
  return {
    runId: z.uuid().parse(row["id"]),
    organizationId: OrganizationIdSchema.parse(row["organization_id"]),
    connectionId: z.uuid().parse(row["connection_id"]),
    provider: providerSchema.parse(row["provider"]),
    externalAccountId: databaseString(row["external_account_id"], "connection.external_account_id"),
    apiCredentialReference: z
      .string()
      .regex(
        /^(?:env:RECONAI_CONNECTOR_[A-Z0-9_]{1,100}|sealed:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u,
      )
      .parse(row["api_credential_reference"]),
    ...(row["configured_api_version"]
      ? {
          configuredApiVersion: databaseString(
            row["configured_api_version"],
            "connection.api_version",
          ),
        }
      : {}),
    mode: modeSchema.parse(row["mode"]),
    windowStart: databaseTimestamp(row["window_start"], "provider_sync.window_start"),
    windowEnd: databaseTimestamp(row["window_end"], "provider_sync.window_end"),
    ...(row["cursor"] ? { cursor: databaseString(row["cursor"], "provider_sync.cursor") } : {}),
    status: runStatusSchema.parse(row["status"]),
    pageCount: databaseInteger(row["page_count"], "provider_sync.page_count"),
    itemCount: databaseInteger(row["item_count"], "provider_sync.item_count"),
    duplicateCount: databaseInteger(row["duplicate_count"], "provider_sync.duplicate_count"),
    maximumPages: databaseInteger(row["maximum_pages"], "provider_sync.maximum_pages"),
    failedAttempts: databaseInteger(row["failed_attempts"], "provider_sync.failed_attempts"),
    requesterType: requesterTypeSchema.parse(row["requester_type"]),
    requestedBy: mapRequester(row),
    correlationId: z.uuid().parse(row["correlation_id"]),
  };
}

function mapRequester(row: Record<string, unknown>): string {
  const requesterType = requesterTypeSchema.parse(row["requester_type"]);
  if (requesterType === "user") {
    return z.uuid().parse(row["requested_by_membership_id"]);
  }
  return z.literal("provider-gap-repair-scheduler").parse(row["requested_by_service"]);
}

async function withTenantTransaction<T>(
  sql: Sql,
  tenant: TenantContext,
  operation: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return withOrganizationTransaction(sql, tenant.organizationId, operation);
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

function databaseRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("database row is invalid");
  return value as Record<string, unknown>;
}

function databaseString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} is invalid`);
  return value;
}

function databaseInteger(value: unknown, name: string): number {
  const parsed = z.coerce.number().int().safeParse(value);
  if (!parsed.success) throw new Error(`${name} is invalid`);
  return parsed.data;
}

function databaseTimestamp(value: unknown, name: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new Error(`${name} is invalid`);
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

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

const scheduledGapRepairCandidateSchema = z.object({
  organizationId: OrganizationIdSchema,
  connectionId: z.uuid(),
  provider: providerSchema,
  lastSuccessfulSyncAt: z.iso.datetime({ offset: true }).optional(),
});
