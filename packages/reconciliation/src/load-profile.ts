import { createHash } from "node:crypto";

import { asCurrency, money, type CanonicalRecord } from "@workspace/domain";
import {
  syntheticAccountingRefund,
  syntheticFee,
  syntheticOrder,
  syntheticPayment,
  syntheticRefund,
} from "@workspace/test-support";

import { MAX_RECONCILIATION_RECORDS, type ReconciliationResult } from "./index.js";

export const REPRESENTATIVE_LOAD_SCENARIO_VERSION = "1.0.0";

export interface RepresentativeLoadProfile {
  readonly exactOrderPaymentFeeGroups: number;
  readonly refundTriples: number;
  readonly missingPaymentOrders: number;
  readonly unmatchedPaymentFeePairs: number;
  readonly malformedIdentifierOrders: number;
}

export const REPRESENTATIVE_LOAD_PROFILE: RepresentativeLoadProfile = {
  exactOrderPaymentFeeGroups: 20_000,
  refundTriples: 8_000,
  missingPaymentOrders: 4_000,
  unmatchedPaymentFeePairs: 4_000,
  malformedIdentifierOrders: 4_000,
};

export interface RepresentativeLoadDataset {
  readonly records: readonly CanonicalRecord[];
  readonly distribution: {
    readonly orders: number;
    readonly payments: number;
    readonly processingFees: number;
    readonly refunds: number;
    readonly accountingEntries: number;
  };
  readonly scenarios: RepresentativeLoadProfile;
  readonly expected: {
    readonly input: number;
    readonly matches: number;
    readonly exceptions: number;
    readonly ambiguousCandidates: 0;
    readonly matchRuleCounts: Readonly<Record<string, number>>;
    readonly exceptionTypeCounts: Readonly<Record<string, number>>;
  };
  readonly moneyConservation: {
    readonly currency: "USD";
    readonly matchedOrderMinor: string;
    readonly matchedPaymentMinor: string;
    readonly shopifyRefundMinor: string;
    readonly stripeRefundMinor: string;
    readonly accountingRefundMinor: string;
  };
}

/**
 * Builds a deterministic, synthetic load profile with both successful and exceptional outcomes.
 * No random generator, wall clock, customer data, or floating-point money enters the fixture.
 */
