import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  SUPPORT_ACCESS_MAXIMUM_DURATION_MINUTES,
  SUPPORT_ACCESS_MINIMUM_DURATION_MINUTES,
  SupportAccessGrantIdSchema,
  SupportAccessRequestCodeSchema,
  SupportCapabilitySchema,
  SupportIdentityDigestSchema,
  type OrganizationId,
  type SupportAccessGrantId,
  type SupportAccessRequestCode,
  type SupportIdentityDigest,
  type TenantContext,
} from "@workspace/domain";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { insertTenantAuditEvent, insertUserAuditEvent } from "./audit.js";
import { withTenantTransaction } from "./tenant-transaction.js";

const reasonSchema = z.string().trim().min(3).max(2000).refine(hasNoControlCharacters);
const ticketReferenceSchema = z.string().trim().min(3).max(200).refine(hasNoControlCharacters);
const supportIdentityReferenceSchema = z.string().regex(/^[a-f0-9]{12}$/u);
const supportGrantStatusSchema = z.enum(["active", "expired", "revoked"]);
const supportRevokeOutcomeSchema = z.enum(["revoked", "already_revoked"]);

export interface SupportAccessRequest {
  readonly requestCode: SupportAccessRequestCode;
  readonly requestExpiresAt: string;
}

export interface SupportAccessGrant {
  readonly id: SupportAccessGrantId;
  readonly supportIdentityReference: string;
  readonly capability: "diagnostics:view";
  readonly ticketReference: string;
  readonly reason: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly status: "active" | "expired" | "revoked";
  readonly revokedAt?: string;
  readonly revocationReason?: string;
}

export interface SupportAccessRevocation {
  readonly outcome: "revoked" | "already_revoked";
  readonly grant: Omit<SupportAccessGrant, "reason" | "approvedAt" | "status" | "revocationReason">;
}

export interface SupportDiagnostics {
  readonly schemaVersion: "support-diagnostics-v1";
  readonly generatedAt: string;
  readonly grantExpiresAt: string;
  readonly countsCapped: boolean;
  readonly connections: {
    readonly total: number;
    readonly nonHealthy: number;
    readonly latestSuccessfulSyncAt?: string;
  };
  readonly providerSyncs: {
    readonly active: number;
    readonly failed: number;
    readonly latestCompletedAt?: string;
  };
  readonly reconciliations: {
    readonly active: number;
    readonly failedOrPartial: number;
    readonly latestCompletedAt?: string;
  };
  readonly exceptions: {
    readonly unresolved: number;
    readonly oldestUnresolvedAt?: string;
  };
  readonly outbox: {
    readonly unpublished: number;
    readonly deadLettered: number;
    readonly oldestUnpublishedAt?: string;
  };
}

export class SupportAccessNotFoundError extends Error {
  public constructor() {
    super("support access authority was not found");
    this.name = "SupportAccessNotFoundError";
  }
}

export interface SupportAccessRepository {
  createRequest(
    supportIdentityDigest: SupportIdentityDigest,
    input: { readonly requestedDurationMinutes: number },
  ): Promise<SupportAccessRequest>;
  approve(
    tenant: TenantContext,
    input: {
      readonly requestCode: SupportAccessRequestCode;
      readonly ticketReference: string;
      readonly reason: string;
      readonly correlationId: string;
    },
  ): Promise<SupportAccessGrant>;
  list(tenant: TenantContext, limit: number): Promise<readonly SupportAccessGrant[]>;
  revoke(
    tenant: TenantContext,
    input: {
      readonly grantId: SupportAccessGrantId;
      readonly reason: string;
      readonly correlationId: string;
    },
  ): Promise<SupportAccessRevocation>;
  diagnostics(
    organizationId: OrganizationId,
    grantId: SupportAccessGrantId,
    supportIdentityDigest: SupportIdentityDigest,
    correlationId: string,
  ): Promise<SupportDiagnostics>;
}

export class PostgresSupportAccessRepository implements SupportAccessRepository {
  public constructor(private readonly sql: Sql) {}

