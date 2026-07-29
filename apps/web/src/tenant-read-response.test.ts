import { describe, expect, it } from "vitest";

import {
  minimizeTenantReadResponse,
  tenantReadViewSchema,
  type TenantReadView,
} from "./tenant-read-response";

const id = "00000000-0000-4000-8000-000000000001";
const relatedId = "00000000-0000-4000-8000-000000000002";
const thirdId = "00000000-0000-4000-8000-000000000003";
const at = "2026-07-29T10:00:00.000Z";
const digest = "a".repeat(64);
const forbidden = "must-not-reach-the-browser";
const injected = {
  internalSecret: forbidden,
  encryptedCredentialReference: `sealed:${id}`,
};

const runSummary = {
  id,
  stableRunKey: "stable-run-key",
  status: "succeeded",
  policyVersion: "finance-v1",
  ruleSetVersion: "rules-v1",
  engineVersion: "engine-v1",
  inputCount: 1,
  matchCount: 1,
  exceptionCount: 0,
  errorCount: 0,
  dispatchCount: 1,
  operationalStateApplied: true,
  createdAt: at,
  ...injected,
};
const runInput = {
  id: relatedId,
  version: 1,
  contentSha256: digest,
  ordinal: 0,
  ...injected,
};
const deterministicEvidence = {
  schemaVersion: "deterministic-evidence-view-v1",
  status: "available",
  ruleId: "refund-accounting",
  ruleVersion: "1.0.0",
  ruleSetVersion: "1.0.0",
  sourceRecordCount: 1,
  evidenceTruncated: false,
  comparisons: [
    {
      source: { minor: "1250", currency: "USD" },
      normalized: { minor: "1250", currency: "USD" },
      ...injected,
    },
  ],
  toleranceMinor: "0",
  result: "pass",
  reasonCode: "REFUND_ACCOUNTING_ENTRY_MATCHED",
  evaluatedAt: at,
  ...injected,
};
const runMatch = {
  id: thirdId,
  ruleId: "refund-accounting",
  ruleVersion: "1.0.0",
  recordReferences: [],
  recordReferencesStatus: "available",
  evidence: deterministicEvidence,
  evidenceFidelity: "exact_at_observation",
  observedAt: at,
  ...injected,
};

