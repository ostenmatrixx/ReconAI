import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  CanonicalRecordSchema,
  InvitationEmailSchema,
  MembershipIdSchema,
  MembershipPolicyError,
  OrganizationNameSchema,
  OrganizationIdSchema,
  RoleSchema,
  UserIdSchema,
  requiredApprovalsForResolution,
  tenantContextFromMembership,
  validateInvitationRole,
  validateMembershipTransition,
  type CanonicalRecord,
  type ResolutionConfidence,
  type Role,
  type TenantContext,
} from "@workspace/domain";
import {
  ReconciliationRunJobEnvelopeSchema,
  SourceObjectFamilySchema,
  type ReconciliationRunJobEnvelope,
  type SourceObjectFamily,
} from "@workspace/connectors";
import { protectCsvFormula } from "@workspace/connector-csv";
import { insertUserAuditEvent, withTenantTransaction } from "@workspace/database";
import {
  MAX_RECONCILIATION_RECORDS,
  RuleEvidenceSchema,
  identifyReconciliation,
  reconciliationRecordIdentity,
  serializeReconciliationPolicy,
  type ReconciliationPolicy,
} from "@workspace/reconciliation";
import type { JSONValue, Sql, TransactionSql } from "postgres";
import { z } from "zod";

import type { VerifiedIdentity } from "./auth.js";

export interface ExceptionListItem {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly severity: string;
  readonly sources: readonly ExceptionSource[];
  readonly confidence: ResolutionConfidence;
  readonly assignee: ExceptionAssigneeFilter;
  readonly amountMinor?: string;
  readonly currency?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ExceptionSource = "shopify" | "stripe" | "accounting_csv";
export type ExceptionSourceFilter = ExceptionSource | "unclassified";
export type ExceptionAssigneeFilter = "me" | "assigned" | "unassigned";
export type ExceptionAgeFilter =
  "under_24h" | "one_to_seven_days" | "seven_to_thirty_days" | "over_30_days";

export interface ExceptionQueueSummary {
  readonly open: number;
  readonly high: number;
  readonly awaitingApproval: number;
  readonly decided: number;
}

export interface ExceptionListOptions {
  readonly status?: string;
  readonly severity?: string;
  readonly search?: string;
  readonly source?: ExceptionSourceFilter;
  readonly amountCurrency?: string;
  readonly minimumAmountMinor?: string;
  readonly maximumAmountMinor?: string;
  readonly confidence?: ResolutionConfidence;
  readonly assignee?: ExceptionAssigneeFilter;
  readonly age?: ExceptionAgeFilter;
  readonly cursor?: string;
  readonly limit: number;
}

export interface ExceptionListPage {
  readonly items: readonly ExceptionListItem[];
  readonly filteredCount: number;
  readonly summary: ExceptionQueueSummary;
  readonly nextCursor?: string;
}

export const MAX_EXCEPTION_EXPORT_ROWS = 10_000;
export const MAX_EXCEPTION_EXPORT_BYTES = 5 * 1024 * 1024;
export const EXCEPTION_EXPORT_FILENAME = "reconai-exception-queue.csv";
export const MAX_EXCEPTION_SOURCE_REFERENCES = 500;
export const RECONCILIATION_RUN_INPUT_INSERT_BATCH_SIZE = 1_000;
export const DEFAULT_RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS = 30_000;
export const MIN_RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS = 5_000;
export const MAX_RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS = 120_000;
export const DEFAULT_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS = 2;
export const MIN_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS = 1;
export const MAX_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS = 10;

export function reconciliationRunTransactionTimeoutMilliseconds(
  value = DEFAULT_RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS ||
    value > MAX_RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS
  ) {
    throw new RangeError(
      `reconciliation run transaction timeout must be an integer from ${MIN_RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS.toString()} to ${MAX_RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS.toString()} milliseconds`,
    );
  }
  return value;
}

export function reconciliationRunMaximumConcurrentTransactions(
  value = DEFAULT_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS ||
    value > MAX_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS
  ) {
    throw new RangeError(
      `maximum concurrent reconciliation run transactions must be an integer from ${MIN_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS.toString()} to ${MAX_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS.toString()}`,
    );
  }
  return value;
}

/**
 * Bounds heavyweight run-authority transactions admitted by one API process. Rejection is
 * retry-safe; callers must retain a lease until hidden pool work settles after any early response.
 */
export class ReconciliationRunAdmission {
  private activeTransactions = 0;

  public constructor(
    private readonly maximumTransactions = DEFAULT_RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS,
  ) {
    reconciliationRunMaximumConcurrentTransactions(maximumTransactions);
  }

  public acquire(): (() => void) | undefined {
    if (this.activeTransactions >= this.maximumTransactions) return undefined;
    this.activeTransactions += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeTransactions -= 1;
    };
  }
}

export interface ReconciliationRunInputIdentity {
  readonly id: string;
  readonly version: number;
  readonly contentSha256: string;
}

export interface ReconciliationRunInputInsertValue {
  readonly organization_id: string;
  readonly run_id: string;
  readonly record_id: string;
  readonly record_version: number;
  readonly content_sha256: string;
  readonly ordinal: number;
}

/**
 * Builds bounded input rows while retaining the deterministic snapshot ordinal across batches.
 * Six parameters per row keep each 1,000-row statement comfortably below PostgreSQL's limit.
 */
export function* reconciliationRunInputInsertBatches(
  organizationId: string,
  runId: string,
  identities: readonly ReconciliationRunInputIdentity[],
): Generator<readonly ReconciliationRunInputInsertValue[]> {
  for (
    let offset = 0;
    offset < identities.length;
    offset += RECONCILIATION_RUN_INPUT_INSERT_BATCH_SIZE
  ) {
    yield identities
      .slice(offset, offset + RECONCILIATION_RUN_INPUT_INSERT_BATCH_SIZE)
      .map((identity, batchIndex) => ({
        organization_id: organizationId,
        run_id: runId,
        record_id: identity.id,
        record_version: identity.version,
        content_sha256: identity.contentSha256,
        ordinal: offset + batchIndex,
      }));
  }
}

export interface ExceptionExportFilters {
  readonly status?: string;
  readonly severity?: string;
  readonly search?: string;
  readonly source?: ExceptionSourceFilter;
  readonly amountCurrency?: string;
  readonly minimumAmountMinor?: string;
  readonly maximumAmountMinor?: string;
  readonly confidence?: ResolutionConfidence;
  readonly assignee?: ExceptionAssigneeFilter;
  readonly age?: ExceptionAgeFilter;
}

export interface ExceptionExportResult {
  readonly id: string;
  readonly csv: string;
  readonly rowCount: number;
}

export interface ExceptionDetail extends ExceptionListItem {
  readonly recordReferences: readonly string[];
  readonly recordReferencesStatus: "available" | "unavailable";
  readonly evidence: DeterministicEvidenceView;
  readonly sourceRecords: readonly SourceRecordEvidence[];
  readonly assigneeMembershipId?: string;
  readonly deferredUntil?: string;
  readonly notes: readonly ExceptionNote[];
  readonly timeline: readonly ExceptionTimelineEvent[];
  readonly timelineTruncated: boolean;
  readonly latestProposal?: {
    readonly id: string;
    readonly version: number;
    readonly type: string;
    readonly reason: string;
    readonly status: string;
    readonly proposedBy?: string;
    readonly canRevise: boolean;
    readonly approvalCount: number;
    readonly requiredApprovals: number;
    readonly createdAt: string;
  };
}

export interface ProposalCreationResult {
  readonly id: string;
  readonly version: number;
  readonly revisedFrom?: {
    readonly id: string;
    readonly version: number;
    readonly approvalCount: number;
  };
}

export interface ExceptionNote {
  readonly id: string;
  readonly authorMembershipId: string;
  readonly authorEmail?: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface ExceptionTimelineEvent {
  readonly id: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly actorType: "user" | "worker" | "system" | "support";
  readonly actorId?: string;
  readonly reason?: string;
  readonly occurredAt: string;
}

export type ExceptionWorkflowInput =
  | {
      readonly action: "assign_self" | "reopen";
      readonly reason: string;
    }
  | {
      readonly action: "defer";
      readonly deferredUntil: string;
      readonly reason: string;
    };

export interface ExceptionWorkflowResult {
  readonly id: string;
  readonly status: "open" | "assigned" | "deferred";
  readonly assigneeMembershipId?: string;
  readonly deferredUntil?: string;
}

export interface ReviewPolicy {
  readonly dualApprovalEnabled: boolean;
  readonly dualApprovalThresholds: Readonly<Record<string, string>>;
  readonly sensitiveResolutionTypes: readonly string[];
  readonly updatedAt: string;
}

export interface OrganizationProfile {
  readonly name: string;
  readonly businessTimeZone: string;
  readonly profileVersion: number;
  readonly updatedAt: string;
}

export interface OrganizationProfileUpdate {
  readonly name: string;
  readonly expectedProfileVersion: number;
  readonly reason: string;
}

export interface ReviewPolicyUpdate {
  readonly dualApprovalEnabled: boolean;
  readonly dualApprovalThresholds: Readonly<Record<string, string>>;
  readonly sensitiveResolutionTypes: readonly string[];
  readonly reason: string;
}

export interface RetentionPolicy {
  readonly rawImportRetentionDays: number | null;
  readonly providerEventRetentionDays: number | null;
  readonly legalHoldEnabled: boolean;
  readonly legalHoldReason: string | null;
  readonly updatedAt: string | null;
}

export interface RetentionPolicyUpdate {
  readonly rawImportRetentionDays: number | null;
  readonly providerEventRetentionDays: number | null;
  readonly legalHoldEnabled: boolean;
  readonly legalHoldReason: string | null;
  readonly reason: string;
}

export interface OrganizationMember {
  readonly id: string;
  readonly userId: string;
  readonly email?: string;
  readonly role: Role;
  readonly status: "invited" | "active" | "deactivated";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrganizationInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly status: "pending" | "accepted" | "revoked" | "expired";
  readonly invitedByMembershipId: string;
  readonly acceptedByUserId?: string;
  readonly acceptedMembershipId?: string;
  readonly expiresAt: string;
  readonly acceptedAt?: string;
  readonly revokedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatedOrganizationInvitation extends OrganizationInvitation {
  /** A bearer capability returned exactly once. Only its SHA-256 digest is persisted. */
  readonly acceptToken: string;
}

export interface InvitationDeliveryAudit {
  readonly status: "accepted" | "not_configured" | "failed";
  readonly provider: "disabled" | "http_webhook";
  readonly correlationId: string;
  readonly providerMessageId?: string;
  readonly errorCode?: string;
}

export interface AcceptedOrganizationInvitation {
  readonly organizationId: string;
  readonly invitationId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly role: Role;
}

export interface ConnectionHealthItem {
  readonly id: string;
  readonly provider: "shopify" | "stripe" | "accounting_csv";
  readonly externalAccountId: string;
  readonly status:
    "healthy" | "backfilling" | "degraded" | "stale" | "disconnected" | "action_required";
  readonly connectorVersion: string;
  readonly syncEnabled: boolean;
  readonly apiVersion?: string;
  readonly lastSuccessfulSyncAt?: string;
  readonly lastVerifiedWebhookAt?: string;
  readonly retryCount: number;
  readonly deadLetterCount: number;
  readonly errorCode?: string;
  readonly objectWatermarks: readonly ConnectionObjectWatermark[];
  readonly updatedAt: string;
}

export type ConnectionObjectType = SourceObjectFamily;

export type ConnectionObjectWatermark =
  | {
      readonly objectType: ConnectionObjectType;
      readonly observationState: "never_observed";
    }
  | {
      readonly objectType: ConnectionObjectType;
      readonly observationState: "classification_unavailable";
    }
  | {
      readonly objectType: ConnectionObjectType;
      readonly observationState: "observed";
      readonly latestSourceAt: string;
      readonly latestReceivedAt: string;
    };

export interface AuditEventListItem {
  readonly id: string;
  readonly actorType: "user" | "worker" | "system" | "support";
  readonly actorId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly reason?: string;
  readonly previousValue?: unknown;
  readonly newValue?: unknown;
  readonly versionContext: unknown;
}

export interface SourceRecordEvidence {
  readonly id: string;
  readonly version: number;
  readonly kind: "order" | "payment" | "refund" | "processing_fee" | "accounting_entry";
  readonly source: "shopify" | "stripe" | "accounting_csv";
  readonly sourceTimestamp: string;
  readonly normalizedData: SourceRecordNormalizedData;
  readonly contentSha256: string;
  readonly fieldProvenanceStatus: "available" | "unavailable";
  readonly fieldProvenance: readonly {
    readonly fieldPath: string;
    readonly normalizedValue: string;
    readonly transformationRule: string;
    readonly transformationVersion: string;
    readonly warnings: readonly string[];
  }[];
}

export interface SourceRecordNormalizedData {
  readonly kind: "order" | "payment" | "refund" | "processing_fee" | "accounting_entry";
  readonly externalId?: string;
  readonly orderReference?: string;
  readonly customerReference?: string;
  readonly effectiveAt: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly incompleteReasons?: readonly string[];
  readonly financialStatus?: string;
  readonly paymentStatus?: string;
  readonly providerOrderReference?: string;
  readonly refundStatus?: string;
  readonly paymentReference?: string;
  readonly refundReference?: string;
  readonly entryType?: string;
  readonly transactionReference?: string;
}

export type DeterministicEvidenceView =
  | {
      readonly schemaVersion: "deterministic-evidence-view-v1";
      readonly status: "available";
      readonly ruleId: string;
      readonly ruleVersion: string;
      readonly ruleSetVersion: string;
      readonly sourceRecordCount: number;
      readonly evidenceTruncated: boolean;
      readonly comparisons: readonly {
        readonly source: Readonly<Record<string, string>>;
        readonly normalized: Readonly<Record<string, string>>;
      }[];
      readonly toleranceMinor?: string;
      readonly candidateSearch?: {
        readonly eligibleCount: number;
        readonly evaluatedCount: number;
        readonly emittedCount: number;
        readonly evaluationLimit: number;
        readonly complete: boolean;
      };
      readonly accountingCandidateSearch?: {
        readonly eligibleCountLowerBound: number;
        readonly evaluationLimit: number;
        readonly complete: false;
      };
      readonly result: "pass" | "fail" | "defer" | "ambiguous";
      readonly reasonCode: string;
      readonly evaluatedAt: string;
    }
  | {
      readonly schemaVersion: "deterministic-evidence-view-v1";
      readonly status: "unavailable";
      readonly reasonCode: "EVIDENCE_UNSUPPORTED_OR_MALFORMED";
    };

export interface ReconciliationRunListItem {
  readonly id: string;
  readonly stableRunKey: string;
  readonly status: "queued" | "running" | "partial" | "succeeded" | "failed" | "cancelled";
  readonly policyVersion: string;
  readonly ruleSetVersion: string;
  readonly engineVersion: string;
  readonly inputCount: number;
  readonly matchCount: number;
  readonly exceptionCount: number;
  readonly errorCount: number;
  readonly dispatchCount: number;
  readonly operationalStateApplied: boolean;
  readonly lastErrorCode?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly createdAt: string;
}

export const MAX_RUN_ARTIFACT_PREVIEW_PER_TYPE = 10;
export const MAX_RUN_ARTIFACT_PAGE_SIZE = 100;
export const MAX_RUN_INPUT_PREVIEW = 100;
export const MAX_RUN_INPUT_PAGE_SIZE = 100;

export type ArtifactEvidenceFidelity = "exact_at_observation" | "legacy_current_projection";
export type ReconciliationRunArtifactType = "match" | "exception";

export interface ReconciliationRunMatchArtifact {
  readonly id: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly recordReferences: readonly string[];
  readonly recordReferencesStatus: "available" | "unavailable";
  readonly evidence: DeterministicEvidenceView;
  readonly evidenceFidelity: ArtifactEvidenceFidelity;
  readonly observedAt: string;
}

export interface ReconciliationRunExceptionArtifact {
  readonly id: string;
  readonly type: string;
  readonly observedStatus: string;
  readonly currentStatus: string;
  readonly severity: string;
  readonly recordReferences: readonly string[];
  readonly recordReferencesStatus: "available" | "unavailable";
  readonly amountMinor?: string;
  readonly currency?: string;
  readonly evidence: DeterministicEvidenceView;
  readonly evidenceFidelity: ArtifactEvidenceFidelity;
  readonly observedAt: string;
}

export interface ReconciliationRunInputReference {
  readonly id: string;
  readonly version: number;
  readonly contentSha256: string;
  readonly ordinal: number;
}

export interface ReconciliationRunDetail extends ReconciliationRunListItem {
  readonly inputSnapshotHash: string;
  readonly policySnapshotHash: string;
  readonly policySnapshot: unknown;
  readonly initiatedBy: string;
  readonly inputRecords: readonly ReconciliationRunInputReference[];
  readonly inputRecordsTruncated: boolean;
  readonly matches: readonly ReconciliationRunMatchArtifact[];
  readonly matchesTruncated: boolean;
  readonly exceptions: readonly ReconciliationRunExceptionArtifact[];
  readonly exceptionsTruncated: boolean;
}

export type ReconciliationRunArtifactPage =
  | {
      readonly type: "match";
      readonly items: readonly ReconciliationRunMatchArtifact[];
      readonly nextCursor?: string;
    }
  | {
      readonly type: "exception";
      readonly items: readonly ReconciliationRunExceptionArtifact[];
      readonly nextCursor?: string;
    };

export interface ReconciliationRunInputPage {
  readonly items: readonly ReconciliationRunInputReference[];
  readonly nextCursor?: string;
}

export interface ReconciliationRepository {
  health(signal?: AbortSignal): Promise<boolean>;
  listExceptions(tenant: TenantContext, options: ExceptionListOptions): Promise<ExceptionListPage>;
  exportExceptions(
    tenant: TenantContext,
    filters: ExceptionExportFilters,
    request: { readonly correlationId: string },
  ): Promise<ExceptionExportResult>;
  getException(tenant: TenantContext, id: string): Promise<ExceptionDetail | undefined>;
  addExceptionNote(
    tenant: TenantContext,
    exceptionId: string,
    body: string,
  ): Promise<ExceptionNote>;
  updateExceptionWorkflow(
    tenant: TenantContext,
    exceptionId: string,
    input: ExceptionWorkflowInput,
  ): Promise<ExceptionWorkflowResult>;
  listRuns(
    tenant: TenantContext,
    options: { readonly limit: number },
  ): Promise<readonly ReconciliationRunListItem[]>;
  getRun(tenant: TenantContext, runId: string): Promise<ReconciliationRunDetail | undefined>;
  listRunArtifacts(
    tenant: TenantContext,
    runId: string,
    options: {
      readonly type: ReconciliationRunArtifactType;
      readonly limit: number;
      readonly cursor?: string;
    },
  ): Promise<ReconciliationRunArtifactPage | undefined>;
  listRunInputs(
    tenant: TenantContext,
    runId: string,
    options: { readonly limit: number; readonly cursor?: string },
  ): Promise<ReconciliationRunInputPage | undefined>;
  startRun(
    tenant: TenantContext,
    policy: ReconciliationPolicy,
    request: {
      readonly correlationId: string;
      readonly reason: string;
      readonly signal?: AbortSignal;
      readonly traceparent?: string;
    },
  ): Promise<ReconciliationRunListItem>;
  replayRun(
    tenant: TenantContext,
    runId: string,
    request: { readonly correlationId: string; readonly reason: string; readonly now: string },
  ): Promise<ReconciliationRunListItem>;
  createProposal(
    tenant: TenantContext,
    exceptionId: string,
    input: { readonly type: string; readonly reason: string },
  ): Promise<ProposalCreationResult>;
  approveProposal(
    tenant: TenantContext,
    proposalId: string,
    input: { readonly decision: "approve" | "reject"; readonly reason: string },
  ): Promise<{
    readonly id: string;
    readonly decision: "approve" | "reject";
    readonly status: "pending" | "approved" | "rejected";
    readonly approvalCount: number;
    readonly requiredApprovals: number;
    readonly proposalCreatedAt: string;
    readonly decidedAt: string;
    readonly exceptionCreatedAt: string;
    readonly exceptionStatusChangedAt: string;
  }>;
  getOrganizationProfile(tenant: TenantContext): Promise<OrganizationProfile>;
  updateOrganizationProfile(
    tenant: TenantContext,
    input: OrganizationProfileUpdate,
  ): Promise<OrganizationProfile>;
  getReviewPolicy(tenant: TenantContext): Promise<ReviewPolicy>;
  updateReviewPolicy(tenant: TenantContext, input: ReviewPolicyUpdate): Promise<ReviewPolicy>;
  getRetentionPolicy(tenant: TenantContext): Promise<RetentionPolicy>;
  updateRetentionPolicy(
    tenant: TenantContext,
    input: RetentionPolicyUpdate,
  ): Promise<RetentionPolicy>;
  listMembers(tenant: TenantContext): Promise<readonly OrganizationMember[]>;
  updateMember(
    tenant: TenantContext,
    membershipId: string,
    input: {
      readonly role: Role;
      readonly status: "active" | "deactivated";
      readonly reason: string;
    },
  ): Promise<OrganizationMember>;
  listInvitations(tenant: TenantContext): Promise<readonly OrganizationInvitation[]>;
  createInvitation(
    tenant: TenantContext,
    input: { readonly email: string; readonly role: Role; readonly reason: string },
  ): Promise<CreatedOrganizationInvitation>;
  recordInvitationDelivery(
    tenant: TenantContext,
    invitationId: string,
    delivery: InvitationDeliveryAudit,
  ): Promise<void>;
  revokeInvitation(
    tenant: TenantContext,
    invitationId: string,
    input: { readonly reason: string },
  ): Promise<OrganizationInvitation>;
  acceptInvitation(
    identity: VerifiedIdentity,
    token: string,
    request: { readonly correlationId: string },
  ): Promise<AcceptedOrganizationInvitation>;
  listConnections(tenant: TenantContext): Promise<readonly ConnectionHealthItem[]>;
  listAuditEvents(
    tenant: TenantContext,
    options: { readonly limit: number },
  ): Promise<readonly AuditEventListItem[]>;
}

export class RepositoryNotFoundError extends Error {
  public constructor() {
    super("resource not found");
    this.name = "RepositoryNotFoundError";
  }
}

export class RepositoryConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RepositoryConflictError";
  }
}

