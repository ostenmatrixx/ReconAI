import type { ScheduledProviderGapRepairInput } from "@workspace/database";
import { describe, expect, it, vi } from "vitest";

import {
  executeProviderGapRepairScan,
  startProviderGapRepairScheduler,
  type ProviderGapRepairSchedulerRepository,
} from "./provider-gap-repair-scheduler.js";

describe("provider gap repair scheduler", () => {
  it("forwards one bounded deterministic scan to the repository", async () => {
    const result = {
      examined: 2,
      scheduled: 1,
      skipped: 1,
      candidateObservations: [
        {
          provider: "shopify",
          freshnessReference: "never_succeeded",
          disposition: "scheduled",
        },
        {
          provider: "stripe",
          freshnessReference: "last_successful_sync",
          disposition: "skipped",
          ageSeconds: 3_600,
        },
      ],
    } as const;
    const scheduleDueGapRepairs = vi.fn(async () => result);
    const repository: ProviderGapRepairSchedulerRepository = { scheduleDueGapRepairs };

    await expect(
      executeProviderGapRepairScan({
        repository,
        now: new Date("2026-07-27T12:07:00.000Z"),
        intervalMs: 900_000,
        lookbackMs: 86_400_000,
        overlapMs: 300_000,
        maximumPages: 5,
        batchSize: 25,
      }),
    ).resolves.toEqual(result);
    expect(scheduleDueGapRepairs).toHaveBeenCalledWith({
      now: "2026-07-27T12:07:00.000Z",
      cadenceMs: 900_000,
      lookbackMs: 86_400_000,
      overlapMs: 300_000,
      maximumPages: 5,
      batchSize: 25,
    } satisfies ScheduledProviderGapRepairInput);
  });

  it("preserves a repository scan failure for the scheduler error path", async () => {
    const repository: ProviderGapRepairSchedulerRepository = {
      scheduleDueGapRepairs: async () => {
        throw new Error("synthetic bounded scan failure");
      },
    };

    await expect(
      executeProviderGapRepairScan({
        repository,
        now: new Date("2026-07-27T12:07:00.000Z"),
        intervalMs: 900_000,
        lookbackMs: 86_400_000,
        overlapMs: 300_000,
        maximumPages: 5,
        batchSize: 25,
      }),
    ).rejects.toThrow("synthetic bounded scan failure");
  });

  it("rejects unsafe scheduling bounds before creating a timer", () => {
    const repository: ProviderGapRepairSchedulerRepository = {
      scheduleDueGapRepairs: async () => ({
        examined: 0,
        scheduled: 0,
        skipped: 0,
        candidateObservations: [],
      }),
    };
    expect(() =>
      startProviderGapRepairScheduler({
        repository,
        environment: "test",
        intervalMs: 59_999,
        lookbackMs: 86_400_000,
        overlapMs: 300_000,
        maximumPages: 5,
        batchSize: 25,
      }),
    ).toThrow("between one minute and one day");
    expect(() =>
      startProviderGapRepairScheduler({
        repository,
        environment: "test",
        intervalMs: 900_000,
        lookbackMs: 300_000,
        overlapMs: 300_000,
        maximumPages: 5,
        batchSize: 25,
      }),
    ).toThrow("overlap is invalid");
  });
});
