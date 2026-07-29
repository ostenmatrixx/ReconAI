import { describe, expect, it } from "vitest";

import { mapConnectionHealthRows } from "./repository.js";

const shopifyConnectionId = "71000000-0000-4000-8000-000000000001";
const stripeConnectionId = "71000000-0000-4000-8000-000000000002";
const csvConnectionId = "71000000-0000-4000-8000-000000000003";

describe("tenant-authorized connection object watermarks", () => {
  it("returns every fixed provider family and marks missing families as never observed", () => {
    expect(
      mapConnectionHealthRows(
        [
          connectionRow(shopifyConnectionId, "shopify"),
          connectionRow(stripeConnectionId, "stripe"),
          connectionRow(csvConnectionId, "accounting_csv"),
        ],
        [
          watermarkRow(
            shopifyConnectionId,
            "order",
            "2026-07-29T00:01:00.000Z",
            "2026-07-29T00:02:00.000Z",
          ),
          watermarkRow(
            stripeConnectionId,
            "refund",
            "2026-07-29T00:03:00.000Z",
            "2026-07-29T00:04:00.000Z",
          ),
        ],
        [],
      ),
    ).toMatchObject([
      {
        id: shopifyConnectionId,
        objectWatermarks: [
          {
            objectType: "order",
            observationState: "observed",
            latestSourceAt: "2026-07-29T00:01:00.000Z",
            latestReceivedAt: "2026-07-29T00:02:00.000Z",
          },
          { objectType: "refund_transaction", observationState: "never_observed" },
        ],
      },
      {
        id: stripeConnectionId,
        objectWatermarks: [
          { objectType: "payment_intent", observationState: "never_observed" },
          {
            objectType: "refund",
            observationState: "observed",
            latestSourceAt: "2026-07-29T00:03:00.000Z",
            latestReceivedAt: "2026-07-29T00:04:00.000Z",
          },
          { objectType: "balance_transaction", observationState: "never_observed" },
        ],
      },
      {
        id: csvConnectionId,
        objectWatermarks: [{ objectType: "csv_row", observationState: "never_observed" }],
      },
    ]);
  });

  it("rejects rows outside the authorized connection result and incompatible object families", () => {
    expect(() =>
      mapConnectionHealthRows(
        [connectionRow(shopifyConnectionId, "shopify")],
        [
          watermarkRow(
            "71000000-0000-4000-8000-000000000099",
            "order",
            "2026-07-29T00:01:00.000Z",
            "2026-07-29T00:02:00.000Z",
          ),
        ],
        [],
      ),
    ).toThrow("outside the authorized result");
    expect(() =>
      mapConnectionHealthRows(
        [connectionRow(shopifyConnectionId, "shopify")],
        [
          watermarkRow(
            shopifyConnectionId,
            "payment_intent",
            "2026-07-29T00:01:00.000Z",
            "2026-07-29T00:02:00.000Z",
          ),
        ],
        [],
      ),
    ).toThrow("does not match its provider");
  });

  it("rejects duplicate, dynamic, and malformed watermark data", () => {
    const observed = watermarkRow(
      shopifyConnectionId,
      "order",
      "2026-07-29T00:01:00.000Z",
      "2026-07-29T00:02:00.000Z",
    );
    expect(() =>
      mapConnectionHealthRows(
        [connectionRow(shopifyConnectionId, "shopify")],
        [observed, observed],
        [],
      ),
    ).toThrow("duplicate object type");
    expect(() =>
      mapConnectionHealthRows(
        [connectionRow(shopifyConnectionId, "shopify")],
        [{ ...observed, external_object_type: "customer" }],
        [],
      ),
    ).toThrow();
    expect(() =>
      mapConnectionHealthRows(
        [connectionRow(shopifyConnectionId, "shopify")],
        [{ ...observed, latest_source_at: "not-a-timestamp" }],
        [],
      ),
    ).toThrow("invalid connection_watermark.latest_source_at");
  });

  it("fails every family visibly closed when one operational receipt lacks classification", () => {
    expect(
      mapConnectionHealthRows(
        [connectionRow(shopifyConnectionId, "shopify")],
        [
          watermarkRow(
            shopifyConnectionId,
            "order",
            "2026-07-29T00:01:00.000Z",
            "2026-07-29T00:02:00.000Z",
          ),
        ],
        [{ connection_id: shopifyConnectionId, unclassified_count: 1 }],
      ),
    ).toMatchObject([
      {
        objectWatermarks: [
          { objectType: "order", observationState: "classification_unavailable" },
          {
            objectType: "refund_transaction",
            observationState: "classification_unavailable",
          },
        ],
      },
    ]);

    expect(() =>
      mapConnectionHealthRows(
        [connectionRow(shopifyConnectionId, "shopify")],
        [],
        [
          {
            connection_id: "71000000-0000-4000-8000-000000000099",
            unclassified_count: 1,
          },
        ],
      ),
    ).toThrow("outside the authorized result");

    expect(() =>
      mapConnectionHealthRows(
        [connectionRow(shopifyConnectionId, "shopify")],
        [],
        [{ connection_id: shopifyConnectionId, unclassified_count: 0 }],
      ),
    ).toThrow("must be positive");

    expect(() =>
      mapConnectionHealthRows(
        [connectionRow(shopifyConnectionId, "shopify")],
        [],
        [
          { connection_id: shopifyConnectionId, unclassified_count: 1 },
          { connection_id: shopifyConnectionId, unclassified_count: 2 },
        ],
      ),
    ).toThrow("duplicate connection");
  });
});

function connectionRow(
  id: string,
  provider: "shopify" | "stripe" | "accounting_csv",
): Record<string, unknown> {
  return {
    id,
    provider,
    external_account_id: `synthetic-${provider}`,
    status: "healthy",
    connector_version: "test-1",
    sync_enabled: provider !== "accounting_csv",
    api_version: null,
    last_successful_sync_at: null,
    last_verified_webhook_at: null,
    retry_count: 0,
    dead_letter_count: 0,
    error_code: null,
    updated_at: "2026-07-29T00:00:00.000Z",
  };
}

function watermarkRow(
  connectionId: string,
  objectType: string,
  latestSourceAt: string,
  latestReceivedAt: string,
): Record<string, unknown> {
  return {
    connection_id: connectionId,
    external_object_type: objectType,
    latest_source_at: latestSourceAt,
    latest_received_at: latestReceivedAt,
  };
}
