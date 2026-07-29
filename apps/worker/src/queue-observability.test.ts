import { describe, expect, it, vi } from "vitest";

import {
  durableQueueMonitorLeaseKey,
  durableQueueMonitorLeaseTtlMs,
  inspectDurableQueue,
  observeDurableQueueAndExceptionOnce,
  observeDurableQueueOnce,
  observeLeasedOperationalTelemetryOnce,
  startDurableQueueMonitor,
  type DurableQueueInspector,
  type DurableQueueLeaseStore,
} from "./queue-observability.js";

const fixedCounts = {
  waiting: 2,
  paused: 1,
  active: 3,
  delayed: 4,
  prioritized: 5,
  "waiting-children": 6,
  failed: 7,
} as const;

describe("durable queue bounded inspection", () => {
  it("reads only fixed counts and three ready-list heads", async () => {
    const getJobCounts = vi.fn(async () => fixedCounts);
    const getJobs = vi.fn(async () => [
      { timestamp: Date.parse("2026-07-29T00:00:50.000Z") },
      { timestamp: Date.parse("2026-07-29T00:00:20.000Z") },
      { timestamp: Date.parse("2026-07-29T00:00:40.000Z") },
    ]);

    await expect(
      inspectDurableQueue({ getJobCounts, getJobs }, new Date("2026-07-29T00:01:00.000Z")),
    ).resolves.toEqual({
      counts: fixedCounts,
      readyHeadMaximumAgeSeconds: 40,
    });
    expect(getJobCounts).toHaveBeenCalledWith(
      "waiting",
      "paused",
      "active",
      "delayed",
      "prioritized",
      "waiting-children",
      "failed",
    );
    expect(getJobs).toHaveBeenCalledWith(["waiting", "prioritized"], 0, 0, true);
  });

  it("records explicit zero age for an empty ready frontier", async () => {
    await expect(
      inspectDurableQueue(
        {
          getJobCounts: async () => ({
            waiting: 0,
            paused: 0,
            active: 0,
            delayed: 0,
            prioritized: 0,
            "waiting-children": 0,
            failed: 0,
          }),
          getJobs: async () => [],
        },
        new Date("2026-07-29T00:01:00.000Z"),
      ),
    ).resolves.toMatchObject({ readyHeadMaximumAgeSeconds: 0 });
  });

  it("rejects corrupt aggregates and an unbounded frontier without emitting a partial snapshot", async () => {
    await expect(
      inspectDurableQueue(
        {
          getJobCounts: async () => ({ ...fixedCounts, failed: -1 }),
          getJobs: async () => [],
        },
        new Date(),
      ),
    ).rejects.toThrow("invalid failed count");
    await expect(
      inspectDurableQueue(
        {
          getJobCounts: async () => fixedCounts,
          getJobs: async () => [
            { timestamp: 1 },
            { timestamp: 2 },
            { timestamp: 3 },
            { timestamp: 4 },
          ],
        },
        new Date(),
      ),
    ).rejects.toThrow("bounded ready-list frontier");
    await expect(
      inspectDurableQueue(
        {
          getJobCounts: async () => fixedCounts,
          getJobs: async () => [{ timestamp: Number.NaN }],
        },
        new Date(),
      ),
    ).rejects.toThrow("invalid ready-list job timestamp");
  });
});