export class RepositoryCursorError extends Error {
  public constructor() {
    super("cursor is invalid or does not match the requested resource");
    this.name = "RepositoryCursorError";
  }
}

export class RepositoryExportLimitError extends Error {
  public constructor() {
    super(
      `exception export exceeds the ${MAX_EXCEPTION_EXPORT_ROWS.toLocaleString("en-US")}-row or 5 MiB limit; narrow the filters and try again`,
    );
    this.name = "RepositoryExportLimitError";
  }
}

export type RepositoryRunCreationUnavailableReason = "admission_saturated" | "interrupted";

export class RepositoryRunCreationUnavailableError extends Error {
  public constructor(
    public readonly reason: RepositoryRunCreationUnavailableReason = "interrupted",
  ) {
    super("reconciliation run creation was interrupted; retry safely");
    this.name = "RepositoryRunCreationUnavailableError";
  }
}

export class VerifiedEmailRequiredError extends Error {
  public constructor() {
    super("a provider-verified email address is required");
    this.name = "VerifiedEmailRequiredError";
  }
}

export class PostgresReconciliationRepository implements ReconciliationRepository {
  private readonly runTransactionTimeoutMilliseconds: number;
  private readonly runCreationAdmission: ReconciliationRunAdmission;

  public constructor(
    private readonly sql: Sql,
    options: {
      readonly runTransactionTimeoutMilliseconds?: number;
      readonly maximumConcurrentRunTransactions?: number;
    } = {},
  ) {
    this.runTransactionTimeoutMilliseconds = reconciliationRunTransactionTimeoutMilliseconds(
      options.runTransactionTimeoutMilliseconds,
    );
    this.runCreationAdmission = new ReconciliationRunAdmission(
      options.maximumConcurrentRunTransactions,
    );
  }

