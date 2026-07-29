import {
  ConnectorError,
  ProviderSyncJobEnvelopeSchema,
  type ProviderPageRequest,
  type ProviderPageSource,
  type ProviderSyncJobEnvelope,
} from "@workspace/connectors";
import { OrganizationIdSchema } from "@workspace/domain";
import { describe, expect, it, vi } from "vitest";

import {
  ProviderSyncService,
  ProviderSyncTerminalError,
  type ProviderRequestCircuit,
  type ProviderRequestCircuitAcquireResult,
  type ProviderRequestCircuitInput,
  type ProviderSyncEventReceiver,
  type ProviderSyncRepository,
  type ProviderSyncRunAuthority,
} from "./provider-sync.js";

const organizationId = OrganizationIdSchema.parse("91000000-0000-4000-8000-000000000001");
const connectionId = "92000000-0000-4000-8000-000000000001";
const runId = "93000000-0000-4000-8000-000000000001";
const correlationId = "94000000-0000-4000-8000-000000000001";
const requesterId = "95000000-0000-4000-8000-000000000001";
const traceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";

describe("bounded provider sync execution", () => {
  it("advances a cursor, stages each item, and counts immutable duplicates", async () => {
    const repository = new MemoryProviderSyncRepository(authority({ maximumPages: 3 }));
    const requestCircuit = new RecordingProviderRequestCircuit();
    const requests: ProviderPageRequest[] = [];
    const source: ProviderPageSource = {
      provider: "stripe",
      fetchPage: async (request) => {
        requests.push(request);
        if (!request.cursor) {
          return {
            items: [stripeItem("evt_page_1", "pi_page_1")],
            hasMore: true,
            nextCursor: "evt_page_1",
          };
        }
        return {
          items: [stripeItem("evt_duplicate", "pi_duplicate")],
          hasMore: false,
        };
      },
    };
    const received: Parameters<ProviderSyncEventReceiver["receiveSyncItem"]>[0][] = [];
    const receiver: ProviderSyncEventReceiver = {
      receiveSyncItem: async (input) => {
        received.push(input);
        return {
          duplicate: input.externalEventId === "evt_duplicate",
          eventId: input.externalEventId,
          status: "queued",
        };
      },
    };
    const service = new ProviderSyncService({
      repository,
      providerEvents: receiver,
      sources: [source],
      requestCircuit,
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });

    await expect(service.process(envelope(), { traceparent })).resolves.toEqual({
      status: "succeeded",
      pagesProcessed: 2,
      itemsStaged: 2,
      duplicates: 1,
    });
    expect(requests.map((request) => request.cursor)).toEqual([undefined, "evt_page_1"]);
    expect(received.map((input) => input.externalEventId)).toEqual(["evt_page_1", "evt_duplicate"]);
    expect(received.every((input) => input.traceparent === traceparent)).toBe(true);
    expect(repository.run).toMatchObject({
      status: "succeeded",
      pageCount: 2,
      itemCount: 2,
      duplicateCount: 1,
    });
    expect(requestCircuit.acquisitions).toHaveLength(2);
    expect(requestCircuit.successes).toHaveLength(2);
    expect(requestCircuit.failures).toHaveLength(0);
  });

  it("stops as partial at the explicit page ceiling", async () => {
    const repository = new MemoryProviderSyncRepository(authority({ maximumPages: 1 }));
    const service = new ProviderSyncService({
      repository,
      providerEvents: receiverWithoutDuplicates(),
      sources: [
        {
          provider: "stripe",
          fetchPage: async () => ({
            items: [stripeItem("evt_limit_1", "pi_limit_1")],
            hasMore: true,
            nextCursor: "evt_limit_1",
          }),
        },
      ],
      requestCircuit: new RecordingProviderRequestCircuit(),
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });

    await expect(service.process(envelope())).resolves.toMatchObject({
      status: "partial",
      pagesProcessed: 1,
      itemsStaged: 1,
    });
    expect(repository.run.status).toBe("partial");
  });

  it("admits one empty source-phase transition and reacquires the circuit for the next request", async () => {
    const repository = new MemoryProviderSyncRepository(authority({ maximumPages: 2 }));
    const requestCircuit = new RecordingProviderRequestCircuit();
    const requests: ProviderPageRequest[] = [];
    const received: Parameters<ProviderSyncEventReceiver["receiveSyncItem"]>[0][] = [];
    const service = new ProviderSyncService({
      repository,
      providerEvents: {
        receiveSyncItem: async (input) => {
          received.push(input);
          return { duplicate: false, eventId: input.externalEventId, status: "queued" };
        },
      },
      sources: [
        {
          provider: "stripe",
          fetchPage: async (request) => {
            requests.push(request);
            return request.cursor
              ? { items: [balanceItem("txn_phasefee")], hasMore: false }
              : {
                  items: [],
                  hasMore: true,
                  nextCursor: "stripe-v2:balance:start",
                  continuationKind: "source_phase",
                };
          },
        },
      ],
      requestCircuit,
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });

    await expect(service.process(envelope())).resolves.toEqual({
      status: "succeeded",
      pagesProcessed: 2,
      itemsStaged: 1,
      duplicates: 0,
    });
    expect(requests.map((request) => request.cursor)).toEqual([
      undefined,
      "stripe-v2:balance:start",
    ]);
    expect(received.map((input) => input.externalEventId)).toEqual(["txn_phasefee"]);
    expect(repository.run).toMatchObject({
      status: "succeeded",
      pageCount: 2,
      itemCount: 1,
    });
    expect(requestCircuit.acquisitions).toHaveLength(2);
    expect(requestCircuit.successes).toHaveLength(2);
  });

  it("records a terminal failure when a provider cursor does not advance", async () => {
    const repository = new MemoryProviderSyncRepository(
      authority({ cursor: "evt_stuck", maximumPages: 3 }),
    );
    const requestCircuit = new RecordingProviderRequestCircuit();
    const service = new ProviderSyncService({
      repository,
      providerEvents: receiverWithoutDuplicates(),
      sources: [
        {
          provider: "stripe",
          fetchPage: async () => ({
            items: [stripeItem("evt_item_1", "pi_item_1")],
            hasMore: true,
            nextCursor: "evt_stuck",
          }),
        },
      ],
      requestCircuit,
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });

    await expect(service.process(envelope())).rejects.toMatchObject({
      name: ProviderSyncTerminalError.name,
      code: "PROVIDER_SYNC_PAYLOAD_INVALID",
    });
    expect(repository.run).toMatchObject({
      status: "failed",
      failedAttempts: 1,
    });
    expect(requestCircuit.successes).toHaveLength(1);
    expect(requestCircuit.failures).toHaveLength(0);
  });

  it("rejects an empty ordinary nonterminal page", async () => {
    const repository = new MemoryProviderSyncRepository(authority({ maximumPages: 2 }));
    const service = new ProviderSyncService({
      repository,
      providerEvents: receiverWithoutDuplicates(),
      sources: [
        {
          provider: "stripe",
          fetchPage: async () => ({
            items: [],
            hasMore: true,
            nextCursor: "evt_empty",
          }),
        },
      ],
      requestCircuit: new RecordingProviderRequestCircuit(),
    });

    await expect(service.process(envelope())).rejects.toMatchObject({
      name: ProviderSyncTerminalError.name,
      code: "PROVIDER_SYNC_PAYLOAD_INVALID",
    });
  });

  it("leaves a transient provider failure retryable before the attempt ceiling", async () => {
    const repository = new MemoryProviderSyncRepository(authority());
    const requestCircuit = new RecordingProviderRequestCircuit();
    const service = new ProviderSyncService({
      repository,
      providerEvents: receiverWithoutDuplicates(),
      sources: [
        {
          provider: "stripe",
          fetchPage: async () => {
            throw new ConnectorError("rate_limited", "synthetic rate limit", 1_000);
          },
        },
      ],
      requestCircuit,
    });

    await expect(service.process(envelope())).rejects.toMatchObject({
      kind: "rate_limited",
    });
    expect(repository.run).toMatchObject({
      status: "running",
      failedAttempts: 1,
    });
    expect(requestCircuit.failures).toEqual([
      expect.objectContaining({
        forceOpen: true,
        retryAfterMs: 1_000,
      }),
    ]);
  });

  it("does not contact a provider while its distributed circuit is open", async () => {
    const repository = new MemoryProviderSyncRepository(authority());
    const fetchPage = vi.fn(async () => ({
      items: [stripeItem("evt_forbidden", "pi_forbidden")],
      hasMore: false,
    }));
    const service = new ProviderSyncService({
      repository,
      providerEvents: receiverWithoutDuplicates(),
      sources: [{ provider: "stripe", fetchPage }],
      requestCircuit: new RecordingProviderRequestCircuit({
        outcome: "open",
        retryAfterMs: 120_000,
      }),
    });

    await expect(service.process(envelope())).rejects.toMatchObject({
      name: ConnectorError.name,
      kind: "provider_unavailable",
      retryAfterMs: 120_000,
    });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(repository.run).toMatchObject({
      status: "running",
      failedAttempts: 1,
    });
  });

  it("fails provider admission closed when the circuit store is unavailable", async () => {
    const repository = new MemoryProviderSyncRepository(authority());
    const fetchPage = vi.fn(async () => ({
      items: [stripeItem("evt_forbidden", "pi_forbidden")],
      hasMore: false,
    }));
    const requestCircuit = new RecordingProviderRequestCircuit();
    requestCircuit.acquire = vi.fn(async () => {
      throw new Error("synthetic circuit store outage");
    });
    const service = new ProviderSyncService({
      repository,
      providerEvents: receiverWithoutDuplicates(),
      sources: [{ provider: "stripe", fetchPage }],
      requestCircuit,
    });

    await expect(service.process(envelope())).rejects.toThrow("synthetic circuit store outage");
    expect(fetchPage).not.toHaveBeenCalled();
    expect(repository.run).toMatchObject({
      status: "running",
      failedAttempts: 1,
    });
  });
});

