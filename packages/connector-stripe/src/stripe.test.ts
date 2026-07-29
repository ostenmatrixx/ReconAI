import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import {
  ConnectorError,
  EnvironmentConnectorSecretResolver,
  type ProviderPageRequest,
} from "@workspace/connectors";
import { OrganizationIdSchema } from "@workspace/domain";

import {
  StripeEventPageSource,
  constructStripeEvent,
  normalizeStripeBalanceTransaction,
} from "./index.js";

describe("Stripe webhook verification", () => {
  it("uses the official SDK against the exact raw body", () => {
    const secret = "whsec_synthetic_secret_for_tests";
    const raw = JSON.stringify({
      id: "evt_synthetic",
      object: "event",
      api_version: "2025-01-01",
      created: 1_785_120_000,
      data: { object: { id: "pi_synthetic", object: "payment_intent" } },
      livemode: false,
      pending_webhooks: 0,
      request: null,
      type: "payment_intent.succeeded",
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload: raw,
      secret,
      timestamp: 1_785_120_000,
    });
    expect(
      constructStripeEvent(Buffer.from(raw), signature, secret, Number.MAX_SAFE_INTEGER).id,
    ).toBe("evt_synthetic");
    expect(() =>
      constructStripeEvent(Buffer.from(`${raw} `), signature, secret, Number.MAX_SAFE_INTEGER),
    ).toThrow(ConnectorError);
  });
});

