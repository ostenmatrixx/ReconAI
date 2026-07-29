import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ProviderWebhookAuthenticationError,
  ProviderWebhookValidationError,
} from "./provider-webhooks.js";
import {
  StripeAppDeauthorizationService,
  type StripeAppDeauthorizationRepository,
} from "./provider-deauthorization.js";

const endpointSecret = "whsec_synthetic_stripe_app_signing_secret";
const timestamp = Math.floor(Date.now() / 1000);

describe("Stripe app deauthorization ingress", () => {
  it("verifies the untouched raw body and forwards bounded account-mode authority", async () => {
    const finalizeStripeDeauthorization = vi.fn<
      StripeAppDeauthorizationRepository["finalizeStripeDeauthorization"]
    >(async () => ({ matched: true, duplicate: false }));
    const service = new StripeAppDeauthorizationService(
      { finalizeStripeDeauthorization },
      endpointSecret,
      () => new Date("2026-07-28T00:00:02.000Z"),
    );
    const rawBody = deauthorizationBody();

    await expect(
      service.receive({
        rawBody,
        signature: signature(rawBody),
        correlationId: "81000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toEqual({
      eventId: "evt_AppDeauthorized123",
      status: "accepted",
      duplicate: false,
    });
    const record = finalizeStripeDeauthorization.mock.calls[0]?.[0];
    expect(record).toEqual({
      externalEventId: "evt_AppDeauthorized123",
      externalAccountId: "acct_Synthetic123",
      payloadSha256: record?.payloadSha256,
      livemode: false,
      occurredAt: new Date(timestamp * 1000).toISOString(),
      receivedAt: "2026-07-28T00:00:02.000Z",
      correlationId: "81000000-0000-4000-8000-000000000001",
    });
    expect(record?.payloadSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects tampering and signed but unrelated event capabilities", async () => {
    const repository: StripeAppDeauthorizationRepository = {
      finalizeStripeDeauthorization: async () => ({ matched: true, duplicate: false }),
    };
    const service = new StripeAppDeauthorizationService(repository, endpointSecret);
    const rawBody = deauthorizationBody();
    await expect(
      service.receive({
        rawBody: Buffer.from(`${rawBody.toString("utf8")} `),
        signature: signature(rawBody),
        correlationId: "81000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toBeInstanceOf(ProviderWebhookAuthenticationError);

    const unrelated = Buffer.from(
      JSON.stringify({
        ...JSON.parse(rawBody.toString("utf8")),
        type: "payment_intent.succeeded",
      }),
    );
    await expect(
      service.receive({
        rawBody: unrelated,
        signature: signature(unrelated),
        correlationId: "81000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toBeInstanceOf(ProviderWebhookValidationError);
  });
});

function deauthorizationBody(): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: "evt_AppDeauthorized123",
      object: "event",
      account: "acct_Synthetic123",
      created: timestamp,
      livemode: false,
      type: "account.application.deauthorized",
      data: { object: { id: "ca_synthetic", object: "application" } },
    }),
  );
}

function signature(rawBody: Uint8Array): string {
  const digest = createHmac("sha256", endpointSecret)
    .update(`${timestamp.toString()}.${Buffer.from(rawBody).toString("utf8")}`)
    .digest("hex");
  return `t=${timestamp.toString()},v1=${digest}`;
}