  public async health(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const query = this.sql`select 1 as healthy`.execute();
    const cancel = (): void => query.cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = await query;
      return result[0] ? toDatabaseRow(result[0])["healthy"] === 1 : false;
    } catch {
      return false;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  public async listExceptions(
    tenant: TenantContext,
    options: ExceptionListOptions,
  ): Promise<ExceptionListPage> {
    const filters = normalizeExceptionFilters(options);
    const cursor = options.cursor ? decodeExceptionListCursor(options.cursor, options) : undefined;
    const cursorEnabled = cursor !== undefined;
    const cursorRank = cursor?.severityRank ?? 0;
    const cursorCreatedAt = cursor?.createdAt ?? "1970-01-01T00:00:00.000Z";
    const cursorId = cursor?.id ?? "00000000-0000-4000-8000-000000000000";

    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const clockRows = await transaction`
        select transaction_timestamp() as filter_as_of
      `;
      const filterAsOf =
        cursor?.asOf ??
        databaseTimestamp(toDatabaseRow(clockRows[0])["filter_as_of"], "exception.filter_as_of");
      const rows = await transaction`
        with selected as materialized (
          select
            exceptions.id,
            exceptions.organization_id,
            exceptions.type,
            exceptions.status,
            exceptions.severity,
            exceptions.record_references,
            exceptions.amount_minor,
            exceptions.currency,
            exceptions.evidence,
            exceptions.assignee_membership_id,
            exceptions.created_at,
            exceptions.updated_at
          from exceptions
          where exceptions.organization_id = ${tenant.organizationId}
            and (
              ${filters.status}::exception_status is null
              or exceptions.status = ${filters.status}::exception_status
            )
            and (
              ${filters.severity}::text is null
              or exceptions.severity = ${filters.severity}::text
            )
            and (${filters.searchId}::uuid is null or exceptions.id = ${filters.searchId}::uuid)
            and (
              ${filters.searchType}::text is null
              or exceptions.type = ${filters.searchType}::text
            )
            and (
              ${filters.amountCurrency}::text is null
              or exceptions.currency::text = ${filters.amountCurrency}::text
            )
            and (
              ${filters.minimumAmountMinor}::bigint is null
              or exceptions.amount_minor >= ${filters.minimumAmountMinor}::bigint
            )
            and (
              ${filters.maximumAmountMinor}::bigint is null
              or exceptions.amount_minor <= ${filters.maximumAmountMinor}::bigint
            )
            and (
              ${filters.confidence}::text is null
              or case exceptions.evidence ->> 'result'
                when 'fail' then 'high'
                when 'ambiguous' then 'low'
                when 'defer' then 'low'
                else 'unclassified'
              end = ${filters.confidence}::text
            )
            and (
              ${filters.assignee}::text is null
              or case ${filters.assignee}::text
                when 'me' then exceptions.assignee_membership_id = ${tenant.membershipId}::uuid
                when 'assigned' then exceptions.assignee_membership_id is not null
                else exceptions.assignee_membership_id is null
              end
            )
            and (
              ${filters.age}::text is null
              or case ${filters.age}::text
                when 'under_24h' then
                  exceptions.created_at > ${filterAsOf}::timestamptz - interval '24 hours'
                  and exceptions.created_at <= ${filterAsOf}::timestamptz
                when 'one_to_seven_days' then
                  exceptions.created_at > ${filterAsOf}::timestamptz - interval '7 days'
                  and exceptions.created_at <= ${filterAsOf}::timestamptz - interval '24 hours'
                when 'seven_to_thirty_days' then
                  exceptions.created_at > ${filterAsOf}::timestamptz - interval '30 days'
                  and exceptions.created_at <= ${filterAsOf}::timestamptz - interval '7 days'
                else exceptions.created_at <= ${filterAsOf}::timestamptz - interval '30 days'
              end
            )
            and (
              ${filters.source}::text is null
              or case
                when ${filters.source}::text = 'unclassified' then not exists (
                  select 1
                  from jsonb_array_elements_text(
                    case
                      when jsonb_typeof(exceptions.record_references) = 'array' then
                        case
                          when jsonb_array_length(exceptions.record_references)
                            <= ${MAX_EXCEPTION_SOURCE_REFERENCES}::integer
                          then exceptions.record_references
                          else '[]'::jsonb
                        end
                      else '[]'::jsonb
                    end
                  ) as referenced(record_id)
                  join canonical_records as source_records
                    on source_records.organization_id = exceptions.organization_id
                    and source_records.id::text = referenced.record_id
                )
                else exists (
                  select 1
                  from jsonb_array_elements_text(
                    case
                      when jsonb_typeof(exceptions.record_references) = 'array' then
                        case
                          when jsonb_array_length(exceptions.record_references)
                            <= ${MAX_EXCEPTION_SOURCE_REFERENCES}::integer
                          then exceptions.record_references
                          else '[]'::jsonb
                        end
                      else '[]'::jsonb
                    end
                  ) as referenced(record_id)
                  join canonical_records as source_records
                    on source_records.organization_id = exceptions.organization_id
                    and source_records.id::text = referenced.record_id
                  where source_records.source::text = ${filters.source}::text
                )
              end
            )
            and (
              ${cursorEnabled}::boolean = false
              or case exceptions.severity when 'high' then 0 when 'medium' then 1 else 2 end
                  > ${cursorRank}::integer
              or (
                case exceptions.severity when 'high' then 0 when 'medium' then 1 else 2 end
                    = ${cursorRank}::integer
                and exceptions.created_at > ${cursorCreatedAt}::timestamptz
              )
              or (
                case exceptions.severity when 'high' then 0 when 'medium' then 1 else 2 end
                    = ${cursorRank}::integer
                and exceptions.created_at = ${cursorCreatedAt}::timestamptz
                and exceptions.id > ${cursorId}::uuid
              )
            )
          order by
            case exceptions.severity when 'high' then 0 when 'medium' then 1 else 2 end,
            exceptions.created_at asc,
            exceptions.id asc
          limit ${options.limit + 1}
        )
        select
          selected.id,
          selected.type,
          selected.status,
          selected.severity,
          selected.amount_minor,
          selected.currency,
          selected.created_at,
          selected.updated_at,
          coalesce(
            array(
              select distinct source_records.source::text
              from jsonb_array_elements_text(
                case
                  when jsonb_typeof(selected.record_references) = 'array' then
                    case
                      when jsonb_array_length(selected.record_references)
                        <= ${MAX_EXCEPTION_SOURCE_REFERENCES}::integer
                      then selected.record_references
                      else '[]'::jsonb
                    end
                  else '[]'::jsonb
                end
              ) as referenced(record_id)
              join canonical_records as source_records
                on source_records.organization_id = selected.organization_id
                and source_records.id::text = referenced.record_id
              order by source_records.source::text
            ),
            array[]::text[]
          ) as sources,
          case selected.evidence ->> 'result'
            when 'fail' then 'high'
            when 'ambiguous' then 'low'
            when 'defer' then 'low'
            else 'unclassified'
          end as confidence,
          case
            when selected.assignee_membership_id is null then 'unassigned'
            when selected.assignee_membership_id = ${tenant.membershipId}::uuid then 'me'
            else 'assigned'
          end as assignee
        from selected
        order by
          case selected.severity when 'high' then 0 when 'medium' then 1 else 2 end,
          selected.created_at asc,
          selected.id asc
      `;
      const filteredCounts = await transaction`
        select count(*)::integer as filtered_count
        from exceptions
        where exceptions.organization_id = ${tenant.organizationId}
          and (
            ${filters.status}::exception_status is null
            or exceptions.status = ${filters.status}::exception_status
          )
          and (
            ${filters.severity}::text is null
            or exceptions.severity = ${filters.severity}::text
          )
          and (${filters.searchId}::uuid is null or exceptions.id = ${filters.searchId}::uuid)
          and (
            ${filters.searchType}::text is null
            or exceptions.type = ${filters.searchType}::text
          )
          and (
            ${filters.amountCurrency}::text is null
            or exceptions.currency::text = ${filters.amountCurrency}::text
          )
          and (
            ${filters.minimumAmountMinor}::bigint is null
            or exceptions.amount_minor >= ${filters.minimumAmountMinor}::bigint
          )
          and (
            ${filters.maximumAmountMinor}::bigint is null
            or exceptions.amount_minor <= ${filters.maximumAmountMinor}::bigint
          )
          and (
            ${filters.confidence}::text is null
            or case exceptions.evidence ->> 'result'
              when 'fail' then 'high'
              when 'ambiguous' then 'low'
              when 'defer' then 'low'
              else 'unclassified'
            end = ${filters.confidence}::text
          )
          and (
            ${filters.assignee}::text is null
            or case ${filters.assignee}::text
              when 'me' then exceptions.assignee_membership_id = ${tenant.membershipId}::uuid
              when 'assigned' then exceptions.assignee_membership_id is not null
              else exceptions.assignee_membership_id is null
            end
          )
          and (
            ${filters.age}::text is null
            or case ${filters.age}::text
              when 'under_24h' then
                exceptions.created_at > ${filterAsOf}::timestamptz - interval '24 hours'
                and exceptions.created_at <= ${filterAsOf}::timestamptz
              when 'one_to_seven_days' then
                exceptions.created_at > ${filterAsOf}::timestamptz - interval '7 days'
                and exceptions.created_at <= ${filterAsOf}::timestamptz - interval '24 hours'
              when 'seven_to_thirty_days' then
                exceptions.created_at > ${filterAsOf}::timestamptz - interval '30 days'
                and exceptions.created_at <= ${filterAsOf}::timestamptz - interval '7 days'
              else exceptions.created_at <= ${filterAsOf}::timestamptz - interval '30 days'
            end
          )
          and (
            ${filters.source}::text is null
            or case
              when ${filters.source}::text = 'unclassified' then not exists (
                select 1
                from jsonb_array_elements_text(
                  case
                    when jsonb_typeof(exceptions.record_references) = 'array' then
                      case
                        when jsonb_array_length(exceptions.record_references)
                          <= ${MAX_EXCEPTION_SOURCE_REFERENCES}::integer
                        then exceptions.record_references
                        else '[]'::jsonb
                      end
                    else '[]'::jsonb
                  end
                ) as referenced(record_id)
                join canonical_records as source_records
                  on source_records.organization_id = exceptions.organization_id
                  and source_records.id::text = referenced.record_id
              )
              else exists (
                select 1
                from jsonb_array_elements_text(
                  case
                    when jsonb_typeof(exceptions.record_references) = 'array' then
                      case
                        when jsonb_array_length(exceptions.record_references)
                          <= ${MAX_EXCEPTION_SOURCE_REFERENCES}::integer
                        then exceptions.record_references
                        else '[]'::jsonb
                      end
                    else '[]'::jsonb
                  end
                ) as referenced(record_id)
                join canonical_records as source_records
                  on source_records.organization_id = exceptions.organization_id
                  and source_records.id::text = referenced.record_id
                where source_records.source::text = ${filters.source}::text
              )
            end
          )
      `;
      const summaryRows = await transaction`
        select
          count(*) filter (
            where status in ('open', 'assigned', 'deferred')
          )::integer as open_count,
          count(*) filter (where severity = 'high')::integer as high_count,
          count(*) filter (where status = 'proposed')::integer as awaiting_approval_count,
          count(*) filter (where status in ('approved', 'rejected'))::integer as decided_count
        from exceptions
        where organization_id = ${tenant.organizationId}
      `;
      const hasNextPage = rows.length > options.limit;
      const items = rows
        .slice(0, options.limit)
        .map((row) => mapExceptionListItem(toDatabaseRow(row)));
      const lastItem = items.at(-1);
      const filteredCountRow = filteredCounts[0] ? toDatabaseRow(filteredCounts[0]) : {};
      const summaryRow = summaryRows[0] ? toDatabaseRow(summaryRows[0]) : {};
      return {
        items,
        filteredCount: databaseInteger(
          filteredCountRow["filtered_count"] ?? 0,
          "exception.filtered_count",
        ),
        summary: {
          open: databaseInteger(summaryRow["open_count"] ?? 0, "exception.open_count"),
          high: databaseInteger(summaryRow["high_count"] ?? 0, "exception.high_count"),
          awaitingApproval: databaseInteger(
            summaryRow["awaiting_approval_count"] ?? 0,
            "exception.awaiting_approval_count",
          ),
          decided: databaseInteger(summaryRow["decided_count"] ?? 0, "exception.decided_count"),
        },
        ...(hasNextPage && lastItem
          ? { nextCursor: encodeExceptionListCursor(lastItem, options, filterAsOf) }
          : {}),
      };
    });
  }

  public async exportExceptions(
    tenant: TenantContext,
    filters: ExceptionExportFilters,
    request: { readonly correlationId: string },
  ): Promise<ExceptionExportResult> {
    const normalized = normalizeExceptionFilters(filters);

    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const clockRows = await transaction`
        select transaction_timestamp() as filter_as_of
      `;
      const filterAsOf = databaseTimestamp(
        toDatabaseRow(clockRows[0])["filter_as_of"],
        "exception_export.filter_as_of",
      );
      const rows = await transaction`
        select
          exceptions.id,
          exceptions.type,
          exceptions.status,
          exceptions.severity,
          exceptions.amount_minor,
          exceptions.currency,
          exceptions.created_at,
          exceptions.updated_at,
          coalesce(
            array(
              select distinct source_records.source::text
              from jsonb_array_elements_text(
                case
                  when jsonb_typeof(exceptions.record_references) = 'array' then
                    case
                      when jsonb_array_length(exceptions.record_references)
                        <= ${MAX_EXCEPTION_SOURCE_REFERENCES}::integer
                      then exceptions.record_references
                      else '[]'::jsonb
                    end
                  else '[]'::jsonb
                end
              ) as referenced(record_id)
              join canonical_records as source_records
                on source_records.organization_id = exceptions.organization_id
                and source_records.id::text = referenced.record_id
              order by source_records.source::text
            ),
            array[]::text[]
          ) as sources,
          case exceptions.evidence ->> 'result'
            when 'fail' then 'high'
            when 'ambiguous' then 'low'
            when 'defer' then 'low'
            else 'unclassified'
          end as confidence,
          case
            when exceptions.assignee_membership_id is null then 'unassigned'
            when exceptions.assignee_membership_id = ${tenant.membershipId}::uuid then 'me'
            else 'assigned'
          end as assignee
        from exceptions
        where exceptions.organization_id = ${tenant.organizationId}
          and (
            ${normalized.status}::exception_status is null
            or exceptions.status = ${normalized.status}::exception_status
          )
          and (
            ${normalized.severity}::text is null
            or exceptions.severity = ${normalized.severity}::text
          )
          and (${normalized.searchId}::uuid is null or exceptions.id = ${normalized.searchId}::uuid)
          and (
            ${normalized.searchType}::text is null
            or exceptions.type = ${normalized.searchType}::text
          )
          and (
            ${normalized.amountCurrency}::text is null
            or exceptions.currency::text = ${normalized.amountCurrency}::text
          )
          and (
            ${normalized.minimumAmountMinor}::bigint is null
            or exceptions.amount_minor >= ${normalized.minimumAmountMinor}::bigint
          )
          and (
            ${normalized.maximumAmountMinor}::bigint is null
            or exceptions.amount_minor <= ${normalized.maximumAmountMinor}::bigint
          )
          and (
            ${normalized.confidence}::text is null
            or case exceptions.evidence ->> 'result'
              when 'fail' then 'high'
              when 'ambiguous' then 'low'
              when 'defer' then 'low'
              else 'unclassified'
            end = ${normalized.confidence}::text
          )
          and (
            ${normalized.assignee}::text is null
            or case ${normalized.assignee}::text
              when 'me' then exceptions.assignee_membership_id = ${tenant.membershipId}::uuid
              when 'assigned' then exceptions.assignee_membership_id is not null
              else exceptions.assignee_membership_id is null
            end
          )
          and (
            ${normalized.age}::text is null
            or case ${normalized.age}::text
              when 'under_24h' then
                exceptions.created_at > ${filterAsOf}::timestamptz - interval '24 hours'
                and exceptions.created_at <= ${filterAsOf}::timestamptz
              when 'one_to_seven_days' then
                exceptions.created_at > ${filterAsOf}::timestamptz - interval '7 days'
                and exceptions.created_at <= ${filterAsOf}::timestamptz - interval '24 hours'
              when 'seven_to_thirty_days' then
                exceptions.created_at > ${filterAsOf}::timestamptz - interval '30 days'
                and exceptions.created_at <= ${filterAsOf}::timestamptz - interval '7 days'
              else exceptions.created_at <= ${filterAsOf}::timestamptz - interval '30 days'
            end
          )
          and (
            ${normalized.source}::text is null
            or case
              when ${normalized.source}::text = 'unclassified' then not exists (
                select 1
                from jsonb_array_elements_text(
                  case
                    when jsonb_typeof(exceptions.record_references) = 'array' then
                      case
                        when jsonb_array_length(exceptions.record_references)
                          <= ${MAX_EXCEPTION_SOURCE_REFERENCES}::integer
                        then exceptions.record_references
                        else '[]'::jsonb
                      end
                    else '[]'::jsonb
                  end
                ) as referenced(record_id)
                join canonical_records as source_records
                  on source_records.organization_id = exceptions.organization_id
                  and source_records.id::text = referenced.record_id
              )
              else exists (
                select 1
                from jsonb_array_elements_text(
                  case
                    when jsonb_typeof(exceptions.record_references) = 'array' then
                      case
                        when jsonb_array_length(exceptions.record_references)
                          <= ${MAX_EXCEPTION_SOURCE_REFERENCES}::integer
                        then exceptions.record_references
                        else '[]'::jsonb
                      end
                    else '[]'::jsonb
                  end
                ) as referenced(record_id)
                join canonical_records as source_records
                  on source_records.organization_id = exceptions.organization_id
                  and source_records.id::text = referenced.record_id
                where source_records.source::text = ${normalized.source}::text
              )
            end
          )
        order by
          case exceptions.severity when 'high' then 0 when 'medium' then 1 else 2 end,
          exceptions.created_at asc,
          exceptions.id asc
        limit ${MAX_EXCEPTION_EXPORT_ROWS + 1}
      `;
      if (rows.length > MAX_EXCEPTION_EXPORT_ROWS) throw new RepositoryExportLimitError();

      const items = rows.map((row) => mapExceptionListItem(toDatabaseRow(row)));
      const csv = serializeExceptionExport(items);
      const exportId = randomUUID();
      await insertUserAuditEvent(transaction, tenant, {
        action: "exception_queue.exported",
        resourceType: "exception_export",
        resourceId: exportId,
        correlationId: request.correlationId,
        reason: "Exception queue CSV exported",
        newValue: {
          format: "csv",
          rowCount: items.length,
          filters: {
            status: filters.status ?? null,
            severity: filters.severity ?? null,
            search: filters.search ?? null,
            source: filters.source ?? null,
            amountCurrency: normalized.amountCurrency,
            minimumAmountMinor: normalized.minimumAmountMinor,
            maximumAmountMinor: normalized.maximumAmountMinor,
            confidence: filters.confidence ?? null,
            assignee: filters.assignee ?? null,
            age: filters.age ?? null,
            filterAsOf,
          },
          columns: [
            "exception_id",
            "type",
            "status",
            "severity",
            "sources",
            "confidence",
            "assignee",
            "amount_minor",
            "currency",
            "created_at",
            "updated_at",
          ],
        },
        versionContext: { schemaVersion: "exception-queue-csv-v2" },
      });
      return { id: exportId, csv, rowCount: items.length };
    });
  }

  public async getException(
    tenant: TenantContext,
    id: string,
  ): Promise<ExceptionDetail | undefined> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select
          exceptions.id,
          exceptions.type,
          exceptions.status,
          exceptions.severity,
          exceptions.amount_minor,
          exceptions.currency,
          exceptions.created_at,
          exceptions.updated_at,
          exceptions.record_references,
          exceptions.evidence,
          exceptions.assignee_membership_id,
          exceptions.deferred_until,
          coalesce(
            array(
              select distinct source_records.source::text
              from jsonb_array_elements_text(
                case
                  when jsonb_typeof(exceptions.record_references) = 'array' then
                    case
                      when jsonb_array_length(exceptions.record_references)
                        <= ${MAX_EXCEPTION_SOURCE_REFERENCES}::integer
                      then exceptions.record_references
                      else '[]'::jsonb
                    end
                  else '[]'::jsonb
                end
              ) as referenced(record_id)
              join canonical_records as source_records
                on source_records.organization_id = exceptions.organization_id
                and source_records.id::text = referenced.record_id
              order by source_records.source::text
            ),
            array[]::text[]
          ) as sources,
          case exceptions.evidence ->> 'result'
            when 'fail' then 'high'
            when 'ambiguous' then 'low'
            when 'defer' then 'low'
            else 'unclassified'
          end as confidence,
          case
            when exceptions.assignee_membership_id is null then 'unassigned'
            when exceptions.assignee_membership_id = ${tenant.membershipId}::uuid then 'me'
            else 'assigned'
          end as assignee
        from exceptions
        where exceptions.organization_id = ${tenant.organizationId}
          and exceptions.id = ${id}::uuid
        limit 1
      `;
      const row = rows[0];
      if (!row) return undefined;
      const detailRow = toDatabaseRow(row);
      const proposals = await transaction`
        select
          resolution_proposals.id,
          resolution_proposals.version,
          resolution_proposals.proposal_type,
          resolution_proposals.reason,
          resolution_proposals.status,
          resolution_proposals.proposed_by,
          resolution_proposals.required_approvals,
          resolution_proposals.created_at,
          (
            select count(*)::integer
            from approvals
            where approvals.organization_id = resolution_proposals.organization_id
              and approvals.proposal_id = resolution_proposals.id
              and approvals.proposal_version = resolution_proposals.version
              and approvals.decision = 'approve'
          ) as approval_count
        from resolution_proposals
        where resolution_proposals.organization_id = ${tenant.organizationId}
          and resolution_proposals.exception_id = ${id}::uuid
        order by created_at desc, version desc
        limit 1
      `;
      const proposal = proposals[0] ? toDatabaseRow(proposals[0]) : undefined;
      const proposedBy = proposal?.["proposed_by"]
        ? databaseScalar(proposal["proposed_by"], "proposal.proposed_by")
        : undefined;
      const sourceRecords = await loadSourceRecordEvidence(
        transaction,
        tenant.organizationId,
        detailRow["evidence"],
      );
      const notes = await loadExceptionNotes(transaction, tenant.organizationId, id);
      const timeline = await loadExceptionTimeline(transaction, tenant.organizationId, id);
      const recordReferences = toVerifiedExceptionRecordReferences(
        detailRow["record_references"],
        sourceRecords,
      );
      return {
        ...mapExceptionListItem(detailRow),
        recordReferences: recordReferences.values,
        recordReferencesStatus: recordReferences.status,
        evidence: toDeterministicEvidenceView(detailRow["evidence"]),
        sourceRecords,
        notes,
        timeline: timeline.events,
        timelineTruncated: timeline.truncated,
        ...(detailRow["assignee_membership_id"]
          ? {
              assigneeMembershipId: databaseScalar(
                detailRow["assignee_membership_id"],
                "assignee_membership_id",
              ),
            }
          : {}),
        ...(detailRow["deferred_until"]
          ? { deferredUntil: databaseTimestamp(detailRow["deferred_until"], "deferred_until") }
          : {}),
        ...(proposal
          ? {
              latestProposal: {
                id: databaseScalar(proposal["id"], "proposal.id"),
                version: Number(proposal["version"]),
                type: databaseScalar(proposal["proposal_type"], "proposal.proposal_type"),
                reason: databaseScalar(proposal["reason"], "proposal.reason"),
                status: databaseScalar(proposal["status"], "proposal.status"),
                ...(proposedBy ? { proposedBy } : {}),
                canRevise: proposal["status"] === "pending" && proposedBy === tenant.actorId,
                approvalCount: databaseInteger(
                  proposal["approval_count"],
                  "proposal.approval_count",
                ),
                requiredApprovals: databaseInteger(
                  proposal["required_approvals"],
                  "proposal.required_approvals",
                ),
                createdAt: databaseTimestamp(proposal["created_at"], "proposal.created_at"),
              },
            }
          : {}),
      };
    });
  }

  public async addExceptionNote(
    tenant: TenantContext,
    exceptionId: string,
    body: string,
  ): Promise<ExceptionNote> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const exceptions = await transaction`
        select id
        from exceptions
        where organization_id = ${tenant.organizationId}
          and id = ${exceptionId}::uuid
        limit 1
      `;
      if (!exceptions[0]) throw new RepositoryNotFoundError();
      const noteId = randomUUID();
      const inserted = await transaction`
        insert into exception_notes (
          id, organization_id, exception_id, author_membership_id, body
        ) values (
          ${noteId}, ${tenant.organizationId}, ${exceptionId}, ${tenant.membershipId}, ${body}
        )
        returning id, author_membership_id, body, created_at
      `;
      const row = inserted[0] ? toDatabaseRow(inserted[0]) : undefined;
      if (!row) throw new RepositoryNotFoundError();
      await insertUserAuditEvent(transaction, tenant, {
        action: "exception.note.added",
        resourceType: "exception_note",
        resourceId: noteId,
        reason: "Investigation note added",
        newValue: { exceptionId, body },
        versionContext: {},
      });
      return mapExceptionNote(row);
    });
  }

  public async updateExceptionWorkflow(
    tenant: TenantContext,
    exceptionId: string,
    input: ExceptionWorkflowInput,
  ): Promise<ExceptionWorkflowResult> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select id, status, assignee_membership_id, deferred_until
        from exceptions
        where organization_id = ${tenant.organizationId}
          and id = ${exceptionId}::uuid
        limit 1
        for update
      `;
      const row = rows[0] ? toDatabaseRow(rows[0]) : undefined;
      if (!row) throw new RepositoryNotFoundError();
      const previous = mapExceptionWorkflow(row);
      if (!["open", "assigned", "deferred"].includes(previous.status)) {
        throw new RepositoryConflictError("the exception workflow is no longer editable");
      }
      let updated;
      if (input.action === "assign_self") {
        updated = await transaction`
          update exceptions
          set
            status = 'assigned',
            assignee_membership_id = ${tenant.membershipId},
            deferred_until = null,
            updated_at = now()
          where organization_id = ${tenant.organizationId}
            and id = ${exceptionId}::uuid
          returning id, status, assignee_membership_id, deferred_until
        `;
      } else if (input.action === "defer") {
        updated = await transaction`
          update exceptions
          set
            status = 'deferred',
            deferred_until = ${input.deferredUntil}::timestamptz,
            updated_at = now()
          where organization_id = ${tenant.organizationId}
            and id = ${exceptionId}::uuid
            and ${input.deferredUntil}::timestamptz > now()
            and ${input.deferredUntil}::timestamptz <= now() + interval '365 days'
          returning id, status, assignee_membership_id, deferred_until
        `;
      } else {
        updated = await transaction`
          update exceptions
          set
            status = case
              when assignee_membership_id is null then 'open'::exception_status
              else 'assigned'::exception_status
            end,
            deferred_until = null,
            updated_at = now()
          where organization_id = ${tenant.organizationId}
            and id = ${exceptionId}::uuid
          returning id, status, assignee_membership_id, deferred_until
        `;
      }
      const updatedRow = updated[0] ? toDatabaseRow(updated[0]) : undefined;
      if (!updatedRow) {
        throw new RepositoryConflictError(
          "deferredUntil must be in the future and no more than 365 days away",
        );
      }
      const next = mapExceptionWorkflow(updatedRow);
      await insertUserAuditEvent(transaction, tenant, {
        action: `exception.${input.action}`,
        resourceType: "exception",
        resourceId: exceptionId,
        reason: input.reason,
        previousValue: previous,
        newValue: next,
        versionContext: {},
      });
      return next;
    });
  }

  public async listRuns(
    tenant: TenantContext,
    options: { readonly limit: number },
  ): Promise<readonly ReconciliationRunListItem[]> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select
          id, stable_run_key, status, policy_version, rule_set_version, engine_version,
          input_count, match_count, exception_count, error_count, dispatch_count,
          operational_state_applied, last_error_code, started_at, completed_at, created_at
        from reconciliation_runs
        where organization_id = ${tenant.organizationId}
        order by created_at desc, id desc
        limit ${options.limit}
      `;
      return rows.map((row) => mapReconciliationRunListItem(toDatabaseRow(row)));
    });
  }

  public async getRun(
    tenant: TenantContext,
    runId: string,
  ): Promise<ReconciliationRunDetail | undefined> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select
          id, stable_run_key, status, policy_version, rule_set_version, engine_version,
          input_snapshot_hash, policy_snapshot_hash, policy_snapshot, initiated_by,
          input_count, match_count, exception_count, error_count, dispatch_count,
          operational_state_applied, last_error_code, started_at, completed_at, created_at
        from reconciliation_runs
        where organization_id = ${tenant.organizationId}
          and id = ${runId}::uuid
        limit 1
      `;
      const row = rows[0] ? toDatabaseRow(rows[0]) : undefined;
      if (!row) return undefined;
      const inputs = await transaction`
        select record_id, record_version, content_sha256, ordinal
        from reconciliation_run_inputs
        where organization_id = ${tenant.organizationId}
          and run_id = ${runId}::uuid
        order by ordinal
        limit ${MAX_RUN_INPUT_PREVIEW + 1}
      `;
      const matchArtifacts = await transaction`
        select
          matches.id,
          case
            when snapshots.match_id is null then matches.rule_id
            else snapshots.rule_id
          end as rule_id,
          case
            when snapshots.match_id is null then matches.rule_version
            else snapshots.rule_version
          end as rule_version,
          case
            when snapshots.match_id is null then matches.record_references
            else snapshots.record_references
          end as record_references,
          case
            when snapshots.match_id is null then matches.evidence
            else snapshots.evidence
          end as evidence,
          case
            when snapshots.match_id is null then 'legacy_current_projection'
            else 'exact_at_observation'
          end as evidence_fidelity,
          occurrences.observed_at
        from match_occurrences as occurrences
        join matches
          on matches.organization_id = occurrences.organization_id
          and matches.id = occurrences.match_id
        left join match_occurrence_snapshots as snapshots
          on snapshots.organization_id = occurrences.organization_id
          and snapshots.run_id = occurrences.run_id
          and snapshots.match_id = occurrences.match_id
        where occurrences.organization_id = ${tenant.organizationId}
          and occurrences.run_id = ${runId}::uuid
        order by occurrences.observed_at, matches.id
        limit ${MAX_RUN_ARTIFACT_PREVIEW_PER_TYPE + 1}
      `;
      const exceptionArtifacts = await transaction`
        select
          exceptions.id,
          case
            when snapshots.exception_id is null then exceptions.type
            else snapshots.type
          end as type,
          case
            when snapshots.exception_id is null then exceptions.status
            else snapshots.observed_status
          end as observed_status,
          exceptions.status as current_status,
          case
            when snapshots.exception_id is null then exceptions.severity
            else snapshots.severity
          end as severity,
          case
            when snapshots.exception_id is null then exceptions.record_references
            else snapshots.record_references
          end as record_references,
          case
            when snapshots.exception_id is null then exceptions.amount_minor
            else snapshots.amount_minor
          end as amount_minor,
          case
            when snapshots.exception_id is null then exceptions.currency
            else snapshots.currency
          end as currency,
          case
            when snapshots.exception_id is null then exceptions.evidence
            else snapshots.evidence
          end as evidence,
          case
            when snapshots.exception_id is null then 'legacy_current_projection'
            else 'exact_at_observation'
          end as evidence_fidelity,
          occurrences.observed_at
        from exception_occurrences as occurrences
        join exceptions
          on exceptions.organization_id = occurrences.organization_id
          and exceptions.id = occurrences.exception_id
        left join exception_occurrence_snapshots as snapshots
          on snapshots.organization_id = occurrences.organization_id
          and snapshots.run_id = occurrences.run_id
          and snapshots.exception_id = occurrences.exception_id
        where occurrences.organization_id = ${tenant.organizationId}
          and occurrences.run_id = ${runId}::uuid
        order by occurrences.observed_at, exceptions.id
        limit ${MAX_RUN_ARTIFACT_PREVIEW_PER_TYPE + 1}
      `;
      return {
        ...mapReconciliationRunListItem(row),
        inputSnapshotHash: databaseScalar(row["input_snapshot_hash"], "input_snapshot_hash"),
        policySnapshotHash: databaseScalar(row["policy_snapshot_hash"], "policy_snapshot_hash"),
        policySnapshot: row["policy_snapshot"],
        initiatedBy: databaseScalar(row["initiated_by"], "initiated_by"),
        inputRecords: inputs
          .slice(0, MAX_RUN_INPUT_PREVIEW)
          .map((input) => mapRunInputReference(toDatabaseRow(input))),
        inputRecordsTruncated: inputs.length > MAX_RUN_INPUT_PREVIEW,
        matches: matchArtifacts
          .slice(0, MAX_RUN_ARTIFACT_PREVIEW_PER_TYPE)
          .map((artifact) => mapRunMatchArtifact(toDatabaseRow(artifact))),
        matchesTruncated: matchArtifacts.length > MAX_RUN_ARTIFACT_PREVIEW_PER_TYPE,
        exceptions: exceptionArtifacts
          .slice(0, MAX_RUN_ARTIFACT_PREVIEW_PER_TYPE)
          .map((artifact) => mapRunExceptionArtifact(toDatabaseRow(artifact))),
        exceptionsTruncated: exceptionArtifacts.length > MAX_RUN_ARTIFACT_PREVIEW_PER_TYPE,
      };
    });
  }

  public async listRunArtifacts(
    tenant: TenantContext,
    runId: string,
    options: {
      readonly type: ReconciliationRunArtifactType;
      readonly limit: number;
      readonly cursor?: string;
    },
  ): Promise<ReconciliationRunArtifactPage | undefined> {
    const cursor = options.cursor
      ? decodeReconciliationRunArtifactCursor(
          options.cursor,
          tenant.organizationId,
          runId,
          options.type,
        )
      : undefined;
    const cursorEnabled = cursor !== undefined;
    const cursorId = cursor?.id ?? "00000000-0000-0000-0000-000000000000";

    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const runRows = await transaction`
        select id
        from reconciliation_runs
        where organization_id = ${tenant.organizationId}
          and id = ${runId}::uuid
        limit 1
      `;
      if (!runRows[0]) return undefined;

      if (options.type === "match") {
        const rows = await transaction`
          select
            matches.id,
            case
              when snapshots.match_id is null then matches.rule_id
              else snapshots.rule_id
            end as rule_id,
            case
              when snapshots.match_id is null then matches.rule_version
              else snapshots.rule_version
            end as rule_version,
            case
              when snapshots.match_id is null then matches.record_references
              else snapshots.record_references
            end as record_references,
            case
              when snapshots.match_id is null then matches.evidence
              else snapshots.evidence
            end as evidence,
            case
              when snapshots.match_id is null then 'legacy_current_projection'
              else 'exact_at_observation'
            end as evidence_fidelity,
            occurrences.observed_at
          from match_occurrences as occurrences
          join matches
            on matches.organization_id = occurrences.organization_id
            and matches.id = occurrences.match_id
          left join match_occurrence_snapshots as snapshots
            on snapshots.organization_id = occurrences.organization_id
            and snapshots.run_id = occurrences.run_id
            and snapshots.match_id = occurrences.match_id
          where occurrences.organization_id = ${tenant.organizationId}
            and occurrences.run_id = ${runId}::uuid
            and (
              ${cursorEnabled}::boolean = false
              or occurrences.match_id > ${cursorId}::uuid
            )
          order by occurrences.match_id
          limit ${options.limit + 1}
        `;
        const items = rows
          .slice(0, options.limit)
          .map((artifact) => mapRunMatchArtifact(toDatabaseRow(artifact)));
        const last = items.at(-1);
        return {
          type: options.type,
          items,
          ...(rows.length > options.limit && last
            ? {
                nextCursor: encodeReconciliationRunArtifactCursor(
                  tenant.organizationId,
                  runId,
                  options.type,
                  last.id,
                ),
              }
            : {}),
        };
      }

      const rows = await transaction`
        select
          exceptions.id,
          case
            when snapshots.exception_id is null then exceptions.type
            else snapshots.type
          end as type,
          case
            when snapshots.exception_id is null then exceptions.status
            else snapshots.observed_status
          end as observed_status,
          exceptions.status as current_status,
          case
            when snapshots.exception_id is null then exceptions.severity
            else snapshots.severity
          end as severity,
          case
            when snapshots.exception_id is null then exceptions.record_references
            else snapshots.record_references
          end as record_references,
          case
            when snapshots.exception_id is null then exceptions.amount_minor
            else snapshots.amount_minor
          end as amount_minor,
          case
            when snapshots.exception_id is null then exceptions.currency
            else snapshots.currency
          end as currency,
          case
            when snapshots.exception_id is null then exceptions.evidence
            else snapshots.evidence
          end as evidence,
          case
            when snapshots.exception_id is null then 'legacy_current_projection'
            else 'exact_at_observation'
          end as evidence_fidelity,
          occurrences.observed_at
        from exception_occurrences as occurrences
        join exceptions
          on exceptions.organization_id = occurrences.organization_id
          and exceptions.id = occurrences.exception_id
        left join exception_occurrence_snapshots as snapshots
          on snapshots.organization_id = occurrences.organization_id
          and snapshots.run_id = occurrences.run_id
          and snapshots.exception_id = occurrences.exception_id
        where occurrences.organization_id = ${tenant.organizationId}
          and occurrences.run_id = ${runId}::uuid
          and (
            ${cursorEnabled}::boolean = false
            or occurrences.exception_id > ${cursorId}::uuid
          )
        order by occurrences.exception_id
        limit ${options.limit + 1}
      `;
      const items = rows
        .slice(0, options.limit)
        .map((artifact) => mapRunExceptionArtifact(toDatabaseRow(artifact)));
      const last = items.at(-1);
      return {
        type: options.type,
        items,
        ...(rows.length > options.limit && last
          ? {
              nextCursor: encodeReconciliationRunArtifactCursor(
                tenant.organizationId,
                runId,
                options.type,
                last.id,
              ),
            }
          : {}),
      };
    });
  }

  public async listRunInputs(
    tenant: TenantContext,
    runId: string,
    options: { readonly limit: number; readonly cursor?: string },
  ): Promise<ReconciliationRunInputPage | undefined> {
    const cursor = options.cursor
      ? decodeReconciliationRunInputCursor(options.cursor, tenant.organizationId, runId)
      : undefined;
    const lastOrdinal = cursor?.ordinal ?? -1;

    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const runRows = await transaction`
        select id
        from reconciliation_runs
        where organization_id = ${tenant.organizationId}
          and id = ${runId}::uuid
        limit 1
      `;
      if (!runRows[0]) return undefined;

      const rows = await transaction`
        select record_id, record_version, content_sha256, ordinal
        from reconciliation_run_inputs
        where organization_id = ${tenant.organizationId}
          and run_id = ${runId}::uuid
          and ordinal > ${lastOrdinal}
        order by ordinal
        limit ${options.limit + 1}
      `;
      const items = rows
        .slice(0, options.limit)
        .map((input) => mapRunInputReference(toDatabaseRow(input)));
      const last = items.at(-1);
      return {
        items,
        ...(rows.length > options.limit && last
          ? {
              nextCursor: encodeReconciliationRunInputCursor(
                tenant.organizationId,
                runId,
                last.ordinal,
              ),
            }
          : {}),
      };
    });
  }

  public async startRun(
    tenant: TenantContext,
    policy: ReconciliationPolicy,
    request: {
      readonly correlationId: string;
      readonly reason: string;
      readonly signal?: AbortSignal;
      readonly traceparent?: string;
    },
  ): Promise<ReconciliationRunListItem> {
    const timeoutMilliseconds = this.runTransactionTimeoutMilliseconds.toString();
    const deadlineController = new AbortController();
    const deadline = setTimeout(
      () => deadlineController.abort(),
      this.runTransactionTimeoutMilliseconds,
    );
    deadline.unref();
    const runSignal = request.signal
      ? AbortSignal.any([request.signal, deadlineController.signal])
      : deadlineController.signal;
    try {
      try {
        assertRunCreationActive(runSignal);
        const transactionOperation = admittedReconciliationRunCreationOperation(
          this.runCreationAdmission,
          () =>
            withTenantTransaction(this.sql, tenant, async (transaction) => {
              assertRunCreationActive(runSignal);
              await runCreationQuery(
                transaction`
            select set_config('statement_timeout', ${timeoutMilliseconds}, true)
          `,
                runSignal,
              );
              await runCreationQuery(
                transaction`
        select pg_advisory_xact_lock(hashtextextended(${tenant.organizationId}, 1))
          `,
                runSignal,
              );
              const rows = await runCreationQuery(
                transaction`
        select distinct on (candidate.id)
          candidate.id, candidate.version, candidate.content_sha256, candidate.normalized_data
        from canonical_records as candidate
        where candidate.organization_id = ${tenant.organizationId}
          and not exists (
            select 1
            from canonical_record_supersessions
            where canonical_record_supersessions.organization_id = candidate.organization_id
              and canonical_record_supersessions.record_id = candidate.id
              and canonical_record_supersessions.record_version = candidate.version
          )
        order by candidate.id, candidate.version desc, candidate.source_timestamp desc
        limit ${MAX_RECONCILIATION_RECORDS + 1}
          `,
                runSignal,
              );
              const records = rows.map((row) => {
                const databaseRecord = toDatabaseRow(row);
                const record = parseCanonicalRecord(databaseRecord["normalized_data"]);
                const identity = reconciliationRecordIdentity(record);
                if (
                  identity.id !== databaseScalar(databaseRecord["id"], "canonical_record.id") ||
                  identity.version !==
                    databaseInteger(databaseRecord["version"], "canonical_record.version") ||
                  identity.contentSha256 !==
                    databaseScalar(
                      databaseRecord["content_sha256"],
                      "canonical_record.content_sha256",
                    )
                ) {
                  throw new Error("canonical record content identity is inconsistent");
                }
                return record;
              });
              assertRunCreationActive(runSignal);
              const identity = identifyReconciliation({
                organizationId: tenant.organizationId,
                policy,
                records,
              });
              assertRunCreationActive(runSignal);
              const existing = await runCreationQuery(
                transaction`
        select
          id, stable_run_key, status, policy_version, rule_set_version, engine_version,
          input_count, match_count, exception_count, error_count, dispatch_count,
          operational_state_applied, last_error_code, started_at, completed_at, created_at
        from reconciliation_runs
        where organization_id = ${tenant.organizationId}
          and stable_run_key = ${identity.runKey}
        limit 1
          `,
                runSignal,
              );
              if (existing[0]) {
                const persisted = mapReconciliationRunListItem(toDatabaseRow(existing[0]));
                if (["failed", "partial", "cancelled"].includes(persisted.status)) {
                  throw new RepositoryConflictError(
                    "an identical immutable run already exists and must be replayed from its detail view",
                  );
                }
                return persisted;
              }
              const runId = randomUUID();
              const now = new Date().toISOString();
              const policySnapshot = serializeReconciliationPolicy(policy);
              const envelope = createReconciliationEnvelope({
                organizationId: tenant.organizationId,
                runId,
                executionAttempt: 1,
                correlationId: request.correlationId,
                requestedBy: tenant.actorId,
                createdAt: now,
                ...(request.traceparent ? { traceparent: request.traceparent } : {}),
              });
              const inserted = await runCreationQuery(
                transaction`
        insert into reconciliation_runs (
          id, organization_id, stable_run_key, input_snapshot_hash, policy_snapshot_hash,
          policy_snapshot, policy_version, rule_set_version, engine_version, initiated_by,
          status, input_count, dispatch_count
        ) values (
          ${runId}, ${tenant.organizationId}, ${identity.runKey}, ${identity.inputSnapshotHash},
          ${identity.policySnapshotHash}, ${transaction.json(toJsonValue(policySnapshot))},
          ${policy.version}, ${identity.ruleSetVersion}, ${identity.engineVersion},
          ${tenant.actorId}, 'queued', ${records.length}, 1
        )
        returning
          id, stable_run_key, status, policy_version, rule_set_version, engine_version,
          input_count, match_count, exception_count, error_count, dispatch_count,
          operational_state_applied, last_error_code, started_at, completed_at, created_at
          `,
                runSignal,
              );
              const inputIdentities = records.map(reconciliationRecordIdentity);
              for (const batch of reconciliationRunInputInsertBatches(
                tenant.organizationId,
                runId,
                inputIdentities,
              )) {
                await runCreationQuery(
                  transaction`
          insert into reconciliation_run_inputs ${transaction(
            batch,
            "organization_id",
            "run_id",
            "record_id",
            "record_version",
            "content_sha256",
            "ordinal",
          )}
            `,
                  runSignal,
                );
              }
              assertRunCreationActive(runSignal);
              await insertReconciliationOutbox(transaction, envelope);
              assertRunCreationActive(runSignal);
              await insertUserAuditEvent(transaction, tenant, {
                action: "reconciliation.run.requested",
                resourceType: "reconciliation_run",
                resourceId: runId,
                correlationId: request.correlationId,
                reason: request.reason,
                newValue: {
                  status: "queued",
                  inputCount: records.length,
                  dispatchCount: 1,
                },
                versionContext: {
                  engineVersion: identity.engineVersion,
                  ruleSetVersion: identity.ruleSetVersion,
                  policyVersion: policy.version,
                  policySnapshotHash: identity.policySnapshotHash,
                  inputSnapshotHash: identity.inputSnapshotHash,
                },
              });
              assertRunCreationActive(runSignal);
              const insertedRow = inserted[0] ? toDatabaseRow(inserted[0]) : undefined;
              if (!insertedRow) throw new Error("reconciliation run was not persisted");
              return mapReconciliationRunListItem(insertedRow);
            }),
        );
        return await settleReconciliationRunCreation(transactionOperation, runSignal);
      } catch (error) {
        if (error instanceof RepositoryRunCreationUnavailableError) throw error;
        if (isRunCreationInterruption(error)) {
          throw new RepositoryRunCreationUnavailableError();
        }
        throw error;
      }
    } finally {
      clearTimeout(deadline);
    }
  }

  public async replayRun(
    tenant: TenantContext,
    runId: string,
    request: { readonly correlationId: string; readonly reason: string; readonly now: string },
  ): Promise<ReconciliationRunListItem> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      await transaction`
        select pg_advisory_xact_lock(hashtextextended(${runId}, 2))
      `;
      const selected = await transaction`
        select
          id, stable_run_key, status, policy_version, rule_set_version, engine_version,
          input_snapshot_hash, policy_snapshot_hash, input_count, match_count, exception_count,
          error_count, dispatch_count, operational_state_applied, last_error_code, started_at,
          completed_at, created_at
        from reconciliation_runs
        where organization_id = ${tenant.organizationId}
          and id = ${runId}::uuid
        limit 1
      `;
      const row = selected[0] ? toDatabaseRow(selected[0]) : undefined;
      if (!row) throw new RepositoryNotFoundError();
      const status = runStatusSchema.parse(row["status"]);
      if (!["failed", "partial", "cancelled"].includes(status)) {
        throw new RepositoryConflictError(
          "only failed, partial, or cancelled runs can be replayed",
        );
      }
      const previousDispatchCount = databaseInteger(row["dispatch_count"], "dispatch_count");
      if (previousDispatchCount >= 100) {
        throw new RepositoryConflictError("the run reached its bounded replay limit");
      }
      const executionAttempt = previousDispatchCount + 1;
      const envelope = createReconciliationEnvelope({
        organizationId: tenant.organizationId,
        runId,
        executionAttempt,
        correlationId: request.correlationId,
        requestedBy: tenant.actorId,
        createdAt: request.now,
      });
      const requeued = await transaction`
        select reconai_requeue_reconciliation_run(
          ${tenant.organizationId}::uuid,
          ${runId}::uuid
        ) as dispatch_count
      `;
      const persistedDispatchCount = requeued[0]
        ? toDatabaseRow(requeued[0])["dispatch_count"]
        : undefined;
      if (
        persistedDispatchCount === null ||
        persistedDispatchCount === undefined ||
        databaseInteger(persistedDispatchCount, "dispatch_count") !== executionAttempt
      ) {
        throw new RepositoryConflictError("the run is no longer eligible for replay");
      }
      const updated = await transaction`
        select
          id, stable_run_key, status, policy_version, rule_set_version, engine_version,
          input_count, match_count, exception_count, error_count, dispatch_count,
          operational_state_applied, last_error_code, started_at, completed_at, created_at
        from reconciliation_runs
        where organization_id = ${tenant.organizationId}
          and id = ${runId}::uuid
        limit 1
      `;
      await insertReconciliationOutbox(transaction, envelope);
      await insertUserAuditEvent(transaction, tenant, {
        action: "reconciliation.run.replay_requested",
        resourceType: "reconciliation_run",
        resourceId: runId,
        correlationId: request.correlationId,
        reason: request.reason,
        previousValue: {
          status,
          dispatchCount: previousDispatchCount,
          lastErrorCode: row["last_error_code"] ?? null,
        },
        newValue: {
          status: "queued",
          dispatchCount: executionAttempt,
        },
        versionContext: {
          engineVersion: databaseScalar(row["engine_version"], "engine_version"),
          ruleSetVersion: databaseScalar(row["rule_set_version"], "rule_set_version"),
          policyVersion: databaseScalar(row["policy_version"], "policy_version"),
          policySnapshotHash: databaseScalar(row["policy_snapshot_hash"], "policy_snapshot_hash"),
          inputSnapshotHash: databaseScalar(row["input_snapshot_hash"], "input_snapshot_hash"),
        },
      });
      const updatedRow = updated[0] ? toDatabaseRow(updated[0]) : undefined;
      if (!updatedRow) throw new RepositoryNotFoundError();
      return mapReconciliationRunListItem(updatedRow);
    });
  }

  public async createProposal(
    tenant: TenantContext,
    exceptionId: string,
    input: { readonly type: string; readonly reason: string },
  ): Promise<ProposalCreationResult> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const exception = await transaction`
        select id, status, severity, amount_minor, currency, evidence from exceptions
        where organization_id = ${tenant.organizationId} and id = ${exceptionId}::uuid
        limit 1
        for update
      `;
      const exceptionRow = exception[0] ? toDatabaseRow(exception[0]) : undefined;
      if (!exceptionRow) throw new RepositoryNotFoundError();
      const exceptionStatus = String(exceptionRow["status"]);
      if (!["open", "assigned", "deferred", "rejected", "proposed"].includes(exceptionStatus)) {
        throw new RepositoryConflictError("the exception cannot receive a new proposal");
      }
      const pending = await transaction`
        select
          resolution_proposals.id,
          resolution_proposals.version,
          resolution_proposals.proposed_by,
          resolution_proposals.proposal_type,
          resolution_proposals.required_approvals,
          (
            select count(*)::integer
            from approvals
            where approvals.organization_id = resolution_proposals.organization_id
              and approvals.proposal_id = resolution_proposals.id
              and approvals.proposal_version = resolution_proposals.version
          ) as approval_count
        from resolution_proposals
        where resolution_proposals.organization_id = ${tenant.organizationId}
          and resolution_proposals.exception_id = ${exceptionId}::uuid
          and resolution_proposals.status = 'pending'
        order by resolution_proposals.version desc
        limit 2
        for update
      `;
      const pendingProposal = pending[0] ? toDatabaseRow(pending[0]) : undefined;
      let revisedFrom: ProposalCreationResult["revisedFrom"];
      if (exceptionStatus === "proposed") {
        if (!pendingProposal || pending.length !== 1) {
          throw new RepositoryConflictError(
            "the proposed exception has invalid proposal authority",
          );
        }
        if (pendingProposal["proposed_by"] !== tenant.actorId) {
          throw new RepositoryConflictError("only the proposer can revise a pending proposal");
        }
        revisedFrom = {
          id: databaseScalar(pendingProposal["id"], "proposal.id"),
          version: databaseInteger(pendingProposal["version"], "proposal.version"),
          approvalCount: databaseInteger(
            pendingProposal["approval_count"],
            "proposal.approval_count",
          ),
        };
      } else if (pending.length > 0) {
        throw new RepositoryConflictError("the exception already has a pending proposal");
      }
      const organizations = await transaction`
        select dual_approval_enabled, dual_approval_thresholds, sensitive_resolution_types
        from organizations
        where id = ${tenant.organizationId}
        limit 1
      `;
      const organization = organizations[0] ? toDatabaseRow(organizations[0]) : undefined;
      if (!organization) throw new RepositoryNotFoundError();
      const reviewPolicy = parseReviewPolicyRow(organization);
      const requiredApprovals = proposalRequiredApprovals(exceptionRow, input.type, reviewPolicy);
      const proposalId = randomUUID();
      const versions = await transaction`
        select coalesce(max(version), 0)::integer + 1 as next_version
        from resolution_proposals
        where organization_id = ${tenant.organizationId}
          and exception_id = ${exceptionId}::uuid
      `;
      const version = databaseInteger(
        toDatabaseRow(versions[0])["next_version"],
        "proposal.next_version",
      );
      if (revisedFrom) {
        const superseded = await transaction`
          update resolution_proposals
          set status = 'superseded'
          where organization_id = ${tenant.organizationId}
            and id = ${revisedFrom.id}::uuid
            and version = ${revisedFrom.version}
            and status = 'pending'
          returning id
        `;
        if (superseded.length !== 1) {
          throw new RepositoryConflictError("the pending proposal changed before revision");
        }
      }
      await transaction`
        insert into resolution_proposals (
          id, organization_id, exception_id, version, proposed_by, proposal_type,
          reason, evidence, status, required_approvals
        ) values (
          ${proposalId}, ${tenant.organizationId}, ${exceptionId}, ${version}, ${tenant.actorId},
          ${input.type}, ${input.reason}, '{}'::jsonb, 'pending', ${requiredApprovals}
        )
      `;
      await transaction`
        update exceptions set status = 'proposed', updated_at = now()
        where organization_id = ${tenant.organizationId} and id = ${exceptionId}::uuid
      `;
      await insertUserAuditEvent(transaction, tenant, {
        action: revisedFrom ? "resolution.revised" : "resolution.proposed",
        resourceType: "resolution_proposal",
        resourceId: proposalId,
        reason: input.reason,
        ...(revisedFrom
          ? {
              previousValue: {
                proposalId: revisedFrom.id,
                proposalVersion: revisedFrom.version,
                approvalCount: revisedFrom.approvalCount,
                status: "pending",
              },
            }
          : {}),
        newValue: {
          exceptionId,
          proposalType: input.type,
          version,
          requiredApprovals,
          ...(revisedFrom
            ? {
                supersedesProposalId: revisedFrom.id,
                supersedesProposalVersion: revisedFrom.version,
                supersededProposalStatus: "superseded",
              }
            : {}),
        },
        versionContext: {},
      });
      return { id: proposalId, version, ...(revisedFrom ? { revisedFrom } : {}) };
    });
  }

  public async approveProposal(
    tenant: TenantContext,
    proposalId: string,
    input: { readonly decision: "approve" | "reject"; readonly reason: string },
  ): Promise<{
    readonly id: string;
    readonly decision: "approve" | "reject";
    readonly status: "pending" | "approved" | "rejected";
    readonly approvalCount: number;
    readonly requiredApprovals: number;
    readonly proposalCreatedAt: string;
    readonly decidedAt: string;
    readonly exceptionCreatedAt: string;
    readonly exceptionStatusChangedAt: string;
  }> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const proposalAuthorityRows = await transaction`
        select exception_id
        from resolution_proposals
        where organization_id = ${tenant.organizationId}
          and id = ${proposalId}::uuid
        limit 1
      `;
      const proposalAuthority = proposalAuthorityRows[0]
        ? toDatabaseRow(proposalAuthorityRows[0])
        : undefined;
      if (!proposalAuthority) throw new RepositoryNotFoundError();
      const exceptionId = databaseScalar(
        proposalAuthority["exception_id"],
        "proposal.exception_id",
      );
      const exceptionRows = await transaction`
        select status, created_at
        from exceptions
        where organization_id = ${tenant.organizationId}
          and id = ${exceptionId}::uuid
        limit 1
        for update
      `;
      const exception = exceptionRows[0] ? toDatabaseRow(exceptionRows[0]) : undefined;
      if (!exception) throw new RepositoryNotFoundError();
      const rows = await transaction`
        select
          resolution_proposals.id,
          resolution_proposals.exception_id,
          resolution_proposals.version,
          resolution_proposals.proposed_by,
          resolution_proposals.status,
          resolution_proposals.required_approvals,
          resolution_proposals.created_at
        from resolution_proposals
        where resolution_proposals.organization_id = ${tenant.organizationId}
          and resolution_proposals.id = ${proposalId}::uuid
        order by version desc
        limit 1
        for update
      `;
      const resultRow = rows[0];
      if (!resultRow) throw new RepositoryNotFoundError();
      const proposal = toDatabaseRow(resultRow);
      if (proposal["status"] !== "pending") {
        throw new RepositoryConflictError("the proposal has already been decided");
      }
      if (exception["status"] !== "proposed") {
        throw new RepositoryConflictError("the exception is no longer awaiting this proposal");
      }
      const proposedBy = proposal["proposed_by"]
        ? databaseScalar(proposal["proposed_by"], "proposal.proposed_by")
        : undefined;
      if (proposedBy === tenant.actorId) {
        throw new RepositoryConflictError("proposer cannot decide their own proposal");
      }
      const priorDecision = await transaction`
        select id
        from approvals
        where organization_id = ${tenant.organizationId}
          and proposal_id = ${proposalId}::uuid
          and proposal_version = ${Number(proposal["version"])}
          and actor_id = ${tenant.actorId}
        limit 1
      `;
      if (priorDecision.length > 0) {
        throw new RepositoryConflictError("reviewer has already decided this proposal");
      }
      const approvalId = randomUUID();
      const insertedApprovals = await transaction`
        insert into approvals (
          id, organization_id, proposal_id, proposal_version, actor_id, decision, reason
        ) values (
          ${approvalId}, ${tenant.organizationId}, ${proposalId},
          ${Number(proposal["version"])}, ${tenant.actorId}, ${input.decision}, ${input.reason}
        )
        returning created_at
      `;
      const insertedApproval = insertedApprovals[0]
        ? toDatabaseRow(insertedApprovals[0])
        : undefined;
      if (!insertedApproval) throw new RepositoryNotFoundError();
      const proposalCreatedAt = databaseTimestamp(proposal["created_at"], "proposal.created_at");
      const decidedAt = databaseTimestamp(insertedApproval["created_at"], "approval.created_at");
      const exceptionCreatedAt = databaseTimestamp(exception["created_at"], "exception.created_at");
      const requiredApprovals = databaseInteger(
        proposal["required_approvals"],
        "proposal.required_approvals",
      );
      const approvalCounts = await transaction`
        select count(*)::integer as approval_count
        from approvals
        where organization_id = ${tenant.organizationId}
          and proposal_id = ${proposalId}::uuid
          and proposal_version = ${Number(proposal["version"])}
          and decision = 'approve'
      `;
      const approvalCount = databaseInteger(
        toDatabaseRow(approvalCounts[0])["approval_count"],
        "proposal.approval_count",
      );
      const proposalStatus =
        input.decision === "reject"
          ? "rejected"
          : approvalCount >= requiredApprovals
            ? "approved"
            : "pending";
      const exceptionStatus =
        proposalStatus === "approved"
          ? "approved"
          : proposalStatus === "rejected"
            ? "open"
            : "proposed";
      await transaction`
        update resolution_proposals
        set status = ${proposalStatus}
        where organization_id = ${tenant.organizationId} and id = ${proposalId}::uuid
          and version = ${Number(proposal["version"])}
      `;
      const updatedExceptions = await transaction`
        update exceptions
        set status = ${exceptionStatus}, updated_at = now()
        where organization_id = ${tenant.organizationId}
          and id = ${exceptionId}::uuid
        returning updated_at
      `;
      const updatedException = updatedExceptions[0]
        ? toDatabaseRow(updatedExceptions[0])
        : undefined;
      if (!updatedException) throw new RepositoryNotFoundError();
      const exceptionStatusChangedAt = databaseTimestamp(
        updatedException["updated_at"],
        "exception.updated_at",
      );
      await insertUserAuditEvent(transaction, tenant, {
        action: `resolution.${input.decision}`,
        resourceType: "resolution_proposal",
        resourceId: proposalId,
        reason: input.reason,
        newValue: {
          decision: input.decision,
          proposalVersion: Number(proposal["version"]),
          approvalCount,
          requiredApprovals,
          proposalStatus,
          exceptionStatus,
        },
        versionContext: {},
      });
      return {
        id: approvalId,
        decision: input.decision,
        status: proposalStatus,
        approvalCount,
        requiredApprovals,
        proposalCreatedAt,
        decidedAt,
        exceptionCreatedAt,
        exceptionStatusChangedAt,
      };
    });
  }

  public async getOrganizationProfile(tenant: TenantContext): Promise<OrganizationProfile> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select name, business_time_zone, profile_version, updated_at
        from organizations
        where id = ${tenant.organizationId}
        limit 1
      `;
      const row = rows[0] ? toDatabaseRow(rows[0]) : undefined;
      if (!row) throw new RepositoryNotFoundError();
      return organizationProfileFromRow(row);
    });
  }

  public async updateOrganizationProfile(
    tenant: TenantContext,
    input: OrganizationProfileUpdate,
  ): Promise<OrganizationProfile> {
    const name = OrganizationNameSchema.parse(input.name);
    if (!Number.isSafeInteger(input.expectedProfileVersion) || input.expectedProfileVersion < 1) {
      throw new RepositoryConflictError("organization profile version is invalid");
    }
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select name, business_time_zone, profile_version, updated_at
        from organizations
        where id = ${tenant.organizationId}
        limit 1
        for update
      `;
      const row = rows[0] ? toDatabaseRow(rows[0]) : undefined;
      if (!row) throw new RepositoryNotFoundError();
      const previous = organizationProfileFromRow(row);
      if (previous.profileVersion !== input.expectedProfileVersion) {
        throw new RepositoryConflictError("organization profile changed; reload before retrying");
      }
      if (previous.name === name) return previous;

      const updated = await transaction`
        update organizations
        set
          name = ${name},
          profile_version = profile_version + 1,
          updated_at = now()
        where id = ${tenant.organizationId}
          and profile_version = ${input.expectedProfileVersion}
        returning name, business_time_zone, profile_version, updated_at
      `;
      const updatedRow = updated[0] ? toDatabaseRow(updated[0]) : undefined;
      if (!updatedRow) {
        throw new RepositoryConflictError("organization profile changed; reload before retrying");
      }
      const next = organizationProfileFromRow(updatedRow);
      await insertUserAuditEvent(transaction, tenant, {
        action: "organization.profile.updated",
        resourceType: "organization",
        resourceId: tenant.organizationId,
        reason: input.reason,
        previousValue: previous,
        newValue: next,
        versionContext: { organizationProfileSchemaVersion: 1 },
      });
      return next;
    });
  }

  public async getReviewPolicy(tenant: TenantContext): Promise<ReviewPolicy> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select
          dual_approval_enabled,
          dual_approval_thresholds,
          sensitive_resolution_types,
          updated_at
        from organizations
        where id = ${tenant.organizationId}
        limit 1
      `;
      const row = rows[0] ? toDatabaseRow(rows[0]) : undefined;
      if (!row) throw new RepositoryNotFoundError();
      return reviewPolicyFromRow(row);
    });
  }

  public async updateReviewPolicy(
    tenant: TenantContext,
    input: ReviewPolicyUpdate,
  ): Promise<ReviewPolicy> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select
          dual_approval_enabled,
          dual_approval_thresholds,
          sensitive_resolution_types,
          updated_at
        from organizations
        where id = ${tenant.organizationId}
        limit 1
        for update
      `;
      const row = rows[0] ? toDatabaseRow(rows[0]) : undefined;
      if (!row) throw new RepositoryNotFoundError();
      const previous = reviewPolicyFromRow(row);
      const updated = await transaction`
        update organizations
        set
          dual_approval_enabled = ${input.dualApprovalEnabled},
          dual_approval_thresholds = ${transaction.json(input.dualApprovalThresholds)},
          sensitive_resolution_types = ${transaction.json(input.sensitiveResolutionTypes)},
          updated_at = now()
        where id = ${tenant.organizationId}
        returning
          dual_approval_enabled,
          dual_approval_thresholds,
          sensitive_resolution_types,
          updated_at
      `;
      const resultRow = updated[0] ? toDatabaseRow(updated[0]) : undefined;
      if (!resultRow) throw new RepositoryNotFoundError();
      const next = reviewPolicyFromRow(resultRow);
      await insertUserAuditEvent(transaction, tenant, {
        action: "organization.review_policy.updated",
        resourceType: "organization",
        resourceId: tenant.organizationId,
        reason: input.reason,
        previousValue: previous,
        newValue: next,
        versionContext: {},
      });
      return next;
    });
  }

  public async getRetentionPolicy(tenant: TenantContext): Promise<RetentionPolicy> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select
          raw_import_retention_days,
          provider_event_retention_days,
          legal_hold_enabled,
          legal_hold_reason,
          updated_at
        from organization_retention_policies
        where organization_id = ${tenant.organizationId}
        limit 1
      `;
      return rows[0] ? retentionPolicyFromRow(toDatabaseRow(rows[0])) : disabledRetentionPolicy();
    });
  }

  public async updateRetentionPolicy(
    tenant: TenantContext,
    input: RetentionPolicyUpdate,
  ): Promise<RetentionPolicy> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const organizations = await transaction`
        select id
        from organizations
        where id = ${tenant.organizationId}
        limit 1
        for update
      `;
      if (!organizations[0]) throw new RepositoryNotFoundError();
      const currentRows = await transaction`
        select
          raw_import_retention_days,
          provider_event_retention_days,
          legal_hold_enabled,
          legal_hold_reason,
          updated_at
        from organization_retention_policies
        where organization_id = ${tenant.organizationId}
        limit 1
        for update
      `;
      const previous = currentRows[0]
        ? retentionPolicyFromRow(toDatabaseRow(currentRows[0]))
        : disabledRetentionPolicy();
      const updated = await transaction`
        insert into organization_retention_policies (
          organization_id,
          raw_import_retention_days,
          provider_event_retention_days,
          legal_hold_enabled,
          legal_hold_reason,
          updated_by_membership_id,
          created_at,
          updated_at
        ) values (
          ${tenant.organizationId},
          ${input.rawImportRetentionDays},
          ${input.providerEventRetentionDays},
          ${input.legalHoldEnabled},
          ${input.legalHoldEnabled ? input.legalHoldReason : null},
          ${tenant.membershipId},
          statement_timestamp(),
          statement_timestamp()
        )
        on conflict (organization_id)
        do update set
          raw_import_retention_days = excluded.raw_import_retention_days,
          provider_event_retention_days = excluded.provider_event_retention_days,
          legal_hold_enabled = excluded.legal_hold_enabled,
          legal_hold_reason = excluded.legal_hold_reason,
          updated_by_membership_id = excluded.updated_by_membership_id,
          updated_at = statement_timestamp()
        returning
          raw_import_retention_days,
          provider_event_retention_days,
          legal_hold_enabled,
          legal_hold_reason,
          updated_at
      `;
      const row = updated[0] ? toDatabaseRow(updated[0]) : undefined;
      if (!row) throw new RepositoryNotFoundError();
      const next = retentionPolicyFromRow(row);
      await insertUserAuditEvent(transaction, tenant, {
        action: "organization.retention_policy.updated",
        resourceType: "organization_retention_policy",
        resourceId: tenant.organizationId,
        reason: input.reason,
        previousValue: previous,
        newValue: next,
        versionContext: { policySchemaVersion: 1 },
      });
      return next;
    });
  }

  public async listMembers(tenant: TenantContext): Promise<readonly OrganizationMember[]> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select
          memberships.id,
          memberships.user_id,
          users.email,
          memberships.role,
          memberships.status,
          memberships.created_at,
          memberships.updated_at
        from memberships
        join users on users.id = memberships.user_id
        where memberships.organization_id = ${tenant.organizationId}
        order by
          case memberships.role
            when 'owner' then 0
            when 'administrator' then 1
            when 'reviewer' then 2
            when 'analyst' then 3
            else 4
          end,
          memberships.created_at,
          memberships.id
      `;
      return rows.map((row) => mapOrganizationMember(toDatabaseRow(row)));
    });
  }

  public async updateMember(
    tenant: TenantContext,
    membershipId: string,
    input: {
      readonly role: Role;
      readonly status: "active" | "deactivated";
      readonly reason: string;
    },
  ): Promise<OrganizationMember> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      await transaction`
        select pg_advisory_xact_lock(hashtextextended(${tenant.organizationId}, 3))
      `;
      const rows = await transaction`
        select
          memberships.id,
          memberships.user_id,
          users.email,
          memberships.role,
          memberships.status,
          memberships.created_at,
          memberships.updated_at
        from memberships
        join users on users.id = memberships.user_id
        where memberships.organization_id = ${tenant.organizationId}
          and memberships.id = ${membershipId}::uuid
        limit 1
        for update of memberships
      `;
      const row = rows[0] ? toDatabaseRow(rows[0]) : undefined;
      if (!row) throw new RepositoryNotFoundError();
      const previous = mapOrganizationMember(row);
      const actorRows = await transaction`
        select role
        from memberships
        where organization_id = ${tenant.organizationId}
          and id = ${tenant.membershipId}
          and status = 'active'
        limit 1
        for share
      `;
      const actorRow = actorRows[0] ? toDatabaseRow(actorRows[0]) : undefined;
      if (!actorRow) throw new RepositoryNotFoundError();
      const actorRole = RoleSchema.parse(actorRow["role"]);
      const owners = await transaction`
        select count(*)::integer as owner_count
        from memberships
        where organization_id = ${tenant.organizationId}
          and role = 'owner'
          and status = 'active'
          and id <> ${membershipId}::uuid
      `;
      try {
        validateMembershipTransition({
          actorMembershipId: tenant.membershipId,
          actorRole,
          targetMembershipId: previous.id,
          targetRole: previous.role,
          targetStatus: previous.status,
          nextRole: input.role,
          nextStatus: input.status,
          otherActiveOwnerCount: databaseInteger(
            toDatabaseRow(owners[0])["owner_count"],
            "membership.owner_count",
          ),
        });
      } catch (error) {
        if (error instanceof MembershipPolicyError) {
          throw new RepositoryConflictError(error.message);
        }
        throw error;
      }
      const updated = await transaction`
        update memberships
        set role = ${input.role}, status = ${input.status}, updated_at = now()
        where organization_id = ${tenant.organizationId}
          and id = ${membershipId}::uuid
        returning id, user_id, role, status, created_at, updated_at
      `;
      const updatedRow = updated[0] ? toDatabaseRow(updated[0]) : undefined;
      if (!updatedRow) throw new RepositoryNotFoundError();
      const next = mapOrganizationMember({ ...updatedRow, email: previous.email });
      await insertUserAuditEvent(transaction, tenant, {
        action: "organization.membership.updated",
        resourceType: "membership",
        resourceId: membershipId,
        reason: input.reason,
        previousValue: previous,
        newValue: next,
        versionContext: {},
      });
      return next;
    });
  }

  public async listInvitations(tenant: TenantContext): Promise<readonly OrganizationInvitation[]> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select
          id,
          email,
          role,
          case
            when status = 'pending' and expires_at <= statement_timestamp() then 'expired'
            else status::text
          end as status,
          invited_by_membership_id,
          accepted_by_user_id,
          accepted_membership_id,
          expires_at,
          accepted_at,
          revoked_at,
          created_at,
          updated_at
        from organization_invitations
        where organization_id = ${tenant.organizationId}
        order by created_at desc, id desc
        limit 200
      `;
      return rows.map((row) => mapOrganizationInvitation(toDatabaseRow(row)));
    });
  }

  public async createInvitation(
    tenant: TenantContext,
    input: { readonly email: string; readonly role: Role; readonly reason: string },
  ): Promise<CreatedOrganizationInvitation> {
    const email = InvitationEmailSchema.parse(input.email);
    const invitationId = randomUUID();
    const acceptToken = randomBytes(32).toString("base64url");
    const tokenSha256 = createHash("sha256").update(acceptToken).digest("hex");
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      await transaction`
        select pg_advisory_xact_lock(hashtextextended(${tenant.organizationId}, 4))
      `;
      const actorRows = await transaction`
        select role
        from memberships
        where organization_id = ${tenant.organizationId}
          and id = ${tenant.membershipId}
          and status = 'active'
        limit 1
        for share
      `;
      const actorRow = actorRows[0] ? toDatabaseRow(actorRows[0]) : undefined;
      if (!actorRow) throw new RepositoryNotFoundError();
      try {
        validateInvitationRole(RoleSchema.parse(actorRow["role"]), input.role);
      } catch (error) {
        if (error instanceof MembershipPolicyError) {
          throw new RepositoryConflictError(error.message);
        }
        throw error;
      }

      const createdRows = await transaction`
        select reconai_create_organization_invitation(
          ${tenant.organizationId},
          ${invitationId}::uuid,
          ${email},
          ${input.role},
          ${tokenSha256},
          ${tenant.membershipId},
          ${expiresAt}::timestamptz
        ) as created
      `;
      if (
        !createdRows[0] ||
        !databaseBoolean(toDatabaseRow(createdRows[0])["created"], "invitation.created")
      ) {
        throw new RepositoryConflictError(
          "an invitation or membership already exists for this verified email",
        );
      }

      const rows = await transaction`
        select
          id,
          email,
          role,
          status::text as status,
          invited_by_membership_id,
          accepted_by_user_id,
          accepted_membership_id,
          expires_at,
          accepted_at,
          revoked_at,
          created_at,
          updated_at
        from organization_invitations
        where organization_id = ${tenant.organizationId}
          and id = ${invitationId}::uuid
        limit 1
      `;
      const row = rows[0] ? toDatabaseRow(rows[0]) : undefined;
      if (!row) throw new RepositoryNotFoundError();
      const invitation = mapOrganizationInvitation(row);
      await insertUserAuditEvent(transaction, tenant, {
        action: "organization.invitation.created",
        resourceType: "organization_invitation",
        resourceId: invitation.id,
        reason: input.reason,
        newValue: {
          email: invitation.email,
          role: invitation.role,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
        },
        versionContext: {},
      });
      return { ...invitation, acceptToken };
    });
  }

  public async recordInvitationDelivery(
    tenant: TenantContext,
    invitationId: string,
    delivery: InvitationDeliveryAudit,
  ): Promise<void> {
    await withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select id
        from organization_invitations
        where organization_id = ${tenant.organizationId}
          and id = ${invitationId}::uuid
        limit 1
      `;
      if (!rows[0]) throw new RepositoryNotFoundError();
      await insertUserAuditEvent(transaction, tenant, {
        action: `organization.invitation.delivery.${delivery.status}`,
        resourceType: "organization_invitation",
        resourceId: invitationId,
        correlationId: delivery.correlationId,
        reason:
          delivery.status === "accepted"
            ? "Invitation email accepted by delivery provider"
            : delivery.status === "not_configured"
              ? "Invitation email delivery is not configured"
              : "Invitation email delivery failed",
        newValue: {
          status: delivery.status,
          provider: delivery.provider,
          ...(delivery.providerMessageId ? { providerMessageId: delivery.providerMessageId } : {}),
          ...(delivery.errorCode ? { errorCode: delivery.errorCode } : {}),
        },
        versionContext: { templateVersion: "organization_invitation_v1" },
      });
    });
  }

  public async revokeInvitation(
    tenant: TenantContext,
    invitationId: string,
    input: { readonly reason: string },
  ): Promise<OrganizationInvitation> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      await transaction`
        select pg_advisory_xact_lock(hashtextextended(${tenant.organizationId}, 4))
      `;
      const previousRows = await transaction`
        select
          id,
          email,
          role,
          case
            when status = 'pending' and expires_at <= statement_timestamp() then 'expired'
            else status::text
          end as status,
          invited_by_membership_id,
          accepted_by_user_id,
          accepted_membership_id,
          expires_at,
          accepted_at,
          revoked_at,
          created_at,
          updated_at
        from organization_invitations
        where organization_id = ${tenant.organizationId}
          and id = ${invitationId}::uuid
        limit 1
      `;
      const previousRow = previousRows[0] ? toDatabaseRow(previousRows[0]) : undefined;
      if (!previousRow) throw new RepositoryNotFoundError();
      const previous = mapOrganizationInvitation(previousRow);
      if (previous.status !== "pending" && previous.status !== "expired") {
        throw new RepositoryConflictError("only a pending invitation can be revoked");
      }

      const resultRows = await transaction`
        select reconai_revoke_organization_invitation(
          ${tenant.organizationId},
          ${invitationId}::uuid,
          ${tenant.membershipId}
        ) as status
      `;
      const statusValue = resultRows[0] ? toDatabaseRow(resultRows[0])["status"] : undefined;
      if (!statusValue) throw new RepositoryNotFoundError();
      const transition = invitationStatusSchema.parse(statusValue);

      const rows = await transaction`
        select
          id,
          email,
          role,
          status::text as status,
          invited_by_membership_id,
          accepted_by_user_id,
          accepted_membership_id,
          expires_at,
          accepted_at,
          revoked_at,
          created_at,
          updated_at
        from organization_invitations
        where organization_id = ${tenant.organizationId}
          and id = ${invitationId}::uuid
        limit 1
      `;
      const row = rows[0] ? toDatabaseRow(rows[0]) : undefined;
      if (!row) throw new RepositoryNotFoundError();
      const invitation = mapOrganizationInvitation(row);
      await insertUserAuditEvent(transaction, tenant, {
        action:
          transition === "expired"
            ? "organization.invitation.expired"
            : "organization.invitation.revoked",
        resourceType: "organization_invitation",
        resourceId: invitation.id,
        reason: input.reason,
        previousValue: previous,
        newValue: invitation,
        versionContext: {},
      });
      return invitation;
    });
  }

  public async acceptInvitation(
    identity: VerifiedIdentity,
    token: string,
    request: { readonly correlationId: string },
  ): Promise<AcceptedOrganizationInvitation> {
    if (!identity.emailVerified || !identity.email) throw new VerifiedEmailRequiredError();
    const emailResult = InvitationEmailSchema.safeParse(identity.email);
    if (!emailResult.success) throw new VerifiedEmailRequiredError();
    const tokenResult = invitationAcceptTokenSchema.safeParse(token);
    if (!tokenResult.success) throw new RepositoryNotFoundError();
    const tokenSha256 = createHash("sha256").update(tokenResult.data).digest("hex");
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`
        select *
        from reconai_accept_organization_invitation(
          ${tokenSha256},
          ${identity.issuer},
          ${identity.subject},
          ${emailResult.data},
          ${randomUUID()}::uuid,
          ${randomUUID()}::uuid
        )
      `;
      const row = rows[0] ? toDatabaseRow(rows[0]) : undefined;
      if (!row) throw new RepositoryNotFoundError();
      const organizationId = OrganizationIdSchema.parse(row["organization_id"]);
      const membershipId = MembershipIdSchema.parse(row["membership_id"]);
      const userId = UserIdSchema.parse(row["user_id"]);
      const role = RoleSchema.parse(row["membership_role"]);
      const invitationId = databaseScalar(row["invitation_id"], "invitation.id");
      await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
      const tenant = tenantContextFromMembership({
        id: membershipId,
        organizationId,
        userId,
        role,
        status: "active",
      });
      await insertUserAuditEvent(transaction, tenant, {
        action: "organization.invitation.accepted",
        resourceType: "organization_invitation",
        resourceId: invitationId,
        correlationId: request.correlationId,
        reason: "Authenticated user accepted a verified-email invitation",
        newValue: {
          membershipId,
          userId,
          role,
        },
        versionContext: {},
      });
      return {
        organizationId,
        invitationId,
        membershipId,
        userId,
        role,
      };
    });
  }

  public async listConnections(tenant: TenantContext): Promise<readonly ConnectionHealthItem[]> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select
          connections.id,
          connections.provider,
          connections.external_account_id,
          connections.status,
          connections.connector_version,
          (
            connections.provider IN ('shopify', 'stripe')
            and connections.api_credential_reference is not null
          ) as sync_enabled,
          connections.api_version,
          connections.last_successful_sync_at,
          connections.last_verified_webhook_at,
          connections.updated_at,
          (
            select count(*)::integer
            from outbox_events
            where outbox_events.organization_id = connections.organization_id
              and outbox_events.payload ->> 'connectionId' = connections.id::text
              and outbox_events.published_at is null
              and outbox_events.dead_lettered_at is null
              and outbox_events.attempts > 0
          ) as retry_count,
          (
            select count(*)::integer
            from outbox_events
            where outbox_events.organization_id = connections.organization_id
              and outbox_events.payload ->> 'connectionId' = connections.id::text
              and outbox_events.dead_lettered_at is not null
          ) as dead_letter_count,
          (
            select source_events.last_error_code
            from source_events
            where source_events.organization_id = connections.organization_id
              and source_events.connection_id = connections.id
              and source_events.last_error_code is not null
            order by source_events.received_at desc, source_events.id desc
            limit 1
          ) as error_code
        from data_source_connections as connections
        where connections.organization_id = ${tenant.organizationId}
        order by connections.provider, connections.created_at, connections.id
      `;
      const watermarkRows = await transaction`
        select
          source_events.connection_id,
          classified.object_family as external_object_type,
          max(source_events.source_timestamp) as latest_source_at,
          max(source_events.received_at) as latest_received_at
        from source_event_object_classifications as classifications
        inner join source_events
          on source_events.organization_id = classifications.organization_id
         and source_events.id = classifications.source_event_id
        cross join lateral unnest(classifications.object_families)
          as classified(object_family)
        where classifications.organization_id = ${tenant.organizationId}
          and source_events.organization_id = ${tenant.organizationId}
          and classifications.classifier_version = 'source-object-family-v1'
        group by source_events.connection_id, classified.object_family
        order by source_events.connection_id, classified.object_family
      `;
      const unclassifiedRows = await transaction`
        select
          source_events.connection_id,
          count(*)::integer as unclassified_count
        from source_events
        left join source_event_object_classifications as classifications
          on classifications.organization_id = source_events.organization_id
         and classifications.source_event_id = source_events.id
         and classifications.classifier_version = 'source-object-family-v1'
        where source_events.organization_id = ${tenant.organizationId}
          and classifications.source_event_id is null
          and (
            source_events.source in ('stripe', 'accounting_csv')
            or (
              source_events.source = 'shopify'
              and source_events.external_object_type not in (
                'customers/data_request',
                'customers/redact',
                'shop/redact'
              )
            )
          )
        group by source_events.connection_id
        order by source_events.connection_id
      `;
      return mapConnectionHealthRows(
        rows.map((row) => toDatabaseRow(row)),
        watermarkRows.map((row) => toDatabaseRow(row)),
        unclassifiedRows.map((row) => toDatabaseRow(row)),
      );
    });
  }

  public async listAuditEvents(
    tenant: TenantContext,
    options: { readonly limit: number },
  ): Promise<readonly AuditEventListItem[]> {
    return withTenantTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select
          id,
          actor_type,
          actor_id,
          action,
          resource_type,
          resource_id,
          occurred_at,
          correlation_id,
          reason,
          previous_value,
          new_value,
          version_context
        from audit_events
        where organization_id = ${tenant.organizationId}
        order by occurred_at desc, id desc
        limit ${options.limit}
      `;
      return rows.map((row) => mapAuditEvent(toDatabaseRow(row)));
    });
  }
}

