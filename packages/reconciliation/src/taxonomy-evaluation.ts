import { asCurrency, money, type CanonicalRecord } from "@workspace/domain";
import {
  defaultPolicy,
  syntheticAccountingRefund,
  syntheticFee,
  syntheticIds,
  syntheticOrder,
  syntheticPayment,
  syntheticRefund,
} from "@workspace/test-support";

import {
  ENGINE_VERSION,
  MAX_ACCOUNTING_CANDIDATES_EVALUATED_PER_REFUND,
  MAX_ACCOUNTING_SPLIT_ENTRIES_PER_REFUND,
  RULE_SET_VERSION,
  reconcile,
  type ExceptionType,
  type ReconciliationPolicy,
} from "./index.js";

interface Scenario {
  readonly name: string;
  readonly records: readonly CanonicalRecord[];
  readonly expectedTypes: readonly ExceptionType[];
  readonly policy?: ReconciliationPolicy;
}

function serializeResult(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

const refundAmountScenario = [
  syntheticRefund("shopify"),
  syntheticRefund("stripe", { amount: money(2_400n, asCurrency("USD")) }),
  syntheticRefund(
    "stripe",
    {
      amount: money(100n, asCurrency("USD")),
      refundReference: "stripe-only-balancing-refund",
    },
    402,
  ),
  syntheticAccountingRefund(),
];
const partialRefundScenario = [
  syntheticRefund("shopify"),
  syntheticRefund("stripe"),
  syntheticRefund(
    "stripe",
    {
      amount: money(500n, asCurrency("USD")),
      refundReference: "stripe-only-extra-refund",
    },
    402,
  ),
  syntheticAccountingRefund(),
];
const duplicateScenario = [
  syntheticOrder({ externalId: "duplicate-order", financialStatus: "pending" }, 1_100),
  syntheticOrder({ externalId: "duplicate-order", financialStatus: "pending" }, 1_101),
  syntheticPayment({ externalId: "duplicate-payment", paymentStatus: "failed" }, 1_200),
  syntheticPayment({ externalId: "duplicate-payment", paymentStatus: "failed" }, 1_201),
  syntheticRefund("shopify", { externalId: "duplicate-refund", refundStatus: "pending" }, 1_300),
  syntheticRefund("shopify", { externalId: "duplicate-refund", refundStatus: "pending" }, 1_301),
  syntheticFee({ externalId: "duplicate-fee" }, 1_400),
  syntheticFee({ externalId: "duplicate-fee" }, 1_401),
  syntheticAccountingRefund({ externalId: "duplicate-accounting" }, 1_500),
  syntheticAccountingRefund({ externalId: "duplicate-accounting" }, 1_501),
];
const refundAmbiguityScenario = [
  syntheticRefund("shopify"),
  syntheticRefund("stripe", { amount: money(1_250n, asCurrency("USD")) }, 401),
  syntheticRefund("stripe", { amount: money(1_250n, asCurrency("USD")) }, 402),
  syntheticAccountingRefund(),
];
const completeMissingIdentifierRecord = syntheticOrder({
  financialStatus: "pending",
  incompleteReasons: ["missing source fields"],
});
const {
  externalId: _missingExternalId,
  orderReference: _missingOrderReference,
  ...missingAndIncompleteRecord
} = completeMissingIdentifierRecord;
void _missingExternalId;
void _missingOrderReference;

const scenarios: readonly Scenario[] = [
  {
    name: "paid_order_missing_payment",
    records: [syntheticOrder()],
    expectedTypes: ["paid_order_missing_payment"],
  },
  {
    name: "payment_missing_order",
    records: [syntheticPayment(), syntheticFee()],
    expectedTypes: ["payment_missing_order"],
  },
  {
    name: "order_payment_amount_mismatch",
    records: [
      syntheticOrder(),
      syntheticPayment({ amount: money(12_499n, asCurrency("USD")) }),
      syntheticFee(),
    ],
    expectedTypes: ["order_payment_amount_mismatch"],
  },
  {
    name: "currency_mismatch",
    records: [
      syntheticOrder(),
      syntheticPayment({ amount: money(12_500n, asCurrency("EUR")) }),
      syntheticFee(),
    ],
    expectedTypes: ["currency_mismatch"],
  },
  {
    name: "shopify_refund_missing_stripe_refund",
    records: [syntheticRefund("shopify"), syntheticAccountingRefund()],
    expectedTypes: ["shopify_refund_missing_stripe_refund"],
  },
  {
    name: "refund_missing_accounting_entry",
    records: [syntheticRefund("shopify"), syntheticRefund("stripe")],
    expectedTypes: ["refund_missing_accounting_entry"],
  },
  {
    name: "refund_amount_mismatch",
    records: refundAmountScenario,
    expectedTypes: ["refund_amount_mismatch"],
  },
  {
    name: "partial_refund_discrepancy",
    records: partialRefundScenario,
    expectedTypes: ["partial_refund_discrepancy"],
  },
  {
    name: "missing_processing_fee",
    records: [syntheticOrder(), syntheticPayment()],
    expectedTypes: ["missing_processing_fee"],
  },
  {
    name: "duplicates",
    records: duplicateScenario,
    expectedTypes: [
      "duplicate_order",
      "duplicate_payment",
      "duplicate_refund",
      "duplicate_processing_fee",
      "duplicate_accounting_entry",
    ],
  },
  {
    name: "missing_and_incomplete",
    records: [missingAndIncompleteRecord],
    expectedTypes: ["missing_identifier", "incomplete_source_record"],
  },
  {
    name: "malformed_identifier",
    records: [
      syntheticOrder({
        externalId: " unsafe-identifier ",
        financialStatus: "pending",
      }),
    ],
    expectedTypes: ["malformed_identifier"],
  },
  {
    name: "delayed_source_record",
    records: [syntheticOrder()],
    policy: {
      ...defaultPolicy,
      evaluatedAt: "2026-07-26T10:30:00.000Z",
    },
    expectedTypes: ["delayed_source_record"],
  },
  {
    name: "ambiguous_identity",
    records: refundAmbiguityScenario,
    expectedTypes: ["ambiguous_identity"],
  },
];

const observedTypes = new Set<ExceptionType>();
const scenarioResults = scenarios.map((scenario) => {
  const result = reconcile({
    organizationId: syntheticIds.organization,
    policy: scenario.policy ?? defaultPolicy,
    records: scenario.records,
  });
  const replay = reconcile({
    organizationId: syntheticIds.organization,
    policy: scenario.policy ?? defaultPolicy,
    records: [...scenario.records].reverse(),
  });
  const actualTypes = result.exceptions.map((item) => item.type).sort();
  const expectedTypes = [...scenario.expectedTypes].sort();
  if (
    JSON.stringify(actualTypes) !== JSON.stringify(expectedTypes) ||
    serializeResult(replay) !== serializeResult(result)
  ) {
    throw new Error(`${scenario.name} failed its taxonomy or permutation-replay contract`);
  }
  for (const type of actualTypes) observedTypes.add(type);
  return {
    name: scenario.name,
    exceptionTypes: actualTypes,
    matches: result.matches.map((item) => item.ruleId).sort(),
    permutationReplayEquivalent: true,
  };
});

const expectedTaxonomy: readonly ExceptionType[] = [
  "paid_order_missing_payment",
  "payment_missing_order",
  "order_payment_amount_mismatch",
  "currency_mismatch",
  "shopify_refund_missing_stripe_refund",
  "refund_missing_accounting_entry",
  "refund_amount_mismatch",
  "partial_refund_discrepancy",
  "missing_processing_fee",
  "duplicate_order",
  "duplicate_payment",
  "duplicate_refund",
  "duplicate_processing_fee",
  "duplicate_accounting_entry",
  "missing_identifier",
  "malformed_identifier",
  "delayed_source_record",
  "ambiguous_identity",
  "incomplete_source_record",
];
if (JSON.stringify([...observedTypes].sort()) !== JSON.stringify([...expectedTaxonomy].sort())) {
  throw new Error("taxonomy evaluation did not exercise every canonical exception type");
}

const normalizedAccountingEntryWithOrder = syntheticAccountingRefund({
  transactionReference: "SHOPIFY-REFUND-400",
});
const { orderReference: _normalizedOrderReference, ...normalizedAccountingEntry } =
  normalizedAccountingEntryWithOrder;
void _normalizedOrderReference;
const normalizedAccountingResult = reconcile({
  organizationId: syntheticIds.organization,
  policy: defaultPolicy,
  records: [syntheticRefund("shopify"), syntheticRefund("stripe"), normalizedAccountingEntry],
});
const normalizedAccountingMatch = normalizedAccountingResult.matches.find(
  (item) => item.ruleId === "refund-accounting",
);
if (
  normalizedAccountingResult.exceptions.length !== 0 ||
  normalizedAccountingMatch?.evidence.reasonCode !== "REFUND_ACCOUNTING_ENTRY_MATCHED"
) {
  throw new Error("normalized unique accounting linkage did not produce a match artifact");
}

const multipleAccountingResult = reconcile({
  organizationId: syntheticIds.organization,
  policy: defaultPolicy,
  records: [
    syntheticRefund("shopify"),
    syntheticRefund("stripe"),
    syntheticAccountingRefund({}, 500),
    syntheticAccountingRefund(
      {
        externalId: "accounting-second",
        transactionReference: "shopify-refund-400",
      },
      501,
    ),
  ],
});
const multipleAccountingException = multipleAccountingResult.exceptions.find(
  (item) => item.evidence.ruleId === "refund-accounting-identity",
);
if (
  multipleAccountingException?.evidence.reasonCode !== "REFUND_ACCOUNTING_IDENTITY_AMBIGUOUS" ||
  multipleAccountingResult.matches.some((item) => item.ruleId === "refund-accounting")
) {
  throw new Error("multiple accounting candidates did not fail closed");
}

const accountingEntryWithTransaction = syntheticAccountingRefund();
const { transactionReference: _sharedTransactionReference, ...sharedAccountingEntry } =
  accountingEntryWithTransaction;
void _sharedTransactionReference;
const sharedAccountingRecords = [
  syntheticRefund("shopify", { refundReference: "refund-one" }, 400),
  syntheticRefund("stripe", { refundReference: "refund-one" }, 401),
  syntheticRefund("shopify", { refundReference: "refund-two" }, 402),
  syntheticRefund("stripe", { refundReference: "refund-two" }, 403),
  sharedAccountingEntry,
];
const sharedAccountingResult = reconcile({
  organizationId: syntheticIds.organization,
  policy: defaultPolicy,
  records: sharedAccountingRecords,
});
const sharedAccountingReplay = reconcile({
  organizationId: syntheticIds.organization,
  policy: defaultPolicy,
  records: [...sharedAccountingRecords].reverse(),
});
const sharedAccountingAmbiguities = sharedAccountingResult.exceptions.filter(
  (item) => item.evidence.ruleId === "refund-accounting-identity",
);
if (
  sharedAccountingResult.matches.some((item) => item.ruleId === "refund-accounting") ||
  sharedAccountingAmbiguities.length !== 1 ||
  serializeResult(sharedAccountingReplay) !== serializeResult(sharedAccountingResult)
) {
  throw new Error("shared accounting entry was reused or produced unstable ambiguity");
}

const accountingCollisionEntries = Array.from(
  { length: MAX_ACCOUNTING_CANDIDATES_EVALUATED_PER_REFUND + 1 },
  (_, index) =>
    syntheticAccountingRefund(
      {
        externalId: `accounting-collision-${index.toString()}`,
        transactionReference: `unrelated-accounting-collision-${index.toString()}`,
      },
      20_000 + index,
    ),
);
const accountingBoundaryResult = reconcile({
  organizationId: syntheticIds.organization,
  policy: defaultPolicy,
  records: [
    syntheticRefund("shopify"),
    syntheticRefund("stripe"),
    ...accountingCollisionEntries.slice(0, MAX_ACCOUNTING_CANDIDATES_EVALUATED_PER_REFUND),
  ],
});
const accountingOverflowResult = reconcile({
  organizationId: syntheticIds.organization,
  policy: defaultPolicy,
  records: [syntheticRefund("shopify"), syntheticRefund("stripe"), ...accountingCollisionEntries],
});
const accountingBoundaryException = accountingBoundaryResult.exceptions.find(
  (item) => item.evidence.ruleId === "refund-accounting-identity",
);
const accountingOverflowException = accountingOverflowResult.exceptions.find(
  (item) => item.evidence.ruleId === "refund-accounting-candidate-overflow",
);
if (
  accountingBoundaryException?.evidence.reasonCode !== "REFUND_ACCOUNTING_IDENTITY_AMBIGUOUS" ||
  accountingOverflowException?.evidence.reasonCode !==
    "REFUND_ACCOUNTING_CANDIDATE_SET_EXCEEDS_LIMIT" ||
  accountingOverflowException.evidence.accountingCandidateSearch?.eligibleCountLowerBound !==
    MAX_ACCOUNTING_CANDIDATES_EVALUATED_PER_REFUND + 1 ||
  accountingOverflowResult.matches.some((item) => item.ruleId === "refund-accounting")
) {
  throw new Error("accounting candidate boundary/overflow contract failed");
}

const mixedKeyOverflowRefund = syntheticRefund(
  "shopify",
  {
    externalId: "overflow-safe-transaction-reference",
    orderReference: "overflow-order",
    refundReference: "overflow-refund",
  },
  410,
);
const mixedKeySafeRefund = syntheticRefund(
  "shopify",
  {
    externalId: "otherwise-unique-refund",
    orderReference: "otherwise-unique-order",
    refundReference: "otherwise-unique-refund-reference",
  },
  420,
);
const mixedKeySafeEntry = syntheticAccountingRefund(
  {
    externalId: "overflow-safe-key-candidate",
    transactionReference: "overflow-safe-transaction-reference",
    orderReference: "otherwise-unique-order",
  },
  31_000,
);
const mixedKeyCrowdedEntries = Array.from(
  { length: MAX_ACCOUNTING_CANDIDATES_EVALUATED_PER_REFUND + 1 },
  (_, index) =>
    syntheticAccountingRefund(
      {
        externalId: `mixed-key-overflow-${index.toString()}`,
        transactionReference: `unrelated-accounting-transaction-${index.toString()}`,
        orderReference: "overflow-order",
      },
      32_000 + index,
    ),
);
const mixedKeyRecords = [
  mixedKeyOverflowRefund,
  syntheticRefund(
    "stripe",
    {
      orderReference: "overflow-order",
      refundReference: "overflow-refund",
    },
    411,
  ),
  mixedKeySafeRefund,
  syntheticRefund(
    "stripe",
    {
      orderReference: "otherwise-unique-order",
      refundReference: "otherwise-unique-refund-reference",
    },
    421,
  ),
  mixedKeySafeEntry,
  ...mixedKeyCrowdedEntries,
];
const mixedKeyResult = reconcile({
  organizationId: syntheticIds.organization,
  policy: defaultPolicy,
  records: mixedKeyRecords,
});
const mixedKeyReplay = reconcile({
  organizationId: syntheticIds.organization,
  policy: defaultPolicy,
  records: [...mixedKeyRecords].reverse(),
});
const mixedKeyReasonCodes = mixedKeyResult.exceptions
  .map((item) => item.evidence.reasonCode)
  .sort();
if (
  JSON.stringify(mixedKeyReasonCodes) !==
    JSON.stringify([
      "REFUND_ACCOUNTING_CANDIDATE_SET_EXCEEDS_LIMIT",
      "REFUND_ACCOUNTING_CANDIDATE_TAINTED_BY_OVERFLOW",
    ]) ||
  mixedKeyResult.matches.some((item) => item.ruleId === "refund-accounting") ||
  serializeResult(mixedKeyReplay) !== serializeResult(mixedKeyResult)
) {
  throw new Error("mixed-key accounting overflow did not prevent hidden reuse");
}

const splitAccountingRecords = [
  syntheticRefund("shopify"),
  syntheticRefund("stripe"),
  syntheticAccountingRefund({ amount: money(1_000n, asCurrency("USD")) }, 500),
  syntheticAccountingRefund(
    {
      externalId: "accounting-split-second",
      amount: money(1_500n, asCurrency("USD")),
    },
    501,
  ),
];
const splitAccountingResult = reconcile({
  organizationId: syntheticIds.organization,
  policy: defaultPolicy,
  records: splitAccountingRecords,
});
const splitAccountingReplay = reconcile({
  organizationId: syntheticIds.organization,
  policy: defaultPolicy,
  records: [...splitAccountingRecords].reverse(),
});
const splitAccountingMatch = splitAccountingResult.matches.find(
  (item) => item.ruleId === "refund-accounting-split",
);
if (
  splitAccountingResult.exceptions.length !== 0 ||
  splitAccountingMatch?.evidence.reasonCode !== "REFUND_ACCOUNTING_SPLIT_TOTAL_MATCHED" ||
  splitAccountingMatch.evidence.sourceRecordCount !== 3 ||
  serializeResult(splitAccountingReplay) !== serializeResult(splitAccountingResult)
) {
  throw new Error("conserved accounting split did not create stable composite evidence");
}

const splitMismatchResult = reconcile({
  organizationId: syntheticIds.organization,
  policy: defaultPolicy,
  records: [
    syntheticRefund("shopify"),
    syntheticRefund("stripe"),
    syntheticAccountingRefund({ amount: money(1_000n, asCurrency("USD")) }, 500),
    syntheticAccountingRefund(
      {
        externalId: "accounting-split-short-second",
        amount: money(1_400n, asCurrency("USD")),
      },
      501,
    ),
  ],
});
const splitMismatch = splitMismatchResult.exceptions.find(
  (item) => item.evidence.ruleId === "refund-accounting-split-amount",
);
if (
  splitMismatch?.type !== "refund_amount_mismatch" ||
  splitMismatch.evidence.reasonCode !== "REFUND_ACCOUNTING_SPLIT_TOTAL_OUTSIDE_TOLERANCE" ||
  splitMismatch.amount?.minor !== 100n
) {
  throw new Error("non-conserving accounting split did not create exact mismatch evidence");
}

const splitOverflowEntries = Array.from(
  { length: MAX_ACCOUNTING_SPLIT_ENTRIES_PER_REFUND + 1 },
  (_, index) =>
    syntheticAccountingRefund(
      {
        externalId: `accounting-split-overflow-${index.toString()}`,
        amount: money(1n, asCurrency("USD")),
      },
      40_000 + index,
    ),
);
const splitOverflowResult = reconcile({
  organizationId: syntheticIds.organization,
  policy: defaultPolicy,
  records: [syntheticRefund("shopify"), syntheticRefund("stripe"), ...splitOverflowEntries],
});
const splitOverflowException = splitOverflowResult.exceptions.find(
  (item) => item.evidence.ruleId === "refund-accounting-split-overflow",
);
if (
  splitOverflowException?.evidence.reasonCode !== "REFUND_ACCOUNTING_SPLIT_SET_EXCEEDS_LIMIT" ||
  splitOverflowException.evidence.accountingCandidateSearch?.evaluationLimit !==
    MAX_ACCOUNTING_SPLIT_ENTRIES_PER_REFUND ||
  splitOverflowResult.matches.some((item) => item.ruleId === "refund-accounting-split")
) {
  throw new Error("accounting split overflow did not fail closed at its independent boundary");
}

process.stdout.write(
  `${JSON.stringify(
    {
      evaluation: "reconciliation-taxonomy-and-accounting-cardinality-v2",
      engineVersion: ENGINE_VERSION,
      ruleSetVersion: RULE_SET_VERSION,
      canonicalExceptionTypes: expectedTaxonomy.length,
      everyCanonicalExceptionTypeExercised: true,
      scenarios: scenarioResults,
      accountingLinkage: {
        normalizedUniqueReferenceMatched: true,
        uniqueMatchRule: normalizedAccountingMatch.ruleId,
        multipleCandidatesFailedClosed: true,
        sharedEntryReused: false,
        sharedEntryAmbiguityArtifacts: sharedAccountingAmbiguities.length,
        evaluationLimit: MAX_ACCOUNTING_CANDIDATES_EVALUATED_PER_REFUND,
        boundaryFullyEvaluated: true,
        overflowFailedClosed: true,
        overflowEligibleCountLowerBound:
          accountingOverflowException.evidence.accountingCandidateSearch.eligibleCountLowerBound,
        mixedKeyOverflowTaintPreventedHiddenReuse: true,
        permutationReplayEquivalent: true,
      },
      splitAccounting: {
        evaluationLimit: MAX_ACCOUNTING_SPLIT_ENTRIES_PER_REFUND,
        wholePositiveBucketRequired: true,
        subsetSelectionPerformed: false,
        conservedBucketMatched: true,
        matchRule: splitAccountingMatch.ruleId,
        matchedAccountingEntryCount: splitAccountingMatch.evidence.sourceRecordCount - 1,
        mismatchDifferenceMinor: splitMismatch.amount.minor.toString(),
        overflowFailedClosed: true,
        permutationReplayEquivalent: true,
      },
      measuredAt: new Date().toISOString(),
      runtime: process.version,
      platform: `${process.platform}-${process.arch}`,
      interpretation:
        "All canonical V1 exception types are exercised by exact synthetic scenarios. Refund/accounting linkage records one unique match, accepts only a complete conserved positive split bucket under one exact transaction reference, and fails closed for non-conservation, multiple identities, reuse, overflow, or mixed-key overflow taint. This is local regression evidence, not staging accuracy or operator-outcome evidence.",
    },
    null,
    2,
  )}\n`,
);
