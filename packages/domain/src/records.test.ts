import { canonicalFieldProvenance } from "./records.js";
import { asCurrency, money } from "./money.js";
import { CanonicalRecordIdSchema, SourceEventIdSchema } from "./records.js";
import { OrganizationIdSchema } from "./tenancy.js";
import { describe, expect, it } from "vitest";

describe("canonical field provenance", () => {
  it("links normalized fields to immutable source evidence without copying raw payloads", () => {
    const sourceEventId = SourceEventIdSchema.parse("a1000000-0000-4000-8000-000000000001");
    const entries = canonicalFieldProvenance({
      id: CanonicalRecordIdSchema.parse("a2000000-0000-4000-8000-000000000001"),
      organizationId: OrganizationIdSchema.parse("a3000000-0000-4000-8000-000000000001"),
      version: 1,
      kind: "payment",
      externalId: "pi_synthetic",
      providerOrderReference: "order-1",
      effectiveAt: "2026-07-27T00:00:00.000Z",
      amount: money(12_500n, asCurrency("USD")),
      paymentStatus: "succeeded",
      provenance: {
        sourceSystem: "stripe",
        externalObjectType: "payment_intent",
        externalObjectId: "pi_synthetic",
        sourceTimestamp: "2026-07-27T00:00:00.000Z",
        ingestionTimestamp: "2026-07-27T00:00:01.000Z",
        sourceEventId,
        connectorVersion: "1.0.0",
        normalizerVersion: "1.0.0",
      },
    });

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldPath: "amount.minor",
          normalizedValue: "12500",
          sourceValueReference: `source-event:${sourceEventId}#amount.minor`,
          transformationRule: "stripe.amount.minor",
          transformationVersion: "1.0.0",
        }),
        expect.objectContaining({
          fieldPath: "providerOrderReference",
          normalizedValue: "order-1",
        }),
      ]),
    );
    expect(JSON.stringify(entries)).not.toContain("rawBody");
  });
});