const dualApprovalThresholdsSchema = z
  .record(z.string().regex(/^[A-Z]{3}$/u), z.string().regex(/^(0|[1-9][0-9]{0,30})$/u))
  .refine((value) => Object.keys(value).length <= 50);
const sensitiveResolutionTypesSchema = z.array(z.string().regex(/^[a-z0-9_]{1,100}$/u)).max(50);
const membershipStatusSchema = z.enum(["invited", "active", "deactivated"]);
const invitationStatusSchema = z.enum(["pending", "accepted", "revoked", "expired"]);
const invitationAcceptTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const connectionProviderSchema = z.enum(["shopify", "stripe", "accounting_csv"]);
const connectionObjectTypeSchema = SourceObjectFamilySchema;
const expectedObjectTypesByProvider = {
  shopify: ["order", "refund_transaction"],
  stripe: ["payment_intent", "refund", "balance_transaction"],
  accounting_csv: ["csv_row"],
} as const satisfies Readonly<
  Record<z.infer<typeof connectionProviderSchema>, readonly ConnectionObjectType[]>
>;
const connectionHealthStatusSchema = z.enum([
  "healthy",
  "backfilling",
  "degraded",
  "stale",
  "disconnected",
  "action_required",
]);
const editableExceptionStatusSchema = z.enum(["open", "assigned", "deferred"]);
const artifactEvidenceFidelitySchema = z.enum([
  "exact_at_observation",
  "legacy_current_projection",
]);
const browserRecordReferencesSchema = z.array(z.uuid()).max(500);
const sourceFieldProvenanceSchema = z
  .object({
    fieldPath: z.string().min(1).max(500),
    normalizedValue: z.string().max(4_096),
    transformationRule: z.string().min(1).max(200),
    transformationVersion: z.string().min(1).max(100),
    warnings: z.array(z.string().min(1).max(200)).max(20),
  })
  .strict();