const fixtures = {
  summary: {
    data: [
      {
        id,
        type: "amount_mismatch",
        status: "open",
        severity: "high",
        sources: ["stripe"],
        confidence: "high",
        assignee: "unassigned",
        amountMinor: "1250",
        currency: "USD",
        createdAt: at,
        updatedAt: at,
        ...injected,
      },
    ],
    meta: {
      correlationId: relatedId,
      filteredCount: 1,
      canExport: true,
      summary: { open: 1, high: 1, awaitingApproval: 0, decided: 0, ...injected },
      nextCursor: "tenant_cursor",
      ...injected,
    },
    ...injected,
  },
  exception: {
    data: {
      id,
      type: "amount_mismatch",
      status: "open",
      severity: "high",
      sources: ["stripe"],
      confidence: "high",
      assignee: "unassigned",
      amountMinor: "1250",
      currency: "USD",
      createdAt: at,
      updatedAt: at,
      recordReferences: [],
      recordReferencesStatus: "available",
      evidence: {
        ...deterministicEvidence,
        ruleId: "order-payment-amount",
        result: "fail",
        reasonCode: "AMOUNT_MISMATCH",
      },
      sourceRecords: [
        {
          id: relatedId,
          version: 1,
          kind: "payment",
          source: "stripe",
          sourceTimestamp: at,
          normalizedData: {
            kind: "payment",
            externalId: "pi_synthetic",
            orderReference: "order_synthetic",
            effectiveAt: at,
            amountMinor: "1250",
            currency: "USD",
            paymentStatus: "succeeded",
            credentialReference: forbidden,
          },
          contentSha256: digest,
          fieldProvenanceStatus: "available",
          fieldProvenance: [
            {
              fieldPath: "amountMinor",
              sourceValueReference: "raw.amount",
              normalizedValue: "1250",
              transformationRule: "integer_minor_units",
              transformationVersion: "1",
              warnings: [],
              ...injected,
            },
          ],
          ...injected,
        },
      ],
      notes: [
        {
          id: thirdId,
          authorMembershipId: relatedId,
          authorEmail: "operator@example.test",
          body: "Synthetic evidence reviewed.",
          createdAt: at,
          ...injected,
        },
      ],
      timeline: [
        {
          id: thirdId,
          action: "exception.created",
          resourceType: "exception",
          resourceId: id,
          actorType: "system",
          actorId: "reconciliation-worker",
          reason: "Deterministic mismatch",
          occurredAt: at,
          ...injected,
        },
      ],
      timelineTruncated: false,
      latestProposal: {
        id: thirdId,
        version: 2,
        type: "investigate_source_record",
        reason: "Revise the proposal after reviewing stronger source evidence",
        status: "pending",
        proposedBy: relatedId,
        canRevise: true,
        approvalCount: 0,
        requiredApprovals: 2,
        createdAt: at,
        ...injected,
      },
      ...injected,
    },
    meta: { correlationId: relatedId },
    ...injected,
  },
  connections: {
    data: [
      {
        id,
        provider: "shopify",
        externalAccountId: "synthetic-shop.myshopify.com",
        status: "healthy",
        connectorVersion: "1.0.0",
        syncEnabled: true,
        apiVersion: "2026-07",
        retryCount: 0,
        deadLetterCount: 0,
        objectWatermarks: [
          {
            objectType: "order",
            observationState: "observed",
            latestSourceAt: at,
            latestReceivedAt: at,
            ...injected,
          },
          {
            objectType: "refund_transaction",
            observationState: "never_observed",
            ...injected,
          },
        ],
        updatedAt: at,
        ...injected,
      },
    ],
    meta: { correlationId: relatedId },
    ...injected,
  },
  connector_credentials: {
    data: [
      {
        id,
        connectionId: relatedId,
        purpose: "api_read",
        status: "active",
        keyVersion: "v1",
        createdAt: at,
        createdByMembershipId: thirdId,
        updatedAt: at,
        ...injected,
      },
    ],
    meta: { correlationId: relatedId, maximumItems: 100 },
    ...injected,
  },
  members: {
    data: [
      {
        id,
        userId: relatedId,
        email: "operator@example.test",
        role: "analyst",
        status: "active",
        createdAt: at,
        updatedAt: at,
        ...injected,
      },
    ],
    meta: { correlationId: relatedId },
    ...injected,
  },
  invitations: {
    data: [
      {
        id,
        email: "invitee@example.test",
        role: "reviewer",
        status: "pending",
        invitedByMembershipId: relatedId,
        expiresAt: at,
        createdAt: at,
        updatedAt: at,
        ...injected,
      },
    ],
    meta: { correlationId: relatedId },
    ...injected,
  },
  imports: {
    data: [
      {
        id,
        connectionId: relatedId,
        status: "succeeded",
        filename: "synthetic.csv",
        templateVersion: "v1",
        mappingVersion: "v1",
        rowCount: 5,
        validRowCount: 5,
        invalidRowCount: 0,
        uploadedAt: at,
        completedAt: at,
        lastErrorCode: "INTERNAL_DETAIL",
        ...injected,
      },
    ],
    meta: { correlationId: relatedId },
    ...injected,
  },
  organization_profile: {
    data: {
      name: "North Operations",
      businessTimeZone: "America/New_York",
      profileVersion: 4,
      updatedAt: at,
      ...injected,
    },
    meta: { correlationId: relatedId },
    ...injected,
  },
  review_policy: {
    data: {
      dualApprovalEnabled: true,
      dualApprovalThresholds: { USD: "100000" },
      sensitiveResolutionTypes: ["manual_adjustment"],
      updatedAt: at,
      ...injected,
    },
    meta: { correlationId: relatedId },
    ...injected,
  },
  retention_policy: {
    data: {
      rawImportRetentionDays: 30,
      providerEventRetentionDays: 90,
      legalHoldEnabled: false,
      legalHoldReason: null,
      updatedAt: at,
      ...injected,
    },
    meta: { correlationId: relatedId },
    ...injected,
  },
  privacy_requests: {
    data: [
      {
        id,
        connectionId: relatedId,
        provider: "shopify",
        topic: "customers/redact",
        apiVersion: "2026-07",
        externalAccountId: "synthetic-shop.myshopify.com",
        status: "action_required",
        objectIdentifierCount: 2,
        receivedAt: at,
        dueAt: at,
        deadlineAlert: { stage: "due_7_days", observedAt: at, ...injected },
        deletionProgress: {
          total: 2,
          pending: 1,
          processing: 0,
          retry: 0,
          deleted: 1,
          alreadyMissing: 0,
          deadLettered: 0,
          ...injected,
        },
        customerId: forbidden,
        objectKey: forbidden,
        ...injected,
      },
    ],
    meta: {
      correlationId: relatedId,
      truncated: true,
      maximumItems: 100,
      nextCursor: "tenant_cursor",
      ...injected,
    },
    ...injected,
  },
  provider_sync_runs: {
    data: [
      {
        id,
        organizationId: thirdId,
        connectionId: relatedId,
        provider: "stripe",
        mode: "gap_repair",
        windowStart: at,
        windowEnd: "2026-07-29T11:00:00.000Z",
        status: "succeeded",
        pageCount: 2,
        itemCount: 10,
        duplicateCount: 1,
        maximumPages: 20,
        failedAttempts: 0,
        requesterType: "user",
        createdAt: at,
        ...injected,
      },
    ],
    meta: { correlationId: relatedId, maximumItems: 50 },
    ...injected,
  },
  audit: {
    data: [
      {
        id,
        actorType: "user",
        actorId: relatedId,
        action: "exception.reviewed",
        resourceType: "exception",
        resourceId: thirdId,
        occurredAt: at,
        correlationId: relatedId,
        reason: "Synthetic review",
        previousValue: { accessToken: forbidden },
        newValue: { accessToken: forbidden },
        versionContext: { diagnostic: forbidden },
        ...injected,
      },
    ],
    meta: { correlationId: relatedId },
    ...injected,
  },
  runs: {
    data: [runSummary],
    meta: { correlationId: relatedId },
    ...injected,
  },
  run: {
    data: {
      ...runSummary,
      inputSnapshotHash: digest,
      policySnapshotHash: digest,
      policySnapshot: { version: "finance-v1" },
      initiatedBy: relatedId,
      inputRecords: [runInput],
      inputRecordsTruncated: false,
      matches: [runMatch],
      matchesTruncated: false,
      exceptions: [],
      exceptionsTruncated: false,
    },
    meta: { correlationId: relatedId },
    ...injected,
  },
  run_artifacts: {
    data: { type: "match", items: [runMatch], ...injected },
    meta: { correlationId: relatedId, nextCursor: "tenant_cursor", ...injected },
    ...injected,
  },
  run_inputs: {
    data: [runInput],
    meta: { correlationId: relatedId, nextCursor: "tenant_cursor", ...injected },
    ...injected,
  },
} as const satisfies Readonly<Record<TenantReadView, unknown>>;

