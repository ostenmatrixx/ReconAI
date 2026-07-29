import { z } from "zod";

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const cursor = z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const currency = z.string().regex(/^[A-Z]{3}$/u);
const minorUnits = z.string().regex(/^-?(0|[1-9][0-9]{0,30})$/u);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const jsonValue = z.json();
const boundedText = (maximum: number) => z.string().min(1).max(maximum);
const code = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/u);
const role = z.enum(["owner", "administrator", "analyst", "reviewer", "auditor"]);
const exceptionStatus = z.enum([
  "open",
  "assigned",
  "deferred",
  "proposed",
  "approved",
  "rejected",
  "superseded",
]);
const runStatus = z.enum(["queued", "running", "partial", "succeeded", "failed", "cancelled"]);
const evidenceFidelity = z.enum(["exact_at_observation", "legacy_current_projection"]);
const recordReferences = z.array(uuid).max(500);
const recordReferencesStatus = z.enum(["available", "unavailable"]);
const comparisonValue = z
  .record(z.string().min(1).max(100), z.string().max(4_096))
  .refine((value) => Object.keys(value).length <= 20);
const deterministicEvidence = z.discriminatedUnion("status", [
  z.object({
    schemaVersion: z.literal("deterministic-evidence-view-v1"),
    status: z.literal("available"),
    ruleId: code,
    ruleVersion: boundedText(100),
    ruleSetVersion: boundedText(100),
    sourceRecordCount: z.number().int().min(0).max(100_000),
    evidenceTruncated: z.boolean(),
    comparisons: z
      .array(
        z.object({
          source: comparisonValue,
          normalized: comparisonValue,
        }),
      )
      .max(500),
    toleranceMinor: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,18})$/u)
      .optional(),
    candidateSearch: z
      .object({
        eligibleCount: z.number().int().min(0).max(100_000),
        evaluatedCount: z.number().int().min(0).max(500),
        emittedCount: z.number().int().min(0).max(5),
        evaluationLimit: z.number().int().min(1).max(500),
        complete: z.boolean(),
      })
      .optional(),
    accountingCandidateSearch: z
      .object({
        eligibleCountLowerBound: z.number().int().min(0).max(100_000),
        evaluationLimit: z.number().int().min(1).max(500),
        complete: z.literal(false),
      })
      .optional(),
    result: z.enum(["pass", "fail", "defer", "ambiguous"]),
    reasonCode: code,
    evaluatedAt: instant,
  }),
  z.object({
    schemaVersion: z.literal("deterministic-evidence-view-v1"),
    status: z.literal("unavailable"),
    reasonCode: z.literal("EVIDENCE_UNSUPPORTED_OR_MALFORMED"),
  }),
]);

const exceptionListItem = z.object({
  id: uuid,
  type: code,
  status: exceptionStatus,
  severity: z.enum(["high", "medium", "low"]),
  sources: z.array(z.enum(["shopify", "stripe", "accounting_csv"])).max(3),
  confidence: z.enum(["high", "low", "unclassified"]),
  assignee: z.enum(["me", "assigned", "unassigned"]),
  amountMinor: minorUnits.optional(),
  currency: currency.optional(),
  createdAt: instant,
});
const queueResponse = z.object({
  data: z.array(exceptionListItem).max(50),
  meta: z.object({
    filteredCount: count,
    canExport: z.boolean(),
    summary: z.object({
      open: count,
      high: count,
      awaitingApproval: count,
      decided: count,
    }),
    nextCursor: cursor.optional(),
  }),
});

