import { createHmac } from "node:crypto";

import { EnvironmentConnectorSecretResolver, type SourceObjectFamily } from "@workspace/connectors";
import { OrganizationIdSchema, type CanonicalRecord } from "@workspace/domain";
import { InMemoryImmutableObjectStore } from "@workspace/object-storage";
import { describe, expect, it } from "vitest";

import {
  ProviderWebhookAuthenticationError,
  ProviderWebhookConflictError,
  ProviderWebhookService,
  type ProviderWebhookAuthority,
  type ProviderWebhookJobEnvelope,
  type ProviderWebhookReceipt,
  type ProviderWebhookRepository,
} from "./provider-webhooks.js";

const organizationId = OrganizationIdSchema.parse("81000000-0000-4000-8000-000000000001");
const shopifyConnectionId = "82000000-0000-4000-8000-000000000001";
const stripeConnectionId = "82000000-0000-4000-8000-000000000002";
const shopifySecret = "synthetic-shopify-signing-secret";
const stripeSecret = "whsec_synthetic_stripe_signing_secret";
const traceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
const replayTraceparent = "00-fedcba9876543210fedcba9876543210-fedcba9876543210-01";

describe("durable provider webhook ingestion", () => {
  it("authenticates, stores, deduplicates, and normalizes a Shopify raw body", async () => {
    const repository = new MemoryProviderWebhookRepository();
    const published: ProviderWebhookJobEnvelope[] = [];
    const service = buildService(repository, published);
    const rawBody = Buffer.from(
      JSON.stringify({
        id: 123,
        name: "#R123",
        email: "CUSTOMER@EXAMPLE.TEST",
        processed_at: "2026-07-27T00:00:00.000Z",
        financial_status: "paid",
        current_total_price_set: {
          shop_money: { amount: "125.00", currency_code: "USD" },
        },
      }),
    );
    const hmac = createHmac("sha256", shopifySecret).update(rawBody).digest("base64");
    const input = {
      organizationId,
      connectionId: shopifyConnectionId,
      rawBody,
      hmac,
      webhookId: "shopify-webhook-1",
      topic: "orders/updated",
      apiVersion: "2026-07",
      correlationId: "83000000-0000-4000-8000-000000000001",
      traceparent,
    } as const;

    await expect(service.receiveShopify(input)).resolves.toMatchObject({
      duplicate: false,
      status: "queued",
    });
    await expect(
      service.receiveShopify({ ...input, traceparent: replayTraceparent }),
    ).resolves.toMatchObject({ duplicate: true });
    expect(repository.receipts).toHaveLength(1);
    expect(repository.classifications.get(repository.receipts[0]?.sourceEventId ?? "")).toEqual([
      "order",
    ]);
    expect(published).toHaveLength(2);
    expect(published[0]?.traceContext).toEqual({ schemaVersion: 1, traceparent });
    expect(published[1]?.traceContext).toEqual({ schemaVersion: 1, traceparent });

    const envelope = published[0];
    if (!envelope) throw new Error("expected a published Shopify job");
    await expect(service.processWebhookWithMetadata(envelope)).resolves.toEqual({
      status: "processed",
      sourceTimestamp: "2026-07-27T00:00:00.000Z",
    });
    await expect(service.processWebhook(envelope)).resolves.toBe("already_processed");
    expect(repository.records).toHaveLength(1);
    expect(repository.records[0]).toMatchObject({
      kind: "order",
      externalId: "123",
    });
    expect(repository.records[0]).not.toHaveProperty("customerReference");

    await expect(
      service.receiveShopify({ ...input, rawBody: Buffer.from(`${rawBody.toString()} `) }),
    ).rejects.toBeInstanceOf(ProviderWebhookAuthenticationError);
    await expect(
      service.receiveShopify({
        ...input,
        topic: "customers/redact",
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("rejects invalid durable context before storing an authenticated provider event", async () => {
    const repository = new MemoryProviderWebhookRepository();
    const service = buildService(repository, []);
    const rawBody = Buffer.from(
      JSON.stringify({
        id: 123,
        processed_at: "2026-07-27T00:00:00.000Z",
        financial_status: "paid",
        current_total_price_set: {
          shop_money: { amount: "125.00", currency_code: "USD" },
        },
      }),
    );

    await expect(
      service.receiveShopify({
        organizationId,
        connectionId: shopifyConnectionId,
        rawBody,
        hmac: createHmac("sha256", shopifySecret).update(rawBody).digest("base64"),
        webhookId: "shopify-webhook-invalid-trace",
        topic: "orders/updated",
        apiVersion: "2026-07",
        correlationId: "83000000-0000-4000-8000-000000000009",
        traceparent: "credential-token-value",
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(repository.receipts).toHaveLength(0);
  });

  it("verifies Stripe against the exact body and rejects immutable event-ID collisions", async () => {
    const repository = new MemoryProviderWebhookRepository();
    const published: ProviderWebhookJobEnvelope[] = [];
    const service = buildService(repository, published);
    const timestamp = Math.floor(Date.now() / 1000);
    const event = {
      id: "evt_synthetic_1",
      object: "event",
      created: timestamp,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_synthetic_1",
          object: "payment_intent",
          amount: 12_500,
          amount_received: 12_500,
          currency: "usd",
          status: "succeeded",
          customer: "cus_synthetic_1",
          metadata: { shopify_order_id: "shopify-order-123" },
        },
      },
    };
    const rawBody = Buffer.from(JSON.stringify(event));
    const input = {
      organizationId,
      connectionId: stripeConnectionId,
      rawBody,
      signature: stripeSignature(rawBody, stripeSecret, timestamp),
      correlationId: "83000000-0000-4000-8000-000000000002",
    } as const;

    await expect(service.receiveStripe(input)).resolves.toMatchObject({
      duplicate: false,
      eventId: event.id,
    });
    expect(repository.classifications.get(repository.receipts[0]?.sourceEventId ?? "")).toEqual([
      "payment_intent",
    ]);
    const envelope = published[0];
    if (!envelope) throw new Error("expected a published Stripe job");
    await expect(service.processWebhook(envelope)).resolves.toBe("processed");
    expect(repository.records[0]).toMatchObject({
      kind: "payment",
      externalId: "pi_synthetic_1",
      orderReference: "shopify-order-123",
    });

    const collidingBody = Buffer.from(
      JSON.stringify({
        ...event,
        data: { object: { ...event.data.object, amount_received: 12_501 } },
      }),
    );
    await expect(
      service.receiveStripe({
        ...input,
        rawBody: collidingBody,
        signature: stripeSignature(collidingBody, stripeSecret, timestamp),
      }),
    ).rejects.toBeInstanceOf(ProviderWebhookConflictError);
  });

  it("deduplicates identical sync events and rejects reused IDs with different bytes", async () => {
    const repository = new MemoryProviderWebhookRepository();
    const published: ProviderWebhookJobEnvelope[] = [];
    const service = buildService(repository, published);
    const event = {
      id: "evt_sync_synthetic_1",
      object: "event",
      api_version: "2026-06-30.basil",
      created: 1_785_105_600,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_sync_synthetic_1",
          object: "payment_intent",
          amount: 12_500,
          amount_received: 12_500,
          currency: "usd",
          status: "succeeded",
          customer: "cus_sync_synthetic_1",
          metadata: { shopify_order_id: "shopify-order-sync-123" },
        },
      },
    };
    const rawBody = Buffer.from(JSON.stringify(event));
    const input = {
      organizationId,
      connectionId: stripeConnectionId,
      provider: "stripe",
      eventType: event.type,
      externalEventId: event.id,
      externalObjectId: event.data.object.id,
      sourceTimestamp: new Date(event.created * 1000).toISOString(),
      apiVersion: event.api_version,
      rawBody,
      correlationId: "83000000-0000-4000-8000-000000000003",
    } as const;

    await expect(service.receiveSyncItem(input)).resolves.toMatchObject({
      duplicate: false,
      eventId: event.id,
    });
    await expect(service.receiveSyncItem(input)).resolves.toMatchObject({
      duplicate: true,
      eventId: event.id,
    });
    expect(repository.receipts).toHaveLength(1);
    expect(published).toHaveLength(1);

    const collidingBody = Buffer.from(
      JSON.stringify({
        ...event,
        data: { object: { ...event.data.object, amount_received: 12_501 } },
      }),
    );
    await expect(
      service.receiveSyncItem({ ...input, rawBody: collidingBody }),
    ).rejects.toBeInstanceOf(ProviderWebhookConflictError);
  });

  it("validates and normalizes a versioned Shopify order snapshot", async () => {
    const repository = new MemoryProviderWebhookRepository();
    const published: ProviderWebhookJobEnvelope[] = [];
    const service = buildService(repository, published);
    const snapshot = {
      apiVersion: "2026-07",
      order: {
        id: "gid://shopify/Order/123",
        legacyResourceId: "123",
        name: "#R123",
        processedAt: "2026-07-27T00:00:01.000Z",
        updatedAt: "2026-07-27T00:00:02.000Z",
        displayFinancialStatus: "PARTIALLY_REFUNDED",
        currentTotalPriceSet: {
          shopMoney: { amount: "125.00", currencyCode: "USD" },
        },
        refunds: [
          {
            id: "gid://shopify/Refund/456",
            legacyResourceId: "456",
            createdAt: "2026-07-27T00:00:01.000Z",
            processedAt: "2026-07-27T00:00:01.000Z",
            updatedAt: "2026-07-27T00:00:02.000Z",
            transactions: {
              nodes: [
                {
                  id: "gid://shopify/OrderTransaction/789",
                  amountSet: {
                    shopMoney: { amount: "25.00", currencyCode: "USD" },
                  },
                  status: "SUCCESS",
                  gateway: "shopify_payments",
                  processedAt: "2026-07-27T00:00:01.000Z",
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        ],
      },
    };
    const rawBody = Buffer.from(JSON.stringify(snapshot));

    await expect(
      service.receiveSyncItem({
        organizationId,
        connectionId: shopifyConnectionId,
        provider: "shopify",
        eventType: "orders/snapshot",
        externalEventId: "shopify/order/123/2026-07-27T00:00:02.000Z/2026-07",
        externalObjectId: "123",
        sourceTimestamp: "2026-07-27T00:00:02.000Z",
        apiVersion: "2026-07",
        rawBody,
        correlationId: "83000000-0000-4000-8000-000000000004",
      }),
    ).resolves.toMatchObject({ duplicate: false });
    expect(repository.classifications.get(repository.receipts[0]?.sourceEventId ?? "")).toEqual([
      "order",
      "refund_transaction",
    ]);

    const envelope = published[0];
    if (!envelope) throw new Error("expected a published Shopify sync job");
    await expect(service.processWebhook(envelope)).resolves.toBe("processed");
    expect(repository.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "order",
          externalId: "123",
          financialStatus: "partially_refunded",
        }),
        expect.objectContaining({
          kind: "refund",
          externalId: "789",
          orderReference: "123",
          refundReference: "456",
          refundStatus: "succeeded",
        }),
      ]),
    );
  });

  it("classifies and normalizes a minimized Stripe balance-transaction snapshot", async () => {
    const repository = new MemoryProviderWebhookRepository();
    const published: ProviderWebhookJobEnvelope[] = [];
    const service = buildService(repository, published);
    const snapshot = {
      schemaVersion: 1,
      object: "reconai.stripe_balance_transaction_snapshot",
      apiVersion: "2026-06-30.basil",
      balanceTransaction: {
        id: "txn_fee123",
        object: "balance_transaction",
        amount: 12_500,
        available_on: 1_785_192_000,
        created: 1_785_105_600,
        currency: "usd",
        fee: 393,
        fee_details: [
          {
            amount: 393,
            application: null,
            currency: "usd",
            description: "Stripe processing fee",
            type: "stripe_fee",
          },
        ],
        net: 12_107,
        reporting_category: "charge",
        source: {
          id: "ch_fee123",
          object: "charge",
          payment_intent: "pi_syncsynthetic1",
        },
        status: "available",
        type: "charge",
      },
    };
    const rawBody = Buffer.from(JSON.stringify(snapshot));
    const input = {
      organizationId,
      connectionId: stripeConnectionId,
      provider: "stripe",
      eventType: "balance_transaction.snapshot",
      externalEventId: snapshot.balanceTransaction.id,
      externalObjectId: snapshot.balanceTransaction.id,
      sourceTimestamp: new Date(snapshot.balanceTransaction.created * 1000).toISOString(),
      apiVersion: snapshot.apiVersion,
      rawBody,
      correlationId: "83000000-0000-4000-8000-000000000005",
    } as const;

    await expect(service.receiveSyncItem(input)).resolves.toMatchObject({
      duplicate: false,
      eventId: "txn_fee123",
    });
    await expect(service.receiveSyncItem(input)).resolves.toMatchObject({ duplicate: true });
    expect(repository.classifications.get(repository.receipts[0]?.sourceEventId ?? "")).toEqual([
      "balance_transaction",
    ]);

    const envelope = published[0];
    if (!envelope) throw new Error("expected a published Stripe balance-transaction job");
    await expect(service.processWebhook(envelope)).resolves.toBe("processed");
    expect(repository.records).toHaveLength(1);
    expect(repository.records[0]).toMatchObject({
      kind: "processing_fee",
      externalId: "txn_fee123",
      paymentReference: "pi_syncsynthetic1",
      amount: { minor: 393n, currency: "USD" },
    });
    expect(repository.records[0]?.provenance).toMatchObject({
      externalObjectType: "balance_transaction",
      connectorVersion: "1.1.0",
      normalizerVersion: "1.1.0",
    });

    await expect(
      service.receiveSyncItem({
        ...input,
        externalEventId: "txn_other123",
      }),
    ).rejects.toThrow("identity does not match");
  });
});

function buildService(
  repository: MemoryProviderWebhookRepository,
  published: ProviderWebhookJobEnvelope[],
): ProviderWebhookService {
  return new ProviderWebhookService({
    environment: "test",
    repository,
    objectStore: new InMemoryImmutableObjectStore(),
    secrets: new EnvironmentConnectorSecretResolver({
      RECONAI_CONNECTOR_SHOPIFY_TEST: shopifySecret,
      RECONAI_CONNECTOR_STRIPE_TEST: stripeSecret,
    }),
    publisher: {
      publish: async (envelope) => {
        published.push(envelope);
      },
    },
    now: () => new Date("2026-07-27T12:00:00.000Z"),
  });
}

function stripeSignature(rawBody: Uint8Array, secret: string, timestamp: number): string {
  const signature = createHmac("sha256", secret)
    .update(`${timestamp.toString()}.${Buffer.from(rawBody).toString("utf8")}`)
    .digest("hex");
  return `t=${timestamp.toString()},v1=${signature}`;
}

class MemoryProviderWebhookRepository implements ProviderWebhookRepository {
  public receipts: ProviderWebhookReceipt[] = [];
  public records: CanonicalRecord[] = [];
  public classifications = new Map<string, readonly SourceObjectFamily[]>();
  readonly #envelopes = new Map<string, ProviderWebhookJobEnvelope>();

  public async loadIngressAuthority(
    requestedOrganizationId: typeof organizationId,
    connectionId: string,
    provider: "shopify" | "stripe",
  ): Promise<ProviderWebhookAuthority | undefined> {
    if (requestedOrganizationId !== organizationId) return undefined;
    if (provider === "shopify" && connectionId === shopifyConnectionId) {
      return {
        organizationId,
        connectionId,
        provider,
        signingSecretReference: "env:RECONAI_CONNECTOR_SHOPIFY_TEST",
        status: "healthy",
      };
    }
    if (provider === "stripe" && connectionId === stripeConnectionId) {
      return {
        organizationId,
        connectionId,
        provider,
        signingSecretReference: "env:RECONAI_CONNECTOR_STRIPE_TEST",
        status: "healthy",
      };
    }
    return undefined;
  }

  public async loadExistingReceipt(
    requestedOrganizationId: typeof organizationId,
    connectionId: string,
    provider: "shopify" | "stripe",
    externalEventId: string,
  ): Promise<ProviderWebhookReceipt | undefined> {
    return this.receipts.find(
      (receipt) =>
        receipt.organizationId === requestedOrganizationId &&
        receipt.connectionId === connectionId &&
        receipt.provider === provider &&
        receipt.externalEventId === externalEventId,
    );
  }

  public async saveReceiptAndOutbox(
    receipt: ProviderWebhookReceipt,
    envelope: ProviderWebhookJobEnvelope,
    objectFamilies: readonly SourceObjectFamily[],
  ) {
    const existing = this.receipts.find(
      (candidate) =>
        candidate.organizationId === receipt.organizationId &&
        candidate.connectionId === receipt.connectionId &&
        candidate.provider === receipt.provider &&
        candidate.externalEventId === receipt.externalEventId,
    );
    if (existing) {
      const existingEnvelope = this.#envelopes.get(envelope.idempotencyKey);
      if (!existingEnvelope) throw new Error("durable envelope missing");
      return { receipt: existing, envelope: existingEnvelope, inserted: false };
    }
    this.receipts.push(receipt);
    this.classifications.set(receipt.sourceEventId, [...objectFamilies]);
    this.#envelopes.set(envelope.idempotencyKey, envelope);
    return { receipt, envelope, inserted: true };
  }

  public markOutboxPublished(): Promise<void> {
    return Promise.resolve();
  }

  public async loadForProcessing(
    envelope: ProviderWebhookJobEnvelope,
  ): Promise<ProviderWebhookReceipt | undefined> {
    return this.receipts.find(
      (receipt) =>
        receipt.organizationId === envelope.organizationId &&
        receipt.connectionId === envelope.connectionId &&
        receipt.externalEventId === envelope.externalEventId,
    );
  }

  public async completeWebhook(
    envelope: ProviderWebhookJobEnvelope,
    records: readonly CanonicalRecord[],
  ): Promise<"processed" | "already_processed"> {
    const index = this.receipts.findIndex(
      (receipt) =>
        receipt.organizationId === envelope.organizationId &&
        receipt.connectionId === envelope.connectionId &&
        receipt.externalEventId === envelope.externalEventId,
    );
    const receipt = this.receipts[index];
    if (!receipt) throw new Error("receipt missing");
    if (receipt.status === "processed") return "already_processed";
    this.records.push(...records);
    this.receipts[index] = { ...receipt, status: "processed" };
    return "processed";
  }

  public async markWebhookFailed(
    envelope: ProviderWebhookJobEnvelope,
    _errorCode: string,
  ): Promise<void> {
    const index = this.receipts.findIndex(
      (receipt) =>
        receipt.organizationId === envelope.organizationId &&
        receipt.externalEventId === envelope.externalEventId,
    );
    const receipt = this.receipts[index];
    if (receipt) this.receipts[index] = { ...receipt, status: "failed" };
  }
}