const auditActorTypeSchema = z.enum(["user", "worker", "system", "support"]);
const runStatusSchema = z.enum([
  "queued",
  "running",
  "partial",
  "succeeded",
  "failed",
  "cancelled",
]);
const retentionDaysSchema = z.coerce.number().int().min(1).max(3650);

function organizationProfileFromRow(row: Record<string, unknown>): OrganizationProfile {
  return {
    name: OrganizationNameSchema.parse(row["name"]),
    businessTimeZone: databaseScalar(row["business_time_zone"], "organization.business_time_zone"),
    profileVersion: databaseInteger(row["profile_version"], "organization.profile_version"),
    updatedAt: databaseTimestamp(row["updated_at"], "organization.updated_at"),
  };
}

function parseReviewPolicyRow(row: Record<string, unknown>): Omit<ReviewPolicy, "updatedAt"> {
  return {
    dualApprovalEnabled: databaseBoolean(
      row["dual_approval_enabled"],
      "organization.dual_approval_enabled",
    ),
    dualApprovalThresholds: dualApprovalThresholdsSchema.parse(row["dual_approval_thresholds"]),
    sensitiveResolutionTypes: sensitiveResolutionTypesSchema.parse(
      row["sensitive_resolution_types"],
    ),
  };
}

function reviewPolicyFromRow(row: Record<string, unknown>): ReviewPolicy {
  return {
    ...parseReviewPolicyRow(row),
    updatedAt: databaseTimestamp(row["updated_at"], "organization.updated_at"),
  };
}

