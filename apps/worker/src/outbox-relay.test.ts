import { OrganizationIdSchema } from "@workspace/domain";
import type { OutboxRelayRepository, PendingOutboxEvent } from "@workspace/database";
import { describe, expect, it } from "vitest";

import { relayOutboxBatch } from "./outbox-relay.js";

const organizationId = OrganizationIdSchema.parse("91000000-0000-4000-8000-000000000001");
const validPayload = {
  schemaVersion: 1,
  type: "csv.import.commit",
  organizationId,
  connectionId: "92000000-0000-4000-8000-000000000001",
  importId: "93000000-0000-4000-8000-000000000001",
  correlationId: "94000000-0000-4000-8000-000000000001",
  idempotencyKey: "csv-import:relay-test:commit:v1",
  requestedBy: "95000000-0000-4000-8000-000000000001",
  createdAt: "2026-07-27T12:00:00.000Z",
} as const;

describe("transactional outbox relay", () => {
  it("publishes a valid tenant-bound envelope and records success", async () => {
    const repository = new MemoryRelayRepository([
      pending(validPayload.idempotencyKey, validPayload),
    ]);
    const published: unknown[] = [];
    const result = await relayOutboxBatch(
      repository,
      {
        publish: async (envelope) => {
          published.push(envelope);
        },
      },
      new Date("2026-07-27T12:00:00.000Z"),
    );

    expect(result).toEqual({ examined: 1, published: 1, retried: 0, deadLettered: 0 });
    expect(published).toEqual([validPayload]);
    expect(repository.published).toEqual([validPayload.idempotencyKey]);
  });

  it("dead-letters invalid authority and bounds dispatch retries", async () => {
    const invalid = pending("forged-idempotency", validPayload);
    const exhausted = { ...pending(validPayload.idempotencyKey, validPayload), attempts: 5 };
    const repository = new MemoryRelayRepository([invalid, exhausted]);
    const result = await relayOutboxBatch(
      repository,
      {
        publish: async () => {
          throw new Error("synthetic queue outage");
        },
      },
      new Date("2026-07-27T12:00:00.000Z"),
    );

    expect(result).toEqual({ examined: 2, published: 0, retried: 0, deadLettered: 2 });
    expect(repository.failures).toEqual([
      { key: "forged-idempotency", code: "OUTBOX_SCHEMA_INVALID", maximumAttempts: 1 },
      {
        key: validPayload.idempotencyKey,
        code: "QUEUE_DISPATCH_FAILED",
        maximumAttempts: 6,
      },
    ]);
  });
});

function pending(idempotencyKey: string, payload: unknown): PendingOutboxEvent {
  return {
    organizationId,
    eventType: "csv.import.commit",
    idempotencyKey,
    payload,
    attempts: 0,
  };
}

class MemoryRelayRepository implements OutboxRelayRepository {
  public readonly published: string[] = [];
  public readonly failures: {
    readonly key: string;
    readonly code: string;
    readonly maximumAttempts: number;
  }[] = [];

  public constructor(private readonly events: readonly PendingOutboxEvent[]) {}

  public async loadPending(): Promise<readonly PendingOutboxEvent[]> {
    return this.events;
  }

  public async markPublished(
    _organizationId: typeof organizationId,
    idempotencyKey: string,
  ): Promise<boolean> {
    this.published.push(idempotencyKey);
    return true;
  }

  public async markFailed(
    _organizationId: typeof organizationId,
    idempotencyKey: string,
    errorCode: string,
    _nextAttemptAt: string,
    maximumAttempts: number,
  ): Promise<boolean> {
    this.failures.push({ key: idempotencyKey, code: errorCode, maximumAttempts });
    return true;
  }
}
