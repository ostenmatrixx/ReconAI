import { createHmac } from "node:crypto";

import {
  ConnectorError,
  EnvironmentConnectorSecretResolver,
  type ProviderPageRequest,
} from "@workspace/connectors";
import { OrganizationIdSchema } from "@workspace/domain";
import { describe, expect, it, vi } from "vitest";

import {
  ShopifyOrderPageSource,
  normalizeShopifyOrderSnapshotRecords,
  verifyShopifyWebhook,
} from "./index.js";

const organizationId = OrganizationIdSchema.parse("00000000-0000-4000-8000-000000000001");

describe("Shopify webhook verification", () => {
  it("accepts the exact raw body with a valid HMAC and rejects tampering", () => {
    const secret = "synthetic-shopify-secret-32-bytes";
    const raw = Buffer.from('{"id":123,"name":"#R123"}');
    const signature = createHmac("sha256", secret).update(raw).digest("base64");
    expect(verifyShopifyWebhook(raw, signature, secret)).toBe(true);
    expect(verifyShopifyWebhook(Buffer.from('{"id":124,"name":"#R123"}'), signature, secret)).toBe(
      false,
    );
  });
});

describe("Shopify bounded order page source", () => {
  it("uses a validated shop origin, pinned API version, and forward cursor", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const body = JSON.stringify(shopifyPagePayload(true));
      return new Response(body, {
        status: 200,
        headers: {
          "content-length": String(body.length),
          "content-type": "application/json; charset=utf-8",
          "x-shopify-api-version": "2026-07",
        },
      });
    });
    const source = new ShopifyOrderPageSource({
      secrets: shopifySecrets(),
      fetch: fetchMock,
    });

    await expect(source.fetchPage(shopifyPageRequest())).resolves.toMatchObject({
      hasMore: true,
      nextCursor: "cursor-next",
      items: [
        {
          eventType: "orders/snapshot",
          externalEventId: "shopify/order/123/2026-07-27T00:00:02.000Z/2026-07",
          externalObjectId: "123",
          sourceTimestamp: "2026-07-27T00:00:02.000Z",
          apiVersion: "2026-07",
        },
      ],
    });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(input).toBeInstanceOf(URL);
    const url = input as URL;
    expect(url.origin).toBe("https://reconai-test.myshopify.com");
    expect(url.pathname).toBe("/admin/api/2026-07/graphql.json");
    expect(url.href).not.toContain("synthetic-shopify-offline-token");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-shopify-access-token")).toBe("synthetic-shopify-offline-token");
    if (typeof init?.body !== "string") throw new TypeError("expected a JSON request body");
    const requestBody = JSON.parse(init.body) as {
      readonly query: string;
      readonly variables: Record<string, unknown>;
    };
    expect(requestBody.query).toContain("sortKey: UPDATED_AT");
    expect(requestBody.query).not.toMatch(/\bemail\b/u);
    expect(requestBody.variables).toMatchObject({
      first: 100,
      after: "cursor-previous",
    });
    expect(requestBody.variables["query"]).toContain("updated_at:>=");
    expect(init.body).not.toContain("synthetic-shopify-offline-token");
  });

  it("classifies GraphQL throttling and rejects host, version, and response bound violations", async () => {
    const throttled = new ShopifyOrderPageSource({
      secrets: shopifySecrets(),
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: null,
              errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
              extensions: {
                cost: {
                  requestedQueryCost: 50,
                  actualQueryCost: null,
                  throttleStatus: {
                    maximumAvailable: 100,
                    currentlyAvailable: 10,
                    restoreRate: 20,
                  },
                },
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-shopify-api-version": "2026-07",
              },
            },
          ),
      ),
    });
    const error = await throttled.fetchPage(shopifyPageRequest()).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ kind: "rate_limited", retryAfterMs: 2000 });

    const fetchMock = vi.fn<typeof fetch>();
    const rejecting = new ShopifyOrderPageSource({
      secrets: shopifySecrets(),
      fetch: fetchMock,
    });
    await expect(
      rejecting.fetchPage({
        ...shopifyPageRequest(),
        externalAccountId: "reconai-test.myshopify.com.evil.example",
      }),
    ).rejects.toMatchObject({ kind: "terminal" });
    await expect(
      rejecting.fetchPage({ ...shopifyPageRequest(), configuredApiVersion: "latest" }),
    ).rejects.toMatchObject({ kind: "terminal" });
    expect(fetchMock).not.toHaveBeenCalled();

    const wrongVersion = new ShopifyOrderPageSource({
      secrets: shopifySecrets(),
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify(shopifyPagePayload(false)), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-shopify-api-version": "2026-10",
            },
          }),
      ),
    });
    await expect(wrongVersion.fetchPage(shopifyPageRequest())).rejects.toMatchObject({
      kind: "invalid_payload",
    });

    const oversized = new ShopifyOrderPageSource({
      secrets: shopifySecrets(),
      fetch: vi.fn(
        async () =>
          new Response("{}", {
            status: 200,
            headers: {
              "content-length": String(2 * 1024 * 1024 + 1),
              "content-type": "application/json",
              "x-shopify-api-version": "2026-07",
            },
          }),
      ),
    });
    await expect(oversized.fetchPage(shopifyPageRequest())).rejects.toMatchObject({
      kind: "invalid_payload",
    });
  });

  it("normalizes order and refund snapshots without floating-point money", () => {
    const payload = {
      apiVersion: "2026-07",
      order: shopifyOrderSnapshot(),
    };
    const records = normalizeShopifyOrderSnapshotRecords(payload, {
      order: {
        organizationId,
        canonicalRecordId: "10000000-0000-4000-8000-000000000001",
        version: 1,
        sourceEventId: "20000000-0000-4000-8000-000000000001",
        ingestionTimestamp: "2026-07-27T00:00:03.000Z",
      },
      refunds: [
        {
          organizationId,
          canonicalRecordId: "10000000-0000-4000-8000-000000000002",
          version: 1,
          sourceEventId: "20000000-0000-4000-8000-000000000001",
          ingestionTimestamp: "2026-07-27T00:00:03.000Z",
        },
      ],
    });

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      kind: "order",
      externalId: "123",
      orderReference: "#R123",
      amount: { minor: 12_500n, currency: "USD" },
      financialStatus: "partially_refunded",
    });
    expect(records[1]).toMatchObject({
      kind: "refund",
      externalId: "789",
      orderReference: "123",
      refundReference: "456",
      amount: { minor: 2500n, currency: "USD" },
      refundStatus: "succeeded",
    });
  });
});

