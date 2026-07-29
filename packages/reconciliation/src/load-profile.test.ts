import { syntheticIds } from "@workspace/test-support";
import { describe, expect, it } from "vitest";

import { reconcile } from "./index.js";
import {
  buildRepresentativeLoadDataset,
  digestReconciliationResult,
  type RepresentativeLoadProfile,
} from "./load-profile.js";

const smallProfile: RepresentativeLoadProfile = {
  exactOrderPaymentFeeGroups: 2,
  refundTriples: 2,
  missingPaymentOrders: 2,
  unmatchedPaymentFeePairs: 2,
  malformedIdentifierOrders: 2,
};

describe("representative reconciliation load profile", () => {
  it("builds the declared mixed financial workload without floating-point money", () => {
    const dataset = buildRepresentativeLoadDataset(smallProfile);

    expect(dataset.records).toHaveLength(20);
    expect(dataset.distribution).toEqual({
      orders: 6,
      payments: 4,
      processingFees: 4,
      refunds: 4,
      accountingEntries: 2,
    });
    expect(dataset.expected).toEqual({
      input: 20,
      matches: 6,
      exceptions: 6,
      ambiguousCandidates: 0,
      matchRuleCounts: {
        "order-payment": 2,
        refund: 2,
        "refund-accounting": 2,
      },
      exceptionTypeCounts: {
        malformed_identifier: 2,
        paid_order_missing_payment: 2,
        payment_missing_order: 2,
      },
    });
    expect(dataset.moneyConservation.matchedOrderMinor).toBe(
      dataset.moneyConservation.matchedPaymentMinor,
    );
    expect(dataset.moneyConservation.shopifyRefundMinor).toBe(
      dataset.moneyConservation.stripeRefundMinor,
    );
    expect(dataset.moneyConservation.shopifyRefundMinor).toBe(
      dataset.moneyConservation.accountingRefundMinor,
    );
    expect(
      dataset.records.every(
        (record) =>
          !("amount" in record) ||
          (typeof record.amount.minor === "bigint" && typeof record.amount.currency === "string"),
      ),
    ).toBe(true);
  });

  it("produces identical identities and artifacts across a complete input reversal", () => {
    const dataset = buildRepresentativeLoadDataset(smallProfile);
    const canonical = reconcile({
      organizationId: syntheticIds.organization,
      policy: {
        version: "load-policy-1",
        evaluatedAt: "2026-07-30T00:00:00.000Z",
        amountToleranceMinor: {},
        dateWindowSeconds: 86_400,
        delayedEventGraceSeconds: 3_600,
        businessTimeZone: "UTC",
      },
      records: dataset.records,
    });
    const reversed = reconcile({
      organizationId: syntheticIds.organization,
      policy: {
        version: "load-policy-1",
        evaluatedAt: "2026-07-30T00:00:00.000Z",
        amountToleranceMinor: {},
        dateWindowSeconds: 86_400,
        delayedEventGraceSeconds: 3_600,
        businessTimeZone: "UTC",
      },
      records: [...dataset.records].reverse(),
    });
    const expectedCounts = {
      input: dataset.expected.input,
      matches: dataset.expected.matches,
      exceptions: dataset.expected.exceptions,
      ambiguousCandidates: dataset.expected.ambiguousCandidates,
    };

    expect(canonical.counts).toEqual(expectedCounts);
    expect(reversed.counts).toEqual(expectedCounts);
    expect(reversed.runKey).toBe(canonical.runKey);
    expect(reversed.inputSnapshotHash).toBe(canonical.inputSnapshotHash);
    expect(digestReconciliationResult(reversed)).toBe(digestReconciliationResult(canonical));
  });

  it("rejects empty, non-integer, and above-ceiling profiles", () => {
    expect(() =>
      buildRepresentativeLoadDataset({
        ...smallProfile,
        exactOrderPaymentFeeGroups: 0,
      }),
    ).toThrow(/positive safe integer/u);
    expect(() =>
      buildRepresentativeLoadDataset({
        ...smallProfile,
        refundTriples: 1.5,
      }),
    ).toThrow(/positive safe integer/u);
    expect(() =>
      buildRepresentativeLoadDataset({
        exactOrderPaymentFeeGroups: 20_001,
        refundTriples: 8_000,
        missingPaymentOrders: 4_000,
        unmatchedPaymentFeePairs: 4_000,
        malformedIdentifierOrders: 4_000,
      }),
    ).toThrow(/maximum is 100000/u);
  });
});
