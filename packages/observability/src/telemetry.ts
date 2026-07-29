import {
  context,
  metrics,
  propagation,
  isSpanContextValid,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Span,
  type SpanContext,
} from "@opentelemetry/api";

import { OPERATIONAL_ALERT_METRICS } from "./metric-contract.js";

const instrumentationVersion = "1.0.0";
export const PROVIDER_EVENT_FRESHNESS_MAXIMUM_LAG_SECONDS = 30 * 24 * 60 * 60;
export const PROVIDER_GAP_REPAIR_MAXIMUM_AGE_SECONDS = 365 * 24 * 60 * 60;
export const PROPOSAL_REVIEW_DECISION_MAXIMUM_AGE_SECONDS = 365 * 24 * 60 * 60;
export const EXCEPTION_FINAL_RESOLUTION_MAXIMUM_AGE_SECONDS = 365 * 24 * 60 * 60;
const tracer = trace.getTracer("reconai.operations", instrumentationVersion);
const durableQueueStates = [
  "waiting",
  "paused",
  "active",
  "delayed",
  "prioritized",
  "waiting-children",
  "failed",
] as const satisfies readonly DurableQueueState[];
const providerTelemetryNames = [
  "shopify",
  "stripe",
] as const satisfies readonly ProviderTelemetryName[];
let currentDurableQueueSnapshot:
  | {
      readonly snapshot: DurableQueueSnapshot;
      readonly expiresAtMonotonicMs: number;
    }
  | undefined;
let currentExceptionQueueSnapshot:
  | {
      readonly snapshot: ExceptionQueueSnapshot;
      readonly expiresAtMonotonicMs: number;
    }
  | undefined;
let currentProviderActiveSyncSnapshot:
  | {
      readonly snapshot: ProviderActiveSyncSnapshot;
      readonly expiresAtMonotonicMs: number;
    }
  | undefined;
let instruments = createInstruments();

const allowedMethods = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const allowedJobTypes = new Set<DurableJobTelemetryType>([
  "connector.webhook.received",
  "csv.import.commit",
  "connector.sync.requested",
  "reconciliation.run.requested",
  "invalid",
]);
const allowedProviderNormalizationOutcomes = new Set<ProviderNormalizationOutcome>([
  "processed",
  "already_processed",
  "receipt_not_found",
  "authority_mismatch",
  "object_invalid",
  "payload_invalid",
  "event_unsupported",
  "failed_terminal",
  "failed_retryable",
]);
const allowedProviderSyncOutcomes = new Set<ProviderSyncOutcome>([
  "succeeded",
  "partial",
  "already_processed",
  "failed_retryable",
  "failed_terminal",
]);
const allowedProviderCircuitDecisions = new Set<ProviderCircuitDecisionOutcome>([
  "closed",
  "half_open",
  "open",
  "probe_busy",
  "failed",
  "invalid",
]);
const allowedProviderCircuitTransitions = new Set<ProviderCircuitTransitionOutcome>([
  "failure_counted",
  "opened",
  "reopened",
  "closed",
  "stale",
  "failed",
  "invalid",
]);

export type ApiRequestOutcome = "success" | "client_error" | "server_error" | "aborted";
export type DurableJobTelemetryType =
  | "connector.webhook.received"
  | "csv.import.commit"
  | "connector.sync.requested"
  | "reconciliation.run.requested"
  | "invalid";
export type DurableJobOutcome =
  | "succeeded"
  | "skipped"
  | "rejected"
  | "busy"
  | "dead_lettered"
  | "failed_retryable"
  | "failed_terminal";
export type ReconciliationRunOutcome =
  "succeeded" | "already_completed" | "failed_retryable" | "failed_terminal";
export type ReconciliationRunCreationUnavailableReason = "admission_saturated" | "interrupted";
export type ProviderTelemetryName = "shopify" | "stripe";
export type ProviderWebhookIngressSurface =
  "shopify_connection" | "shopify_privacy" | "stripe_connection" | "stripe_deauthorization";
export type ProviderWebhookIngressOutcome =
  | "accepted"
  | "duplicate"
  | "authentication_failed"
  | "validation_failed"
  | "evidence_conflict"
  | "dispatch_unavailable"
  | "rate_limited"
  | "failed"
  | "aborted";
export type ProviderNormalizationSource = "webhook" | "sync" | "invalid";
export type ProviderNormalizationOutcome =
  | "processed"
  | "already_processed"
  | "receipt_not_found"
  | "authority_mismatch"
  | "object_invalid"
  | "payload_invalid"
  | "event_unsupported"
  | "failed_terminal"
  | "failed_retryable";
export type ProviderSyncTrigger = "scheduled" | "user_requested" | "invalid";
export type ProviderSyncOutcome =
  "succeeded" | "partial" | "already_processed" | "failed_retryable" | "failed_terminal";
export type ProviderCircuitDecisionOutcome =
  "closed" | "half_open" | "open" | "probe_busy" | "failed" | "invalid";
export type ProviderCircuitTransitionOutcome =
  "failure_counted" | "opened" | "reopened" | "closed" | "stale" | "failed" | "invalid";
export type ProviderEventFreshnessOutcome =
  "observed" | "future_timestamp" | "outside_window" | "invalid_timestamp";
export type ProviderGapRepairScanOutcome = "succeeded" | "failed" | "invalid";
export type ProviderGapRepairFreshnessReference =
  "last_successful_sync" | "never_succeeded" | "invalid";
export type ProviderGapRepairDisposition = "scheduled" | "skipped" | "invalid";
export type ProviderGapRepairAgeOutcome =
  "observed" | "future_timestamp" | "outside_window" | "never_succeeded" | "invalid_age";