const normalizedRecordBase = z.object({
  externalId: boundedText(255).optional(),
  orderReference: boundedText(255).optional(),
  customerReference: boundedText(255).optional(),
  effectiveAt: instant,
  amountMinor: minorUnits,
  currency,
  incompleteReasons: z.array(boundedText(200)).max(20).optional(),
});
const normalizedRecordData = z.discriminatedUnion("kind", [
  normalizedRecordBase.extend({
    kind: z.literal("order"),
    financialStatus: z.enum(["paid", "partially_refunded", "refunded", "pending", "voided"]),
  }),
  normalizedRecordBase.extend({
    kind: z.literal("payment"),
    paymentStatus: z.enum(["succeeded", "pending", "failed", "reversed"]),
    providerOrderReference: boundedText(255).optional(),
  }),
  normalizedRecordBase.extend({
    kind: z.literal("refund"),
    refundStatus: z.enum(["succeeded", "pending", "failed", "reversed"]),
    paymentReference: boundedText(255).optional(),
    refundReference: boundedText(255).optional(),
  }),
  normalizedRecordBase.extend({
    kind: z.literal("processing_fee"),
    paymentReference: boundedText(255),
  }),
  normalizedRecordBase.extend({
    kind: z.literal("accounting_entry"),
    entryType: z.enum(["payment", "refund", "processing_fee", "other"]),
    transactionReference: boundedText(255).optional(),
  }),
]);
const sourceRecordEvidence = z
  .object({
    id: uuid,
    version: z.number().int().min(1),
    kind: z.enum(["order", "payment", "refund", "processing_fee", "accounting_entry"]),
    source: z.enum(["shopify", "stripe", "accounting_csv"]),
    sourceTimestamp: instant,
    normalizedData: normalizedRecordData,
    contentSha256: sha256,
    fieldProvenanceStatus: z.enum(["available", "unavailable"]),
    fieldProvenance: z
      .array(
        z.object({
          fieldPath: boundedText(500),
          normalizedValue: z.string().max(4_096),
          transformationRule: boundedText(200),
          transformationVersion: boundedText(100),
          warnings: z.array(boundedText(200)).max(20),
        }),
      )
      .max(1_000),
  })
  .superRefine((value, context) => {
    if (
      value.kind !== value.normalizedData.kind ||
      (value.fieldProvenanceStatus === "unavailable" && value.fieldProvenance.length !== 0)
    ) {
      context.addIssue({ code: "custom", message: "source evidence state is inconsistent" });
    }
  });
const exceptionDetailResponse = z.object({
  data: exceptionListItem.extend({
    updatedAt: instant,
    recordReferences,
    recordReferencesStatus,
    evidence: deterministicEvidence,
    sourceRecords: z.array(sourceRecordEvidence).max(100),
    assigneeMembershipId: uuid.optional(),
    deferredUntil: instant.optional(),
    notes: z
      .array(
        z.object({
          id: uuid,
          authorMembershipId: uuid,
          authorEmail: z.email().max(320).optional(),
          body: boundedText(4_000),
          createdAt: instant,
        }),
      )
      .max(100),
    timeline: z
      .array(
        z.object({
          id: uuid,
          action: code,
          resourceType: code,
          resourceId: boundedText(200),
          actorType: z.enum(["user", "worker", "system", "support"]),
          actorId: boundedText(200).optional(),
          reason: boundedText(2_000).optional(),
          occurredAt: instant,
        }),
      )
      .max(100),
    timelineTruncated: z.boolean(),
    latestProposal: z
      .object({
        id: uuid,
        version: z.number().int().min(1),
        type: code,
        reason: boundedText(2_000),
        status: z.enum(["pending", "approved", "rejected", "superseded"]),
        canRevise: z.boolean(),
        approvalCount: count,
        requiredApprovals: count,
        createdAt: instant,
      })
      .optional(),
  }),
});