export function buildRepresentativeLoadDataset(
  profile: RepresentativeLoadProfile = REPRESENTATIVE_LOAD_PROFILE,
): RepresentativeLoadDataset {
  validateProfile(profile);

  const records: CanonicalRecord[] = [];
  let matchedOrderMinor = 0n;
  let matchedPaymentMinor = 0n;
  let shopifyRefundMinor = 0n;
  let stripeRefundMinor = 0n;
  let accountingRefundMinor = 0n;

  for (let index = 0; index < profile.exactOrderPaymentFeeGroups; index += 1) {
    const orderSequence = 1_000_000 + index;
    const paymentSequence = 101_000_000 + index;
    const feeSequence = 201_000_000 + index;
    const orderExternalId = `load-order-${index.toString()}`;
    const paymentExternalId = `load-payment-${index.toString()}`;
    const amountMinor = 10_000n + BigInt(index % 10_000);
    const amount = money(amountMinor, asCurrency("USD"));

    matchedOrderMinor += amountMinor;
    matchedPaymentMinor += amountMinor;
    records.push(
      syntheticOrder(
        {
          externalId: orderExternalId,
          orderReference: `#LOAD-${index.toString()}`,
          customerReference: `load-customer-${index.toString()}`,
          amount,
        },
        orderSequence,
      ),
      syntheticPayment(
        {
          externalId: paymentExternalId,
          orderReference: orderExternalId,
          providerOrderReference: orderExternalId,
          customerReference: `load-customer-${index.toString()}`,
          amount,
        },
        paymentSequence,
      ),
      syntheticFee(
        {
          paymentReference: paymentExternalId,
        },
        feeSequence,
      ),
    );
  }

  for (let index = 0; index < profile.refundTriples; index += 1) {
    const shopifySequence = 301_000_000 + index;
    const stripeSequence = 401_000_000 + index;
    const accountingSequence = 501_000_000 + index;
    const refundReference = `load-refund-${index.toString()}`;
    const shopifyExternalId = `shopify-${refundReference}`;
    const orderReference = `load-refund-order-${index.toString()}`;
    const paymentReference = `load-refund-payment-${index.toString()}`;
    const amountMinor = 2_500n + BigInt(index % 500);
    const amount = money(amountMinor, asCurrency("USD"));

    shopifyRefundMinor += amountMinor;
    stripeRefundMinor += amountMinor;
    accountingRefundMinor += amountMinor;
    records.push(
      syntheticRefund(
        "shopify",
        {
          externalId: shopifyExternalId,
          orderReference,
          paymentReference,
          refundReference,
          amount,
        },
        shopifySequence,
      ),
      syntheticRefund(
        "stripe",
        {
          externalId: `stripe-${refundReference}`,
          orderReference,
          paymentReference,
          refundReference,
          amount,
        },
        stripeSequence,
      ),
      syntheticAccountingRefund(
        {
          transactionReference: shopifyExternalId,
          orderReference,
          amount,
        },
        accountingSequence,
      ),
    );
  }

  for (let index = 0; index < profile.missingPaymentOrders; index += 1) {
    records.push(
      syntheticOrder(
        {
          externalId: `missing-payment-order-${index.toString()}`,
          orderReference: `#MISSING-${index.toString()}`,
          customerReference: `missing-payment-customer-${index.toString()}`,
          amount: money(30_000n + BigInt(index), asCurrency("EUR")),
        },
        601_000_000 + index,
      ),
    );
  }

  for (let index = 0; index < profile.unmatchedPaymentFeePairs; index += 1) {
    const paymentExternalId = `unmatched-payment-${index.toString()}`;
    records.push(
      syntheticPayment(
        {
          externalId: paymentExternalId,
          orderReference: `absent-order-${index.toString()}`,
          providerOrderReference: `absent-order-${index.toString()}`,
          customerReference: `unmatched-payment-customer-${index.toString()}`,
          amount: money(40_000n + BigInt(index), asCurrency("USD")),
        },
        701_000_000 + index,
      ),
      syntheticFee(
        {
          paymentReference: paymentExternalId,
        },
        801_000_000 + index,
      ),
    );
  }

  for (let index = 0; index < profile.malformedIdentifierOrders; index += 1) {
    records.push(
      syntheticOrder(
        {
          externalId: ` malformed-load-order-${index.toString()} `,
          financialStatus: "pending",
        },
        901_000_000 + index,
      ),
    );
  }

  const input = recordCount(profile);
  if (records.length !== input) {
    throw new Error("representative load fixture cardinality drifted");
  }

  return {
    records,
    distribution: {
      orders:
        profile.exactOrderPaymentFeeGroups +
        profile.missingPaymentOrders +
        profile.malformedIdentifierOrders,
      payments: profile.exactOrderPaymentFeeGroups + profile.unmatchedPaymentFeePairs,
      processingFees: profile.exactOrderPaymentFeeGroups + profile.unmatchedPaymentFeePairs,
      refunds: profile.refundTriples * 2,
      accountingEntries: profile.refundTriples,
    },
    scenarios: profile,
    expected: {
      input,
      matches: profile.exactOrderPaymentFeeGroups + profile.refundTriples * 2,
      exceptions:
        profile.missingPaymentOrders +
        profile.unmatchedPaymentFeePairs +
        profile.malformedIdentifierOrders,
      ambiguousCandidates: 0,
      matchRuleCounts: {
        "order-payment": profile.exactOrderPaymentFeeGroups,
        refund: profile.refundTriples,
        "refund-accounting": profile.refundTriples,
      },
      exceptionTypeCounts: {
        malformed_identifier: profile.malformedIdentifierOrders,
        paid_order_missing_payment: profile.missingPaymentOrders,
        payment_missing_order: profile.unmatchedPaymentFeePairs,
      },
    },
    moneyConservation: {
      currency: "USD",
      matchedOrderMinor: matchedOrderMinor.toString(),
      matchedPaymentMinor: matchedPaymentMinor.toString(),
      shopifyRefundMinor: shopifyRefundMinor.toString(),
      stripeRefundMinor: stripeRefundMinor.toString(),
      accountingRefundMinor: accountingRefundMinor.toString(),
    },
  };
}

export function digestReconciliationResult(result: ReconciliationResult): string {
  return createHash("sha256")
    .update(
      JSON.stringify(result, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    )
    .digest("hex");
}

function validateProfile(profile: RepresentativeLoadProfile): void {
  for (const [name, count] of Object.entries(profile)) {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  const count = recordCount(profile);
  if (count > MAX_RECONCILIATION_RECORDS) {
    throw new Error(
      `representative load profile has ${count.toString()} records; maximum is ${MAX_RECONCILIATION_RECORDS.toString()}`,
    );
  }
}

function recordCount(profile: RepresentativeLoadProfile): number {
  return (
    profile.exactOrderPaymentFeeGroups * 3 +
    profile.refundTriples * 3 +
    profile.missingPaymentOrders +
    profile.unmatchedPaymentFeePairs * 2 +
    profile.malformedIdentifierOrders
  );
}