function disabledRetentionPolicy(): RetentionPolicy {
  return {
    rawImportRetentionDays: null,
    providerEventRetentionDays: null,
    legalHoldEnabled: false,
    legalHoldReason: null,
    updatedAt: null,
  };
}

function retentionPolicyFromRow(row: Record<string, unknown>): RetentionPolicy {
  return {
    rawImportRetentionDays:
      row["raw_import_retention_days"] === null
        ? null
        : retentionDaysSchema.parse(row["raw_import_retention_days"]),
    providerEventRetentionDays:
      row["provider_event_retention_days"] === null
        ? null
        : retentionDaysSchema.parse(row["provider_event_retention_days"]),
    legalHoldEnabled: databaseBoolean(
      row["legal_hold_enabled"],
      "retention_policy.legal_hold_enabled",
    ),
    legalHoldReason:
      row["legal_hold_reason"] === null
        ? null
        : databaseScalar(row["legal_hold_reason"], "retention_policy.legal_hold_reason"),
    updatedAt:
      row["updated_at"] === null
        ? null
        : databaseTimestamp(row["updated_at"], "retention_policy.updated_at"),
  };
}

function proposalRequiredApprovals(
  exception: Record<string, unknown>,
  proposalType: string,
  policy: Omit<ReviewPolicy, "updatedAt">,
): number {
  const currency = exception["currency"];
  const amountMinor = exception["amount_minor"];
  return requiredApprovalsForResolution(
    {
      enabled: policy.dualApprovalEnabled,
      amountThresholdsMinor: policy.dualApprovalThresholds,
      sensitiveResolutionTypes: policy.sensitiveResolutionTypes,
    },
    {
      severity: databaseScalar(exception["severity"], "exception.severity"),
      proposalType,
      confidence: exceptionConfidenceFromEvidence(exception["evidence"]),
      ...(amountMinor === null || amountMinor === undefined
        ? {}
        : { amountMinor: BigInt(databaseScalar(amountMinor, "exception.amount_minor")) }),
      ...(typeof currency === "string" ? { currency } : {}),
    },
  );
}

interface ReconciliationRunArtifactCursor {
  readonly version: 1;
  readonly organizationId: string;
  readonly runId: string;
  readonly type: ReconciliationRunArtifactType;
  readonly id: string;
}

interface ReconciliationRunInputCursor {
  readonly version: 1;
  readonly organizationId: string;
  readonly runId: string;
  readonly ordinal: number;
}

const reconciliationRunInputCursorSchema = z
  .object({
    version: z.literal(1),
    organizationId: z.uuid(),
    runId: z.uuid(),
    ordinal: z
      .number()
      .int()
      .min(0)
      .max(MAX_RECONCILIATION_RECORDS - 1),
  })
  .strict();

export function encodeReconciliationRunInputCursor(
  organizationId: string,
  runId: string,
  ordinal: number,
): string {
  const cursor = reconciliationRunInputCursorSchema.parse({
    version: 1,
    organizationId,
    runId,
    ordinal,
  });
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeReconciliationRunInputCursor(
  encoded: string,
  organizationId: string,
  runId: string,
): ReconciliationRunInputCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded)) throw new RepositoryCursorError();
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded || bytes.byteLength > 768) {
      throw new RepositoryCursorError();
    }
    const cursor = reconciliationRunInputCursorSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    );
    if (cursor.organizationId !== organizationId || cursor.runId !== runId) {
      throw new RepositoryCursorError();
    }
    return cursor;
  } catch (error) {
    if (error instanceof RepositoryCursorError) throw error;
    throw new RepositoryCursorError();
  }
}

const reconciliationRunArtifactCursorSchema = z
  .object({
    version: z.literal(1),
    organizationId: z.uuid(),
    runId: z.uuid(),
    type: z.enum(["match", "exception"]),
    id: z.uuid(),
  })
  .strict();

export function encodeReconciliationRunArtifactCursor(
  organizationId: string,
  runId: string,
  type: ReconciliationRunArtifactType,
  id: string,
): string {
  const cursor = reconciliationRunArtifactCursorSchema.parse({
    version: 1,
    organizationId,
    runId,
    type,
    id,
  });
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeReconciliationRunArtifactCursor(
  encoded: string,
  organizationId: string,
  runId: string,
  type: ReconciliationRunArtifactType,
): ReconciliationRunArtifactCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded)) throw new RepositoryCursorError();
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded || bytes.byteLength > 768) {
      throw new RepositoryCursorError();
    }
    const cursor = reconciliationRunArtifactCursorSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    );
    if (
      cursor.organizationId !== organizationId ||
      cursor.runId !== runId ||
      cursor.type !== type
    ) {
      throw new RepositoryCursorError();
    }
    return cursor;
  } catch (error) {
    if (error instanceof RepositoryCursorError) throw error;
    throw new RepositoryCursorError();
  }
}