  public async createRequest(
    supportIdentityDigestValue: SupportIdentityDigest,
    input: { readonly requestedDurationMinutes: number },
  ): Promise<SupportAccessRequest> {
    const supportIdentityDigest = SupportIdentityDigestSchema.parse(supportIdentityDigestValue);
    const requestedDurationMinutes = z
      .number()
      .int()
      .min(SUPPORT_ACCESS_MINIMUM_DURATION_MINUTES)
      .max(SUPPORT_ACCESS_MAXIMUM_DURATION_MINUTES)
      .parse(input.requestedDurationMinutes);
    const requestCode = SupportAccessRequestCodeSchema.parse(randomBytes(32).toString("base64url"));
    const requestTokenSha256 = createHash("sha256").update(requestCode).digest("hex");
    const createdAt = new Date().toISOString();
    const rows = await this.sql`
      select request_expires_at
      from public.reconai_create_support_access_request(
        ${randomUUID()}::uuid,
        ${supportIdentityDigest},
        ${requestTokenSha256},
        ${requestedDurationMinutes},
        ${createdAt}::timestamptz
      )
    `;
    const row = requiredRow(rows[0]);
    return {
      requestCode,
      requestExpiresAt: databaseTimestamp(row["request_expires_at"], "requestExpiresAt"),
    };
  }

