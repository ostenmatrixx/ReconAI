import { createHash, randomUUID } from "node:crypto";

import type { SourceObjectFamily } from "@workspace/connectors";
import type {
  SourceEventClassificationRepairCandidate,
  SourceEventClassificationRepairGapCounts,
  SourceEventClassificationRepairProcessResult,
  SourceEventClassificationRepairRepository,
} from "@workspace/database";
import { OrganizationIdSchema } from "@workspace/domain";
import {
  InMemoryImmutableObjectStore,
  ObjectReadTimeoutError,
  type ImmutableObjectStore,
} from "@workspace/object-storage";
import { describe, expect, it } from "vitest";

import { executeSourceEventClassificationRepairBatch } from "./source-event-classification-repair.js";

describe("source-event classification repair", () => {
  it("replays exact provider classification and reuses one verified CSV object", async () => {
    const shopify = candidate("shopify", "orders/snapshot", "shopify.json");
    const stripe = candidate("stripe", "refund.updated", "stripe.json");
    const csvA = candidate("accounting_csv", "accounting_entry", "ledger.csv");
    const csvB = {
      ...candidate("accounting_csv", "accounting_entry", "ledger.csv"),
      objectKey: csvA.objectKey,
      payloadSha256: csvA.payloadSha256,
    };
    const repository = new FakeRepairRepository([shopify, stripe, csvA, csvB]);
    const store = new CountingObjectStore();
    await put(store, shopify, shopifySnapshot(true));
    await put(store, stripe, stripeRefund());
    await put(store, csvA, Buffer.from("id,amount\\n1,10.00\\n"));

    const result = await executeSourceEventClassificationRepairBatch({
      repository,
      objectStore: store,
      requestedBy: "classification-repair-test",
      reason: "Repair integrity-verified legacy source classifications",
      batchSize: 10,
      repairRunId: randomUUID(),
      now: () => new Date("2026-07-29T08:00:00.000Z"),
    });

    expect(result).toMatchObject({
      examined: 4,
      classified: 4,
      alreadyClassified: 0,
      remainingGaps: 0,
      remainingRepairableGaps: 0,
      complete: true,
    });
    expect(repository.families).toEqual([
      ["order", "refund_transaction"],
      ["refund"],
      ["csv_row"],
      ["csv_row"],
    ]);
    expect(store.reads).toBe(3);
    expect(store.readTimeouts).toEqual([15_000, 15_000, 15_000]);
  });

  it("fails closed on missing, corrupt, and unsupported immutable payloads", async () => {
    const missing = candidate("shopify", "orders/create", "missing.json");
    await expect(runOne(missing, new InMemoryImmutableObjectStore())).rejects.toMatchObject({
      code: "SOURCE_OBJECT_NOT_FOUND",
    });

    const corrupt = candidate("shopify", "orders/create", "corrupt.json");
    const corruptStore = new InMemoryImmutableObjectStore();
    await corruptStore.putImmutable({
      key: corrupt.objectKey,
      body: Buffer.from("{}"),
      contentType: "application/json",
      checksumSha256: sha256(Buffer.from("{}")),
    });
    await expect(runOne(corrupt, corruptStore)).rejects.toMatchObject({
      code: "SOURCE_OBJECT_INTEGRITY_FAILED",
    });

    const unsupportedBody = Buffer.from("{}");
    const unsupported = {
      ...candidate("shopify", "orders/create", "unsupported.json"),
      payloadSha256: sha256(unsupportedBody),
    };
    const unsupportedStore = new InMemoryImmutableObjectStore();
    await put(unsupportedStore, unsupported, unsupportedBody);
    await expect(runOne(unsupported, unsupportedStore)).rejects.toMatchObject({
      code: "SOURCE_PAYLOAD_UNSUPPORTED",
    });

    await expect(runOne(missing, new TimeoutObjectStore())).rejects.toMatchObject({
      code: "SOURCE_OBJECT_READ_TIMEOUT",
    });
  });

  it("enforces the 100-event batch ceiling", async () => {
    await expect(
      executeSourceEventClassificationRepairBatch({
        repository: new FakeRepairRepository([]),
        objectStore: new InMemoryImmutableObjectStore(),
        requestedBy: "classification-repair-test",
        reason: "Repair integrity-verified legacy source classifications",
        batchSize: 101,
      }),
    ).rejects.toThrow();
  });
});

class FakeRepairRepository implements SourceEventClassificationRepairRepository {
  public readonly families: SourceObjectFamily[][] = [];
  readonly #candidates: SourceEventClassificationRepairCandidate[];

