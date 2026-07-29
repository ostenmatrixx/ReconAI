import type {
  ProviderPrivacyDeadlineAlertScanInput,
  ProviderPrivacyDeadlineAlertScanResult,
} from "@workspace/database";
import { createLogger, safeError } from "@workspace/observability";

export interface ProviderPrivacyDeadlineMonitorRepository {
  scanDueDeadlineAlerts(
    input: ProviderPrivacyDeadlineAlertScanInput,
  ): Promise<ProviderPrivacyDeadlineAlertScanResult>;
}

export interface ProviderPrivacyDeadlineMonitorOptions {
  readonly repository: ProviderPrivacyDeadlineMonitorRepository;
  readonly environment: string;
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly now?: () => Date;
}

export interface RunningProviderPrivacyDeadlineMonitor {
  runNow(): Promise<void>;
  close(): Promise<void>;
}

export async function executeProviderPrivacyDeadlineScan(
  options: Pick<ProviderPrivacyDeadlineMonitorOptions, "repository" | "batchSize"> & {
    readonly now: Date;
  },
): Promise<ProviderPrivacyDeadlineAlertScanResult> {
  return options.repository.scanDueDeadlineAlerts({
    now: options.now.toISOString(),
    batchSize: options.batchSize,
  });
}

export function startProviderPrivacyDeadlineMonitor(
  options: ProviderPrivacyDeadlineMonitorOptions,
): RunningProviderPrivacyDeadlineMonitor {
  validateMonitorOptions(options);
  const logger = createLogger("reconai-provider-privacy-deadline-monitor", options.environment);
  const now = options.now ?? (() => new Date());
  let closed = false;
  let running: Promise<void> | undefined;
  const runNow = async () => {
    if (closed || running) return;
    running = (async () => {
      try {
        const result = await executeProviderPrivacyDeadlineScan({ ...options, now: now() });
        if (result.overdue > 0) {
          logger.error(result, "overdue Shopify privacy request escalation created");
        } else if (result.created > 0) {
          logger.warn(result, "Shopify privacy request deadline escalation created");
        }
      } catch (error) {
        logger.error({ error: safeError(error) }, "Shopify privacy deadline scan failed");
      } finally {
        running = undefined;
      }
    })();
    await running;
  };
  const timer = setInterval(() => {
    void runNow();
  }, options.intervalMs);
  timer.unref();
  void runNow();
  return {
    runNow,
    close: async () => {
      closed = true;
      clearInterval(timer);
      await running;
    },
  };
}

function validateMonitorOptions(options: ProviderPrivacyDeadlineMonitorOptions): void {
  if (
    !Number.isSafeInteger(options.intervalMs) ||
    options.intervalMs < 60_000 ||
    options.intervalMs > 86_400_000
  ) {
    throw new TypeError("privacy deadline monitor interval must be between one minute and one day");
  }
  if (
    !Number.isSafeInteger(options.batchSize) ||
    options.batchSize < 1 ||
    options.batchSize > 500
  ) {
    throw new TypeError("privacy deadline monitor batch size must be between 1 and 500");
  }
}