describe("tenant read response minimization", () => {
  it("has one successful response contract for every enumerated tenant read view", () => {
    expect(Object.keys(fixtures).sort()).toEqual([...tenantReadViewSchema.options].sort());

    for (const view of tenantReadViewSchema.options) {
      const minimized = minimizeTenantReadResponse(view, fixtures[view]);
      const serialized = JSON.stringify(minimized);
      expect(serialized, view).not.toContain(forbidden);
      expect(serialized, view).not.toContain("internalSecret");
      expect(serialized, view).not.toContain("encryptedCredentialReference");
    }
  });

  it("removes high-risk API-only metadata while retaining browser-required pagination", () => {
    const audit = minimizeTenantReadResponse("audit", fixtures.audit);
    expect(audit).toEqual({
      data: [
        {
          id,
          actorType: "user",
          actorId: relatedId,
          action: "exception.reviewed",
          resourceType: "exception",
          resourceId: thirdId,
          occurredAt: at,
          correlationId: relatedId,
          reason: "Synthetic review",
        },
      ],
    });

    expect(minimizeTenantReadResponse("run_inputs", fixtures.run_inputs)).toEqual({
      data: [{ id: relatedId, version: 1, contentSha256: digest, ordinal: 0 }],
      meta: { nextCursor: "tenant_cursor" },
    });

    expect(minimizeTenantReadResponse("exception", fixtures.exception)).toMatchObject({
      data: {
        latestProposal: {
          id: thirdId,
          version: 2,
          status: "pending",
          canRevise: true,
          approvalCount: 0,
          requiredApprovals: 2,
        },
      },
    });
    expect(
      JSON.stringify(minimizeTenantReadResponse("exception", fixtures.exception)),
    ).not.toContain("proposedBy");
  });

  it("accepts the fixed unavailable evidence state but rejects arbitrary stored evidence", () => {
    const unavailable = minimizeTenantReadResponse("exception", {
      ...fixtures.exception,
      data: {
        ...fixtures.exception.data,
        evidence: {
          schemaVersion: "deterministic-evidence-view-v1",
          status: "unavailable",
          reasonCode: "EVIDENCE_UNSUPPORTED_OR_MALFORMED",
        },
      },
    });
    expect(unavailable).toMatchObject({
      data: {
        evidence: {
          status: "unavailable",
          reasonCode: "EVIDENCE_UNSUPPORTED_OR_MALFORMED",
        },
      },
    });
    expect(() =>
      minimizeTenantReadResponse("exception", {
        ...fixtures.exception,
        data: {
          ...fixtures.exception.data,
          evidence: { credentialReference: forbidden },
        },
      }),
    ).toThrow();
  });

  it("fails closed on an invalid contract, oversized page, or unknown view", () => {
    expect(() =>
      minimizeTenantReadResponse("connections", {
        data: [{ id: "not-a-uuid" }],
      }),
    ).toThrow();
    expect(() =>
      minimizeTenantReadResponse("summary", {
        data: Array.from({ length: 51 }, () => fixtures.summary.data[0]),
        meta: fixtures.summary.meta,
      }),
    ).toThrow();
    expect(tenantReadViewSchema.safeParse("internal_diagnostics").success).toBe(false);
  });
});
