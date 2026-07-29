import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  CanonicalRecordIdSchema,
  MembershipIdSchema,
  OrganizationIdSchema,
  SourceEventIdSchema,
  UserIdSchema,
  asCurrency,
  canonicalFieldProvenance,
  money,
  serializeCanonicalRecord,
  tenantContextFromMembership,
  type CanonicalRecord,
} from "@workspace/domain";
import type { RuleEvidence } from "@workspace/reconciliation";
import postgres, { type JSONValue, type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresReconciliationRepository,
  RepositoryConflictError,
  RepositoryCursorError,
  RepositoryNotFoundError,
  type ReconciliationRunInputReference,
  type ReconciliationRunMatchArtifact,
} from "./repository.js";

const organizationId = OrganizationIdSchema.parse(randomUUID());
const otherOrganizationId = OrganizationIdSchema.parse(randomUUID());
const analystId = UserIdSchema.parse(randomUUID());
const reviewerId = UserIdSchema.parse(randomUUID());
const secondReviewerId = UserIdSchema.parse(randomUUID());
const ownerId = UserIdSchema.parse(randomUUID());
const analystMembershipId = MembershipIdSchema.parse(randomUUID());
const reviewerMembershipId = MembershipIdSchema.parse(randomUUID());
const secondReviewerMembershipId = MembershipIdSchema.parse(randomUUID());
const ownerMembershipId = MembershipIdSchema.parse(randomUUID());
const connectionId = randomUUID();
const stripeConnectionId = randomUUID();
const foreignConnectionId = randomUUID();
const orderEventId = SourceEventIdSchema.parse(randomUUID());
const paymentEventId = SourceEventIdSchema.parse(randomUUID());
const feeEventId = SourceEventIdSchema.parse(randomUUID());
const foreignOrderEventId = SourceEventIdSchema.parse(randomUUID());
const orderRecordId = CanonicalRecordIdSchema.parse(randomUUID());
const paymentRecordId = CanonicalRecordIdSchema.parse(randomUUID());
const feeRecordId = CanonicalRecordIdSchema.parse(randomUUID());
const foreignOrderRecordId = CanonicalRecordIdSchema.parse(randomUUID());

const analystTenant = tenantContextFromMembership({
  id: analystMembershipId,
  organizationId,
  userId: analystId,
  role: "analyst",
  status: "active",
});
const foreignAnalystTenant = tenantContextFromMembership({
  id: analystMembershipId,
  organizationId: otherOrganizationId,
  userId: analystId,
  role: "analyst",
  status: "active",
});
const reviewerTenant = tenantContextFromMembership({
  id: reviewerMembershipId,
  organizationId,
  userId: reviewerId,
  role: "reviewer",
  status: "active",
});
const secondReviewerTenant = tenantContextFromMembership({
  id: secondReviewerMembershipId,
  organizationId,
  userId: secondReviewerId,
  role: "reviewer",
  status: "active",
});
const ownerTenant = tenantContextFromMembership({
  id: ownerMembershipId,
  organizationId,
  userId: ownerId,
  role: "owner",
  status: "active",
});
const policy = {
  version: "integration-policy-v1",
  evaluatedAt: "2026-07-27T12:00:00.000Z",
  amountToleranceMinor: {},
  dateWindowSeconds: 86_400,
  delayedEventGraceSeconds: 3_600,
  businessTimeZone: "UTC",
} as const;

let administrator: Sql | undefined;
let application: Sql | undefined;