function envelope(): ProviderSyncJobEnvelope {
  return ProviderSyncJobEnvelopeSchema.parse({
    schemaVersion: 1,
    type: "connector.sync.requested",
    organizationId,
    connectionId,
    provider: "stripe",
    syncRunId: runId,
    executionAttempt: 1,
    correlationId,
    idempotencyKey: `stripe:sync:${runId}:dispatch:1`,
    requestedBy: requesterId,
    createdAt: "2026-07-27T11:00:00.000Z",
  });
}

function authority(overrides: Partial<ProviderSyncRunAuthority> = {}): ProviderSyncRunAuthority {
  return {
    runId,
    organizationId,
    connectionId,
    provider: "stripe",
    externalAccountId: "acct_synthetic",
    apiCredentialReference: "env:RECONAI_CONNECTOR_STRIPE_READ_TEST",
    configuredApiVersion: "2025-06-30.basil",
    mode: "gap_repair",
    windowStart: "2026-07-26T00:00:00.000Z",
    windowEnd: "2026-07-27T00:00:00.000Z",
    status: "queued",
    pageCount: 0,
    itemCount: 0,
    duplicateCount: 0,
    maximumPages: 2,
    failedAttempts: 0,
    requesterType: "user",
    requestedBy: requesterId,
    correlationId,
    ...overrides,
  };
}

