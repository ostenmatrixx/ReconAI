import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";

import { afterAll, describe, expect, it } from "vitest";

import {
  EXCEPTION_FINAL_RESOLUTION_MAXIMUM_AGE_SECONDS,
  PROPOSAL_REVIEW_DECISION_MAXIMUM_AGE_SECONDS,
  PROVIDER_EVENT_FRESHNESS_MAXIMUM_LAG_SECONDS,
  PROVIDER_GAP_REPAIR_MAXIMUM_AGE_SECONDS,
  activeTraceparent,
  activeTraceIds,
  clearExceptionQueueSnapshot,
  clearProviderActiveSyncSnapshot,
  providerNormalizationOutcomeForTerminalCode,
  providerNormalizationSourceForRequestedBy,
  providerSyncTriggerForRequestedBy,
  recordDurableQueueMonitorPoll,
  recordDurableQueueSnapshot,
  recordExceptionFinalResolution,
  recordExceptionQueueObservation,
  recordExceptionQueueObservationFailure,
  recordProviderActiveSyncObservation,
  recordProviderActiveSyncObservationFailure,
  recordProviderCircuitDecision,
  recordProviderCircuitTransition,
  recordProviderEventFreshness,
  recordProviderGapRepairCandidate,
  recordProviderGapRepairScan,
  recordProposalReviewDecision,
  recordReconciliationRunCreationUnavailable,
  resolveOtlpSignalEndpoints,
  startApiRequestObservation,
  startDurableJobObservation,
  startObservability,
  startOutboxRelayBatchObservation,
  startProviderNormalizationObservation,
  startProviderSyncObservation,
  startProviderWebhookIngressObservation,
  startReconciliationRunObservation,
  type ObservabilityRuntime,
  type ProviderNormalizationOutcome,
  type ProviderSyncOutcome,
  type ProviderWebhookIngressSurface,
} from "./index.js";