interface ExceptionListCursor {
  readonly version: 2;
  readonly filterHash: string;
  readonly asOf: string;
  readonly severityRank: number;
  readonly createdAt: string;
  readonly id: string;
}

const exceptionListCursorSchema = z
  .object({
    version: z.literal(2),
    filterHash: z.string().regex(/^[a-f0-9]{64}$/u),
    asOf: z.iso.datetime({ offset: true }),
    severityRank: z.number().int().min(0).max(2),
    createdAt: z.iso.datetime({ offset: true }),
    id: z.uuid(),
  })
  .strict();

export function encodeExceptionListCursor(
  item: ExceptionListItem,
  options: ExceptionListOptions,
  asOf: string,
): string {
  const cursor: ExceptionListCursor = {
    version: 2,
    filterHash: exceptionListFilterHash(options),
    asOf: z.iso.datetime({ offset: true }).parse(asOf),
    severityRank: exceptionSeverityRank(item.severity),
    createdAt: item.createdAt,
    id: item.id,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeExceptionListCursor(
  encoded: string,
  options: ExceptionListOptions,
): ExceptionListCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded)) throw new RepositoryCursorError();
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded || bytes.byteLength > 768) {
      throw new RepositoryCursorError();
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (Buffer.byteLength(decoded, "utf8") > 768) throw new RepositoryCursorError();
    const cursor = exceptionListCursorSchema.parse(JSON.parse(decoded) as unknown);
    if (cursor.filterHash !== exceptionListFilterHash(options)) {
      throw new RepositoryCursorError();
    }
    return cursor;
  } catch (error) {
    if (error instanceof RepositoryCursorError) throw error;
    throw new RepositoryCursorError();
  }
}

function exceptionListFilterHash(options: ExceptionListOptions): string {
  const filters = normalizeExceptionFilters(options);
  return createHash("sha256")
    .update(
      JSON.stringify({
        status: filters.status,
        severity: filters.severity,
        search:
          filters.searchId !== null
            ? `id:${filters.searchId}`
            : filters.searchType !== null
              ? `type:${filters.searchType}`
              : null,
        source: filters.source,
        amountCurrency: filters.amountCurrency,
        minimumAmountMinor: filters.minimumAmountMinor,
        maximumAmountMinor: filters.maximumAmountMinor,
        confidence: filters.confidence,
        assignee: filters.assignee,
        age: filters.age,
      }),
    )
    .digest("hex");
}

interface NormalizedExceptionFilters {
  readonly status: string | null;
  readonly severity: string | null;
  readonly searchId: string | null;
  readonly searchType: string | null;
  readonly source: ExceptionSourceFilter | null;
  readonly amountCurrency: string | null;
  readonly minimumAmountMinor: string | null;
  readonly maximumAmountMinor: string | null;
  readonly confidence: ResolutionConfidence | null;
  readonly assignee: ExceptionAssigneeFilter | null;
  readonly age: ExceptionAgeFilter | null;
}

const exceptionAmountMinorSchema = z.string().regex(/^-?(0|[1-9][0-9]{0,30})$/u);
const exceptionAmountCurrencySchema = z.string().regex(/^[A-Z]{3}$/u);
const exceptionSourcesSchema = z.array(z.enum(["shopify", "stripe", "accounting_csv"])).max(3);
const exceptionConfidenceSchema = z.enum(["high", "low", "unclassified"]);
const exceptionAssigneeSchema = z.enum(["me", "assigned", "unassigned"]);

function normalizeExceptionFilters(input: ExceptionExportFilters): NormalizedExceptionFilters {
  const search = normalizeExceptionSearch(input.search);
  const minimumAmountMinor = input.minimumAmountMinor
    ? BigInt(exceptionAmountMinorSchema.parse(input.minimumAmountMinor)).toString()
    : null;
  const maximumAmountMinor = input.maximumAmountMinor
    ? BigInt(exceptionAmountMinorSchema.parse(input.maximumAmountMinor)).toString()
    : null;
  const amountCurrency = input.amountCurrency
    ? exceptionAmountCurrencySchema.parse(input.amountCurrency.toUpperCase())
    : null;
  if ((minimumAmountMinor !== null || maximumAmountMinor !== null) && !amountCurrency) {
    throw new TypeError("amount currency is required when an amount bound is present");
  }
  if (
    minimumAmountMinor !== null &&
    maximumAmountMinor !== null &&
    BigInt(minimumAmountMinor) > BigInt(maximumAmountMinor)
  ) {
    throw new TypeError("minimum amount cannot exceed maximum amount");
  }
  return {
    status: input.status ?? null,
    severity: input.severity ?? null,
    searchId: search?.kind === "id" ? search.value : null,
    searchType: search?.kind === "type" ? search.value : null,
    source: input.source ?? null,
    amountCurrency,
    minimumAmountMinor,
    maximumAmountMinor,
    confidence: input.confidence ?? null,
    assignee: input.assignee ?? null,
    age: input.age ?? null,
  };
}

function normalizeExceptionSearch(
  input: string | undefined,
): { readonly kind: "id" | "type"; readonly value: string } | undefined {
  const value = input?.trim().toLocaleLowerCase("en-US");
  if (!value) return undefined;
  const id = z.uuid().safeParse(value);
  if (id.success) return { kind: "id", value: id.data };
  return { kind: "type", value: value.replaceAll(/[\s-]+/gu, "_") };
}

/**
 * Classifies deterministic rule evidence for review routing. It intentionally emits no numeric
 * score: ambiguity and deferral are low-confidence findings, explicit failures are high-confidence
 * findings, and legacy or malformed evidence remains unclassified.
 */
export function exceptionConfidenceFromEvidence(evidence: unknown): ResolutionConfidence {
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
    return "unclassified";
  }
  const result = (evidence as Record<string, unknown>)["result"];
  if (result === "fail") return "high";
  if (result === "ambiguous" || result === "defer") return "low";
  return "unclassified";
}

function exceptionSeverityRank(severity: string): number {
  if (severity === "high") return 0;
  if (severity === "medium") return 1;
  return 2;
}

function mapExceptionListItem(row: Record<string, unknown>): ExceptionListItem {
  return {
    id: databaseScalar(row["id"], "exception.id"),
    type: databaseScalar(row["type"], "exception.type"),
    status: databaseScalar(row["status"], "exception.status"),
    severity: databaseScalar(row["severity"], "exception.severity"),
    sources: exceptionSourcesSchema.parse(row["sources"]),
    confidence: exceptionConfidenceSchema.parse(row["confidence"]),
    assignee: exceptionAssigneeSchema.parse(row["assignee"]),
    ...(row["amount_minor"] === null || row["amount_minor"] === undefined
      ? {}
      : { amountMinor: databaseScalar(row["amount_minor"], "exception.amount_minor") }),
    ...(row["currency"] ? { currency: databaseScalar(row["currency"], "exception.currency") } : {}),
    createdAt: databaseTimestamp(row["created_at"], "exception.created_at"),
    updatedAt: databaseTimestamp(row["updated_at"], "exception.updated_at"),
  };
}

export function serializeExceptionExport(items: readonly ExceptionListItem[]): string {
  const rows = [
    [
      "exception_id",
      "type",
      "status",
      "severity",
      "sources",
      "confidence",
      "assignee",
      "amount_minor",
      "currency",
      "created_at",
      "updated_at",
    ],
    ...items.map((item) => [
      item.id,
      item.type,
      item.status,
      item.severity,
      item.sources.join("|"),
      item.confidence,
      item.assignee,
      item.amountMinor ?? "",
      item.currency ?? "",
      item.createdAt,
      item.updatedAt,
    ]),
  ];
  const csv = `\uFEFF${rows.map((row) => row.map(serializeCsvCell).join(",")).join("\r\n")}\r\n`;
  if (Buffer.byteLength(csv, "utf8") > MAX_EXCEPTION_EXPORT_BYTES) {
    throw new RepositoryExportLimitError();
  }
  return csv;
}

function serializeCsvCell(value: string): string {
  const safe = protectCsvFormula(value);
  return `"${safe.replaceAll('"', '""')}"`;
}

function mapReconciliationRunListItem(row: Record<string, unknown>): ReconciliationRunListItem {
  return {
    id: databaseScalar(row["id"], "reconciliation_run.id"),
    stableRunKey: databaseScalar(row["stable_run_key"], "reconciliation_run.stable_run_key"),
    status: runStatusSchema.parse(row["status"]),
    policyVersion: databaseScalar(row["policy_version"], "reconciliation_run.policy_version"),
    ruleSetVersion: databaseScalar(row["rule_set_version"], "reconciliation_run.rule_set_version"),
    engineVersion: databaseScalar(row["engine_version"], "reconciliation_run.engine_version"),
    inputCount: databaseInteger(row["input_count"], "reconciliation_run.input_count"),
    matchCount: databaseInteger(row["match_count"], "reconciliation_run.match_count"),
    exceptionCount: databaseInteger(row["exception_count"], "reconciliation_run.exception_count"),
    errorCount: databaseInteger(row["error_count"], "reconciliation_run.error_count"),
    dispatchCount: databaseInteger(row["dispatch_count"], "reconciliation_run.dispatch_count"),
    operationalStateApplied: databaseBoolean(
      row["operational_state_applied"],
      "reconciliation_run.operational_state_applied",
    ),
    ...(row["last_error_code"]
      ? {
          lastErrorCode: databaseScalar(
            row["last_error_code"],
            "reconciliation_run.last_error_code",
          ),
        }
      : {}),
    ...(row["started_at"]
      ? {
          startedAt: databaseTimestamp(row["started_at"], "reconciliation_run.started_at"),
        }
      : {}),
    ...(row["completed_at"]
      ? {
          completedAt: databaseTimestamp(row["completed_at"], "reconciliation_run.completed_at"),
        }
      : {}),
    createdAt: databaseTimestamp(row["created_at"], "reconciliation_run.created_at"),
  };
}

function mapRunInputReference(row: Record<string, unknown>): ReconciliationRunInputReference {
  return {
    id: databaseScalar(row["record_id"], "record_id"),
    version: databaseInteger(row["record_version"], "record_version"),
    contentSha256: databaseScalar(row["content_sha256"], "content_sha256"),
    ordinal: databaseInteger(row["ordinal"], "ordinal"),
  };
}

export function toDeterministicEvidenceView(value: unknown): DeterministicEvidenceView {
  const parsed = RuleEvidenceSchema.safeParse(value);
  if (!parsed.success) {
    return {
      schemaVersion: "deterministic-evidence-view-v1",
      status: "unavailable",
      reasonCode: "EVIDENCE_UNSUPPORTED_OR_MALFORMED",
    };
  }
  const evidence = parsed.data;
  return {
    schemaVersion: "deterministic-evidence-view-v1",
    status: "available",
    ruleId: evidence.ruleId,
    ruleVersion: evidence.ruleVersion,
    ruleSetVersion: evidence.ruleSetVersion,
    sourceRecordCount: evidence.sourceRecordCount,
    evidenceTruncated: evidence.evidenceTruncated,
    comparisons: evidence.sourceValues.map((source, index) => ({
      source,
      normalized: evidence.normalizedValues[index] ?? {},
    })),
    ...(evidence.toleranceMinor === undefined ? {} : { toleranceMinor: evidence.toleranceMinor }),
    ...(evidence.candidateSearch === undefined
      ? {}
      : { candidateSearch: evidence.candidateSearch }),
    ...(evidence.accountingCandidateSearch === undefined
      ? {}
      : { accountingCandidateSearch: evidence.accountingCandidateSearch }),
    result: evidence.result,
    reasonCode: evidence.reasonCode,
    evaluatedAt: evidence.evaluatedAt,
  };
}

export function toBrowserRecordReferences(value: unknown): {
  readonly values: readonly string[];
  readonly status: "available" | "unavailable";
} {
  const parsed = browserRecordReferencesSchema.safeParse(value);
  return parsed.success
    ? { values: parsed.data, status: "available" }
    : { values: [], status: "unavailable" };
}

function toVerifiedExceptionRecordReferences(
  value: unknown,
  sourceRecords: readonly SourceRecordEvidence[],
): {
  readonly values: readonly string[];
  readonly status: "available" | "unavailable";
} {
  const parsed = toBrowserRecordReferences(value);
  if (parsed.status === "unavailable") return parsed;
  const uniqueReferences = new Set(parsed.values);
  const sourceRecordIds = new Set(sourceRecords.map(({ id }) => id));
  if (
    uniqueReferences.size !== parsed.values.length ||
    sourceRecordIds.size !== sourceRecords.length ||
    uniqueReferences.size !== sourceRecordIds.size ||
    parsed.values.some((id) => !sourceRecordIds.has(id))
  ) {
    return { values: [], status: "unavailable" };
  }
  return parsed;
}

function mapRunMatchArtifact(row: Record<string, unknown>): ReconciliationRunMatchArtifact {
  const recordReferences = toBrowserRecordReferences(row["record_references"]);
  return {
    id: databaseScalar(row["id"], "reconciliation_run.match.id"),
    ruleId: databaseScalar(row["rule_id"], "reconciliation_run.match.rule_id"),
    ruleVersion: databaseScalar(row["rule_version"], "reconciliation_run.match.rule_version"),
    recordReferences: recordReferences.values,
    recordReferencesStatus: recordReferences.status,
    evidence: toDeterministicEvidenceView(row["evidence"]),
    evidenceFidelity: artifactEvidenceFidelitySchema.parse(row["evidence_fidelity"]),
    observedAt: databaseTimestamp(row["observed_at"], "reconciliation_run.match.observed_at"),
  };
}

function mapRunExceptionArtifact(row: Record<string, unknown>): ReconciliationRunExceptionArtifact {
  const recordReferences = toBrowserRecordReferences(row["record_references"]);
  return {
    id: databaseScalar(row["id"], "reconciliation_run.exception.id"),
    type: databaseScalar(row["type"], "reconciliation_run.exception.type"),
    observedStatus: databaseScalar(
      row["observed_status"],
      "reconciliation_run.exception.observed_status",
    ),
    currentStatus: databaseScalar(
      row["current_status"],
      "reconciliation_run.exception.current_status",
    ),
    severity: databaseScalar(row["severity"], "reconciliation_run.exception.severity"),
    recordReferences: recordReferences.values,
    recordReferencesStatus: recordReferences.status,
    ...(row["amount_minor"] === null || row["amount_minor"] === undefined
      ? {}
      : {
          amountMinor: databaseScalar(
            row["amount_minor"],
            "reconciliation_run.exception.amount_minor",
          ),
        }),
    ...(row["currency"]
      ? {
          currency: databaseScalar(row["currency"], "reconciliation_run.exception.currency"),
        }
      : {}),
    evidence: toDeterministicEvidenceView(row["evidence"]),
    evidenceFidelity: artifactEvidenceFidelitySchema.parse(row["evidence_fidelity"]),
    observedAt: databaseTimestamp(row["observed_at"], "reconciliation_run.exception.observed_at"),
  };
}

function mapExceptionWorkflow(row: Record<string, unknown>): ExceptionWorkflowResult {
  return {
    id: databaseScalar(row["id"], "exception.id"),
    status: editableExceptionStatusSchema.parse(row["status"]),
    ...(row["assignee_membership_id"]
      ? {
          assigneeMembershipId: databaseScalar(
            row["assignee_membership_id"],
            "exception.assignee_membership_id",
          ),
        }
      : {}),
    ...(row["deferred_until"]
      ? {
          deferredUntil: databaseTimestamp(row["deferred_until"], "exception.deferred_until"),
        }
      : {}),
  };
}

function mapExceptionNote(row: Record<string, unknown>): ExceptionNote {
  return {
    id: databaseScalar(row["id"], "exception_note.id"),
    authorMembershipId: databaseScalar(
      row["author_membership_id"],
      "exception_note.author_membership_id",
    ),
    ...(row["author_email"]
      ? { authorEmail: databaseScalar(row["author_email"], "exception_note.author_email") }
      : {}),
    body: databaseScalar(row["body"], "exception_note.body"),
    createdAt: databaseTimestamp(row["created_at"], "exception_note.created_at"),
  };
}

function mapExceptionTimelineEvent(row: Record<string, unknown>): ExceptionTimelineEvent {
  return {
    id: databaseScalar(row["id"], "exception_timeline.id"),
    action: databaseScalar(row["action"], "exception_timeline.action"),
    resourceType: databaseScalar(row["resource_type"], "exception_timeline.resource_type"),
    resourceId: databaseScalar(row["resource_id"], "exception_timeline.resource_id"),
    actorType: auditActorTypeSchema.parse(row["actor_type"]),
    ...(row["actor_id"]
      ? { actorId: databaseScalar(row["actor_id"], "exception_timeline.actor_id") }
      : {}),
    ...(row["reason"]
      ? { reason: databaseScalar(row["reason"], "exception_timeline.reason") }
      : {}),
    occurredAt: databaseTimestamp(row["occurred_at"], "exception_timeline.occurred_at"),
  };
}

function mapOrganizationMember(row: Record<string, unknown>): OrganizationMember {
  return {
    id: databaseScalar(row["id"], "membership.id"),
    userId: databaseScalar(row["user_id"], "membership.user_id"),
    ...(row["email"] ? { email: databaseScalar(row["email"], "membership.email") } : {}),
    role: RoleSchema.parse(row["role"]),
    status: membershipStatusSchema.parse(row["status"]),
    createdAt: databaseTimestamp(row["created_at"], "membership.created_at"),
    updatedAt: databaseTimestamp(row["updated_at"], "membership.updated_at"),
  };
}

function mapOrganizationInvitation(row: Record<string, unknown>): OrganizationInvitation {
  return {
    id: databaseScalar(row["id"], "invitation.id"),
    email: InvitationEmailSchema.parse(row["email"]),
    role: RoleSchema.parse(row["role"]),
    status: invitationStatusSchema.parse(row["status"]),
    invitedByMembershipId: databaseScalar(
      row["invited_by_membership_id"],
      "invitation.invited_by_membership_id",
    ),
    ...(row["accepted_by_user_id"]
      ? {
          acceptedByUserId: databaseScalar(
            row["accepted_by_user_id"],
            "invitation.accepted_by_user_id",
          ),
        }
      : {}),
    ...(row["accepted_membership_id"]
      ? {
          acceptedMembershipId: databaseScalar(
            row["accepted_membership_id"],
            "invitation.accepted_membership_id",
          ),
        }
      : {}),
    expiresAt: databaseTimestamp(row["expires_at"], "invitation.expires_at"),
    ...(row["accepted_at"]
      ? { acceptedAt: databaseTimestamp(row["accepted_at"], "invitation.accepted_at") }
      : {}),
    ...(row["revoked_at"]
      ? { revokedAt: databaseTimestamp(row["revoked_at"], "invitation.revoked_at") }
      : {}),
    createdAt: databaseTimestamp(row["created_at"], "invitation.created_at"),
    updatedAt: databaseTimestamp(row["updated_at"], "invitation.updated_at"),
  };
}