  public constructor(candidates: readonly SourceEventClassificationRepairCandidate[]) {
    this.#candidates = [...candidates];
  }

  public async processNext(
    _input: {
      readonly repairRunId: string;
      readonly requestedBy: string;
      readonly reason: string;
      readonly repairedAt: string;
    },
    classify: (
      candidate: SourceEventClassificationRepairCandidate,
    ) => Promise<readonly SourceObjectFamily[]>,
  ): Promise<SourceEventClassificationRepairProcessResult> {
    const candidate = this.#candidates.shift();
    if (!candidate) return { kind: "none" };
    const families = await classify(candidate);
    this.families.push([...families]);
    return { kind: "classified" };
  }

  public async countGaps(): Promise<SourceEventClassificationRepairGapCounts> {
    return { total: this.#candidates.length, repairable: this.#candidates.length };
  }
}

class CountingObjectStore extends InMemoryImmutableObjectStore {
  public reads = 0;
  public readonly readTimeouts: (number | undefined)[] = [];

  public override async getVerified(
    input: Parameters<ImmutableObjectStore["getVerified"]>[0],
  ): ReturnType<ImmutableObjectStore["getVerified"]> {
    this.reads += 1;
    this.readTimeouts.push(input.timeoutMs);
    return super.getVerified(input);
  }
}

class TimeoutObjectStore implements Pick<ImmutableObjectStore, "getVerified"> {
  public async getVerified(): Promise<Uint8Array> {
    throw new ObjectReadTimeoutError();
  }
}

function candidate(
  source: SourceEventClassificationRepairCandidate["source"],
  eventType: string,
  suffix: string,
): SourceEventClassificationRepairCandidate {
  const body =
    source === "shopify"
      ? shopifySnapshot(true)
      : source === "stripe"
        ? stripeRefund()
        : Buffer.from("id,amount\\n1,10.00\\n");
  return {
    organizationId: OrganizationIdSchema.parse(randomUUID()),
    sourceEventId: randomUUID(),
    connectionId: randomUUID(),
    source,
    eventType,
    objectKey: `test/${randomUUID()}/provider-events/${randomUUID()}/${suffix}`,
    payloadSha256: sha256(body),
  };
}

async function put(
  store: InMemoryImmutableObjectStore,
  candidateValue: SourceEventClassificationRepairCandidate,
  body: Uint8Array,
): Promise<void> {
  await store.putImmutable({
    key: candidateValue.objectKey,
    body,
    contentType: candidateValue.source === "accounting_csv" ? "text/csv" : "application/json",
    checksumSha256: sha256(body),
  });
}

async function runOne(
  candidateValue: SourceEventClassificationRepairCandidate,
  store: Pick<ImmutableObjectStore, "getVerified">,
): Promise<unknown> {
  return executeSourceEventClassificationRepairBatch({
    repository: new FakeRepairRepository([candidateValue]),
    objectStore: store,
    requestedBy: "classification-repair-test",
    reason: "Repair integrity-verified legacy source classifications",
    batchSize: 1,
  });
}

function shopifySnapshot(withRefund: boolean): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      apiVersion: "2026-07",
      order: {
        id: "gid://shopify/Order/123",
        legacyResourceId: "123",
        name: "#123",
        processedAt: "2026-07-29T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:01.000Z",
        displayFinancialStatus: withRefund ? "PARTIALLY_REFUNDED" : "PAID",
        currentTotalPriceSet: {
          shopMoney: { amount: "10.00", currencyCode: "USD" },
        },
        refunds: withRefund
          ? [
              {
                id: "gid://shopify/Refund/456",
                legacyResourceId: "456",
                createdAt: "2026-07-29T00:00:00.000Z",
                processedAt: "2026-07-29T00:00:00.000Z",
                updatedAt: "2026-07-29T00:00:01.000Z",
                transactions: {
                  nodes: [
                    {
                      id: "gid://shopify/OrderTransaction/789",
                      amountSet: {
                        shopMoney: { amount: "1.00", currencyCode: "USD" },
                      },
                      status: "SUCCESS",
                      gateway: "shopify_payments",
                      processedAt: "2026-07-29T00:00:00.000Z",
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            ]
          : [],
      },
    }),
  );
}

function stripeRefund(): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      id: "evt_repair",
      object: "event",
      created: 1785283200,
      api_version: "2025-06-30.basil",
      type: "refund.updated",
      data: {
        object: {
          id: "re_repair",
          object: "refund",
          amount: 100,
          currency: "usd",
          created: 1785283200,
          payment_intent: "pi_repair",
          status: "succeeded",
        },
      },
    }),
  );
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
