import type { ProviderPrivacyDeadlineAlertScanInput } from "@workspace/database";
import { describe, expect, it, vi } from "vitest";

import {
  executeProviderPrivacyDeadlineScan,
  startProviderPrivacyDeadlineMonitor,
  type ProviderPrivacyDeadlineMonitorRepository,
} from "./provider-privacy-deadline-monitor.js";

describe("provider privacy deadline monitor", () => {
  it("forwards one bounded deterministic scan to the repository", async () => {
    const scanDueDeadlineAlerts = vi.fn(
      async () =>
        ({
          examined: 3,
          created: 3,
          skipped: 0,
          due7Days: 1,
          due24Hours: 1,
          overdue: 1,
        }) as const,
    );
    const repository: ProviderPrivacyDeadlineMonitorRepository = { scanDueDeadlineAlerts };

    await expect(
      executeProviderPrivacyDeadlineScan({
        repository,
        now: new Date("2026-07-28T02:30:00.000Z"),
        batchSize: 100,
      }),
    ).resolves.toEqual({
      examined: 3,
      created: 3,
      skipped: 0,
      due7Days: 1,
      due24Hours: 1,
      overdue: 1,
    });
    expect(scanDueDeadlineAlerts).toHaveBeenCalledWith({
      now: "2026-07-28T02:30:00.000Z",
      batchSize: 100,
    } satisfies ProviderPrivacyDeadlineAlertScanInput);
  });

  it("rejects unsafe cadence and batch bounds before creating a timer", () => {
    const repository: ProviderPrivacyDeadlineMonitorRepository = {
      scanDueDeadlineAlerts: async () => ({
        examined: 0,
        created: 0,
        skipped: 0,
        due7Days: 0,
        due24Hours: 0,
        overdue: 0,
      }),
    };
    expect(() =>
      startProviderPrivacyDeadlineMonitor({
        repository,
        environment: "test",
        intervalMs: 59_999,
        batchSize: 100,
      }),
    ).toThrow("between one minute and one day");
    expect(() =>
      startProviderPrivacyDeadlineMonitor({
        repository,
        environment: "test",
        intervalMs: 900_000,
        batchSize: 501,
      }),
    ).toThrow("between 1 and 500");
  });
});
