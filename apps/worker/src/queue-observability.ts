import { randomUUID } from "node:crypto";

import {
  clearExceptionQueueSnapshot,
  clearDurableQueueSnapshot,
  clearProviderActiveSyncSnapshot,
  createLogger,
  recordDurableQueueMonitorPoll,
  recordDurableQueueSnapshot,
  recordExceptionQueueObservation,
  recordExceptionQueueObservationFailure,
  recordProviderActiveSyncObservation,
  recordProviderActiveSyncObservationFailure,
  safeError,
  type DurableQueueSnapshot,
  type DurableQueueState,
} from "@workspace/observability";
import type { JobType } from "bullmq";

const queueStates = [
  "waiting",
  "paused",
  "active",
  "delayed",
  "prioritized",
  "waiting-children",
  "failed",
] as const satisfies readonly DurableQueueState[] & readonly JobType[];
const readyHeadStates = ["waiting", "prioritized"] as const satisfies readonly JobType[];
const acquireOrRenewLeaseScript = `
local current = redis.call("GET", KEYS[1])
if not current then
  if redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then
    return 1
  end
  return 0
end
if current == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;
const releaseLeaseScript = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export interface DurableQueueInspector {
  getJobCounts(...types: JobType[]): Promise<Partial<Record<JobType, number>>>;
  getJobs(
    types: JobType[] | JobType,
    start?: number,
    end?: number,
    asc?: boolean,
  ): Promise<readonly { readonly timestamp: number }[]>;
}

export interface DurableQueueLeaseStore {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<unknown>;
}

export interface DurableQueueMonitorOptions {
  readonly inspector: DurableQueueInspector;
  readonly leaseStore: DurableQueueLeaseStore;
  readonly queueName: string;
  readonly environment: string;
  readonly intervalMs: number;
  readonly exceptionQueue?: ExceptionQueueObservabilityRepository;
  readonly providerActiveSyncs?: ProviderActiveSyncObservabilityRepository;
  readonly now?: () => Date;
  /** Test-only deterministic lease ownership. Production callers must omit this value. */
  readonly leaseToken?: string;
}

export interface ExceptionQueueObservabilityRepository {
  observeExceptionQueue(): Promise<{
    readonly queueState: "empty" | "nonempty";
    readonly oldestAgeSeconds?: number;
  }>;
}

export interface ProviderActiveSyncObservabilityRepository {
  observeProviderActiveSyncs(): Promise<
    readonly {
      readonly provider: "shopify" | "stripe";
      readonly activityState: "empty" | "active";
      readonly syncStatus?: "queued" | "running";
      readonly oldestAgeSeconds?: number;
    }[]
  >;
}

export interface DurableQueuePollOptions {
  readonly inspector: DurableQueueInspector;
  readonly leaseStore: DurableQueueLeaseStore;
  readonly leaseKey: string;
  readonly leaseToken: string;
  readonly leaseTtlMs: number;
  readonly now: Date;
}

export type DurableQueuePollResult =
  | { readonly outcome: "recorded"; readonly snapshot: DurableQueueSnapshot }
  | { readonly outcome: "not_leader" };

export interface RunningDurableQueueMonitor {
  runNow(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Reads only fixed-size queue metadata: seven aggregate counts and at most one hydrated job from
 * each ready list (waiting, paused, prioritized). BullMQ adds paused when waiting is requested.
 */
export async function inspectDurableQueue(
  inspector: DurableQueueInspector,
  now: Date,
): Promise<DurableQueueSnapshot> {
  if (!Number.isFinite(now.getTime())) throw new TypeError("queue observation time is invalid");
  const [rawCounts, readyHeads] = await Promise.all([
    inspector.getJobCounts(...queueStates),
    inspector.getJobs([...readyHeadStates], 0, 0, true),
  ]);
  if (readyHeads.length > 3) {
    throw new Error("queue inspector returned more than the bounded ready-list frontier");
  }

  const counts = Object.fromEntries(
    queueStates.map((state) => [state, validatedCount(rawCounts, state)]),
  ) as Record<DurableQueueState, number>;
  const readyHeadMaximumAgeSeconds = readyHeads.reduce((maximum, job) => {
    const timestamp = validatedJobTimestamp(job);
    return Math.max(maximum, Math.max(0, (now.getTime() - timestamp) / 1_000));
  }, 0);
  return { counts, readyHeadMaximumAgeSeconds };
}

export async function observeDurableQueueOnce(
  options: DurableQueuePollOptions,
): Promise<DurableQueuePollResult> {
  validateLeaseOptions(options);
  let acquired: unknown;
  try {
    acquired = await options.leaseStore.eval(
      acquireOrRenewLeaseScript,
      1,
      options.leaseKey,
      options.leaseToken,
      options.leaseTtlMs,
    );
  } catch (error) {
    clearDurableQueueSnapshot();
    recordDurableQueueMonitorPoll("failed");
    throw error;
  }
  if (!redisTruthy(acquired)) {
    clearDurableQueueSnapshot();
    return { outcome: "not_leader" };
  }

  try {
    const snapshot = await inspectDurableQueue(options.inspector, options.now);
    recordDurableQueueSnapshot(snapshot, options.leaseTtlMs);
    recordDurableQueueMonitorPoll("succeeded");
    return { outcome: "recorded", snapshot };
  } catch (error) {
    clearDurableQueueSnapshot();
    recordDurableQueueMonitorPoll("failed");
    throw error;
  }
}

export async function observeDurableQueueAndExceptionOnce(
  options: DurableQueuePollOptions & {
    readonly exceptionQueue?: ExceptionQueueObservabilityRepository;
  },
): Promise<DurableQueuePollResult> {
  return observeLeasedOperationalTelemetryOnce(options);
}

export async function observeLeasedOperationalTelemetryOnce(
  options: DurableQueuePollOptions & {
    readonly exceptionQueue?: ExceptionQueueObservabilityRepository;
    readonly providerActiveSyncs?: ProviderActiveSyncObservabilityRepository;
  },
): Promise<DurableQueuePollResult> {
  let queueResult: DurableQueuePollResult;
  try {
    queueResult = await observeDurableQueueOnce(options);
  } catch (error) {
    clearExceptionQueueSnapshot();
    clearProviderActiveSyncSnapshot();
    throw error;
  }
  if (queueResult.outcome === "not_leader") {
    clearExceptionQueueSnapshot();
    clearProviderActiveSyncSnapshot();
    return queueResult;
  }
  if (options.exceptionQueue) {
    try {
      const observation = await options.exceptionQueue.observeExceptionQueue();
      recordExceptionQueueObservation(observation, options.leaseTtlMs);
    } catch (error) {
      clearExceptionQueueSnapshot();
      clearProviderActiveSyncSnapshot();
      recordExceptionQueueObservationFailure();
      throw error;
    }
  }
  if (options.providerActiveSyncs) {
    try {
      const observations = await options.providerActiveSyncs.observeProviderActiveSyncs();
      recordProviderActiveSyncObservation(observations, options.leaseTtlMs);
    } catch (error) {
      clearProviderActiveSyncSnapshot();
      recordProviderActiveSyncObservationFailure();
      throw error;
    }
  }
  return queueResult;
}

export function startDurableQueueMonitor(
  options: DurableQueueMonitorOptions,
): RunningDurableQueueMonitor {
  validateMonitorOptions(options);
  const logger = createLogger("reconai-durable-queue-monitor", options.environment);
  const leaseKey = durableQueueMonitorLeaseKey(options.queueName);
  const leaseToken = options.leaseToken ?? randomUUID();
  const leaseTtlMs = durableQueueMonitorLeaseTtlMs(options.intervalMs);
  const now = options.now ?? (() => new Date());
  let closed = false;
  let running: Promise<void> | undefined;

  const runNow = async () => {
    if (closed || running) return;
    running = (async () => {
      try {
        await observeLeasedOperationalTelemetryOnce({
          inspector: options.inspector,
          leaseStore: options.leaseStore,
          leaseKey,
          leaseToken,
          leaseTtlMs,
          now: now(),
          ...(options.exceptionQueue ? { exceptionQueue: options.exceptionQueue } : {}),
          ...(options.providerActiveSyncs
            ? { providerActiveSyncs: options.providerActiveSyncs }
            : {}),
        });
      } catch (error) {
        logger.error({ error: safeError(error) }, "leased operational telemetry poll failed");
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
      clearDurableQueueSnapshot();
      clearExceptionQueueSnapshot();
      clearProviderActiveSyncSnapshot();
      try {
        await releaseDurableQueueMonitorLease(options.leaseStore, leaseKey, leaseToken);
      } catch (error) {
        logger.warn({ error: safeError(error) }, "durable queue telemetry lease release failed");
      }
    },
  };
}

export function durableQueueMonitorLeaseKey(queueName: string): string {
  if (
    queueName.length < 3 ||
    queueName.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]+$/u.test(queueName)
  ) {
    throw new TypeError("durable queue name is invalid");
  }
  return `${queueName}:observability:lease:v1`;
}

export function durableQueueMonitorLeaseTtlMs(intervalMs: number): number {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 300_000) {
    throw new TypeError(
      "durable queue monitor interval must be between one second and five minutes",
    );
  }
  return Math.max(5_000, Math.min(900_000, intervalMs * 3));
}

async function releaseDurableQueueMonitorLease(
  leaseStore: DurableQueueLeaseStore,
  leaseKey: string,
  leaseToken: string,
): Promise<void> {
  await leaseStore.eval(releaseLeaseScript, 1, leaseKey, leaseToken);
}

function validatedCount(
  counts: Partial<Record<JobType, number>>,
  state: DurableQueueState,
): number {
  const value = counts[state];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`queue inspector returned an invalid ${state} count`);
  }
  return value;
}

function validatedJobTimestamp(job: { readonly timestamp: number }): number {
  if (!Number.isSafeInteger(job.timestamp) || job.timestamp < 0) {
    throw new Error("queue inspector returned an invalid ready-list job timestamp");
  }
  return job.timestamp;
}

function redisTruthy(value: unknown): boolean {
  return value === 1 || value === "1";
}

function validateMonitorOptions(options: DurableQueueMonitorOptions): void {
  durableQueueMonitorLeaseKey(options.queueName);
  durableQueueMonitorLeaseTtlMs(options.intervalMs);
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/u.test(options.environment)) {
    throw new TypeError("durable queue monitor environment is invalid");
  }
  if (options.leaseToken !== undefined && !/^[A-Za-z0-9-]{16,64}$/u.test(options.leaseToken)) {
    throw new TypeError("durable queue monitor lease token is invalid");
  }
}

function validateLeaseOptions(options: DurableQueuePollOptions): void {
  if (
    options.leaseKey.length < 3 ||
    options.leaseKey.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]+$/u.test(options.leaseKey)
  ) {
    throw new TypeError("durable queue monitor lease key is invalid");
  }
  if (!/^[A-Za-z0-9-]{16,64}$/u.test(options.leaseToken)) {
    throw new TypeError("durable queue monitor lease token is invalid");
  }
  if (
    !Number.isSafeInteger(options.leaseTtlMs) ||
    options.leaseTtlMs < 5_000 ||
    options.leaseTtlMs > 900_000
  ) {
    throw new TypeError("durable queue monitor lease TTL is invalid");
  }
  if (!Number.isFinite(options.now.getTime())) {
    throw new TypeError("durable queue monitor observation time is invalid");
  }
}