const connectionObjectType = z.enum([
  "order",
  "refund_transaction",
  "payment_intent",
  "refund",
  "balance_transaction",
  "csv_row",
]);
const connectionWatermark = z.discriminatedUnion("observationState", [
  z.object({
    objectType: connectionObjectType,
    observationState: z.literal("never_observed"),
  }),
  z.object({
    objectType: connectionObjectType,
    observationState: z.literal("classification_unavailable"),
  }),
  z.object({
    objectType: connectionObjectType,
    observationState: z.literal("observed"),
    latestSourceAt: instant,
    latestReceivedAt: instant,
  }),
]);
const connectionsResponse = z.object({
  data: z
    .array(
      z.object({
        id: uuid,
        provider: z.enum(["shopify", "stripe", "accounting_csv"]),
        externalAccountId: boundedText(500),
        status: z.enum([
          "healthy",
          "backfilling",
          "degraded",
          "stale",
          "disconnected",
          "action_required",
        ]),
        connectorVersion: boundedText(100),
        syncEnabled: z.boolean(),
        apiVersion: boundedText(100).optional(),
        lastSuccessfulSyncAt: instant.optional(),
        lastVerifiedWebhookAt: instant.optional(),
        retryCount: count,
        deadLetterCount: count,
        errorCode: code.optional(),
        objectWatermarks: z.array(connectionWatermark).min(1).max(3),
        updatedAt: instant,
      }),
    )
    .max(100),
});
const connectorCredentialsResponse = z.object({
  data: z
    .array(
      z.object({
        id: uuid,
        connectionId: uuid,
        purpose: z.enum(["webhook_signing", "api_read"]),
        status: z.enum(["active", "superseded", "revoked"]),
        keyVersion: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/u),
        createdAt: instant,
      }),
    )
    .max(100),
});
const membersResponse = z.object({
  data: z
    .array(
      z.object({
        id: uuid,
        userId: uuid,
        email: z.email().max(320).optional(),
        role,
        status: z.enum(["invited", "active", "deactivated"]),
        createdAt: instant,
        updatedAt: instant,
      }),
    )
    .max(1_000),
});
const invitationsResponse = z.object({
  data: z
    .array(
      z.object({
        id: uuid,
        email: z.email().max(320),
        role,
        status: z.enum(["pending", "accepted", "revoked", "expired"]),
        expiresAt: instant,
        acceptedAt: instant.optional(),
        revokedAt: instant.optional(),
        createdAt: instant,
      }),
    )
    .max(1_000),
});
const importsResponse = z.object({
  data: z
    .array(
      z.object({
        id: uuid,
        connectionId: uuid,
        status: z.enum([
          "previewed",
          "validation_failed",
          "queued",
          "succeeded",
          "failed",
          "rolled_back",
        ]),
        filename: boundedText(255),
        rowCount: count,
        invalidRowCount: count,
        uploadedAt: instant,
        completedAt: instant.optional(),
        rolledBackAt: instant.optional(),
        supersededRecordCount: count.optional(),
      }),
    )
    .max(50),
});
const organizationProfileResponse = z.object({
  data: z.object({
    name: boundedText(200),
    businessTimeZone: boundedText(100),
    profileVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    updatedAt: instant,
  }),
});
const reviewPolicyResponse = z.object({
  data: z.object({
    dualApprovalEnabled: z.boolean(),
    dualApprovalThresholds: z
      .record(currency, z.string().regex(/^(0|[1-9][0-9]{0,30})$/u))
      .refine((value) => Object.keys(value).length <= 50),
    sensitiveResolutionTypes: z.array(code).max(50),
    updatedAt: instant,
  }),
});
const retentionPolicyResponse = z.object({
  data: z.object({
    rawImportRetentionDays: z.number().int().min(1).max(3_650).nullable(),
    providerEventRetentionDays: z.number().int().min(1).max(3_650).nullable(),
    legalHoldEnabled: z.boolean(),
    legalHoldReason: boundedText(2_000).nullable(),
    updatedAt: instant.nullable(),
  }),
});

const privacyRequestsResponse = z.object({
  data: z
    .array(
      z.object({
        id: uuid,
        connectionId: uuid,
        provider: z.literal("shopify"),
        topic: z.enum(["customers/data_request", "customers/redact", "shop/redact"]),
        apiVersion: boundedText(100),
        externalAccountId: boundedText(500),
        status: z.literal("action_required"),
        objectIdentifierCount: count,
        receivedAt: instant,
        dueAt: instant,
        deadlineAlert: z
          .object({
            stage: z.enum(["due_7_days", "due_24_hours", "overdue"]),
            observedAt: instant,
          })
          .optional(),
        deletionProgress: z.object({
          total: count,
          pending: count,
          processing: count,
          retry: count,
          deleted: count,
          alreadyMissing: count,
          deadLettered: count,
        }),
      }),
    )
    .max(50),
  meta: z.object({
    nextCursor: cursor.optional(),
  }),
});
const providerSyncRunsResponse = z.object({
  data: z
    .array(
      z.object({
        id: uuid,
        connectionId: uuid,
        provider: z.enum(["shopify", "stripe"]),
        mode: z.enum(["backfill", "gap_repair"]),
        windowStart: instant,
        windowEnd: instant,
        status: z.enum(["queued", "running", "partial", "succeeded", "failed"]),
        pageCount: count,
        itemCount: count,
        duplicateCount: count,
        maximumPages: z.number().int().min(1).max(100),
        failedAttempts: count,
        requesterType: z.enum(["user", "system"]),
        lastErrorCode: code.optional(),
        createdAt: instant,
      }),
    )
    .max(50),
});
const auditResponse = z.object({
  data: z
    .array(
      z.object({
        id: uuid,
        actorType: z.enum(["user", "worker", "system", "support"]),
        actorId: boundedText(200),
        action: code,
        resourceType: code,
        resourceId: boundedText(200),
        occurredAt: instant,
        correlationId: uuid,
        reason: boundedText(2_000).optional(),
      }),
    )
    .max(100),
});