describe("Stripe bounded event page source", () => {
  it("uses fixed-origin cursor pagination without exposing the API credential", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const payload = JSON.stringify({
        object: "list",
        data: [
          stripePaymentEvent("evt_first", 1_785_120_000),
          stripePaymentEvent("evt_second", 1_785_120_001),
        ],
        has_more: true,
        url: "/v1/events",
      });
      return new Response(payload, {
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(payload.length) },
      });
    });
    const source = new StripeEventPageSource({
      secrets: new EnvironmentConnectorSecretResolver({
        RECONAI_CONNECTOR_STRIPE_READ_TEST: "sk_test_synthetic_read_credential",
      }),
      fetch: fetchMock,
    });

    await expect(source.fetchPage(stripePageRequest())).resolves.toMatchObject({
      hasMore: true,
      nextCursor: "stripe-v2:events:evt_second",
      items: [
        {
          eventType: "payment_intent.succeeded",
          externalEventId: "evt_first",
          externalObjectId: "pi_evt_first",
          apiVersion: "2025-01-01",
        },
        {
          eventType: "payment_intent.succeeded",
          externalEventId: "evt_second",
          externalObjectId: "pi_evt_second",
          apiVersion: "2025-01-01",
        },
      ],
    });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(input).toBeInstanceOf(URL);
    const url = input as URL;
    expect(url.origin).toBe("https://api.stripe.com");
    expect(url.pathname).toBe("/v1/events");
    expect(url.searchParams.get("starting_after")).toBe("evt_previous");
    expect(url.searchParams.getAll("types[]")).toHaveLength(8);
    expect(url.href).not.toContain("sk_test");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toMatch(/^Basic /u);
    expect(headers.get("stripe-account")).toBe("acct_synthetic");
    expect(headers.get("stripe-version")).toBe("2025-01-01");
  });

  it("moves from an empty event window to bounded charge-fee pages with minimized snapshots", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = input as URL;
      if (url.pathname === "/v1/events") {
        return jsonResponse({
          object: "list",
          data: [],
          has_more: false,
          url: "/v1/events",
        });
      }
      const after = url.searchParams.get("starting_after");
      return jsonResponse({
        object: "list",
        data: [
          stripeBalanceTransaction(
            after ? "txn_feesecond" : "txn_feefirst",
            after ? 1_785_024_002 : 1_785_024_001,
          ),
        ],
        has_more: !after,
        url: "/v1/balance_transactions",
      });
    });
    const source = new StripeEventPageSource({
      secrets: new EnvironmentConnectorSecretResolver({
        RECONAI_CONNECTOR_STRIPE_READ_TEST: "sk_test_synthetic_read_credential",
      }),
      fetch: fetchMock,
    });

    await expect(source.fetchPage(stripePageRequest(null))).resolves.toEqual({
      items: [],
      hasMore: true,
      nextCursor: "stripe-v2:balance:start",
      continuationKind: "source_phase",
    });
    const firstBalancePage = await source.fetchPage({
      ...stripePageRequest(),
      cursor: "stripe-v2:balance:start",
    });
    expect(firstBalancePage).toMatchObject({
      hasMore: true,
      nextCursor: "stripe-v2:balance:txn_feefirst",
      items: [
        {
          eventType: "balance_transaction.snapshot",
          externalEventId: "txn_feefirst",
          externalObjectId: "txn_feefirst",
          sourceTimestamp: "2026-07-26T00:00:01.000Z",
          apiVersion: "2025-01-01",
        },
      ],
    });
    const rawSnapshot = JSON.parse(
      Buffer.from(firstBalancePage.items[0]?.rawBody ?? []).toString("utf8"),
    ) as Record<string, unknown>;
    expect(rawSnapshot).toMatchObject({
      schemaVersion: 1,
      object: "reconai.stripe_balance_transaction_snapshot",
      apiVersion: "2025-01-01",
      balanceTransaction: {
        id: "txn_feefirst",
        amount: 2500,
        fee: 103,
        net: 2397,
        source: {
          id: "ch_feefirst",
          object: "charge",
          payment_intent: "pi_feefirst",
        },
      },
    });
    expect(JSON.stringify(rawSnapshot)).not.toContain("must-not-be-persisted");

    await expect(
      source.fetchPage({
        ...stripePageRequest(),
        cursor: "stripe-v2:balance:txn_feefirst",
      }),
    ).resolves.toMatchObject({
      hasMore: false,
      items: [{ externalEventId: "txn_feesecond" }],
    });

    const balanceCalls = fetchMock.mock.calls
      .map(([input]) => input as URL)
      .filter((url) => url.pathname === "/v1/balance_transactions");
    expect(balanceCalls).toHaveLength(2);
    expect(balanceCalls[0]?.searchParams.get("type")).toBe("charge");
    expect(balanceCalls[0]?.searchParams.getAll("expand[]")).toEqual(["data.source"]);
    expect(balanceCalls[0]?.searchParams.get("starting_after")).toBeNull();
    expect(balanceCalls[1]?.searchParams.get("starting_after")).toBe("txn_feefirst");
  });

  it("bounds provider windows, response bytes, and rate-limit retry authority", async () => {
    const rateLimited = new StripeEventPageSource({
      secrets: new EnvironmentConnectorSecretResolver({
        RECONAI_CONNECTOR_STRIPE_READ_TEST: "sk_test_synthetic_read_credential",
      }),
      fetch: vi.fn(
        async () => new Response(null, { status: 429, headers: { "retry-after": "7" } }),
      ),
    });
    const rateLimitError = await rateLimited
      .fetchPage(stripePageRequest())
      .catch((error: unknown) => error);
    expect(rateLimitError).toBeInstanceOf(ConnectorError);
    expect(rateLimitError).toMatchObject({ kind: "rate_limited", retryAfterMs: 7000 });

    const oversized = new StripeEventPageSource({
      secrets: new EnvironmentConnectorSecretResolver({
        RECONAI_CONNECTOR_STRIPE_READ_TEST: "sk_test_synthetic_read_credential",
      }),
      fetch: vi.fn(
        async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-length": String(2 * 1024 * 1024 + 1) },
          }),
      ),
    });
    await expect(oversized.fetchPage(stripePageRequest())).rejects.toMatchObject({
      kind: "invalid_payload",
    });

    await expect(
      rateLimited.fetchPage({
        ...stripePageRequest(),
        windowStart: "2026-05-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ kind: "terminal" });

    const nonConserving = new StripeEventPageSource({
      secrets: new EnvironmentConnectorSecretResolver({
        RECONAI_CONNECTOR_STRIPE_READ_TEST: "sk_test_synthetic_read_credential",
      }),
      fetch: vi.fn(async () =>
        jsonResponse({
          object: "list",
          data: [{ ...stripeBalanceTransaction("txn_invalid", 1_785_120_001), net: 2398 }],
          has_more: false,
          url: "/v1/balance_transactions",
        }),
      ),
    });
    await expect(
      nonConserving.fetchPage({
        ...stripePageRequest(),
        cursor: "stripe-v2:balance:start",
      }),
    ).rejects.toMatchObject({ kind: "invalid_payload" });
  });
});