function stripeItem(eventId: string, objectId: string) {
  return {
    eventType: "payment_intent.succeeded",
    externalEventId: eventId,
    externalObjectId: objectId,
    sourceTimestamp: "2026-07-26T12:00:00.000Z",
    apiVersion: "2025-06-30.basil",
    rawBody: Buffer.from(
      JSON.stringify({
        id: eventId,
        object: "event",
        created: 1_774_783_200,
        api_version: "2025-06-30.basil",
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: objectId,
            object: "payment_intent",
            amount: 1_000,
            amount_received: 1_000,
            currency: "usd",
            status: "succeeded",
            metadata: {},
          },
        },
      }),
    ),
  };
}

function balanceItem(transactionId: string) {
  return {
    eventType: "balance_transaction.snapshot",
    externalEventId: transactionId,
    externalObjectId: transactionId,
    sourceTimestamp: "2026-07-26T12:00:00.000Z",
    apiVersion: "2025-06-30.basil",
    rawBody: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        object: "reconai.stripe_balance_transaction_snapshot",
        apiVersion: "2025-06-30.basil",
        balanceTransaction: { id: transactionId },
      }),
    ),
  };
}

function receiverWithoutDuplicates(): ProviderSyncEventReceiver {
  return {
    receiveSyncItem: async (input) => ({
      duplicate: false,
      eventId: input.externalEventId,
      status: "queued",
    }),
  };
}