describe("live reconciliation persistence", { concurrent: false }, () => {
  beforeAll(async () => {
    const adminUrl = requiredEnvironment("DATABASE_ADMIN_URL");
    const migrationUrl = requiredEnvironment("DATABASE_MIGRATION_URL");
    const applicationUrl = requiredEnvironment("DATABASE_URL");
    const admin = postgres(adminUrl, { max: 1 });
    administrator = admin;
    await ensureLocalTestRoles(admin);
    execFileSync("pnpm", ["--filter", "@workspace/database", "db:migrate"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl },
      stdio: "pipe",
    });
    await seedTenant(admin);
    await insertCanonicalRecord(admin, orderRecord());
    await insertCanonicalRecord(admin, foreignOrderRecord(), otherOrganizationId);
    application = postgres(applicationUrl, { max: 4 });
  });

  afterAll(async () => {
    await application?.end({ timeout: 5 });
    await administrator?.end({ timeout: 5 });
  });

  it("keeps retention disabled until an owner records an explicit audited policy", async () => {
    const database = requiredConnection(application, "application");
    const admin = requiredConnection(administrator, "administrator");
    const repository = new PostgresReconciliationRepository(database);

    await expect(database`select * from reconai_observe_exception_queue()`).rejects.toMatchObject({
      code: "42501",
    });
    await expect(repository.getRetentionPolicy(ownerTenant)).resolves.toEqual({
      rawImportRetentionDays: null,
      providerEventRetentionDays: null,
      legalHoldEnabled: false,
      legalHoldReason: null,
      updatedAt: null,
    });
    const updated = await repository.updateRetentionPolicy(ownerTenant, {
      rawImportRetentionDays: 30,
      providerEventRetentionDays: 90,
      legalHoldEnabled: true,
      legalHoldReason: "Preserve raw evidence for the synthetic investigation",
      reason: "Record the approved synthetic retention and legal-hold policy",
    });
    expect(updated).toMatchObject({
      rawImportRetentionDays: 30,
      providerEventRetentionDays: 90,
      legalHoldEnabled: true,
      legalHoldReason: "Preserve raw evidence for the synthetic investigation",
    });
    expect(updated.updatedAt).toMatch(/^20[0-9]{2}-/u);
    await expect(repository.getRetentionPolicy(ownerTenant)).resolves.toEqual(updated);

    const evidence = await admin`
      select
        policies.updated_by_membership_id,
        policies.legal_hold_enabled,
        events.action,
        events.reason,
        events.previous_value,
        events.new_value
      from organization_retention_policies as policies
      inner join audit_events as events
        on events.organization_id = policies.organization_id
        and events.resource_type = 'organization_retention_policy'
      where policies.organization_id = ${organizationId}
      order by events.occurred_at desc, events.id desc
      limit 1
    `;
    expect(evidence[0]).toMatchObject({
      updated_by_membership_id: ownerMembershipId,
      legal_hold_enabled: true,
      action: "organization.retention_policy.updated",
      reason: "Record the approved synthetic retention and legal-hold policy",
      previous_value: {
        rawImportRetentionDays: null,
        providerEventRetentionDays: null,
        legalHoldEnabled: false,
      },
      new_value: {
        rawImportRetentionDays: 30,
        providerEventRetentionDays: 90,
        legalHoldEnabled: true,
      },
    });
  });

  it("returns only tenant-scoped fixed-family source watermarks", async () => {
    const repository = new PostgresReconciliationRepository(
      requiredConnection(application, "application"),
    );

    await expect(repository.listConnections(analystTenant)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: connectionId,
          provider: "shopify",
          objectWatermarks: [
            {
              objectType: "order",
              observationState: "observed",
              latestSourceAt: "2026-07-26T10:00:00.000Z",
              latestReceivedAt: "2026-07-26T10:01:00.000Z",
            },
            {
              objectType: "refund_transaction",
              observationState: "never_observed",
            },
          ],
        }),
        expect.objectContaining({
          id: stripeConnectionId,
          provider: "stripe",
          objectWatermarks: [
            { objectType: "payment_intent", observationState: "never_observed" },
            { objectType: "refund", observationState: "never_observed" },
            { objectType: "balance_transaction", observationState: "never_observed" },
          ],
        }),
      ]),
    );
    await expect(repository.listConnections(foreignAnalystTenant)).resolves.toEqual([
      expect.objectContaining({
        id: foreignConnectionId,
        provider: "shopify",
        objectWatermarks: [
          expect.objectContaining({ objectType: "order", observationState: "observed" }),
          { objectType: "refund_transaction", observationState: "never_observed" },
        ],
      }),
    ]);
  });

  it("pins durable run authority, deduplicates requests, and preserves review controls", async () => {
    const database = requiredConnection(application, "application");
    const admin = requiredConnection(administrator, "administrator");
    const repository = new PostgresReconciliationRepository(database);
    const traceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";

    const first = await repository.startRun(analystTenant, policy, {
      correlationId: randomUUID(),
      reason: "Exercise the durable reconciliation request boundary",
      traceparent,
    });
    expect(first).toMatchObject({ status: "queued", inputCount: 1, dispatchCount: 1 });
    const firstAuthority = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
      return transaction`
        select payload
        from outbox_events
        where organization_id = ${organizationId}
          and event_type = 'reconciliation.run.requested'
          and payload ->> 'runId' = ${first.id}
        limit 1
      `;
    });
    expect(firstAuthority[0]?.["payload"]).toMatchObject({
      traceContext: { schemaVersion: 1, traceparent },
    });
    await expect(
      repository.startRun(analystTenant, policy, {
        correlationId: randomUUID(),
        reason: "Verify idempotent authority for the same snapshot",
      }),
    ).resolves.toEqual(first);
    const firstDetail = await repository.getRun(analystTenant, first.id);
    expect(firstDetail).toMatchObject({
      id: first.id,
      inputRecords: [
        {
          id: orderRecordId,
          version: 1,
        },
      ],
      inputRecordsTruncated: false,
    });
    expect(firstDetail?.inputRecords[0]?.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
    await admin`
      update reconciliation_runs
      set status = 'failed', completed_at = now(), error_count = 1,
          last_error_code = 'SYNTHETIC_EXECUTION_FAILURE'
      where organization_id = ${organizationId} and id = ${first.id}
    `;
    await expect(
      repository.startRun(analystTenant, policy, {
        correlationId: randomUUID(),
        reason: "An identical failed run must use explicit recovery replay",
      }),
    ).rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(
      repository.replayRun(analystTenant, first.id, {
        correlationId: randomUUID(),
        reason: "Retry the same immutable snapshot after a synthetic failure",
        now: "2026-07-27T12:05:00.000Z",
      }),
    ).resolves.toMatchObject({
      id: first.id,
      status: "queued",
      dispatchCount: 2,
    });

    const dualReviewExceptionId = await insertSyntheticException(
      admin,
      first.stableRunKey,
      orderRecord(),
    );
    const investigation = await repository.getException(analystTenant, dualReviewExceptionId);
    expect(investigation).toMatchObject({
      recordReferences: [orderRecordId],
      recordReferencesStatus: "available",
      evidence: {
        status: "available",
        ruleId: "manual-review-required",
        reasonCode: "MANUAL_REVIEW_REQUIRED",
      },
      sourceRecords: [
        {
          id: orderRecordId,
          version: 1,
          kind: "order",
          source: "shopify",
          fieldProvenanceStatus: "available",
          normalizedData: {
            kind: "order",
            amountMinor: "12500",
            currency: "USD",
            financialStatus: "paid",
          },
        },
      ],
    });
    expect(investigation?.sourceRecords[0]?.fieldProvenance.length).toBeGreaterThan(0);
    expect(JSON.stringify(investigation)).not.toContain("sourceValueReference");
    expect(JSON.stringify(investigation)).not.toContain("sourceEventId");
    expect(JSON.stringify(investigation)).not.toContain("organizationId");
    await expect(
      repository.getException(foreignAnalystTenant, dualReviewExceptionId),
    ).resolves.toBeUndefined();

    const queueFilters = {
      status: "open",
      severity: "high",
      search: "manual review-required",
      source: "shopify",
      amountCurrency: "USD",
      minimumAmountMinor: "250000",
      maximumAmountMinor: "250000",
      confidence: "low",
      assignee: "unassigned",
      age: "under_24h",
    } as const;
    await expect(
      repository.listExceptions(analystTenant, {
        ...queueFilters,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      items: [
        {
          id: dualReviewExceptionId,
          type: "manual_review_required",
          sources: ["shopify"],
          confidence: "low",
          assignee: "unassigned",
        },
      ],
      filteredCount: 1,
      summary: { open: 1, high: 1, awaitingApproval: 0, decided: 0 },
    });
    await expect(
      repository.listExceptions(foreignAnalystTenant, {
        ...queueFilters,
        limit: 1,
      }),
    ).resolves.toMatchObject({ items: [], filteredCount: 0 });
    await expect(
      repository.listExceptions(analystTenant, {
        ...queueFilters,
        source: "stripe",
        limit: 1,
      }),
    ).resolves.toMatchObject({ items: [], filteredCount: 0 });
    const exportCorrelationId = randomUUID();
    const exported = await repository.exportExceptions(ownerTenant, queueFilters, {
      correlationId: exportCorrelationId,
    });
    expect(exported).toMatchObject({ rowCount: 1 });
    expect(exported.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(Buffer.byteLength(exported.csv, "utf8")).toBeGreaterThan(0);
    expect(exported.csv).toContain(dualReviewExceptionId);
    const exportAudit = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
      return transaction`
        select action, resource_type, resource_id, correlation_id, new_value
        from audit_events
        where organization_id = ${organizationId}
          and action = 'exception_queue.exported'
          and resource_id = ${exported.id}
        limit 1
      `;
    });
    expect(exportAudit[0]).toMatchObject({
      action: "exception_queue.exported",
      resource_type: "exception_export",
      resource_id: exported.id,
      correlation_id: exportCorrelationId,
      new_value: {
        format: "csv",
        rowCount: 1,
        filters: {
          status: "open",
          severity: "high",
          search: "manual review-required",
          source: "shopify",
          amountCurrency: "USD",
          minimumAmountMinor: "250000",
          maximumAmountMinor: "250000",
          confidence: "low",
          assignee: "unassigned",
          age: "under_24h",
        },
      },
    });
    expect(JSON.stringify(exportAudit[0])).toMatch(/"filterAsOf":"20[0-9]{2}-[0-9]{2}-[0-9]{2}T/u);
    const foreignReferenceExceptionId = await insertSyntheticException(
      admin,
      first.stableRunKey,
      foreignOrderRecord(),
    );
    await expect(
      repository.getException(analystTenant, foreignReferenceExceptionId),
    ).resolves.toMatchObject({
      recordReferences: [],
      recordReferencesStatus: "unavailable",
      evidence: { status: "available", reasonCode: "MANUAL_REVIEW_REQUIRED" },
      sourceRecords: [],
    });
    const dualReviewProposal = await repository.createProposal(
      analystTenant,
      dualReviewExceptionId,
      {
        type: "write_off",
        reason: "Exercise the configured dual-review path",
      },
    );
    await expect(
      repository.approveProposal(analystTenant, dualReviewProposal.id, {
        decision: "approve",
        reason: "A proposer must not decide their own proposal",
      }),
    ).rejects.toBeInstanceOf(RepositoryConflictError);
    const firstDecision = await repository.approveProposal(reviewerTenant, dualReviewProposal.id, {
      decision: "approve",
      reason: "First independent reviewer confirms the evidence",
    });
    expect(firstDecision).toMatchObject({
      status: "pending",
      approvalCount: 1,
      requiredApprovals: 2,
    });
    expect(Date.parse(firstDecision.decidedAt)).toBeGreaterThanOrEqual(
      Date.parse(firstDecision.proposalCreatedAt),
    );
    await expect(
      repository.getException(analystTenant, dualReviewExceptionId),
    ).resolves.toMatchObject({
      status: "proposed",
      latestProposal: {
        id: dualReviewProposal.id,
        version: 1,
        status: "pending",
        approvalCount: 1,
        requiredApprovals: 2,
        canRevise: true,
      },
    });
    await expect(
      repository.getException(reviewerTenant, dualReviewExceptionId),
    ).resolves.toMatchObject({
      latestProposal: { id: dualReviewProposal.id, canRevise: false },
    });
    await expect(
      repository.createProposal(reviewerTenant, dualReviewExceptionId, {
        type: "write_off",
        reason: "A different reviewer must not replace the proposer's pending evidence",
      }),
    ).rejects.toBeInstanceOf(RepositoryConflictError);

    const revisedProposal = await repository.createProposal(analystTenant, dualReviewExceptionId, {
      type: "write_off",
      reason: "Revise the proposal after reviewing stronger source evidence",
    });
    expect(revisedProposal).toMatchObject({
      version: 2,
      revisedFrom: {
        id: dualReviewProposal.id,
        version: 1,
        approvalCount: 1,
      },
    });
    await expect(
      repository.approveProposal(secondReviewerTenant, dualReviewProposal.id, {
        decision: "approve",
        reason: "A superseded proposal version must never retain approval authority",
      }),
    ).rejects.toBeInstanceOf(RepositoryConflictError);

    const revisionEvidence = await admin`
      select
        proposals.id,
        proposals.version,
        proposals.status,
        count(approvals.id)::integer as approval_count
      from resolution_proposals as proposals
      left join approvals
        on approvals.organization_id = proposals.organization_id
        and approvals.proposal_id = proposals.id
        and approvals.proposal_version = proposals.version
      where proposals.organization_id = ${organizationId}
        and proposals.exception_id = ${dualReviewExceptionId}
      group by proposals.id, proposals.version, proposals.status
      order by proposals.version
    `;
    expect(revisionEvidence).toEqual([
      {
        id: dualReviewProposal.id,
        version: 1,
        status: "superseded",
        approval_count: 1,
      },
      {
        id: revisedProposal.id,
        version: 2,
        status: "pending",
        approval_count: 0,
      },
    ]);
    const revisionAudit = await admin`
      select action, resource_id, previous_value, new_value
      from audit_events
      where organization_id = ${organizationId}
        and action = 'resolution.revised'
        and resource_id = ${revisedProposal.id}
      limit 1
    `;
    expect(revisionAudit[0]).toMatchObject({
      action: "resolution.revised",
      resource_id: revisedProposal.id,
      previous_value: {
        proposalId: dualReviewProposal.id,
        proposalVersion: 1,
        approvalCount: 1,
        status: "pending",
      },
      new_value: {
        exceptionId: dualReviewExceptionId,
        proposalType: "write_off",
        version: 2,
        requiredApprovals: 2,
        supersedesProposalId: dualReviewProposal.id,
        supersedesProposalVersion: 1,
        supersededProposalStatus: "superseded",
      },
    });

    const revisedFirstDecision = await repository.approveProposal(
      reviewerTenant,
      revisedProposal.id,
      {
        decision: "approve",
        reason: "First reviewer confirms the revised immutable evidence",
      },
    );
    expect(revisedFirstDecision).toMatchObject({
      status: "pending",
      approvalCount: 1,
      requiredApprovals: 2,
    });
    await expect(
      repository.approveProposal(reviewerTenant, revisedProposal.id, {
        decision: "approve",
        reason: "The same reviewer must not count twice on the revised version",
      }),
    ).rejects.toBeInstanceOf(RepositoryConflictError);
    const finalDecision = await repository.approveProposal(
      secondReviewerTenant,
      revisedProposal.id,
      {
        decision: "approve",
        reason: "Second independent reviewer completes revised dual control",
      },
    );
    expect(finalDecision).toMatchObject({
      status: "approved",
      approvalCount: 2,
      requiredApprovals: 2,
    });
    expect(Date.parse(finalDecision.decidedAt)).toBeGreaterThanOrEqual(
      Date.parse(finalDecision.proposalCreatedAt),
    );
    expect(Date.parse(finalDecision.exceptionStatusChangedAt)).toBeGreaterThanOrEqual(
      Date.parse(finalDecision.exceptionCreatedAt),
    );
    await expect(
      repository.getException(analystTenant, dualReviewExceptionId),
    ).resolves.toMatchObject({
      status: "approved",
      latestProposal: {
        id: revisedProposal.id,
        version: 2,
        status: "approved",
        approvalCount: 2,
        requiredApprovals: 2,
        canRevise: false,
      },
    });

    const concurrentExceptionId = await insertSyntheticException(
      admin,
      first.stableRunKey,
      orderRecord(),
    );
    const concurrentProposal = await repository.createProposal(
      analystTenant,
      concurrentExceptionId,
      {
        type: "write_off",
        reason: "Create an immutable proposal for the approval-revision serialization race",
      },
    );
    const [concurrentRevision, concurrentApproval] = await Promise.allSettled([
      repository.createProposal(analystTenant, concurrentExceptionId, {
        type: "manual_override",
        reason: "Replace the pending authority while an independent review may be arriving",
      }),
      repository.approveProposal(reviewerTenant, concurrentProposal.id, {
        decision: "approve",
        reason: "Exercise the independent reviewer side of the serialization race",
      }),
    ]);
    expect(concurrentRevision.status).toBe("fulfilled");
    if (concurrentRevision.status !== "fulfilled") {
      throw concurrentRevision.reason;
    }
    expect(concurrentRevision.value).toMatchObject({
      version: 2,
      revisedFrom: {
        id: concurrentProposal.id,
        version: 1,
      },
    });
    if (concurrentApproval.status === "rejected") {
      expect(concurrentApproval.reason).toBeInstanceOf(RepositoryConflictError);
    } else {
      expect(concurrentApproval.value).toMatchObject({
        status: "pending",
        approvalCount: 1,
        requiredApprovals: 2,
      });
    }
    const concurrentEvidence = await admin`
      select
        proposals.id,
        proposals.version,
        proposals.status,
        count(approvals.id)::integer as approval_count
      from resolution_proposals as proposals
      left join approvals
        on approvals.organization_id = proposals.organization_id
        and approvals.proposal_id = proposals.id
        and approvals.proposal_version = proposals.version
      where proposals.organization_id = ${organizationId}
        and proposals.exception_id = ${concurrentExceptionId}
      group by proposals.id, proposals.version, proposals.status
      order by proposals.version
    `;
    expect(concurrentEvidence).toEqual([
      {
        id: concurrentProposal.id,
        version: 1,
        status: "superseded",
        approval_count: concurrentApproval.status === "fulfilled" ? 1 : 0,
      },
      {
        id: concurrentRevision.value.id,
        version: 2,
        status: "pending",
        approval_count: 0,
      },
    ]);

    await insertCanonicalRecord(admin, paymentRecord());
    await insertCanonicalRecord(admin, feeRecord());
    const second = await repository.startRun(analystTenant, policy, {
      correlationId: randomUUID(),
      reason: "Queue a new immutable snapshot after additional canonical records",
    });
    expect(second.stableRunKey).not.toBe(first.stableRunKey);
    expect(second).toMatchObject({ status: "queued", inputCount: 3, dispatchCount: 1 });
    await expect(repository.listRuns(analystTenant, { limit: 10 })).resolves.toEqual([
      second,
      expect.objectContaining({ id: first.id, dispatchCount: 2 }),
    ]);

    const counts = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
      return transaction`
        select
          (select count(*)::integer from reconciliation_runs) as runs,
          (select count(*)::integer from reconciliation_run_inputs) as run_inputs,
          (select count(*)::integer from outbox_events
            where event_type = 'reconciliation.run.requested') as outbox,
          (select count(*)::integer from exceptions) as exceptions,
          (select count(*)::integer from exception_occurrences) as exception_occurrences,
          (select count(*)::integer from matches) as matches,
          (select count(*)::integer from match_occurrences) as match_occurrences
      `;
    });
    expect(counts[0]).toMatchObject({
      runs: 2,
      run_inputs: 4,
      outbox: 3,
      exceptions: 3,
      exception_occurrences: 0,
      matches: 0,
      match_occurrences: 0,
    });

    const hidden = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${otherOrganizationId}, true)`;
      return transaction`select run_id from reconciliation_run_inputs`;
    });
    expect(hidden).toHaveLength(0);

    await expect(
      database.begin(async (transaction) => {
        await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
        await transaction`
          update reconciliation_runs
          set status = 'cancelled', completed_at = now()
          where id = ${first.id}
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      database.begin(async (transaction) => {
        await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
        await transaction`update reconciliation_run_inputs set ordinal = ordinal + 1`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      admin`update reconciliation_run_inputs set ordinal = ordinal + 1
            where organization_id = ${organizationId}`,
    ).rejects.toMatchObject({ code: "P0001" });
  });

  it("returns bounded exact run artifacts and labels rolling-window legacy projections", async () => {
    const database = requiredConnection(application, "application");
    const admin = requiredConnection(administrator, "administrator");
    const repository = new PostgresReconciliationRepository(database);
    const scenario = await insertRunArtifactReadScenario(admin);
    const detail = await repository.getRun(analystTenant, scenario.runId);

    expect(detail).toMatchObject({
      id: scenario.runId,
      status: "succeeded",
      engineVersion: "0.6.0",
      ruleSetVersion: "1.4.0",
      matchCount: 12,
      exceptionCount: 1,
      matchesTruncated: true,
      exceptionsTruncated: false,
    });
    expect(detail?.inputRecords).toHaveLength(100);
    expect(detail?.inputRecordsTruncated).toBe(true);
    expect(detail?.matches).toHaveLength(10);
    const exactMatch = detail?.matches.find(({ id }) => id === scenario.exactMatchId);
    const legacyMatch = detail?.matches.find(({ id }) => id === scenario.legacyMatchId);
    expect(exactMatch).toMatchObject({
      id: scenario.exactMatchId,
      ruleId: "refund-accounting",
      ruleVersion: "1.4.0",
      evidenceFidelity: "exact_at_observation",
    });
    expect(exactMatch?.evidence).toMatchObject({
      reasonCode: "REFUND_ACCOUNTING_ENTRY_MATCHED",
    });
    expect(legacyMatch).toMatchObject({
      id: scenario.legacyMatchId,
      ruleId: "order-payment",
      ruleVersion: "1.4.0",
      evidenceFidelity: "legacy_current_projection",
    });
    expect(legacyMatch?.evidence).toMatchObject({
      reasonCode: "ORDER_PAYMENT_TOTAL_MATCHED",
    });
    expect(detail?.exceptions).toHaveLength(1);
    expect(detail?.exceptions[0]).toMatchObject({
      id: scenario.exceptionId,
      type: "duplicate_processing_fee",
      observedStatus: "open",
      currentStatus: "approved",
      severity: "high",
      evidenceFidelity: "exact_at_observation",
    });
    expect(detail?.exceptions[0]?.evidence).toMatchObject({
      reasonCode: "DUPLICATE_SOURCE_EXTERNAL_IDENTIFIER",
    });

    const pagedMatches: ReconciliationRunMatchArtifact[] = [];
    let matchCursor: string | undefined;
    do {
      const page = await repository.listRunArtifacts(analystTenant, scenario.runId, {
        type: "match",
        limit: 5,
        ...(matchCursor ? { cursor: matchCursor } : {}),
      });
      expect(page?.type).toBe("match");
      if (!page) throw new Error("expected a tenant-visible match artifact page");
      if (page.type !== "match") throw new Error("expected a match artifact page");
      pagedMatches.push(...page.items);
      matchCursor = page.nextCursor;
    } while (matchCursor);
    expect(pagedMatches).toHaveLength(12);
    expect(new Set(pagedMatches.map(({ id }) => id)).size).toBe(12);
    expect(pagedMatches.map(({ id }) => id)).toEqual([...pagedMatches.map(({ id }) => id)].sort());
    expect(pagedMatches.find(({ id }) => id === scenario.exactMatchId)).toMatchObject({
      evidenceFidelity: "exact_at_observation",
      evidence: { reasonCode: "REFUND_ACCOUNTING_ENTRY_MATCHED" },
    });
    expect(pagedMatches.find(({ id }) => id === scenario.legacyMatchId)).toMatchObject({
      evidenceFidelity: "legacy_current_projection",
      evidence: { reasonCode: "ORDER_PAYMENT_TOTAL_MATCHED" },
    });

    const exceptionPage = await repository.listRunArtifacts(analystTenant, scenario.runId, {
      type: "exception",
      limit: 5,
    });
    expect(exceptionPage).toMatchObject({
      type: "exception",
      items: [
        {
          id: scenario.exceptionId,
          observedStatus: "open",
          currentStatus: "approved",
          evidenceFidelity: "exact_at_observation",
          evidence: { reasonCode: "DUPLICATE_SOURCE_EXTERNAL_IDENTIFIER" },
        },
      ],
    });
    expect(exceptionPage?.nextCursor).toBeUndefined();
    await expect(
      repository.listRunArtifacts(foreignAnalystTenant, scenario.runId, {
        type: "match",
        limit: 5,
      }),
    ).resolves.toBeUndefined();
    const firstMatchPage = await repository.listRunArtifacts(analystTenant, scenario.runId, {
      type: "match",
      limit: 5,
    });
    const boundCursor = firstMatchPage?.nextCursor;
    if (!boundCursor) throw new Error("expected a cursor for the first five match artifacts");
    await expect(
      repository.listRunArtifacts(analystTenant, scenario.runId, {
        type: "exception",
        limit: 5,
        cursor: boundCursor,
      }),
    ).rejects.toBeInstanceOf(RepositoryCursorError);

    const pagedInputs: ReconciliationRunInputReference[] = [];
    let inputCursor: string | undefined;
    do {
      const page = await repository.listRunInputs(analystTenant, scenario.runId, {
        limit: 40,
        ...(inputCursor ? { cursor: inputCursor } : {}),
      });
      if (!page) throw new Error("expected a tenant-visible run input page");
      pagedInputs.push(...page.items);
      inputCursor = page.nextCursor;
    } while (inputCursor);
    expect(pagedInputs).toHaveLength(102);
    expect(new Set(pagedInputs.map(({ id, version }) => `${id}:${String(version)}`)).size).toBe(
      102,
    );
    expect(pagedInputs.map(({ ordinal }) => ordinal)).toEqual(
      Array.from({ length: 102 }, (_, index) => index),
    );
    expect(pagedInputs.every(({ contentSha256 }) => /^[a-f0-9]{64}$/u.test(contentSha256))).toBe(
      true,
    );
    await expect(
      repository.listRunInputs(foreignAnalystTenant, scenario.runId, { limit: 40 }),
    ).resolves.toBeUndefined();
    const firstInputPage = await repository.listRunInputs(analystTenant, scenario.runId, {
      limit: 40,
    });
    const boundInputCursor = firstInputPage?.nextCursor;
    if (!boundInputCursor) throw new Error("expected a cursor for the first 40 run inputs");
    await expect(
      repository.listRunInputs(analystTenant, randomUUID(), {
        limit: 40,
        cursor: boundInputCursor,
      }),
    ).rejects.toBeInstanceOf(RepositoryCursorError);

    const hidden = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${otherOrganizationId}, true)`;
      return transaction`
        select
          (select count(*)::integer from reconciliation_runs where id = ${scenario.runId}) as runs,
          (select count(*)::integer from reconciliation_run_inputs
            where run_id = ${scenario.runId}) as run_inputs,
          (select count(*)::integer from match_occurrence_snapshots
            where run_id = ${scenario.runId}) as match_snapshots,
          (select count(*)::integer from exception_occurrence_snapshots
            where run_id = ${scenario.runId}) as exception_snapshots
      `;
    });
    expect(hidden[0]).toMatchObject({
      runs: 0,
      run_inputs: 0,
      match_snapshots: 0,
      exception_snapshots: 0,
    });
  });

  it("enforces verified-email invitation creation, single-use acceptance, and revocation", async () => {
    const database = requiredConnection(application, "application");
    const repository = new PostgresReconciliationRepository(database);
    const invitedEmail = `reviewer-${randomUUID()}@example.test`;
    const invitation = await repository.createInvitation(ownerTenant, {
      email: invitedEmail,
      role: "reviewer",
      reason: "Invite a verified integration-test reviewer",
    });
    expect(invitation).toMatchObject({
      email: invitedEmail,
      role: "reviewer",
      status: "pending",
    });
    expect(invitation.acceptToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(repository.listInvitations(ownerTenant)).resolves.toEqual([
      expect.objectContaining({ id: invitation.id, status: "pending" }),
    ]);
    const deliveryCorrelationId = randomUUID();
    await repository.recordInvitationDelivery(ownerTenant, invitation.id, {
      status: "accepted",
      provider: "http_webhook",
      providerMessageId: "integration-message-1",
      correlationId: deliveryCorrelationId,
    });
    const deliveryAudit = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
      return transaction`
        select correlation_id, new_value
        from audit_events
        where organization_id = ${organizationId}
          and resource_id = ${invitation.id}
          and action = 'organization.invitation.delivery.accepted'
        limit 1
      `;
    });
    expect(deliveryAudit[0]).toMatchObject({
      correlation_id: deliveryCorrelationId,
      new_value: {
        status: "accepted",
        provider: "http_webhook",
        providerMessageId: "integration-message-1",
      },
    });
    expect(JSON.stringify(deliveryAudit[0])).not.toContain(invitation.acceptToken);

    await expect(
      repository.acceptInvitation(
        {
          issuer: "https://issuer.example.test",
          subject: `wrong-email-${randomUUID()}`,
          email: `wrong-${randomUUID()}@example.test`,
          emailVerified: true,
        },
        invitation.acceptToken,
        { correlationId: randomUUID() },
      ),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError);

    const accepted = await repository.acceptInvitation(
      {
        issuer: "https://issuer.example.test",
        subject: `invited-${randomUUID()}`,
        email: invitedEmail,
        emailVerified: true,
      },
      invitation.acceptToken,
      { correlationId: randomUUID() },
    );
    expect(accepted).toMatchObject({
      organizationId,
      invitationId: invitation.id,
      role: "reviewer",
    });
    await expect(
      repository.acceptInvitation(
        {
          issuer: "https://issuer.example.test",
          subject: `replay-${randomUUID()}`,
          email: invitedEmail,
          emailVerified: true,
        },
        invitation.acceptToken,
        { correlationId: randomUUID() },
      ),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(repository.listInvitations(ownerTenant)).resolves.toEqual([
      expect.objectContaining({
        id: invitation.id,
        status: "accepted",
        acceptedMembershipId: accepted.membershipId,
      }),
    ]);

    const revocable = await repository.createInvitation(ownerTenant, {
      email: `auditor-${randomUUID()}@example.test`,
      role: "auditor",
      reason: "Exercise immediate invitation revocation",
    });
    await expect(
      repository.revokeInvitation(ownerTenant, revocable.id, {
        reason: "The planned access review was cancelled",
      }),
    ).resolves.toMatchObject({ id: revocable.id, status: "revoked" });
    await expect(
      repository.acceptInvitation(
        {
          issuer: "https://issuer.example.test",
          subject: `revoked-${randomUUID()}`,
          email: revocable.email,
          emailVerified: true,
        },
        revocable.acceptToken,
        { correlationId: randomUUID() },
      ),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError);

    await expect(
      repository.createInvitation(analystTenant, {
        email: `blocked-${randomUUID()}@example.test`,
        role: "reviewer",
        reason: "An analyst must not mint organization access",
      }),
    ).rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(
      database.begin(async (transaction) => {
        await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
        await transaction`select token_sha256 from organization_invitations`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      database.begin(async (transaction) => {
        await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
        await transaction`
          update organization_invitations
          set status = 'accepted'
          where id = ${revocable.id}
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

function orderRecord(): CanonicalRecord {
  return {
    id: orderRecordId,
    organizationId,
    version: 1,
    kind: "order",
    externalId: "integration-order-1",
    orderReference: "#INTEGRATION-1",
    effectiveAt: "2026-07-26T10:00:00.000Z",
    amount: money(12_500n, asCurrency("USD")),
    financialStatus: "paid",
    provenance: provenance("shopify", "order", "integration-order-1", orderEventId),
  };
}

function foreignOrderRecord(): CanonicalRecord {
  const record = orderRecord();
  return {
    ...record,
    id: foreignOrderRecordId,
    organizationId: otherOrganizationId,
    externalId: "foreign-order-1",
    orderReference: "foreign-order-1",
    provenance: {
      ...record.provenance,
      externalObjectId: "foreign-order-1",
      sourceEventId: foreignOrderEventId,
    },
  };
}

function artifactInputRecord(index: number): CanonicalRecord {
  const externalId = `artifact-input-${String(index + 1)}`;
  return {
    id: CanonicalRecordIdSchema.parse(randomUUID()),
    organizationId,
    version: 1,
    kind: "order",
    externalId,
    orderReference: `#ARTIFACT-${String(index + 1)}`,
    effectiveAt: "2026-07-29T00:00:00.000Z",
    amount: money(BigInt(index + 1), asCurrency("USD")),
    financialStatus: "paid",
    provenance: provenance("shopify", "order", externalId, SourceEventIdSchema.parse(randomUUID())),
  };
}

function paymentRecord(): CanonicalRecord {
  return {
    id: paymentRecordId,
    organizationId,
    version: 1,
    kind: "payment",
    externalId: "integration-payment-1",
    orderReference: "integration-order-1",
    providerOrderReference: "integration-order-1",
    effectiveAt: "2026-07-26T10:02:00.000Z",
    amount: money(12_500n, asCurrency("USD")),
    paymentStatus: "succeeded",
    provenance: provenance("stripe", "payment_intent", "integration-payment-1", paymentEventId),
  };
}

function feeRecord(): CanonicalRecord {
  return {
    id: feeRecordId,
    organizationId,
    version: 1,
    kind: "processing_fee",
    externalId: "integration-fee-1",
    paymentReference: "integration-payment-1",
    effectiveAt: "2026-07-26T10:03:00.000Z",
    amount: money(393n, asCurrency("USD")),
    provenance: provenance("stripe", "balance_transaction", "integration-fee-1", feeEventId),
  };
}

function provenance(
  sourceSystem: "shopify" | "stripe",
  externalObjectType: string,
  externalObjectId: string,
  sourceEventId: ReturnType<typeof SourceEventIdSchema.parse>,
) {
  return {
    sourceSystem,
    externalObjectType,
    externalObjectId,
    sourceTimestamp: "2026-07-26T10:00:00.000Z",
    ingestionTimestamp: "2026-07-26T10:01:00.000Z",
    sourceEventId,
    connectorVersion: "integration-v1",
    normalizerVersion: "integration-v1",
  } as const;
}

async function insertCanonicalRecord(
  sql: Sql,
  record: CanonicalRecord,
  recordOrganizationId = organizationId,
): Promise<void> {
  const serialized = serializeCanonicalRecord(record);
  const contentSha256 = canonicalRecordContentSha256(record);
  const normalizedData = JSON.parse(JSON.stringify(serialized)) as JSONValue;
  const sourceConnectionId =
    recordOrganizationId === otherOrganizationId
      ? foreignConnectionId
      : record.provenance.sourceSystem === "stripe"
        ? stripeConnectionId
        : connectionId;
  await sql`
    insert into source_events (
      id, organization_id, connection_id, source, external_event_id, external_object_type,
      external_object_id, source_timestamp, received_at, connector_version,
      payload_object_key, payload_sha256, status
    ) values (
      ${record.provenance.sourceEventId}, ${recordOrganizationId}, ${sourceConnectionId},
      ${record.provenance.sourceSystem}, ${record.provenance.externalObjectId},
      ${record.provenance.externalObjectType}, ${record.provenance.externalObjectId},
      ${record.provenance.sourceTimestamp}, ${record.provenance.ingestionTimestamp},
      ${record.provenance.connectorVersion},
      ${`integration/${recordOrganizationId}/events/${record.provenance.sourceEventId}.json`},
      ${contentSha256}, 'normalized'
    )
  `;
  await sql`
    insert into source_event_object_classifications (
      organization_id, source_event_id, object_families, classifier_version
    ) values (
      ${recordOrganizationId}, ${record.provenance.sourceEventId},
      ${[record.provenance.externalObjectType]}::text[], 'source-object-family-v1'
    )
  `;
  await sql`
    insert into canonical_records (
      id, organization_id, version, kind, source_event_id, source, external_object_type,
      external_object_id, source_timestamp, ingestion_timestamp, effective_at,
      connector_version, normalizer_version, amount_minor, currency, order_reference,
      customer_reference, normalized_data, content_sha256, is_incomplete
    ) values (
      ${record.id}, ${recordOrganizationId}, ${record.version}, ${record.kind},
      ${record.provenance.sourceEventId}, ${record.provenance.sourceSystem},
      ${record.provenance.externalObjectType}, ${record.provenance.externalObjectId},
      ${record.provenance.sourceTimestamp}, ${record.provenance.ingestionTimestamp},
      ${record.effectiveAt}, ${record.provenance.connectorVersion},
      ${record.provenance.normalizerVersion}, ${record.amount.minor.toString()},
      ${record.amount.currency}, ${record.orderReference ?? null},
      ${record.customerReference ?? null}, ${sql.json(normalizedData)}, ${contentSha256}, false
    )
  `;
  const fieldValues = canonicalFieldProvenance(record).map((entry) => ({
    organization_id: recordOrganizationId,
    record_id: record.id,
    record_version: record.version,
    field_path: entry.fieldPath,
    source_event_id: entry.sourceEventId,
    source_value_reference: entry.sourceValueReference,
    normalized_value: sql.json(entry.normalizedValue as JSONValue),
    transformation_rule: entry.transformationRule,
    transformation_version: entry.transformationVersion,
    warnings: sql.json(JSON.parse(JSON.stringify(entry.warnings)) as JSONValue),
  }));
  await sql`
    insert into canonical_field_provenance ${sql(
      fieldValues,
      "organization_id",
      "record_id",
      "record_version",
      "field_path",
      "source_event_id",
      "source_value_reference",
      "normalized_value",
      "transformation_rule",
      "transformation_version",
      "warnings",
    )}
  `;
}

function canonicalRecordContentSha256(record: CanonicalRecord): string {
  return createHash("sha256")
    .update(stableStringify(serializeCanonicalRecord(record)))
    .digest("hex");
}

async function insertSyntheticException(
  sql: Sql,
  runKey: string,
  sourceRecord: CanonicalRecord,
): Promise<string> {
  const run = await sql`
    select id
    from reconciliation_runs
    where organization_id = ${organizationId} and stable_run_key = ${runKey}
    limit 1
  `;
  const runId: unknown = run[0]?.["id"];
  if (typeof runId !== "string") throw new Error("expected persisted reconciliation run");
  const id = randomUUID();
  const stableKey = createHash("sha256").update(`dual-review:${id}`).digest("hex");
  const deterministicEvidence = integrationRuleEvidence({
    ruleId: "manual-review-required",
    reasonCode: "MANUAL_REVIEW_REQUIRED",
    result: "ambiguous",
    records: [
      {
        id: sourceRecord.id,
        version: sourceRecord.version,
        contentSha256: canonicalRecordContentSha256(sourceRecord),
      },
    ],
    evaluatedAt: "2026-07-27T12:00:00.000Z",
  });
  await sql`
    insert into exceptions (
      id, organization_id, stable_key, first_run_id, latest_run_id, type, status,
      severity, record_references, amount_minor, currency, evidence
    ) values (
      ${id}, ${organizationId}, ${stableKey}, ${runId}, ${runId}, 'manual_review_required',
      'open', 'high', ${sql.json([sourceRecord.id])}, '250000', 'USD',
      ${sql.json(evidenceJson(deterministicEvidence))}
    )
  `;
  return id;
}

async function insertRunArtifactReadScenario(sql: Sql): Promise<{
  readonly runId: string;
  readonly exactMatchId: string;
  readonly legacyMatchId: string;
  readonly exceptionId: string;
}> {
  const runId = randomUUID();
  const exactMatchId = randomUUID();
  const legacyMatchId = randomUUID();
  const exceptionId = randomUUID();
  const runStableKey = createHash("sha256").update(`artifact-read-run:${runId}`).digest("hex");
  const exactMatchStableKey = createHash("sha256")
    .update(`artifact-read-exact-match:${exactMatchId}`)
    .digest("hex");
  const legacyMatchStableKey = createHash("sha256")
    .update(`artifact-read-legacy-match:${legacyMatchId}`)
    .digest("hex");
  const exceptionStableKey = createHash("sha256")
    .update(`artifact-read-exception:${exceptionId}`)
    .digest("hex");
  const refundReferences = [randomUUID(), randomUUID()];
  const orderReferences = [randomUUID(), randomUUID()];
  const feeReferences = [randomUUID(), randomUUID()];
  const overflowLegacyMatchIds = Array.from({ length: 10 }, () => randomUUID());
  const inputRecords = [
    orderRecord(),
    ...Array.from({ length: 101 }, (_, index) => artifactInputRecord(index)),
  ];
  for (const record of inputRecords.slice(1)) await insertCanonicalRecord(sql, record);
  const exactMatchEvidence = integrationRuleEvidence({
    ruleId: "refund-accounting",
    reasonCode: "REFUND_ACCOUNTING_ENTRY_MATCHED",
    result: "pass",
    records: refundReferences.map((id) => ({ id, version: 1, contentSha256: "3".repeat(64) })),
    evaluatedAt: "2026-07-29T00:00:00.000Z",
  });
  const legacyMatchEvidence = integrationRuleEvidence({
    ruleId: "order-payment",
    reasonCode: "ORDER_PAYMENT_TOTAL_MATCHED",
    result: "pass",
    records: orderReferences.map((id) => ({ id, version: 1, contentSha256: "4".repeat(64) })),
    evaluatedAt: "2026-07-29T00:00:00.000Z",
  });
  const currentExceptionEvidence = integrationRuleEvidence({
    ruleId: "duplicate-processing-fee",
    reasonCode: "LATER_CURRENT_PROJECTION",
    result: "fail",
    records: feeReferences.map((id) => ({ id, version: 1, contentSha256: "5".repeat(64) })),
    evaluatedAt: "2026-07-29T01:00:00.000Z",
  });
  const observedExceptionEvidence = integrationRuleEvidence({
    ruleId: "duplicate-processing-fee",
    reasonCode: "DUPLICATE_SOURCE_EXTERNAL_IDENTIFIER",
    result: "fail",
    records: feeReferences.map((id) => ({ id, version: 1, contentSha256: "5".repeat(64) })),
    evaluatedAt: "2026-07-29T00:00:00.000Z",
  });

  await sql`
    insert into reconciliation_runs (
      id, organization_id, stable_run_key, input_snapshot_hash, policy_snapshot_hash,
      policy_snapshot, policy_version, rule_set_version, engine_version, initiated_by,
      status, input_count, match_count, exception_count, error_count, dispatch_count,
      operational_state_applied, started_at, completed_at, created_at
    ) values (
      ${runId}, ${organizationId}, ${runStableKey}, ${"1".repeat(64)}, ${"2".repeat(64)},
      '{"version":"artifact-read-v1","evaluatedAt":"2026-07-29T00:00:00.000Z","amountToleranceMinor":{"USD":"0"},"dateWindowSeconds":86400,"delayedEventGraceSeconds":3600,"businessTimeZone":"UTC"}'::jsonb,
      'artifact-read-v1', '1.4.0', '0.6.0', ${analystId}, 'succeeded', 102, 12, 1, 0, 1,
      false, '2026-07-29T00:00:01.000Z', '2026-07-29T00:00:02.000Z',
      '2026-07-29T00:00:00.000Z'
    )
  `;
  const runInputs = inputRecords.map((record, ordinal) => ({
    organization_id: organizationId,
    run_id: runId,
    record_id: record.id,
    record_version: record.version,
    content_sha256: canonicalRecordContentSha256(record),
    ordinal,
  }));
  await sql`
    insert into reconciliation_run_inputs ${sql(
      runInputs,
      "organization_id",
      "run_id",
      "record_id",
      "record_version",
      "content_sha256",
      "ordinal",
    )}
  `;
  await sql`
    insert into matches (
      id, organization_id, run_id, stable_key, rule_id, rule_version,
      record_references, evidence, created_at
    ) values
    (
      ${exactMatchId}, ${organizationId}, ${runId}, ${exactMatchStableKey},
      'refund-accounting', '1.4.0', ${sql.json(refundReferences)},
      ${sql.json(evidenceJson(exactMatchEvidence))},
      '2026-07-29T00:00:02.000Z'
    ),
    (
      ${legacyMatchId}, ${organizationId}, ${runId}, ${legacyMatchStableKey},
      'order-payment', '1.4.0', ${sql.json(orderReferences)},
      ${sql.json(evidenceJson(legacyMatchEvidence))},
      '2026-07-29T00:00:02.000Z'
    )
  `;
  await sql`
    insert into match_occurrences (organization_id, run_id, match_id, observed_at) values
      (${organizationId}, ${runId}, ${exactMatchId}, '2026-07-29T00:00:02.000Z'),
      (${organizationId}, ${runId}, ${legacyMatchId}, '2026-07-29T00:00:03.000Z')
  `;
  for (const [index, overflowMatchId] of overflowLegacyMatchIds.entries()) {
    const stableKey = createHash("sha256")
      .update(`artifact-read-overflow-match:${overflowMatchId}`)
      .digest("hex");
    const observedAt = `2026-07-29T00:00:${String(index + 4).padStart(2, "0")}.000Z`;
    await sql`
      insert into matches (
        id, organization_id, run_id, stable_key, rule_id, rule_version,
        record_references, evidence, created_at
      ) values (
        ${overflowMatchId}, ${organizationId}, ${runId}, ${stableKey},
        'order-payment', '1.4.0', ${sql.json(orderReferences)},
        ${sql.json(evidenceJson(legacyMatchEvidence))},
        ${observedAt}
      )
    `;
    await sql`
      insert into match_occurrences (
        organization_id, run_id, match_id, observed_at
      ) values (
        ${organizationId}, ${runId}, ${overflowMatchId}, ${observedAt}
      )
    `;
  }
  await sql`
    insert into match_occurrence_snapshots (
      organization_id, run_id, match_id, snapshot_version, rule_id, rule_version,
      record_references, evidence, captured_at
    ) values (
      ${organizationId}, ${runId}, ${exactMatchId}, 'artifact-occurrence-v1',
      'refund-accounting', '1.4.0', ${sql.json(refundReferences)},
      ${sql.json(evidenceJson(exactMatchEvidence))},
      '2026-07-29T00:00:02.000Z'
    )
  `;
  await sql`
    insert into exceptions (
      id, organization_id, stable_key, first_run_id, latest_run_id, type, status,
      severity, record_references, evidence, created_at, updated_at
    ) values (
      ${exceptionId}, ${organizationId}, ${exceptionStableKey}, ${runId}, ${runId},
      'duplicate_processing_fee', 'approved', 'high', ${sql.json(feeReferences)},
      ${sql.json(evidenceJson(currentExceptionEvidence))},
      '2026-07-29T00:00:02.000Z', '2026-07-29T01:00:00.000Z'
    )
  `;
  await sql`
    insert into exception_occurrences (
      organization_id, run_id, exception_id, observed_at
    ) values (
      ${organizationId}, ${runId}, ${exceptionId}, '2026-07-29T00:00:02.000Z'
    )
  `;
  await sql`
    insert into exception_occurrence_snapshots (
      organization_id, run_id, exception_id, snapshot_version, type, observed_status, severity,
      record_references, amount_minor, currency, evidence, captured_at
    ) values (
      ${organizationId}, ${runId}, ${exceptionId}, 'artifact-occurrence-v1',
      'duplicate_processing_fee', 'open', 'high', ${sql.json(feeReferences)}, null, null,
      ${sql.json(evidenceJson(observedExceptionEvidence))},
      '2026-07-29T00:00:02.000Z'
    )
  `;

  return { runId, exactMatchId, legacyMatchId, exceptionId };
}

function integrationRuleEvidence(input: {
  readonly ruleId: string;
  readonly reasonCode: string;
  readonly result: "pass" | "fail" | "ambiguous";
  readonly records: readonly {
    readonly id: string;
    readonly version: number;
    readonly contentSha256: string;
  }[];
  readonly evaluatedAt: string;
}): RuleEvidence {
  return {
    ruleId: input.ruleId,
    ruleVersion: "1.4.0",
    ruleSetVersion: "1.4.0",
    sourceRecordIds: input.records.map(({ id }) => id),
    sourceRecordCount: input.records.length,
    evidenceTruncated: false,
    sourceRecordVersions: input.records,
    sourceValues: input.records.map((_, index) => ({ sourceAmount: String(index + 1) })),
    normalizedValues: input.records.map((_, index) => ({
      amountMinor: String(index + 1),
      currency: "USD",
    })),
    toleranceMinor: "0",
    result: input.result,
    reasonCode: input.reasonCode,
    evaluatedAt: input.evaluatedAt,
  };
}

function evidenceJson(value: RuleEvidence): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the PostgreSQL integration suite`);
  return value;
}

function requiredConnection(value: Sql | undefined, name: string): Sql {
  if (!value) throw new Error(`${name} database connection was not initialized`);
  return value;
}

async function ensureLocalTestRoles(sql: Sql): Promise<void> {
  const existing = await sql`
    select rolname from pg_roles
    where rolname in (
      'reconai_migrator',
      'reconai_app',
      'reconai_worker',
      'reconai_maintenance'
    )
  `;
  const names = new Set(
    Array.from(existing, (row: unknown) => {
      if (typeof row !== "object" || row === null) throw new Error("invalid role row");
      const value = (row as Record<string, unknown>)["rolname"];
      if (typeof value !== "string") throw new Error("invalid role name");
      return value;
    }),
  );
  if (!names.has("reconai_migrator")) {
    await sql.unsafe(
      "create role reconai_migrator login password 'local-migrator-only' nosuperuser nocreatedb nocreaterole noinherit",
    );
  }
  if (!names.has("reconai_app")) {
    await sql.unsafe(
      "create role reconai_app login password 'local-app-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
    );
  }
  if (!names.has("reconai_worker")) {
    await sql.unsafe(
      "create role reconai_worker login password 'local-worker-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
    );
  }
  if (!names.has("reconai_maintenance")) {
    await sql.unsafe(
      "create role reconai_maintenance login password 'local-maintenance-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
    );
  }
  await sql.unsafe(
    "grant connect on database reconai to reconai_migrator, reconai_app, reconai_worker, reconai_maintenance",
  );
  await sql.unsafe("grant create, usage on schema public to reconai_migrator");
  await sql.unsafe(
    "grant usage on schema public to reconai_app, reconai_worker, reconai_maintenance",
  );
  await sql.unsafe(`
    alter default privileges for role reconai_migrator in schema public
    grant select, insert, update, delete on tables to reconai_app
  `);
  await sql.unsafe(`
    alter default privileges for role reconai_migrator in schema public
    grant select, insert, update, delete on tables to reconai_worker
  `);
}

async function seedTenant(sql: Sql): Promise<void> {
  await sql`
    insert into organizations (id, name) values
      (${organizationId}, 'Reconciliation Integration Tenant'),
      (${otherOrganizationId}, 'Other Reconciliation Integration Tenant')
  `;
  await sql`
    insert into users (id, issuer, subject, email) values
      (${analystId}, 'https://issuer.example.test', ${`analyst-${analystId}`}, null),
      (${reviewerId}, 'https://issuer.example.test', ${`reviewer-${reviewerId}`}, null),
      (${secondReviewerId}, 'https://issuer.example.test',
        ${`reviewer-${secondReviewerId}`}, null),
      (${ownerId}, 'https://issuer.example.test', ${`owner-${ownerId}`},
        ${`owner-${ownerId}@example.test`})
  `;
  await sql`
    insert into memberships (id, organization_id, user_id, role, status) values
      (${analystMembershipId}, ${organizationId}, ${analystId}, 'analyst', 'active'),
      (${reviewerMembershipId}, ${organizationId}, ${reviewerId}, 'reviewer', 'active'),
      (${secondReviewerMembershipId}, ${organizationId}, ${secondReviewerId},
        'reviewer', 'active'),
      (${ownerMembershipId}, ${organizationId}, ${ownerId}, 'owner', 'active')
  `;
  await sql`
    insert into data_source_connections (
      id, organization_id, provider, external_account_id, status, connector_version
    ) values
      (
        ${connectionId}, ${organizationId}, 'shopify', ${`shopify-${connectionId}`},
        'healthy', 'integration-v1'
      ),
      (
        ${stripeConnectionId}, ${organizationId}, 'stripe', ${`stripe-${stripeConnectionId}`},
        'healthy', 'integration-v1'
      ),
      (
        ${foreignConnectionId}, ${otherOrganizationId}, 'shopify',
        ${`shopify-${foreignConnectionId}`}, 'healthy', 'integration-v1'
      )
  `;
}
