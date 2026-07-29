export type OperationalMetricInstrument = "counter" | "observable_gauge";

export interface OperationalMetricContract {
  readonly name: string;
  readonly instrument: OperationalMetricInstrument;
  readonly attributes: Readonly<Record<string, readonly string[]>>;
}

/**
 * Alertable operational instruments and their complete low-cardinality attribute vocabularies.
 *
 * Keep telemetry creation and the source-controlled alert policy bound to these constants so a
 * metric or label rename cannot silently orphan a backend alert.
 */
export const OPERATIONAL_ALERT_METRICS = {
  durableQueueJobs: {
    name: "reconai.queue.jobs",
    instrument: "observable_gauge",
    attributes: {
      "reconai.queue.state": [
        "waiting",
        "paused",
        "active",
        "delayed",
        "prioritized",
        "waiting-children",
        "failed",
      ],
    },
  },
  durableQueueReadyHeadMaximumAge: {
    name: "reconai.queue.ready_head.maximum_age",
    instrument: "observable_gauge",
    attributes: {},
  },
  durableQueueMonitorPolls: {
    name: "reconai.queue.monitor.polls",
    instrument: "counter",
    attributes: {
      "reconai.outcome": ["succeeded", "failed"],
    },
  },
  exceptionQueueHasUnresolved: {
    name: "reconai.review.exception_queue.has_unresolved",
    instrument: "observable_gauge",
    attributes: {},
  },
  exceptionQueueOldestAge: {
    name: "reconai.review.exception_queue.oldest_age",
    instrument: "observable_gauge",
    attributes: {},
  },
  exceptionQueueMonitorPolls: {
    name: "reconai.review.exception_queue.monitor.polls",
    instrument: "counter",
    attributes: {
      "reconai.outcome": ["empty", "observed", "future_timestamp", "invalid_age", "failed"],
    },
  },
  providerActiveSyncHasActive: {
    name: "reconai.provider.sync.active.has_active",
    instrument: "observable_gauge",
    attributes: {
      "reconai.provider": ["shopify", "stripe"],
    },
  },
  providerActiveSyncOldestAge: {
    name: "reconai.provider.sync.active.oldest_age",
    instrument: "observable_gauge",
    attributes: {
      "reconai.provider": ["shopify", "stripe"],
      "reconai.provider.sync.status": ["queued", "running"],
    },
  },
  providerActiveSyncMonitorPolls: {
    name: "reconai.provider.sync.active.monitor.polls",
    instrument: "counter",
    attributes: {
      "reconai.outcome": ["empty", "observed", "future_timestamp", "invalid_age", "failed"],
    },
  },
} as const satisfies Readonly<Record<string, OperationalMetricContract>>;

export type OperationalAlertMetricName =
  (typeof OPERATIONAL_ALERT_METRICS)[keyof typeof OPERATIONAL_ALERT_METRICS]["name"];

export const OPERATIONAL_ALERT_METRICS_BY_NAME: Readonly<
  Record<OperationalAlertMetricName, OperationalMetricContract>
> = Object.fromEntries(
  Object.values(OPERATIONAL_ALERT_METRICS).map((contract) => [contract.name, contract]),
) as Record<OperationalAlertMetricName, OperationalMetricContract>;
