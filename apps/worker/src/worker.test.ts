import { describe, expect, it, vi } from "vitest";

import {
  DurableJobEnvelopeSchema,
  ConnectorError,
  ReconciliationRunJobEnvelopeSchema,
  durableJobId,
  retryDelayMs,
} from "@workspace/connectors";

import { authorizeQueuedDurableJob, durableJobRetryDelayMs } from "./worker.js";

const reconciliationEnvelope = ReconciliationRunJobEnvelopeSchema.parse({
  schemaVersion: 1,
  type: "reconciliation.run.requested",
  organizationId: "00000000-0000-4000-8000-000000000001",
  runId: "00000000-0000-4000-8000-000000000002",
  executionAttempt: 1,
  correlationId: "00000000-0000-4000-8000-000000000003",
  idempotencyKey: "reconciliation-run:test:dispatch:1",
  requestedBy: "00000000-0000-4000-8000-000000000004",
  createdAt: "2026-07-27T12:00:00.000Z",
  traceContext: {
    schemaVersion: 1,
    traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
  },
});

describe("worker safety boundary", () => {
  it("rejects a job without tenant context", () => {
    expect(
      DurableJobEnvelopeSchema.safeParse({
        schemaVersion: 1,
        type: "connector.webhook.received",
      }).success,
    ).toBe(false);
  });

  it("accepts only bounded reconciliation execution authority", () => {
    expect(ReconciliationRunJobEnvelopeSchema.safeParse(reconciliationEnvelope).success).toBe(true);
  });

  it("honors trace context only after the complete queue envelope matches outbox authority", async () => {
    const loadAuthority = vi.fn(async () => reconciliationEnvelope);
    await expect(
      authorizeQueuedDurableJob({
        data: reconciliationEnvelope,
        jobId: durableJobId(reconciliationEnvelope),
        loadAuthority,
      }),
    ).resolves.toEqual(reconciliationEnvelope);
    expect(loadAuthority).toHaveBeenCalledWith(reconciliationEnvelope);

    const forged = ReconciliationRunJobEnvelopeSchema.parse({
      ...reconciliationEnvelope,
      traceContext: {
        schemaVersion: 1,
        traceparent: "00-fedcba9876543210fedcba9876543210-fedcba9876543210-01",
      },
    });
    await expect(
      authorizeQueuedDurableJob({
        data: forged,
        jobId: durableJobId(forged),
        loadAuthority: async () => reconciliationEnvelope,
      }),
    ).rejects.toThrow("does not match its tenant-bound outbox authority");
  });

  it("does not query outbox authority for an invalid queue identity", async () => {
    const loadAuthority = vi.fn(async () => reconciliationEnvelope);
    await expect(
      authorizeQueuedDurableJob({
        data: reconciliationEnvelope,
        jobId: "forged-queue-id",
        loadAuthority,
      }),
    ).rejects.toThrow("identity does not match");
    expect(loadAuthority).not.toHaveBeenCalled();
  });

  it("keeps exponential retries bounded", () => {
    const delays = Array.from({ length: 20 }, (_, index) => retryDelayMs(index + 1));
    expect(Math.max(...delays)).toBeLessThanOrEqual(60_000);
    expect(delays[1]).toBeGreaterThan(delays[0] ?? 0);
  });

  it("honors bounded provider retry-after guidance without trusting arbitrary values", () => {
    expect(
      durableJobRetryDelayMs(
        1,
        new ConnectorError("rate_limited", "synthetic rate limit", 120_000),
      ),
    ).toBe(120_000);
    expect(
      durableJobRetryDelayMs(
        1,
        new ConnectorError("provider_unavailable", "synthetic cooldown", 3_600_000),
      ),
    ).toBe(900_000);
    expect(durableJobRetryDelayMs(2, { retryAfterMs: Number.NaN })).toBe(retryDelayMs(2));
    expect(durableJobRetryDelayMs(2, { retryAfterMs: "customer-controlled" })).toBe(
      retryDelayMs(2),
    );
  });
});