const runSummary = z.object({
  id: uuid,
  stableRunKey: boundedText(200),
  status: runStatus,
  policyVersion: boundedText(100),
  ruleSetVersion: boundedText(100),
  engineVersion: boundedText(100),
  inputCount: count,
  matchCount: count,
  exceptionCount: count,
  errorCount: count,
  dispatchCount: count,
  operationalStateApplied: z.boolean(),
  lastErrorCode: code.optional(),
  startedAt: instant.optional(),
  completedAt: instant.optional(),
  createdAt: instant,
});
const runInput = z.object({
  id: uuid,
  version: z.number().int().min(1),
  contentSha256: sha256,
  ordinal: count,
});
const runMatch = z.object({
  id: uuid,
  ruleId: code,
  ruleVersion: boundedText(100),
  recordReferences,
  recordReferencesStatus,
  evidence: deterministicEvidence,
  evidenceFidelity,
  observedAt: instant,
});
const runException = z.object({
  id: uuid,
  type: code,
  observedStatus: code,
  currentStatus: code,
  severity: z.enum(["high", "medium", "low"]),
  recordReferences,
  recordReferencesStatus,
  amountMinor: minorUnits.optional(),
  currency: currency.optional(),
  evidence: deterministicEvidence,
  evidenceFidelity,
  observedAt: instant,
});
const runsResponse = z.object({ data: z.array(runSummary).max(50) });
const runResponse = z.object({
  data: runSummary.extend({
    inputSnapshotHash: sha256,
    policySnapshotHash: sha256,
    policySnapshot: jsonValue,
    initiatedBy: boundedText(200),
    inputRecords: z.array(runInput).max(100),
    inputRecordsTruncated: z.boolean(),
    matches: z.array(runMatch).max(10),
    matchesTruncated: z.boolean(),
    exceptions: z.array(runException).max(10),
    exceptionsTruncated: z.boolean(),
  }),
});
const runArtifactsResponse = z.object({
  data: z.discriminatedUnion("type", [
    z.object({ type: z.literal("match"), items: z.array(runMatch).max(25) }),
    z.object({ type: z.literal("exception"), items: z.array(runException).max(25) }),
  ]),
  meta: z.object({ nextCursor: cursor.optional() }),
});
const runInputsResponse = z.object({
  data: z.array(runInput).max(100),
  meta: z.object({ nextCursor: cursor.optional() }),
});

export const tenantReadViewSchema = z.enum([
  "summary",
  "exception",
  "connections",
  "connector_credentials",
  "members",
  "invitations",
  "imports",
  "organization_profile",
  "review_policy",
  "retention_policy",
  "privacy_requests",
  "provider_sync_runs",
  "audit",
  "runs",
  "run",
  "run_artifacts",
  "run_inputs",
]);

export type TenantReadView = z.infer<typeof tenantReadViewSchema>;

export function minimizeTenantReadResponse(view: TenantReadView, body: unknown): unknown {
  switch (view) {
    case "summary":
      return queueResponse.parse(body);
    case "exception":
      return exceptionDetailResponse.parse(body);
    case "connections":
      return connectionsResponse.parse(body);
    case "connector_credentials":
      return connectorCredentialsResponse.parse(body);
    case "members":
      return membersResponse.parse(body);
    case "invitations":
      return invitationsResponse.parse(body);
    case "imports":
      return importsResponse.parse(body);
    case "organization_profile":
      return organizationProfileResponse.parse(body);
    case "review_policy":
      return reviewPolicyResponse.parse(body);
    case "retention_policy":
      return retentionPolicyResponse.parse(body);
    case "privacy_requests":
      return privacyRequestsResponse.parse(body);
    case "provider_sync_runs":
      return providerSyncRunsResponse.parse(body);
    case "audit":
      return auditResponse.parse(body);
    case "runs":
      return runsResponse.parse(body);
    case "run":
      return runResponse.parse(body);
    case "run_artifacts":
      return runArtifactsResponse.parse(body);
    case "run_inputs":
      return runInputsResponse.parse(body);
  }
}
