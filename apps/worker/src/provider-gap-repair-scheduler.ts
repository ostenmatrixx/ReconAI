import type {
  ScheduledProviderGapRepairInput,
  ScheduledProviderGapRepairResult,
} from "@workspace/database";
import {
  createLogger,
  recordProviderGapRepairCandidate,
  recordProviderGapRepairScan,
  safeError,
} from "@workspace/observability";

export interface ProviderGapRepairSchedulerRepository {
  scheduleDueGapRepairs(
    input: ScheduledProviderGapRepairInput,
  ): Promise<ScheduledProviderGapRepairResult>;
}

export interface ProviderGapRepairSchedulerOptions {
  readonly repository: ProviderGapRepairSchedulerRepository;
  readonly environment: string;
  readonly intervalMs: number;
  readonly lookbackMs: number;
  readonly overlapMs: number;
  readonly maximumPages: number;
  readonly batchSize: number;
  readonly now?: () => Date;
}

export interface RunningProviderGapRepairScheduler {
  runNow(): Promise<void>;
  close(): Promise<void>;
}

export async function executeProviderGapRepairScan(
  options: Omit<ProviderGapRepairSchedulerOptions, "environment" | "now"> & {
    readonly now: Date;
  },
): Promise<ScheduledProviderGapRepairResult> {
  try {
    const result = await options.repository.scheduleDueGapRepairs({
      now: options.now.toISOString(),
      cadenceMs: options.intervalMs,
      lookbackMs: options.lookbackMs,
      overlapMs: options.overlapMs,
      maximumPages: options.maximumPages,
      batchSize: options.batchSize,
    });
    recordProviderGapRepairScan("succeeded");
    for (const candidate of result.candidateObservations.slice(0, 100)) {
      recordProviderGapRepairCandidate(candidate);
    }
    return result;
  } catch (error) {
    recordProviderGapRepairScan("failed");
    throw error;
  }
}

export function startProviderGapRepairScheduler(
  options: ProviderGapRepairSchedulerOptions,
): RunningProviderGapRepairScheduler {
  validateSchedulerOptions(options);
  const logger = createLogger("reconai-provider-gap-repair-scheduler", options.environment);
  const now = options.now ?? (() => new Date());
  let closed = false;
  let running: Promise<void> | undefined;
  const runNow = async () => {
    if (closed || running) return;
    running = (async () => {
      try {
        const result = await executeProviderGapRepairScan({ ...options, now: now() });
        if (result.examined > 0) {
          logger.info(
            {
              examined: result.examined,
              scheduled: result.scheduled,
              skipped: result.skipped,
            },
            "provider gap repair scan completed",
          );
        }
      } catch (error) {
        logger.error({ error: safeError(error) }, "provider gap repair scan failed");
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

function validateSchedulerOptions(options: ProviderGapRepairSchedulerOptions): void {
  if (
    !Number.isSafeInteger(options.intervalMs) ||
    options.intervalMs < 60_000 ||
    options.intervalMs > 86_400_000
  ) {
    throw new TypeError("provider gap repair interval must be between one minute and one day");
  }
  if (
    !Number.isSafeInteger(options.lookbackMs) ||
    options.lookbackMs < 60_000 ||
    options.lookbackMs > 30 * 24 * 60 * 60 * 1000
  ) {
    throw new TypeError("provider gap repair lookback must be between one minute and 30 days");
  }
  if (
    !Number.isSafeInteger(options.overlapMs) ||
    options.overlapMs < 0 ||
    options.overlapMs > 60 * 60 * 1000 ||
    options.overlapMs >= options.lookbackMs
  ) {
    throw new TypeError("provider gap repair overlap is invalid");
  }
  if (
    !Number.isSafeInteger(options.maximumPages) ||
    options.maximumPages < 1 ||
    options.maximumPages > 25
  ) {
    throw new TypeError("provider gap repair page ceiling must be between 1 and 25");
  }
  if (
    !Number.isSafeInteger(options.batchSize) ||
    options.batchSize < 1 ||
    options.batchSize > 100
  ) {
    throw new TypeError("provider gap repair batch size must be between 1 and 100");
  }
}