describe("durable queue single-writer ownership", () => {
  it("records only for the lease owner and leaves a follower read-free", async () => {
    const leaderInspector = inspector();
    const followerInspector = inspector();
    const leader = await observeDurableQueueOnce({
      inspector: leaderInspector.value,
      leaseStore: { eval: async () => 1 },
      leaseKey: "reconai-test-durable:observability:lease:v1",
      leaseToken: "leader-token-0001",
      leaseTtlMs: 45_000,
      now: new Date("2026-07-29T00:01:00.000Z"),
    });
    const follower = await observeDurableQueueOnce({
      inspector: followerInspector.value,
      leaseStore: { eval: async () => 0 },
      leaseKey: "reconai-test-durable:observability:lease:v1",
      leaseToken: "follower-token-01",
      leaseTtlMs: 45_000,
      now: new Date("2026-07-29T00:01:00.000Z"),
    });

    expect(leader).toMatchObject({ outcome: "recorded" });
    expect(follower).toEqual({ outcome: "not_leader" });
    expect(leaderInspector.getJobCounts).toHaveBeenCalledOnce();
    expect(followerInspector.getJobCounts).not.toHaveBeenCalled();
    expect(followerInspector.getJobs).not.toHaveBeenCalled();
  });

  it("reads the identifier-free exception aggregate only for the queue-lease owner", async () => {
    const leaderExceptionQueue = {
      observeExceptionQueue: vi.fn(async () => ({
        queueState: "nonempty" as const,
        oldestAgeSeconds: 120,
      })),
    };
    const followerExceptionQueue = {
      observeExceptionQueue: vi.fn(async () => ({ queueState: "empty" as const })),
    };
    await expect(
      observeDurableQueueAndExceptionOnce({
        inspector: inspector().value,
        leaseStore: { eval: async () => 1 },
        leaseKey: "reconai-test-durable:observability:lease:v1",
        leaseToken: "leader-token-0002",
        leaseTtlMs: 45_000,
        now: new Date("2026-07-29T00:01:00.000Z"),
        exceptionQueue: leaderExceptionQueue,
      }),
    ).resolves.toMatchObject({ outcome: "recorded" });
    await expect(
      observeDurableQueueAndExceptionOnce({
        inspector: inspector().value,
        leaseStore: { eval: async () => 0 },
        leaseKey: "reconai-test-durable:observability:lease:v1",
        leaseToken: "follower-token-02",
        leaseTtlMs: 45_000,
        now: new Date("2026-07-29T00:01:00.000Z"),
        exceptionQueue: followerExceptionQueue,
      }),
    ).resolves.toEqual({ outcome: "not_leader" });
    expect(leaderExceptionQueue.observeExceptionQueue).toHaveBeenCalledOnce();
    expect(followerExceptionQueue.observeExceptionQueue).not.toHaveBeenCalled();
  });

  it("preserves a leader database failure without allowing a stale exception snapshot", async () => {
    await expect(
      observeDurableQueueAndExceptionOnce({
        inspector: inspector().value,
        leaseStore: { eval: async () => 1 },
        leaseKey: "reconai-test-durable:observability:lease:v1",
        leaseToken: "leader-token-0003",
        leaseTtlMs: 45_000,
        now: new Date("2026-07-29T00:01:00.000Z"),
        exceptionQueue: {
          observeExceptionQueue: async () => {
            throw new Error("synthetic database observer failure");
          },
        },
      }),
    ).rejects.toThrow("synthetic database observer failure");
  });

  it("reads both fixed provider active-sync aggregates only for the queue-lease owner", async () => {
    const leaderProviderActiveSyncs = {
      observeProviderActiveSyncs: vi.fn(async () => [
        {
          provider: "shopify" as const,
          activityState: "active" as const,
          syncStatus: "running" as const,
          oldestAgeSeconds: 120,
        },
        { provider: "stripe" as const, activityState: "empty" as const },
      ]),
    };
    const followerProviderActiveSyncs = {
      observeProviderActiveSyncs: vi.fn(async () => [
        { provider: "shopify" as const, activityState: "empty" as const },
        { provider: "stripe" as const, activityState: "empty" as const },
      ]),
    };
    await expect(
      observeLeasedOperationalTelemetryOnce({
        inspector: inspector().value,
        leaseStore: { eval: async () => 1 },
        leaseKey: "reconai-test-durable:observability:lease:v1",
        leaseToken: "leader-token-0004",
        leaseTtlMs: 45_000,
        now: new Date("2026-07-29T00:01:00.000Z"),
        providerActiveSyncs: leaderProviderActiveSyncs,
      }),
    ).resolves.toMatchObject({ outcome: "recorded" });
    await expect(
      observeLeasedOperationalTelemetryOnce({
        inspector: inspector().value,
        leaseStore: { eval: async () => 0 },
        leaseKey: "reconai-test-durable:observability:lease:v1",
        leaseToken: "follower-token-04",
        leaseTtlMs: 45_000,
        now: new Date("2026-07-29T00:01:00.000Z"),
        providerActiveSyncs: followerProviderActiveSyncs,
      }),
    ).resolves.toEqual({ outcome: "not_leader" });
    expect(leaderProviderActiveSyncs.observeProviderActiveSyncs).toHaveBeenCalledOnce();
    expect(followerProviderActiveSyncs.observeProviderActiveSyncs).not.toHaveBeenCalled();
  });

  it("propagates a provider active-sync database failure and clears its snapshot", async () => {
    await expect(
      observeLeasedOperationalTelemetryOnce({
        inspector: inspector().value,
        leaseStore: { eval: async () => 1 },
        leaseKey: "reconai-test-durable:observability:lease:v1",
        leaseToken: "leader-token-0005",
        leaseTtlMs: 45_000,
        now: new Date("2026-07-29T00:01:00.000Z"),
        providerActiveSyncs: {
          observeProviderActiveSyncs: async () => {
            throw new Error("synthetic provider active-sync observer failure");
          },
        },
      }),
    ).rejects.toThrow("synthetic provider active-sync observer failure");
  });

  it("keeps scheduled execution single-flight and releases only its own lease on close", async () => {
    let resolveCounts: ((value: typeof fixedCounts) => void) | undefined;
    const counts = new Promise<typeof fixedCounts>((resolve) => {
      resolveCounts = resolve;
    });
    const getJobCounts = vi.fn(async () => counts);
    const leaseStore = inMemoryLeaseStore();
    const monitor = startDurableQueueMonitor({
      inspector: {
        getJobCounts,
        getJobs: async () => [],
      },
      leaseStore,
      queueName: "reconai-test-durable",
      environment: "test",
      intervalMs: 300_000,
      leaseToken: "single-flight-token",
      exceptionQueue: {
        observeExceptionQueue: async () => ({ queueState: "empty" }),
      },
      providerActiveSyncs: {
        observeProviderActiveSyncs: async () => [
          { provider: "shopify", activityState: "empty" },
          { provider: "stripe", activityState: "empty" },
        ],
      },
    });
    await Promise.resolve();
    await monitor.runNow();
    expect(getJobCounts).toHaveBeenCalledOnce();
    resolveCounts?.(fixedCounts);
    await monitor.close();
    expect(leaseStore.current()).toBeUndefined();
  });

  it("derives a bounded environment-scoped lease policy", () => {
    expect(durableQueueMonitorLeaseKey("reconai-production-durable")).toBe(
      "reconai-production-durable:observability:lease:v1",
    );
    expect(durableQueueMonitorLeaseTtlMs(1_000)).toBe(5_000);
    expect(durableQueueMonitorLeaseTtlMs(15_000)).toBe(45_000);
    expect(durableQueueMonitorLeaseTtlMs(300_000)).toBe(900_000);
    expect(() => durableQueueMonitorLeaseTtlMs(999)).toThrow();
    expect(() => durableQueueMonitorLeaseKey("tenant id/payload")).toThrow();
  });
});

function inspector(): {
  readonly value: DurableQueueInspector;
  readonly getJobCounts: ReturnType<typeof vi.fn>;
  readonly getJobs: ReturnType<typeof vi.fn>;
} {
  const getJobCounts = vi.fn(async () => fixedCounts);
  const getJobs = vi.fn(async () => []);
  return { value: { getJobCounts, getJobs }, getJobCounts, getJobs };
}

function inMemoryLeaseStore(): DurableQueueLeaseStore & { current(): string | undefined } {
  let current: string | undefined;
  return {
    eval: async (script, _numberOfKeys, ...args) => {
      const token = String(args[1]);
      if (script.includes('"SET"')) {
        if (current === undefined || current === token) {
          current = token;
          return 1;
        }
        return 0;
      }
      if (script.includes('"DEL"') && current === token) {
        current = undefined;
        return 1;
      }
      return 0;
    },
    current: () => current,
  };
}
