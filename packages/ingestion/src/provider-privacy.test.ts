import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ShopifyPrivacyWebhookService,
  type ShopifyPrivacyRequestRecord,
  type ShopifyPrivacyRequestRepository,
} from "./provider-privacy.js";
import {
  ProviderWebhookAuthenticationError,
  ProviderWebhookValidationError,
} from "./provider-webhooks.js";

const secret = "synthetic-shopify-app-secret";
const correlationId = "93000000-0000-4000-8000-000000000001";

describe("Shopify mandatory privacy webhook boundary", () => {
  it("authenticates exact bytes and persists only bounded identifiers", async () => {
    const repository = new MemoryPrivacyRepository();
    const service = new ShopifyPrivacyWebhookService(
      repository,
      secret,
      "2026-07",
      () => new Date("2026-07-28T00:00:00.000Z"),
    );
    const rawBody = Buffer.from(
      JSON.stringify({
        shop_id: 954889,
        shop_domain: "reconai-test.myshopify.com",
        orders_requested: [299938, "280263"],
        customer: {
          id: 191167,
          email: "must-not-be-persisted@example.test",
          phone: "555-0100",
        },
        data_request: { id: 9999 },
      }),
    );

    await expect(
      service.receive(request(rawBody, "customers/data_request")),
    ).resolves.toMatchObject({
      eventId: "privacy-webhook-1",
      status: "accepted",
      duplicate: false,
    });
    expect(repository.records).toHaveLength(1);
    const persisted = repository.records[0];
    if (!persisted) throw new Error("privacy request was not persisted");
    expect(persisted).toMatchObject({
      provider: "shopify",
      externalEventId: "privacy-webhook-1",
      topic: "customers/data_request",
      apiVersion: "2026-07",
      shopId: "954889",
      shopDomain: "reconai-test.myshopify.com",
      customerId: "191167",
      externalRequestId: "9999",
      orderIds: ["299938", "280263"],
      receivedAt: "2026-07-28T00:00:00.000Z",
      dueAt: "2026-08-27T00:00:00.000Z",
      correlationId,
    });
    expect(persisted.payloadSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(repository.records)).not.toContain("must-not-be-persisted");
    expect(JSON.stringify(repository.records)).not.toContain("555-0100");
  });

  it("rejects forged bodies before repository resolution", async () => {
    const repository = new MemoryPrivacyRepository();
    const service = new ShopifyPrivacyWebhookService(repository, secret, "2026-07");
    const rawBody = Buffer.from(
      JSON.stringify({
        shop_id: 954889,
        shop_domain: "reconai-test.myshopify.com",
      }),
    );

    await expect(
      service.receive({
        ...request(rawBody, "shop/redact"),
        hmac: createHmac("sha256", secret).update(Buffer.from("{}")).digest("base64"),
      }),
    ).rejects.toBeInstanceOf(ProviderWebhookAuthenticationError);
    expect(repository.records).toHaveLength(0);
  });

  it("requires the signed payload, shop header, API version, and identifiers to agree", async () => {
    const repository = new MemoryPrivacyRepository();
    const service = new ShopifyPrivacyWebhookService(repository, secret, "2026-07");
    const mismatched = Buffer.from(
      JSON.stringify({
        shop_id: 954889,
        shop_domain: "reconai-test.myshopify.com",
        orders_to_redact: [299938, 299938],
        customer: { id: 191167 },
      }),
    );

    await expect(
      service.receive({
        ...request(mismatched, "customers/redact"),
        shopDomain: "other-shop.myshopify.com",
      }),
    ).rejects.toBeInstanceOf(ProviderWebhookValidationError);
    await expect(service.receive(request(mismatched, "customers/redact"))).rejects.toBeInstanceOf(
      ProviderWebhookValidationError,
    );
    await expect(service.receive(request(mismatched, "shop/redact"))).rejects.toMatchObject({
      name: "ZodError",
    });
    await expect(
      service.receive(
        request(
          Buffer.from(
            JSON.stringify({
              shop_id: Number.MAX_SAFE_INTEGER + 1,
              shop_domain: "reconai-test.myshopify.com",
            }),
          ),
          "shop/redact",
        ),
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      service.receive({
        ...request(
          Buffer.from(
            JSON.stringify({
              shop_id: 954889,
              shop_domain: "reconai-test.myshopify.com",
            }),
          ),
          "shop/redact",
        ),
        apiVersion: "2026-10",
      }),
    ).rejects.toBeInstanceOf(ProviderWebhookValidationError);
    expect(repository.records).toHaveLength(0);
  });
});

class MemoryPrivacyRepository implements ShopifyPrivacyRequestRepository {
  public readonly records: ShopifyPrivacyRequestRecord[] = [];

  public async recordShopifyPrivacyRequest(
    record: ShopifyPrivacyRequestRecord,
  ): Promise<{ readonly matched: boolean; readonly duplicate: boolean }> {
    this.records.push(record);
    return { matched: true, duplicate: false };
  }
}

function request(rawBody: Buffer, topic: string) {
  return {
    rawBody,
    hmac: createHmac("sha256", secret).update(rawBody).digest("base64"),
    webhookId: "privacy-webhook-1",
    topic,
    apiVersion: "2026-07",
    shopDomain: "reconai-test.myshopify.com",
    correlationId,
  };
}