describe("Stripe balance-transaction normalization", () => {
  it("falls back to the charge reference and marks a missing payment intent as incomplete", () => {
    const original = stripeBalanceTransaction("txn_nopaymentintent", 1_785_120_001);
    const balanceTransaction = {
      ...original,
      source: {
        ...original.source,
        payment_intent: null,
      },
    };

    expect(
      normalizeStripeBalanceTransaction(
        {
          schemaVersion: 1,
          object: "reconai.stripe_balance_transaction_snapshot",
          apiVersion: "2025-01-01",
          balanceTransaction,
        },
        {
          organizationId: OrganizationIdSchema.parse("00000000-0000-4000-8000-000000000001"),
          canonicalRecordId: "00000000-0000-4000-8000-000000000003",
          version: 1,
          sourceEventId: "00000000-0000-4000-8000-000000000004",
          ingestionTimestamp: "2026-07-27T12:00:00.000Z",
        },
      ),
    ).toMatchObject({
      kind: "processing_fee",
      externalId: "txn_nopaymentintent",
      paymentReference: "ch_nopaymentintent",
      amount: { minor: 103n, currency: "USD" },
      incompleteReasons: ["STRIPE_CHARGE_HAS_NO_PAYMENT_INTENT"],
    });
  });
});

function stripePageRequest(cursor: string | null = "evt_previous"): ProviderPageRequest {
  return {
    organizationId: OrganizationIdSchema.parse("00000000-0000-4000-8000-000000000001"),
    connectionId: "00000000-0000-4000-8000-000000000002",
    provider: "stripe",
    externalAccountId: "acct_synthetic",
    apiCredentialReference: "env:RECONAI_CONNECTOR_STRIPE_READ_TEST",
    configuredApiVersion: "2025-01-01",
    mode: "gap_repair",
    windowStart: "2026-07-01T00:00:00.000Z",
    windowEnd: "2026-07-02T00:00:00.000Z",
    ...(cursor === null ? {} : { cursor }),
    limit: 100,
  };
}

function stripePaymentEvent(id: string, created: number) {
  return {
    id,
    object: "event",
    created,
    api_version: "2025-01-01",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: `pi_${id}`,
        object: "payment_intent",
        amount: 2500,
        amount_received: 2500,
        currency: "usd",
        status: "succeeded",
        customer: null,
        metadata: { shopify_order_id: "order-1" },
      },
    },
  };
}

function stripeBalanceTransaction(id: string, created: number) {
  const suffix = id.slice("txn_".length);
  return {
    id,
    object: "balance_transaction",
    amount: 2500,
    available_on: created + 86_400,
    created,
    currency: "usd",
    description: "must-not-be-persisted",
    fee: 103,
    fee_details: [
      {
        amount: 103,
        application: null,
        currency: "usd",
        description: "Stripe processing fee",
        type: "stripe_fee",
      },
    ],
    net: 2397,
    reporting_category: "charge",
    source: {
      id: `ch_${suffix}`,
      object: "charge",
      payment_intent: `pi_${suffix}`,
      billing_details: { email: "must-not-be-persisted@example.test" },
    },
    status: "available",
    type: "charge",
  };
}

function jsonResponse(value: unknown): Response {
  const payload = JSON.stringify(value);
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "application/json", "content-length": String(payload.length) },
  });
}
