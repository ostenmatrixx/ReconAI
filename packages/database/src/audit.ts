import { createHash, randomUUID } from "node:crypto";

import type { TenantContext } from "@workspace/domain";
import type { TransactionSql } from "postgres";

const auditHashVersion = 2;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export type AuditJsonValue =
  null | boolean | number | string | AuditJsonValue[] | { readonly [key: string]: AuditJsonValue };

export interface TenantAuditEvent {
  readonly organizationId: string;
  readonly actorType: "user" | "worker" | "system" | "support";
  readonly actorId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly correlationId: string;
  readonly reason: string;
  readonly previousValue?: unknown;
  readonly newValue: unknown;
  readonly versionContext: unknown;
  readonly occurredAt?: string;
}

export interface AuditEventHashV2Input {
  readonly id: string;
  readonly organizationId: string;
  readonly actorType: TenantAuditEvent["actorType"];
  readonly actorId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly reason: string | null;
  readonly previousValue: AuditJsonValue | null;
  readonly newValue: AuditJsonValue;
  readonly versionContext: AuditJsonValue;
  readonly previousEventHash: string | null;
}

export class AuditChainIntegrityError extends Error {
  override readonly name = "AuditChainIntegrityError";

  constructor(message = "audit chain does not have exactly one topological head") {
    super(message);
  }
}

export async function insertTenantAuditEvent(
  transaction: TransactionSql,
  event: TenantAuditEvent,
): Promise<void> {
  await transaction`
    select pg_advisory_xact_lock(hashtextextended(${event.organizationId}, 0))
  `;
  const heads = await transaction`
    select candidate.event_hash
    from audit_events candidate
    where candidate.organization_id = ${event.organizationId}
      and not exists (
        select 1
        from audit_events child
        where child.organization_id = candidate.organization_id
          and child.previous_event_hash = candidate.event_hash
      )
    order by candidate.event_hash
    limit 2
  `;
  if (heads.length > 1) throw new AuditChainIntegrityError();
  if (heads.length === 0) {
    const existing = await transaction`
      select 1 from audit_events
      where organization_id = ${event.organizationId}
      limit 1
    `;
    if (existing.length > 0) throw new AuditChainIntegrityError("audit chain has no head");
  }
  const previousHash = auditHashOrUndefined(heads[0]?.["event_hash"]);
  const id = randomUUID();
  const occurredAt = normalizeInstant(event.occurredAt ?? new Date().toISOString());
  const previousValue = event.previousValue === undefined ? null : toJsonValue(event.previousValue);
  const newValue = toJsonValue(event.newValue);
  const versionContext = toJsonValue(event.versionContext);
  const hash = computeAuditEventHashV2({
    id,
    organizationId: event.organizationId,
    actorType: event.actorType,
    actorId: event.actorId,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    occurredAt,
    correlationId: event.correlationId,
    reason: event.reason,
    previousValue,
    newValue,
    versionContext,
    previousEventHash: previousHash ?? null,
  });
  await transaction`
    insert into audit_events (
      id, organization_id, actor_type, actor_id, action, resource_type, resource_id,
      occurred_at, correlation_id, reason, previous_value, new_value, version_context,
      previous_event_hash, event_hash, hash_version
    ) values (
      ${id}, ${event.organizationId}, ${event.actorType}, ${event.actorId}, ${event.action},
      ${event.resourceType}, ${event.resourceId}, ${occurredAt}, ${event.correlationId},
      ${event.reason}, ${previousValue === null ? null : transaction.json(previousValue)},
      ${transaction.json(newValue)}, ${transaction.json(versionContext)},
      ${previousHash ?? null}, ${hash}, ${auditHashVersion}
    )
  `;
}

export function computeAuditEventHashV2(input: AuditEventHashV2Input): string {
  const previousEventHash =
    input.previousEventHash === null ? null : requireAuditHash(input.previousEventHash);
  const occurredAt = normalizeInstant(input.occurredAt);
  return createHash("sha256")
    .update(
      stableJsonStringify({
        action: input.action,
        actorId: input.actorId,
        actorType: input.actorType,
        correlationId: input.correlationId,
        eventHashVersion: auditHashVersion,
        id: input.id,
        newValue: input.newValue,
        occurredAt,
        organizationId: input.organizationId,
        previousEventHash,
        previousValue: input.previousValue,
        reason: input.reason,
        resourceId: input.resourceId,
        resourceType: input.resourceType,
        versionContext: input.versionContext,
      }),
    )
    .digest("hex");
}

function stableJsonStringify(value: AuditJsonValue): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: AuditJsonValue): AuditJsonValue {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item));
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, AuditJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) throw new Error("audit JSON contains an undefined value");
      sorted[key] = sortJsonValue(item);
    }
    return sorted;
  }
  return value;
}

function normalizeInstant(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()))
    throw new Error("audit occurredAt must be a valid instant");
  return timestamp.toISOString();
}

function requireAuditHash(value: string): string {
  const normalized = value.trim();
  if (!sha256Pattern.test(normalized)) {
    throw new AuditChainIntegrityError("database returned an invalid audit hash");
  }
  return normalized;
}

function auditHashOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return requireAuditHash(value);
  throw new AuditChainIntegrityError("database returned an invalid audit hash");
}

export async function insertUserAuditEvent(
  transaction: TransactionSql,
  tenant: TenantContext,
  event: Omit<TenantAuditEvent, "organizationId" | "actorType" | "actorId" | "correlationId"> & {
    readonly correlationId?: string;
  },
): Promise<void> {
  await insertTenantAuditEvent(transaction, {
    ...event,
    organizationId: tenant.organizationId,
    actorType: "user",
    actorId: tenant.actorId,
    correlationId: event.correlationId ?? randomUUID(),
  });
}

function toJsonValue(value: unknown): AuditJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      return item;
    }),
  ) as AuditJsonValue;
}