  public async approve(
    tenant: TenantContext,
    input: {
      readonly requestCode: SupportAccessRequestCode;
      readonly ticketReference: string;
      readonly reason: string;
      readonly correlationId: string;
    },
  ): Promise<SupportAccessGrant> {
    const requestCode = SupportAccessRequestCodeSchema.parse(input.requestCode);
    const ticketReference = ticketReferenceSchema.parse(input.ticketReference);
    const reason = reasonSchema.parse(input.reason);
    const requestTokenSha256 = createHash("sha256").update(requestCode).digest("hex");
    const grantId = SupportAccessGrantIdSchema.parse(randomUUID());
    const approvedAt = new Date().toISOString();
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select *
        from public.reconai_approve_support_access_request(
          ${tenant.organizationId}::uuid,
          ${grantId}::uuid,
          ${tenant.membershipId}::uuid,
          ${requestTokenSha256},
          ${ticketReference},
          ${reason},
          ${approvedAt}::timestamptz
        )
      `;
      const row = rows[0];
      if (!row) throw new SupportAccessNotFoundError();
      const grant = parseApprovedGrant(row);
      await insertUserAuditEvent(transaction, tenant, {
        action: "support.access.approved",
        resourceType: "support_access_grant",
        resourceId: grant.id,
        correlationId: input.correlationId,
        reason,
        newValue: {
          capability: grant.capability,
          expiresAt: grant.expiresAt,
          status: grant.status,
          supportIdentityReference: grant.supportIdentityReference,
          ticketReference,
        },
        versionContext: { supportAccessPolicyVersion: 1 },
      });
      return grant;
    });
  }

  public async list(
    tenant: TenantContext,
    limitValue: number,
  ): Promise<readonly SupportAccessGrant[]> {
    const limit = z.number().int().min(1).max(100).parse(limitValue);
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select *
        from public.reconai_list_support_access_grants(
          ${tenant.organizationId}::uuid,
          ${tenant.membershipId}::uuid,
          ${limit}
        )
      `;
      return rows.map(parseListedGrant);
    });
  }

  public async revoke(
    tenant: TenantContext,
    input: {
      readonly grantId: SupportAccessGrantId;
      readonly reason: string;
      readonly correlationId: string;
    },
  ): Promise<SupportAccessRevocation> {
    const grantId = SupportAccessGrantIdSchema.parse(input.grantId);
    const reason = reasonSchema.parse(input.reason);
    const revokedAt = new Date().toISOString();
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select *
        from public.reconai_revoke_support_access_grant(
          ${tenant.organizationId}::uuid,
          ${grantId}::uuid,
          ${tenant.membershipId}::uuid,
          ${reason},
          ${revokedAt}::timestamptz
        )
      `;
      const row = rows[0];
      if (!row) throw new SupportAccessNotFoundError();
      const revocation = parseRevocation(row, grantId);
      if (revocation.outcome === "revoked") {
        await insertUserAuditEvent(transaction, tenant, {
          action: "support.access.revoked",
          resourceType: "support_access_grant",
          resourceId: grantId,
          correlationId: input.correlationId,
          reason,
          newValue: {
            capability: revocation.grant.capability,
            revokedAt: revocation.grant.revokedAt,
            status: "revoked",
            supportIdentityReference: revocation.grant.supportIdentityReference,
            ticketReference: revocation.grant.ticketReference,
          },
          versionContext: { supportAccessPolicyVersion: 1 },
        });
      }
      return revocation;
    });
  }

  public async diagnostics(
    organizationId: OrganizationId,
    grantIdValue: SupportAccessGrantId,
    supportIdentityDigestValue: SupportIdentityDigest,
    correlationId: string,
  ): Promise<SupportDiagnostics> {
    const grantId = SupportAccessGrantIdSchema.parse(grantIdValue);
    const supportIdentityDigest = SupportIdentityDigestSchema.parse(supportIdentityDigestValue);
    return this.#withSupportTransaction(organizationId, async (transaction) => {
      const rows = await transaction`
        select *
        from public.reconai_support_diagnostics(
          ${organizationId}::uuid,
          ${grantId}::uuid,
          ${supportIdentityDigest}
        )
      `;
      const row = rows[0];
      if (!row) throw new SupportAccessNotFoundError();
      const diagnostics = parseDiagnostics(row);
      await insertTenantAuditEvent(transaction, {
        organizationId,
        actorType: "support",
        actorId: supportIdentityDigest,
        action: "support.diagnostics.viewed",
        resourceType: "support_access_grant",
        resourceId: grantId,
        correlationId,
        reason: "Approved restricted support diagnostics accessed",
        newValue: {
          countsCapped: diagnostics.countsCapped,
          diagnosticsSchemaVersion: diagnostics.schemaVersion,
          grantExpiresAt: diagnostics.grantExpiresAt,
        },
        versionContext: {
          supportAccessPolicyVersion: 1,
          supportDiagnosticsSchemaVersion: 1,
        },
      });
      return diagnostics;
    });
  }

  async #withSupportTransaction<T>(
    organizationId: OrganizationId,
    operation: (transaction: TransactionSql) => Promise<T>,
  ): Promise<T> {
    return this.sql.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
      const context =
        await transaction`select current_setting('app.organization_id', true) as organization_id`;
      if (context[0]?.["organization_id"] !== organizationId) {
        throw new Error("database support tenant context was not established");
      }
      return operation(transaction);
    }) as Promise<T>;
  }
}

function parseApprovedGrant(value: unknown): SupportAccessGrant {
  const row = requiredRow(value);
  const supportIdentityDigest = SupportIdentityDigestSchema.parse(
    databaseString(row["support_identity_digest"], "supportIdentityDigest"),
  );
  return {
    id: SupportAccessGrantIdSchema.parse(row["grant_id"]),
    supportIdentityReference: supportIdentityDigest.slice(0, 12),
    capability: SupportCapabilitySchema.parse(row["capability"]),
    ticketReference: ticketReferenceSchema.parse(row["ticket_reference"]),
    reason: reasonSchema.parse(row["reason"]),
    approvedAt: databaseTimestamp(row["approved_at"], "approvedAt"),
    expiresAt: databaseTimestamp(row["expires_at"], "expiresAt"),
    status: "active",
  };
}

function parseListedGrant(value: unknown): SupportAccessGrant {
  const row = requiredRow(value);
  const revokedAt = optionalDatabaseTimestamp(row["revoked_at"], "revokedAt");
  const revocationReason =
    row["revocation_reason"] === null || row["revocation_reason"] === undefined
      ? undefined
      : reasonSchema.parse(row["revocation_reason"]);
  return {
    id: SupportAccessGrantIdSchema.parse(row["grant_id"]),
    supportIdentityReference: supportIdentityReferenceSchema.parse(
      row["support_identity_reference"],
    ),
    capability: SupportCapabilitySchema.parse(row["capability"]),
    ticketReference: ticketReferenceSchema.parse(row["ticket_reference"]),
    reason: reasonSchema.parse(row["reason"]),
    approvedAt: databaseTimestamp(row["approved_at"], "approvedAt"),
    expiresAt: databaseTimestamp(row["expires_at"], "expiresAt"),
    status: supportGrantStatusSchema.parse(row["grant_status"]),
    ...(revokedAt ? { revokedAt } : {}),
    ...(revocationReason ? { revocationReason } : {}),
  };
}

function parseRevocation(value: unknown, grantId: SupportAccessGrantId): SupportAccessRevocation {
  const row = requiredRow(value);
  return {
    outcome: supportRevokeOutcomeSchema.parse(row["outcome"]),
    grant: {
      id: grantId,
      supportIdentityReference: supportIdentityReferenceSchema.parse(
        row["support_identity_reference"],
      ),
      capability: SupportCapabilitySchema.parse(row["capability"]),
      ticketReference: ticketReferenceSchema.parse(row["ticket_reference"]),
      expiresAt: databaseTimestamp(row["expires_at"], "expiresAt"),
      revokedAt: databaseTimestamp(row["revoked_at"], "revokedAt"),
    },
  };
}

function parseDiagnostics(value: unknown): SupportDiagnostics {
  const row = requiredRow(value);
  return {
    schemaVersion: "support-diagnostics-v1",
    generatedAt: databaseTimestamp(row["generated_at"], "generatedAt"),
    grantExpiresAt: databaseTimestamp(row["grant_expires_at"], "grantExpiresAt"),
    countsCapped: databaseBoolean(row["counts_capped"], "countsCapped"),
    connections: {
      total: databaseCount(row["connection_count"], "connectionCount"),
      nonHealthy: databaseCount(row["non_healthy_connection_count"], "nonHealthyConnectionCount"),
      ...optionalTimestampProperty("latestSuccessfulSyncAt", row["latest_successful_sync_at"]),
    },
    providerSyncs: {
      active: databaseCount(row["provider_sync_active_count"], "providerSyncActiveCount"),
      failed: databaseCount(row["provider_sync_failed_count"], "providerSyncFailedCount"),
      ...optionalTimestampProperty("latestCompletedAt", row["latest_provider_sync_completed_at"]),
    },
    reconciliations: {
      active: databaseCount(row["reconciliation_active_count"], "reconciliationActiveCount"),
      failedOrPartial: databaseCount(
        row["reconciliation_failed_count"],
        "reconciliationFailedCount",
      ),
      ...optionalTimestampProperty("latestCompletedAt", row["latest_reconciliation_completed_at"]),
    },
    exceptions: {
      unresolved: databaseCount(row["unresolved_exception_count"], "unresolvedExceptionCount"),
      ...optionalTimestampProperty("oldestUnresolvedAt", row["oldest_unresolved_exception_at"]),
    },
    outbox: {
      unpublished: databaseCount(row["unpublished_outbox_count"], "unpublishedOutboxCount"),
      deadLettered: databaseCount(row["dead_lettered_outbox_count"], "deadLetteredOutboxCount"),
      ...optionalTimestampProperty("oldestUnpublishedAt", row["oldest_unpublished_outbox_at"]),
    },
  };
}

function requiredRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("database returned an invalid support access row");
  }
  return value as Record<string, unknown>;
}

function databaseString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`database returned an invalid ${field}`);
  return value;
}

function databaseTimestamp(value: unknown, field: string): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string") {
    const timestamp = new Date(value);
    if (Number.isFinite(timestamp.getTime())) return timestamp.toISOString();
  }
  throw new Error(`database returned an invalid ${field}`);
}

function optionalDatabaseTimestamp(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return databaseTimestamp(value, field);
}

function optionalTimestampProperty(key: string, value: unknown): Readonly<Record<string, string>> {
  const timestamp = optionalDatabaseTimestamp(value, key);
  return timestamp ? { [key]: timestamp } : {};
}

function databaseCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`database returned an invalid ${field}`);
  }
  return value;
}

function databaseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`database returned an invalid ${field}`);
  return value;
}

function hasNoControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return false;
  }
  return true;
}