export type ProposalReviewDecision = "approve" | "reject";
export type ProposalReviewStatus = "pending" | "approved" | "rejected";
export type ProposalReviewTimingOutcome = ProviderEventFreshnessOutcome;
export type ExceptionFinalResolutionTimingOutcome = ProposalReviewTimingOutcome | "not_final";
export type DurableQueueState =
  "waiting" | "paused" | "active" | "delayed" | "prioritized" | "waiting-children" | "failed";
export type DurableQueueMonitorOutcome = "succeeded" | "failed";
export type ExceptionQueueObservationOutcome =
  "empty" | "observed" | "future_timestamp" | "invalid_age" | "failed";
export type ProviderActiveSyncObservationOutcome = ExceptionQueueObservationOutcome;
export type ProviderActiveSyncStatus = "queued" | "running";

export interface DurableQueueSnapshot {
  readonly counts: Readonly<Record<DurableQueueState, number>>;
  /**
   * Maximum creation age, in seconds, among the next dispatchable waiting, paused, and prioritized
   * list heads. This is deliberately a constant-size queue-frontier observation, not a full scan.
   */
  readonly readyHeadMaximumAgeSeconds: number;
}

export interface ExceptionQueueSnapshot {
  readonly hasUnresolved: 0 | 1;
  readonly oldestAgeSeconds: number;
}

export type ProviderActiveSyncSnapshotValue =
  | { readonly hasActive: 0 }
  | {
      readonly hasActive: 1;
      readonly syncStatus: ProviderActiveSyncStatus;
      readonly oldestAgeSeconds: number;
    };

export interface ProviderActiveSyncSnapshot {
  readonly providers: Readonly<Record<ProviderTelemetryName, ProviderActiveSyncSnapshotValue>>;
}

export interface ProviderActiveSyncObservationInput {
  readonly provider: string;
  readonly activityState: string;
  readonly syncStatus?: string;
  readonly oldestAgeSeconds?: number;
}

export interface ReconciliationRunCounts {
  readonly input: number;
  readonly matches: number;
  readonly exceptions: number;
  readonly ambiguousCandidates: number;
}

export interface ApiRequestObservation {
  run<T>(operation: () => T): T;
  finish(statusCode: number | undefined, aborted?: boolean): void;
}

export interface DurableJobObservation {
  run<T>(operation: () => T): T;
  finish(outcome: DurableJobOutcome): void;
}

export interface ReconciliationRunObservation {
  run<T>(operation: () => T): T;
  finish(outcome: ReconciliationRunOutcome, counts?: ReconciliationRunCounts): void;
}

export interface OutboxRelayBatchObservation {
  finish(
    outcome: "succeeded" | "failed",
    counts?: {
      readonly published: number;
      readonly retried: number;
      readonly deadLettered: number;
    },
  ): void;
}

export interface ProviderWebhookIngressObservation {
  finish(statusCode: number | undefined, aborted?: boolean): void;
}

export interface ProviderNormalizationObservation {
  finish(outcome: ProviderNormalizationOutcome): void;
}

export interface ProviderSyncObservation {
  finish(outcome: ProviderSyncOutcome): void;
}

/** @internal Refreshes instruments after the process-global SDK is registered. */
export function initializeRegisteredTelemetry(): void {
  instruments = createInstruments();
}