function mapConnectionHealth(
  row: Record<string, unknown>,
): Omit<ConnectionHealthItem, "objectWatermarks"> {
  return {
    id: databaseScalar(row["id"], "connection.id"),
    provider: connectionProviderSchema.parse(row["provider"]),
    externalAccountId: databaseScalar(row["external_account_id"], "connection.external_account_id"),
    status: connectionHealthStatusSchema.parse(row["status"]),
    connectorVersion: databaseScalar(row["connector_version"], "connection.connector_version"),
    syncEnabled: row["sync_enabled"] === true,
    ...(row["api_version"]
      ? { apiVersion: databaseScalar(row["api_version"], "connection.api_version") }
      : {}),
    ...(row["last_successful_sync_at"]
      ? {
          lastSuccessfulSyncAt: databaseTimestamp(
            row["last_successful_sync_at"],
            "connection.last_successful_sync_at",
          ),
        }
      : {}),
    ...(row["last_verified_webhook_at"]
      ? {
          lastVerifiedWebhookAt: databaseTimestamp(
            row["last_verified_webhook_at"],
            "connection.last_verified_webhook_at",
          ),
        }
      : {}),
    retryCount: databaseInteger(row["retry_count"], "connection.retry_count"),
    deadLetterCount: databaseInteger(row["dead_letter_count"], "connection.dead_letter_count"),
    ...(row["error_code"]
      ? { errorCode: databaseScalar(row["error_code"], "connection.error_code") }
      : {}),
    updatedAt: databaseTimestamp(row["updated_at"], "connection.updated_at"),
  };
}

/** @internal Maps only fixed-family tenant query results into the public connection-health shape. */
export function mapConnectionHealthRows(
  connectionRows: readonly Record<string, unknown>[],
  watermarkRows: readonly Record<string, unknown>[],
  unclassifiedRows: readonly Record<string, unknown>[],
): readonly ConnectionHealthItem[] {
  const connections = connectionRows.map((row) => mapConnectionHealth(row));
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  const observedByConnection = new Map<
    string,
    Map<ConnectionObjectType, ConnectionObjectWatermark>
  >();
  const classificationUnavailable = new Set<string>();

  for (const row of unclassifiedRows) {
    const connectionId = z
      .uuid()
      .parse(databaseScalar(row["connection_id"], "connection_classification.connection_id"));
    if (!connectionById.has(connectionId)) {
      throw new Error(
        "connection classification gap references a connection outside the authorized result",
      );
    }
    if (
      databaseInteger(row["unclassified_count"], "connection_classification.unclassified_count") < 1
    ) {
      throw new Error("connection classification gap count must be positive");
    }
    if (classificationUnavailable.has(connectionId)) {
      throw new Error("connection classification gap result contains a duplicate connection");
    }
    classificationUnavailable.add(connectionId);
  }

  for (const row of watermarkRows) {
    const connectionId = z
      .uuid()
      .parse(databaseScalar(row["connection_id"], "connection_watermark.connection_id"));
    const connection = connectionById.get(connectionId);
    if (!connection) {
      throw new Error("connection watermark references a connection outside the authorized result");
    }
    const objectType = connectionObjectTypeSchema.parse(row["external_object_type"]);
    if (
      !(expectedObjectTypesByProvider[connection.provider] as readonly string[]).includes(
        objectType,
      )
    ) {
      throw new Error("connection watermark object type does not match its provider");
    }
    const watermarks =
      observedByConnection.get(connectionId) ??
      new Map<ConnectionObjectType, ConnectionObjectWatermark>();
    if (watermarks.has(objectType)) {
      throw new Error("connection watermark result contains a duplicate object type");
    }
    watermarks.set(objectType, {
      objectType,
      observationState: "observed",
      latestSourceAt: databaseTimestamp(
        row["latest_source_at"],
        "connection_watermark.latest_source_at",
      ),
      latestReceivedAt: databaseTimestamp(
        row["latest_received_at"],
        "connection_watermark.latest_received_at",
      ),
    });
    observedByConnection.set(connectionId, watermarks);
  }

  return connections.map((connection) => {
    const observed = observedByConnection.get(connection.id);
    return {
      ...connection,
      objectWatermarks: expectedObjectTypesByProvider[connection.provider].map(
        (objectType): ConnectionObjectWatermark =>
          classificationUnavailable.has(connection.id)
            ? { objectType, observationState: "classification_unavailable" }
            : (observed?.get(objectType) ?? {
                objectType,
                observationState: "never_observed",
              }),
      ),
    };
  });
}

function mapAuditEvent(row: Record<string, unknown>): AuditEventListItem {
  return {
    id: databaseScalar(row["id"], "audit_event.id"),
    actorType: auditActorTypeSchema.parse(row["actor_type"]),
    actorId: databaseScalar(row["actor_id"], "audit_event.actor_id"),
    action: databaseScalar(row["action"], "audit_event.action"),
    resourceType: databaseScalar(row["resource_type"], "audit_event.resource_type"),
    resourceId: databaseScalar(row["resource_id"], "audit_event.resource_id"),
    occurredAt: databaseTimestamp(row["occurred_at"], "audit_event.occurred_at"),
    correlationId: databaseScalar(row["correlation_id"], "audit_event.correlation_id"),
    ...(row["reason"] ? { reason: databaseScalar(row["reason"], "audit_event.reason") } : {}),
    ...(row["previous_value"] === null || row["previous_value"] === undefined
      ? {}
      : { previousValue: row["previous_value"] }),
    ...(row["new_value"] === null || row["new_value"] === undefined
      ? {}
      : { newValue: row["new_value"] }),
    versionContext: row["version_context"],
  };
}

function parseCanonicalRecord(value: unknown): CanonicalRecord {
  // Runtime validation is authoritative; this assertion bridges Zod's optional-property output
  // representation with exactOptionalPropertyTypes in the hand-authored domain union.
  return CanonicalRecordSchema.parse(value) as CanonicalRecord;
}

async function loadSourceRecordEvidence(
  transaction: TransactionSql,
  organizationId: string,
  evidenceValue: unknown,
): Promise<readonly SourceRecordEvidence[]> {
  const parsed = RuleEvidenceSchema.safeParse(evidenceValue);
  if (!parsed.success || parsed.data.sourceRecordVersions.length === 0) return [];
  const requested = parsed.data.sourceRecordVersions.map((reference) => ({
    id: reference.id,
    version: reference.version,
  }));
  const records = await transaction`
    select
      canonical_records.id,
      canonical_records.version,
      canonical_records.kind,
      canonical_records.source,
      canonical_records.source_timestamp,
      canonical_records.normalized_data,
      canonical_records.content_sha256
    from canonical_records
    join jsonb_to_recordset(${transaction.json(requested)}::jsonb)
      as requested(id uuid, version integer)
      on requested.id = canonical_records.id
      and requested.version = canonical_records.version
    where canonical_records.organization_id = ${organizationId}
    order by canonical_records.id, canonical_records.version
  `;
  const provenance = await transaction`
    select
      canonical_field_provenance.record_id,
      canonical_field_provenance.record_version,
      canonical_field_provenance.field_path,
      canonical_field_provenance.normalized_value,
      canonical_field_provenance.transformation_rule,
      canonical_field_provenance.transformation_version,
      canonical_field_provenance.warnings
    from canonical_field_provenance
    join jsonb_to_recordset(${transaction.json(requested)}::jsonb)
      as requested(id uuid, version integer)
      on requested.id = canonical_field_provenance.record_id
      and requested.version = canonical_field_provenance.record_version
    where canonical_field_provenance.organization_id = ${organizationId}
    order by
      canonical_field_provenance.record_id,
      canonical_field_provenance.record_version,
      canonical_field_provenance.field_path
  `;
  const expectedHashes = new Map(
    parsed.data.sourceRecordVersions.map((reference) => [
      `${reference.id}:${reference.version.toString()}`,
      reference.contentSha256,
    ]),
  );
  const provenanceByRecord = new Map<string, SourceRecordEvidence["fieldProvenance"][number][]>();
  const unavailableProvenanceRecords = new Set<string>();
  for (const value of provenance) {
    const row = toDatabaseRow(value);
    const key = `${databaseScalar(row["record_id"], "provenance.record_id")}:${Number(
      row["record_version"],
    ).toString()}`;
    const parsedProvenance = sourceFieldProvenanceSchema.safeParse({
      fieldPath: row["field_path"],
      normalizedValue: row["normalized_value"],
      transformationRule: row["transformation_rule"],
      transformationVersion: row["transformation_version"],
      warnings: row["warnings"],
    });
    if (!parsedProvenance.success) {
      unavailableProvenanceRecords.add(key);
      continue;
    }
    const entries = provenanceByRecord.get(key) ?? [];
    entries.push(parsedProvenance.data);
    provenanceByRecord.set(key, entries);
  }
  return records.map((value): SourceRecordEvidence => {
    const row = toDatabaseRow(value);
    const id = databaseScalar(row["id"], "canonical_record.id");
    const version = Number(row["version"]);
    const key = `${id}:${version.toString()}`;
    const contentSha256 = databaseScalar(
      row["content_sha256"],
      "canonical_record.content_sha256",
    ).trim();
    if (expectedHashes.get(key) !== contentSha256) {
      throw new Error("canonical record content hash does not match reconciliation evidence");
    }
    const sourceTimestamp = databaseTimestamp(
      row["source_timestamp"],
      "canonical_record.source_timestamp",
    );
    const normalizedRecord = parseCanonicalRecord(row["normalized_data"]);
    if (
      normalizedRecord.id !== id ||
      normalizedRecord.version !== version ||
      normalizedRecord.organizationId !== organizationId ||
      normalizedRecord.kind !== row["kind"] ||
      normalizedRecord.provenance.sourceSystem !== row["source"] ||
      normalizedRecord.provenance.sourceTimestamp !== sourceTimestamp
    ) {
      throw new Error("canonical record metadata does not match normalized evidence");
    }
    const fieldProvenance = provenanceByRecord.get(key) ?? [];
    const fieldProvenanceAvailable =
      fieldProvenance.length > 0 && !unavailableProvenanceRecords.has(key);
    return {
      id,
      version,
      kind: normalizedRecord.kind,
      source: normalizedRecord.provenance.sourceSystem,
      sourceTimestamp,
      normalizedData: toSourceRecordNormalizedData(normalizedRecord),
      contentSha256,
      fieldProvenanceStatus: fieldProvenanceAvailable ? "available" : "unavailable",
      fieldProvenance: fieldProvenanceAvailable ? fieldProvenance : [],
    };
  });
}

function toSourceRecordNormalizedData(record: CanonicalRecord): SourceRecordNormalizedData {
  const common = {
    kind: record.kind,
    ...(record.externalId === undefined ? {} : { externalId: record.externalId }),
    ...(record.orderReference === undefined ? {} : { orderReference: record.orderReference }),
    ...(record.customerReference === undefined
      ? {}
      : { customerReference: record.customerReference }),
    effectiveAt: record.effectiveAt,
    amountMinor: record.amount.minor.toString(),
    currency: record.amount.currency,
    ...(record.incompleteReasons === undefined
      ? {}
      : { incompleteReasons: record.incompleteReasons }),
  };
  switch (record.kind) {
    case "order":
      return { ...common, financialStatus: record.financialStatus };
    case "payment":
      return {
        ...common,
        paymentStatus: record.paymentStatus,
        ...(record.providerOrderReference === undefined
          ? {}
          : { providerOrderReference: record.providerOrderReference }),
      };
    case "refund":
      return {
        ...common,
        refundStatus: record.refundStatus,
        ...(record.paymentReference === undefined
          ? {}
          : { paymentReference: record.paymentReference }),
        ...(record.refundReference === undefined
          ? {}
          : { refundReference: record.refundReference }),
      };
    case "processing_fee":
      return { ...common, paymentReference: record.paymentReference };
    case "accounting_entry":
      return {
        ...common,
        entryType: record.entryType,
        ...(record.transactionReference === undefined
          ? {}
          : { transactionReference: record.transactionReference }),
      };
  }
}

async function loadExceptionNotes(
  transaction: TransactionSql,
  organizationId: string,
  exceptionId: string,
): Promise<readonly ExceptionNote[]> {
  const rows = await transaction`
    select
      exception_notes.id,
      exception_notes.author_membership_id,
      users.email as author_email,
      exception_notes.body,
      exception_notes.created_at
    from exception_notes
    join memberships
      on memberships.organization_id = exception_notes.organization_id
      and memberships.id = exception_notes.author_membership_id
    join users on users.id = memberships.user_id
    where exception_notes.organization_id = ${organizationId}
      and exception_notes.exception_id = ${exceptionId}::uuid
    order by exception_notes.created_at, exception_notes.id
    limit 500
  `;
  return rows.map((row) => mapExceptionNote(toDatabaseRow(row)));
}

async function loadExceptionTimeline(
  transaction: TransactionSql,
  organizationId: string,
  exceptionId: string,
): Promise<{
  readonly events: readonly ExceptionTimelineEvent[];
  readonly truncated: boolean;
}> {
  const rows = await transaction`
    select *
    from (
      select *
      from (
        select
          audit_events.id::text as id,
          audit_events.action,
          audit_events.resource_type,
          audit_events.resource_id,
          audit_events.actor_type,
          audit_events.actor_id,
          audit_events.reason,
          audit_events.occurred_at
        from audit_events
        where audit_events.organization_id = ${organizationId}
          and (
            (
              audit_events.resource_type = 'exception'
              and audit_events.resource_id = ${exceptionId}
            )
            or (
              audit_events.resource_type = 'resolution_proposal'
              and audit_events.resource_id in (
                select resolution_proposals.id::text
                from resolution_proposals
                where resolution_proposals.organization_id = ${organizationId}
                  and resolution_proposals.exception_id = ${exceptionId}::uuid
              )
            )
            or (
              audit_events.resource_type = 'exception_note'
              and audit_events.new_value ->> 'exceptionId' = ${exceptionId}
            )
          )
        union all
        select
          'occurrence:' || exception_occurrences.run_id::text as id,
          'reconciliation.observed' as action,
          'reconciliation_run' as resource_type,
          exception_occurrences.run_id::text as resource_id,
          'system' as actor_type,
          null::text as actor_id,
          null::text as reason,
          exception_occurrences.observed_at as occurred_at
        from exception_occurrences
        where exception_occurrences.organization_id = ${organizationId}
          and exception_occurrences.exception_id = ${exceptionId}::uuid
        union all
        select
          'status:' || exception_status_events.run_id::text as id,
          'exception.status.' || exception_status_events.next_status::text as action,
          'exception' as resource_type,
          exception_status_events.exception_id::text as resource_id,
          'worker' as actor_type,
          'reconciliation-worker' as actor_id,
          replace(exception_status_events.reason_code, '_', ' ') as reason,
          exception_status_events.occurred_at
        from exception_status_events
        where exception_status_events.organization_id = ${organizationId}
          and exception_status_events.exception_id = ${exceptionId}::uuid
      ) as all_events
      order by occurred_at desc, id desc
      limit 501
    ) as recent_events
    order by occurred_at, id
  `;
  const events = rows.map((row) => mapExceptionTimelineEvent(toDatabaseRow(row)));
  return {
    events: events.length > 500 ? events.slice(1) : events,
    truncated: events.length > 500,
  };
}

function createReconciliationEnvelope(input: {
  readonly organizationId: TenantContext["organizationId"];
  readonly runId: string;
  readonly executionAttempt: number;
  readonly correlationId: string;
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly traceparent?: string;
}): ReconciliationRunJobEnvelope {
  return ReconciliationRunJobEnvelopeSchema.parse({
    schemaVersion: 1,
    type: "reconciliation.run.requested",
    organizationId: input.organizationId,
    runId: input.runId,
    executionAttempt: input.executionAttempt,
    correlationId: input.correlationId,
    requestedBy: input.requestedBy,
    createdAt: input.createdAt,
    ...(input.traceparent
      ? {
          traceContext: {
            schemaVersion: 1,
            traceparent: input.traceparent,
          },
        }
      : {}),
    idempotencyKey: `reconciliation-run:${input.runId}:dispatch:${input.executionAttempt.toString()}`,
  });
}

async function insertReconciliationOutbox(
  transaction: TransactionSql,
  envelope: ReconciliationRunJobEnvelope,
): Promise<void> {
  await transaction`
    insert into outbox_events (
      id, organization_id, event_type, schema_version, idempotency_key,
      payload, correlation_id, execution_tracking_version
    ) values (
      ${randomUUID()}, ${envelope.organizationId}, ${envelope.type}, ${envelope.schemaVersion},
      ${envelope.idempotencyKey}, ${transaction.json(toJsonValue(envelope))},
      ${envelope.correlationId}, 1
    )
  `;
}

function toDatabaseRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("database returned an invalid row");
  }
  return value as Record<string, unknown>;
}

interface CancellableDatabaseQuery<TResult> extends Promise<TResult> {
  cancel(): void;
}

/**
 * Admits one database operation and releases its slot only after that operation settles. This
 * deliberately retains the slot when the caller has already received an interruption response.
 */
export function admittedReconciliationRunCreationOperation<TResult>(
  admission: ReconciliationRunAdmission,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  const release = admission.acquire();
  if (!release) {
    return Promise.reject(new RepositoryRunCreationUnavailableError("admission_saturated"));
  }
  try {
    return operation().finally(release);
  } catch (error) {
    release();
    return Promise.reject(
      error instanceof Error
        ? error
        : new Error("reconciliation run operation construction failed", { cause: error }),
    );
  }
}

/**
 * Returns a retry-safe interruption as soon as the run signal aborts while continuing to observe
 * the non-cancellable pool/transaction promise. The transaction receives the same signal and must
 * still enforce the zero-or-complete authority contract after this caller settles.
 */
export function settleReconciliationRunCreation<TResult>(
  operation: Promise<TResult>,
  signal: AbortSignal,
): Promise<TResult> {
  return new Promise<TResult>((resolve, reject) => {
    const interrupt = (): void => {
      reject(new RepositoryRunCreationUnavailableError());
    };
    signal.addEventListener("abort", interrupt, { once: true });
    if (signal.aborted) interrupt();
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", interrupt);
    });
  });
}

async function runCreationQuery<TResult>(
  query: CancellableDatabaseQuery<TResult>,
  signal?: AbortSignal,
): Promise<TResult> {
  if (signal?.aborted) {
    query.cancel();
    void query.catch(() => undefined);
    throw new RepositoryRunCreationUnavailableError();
  }
  const cancel = (): void => query.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await query;
  } catch (error) {
    if (signal?.aborted || isRunCreationInterruption(error)) {
      throw new RepositoryRunCreationUnavailableError();
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

function assertRunCreationActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RepositoryRunCreationUnavailableError();
}

function isRunCreationInterruption(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "25P04" || error.code === "57014";
}

function databaseScalar(value: unknown, field: string): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  throw new Error(`database returned a non-scalar ${field}`);
}

function databaseTimestamp(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(databaseScalar(value, field));
  if (Number.isNaN(date.getTime())) throw new Error(`database returned an invalid ${field}`);
  return date.toISOString();
}

function databaseInteger(value: unknown, field: string): number {
  const numeric = Number(databaseScalar(value, field));
  if (!Number.isSafeInteger(numeric)) throw new Error(`database returned an invalid ${field}`);
  return numeric;
}

function databaseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`database returned an invalid ${field}`);
  return value;
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      return item;
    }),
  ) as JSONValue;
}