function shopifySecrets(): EnvironmentConnectorSecretResolver {
  return new EnvironmentConnectorSecretResolver({
    RECONAI_CONNECTOR_SHOPIFY_READ_TEST: "synthetic-shopify-offline-token",
  });
}

function shopifyPageRequest(): ProviderPageRequest {
  return {
    organizationId,
    connectionId: "00000000-0000-4000-8000-000000000002",
    provider: "shopify",
    externalAccountId: "reconai-test.myshopify.com",
    apiCredentialReference: "env:RECONAI_CONNECTOR_SHOPIFY_READ_TEST",
    configuredApiVersion: "2026-07",
    mode: "gap_repair",
    windowStart: "2026-07-27T00:00:00.000Z",
    windowEnd: "2026-07-28T00:00:00.000Z",
    cursor: "cursor-previous",
    limit: 100,
  };
}

function shopifyPagePayload(hasNextPage: boolean) {
  return {
    data: {
      orders: {
        edges: [{ cursor: "cursor-next", node: shopifyOrderSnapshot() }],
        pageInfo: {
          hasNextPage,
          endCursor: "cursor-next",
        },
      },
    },
    extensions: {
      cost: {
        requestedQueryCost: 50,
        actualQueryCost: 25,
        throttleStatus: {
          maximumAvailable: 1000,
          currentlyAvailable: 975,
          restoreRate: 50,
        },
      },
    },
  };
}

function shopifyOrderSnapshot() {
  return {
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
  };
}