export function startApiRequestObservation(input: {
  readonly method: string;
  readonly route?: string;
  readonly traceparent?: string;
}): ApiRequestObservation {
  const method = allowedMethods.has(input.method) ? input.method : "OTHER";
  const route = normalizedRoute(input.route);
  const parentContext = propagation.extract(context.active(), traceCarrier(input));
  const span = tracer.startSpan(
    `${method} ${route}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": method,
        "http.route": route,
      },
    },
    parentContext,
  );
  const spanContext = trace.setSpan(parentContext, span);
  const startedAt = performance.now();
  let finished = false;
  return {
    run: <T>(operation: () => T): T => context.with(spanContext, operation),
    finish: (statusCode, aborted = false) => {
      if (finished) return;
      finished = true;
      const outcome = apiOutcome(statusCode, aborted);
      const attributes = {
        "http.request.method": method,
        "http.route": route,
        "reconai.outcome": outcome,
      };
      instruments.apiRequestCount.add(1, attributes);
      instruments.apiRequestDuration.record(Math.max(0, performance.now() - startedAt), attributes);
      span.setAttribute("reconai.outcome", outcome);
      if (statusCode !== undefined) span.setAttribute("http.response.status_code", statusCode);
      if (outcome === "server_error" || outcome === "aborted") {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end();
    },
  };
}

export function startDurableJobObservation(input: {
  readonly jobType: DurableJobTelemetryType;
  readonly attempt: number;
  /**
   * A locally generated context loaded from exact durable outbox authority. Never pass a raw
   * inbound header or queue field before authority verification.
   */
  readonly trustedParentTraceparent?: string;
}): DurableJobObservation {
  const jobType = allowedJobTypes.has(input.jobType) ? input.jobType : "invalid";
  const attempt =
    Number.isSafeInteger(input.attempt) && input.attempt >= 1 && input.attempt <= 100
      ? input.attempt
      : 1;
  const parentContext = trustedParentContext(input.trustedParentTraceparent);
  const span = tracer.startSpan(
    `durable_job ${jobType}`,
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        "reconai.job.type": jobType,
        "reconai.job.attempt": attempt,
      },
    },
    parentContext,
  );
  const spanContext = trace.setSpan(parentContext, span);
  const startedAt = performance.now();
  let finished = false;
  return {
    run: <T>(operation: () => T): T => context.with(spanContext, operation),
    finish: (outcome) => {
      if (finished) return;
      finished = true;
      const attributes = {
        "reconai.job.type": jobType,
        "reconai.outcome": outcome,
      };
      instruments.durableJobCount.add(1, attributes);
      instruments.durableJobDuration.record(Math.max(0, performance.now() - startedAt), attributes);
      span.setAttribute("reconai.outcome", outcome);
      if (
        outcome === "rejected" ||
        outcome === "busy" ||
        outcome === "dead_lettered" ||
        outcome === "failed_retryable" ||
        outcome === "failed_terminal"
      ) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end();
    },
  };
}

export function startReconciliationRunObservation(): ReconciliationRunObservation {
  const span = tracer.startSpan("reconciliation_run", {
    kind: SpanKind.INTERNAL,
  });
  const spanContext = trace.setSpan(context.active(), span);
  const startedAt = performance.now();
  let finished = false;
  return {
    run: <T>(operation: () => T): T => context.with(spanContext, operation),
    finish: (outcome, counts) => {
      if (finished) return;
      finished = true;
      const attributes = { "reconai.outcome": outcome };
      instruments.reconciliationRunCount.add(1, attributes);
      instruments.reconciliationRunDuration.record(
        Math.max(0, performance.now() - startedAt),
        attributes,
      );
      span.setAttribute("reconai.outcome", outcome);
      if (counts) {
        recordReconciliationCounts(counts, span);
      }
      if (outcome === "failed_retryable" || outcome === "failed_terminal") {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end();
    },
  };
}

export function startOutboxRelayBatchObservation(): OutboxRelayBatchObservation {
  const startedAt = performance.now();
  let finished = false;
  return {
    finish: (outcome, counts) => {
      if (finished) return;
      finished = true;
      const attributes = { "reconai.outcome": outcome };
      instruments.outboxBatchCount.add(1, attributes);
      instruments.outboxBatchDuration.record(
        Math.max(0, performance.now() - startedAt),
        attributes,
      );
      if (!counts) return;
      recordOutboxCount("published", counts.published);
      recordOutboxCount("retried", counts.retried);
      recordOutboxCount("dead_lettered", counts.deadLettered);
    },
  };
}

export function startProviderWebhookIngressObservation(
  surface: ProviderWebhookIngressSurface,
): ProviderWebhookIngressObservation {
  const provider = providerForWebhookSurface(surface);
  let finished = false;
  return {
    finish: (statusCode, aborted = false) => {
      if (finished) return;
      finished = true;
      if (!provider) return;
      instruments.providerWebhookIngressCount.add(1, {
        "reconai.provider": provider,
        "reconai.provider.webhook.surface": surface,
        "reconai.outcome": providerWebhookIngressOutcome(statusCode, aborted),
      });
    },
  };
}

export function startProviderNormalizationObservation(input: {
  readonly provider: string;
  readonly source: string;
}): ProviderNormalizationObservation {
  const provider = providerTelemetryValue(input.provider);
  const source = providerNormalizationSourceTelemetryValue(input.source);
  const startedAt = performance.now();
  let finished = false;
  return {
    finish: (requestedOutcome) => {
      if (finished) return;
      finished = true;
      const outcome = allowedProviderNormalizationOutcomes.has(requestedOutcome)
        ? requestedOutcome
        : "failed_terminal";
      const attributes = {
        "reconai.provider": provider,
        "reconai.provider.normalization.source": source,
        "reconai.outcome": outcome,
      };
      instruments.providerNormalizationCount.add(1, attributes);
      instruments.providerNormalizationDuration.record(
        Math.max(0, performance.now() - startedAt),
        attributes,
      );
    },
  };
}

export function startProviderSyncObservation(input: {
  readonly provider: string;
  readonly trigger: string;
}): ProviderSyncObservation {
  const provider = providerTelemetryValue(input.provider);
  const trigger: ProviderSyncTrigger =
    input.trigger === "scheduled" || input.trigger === "user_requested" ? input.trigger : "invalid";
  const startedAt = performance.now();
  let finished = false;
  return {
    finish: (requestedOutcome) => {
      if (finished) return;
      finished = true;
      const outcome = allowedProviderSyncOutcomes.has(requestedOutcome)
        ? requestedOutcome
        : "failed_terminal";
      const attributes = {
        "reconai.provider": provider,
        "reconai.provider.sync.trigger": trigger,
        "reconai.outcome": outcome,
      };
      instruments.providerSyncCount.add(1, attributes);
      instruments.providerSyncDuration.record(
        Math.max(0, performance.now() - startedAt),
        attributes,
      );
    },
  };
}

export function providerSyncTriggerForRequestedBy(requestedBy: string): ProviderSyncTrigger {
  if (requestedBy === "provider-gap-repair-scheduler") return "scheduled";
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(requestedBy)
  ) {
    return "user_requested";
  }
  return "invalid";
}

export function recordProviderCircuitDecision(
  requestedProvider: string,
  requestedOutcome: string,
): ProviderCircuitDecisionOutcome {
  const provider = providerTelemetryValue(requestedProvider);
  const outcome = allowedProviderCircuitDecisions.has(
    requestedOutcome as ProviderCircuitDecisionOutcome,
  )
    ? (requestedOutcome as ProviderCircuitDecisionOutcome)
    : "invalid";
  instruments.providerCircuitDecisions.add(1, {
    "reconai.provider": provider,
    "reconai.outcome": outcome,
  });
  return outcome;
}

export function recordProviderCircuitTransition(
  requestedProvider: string,
  requestedOutcome: string,
): ProviderCircuitTransitionOutcome {
  const provider = providerTelemetryValue(requestedProvider);
  const outcome = allowedProviderCircuitTransitions.has(
    requestedOutcome as ProviderCircuitTransitionOutcome,
  )
    ? (requestedOutcome as ProviderCircuitTransitionOutcome)
    : "invalid";
  instruments.providerCircuitTransitions.add(1, {
    "reconai.provider": provider,
    "reconai.outcome": outcome,
  });
  return outcome;
}

export function providerNormalizationSourceForRequestedBy(
  provider: string,
  requestedBy: string,
): ProviderNormalizationSource {
  if (provider !== "shopify" && provider !== "stripe") {
    return "invalid";
  }

  if (requestedBy === `${provider}-webhook-ingress`) {
    return "webhook";
  }

  if (requestedBy === `${provider}-sync-worker`) {
    return "sync";
  }

  return "invalid";
}

export function providerNormalizationOutcomeForTerminalCode(
  code: string,
): ProviderNormalizationOutcome {
  switch (code) {
    case "WEBHOOK_NOT_FOUND":
      return "receipt_not_found";
    case "WEBHOOK_AUTHORITY_MISMATCH":
      return "authority_mismatch";
    case "WEBHOOK_OBJECT_INVALID":
      return "object_invalid";
    case "WEBHOOK_PAYLOAD_INVALID":
      return "payload_invalid";
    case "WEBHOOK_EVENT_UNSUPPORTED":
      return "event_unsupported";
    default:
      return "failed_terminal";
  }
}

export function recordProviderEventFreshness(input: {
  readonly provider: string;
  readonly source: string;
  readonly sourceTimestamp: string;
  readonly observedAt?: string;
}): ProviderEventFreshnessOutcome {
  const provider = providerTelemetryValue(input.provider);
  const source = providerNormalizationSourceTelemetryValue(input.source);
  const timing = classifyBoundedTiming(
    input.sourceTimestamp,
    input.observedAt,
    PROVIDER_EVENT_FRESHNESS_MAXIMUM_LAG_SECONDS,
  );

  const attributes = {
    "reconai.provider": provider,
    "reconai.provider.event.source": source,
  };
  instruments.providerEventFreshnessSamples.add(1, {
    ...attributes,
    "reconai.outcome": timing.outcome,
  });
  if (timing.outcome === "observed" && timing.valueSeconds !== undefined) {
    instruments.providerEventSourceLag.record(timing.valueSeconds, attributes);
  }
  return timing.outcome;
}

export function recordProviderGapRepairScan(outcome: string): ProviderGapRepairScanOutcome {
  const normalized =
    outcome === "succeeded" || outcome === "failed" ? outcome : ("invalid" as const);
  instruments.providerGapRepairScans.add(1, { "reconai.outcome": normalized });
  return normalized;
}

export function recordProviderGapRepairCandidate(input: {
  readonly provider: string;
  readonly freshnessReference: string;
  readonly disposition: string;
  readonly ageSeconds?: number;
}): ProviderGapRepairAgeOutcome {
  const provider = providerTelemetryValue(input.provider);
  const freshnessReference: ProviderGapRepairFreshnessReference =
    input.freshnessReference === "last_successful_sync" ||
    input.freshnessReference === "never_succeeded"
      ? input.freshnessReference
      : "invalid";
  const disposition: ProviderGapRepairDisposition =
    input.disposition === "scheduled" || input.disposition === "skipped"
      ? input.disposition
      : "invalid";
  const ageOutcome = classifyProviderGapRepairAge(freshnessReference, input.ageSeconds);
  const attributes = {
    "reconai.provider": provider,
    "reconai.provider.connection.freshness_reference": freshnessReference,
    "reconai.provider.gap_repair.disposition": disposition,
  };
  instruments.providerGapRepairCandidates.add(1, {
    ...attributes,
    "reconai.outcome": ageOutcome,
  });
  if (ageOutcome === "observed" && input.ageSeconds !== undefined) {
    instruments.providerGapRepairLastSuccessfulSyncAge.record(input.ageSeconds, {
      "reconai.provider": provider,
      "reconai.provider.gap_repair.disposition": disposition,
    });
  }
  return ageOutcome;
}

export function recordProposalReviewDecision(input: {
  readonly decision: string;
  readonly status: string;
  readonly proposalCreatedAt: string;
  readonly decidedAt?: string;
}): ProposalReviewTimingOutcome {
  const decision =
    input.decision === "approve" || input.decision === "reject" ? input.decision : "invalid";
  const status =
    (decision === "approve" && (input.status === "pending" || input.status === "approved")) ||
    (decision === "reject" && input.status === "rejected")
      ? input.status
      : "invalid";
  const timing = classifyBoundedTiming(
    input.proposalCreatedAt,
    input.decidedAt,
    PROPOSAL_REVIEW_DECISION_MAXIMUM_AGE_SECONDS,
  );
  const attributes = {
    "reconai.review.decision": decision,
    "reconai.review.proposal.status": status,
  };
  instruments.proposalReviewDecisionSamples.add(1, {
    ...attributes,
    "reconai.outcome": timing.outcome,
  });
  if (timing.outcome === "observed" && timing.valueSeconds !== undefined) {
    instruments.proposalReviewDecisionAge.record(timing.valueSeconds, attributes);
  }
  return timing.outcome;
}

export function recordExceptionFinalResolution(input: {
  readonly status: string;
  readonly exceptionCreatedAt: string;
  readonly resolvedAt?: string;
}): ExceptionFinalResolutionTimingOutcome {
  if (input.status !== "approved") return "not_final";
  const timing = classifyBoundedTiming(
    input.exceptionCreatedAt,
    input.resolvedAt,
    EXCEPTION_FINAL_RESOLUTION_MAXIMUM_AGE_SECONDS,
  );
  instruments.exceptionFinalResolutionSamples.add(1, {
    "reconai.outcome": timing.outcome,
  });
  if (timing.outcome === "observed" && timing.valueSeconds !== undefined) {
    instruments.exceptionFinalResolutionAge.record(timing.valueSeconds);
  }
  return timing.outcome;
}

export function recordReconciliationRunCreationUnavailable(
  reason: ReconciliationRunCreationUnavailableReason,
): void {
  instruments.reconciliationRunCreationUnavailableCount.add(1, {
    "reconai.reason": reason,
  });
}

export function recordDurableQueueSnapshot(
  snapshot: DurableQueueSnapshot,
  validForMs = 60_000,
): void {
  currentDurableQueueSnapshot = undefined;
  const safeCounts: (readonly [DurableQueueState, number])[] = [];
  for (const state of durableQueueStates) {
    const count = safeMetricCount(snapshot.counts[state]);
    if (count === undefined) return;
    safeCounts.push([state, count]);
  }
  const readyHeadMaximumAgeSeconds = safeMetricValue(snapshot.readyHeadMaximumAgeSeconds);
  if (readyHeadMaximumAgeSeconds === undefined) return;
  if (!Number.isSafeInteger(validForMs) || validForMs < 1_000 || validForMs > 900_000) {
    return;
  }
  currentDurableQueueSnapshot = {
    snapshot: {
      counts: Object.fromEntries(safeCounts) as Record<DurableQueueState, number>,
      readyHeadMaximumAgeSeconds,
    },
    expiresAtMonotonicMs: performance.now() + validForMs,
  };
}

export function clearDurableQueueSnapshot(): void {
  currentDurableQueueSnapshot = undefined;
}

export function recordDurableQueueMonitorPoll(outcome: DurableQueueMonitorOutcome): void {
  instruments.durableQueueMonitorPolls.add(1, { "reconai.outcome": outcome });
}

export function recordExceptionQueueObservation(
  input: {
    readonly queueState: string;
    readonly oldestAgeSeconds?: number;
  },
  validForMs = 60_000,
): ExceptionQueueObservationOutcome {
  currentExceptionQueueSnapshot = undefined;
  let outcome: ExceptionQueueObservationOutcome;
  let snapshot: ExceptionQueueSnapshot | undefined;
  if (input.queueState === "empty" && input.oldestAgeSeconds === undefined) {
    outcome = "empty";
    snapshot = { hasUnresolved: 0, oldestAgeSeconds: 0 };
  } else if (
    input.queueState === "nonempty" &&
    input.oldestAgeSeconds !== undefined &&
    Number.isFinite(input.oldestAgeSeconds)
  ) {
    if (input.oldestAgeSeconds < 0) {
      outcome = "future_timestamp";
    } else {
      outcome = "observed";
      snapshot = { hasUnresolved: 1, oldestAgeSeconds: input.oldestAgeSeconds };
    }
  } else {
    outcome = "invalid_age";
  }
  if (!Number.isSafeInteger(validForMs) || validForMs < 1_000 || validForMs > 900_000) {
    outcome = "invalid_age";
    snapshot = undefined;
  }
  instruments.exceptionQueueMonitorPolls.add(1, { "reconai.outcome": outcome });
  if (snapshot) {
    currentExceptionQueueSnapshot = {
      snapshot,
      expiresAtMonotonicMs: performance.now() + validForMs,
    };
  }
  return outcome;
}

export function recordExceptionQueueObservationFailure(): void {
  currentExceptionQueueSnapshot = undefined;
  instruments.exceptionQueueMonitorPolls.add(1, { "reconai.outcome": "failed" });
}

export function clearExceptionQueueSnapshot(): void {
  currentExceptionQueueSnapshot = undefined;
}

export function recordProviderActiveSyncObservation(
  input: readonly ProviderActiveSyncObservationInput[],
  validForMs = 60_000,
): ProviderActiveSyncObservationOutcome {
  currentProviderActiveSyncSnapshot = undefined;
  const parsed: Partial<Record<ProviderTelemetryName, ProviderActiveSyncSnapshotValue>> = {};
  let outcome: ProviderActiveSyncObservationOutcome = "empty";
  if (
    input.length !== providerTelemetryNames.length ||
    !Number.isSafeInteger(validForMs) ||
    validForMs < 1_000 ||
    validForMs > 900_000
  ) {
    outcome = "invalid_age";
  } else {
    for (const [index, expectedProvider] of providerTelemetryNames.entries()) {
      const observation = input[index];
      if (observation?.provider !== expectedProvider) {
        outcome = "invalid_age";
        break;
      }
      if (
        observation.activityState === "empty" &&
        observation.syncStatus === undefined &&
        observation.oldestAgeSeconds === undefined
      ) {
        parsed[expectedProvider] = { hasActive: 0 };
        continue;
      }
      if (
        observation.activityState !== "active" ||
        (observation.syncStatus !== "queued" && observation.syncStatus !== "running") ||
        observation.oldestAgeSeconds === undefined ||
        !Number.isFinite(observation.oldestAgeSeconds)
      ) {
        outcome = "invalid_age";
        break;
      }
      if (observation.oldestAgeSeconds < 0) {
        outcome = "future_timestamp";
        break;
      }
      parsed[expectedProvider] = {
        hasActive: 1,
        syncStatus: observation.syncStatus,
        oldestAgeSeconds: observation.oldestAgeSeconds,
      };
      outcome = "observed";
    }
  }
  const shopify = parsed.shopify;
  const stripe = parsed.stripe;
  if (
    (outcome === "empty" || outcome === "observed") &&
    shopify !== undefined &&
    stripe !== undefined
  ) {
    currentProviderActiveSyncSnapshot = {
      snapshot: { providers: { shopify, stripe } },
      expiresAtMonotonicMs: performance.now() + validForMs,
    };
  } else if (outcome === "empty" || outcome === "observed") {
    outcome = "invalid_age";
  }
  instruments.providerActiveSyncMonitorPolls.add(1, { "reconai.outcome": outcome });
  return outcome;
}

export function recordProviderActiveSyncObservationFailure(): void {
  currentProviderActiveSyncSnapshot = undefined;
  instruments.providerActiveSyncMonitorPolls.add(1, { "reconai.outcome": "failed" });
}

export function clearProviderActiveSyncSnapshot(): void {
  currentProviderActiveSyncSnapshot = undefined;
}

/**
 * Captures only the locally accepted trace/span identity and sampled bit. Caller tracestate and
 * arbitrary baggage are never persisted.
 */
export function activeTraceparent(): string | undefined {
  const spanContext = trace.getSpanContext(context.active());
  if (!spanContext || !isSpanContextValid(spanContext)) return undefined;
  const flags = spanContext.traceFlags & TraceFlags.SAMPLED ? "01" : "00";
  return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}

function apiOutcome(statusCode: number | undefined, aborted: boolean): ApiRequestOutcome {
  if (aborted) return "aborted";
  if (statusCode !== undefined && statusCode >= 500) return "server_error";
  if (statusCode !== undefined && statusCode >= 400) return "client_error";
  return "success";
}

function providerWebhookIngressOutcome(
  statusCode: number | undefined,
  aborted: boolean,
): ProviderWebhookIngressOutcome {
  if (aborted || statusCode === undefined) return "aborted";
  if (statusCode === 200) return "duplicate";
  if (statusCode >= 200 && statusCode < 300) return "accepted";
  if (statusCode === 401) return "authentication_failed";
  if (statusCode === 400 || statusCode === 413 || statusCode === 415) return "validation_failed";
  if (statusCode === 409) return "evidence_conflict";
  if (statusCode === 429) return "rate_limited";
  if (statusCode === 503) return "dispatch_unavailable";
  return "failed";
}

function providerForWebhookSurface(
  surface: ProviderWebhookIngressSurface,
): ProviderTelemetryName | undefined {
  switch (surface) {
    case "shopify_connection":
    case "shopify_privacy":
      return "shopify";
    case "stripe_connection":
    case "stripe_deauthorization":
      return "stripe";
    default:
      return undefined;
  }
}

function providerTelemetryValue(value: string): ProviderTelemetryName | "invalid" {
  return value === "shopify" || value === "stripe" ? value : "invalid";
}

function providerNormalizationSourceTelemetryValue(value: string): ProviderNormalizationSource {
  return value === "webhook" || value === "sync" || value === "invalid" ? value : "invalid";
}

function parseTelemetryInstant(value: string): number | undefined {
  if (
    value.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  ) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function classifyBoundedTiming(
  startedAt: string,
  completedAt: string | undefined,
  maximumSeconds: number,
): {
  readonly outcome: ProviderEventFreshnessOutcome;
  readonly valueSeconds?: number;
} {
  const startedAtMs = parseTelemetryInstant(startedAt);
  const completedAtMs = completedAt === undefined ? Date.now() : parseTelemetryInstant(completedAt);
  if (startedAtMs === undefined || completedAtMs === undefined) {
    return { outcome: "invalid_timestamp" };
  }
  if (startedAtMs > completedAtMs) {
    return { outcome: "future_timestamp" };
  }
  const valueSeconds = (completedAtMs - startedAtMs) / 1_000;
  return valueSeconds > maximumSeconds
    ? { outcome: "outside_window" }
    : { outcome: "observed", valueSeconds };
}

function classifyProviderGapRepairAge(
  freshnessReference: ProviderGapRepairFreshnessReference,
  ageSeconds: number | undefined,
): ProviderGapRepairAgeOutcome {
  if (freshnessReference === "never_succeeded" && ageSeconds === undefined) {
    return "never_succeeded";
  }
  if (
    freshnessReference !== "last_successful_sync" ||
    ageSeconds === undefined ||
    !Number.isFinite(ageSeconds)
  ) {
    return "invalid_age";
  }
  if (ageSeconds < 0) return "future_timestamp";
  return ageSeconds > PROVIDER_GAP_REPAIR_MAXIMUM_AGE_SECONDS ? "outside_window" : "observed";
}

function normalizedRoute(route: string | undefined): string {
  if (
    !route ||
    route.length > 200 ||
    !/^\/[A-Za-z0-9_/:.*-]*$/u.test(route) ||
    route.includes("//")
  ) {
    return "unmatched";
  }
  return route;
}

function traceCarrier(input: { readonly traceparent?: string }): Readonly<Record<string, string>> {
  return {
    ...(validTraceparent(input.traceparent) ? { traceparent: input.traceparent } : {}),
  };
}

function validTraceparent(value: string | undefined): value is string {
  return value !== undefined && parseTraceparent(value) !== undefined;
}

function trustedParentContext(value: string | undefined): ReturnType<typeof context.active> {
  const parsed = value ? parseTraceparent(value) : undefined;
  return parsed
    ? trace.setSpanContext(context.active(), { ...parsed, isRemote: false })
    : context.active();
}

function parseTraceparent(value: string): Omit<SpanContext, "isRemote"> | undefined {
  const match = /^00-((?!0{32})[0-9a-f]{32})-((?!0{16})[0-9a-f]{16})-(00|01)$/u.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return {
    traceId: match[1],
    spanId: match[2],
    traceFlags: match[3] === "01" ? TraceFlags.SAMPLED : TraceFlags.NONE,
  };
}

function recordReconciliationCounts(counts: ReconciliationRunCounts, span: Span): void {
  const values = [
    ["input", counts.input],
    ["matches", counts.matches],
    ["exceptions", counts.exceptions],
    ["ambiguous_candidates", counts.ambiguousCandidates],
  ] as const;
  for (const [kind, value] of values) {
    const count = safeMetricCount(value);
    if (count === undefined) continue;
    instruments.reconciliationResultCount.add(count, {
      "reconai.reconciliation.result": kind,
    });
    span.setAttribute(`reconai.reconciliation.${kind}`, count);
  }
}

function recordOutboxCount(
  outcome: "published" | "retried" | "dead_lettered",
  value: number,
): void {
  const count = safeMetricCount(value);
  if (count === undefined || count === 0) return;
  instruments.outboxEventCount.add(count, { "reconai.outcome": outcome });
}

function safeMetricCount(value: number): number | undefined {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeMetricValue(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function createInstruments() {
  const currentMeter = metrics.getMeter("reconai.operations", instrumentationVersion);
  const durableQueueJobs = currentMeter.createObservableGauge(
    OPERATIONAL_ALERT_METRICS.durableQueueJobs.name,
    {
      description: "Current durable queue job count by fixed lifecycle state.",
      unit: "{job}",
    },
  );
  durableQueueJobs.addCallback((result) => {
    const snapshot = validCurrentDurableQueueSnapshot();
    if (!snapshot) return;
    for (const state of durableQueueStates) {
      result.observe(snapshot.counts[state], { "reconai.queue.state": state });
    }
  });
  const durableQueueReadyHeadMaximumAge = currentMeter.createObservableGauge(
    OPERATIONAL_ALERT_METRICS.durableQueueReadyHeadMaximumAge.name,
    {
      description:
        "Maximum creation age among the next dispatchable waiting, paused, and prioritized list heads.",
      unit: "s",
    },
  );
  durableQueueReadyHeadMaximumAge.addCallback((result) => {
    const snapshot = validCurrentDurableQueueSnapshot();
    if (!snapshot) return;
    result.observe(snapshot.readyHeadMaximumAgeSeconds);
  });
  const exceptionQueueHasUnresolved = currentMeter.createObservableGauge(
    OPERATIONAL_ALERT_METRICS.exceptionQueueHasUnresolved.name,
    {
      description: "Whether the environment currently has at least one unresolved exception.",
      unit: "{queue}",
    },
  );
  exceptionQueueHasUnresolved.addCallback((result) => {
    const snapshot = validCurrentExceptionQueueSnapshot();
    if (!snapshot) return;
    result.observe(snapshot.hasUnresolved);
  });
  const exceptionQueueOldestAge = currentMeter.createObservableGauge(
    OPERATIONAL_ALERT_METRICS.exceptionQueueOldestAge.name,
    {
      description: "Age of the oldest unresolved exception in the environment.",
      unit: "s",
    },
  );
  exceptionQueueOldestAge.addCallback((result) => {
    const snapshot = validCurrentExceptionQueueSnapshot();
    if (!snapshot) return;
    result.observe(snapshot.oldestAgeSeconds);
  });
  const providerActiveSyncHasActive = currentMeter.createObservableGauge(
    OPERATIONAL_ALERT_METRICS.providerActiveSyncHasActive.name,
    {
      description: "Whether each fixed provider currently has an active sync run.",
      unit: "{sync}",
    },
  );
  providerActiveSyncHasActive.addCallback((result) => {
    const snapshot = validCurrentProviderActiveSyncSnapshot();
    if (!snapshot) return;
    for (const provider of providerTelemetryNames) {
      result.observe(snapshot.providers[provider].hasActive, {
        "reconai.provider": provider,
      });
    }
  });
  const providerActiveSyncOldestAge = currentMeter.createObservableGauge(
    OPERATIONAL_ALERT_METRICS.providerActiveSyncOldestAge.name,
    {
      description: "Creation age of the oldest queued or running sync for each fixed provider.",
      unit: "s",
    },
  );
  providerActiveSyncOldestAge.addCallback((result) => {
    const snapshot = validCurrentProviderActiveSyncSnapshot();
    if (!snapshot) return;
    for (const provider of providerTelemetryNames) {
      const active = snapshot.providers[provider];
      if (active.hasActive === 0) continue;
      result.observe(active.oldestAgeSeconds, {
        "reconai.provider": provider,
        "reconai.provider.sync.status": active.syncStatus,
      });
    }
  });
  return {
    apiRequestCount: currentMeter.createCounter("reconai.api.server.requests", {
      description: "Completed API requests.",
      unit: "{request}",
    }),
    apiRequestDuration: currentMeter.createHistogram("reconai.api.server.duration", {
      description: "API request duration.",
      unit: "ms",
    }),
    durableJobCount: currentMeter.createCounter("reconai.worker.jobs", {
      description: "Completed durable job attempts.",
      unit: "{job}",
    }),
    durableJobDuration: currentMeter.createHistogram("reconai.worker.job.duration", {
      description: "Durable job attempt duration.",
      unit: "ms",
    }),
    reconciliationRunCount: currentMeter.createCounter("reconai.reconciliation.runs", {
      description: "Completed deterministic reconciliation run executions.",
      unit: "{run}",
    }),
    reconciliationRunDuration: currentMeter.createHistogram("reconai.reconciliation.duration", {
      description: "Deterministic reconciliation execution duration.",
      unit: "ms",
    }),
    reconciliationResultCount: currentMeter.createCounter("reconai.reconciliation.results", {
      description: "Aggregate deterministic reconciliation result counts.",
      unit: "{record}",
    }),
    reconciliationRunCreationUnavailableCount: currentMeter.createCounter(
      "reconai.reconciliation.run_creation.unavailable",
      {
        description: "Retry-safe reconciliation run-creation unavailability responses.",
        unit: "{request}",
      },
    ),
    outboxBatchCount: currentMeter.createCounter("reconai.outbox.relay.batches", {
      description: "Completed transactional outbox relay batches.",
      unit: "{batch}",
    }),
    outboxBatchDuration: currentMeter.createHistogram("reconai.outbox.relay.duration", {
      description: "Transactional outbox relay batch duration.",
      unit: "ms",
    }),
    outboxEventCount: currentMeter.createCounter("reconai.outbox.events", {
      description: "Transactional outbox relay event outcomes.",
      unit: "{event}",
    }),
    durableQueueMonitorPolls: currentMeter.createCounter(
      OPERATIONAL_ALERT_METRICS.durableQueueMonitorPolls.name,
      {
        description: "Leader-owned durable queue telemetry poll outcomes.",
        unit: "{poll}",
      },
    ),
    exceptionQueueMonitorPolls: currentMeter.createCounter(
      OPERATIONAL_ALERT_METRICS.exceptionQueueMonitorPolls.name,
      {
        description: "Leader-owned oldest-unresolved exception queue observation outcomes.",
        unit: "{poll}",
      },
    ),
    providerActiveSyncMonitorPolls: currentMeter.createCounter(
      OPERATIONAL_ALERT_METRICS.providerActiveSyncMonitorPolls.name,
      {
        description: "Leader-owned provider active-sync observation outcomes.",
        unit: "{poll}",
      },
    ),
    providerWebhookIngressCount: currentMeter.createCounter(
      "reconai.provider.webhook.ingress.requests",
      {
        description: "Completed provider-signed webhook ingress requests.",
        unit: "{request}",
      },
    ),
    providerNormalizationCount: currentMeter.createCounter("reconai.provider.normalization.runs", {
      description: "Completed provider event normalization attempts after durable authority.",
      unit: "{run}",
    }),
    providerNormalizationDuration: currentMeter.createHistogram(
      "reconai.provider.normalization.duration",
      {
        description: "Provider event normalization duration after durable authority.",
        unit: "ms",
      },
    ),
    providerSyncCount: currentMeter.createCounter("reconai.provider.sync.runs", {
      description: "Completed provider sync worker attempts after durable authority.",
      unit: "{run}",
    }),
    providerSyncDuration: currentMeter.createHistogram("reconai.provider.sync.duration", {
      description: "Provider sync worker attempt duration after durable authority.",
      unit: "ms",
    }),
    providerCircuitDecisions: currentMeter.createCounter("reconai.provider.circuit.decisions", {
      description: "Distributed provider request circuit admission decisions.",
      unit: "{decision}",
    }),
    providerCircuitTransitions: currentMeter.createCounter("reconai.provider.circuit.transitions", {
      description: "Distributed provider request circuit state transitions.",
      unit: "{transition}",
    }),
    providerEventFreshnessSamples: currentMeter.createCounter(
      "reconai.provider.event.freshness.samples",
      {
        description: "Classified provider event source-time freshness samples after normalization.",
        unit: "{sample}",
      },
    ),
    providerEventSourceLag: currentMeter.createHistogram("reconai.provider.event.source_lag", {
      description: "Provider event source timestamp to successful normalization lag.",
      unit: "s",
    }),
    providerGapRepairScans: currentMeter.createCounter("reconai.provider.gap_repair.scans", {
      description: "Bounded scheduled provider gap-repair scan outcomes.",
      unit: "{scan}",
    }),
    providerGapRepairCandidates: currentMeter.createCounter(
      "reconai.provider.gap_repair.candidates",
      {
        description: "Due provider gap-repair candidates observed by a bounded scheduler scan.",
        unit: "{candidate}",
      },
    ),
    providerGapRepairLastSuccessfulSyncAge: currentMeter.createHistogram(
      "reconai.provider.gap_repair.last_successful_sync_age",
      {
        description: "Age of the last successful sync for due provider gap-repair candidates.",
        unit: "s",
      },
    ),
    proposalReviewDecisionSamples: currentMeter.createCounter(
      "reconai.review.proposal_decision.samples",
      {
        description: "Classified tenant-authorized proposal review decisions.",
        unit: "{decision}",
      },
    ),
    proposalReviewDecisionAge: currentMeter.createHistogram(
      "reconai.review.proposal_decision.age",
      {
        description: "Proposal creation to committed reviewer decision age.",
        unit: "s",
      },
    ),
    exceptionFinalResolutionSamples: currentMeter.createCounter(
      "reconai.review.exception_final_resolution.samples",
      {
        description: "Classified final approved-exception resolution samples.",
        unit: "{resolution}",
      },
    ),
    exceptionFinalResolutionAge: currentMeter.createHistogram(
      "reconai.review.exception_final_resolution.age",
      {
        description: "Exception creation to final approved status transition age.",
        unit: "s",
      },
    ),
  };
}

function validCurrentDurableQueueSnapshot(): DurableQueueSnapshot | undefined {
  if (
    currentDurableQueueSnapshot &&
    currentDurableQueueSnapshot.expiresAtMonotonicMs >= performance.now()
  ) {
    return currentDurableQueueSnapshot.snapshot;
  }
  currentDurableQueueSnapshot = undefined;
  return undefined;
}

function validCurrentExceptionQueueSnapshot(): ExceptionQueueSnapshot | undefined {
  if (
    currentExceptionQueueSnapshot &&
    currentExceptionQueueSnapshot.expiresAtMonotonicMs >= performance.now()
  ) {
    return currentExceptionQueueSnapshot.snapshot;
  }
  currentExceptionQueueSnapshot = undefined;
  return undefined;
}

function validCurrentProviderActiveSyncSnapshot(): ProviderActiveSyncSnapshot | undefined {
  if (
    currentProviderActiveSyncSnapshot &&
    currentProviderActiveSyncSnapshot.expiresAtMonotonicMs >= performance.now()
  ) {
    return currentProviderActiveSyncSnapshot.snapshot;
  }
  currentProviderActiveSyncSnapshot = undefined;
  return undefined;
}