class RecordingProviderRequestCircuit implements ProviderRequestCircuit {
  public readonly acquisitions: ProviderRequestCircuitInput[] = [];
  public readonly successes: Parameters<ProviderRequestCircuit["recordSuccess"]>[0][] = [];
  public readonly failures: Parameters<ProviderRequestCircuit["recordTransientFailure"]>[0][] = [];

  public constructor(
    private readonly acquireResult: ProviderRequestCircuitAcquireResult = {
      outcome: "permitted",
      permit: { state: "closed", token: "synthetic-circuit-permit" },
    },
  ) {}

  public async acquire(
    input: ProviderRequestCircuitInput,
  ): Promise<ProviderRequestCircuitAcquireResult> {
    this.acquisitions.push(input);
    return this.acquireResult;
  }

  public async recordSuccess(
    input: Parameters<ProviderRequestCircuit["recordSuccess"]>[0],
  ): Promise<void> {
    this.successes.push(input);
  }

  public async recordTransientFailure(
    input: Parameters<ProviderRequestCircuit["recordTransientFailure"]>[0],
  ): Promise<void> {
    this.failures.push(input);
  }
}

class MemoryProviderSyncRepository implements ProviderSyncRepository {
  public constructor(public run: ProviderSyncRunAuthority) {}

  public async loadForProcessing(
    requestedEnvelope: ProviderSyncJobEnvelope,
  ): Promise<ProviderSyncRunAuthority | undefined> {
    if (requestedEnvelope.syncRunId !== this.run.runId) return undefined;
    if (this.run.status === "queued") this.run = { ...this.run, status: "running" };
    return this.run;
  }

  public async advancePage(
    _requestedEnvelope: ProviderSyncJobEnvelope,
    input: {
      readonly expectedCursor?: string;
      readonly nextCursor?: string;
      readonly hasMore: boolean;
      readonly itemCount: number;
      readonly duplicateCount: number;
      readonly completedAt: string;
    },
  ): Promise<ProviderSyncRunAuthority> {
    expect(input.expectedCursor).toBe(this.run.cursor);
    const reachesLimit = input.hasMore && this.run.pageCount + 1 >= this.run.maximumPages;
    const { cursor: _currentCursor, ...runWithoutCursor } = this.run;
    void _currentCursor;
    this.run = {
      ...runWithoutCursor,
      ...(input.hasMore && input.nextCursor ? { cursor: input.nextCursor } : {}),
      status: reachesLimit ? "partial" : input.hasMore ? "running" : "succeeded",
      pageCount: this.run.pageCount + 1,
      itemCount: this.run.itemCount + input.itemCount,
      duplicateCount: this.run.duplicateCount + input.duplicateCount,
    };
    return this.run;
  }

  public async recordFailure(
    _requestedEnvelope: ProviderSyncJobEnvelope,
    input: {
      readonly errorCode: string;
      readonly terminalRequested: boolean;
      readonly failedAt: string;
    },
  ): Promise<{ readonly terminal: boolean }> {
    const failedAttempts = this.run.failedAttempts + 1;
    const terminal = input.terminalRequested || failedAttempts >= 6;
    this.run = {
      ...this.run,
      status: terminal ? "failed" : "running",
      failedAttempts,
    };
    return { terminal };
  }
}
