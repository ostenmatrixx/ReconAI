import { context, trace } from "@opentelemetry/api";
import pino, { type Logger } from "pino";

export * from "./runtime.js";
export {
  OPERATIONAL_ALERT_POLICY_API_VERSION,
  validateOperationalAlertPolicy,
  type AlertCondition,
  type AlertSeverity,
  type OperationalAlertPolicy,
  type OperationalAlertRule,
} from "./alert-policy.js";
export {
  OPERATIONAL_ALERT_METRICS,
  OPERATIONAL_ALERT_METRICS_BY_NAME,
  type OperationalAlertMetricName,
  type OperationalMetricContract,
  type OperationalMetricInstrument,
} from "./metric-contract.js";
export {
  EXCEPTION_FINAL_RESOLUTION_MAXIMUM_AGE_SECONDS,
  PROPOSAL_REVIEW_DECISION_MAXIMUM_AGE_SECONDS,
  PROVIDER_EVENT_FRESHNESS_MAXIMUM_LAG_SECONDS,
  PROVIDER_GAP_REPAIR_MAXIMUM_AGE_SECONDS,
  activeTraceparent,
  clearExceptionQueueSnapshot,
  clearProviderActiveSyncSnapshot,
  clearDurableQueueSnapshot,
  providerNormalizationOutcomeForTerminalCode,
  providerNormalizationSourceForRequestedBy,
  providerSyncTriggerForRequestedBy,
  recordExceptionFinalResolution,
  recordExceptionQueueObservation,
  recordExceptionQueueObservationFailure,
  recordProviderEventFreshness,
  recordProviderCircuitDecision,
  recordProviderCircuitTransition,
  recordProviderActiveSyncObservation,
  recordProviderActiveSyncObservationFailure,
  recordProviderGapRepairCandidate,
  recordProviderGapRepairScan,
  recordProposalReviewDecision,
  recordDurableQueueMonitorPoll,
  recordDurableQueueSnapshot,
  recordReconciliationRunCreationUnavailable,
  startApiRequestObservation,
  startDurableJobObservation,
  startOutboxRelayBatchObservation,
  startProviderNormalizationObservation,
  startProviderSyncObservation,
  startProviderWebhookIngressObservation,
  startReconciliationRunObservation,
  type ApiRequestObservation,
  type ApiRequestOutcome,
  type DurableJobObservation,
  type DurableJobOutcome,
  type DurableJobTelemetryType,
  type DurableQueueMonitorOutcome,
  type DurableQueueSnapshot,
  type DurableQueueState,
  type ExceptionQueueObservationOutcome,
  type ExceptionQueueSnapshot,
  type ExceptionFinalResolutionTimingOutcome,
  type OutboxRelayBatchObservation,
  type ProviderEventFreshnessOutcome,
  type ProviderCircuitDecisionOutcome,
  type ProviderCircuitTransitionOutcome,
  type ProviderActiveSyncObservationInput,
  type ProviderActiveSyncObservationOutcome,
  type ProviderActiveSyncSnapshot,
  type ProviderActiveSyncSnapshotValue,
  type ProviderActiveSyncStatus,
  type ProviderGapRepairAgeOutcome,
  type ProviderGapRepairDisposition,
  type ProviderGapRepairFreshnessReference,
  type ProviderGapRepairScanOutcome,
  type ProviderNormalizationObservation,
  type ProviderNormalizationOutcome,
  type ProviderNormalizationSource,
  type ProviderSyncObservation,
  type ProviderSyncOutcome,
  type ProviderSyncTrigger,
  type ProviderTelemetryName,
  type ProviderWebhookIngressObservation,
  type ProviderWebhookIngressOutcome,
  type ProviderWebhookIngressSurface,
  type ProposalReviewDecision,
  type ProposalReviewStatus,
  type ProposalReviewTimingOutcome,
  type ReconciliationRunCounts,
  type ReconciliationRunCreationUnavailableReason,
  type ReconciliationRunObservation,
  type ReconciliationRunOutcome,
} from "./telemetry.js";

const redactedPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "*.accessToken",
  "*.refreshToken",
  "*.apiKey",
  "*.secret",
  "*.password",
  "*.rawBody",
  "*.payload",
  "*.card",
  "*.cvc",
];

export function createLogger(service: string, environment: string, level = "info"): Logger {
  return pino({
    name: service,
    level,
    base: { service, environment },
    redact: { paths: redactedPaths, censor: "[REDACTED]" },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    mixin() {
      return activeTraceIds();
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export function activeTraceIds(): { traceId?: string; spanId?: string } {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const spanContext = span.spanContext();
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}

export function safeError(error: unknown): { name: string; code?: string; message: string } {
  if (!(error instanceof Error)) return { name: "UnknownError", message: "operation failed" };
  const code =
    "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code)
      ? error.code
      : undefined;
  return {
    name: error.name.slice(0, 100),
    ...(code ? { code } : {}),
    message: sanitizeErrorMessage(error.message),
  };
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, "[REDACTED_AUTH]")
    .replace(/(?:password|secret|token|api[_-]?key)=\S+/giu, "$1=[REDACTED]")
    .slice(0, 500);
}