interface CapturedExport {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

let activeRuntime: ObservabilityRuntime | undefined;
let closeCaptureServer: (() => Promise<void>) | undefined;

afterAll(async () => {
  await activeRuntime?.shutdown();
  await closeCaptureServer?.();
});

describe("OTLP runtime boundary", () => {
  it("derives only the standard OTLP/HTTP protobuf signal paths", () => {
    expect(resolveOtlpSignalEndpoints("https://collector.example.test", true)).toEqual({
      traces: "https://collector.example.test/v1/traces",
      metrics: "https://collector.example.test/v1/metrics",
    });
    expect(() => resolveOtlpSignalEndpoints("http://collector.example.test", true)).toThrow(
      "must use HTTPS",
    );
    for (const endpoint of [
      "ftp://collector.example.test",
      "https://user:password@collector.example.test",
      "https://collector.example.test/custom",
      "https://collector.example.test?token=unsafe",
      "https://collector.example.test#fragment",
    ]) {
      expect(() => resolveOtlpSignalEndpoints(endpoint, false)).toThrow();
    }
  });

  it("is a network-free no-op outside production when no endpoint is configured", async () => {
    const runtime = startObservability({
      environment: "test",
      production: false,
      serviceName: "reconai-disabled-test",
    });
    expect(runtime.enabled).toBe(false);
    await expect(runtime.forceFlush()).resolves.toBeUndefined();
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  it("exports bounded explicit spans and metrics without tenant or payload attributes", async () => {
    const exports: CapturedExport[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        exports.push({
          path: request.url ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks),
        });
        response.writeHead(200, { "content-type": "application/x-protobuf" });
        response.end();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("capture server has no TCP port");
    closeCaptureServer = async () => {
      server.close();
      await once(server, "close");
    };

    activeRuntime = startObservability({
      endpoint: `http://127.0.0.1:${String(address.port)}`,
      environment: "test",
      production: false,
      serviceName: "reconai-observability-test",
      serviceVersion: "test.1",
      traceSampleRatio: 1,
      metricExportIntervalMs: 1_000,
      exportTimeoutMs: 500,
    });

    const traceId = "0123456789abcdef0123456789abcdef";
    const apiObservation = startApiRequestObservation({
      method: "GET",
      route: "/v1/organizations/:organizationId/exceptions",
      traceparent: `00-${traceId}-0123456789abcdef-01`,
    });
    let durableParent: string | undefined;
    const apiTrace = apiObservation.run(() => {
      durableParent = activeTraceparent();
      return activeTraceIds();
    });
    expect(apiTrace).toMatchObject({ traceId });
    expect(durableParent).toBe(`00-${traceId}-${apiTrace.spanId ?? ""}-01`);
    apiObservation.finish(200);

    const rejectedParentObservation = startApiRequestObservation({
      method: "customer-payload-value",
      route: "/v1/organizations/:organizationId/reconciliation-runs",
      traceparent: "organization-secret-value",
    });
    expect(rejectedParentObservation.run(activeTraceIds).traceId).not.toBe(traceId);
    rejectedParentObservation.finish(400);

    const rejectedLabelObservation = startApiRequestObservation({
      method: "credential-token-value",
      route: "/payment-payload-value?credential-token-value",
    });
    rejectedLabelObservation.finish(400);

    const jobObservation = startDurableJobObservation({
      jobType: "reconciliation.run.requested",
      attempt: 2,
      ...(durableParent ? { trustedParentTraceparent: durableParent } : {}),
    });
    let nestedDurableParent: string | undefined;
    const jobTrace = jobObservation.run(() => {
      nestedDurableParent = activeTraceparent();
      return activeTraceIds();
    });
    expect(jobTrace.traceId).toBe(traceId);
    expect(jobTrace.spanId).not.toBe(apiTrace.spanId);
    jobObservation.finish("succeeded");

    const nestedJobObservation = startDurableJobObservation({
      jobType: "connector.webhook.received",
      attempt: 1,
      ...(nestedDurableParent ? { trustedParentTraceparent: nestedDurableParent } : {}),
    });
    const nestedJobTrace = nestedJobObservation.run(activeTraceIds);
    expect(nestedJobTrace.traceId).toBe(traceId);
    expect(nestedJobTrace.spanId).not.toBe(jobTrace.spanId);
    nestedJobObservation.finish("succeeded");

    const reconciliationObservation = startReconciliationRunObservation();
    expect(reconciliationObservation.run(activeTraceIds).traceId).toMatch(/^[0-9a-f]{32}$/u);
    reconciliationObservation.finish("succeeded", {
      input: 4,
      matches: 1,
      exceptions: 2,
      ambiguousCandidates: 1,
    });

    const outboxObservation = startOutboxRelayBatchObservation();
    outboxObservation.finish("succeeded", {
      published: 2,
      retried: 1,
      deadLettered: 1,
    });
    recordReconciliationRunCreationUnavailable("admission_saturated");
    recordReconciliationRunCreationUnavailable("interrupted");
    recordDurableQueueSnapshot({
      counts: {
        waiting: 2,
        paused: 0,
        active: 1,
        delayed: 3,
        prioritized: 0,
        "waiting-children": 0,
        failed: 1,
      },
      readyHeadMaximumAgeSeconds: 12.5,
    });
    recordDurableQueueMonitorPoll("succeeded");
    recordDurableQueueMonitorPoll("failed");
    const ingressCases = [
      ["shopify_connection", 202],
      ["shopify_privacy", 200],
      ["stripe_connection", 401],
      ["stripe_deauthorization", 400],
      ["shopify_connection", 409],
      ["shopify_connection", 429],
      ["stripe_connection", 503],
      ["stripe_connection", 500],
    ] as const;
    for (const [surface, statusCode] of ingressCases) {
      startProviderWebhookIngressObservation(surface).finish(statusCode);
    }
    startProviderWebhookIngressObservation("shopify_connection").finish(undefined, true);
    const normalizationOutcomes = [
      "processed",
      "already_processed",
      "receipt_not_found",
      "authority_mismatch",
      "object_invalid",
      "payload_invalid",
      "event_unsupported",
      "failed_terminal",
      "failed_retryable",
    ] as const;
    for (const [index, outcome] of normalizationOutcomes.entries()) {
      startProviderNormalizationObservation({
        provider: index % 2 === 0 ? "shopify" : "stripe",
        source: index % 3 === 0 ? "webhook" : index % 3 === 1 ? "sync" : "invalid",
      }).finish(outcome);
    }
    expect(providerNormalizationOutcomeForTerminalCode("WEBHOOK_PAYLOAD_INVALID")).toBe(
      "payload_invalid",
    );
    expect(providerNormalizationOutcomeForTerminalCode("CUSTOMER_SUPPLIED_VALUE")).toBe(
      "failed_terminal",
    );
    expect(providerNormalizationSourceForRequestedBy("shopify", "shopify-webhook-ingress")).toBe(
      "webhook",
    );
    expect(providerNormalizationSourceForRequestedBy("stripe", "stripe-sync-worker")).toBe("sync");
    expect(providerNormalizationSourceForRequestedBy("shopify", "customer-payload-secret")).toBe(
      "invalid",
    );
    expect(
      providerNormalizationSourceForRequestedBy("customer-provider-secret", "shopify-sync-worker"),
    ).toBe("invalid");
    startProviderWebhookIngressObservation(
      "customer-webhook-surface-secret" as ProviderWebhookIngressSurface,
    ).finish(202);
    startProviderNormalizationObservation({
      provider: "customer-provider-secret",
      source: "customer-normalization-source-secret",
    }).finish("customer-normalization-outcome-secret" as ProviderNormalizationOutcome);
    for (const [index, outcome] of [
      "succeeded",
      "partial",
      "already_processed",
      "failed_terminal",
      "failed_retryable",
    ].entries()) {
      startProviderSyncObservation({
        provider: index % 2 === 0 ? "shopify" : "stripe",
        trigger: index % 2 === 0 ? "scheduled" : "user_requested",
      }).finish(outcome as ProviderSyncOutcome);
    }
    startProviderSyncObservation({
      provider: "customer-sync-provider-secret",
      trigger: "customer-sync-trigger-secret",
    }).finish("customer-sync-outcome-secret" as ProviderSyncOutcome);
    expect(providerSyncTriggerForRequestedBy("provider-gap-repair-scheduler")).toBe("scheduled");
    expect(providerSyncTriggerForRequestedBy("75000000-0000-4000-8000-000000000001")).toBe(
      "user_requested",
    );
    expect(providerSyncTriggerForRequestedBy("customer-sync-requester-secret")).toBe("invalid");
    for (const outcome of ["closed", "half_open", "open", "probe_busy", "failed", "invalid"]) {
      expect(recordProviderCircuitDecision("stripe", outcome)).toBe(outcome);
    }
    expect(
      recordProviderCircuitDecision(
        "customer-circuit-provider-secret",
        "customer-circuit-decision-secret",
      ),
    ).toBe("invalid");
    for (const outcome of [
      "failure_counted",
      "opened",
      "reopened",
      "closed",
      "stale",
      "failed",
      "invalid",
    ]) {
      expect(recordProviderCircuitTransition("shopify", outcome)).toBe(outcome);
    }
    expect(
      recordProviderCircuitTransition(
        "customer-circuit-provider-secret",
        "customer-circuit-transition-secret",
      ),
    ).toBe("invalid");
    expect(
      recordProviderEventFreshness({
        provider: "shopify",
        source: "webhook",
        sourceTimestamp: "2026-07-29T00:00:00.000Z",
        observedAt: "2026-07-29T00:00:12.500Z",
      }),
    ).toBe("observed");
    expect(
      recordProviderEventFreshness({
        provider: "stripe",
        source: "sync",
        sourceTimestamp: "2026-07-29T00:00:01.000Z",
        observedAt: "2026-07-29T00:00:00.000Z",
      }),
    ).toBe("future_timestamp");
    expect(
      recordProviderEventFreshness({
        provider: "shopify",
        source: "sync",
        sourceTimestamp: "2026-06-28T23:59:59.999Z",
        observedAt: "2026-07-29T00:00:00.000Z",
      }),
    ).toBe("outside_window");
    expect(
      recordProviderEventFreshness({
        provider: "stripe",
        source: "webhook",
        sourceTimestamp: "2026-06-29T00:00:00.000Z",
        observedAt: "2026-07-29T00:00:00.000Z",
      }),
    ).toBe("observed");
    expect(
      recordProviderEventFreshness({
        provider: "customer-freshness-provider-secret",
        source: "customer-freshness-source-secret",
        sourceTimestamp: "customer-freshness-timestamp-secret",
        observedAt: "2026-07-29T00:00:00.000Z",
      }),
    ).toBe("invalid_timestamp");
    expect(PROVIDER_EVENT_FRESHNESS_MAXIMUM_LAG_SECONDS).toBe(2_592_000);
    expect(recordProviderGapRepairScan("succeeded")).toBe("succeeded");
    expect(recordProviderGapRepairScan("failed")).toBe("failed");
    expect(recordProviderGapRepairScan("customer-gap-repair-scan-secret")).toBe("invalid");
    expect(
      recordProviderGapRepairCandidate({
        provider: "shopify",
        freshnessReference: "last_successful_sync",
        disposition: "scheduled",
        ageSeconds: 31_536_000,
      }),
    ).toBe("observed");
    expect(
      recordProviderGapRepairCandidate({
        provider: "stripe",
        freshnessReference: "never_succeeded",
        disposition: "scheduled",
      }),
    ).toBe("never_succeeded");
    expect(
      recordProviderGapRepairCandidate({
        provider: "stripe",
        freshnessReference: "last_successful_sync",
        disposition: "skipped",
        ageSeconds: -1,
      }),
    ).toBe("future_timestamp");
    expect(
      recordProviderGapRepairCandidate({
        provider: "shopify",
        freshnessReference: "last_successful_sync",
        disposition: "skipped",
        ageSeconds: 31_536_000.001,
      }),
    ).toBe("outside_window");
    expect(
      recordProviderGapRepairCandidate({
        provider: "customer-gap-repair-provider-secret",
        freshnessReference: "customer-gap-repair-reference-secret",
        disposition: "customer-gap-repair-disposition-secret",
        ageSeconds: Number.NaN,
      }),
    ).toBe("invalid_age");
    expect(PROVIDER_GAP_REPAIR_MAXIMUM_AGE_SECONDS).toBe(31_536_000);
    expect(
      recordProposalReviewDecision({
        decision: "approve",
        status: "pending",
        proposalCreatedAt: "2026-07-29T00:00:00.000Z",
        decidedAt: "2026-07-29T00:00:10.000Z",
      }),
    ).toBe("observed");
    expect(
      recordProposalReviewDecision({
        decision: "approve",
        status: "approved",
        proposalCreatedAt: "2025-07-29T00:00:00.000Z",
        decidedAt: "2026-07-29T00:00:00.000Z",
      }),
    ).toBe("observed");
    expect(
      recordProposalReviewDecision({
        decision: "reject",
        status: "rejected",
        proposalCreatedAt: "2026-07-29T00:00:01.000Z",
        decidedAt: "2026-07-29T00:00:00.000Z",
      }),
    ).toBe("future_timestamp");
    expect(
      recordProposalReviewDecision({
        decision: "approve",
        status: "approved",
        proposalCreatedAt: "2025-07-28T23:59:59.999Z",
        decidedAt: "2026-07-29T00:00:00.000Z",
      }),
    ).toBe("outside_window");
    expect(
      recordProposalReviewDecision({
        decision: "customer-review-decision-secret",
        status: "customer-review-status-secret",
        proposalCreatedAt: "customer-review-created-secret",
        decidedAt: "2026-07-29T00:00:00.000Z",
      }),
    ).toBe("invalid_timestamp");
    expect(PROPOSAL_REVIEW_DECISION_MAXIMUM_AGE_SECONDS).toBe(31_536_000);
    expect(
      recordExceptionFinalResolution({
        status: "approved",
        exceptionCreatedAt: "2026-07-28T23:59:50.000Z",
        resolvedAt: "2026-07-29T00:00:00.000Z",
      }),
    ).toBe("observed");
    expect(
      recordExceptionFinalResolution({
        status: "approved",
        exceptionCreatedAt: "2025-07-29T00:00:00.000Z",
        resolvedAt: "2026-07-29T00:00:00.000Z",
      }),
    ).toBe("observed");
    expect(
      recordExceptionFinalResolution({
        status: "approved",
        exceptionCreatedAt: "2026-07-29T00:00:01.000Z",
        resolvedAt: "2026-07-29T00:00:00.000Z",
      }),
    ).toBe("future_timestamp");
    expect(
      recordExceptionFinalResolution({
        status: "approved",
        exceptionCreatedAt: "2025-07-28T23:59:59.999Z",
        resolvedAt: "2026-07-29T00:00:00.000Z",
      }),
    ).toBe("outside_window");
    expect(
      recordExceptionFinalResolution({
        status: "approved",
        exceptionCreatedAt: "customer-exception-created-secret",
        resolvedAt: "2026-07-29T00:00:00.000Z",
      }),
    ).toBe("invalid_timestamp");
    expect(
      recordExceptionFinalResolution({
        status: "pending",
        exceptionCreatedAt: "customer-nonfinal-created-secret",
        resolvedAt: "customer-nonfinal-resolved-secret",
      }),
    ).toBe("not_final");
    expect(
      recordExceptionFinalResolution({
        status: "customer-nonfinal-status-secret",
        exceptionCreatedAt: "customer-unknown-status-created-secret",
        resolvedAt: "customer-unknown-status-resolved-secret",
      }),
    ).toBe("not_final");
    expect(EXCEPTION_FINAL_RESOLUTION_MAXIMUM_AGE_SECONDS).toBe(31_536_000);
    expect(recordExceptionQueueObservation({ queueState: "empty" }, 45_000)).toBe("empty");
    expect(
      recordExceptionQueueObservation({ queueState: "nonempty", oldestAgeSeconds: -1 }, 45_000),
    ).toBe("future_timestamp");
    expect(
      recordExceptionQueueObservation(
        {
          queueState: "customer-exception-queue-state-secret",
          oldestAgeSeconds: Number.NaN,
        },
        45_000,
      ),
    ).toBe("invalid_age");
    recordExceptionQueueObservationFailure();
    expect(
      recordExceptionQueueObservation({ queueState: "nonempty", oldestAgeSeconds: 86_400 }, 45_000),
    ).toBe("observed");
    expect(
      recordProviderActiveSyncObservation(
        [
          { provider: "shopify", activityState: "empty" },
          { provider: "stripe", activityState: "empty" },
        ],
        45_000,
      ),
    ).toBe("empty");
    expect(
      recordProviderActiveSyncObservation(
        [
          {
            provider: "shopify",
            activityState: "active",
            syncStatus: "queued",
            oldestAgeSeconds: -1,
          },
          { provider: "stripe", activityState: "empty" },
        ],
        45_000,
      ),
    ).toBe("future_timestamp");
    expect(
      recordProviderActiveSyncObservation(
        [
          {
            provider: "customer-active-sync-provider-secret",
            activityState: "active",
            syncStatus: "customer-active-sync-status-secret",
            oldestAgeSeconds: Number.NaN,
          },
          { provider: "stripe", activityState: "empty" },
        ],
        45_000,
      ),
    ).toBe("invalid_age");
    recordProviderActiveSyncObservationFailure();
    expect(
      recordProviderActiveSyncObservation(
        [
          {
            provider: "shopify",
            activityState: "active",
            syncStatus: "queued",
            oldestAgeSeconds: 7_200,
          },
          {
            provider: "stripe",
            activityState: "active",
            syncStatus: "running",
            oldestAgeSeconds: 3_600,
          },
        ],
        45_000,
      ),
    ).toBe("observed");

    await activeRuntime.forceFlush();

    const traceExport = exports.find((entry) => entry.path === "/v1/traces");
    const metricExport = exports.find((entry) => entry.path === "/v1/metrics");
    expect(traceExport?.headers["content-type"]).toContain("application/x-protobuf");
    expect(metricExport?.headers["content-type"]).toContain("application/x-protobuf");
    expect(traceExport?.body.byteLength).toBeGreaterThan(0);
    expect(metricExport?.body.byteLength).toBeGreaterThan(0);

    const serialized = Buffer.concat(exports.map((entry) => entry.body)).toString("latin1");
    expect(serialized).toContain("reconai-observability-test");
    expect(serialized).toContain("reconai.api.server.requests");
    expect(serialized).toContain("reconai.worker.jobs");
    expect(serialized).toContain("reconai.reconciliation.runs");
    expect(serialized).toContain("reconai.reconciliation.results");
    expect(serialized).toContain("reconai.reconciliation.run_creation.unavailable");
    expect(serialized).toContain("admission_saturated");
    expect(serialized).toContain("interrupted");
    expect(serialized).toContain("reconai.outbox.events");
    expect(serialized).toContain("reconai.queue.jobs");
    expect(serialized).toContain("reconai.queue.ready_head.maximum_age");
    expect(serialized).toContain("reconai.queue.monitor.polls");
    expect(serialized).toContain("reconai.provider.webhook.ingress.requests");
    expect(serialized).toContain("reconai.provider.normalization.runs");
    expect(serialized).toContain("reconai.provider.normalization.duration");
    expect(serialized).toContain("reconai.provider.sync.runs");
    expect(serialized).toContain("reconai.provider.sync.duration");
    expect(serialized).toContain("reconai.provider.circuit.decisions");
    expect(serialized).toContain("reconai.provider.circuit.transitions");
    expect(serialized).toContain("reconai.provider.event.freshness.samples");
    expect(serialized).toContain("reconai.provider.event.source_lag");
    expect(serialized).toContain("reconai.provider.gap_repair.scans");
    expect(serialized).toContain("reconai.provider.gap_repair.candidates");
    expect(serialized).toContain("reconai.provider.gap_repair.last_successful_sync_age");
    expect(serialized).toContain("reconai.review.proposal_decision.samples");
    expect(serialized).toContain("reconai.review.proposal_decision.age");
    expect(serialized).toContain("reconai.review.exception_final_resolution.samples");
    expect(serialized).toContain("reconai.review.exception_final_resolution.age");
    expect(serialized).toContain("reconai.review.exception_queue.monitor.polls");
    expect(serialized).toContain("reconai.review.exception_queue.has_unresolved");
    expect(serialized).toContain("reconai.review.exception_queue.oldest_age");
    expect(serialized).toContain("reconai.provider.sync.active.monitor.polls");
    expect(serialized).toContain("reconai.provider.sync.active.has_active");
    expect(serialized).toContain("reconai.provider.sync.active.oldest_age");
    for (const value of [
      "shopify_connection",
      "shopify_privacy",
      "stripe_connection",
      "stripe_deauthorization",
      "accepted",
      "duplicate",
      "authentication_failed",
      "validation_failed",
      "evidence_conflict",
      "rate_limited",
      "dispatch_unavailable",
      "failed",
      "aborted",
      "processed",
      "already_processed",
      "receipt_not_found",
      "authority_mismatch",
      "object_invalid",
      "payload_invalid",
      "event_unsupported",
      "failed_terminal",
      "failed_retryable",
      "partial",
      "user_requested",
      "half_open",
      "probe_busy",
      "failure_counted",
      "opened",
      "reopened",
      "stale",
      "observed",
      "future_timestamp",
      "outside_window",
      "invalid_timestamp",
      "last_successful_sync",
      "never_succeeded",
      "scheduled",
      "skipped",
      "invalid_age",
      "approve",
      "reject",
      "pending",
      "approved",
      "rejected",
      "empty",
      "invalid_age",
    ]) {
      expect(serialized).toContain(value);
    }
    for (const state of [
      "waiting",
      "paused",
      "active",
      "delayed",
      "prioritized",
      "waiting-children",
      "failed",
    ]) {
      expect(serialized).toContain(state);
    }
    expect(serialized).not.toContain("organization-secret-value");
    expect(serialized).not.toContain("customer-payload-value");
    expect(serialized).not.toContain("credential-token-value");
    expect(serialized).not.toContain("payment-payload-value");
    expect(serialized).not.toContain("customer-webhook-surface-secret");
    expect(serialized).not.toContain("customer-provider-secret");
    expect(serialized).not.toContain("customer-normalization-source-secret");
    expect(serialized).not.toContain("customer-normalization-outcome-secret");
    expect(serialized).not.toContain("customer-sync-provider-secret");
    expect(serialized).not.toContain("customer-sync-trigger-secret");
    expect(serialized).not.toContain("customer-sync-outcome-secret");
    expect(serialized).not.toContain("customer-sync-requester-secret");
    expect(serialized).not.toContain("customer-circuit-provider-secret");
    expect(serialized).not.toContain("customer-circuit-decision-secret");
    expect(serialized).not.toContain("customer-circuit-transition-secret");
    expect(serialized).not.toContain("customer-freshness-provider-secret");
    expect(serialized).not.toContain("customer-freshness-source-secret");
    expect(serialized).not.toContain("customer-freshness-timestamp-secret");
    expect(serialized).not.toContain("customer-gap-repair-scan-secret");
    expect(serialized).not.toContain("customer-gap-repair-provider-secret");
    expect(serialized).not.toContain("customer-gap-repair-reference-secret");
    expect(serialized).not.toContain("customer-gap-repair-disposition-secret");
    expect(serialized).not.toContain("customer-review-decision-secret");
    expect(serialized).not.toContain("customer-review-status-secret");
    expect(serialized).not.toContain("customer-review-created-secret");
    expect(serialized).not.toContain("customer-exception-created-secret");
    expect(serialized).not.toContain("customer-nonfinal-created-secret");
    expect(serialized).not.toContain("customer-nonfinal-resolved-secret");
    expect(serialized).not.toContain("customer-nonfinal-status-secret");
    expect(serialized).not.toContain("customer-unknown-status-created-secret");
    expect(serialized).not.toContain("customer-unknown-status-resolved-secret");
    expect(serialized).not.toContain("customer-exception-queue-state-secret");
    expect(serialized).not.toContain("customer-active-sync-provider-secret");
    expect(serialized).not.toContain("customer-active-sync-status-secret");
    clearExceptionQueueSnapshot();
    clearProviderActiveSyncSnapshot();
  });
});
