import { describe, expect, it } from "vitest";

import { classifyProviderPrivacyDeadlineStage } from "./provider-privacy-deadline-alerts.js";

const dueAt = "2026-08-27T02:00:00.000Z";

describe("provider privacy deadline escalation thresholds", () => {
  it("does not create a signal before the final seven-day window", () => {
    expect(classifyProviderPrivacyDeadlineStage(dueAt, "2026-08-20T01:59:59.999Z")).toBeUndefined();
  });

  it("uses exact seven-day and 24-hour boundary stages", () => {
    expect(classifyProviderPrivacyDeadlineStage(dueAt, "2026-08-20T02:00:00.000Z")).toBe(
      "due_7_days",
    );
    expect(classifyProviderPrivacyDeadlineStage(dueAt, "2026-08-26T01:59:59.999Z")).toBe(
      "due_7_days",
    );
    expect(classifyProviderPrivacyDeadlineStage(dueAt, "2026-08-26T02:00:00.000Z")).toBe(
      "due_24_hours",
    );
  });

  it("marks the exact deadline and every later observation overdue", () => {
    expect(classifyProviderPrivacyDeadlineStage(dueAt, dueAt)).toBe("overdue");
    expect(classifyProviderPrivacyDeadlineStage(dueAt, "2026-08-28T02:00:00.000Z")).toBe("overdue");
  });
});
