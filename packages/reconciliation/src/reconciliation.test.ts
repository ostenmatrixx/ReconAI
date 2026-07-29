import { asCurrency, money } from "@workspace/domain";
import {
  completeSyntheticRecords,
  defaultPolicy,
  operatorEvidenceSyntheticRecords,
  syntheticAccountingRefund,
  syntheticFee,
  syntheticIds,
  syntheticOrder,
  syntheticPayment,
  syntheticRefund,
} from "@workspace/test-support";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ENGINE_VERSION,
  MAX_ACCOUNTING_CANDIDATES_EVALUATED_PER_REFUND,
  MAX_ACCOUNTING_SPLIT_ENTRIES_PER_REFUND,
  MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD,
  MAX_ARTIFACT_EVIDENCE_RECORDS,
  RULE_SET_VERSION,
  identifyReconciliation,
  parseReconciliationPolicySnapshot,
  reconcile,
  reconciliationRecordIdentity,
  serializeReconciliationPolicy,
} from "./index.js";

describe("deterministic reconciliation", () => {
  it("matches a complete synthetic order/payment/refund/accounting set", () => {
    const result = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: completeSyntheticRecords(),
    });
    expect(result.exceptions).toEqual([]);
    expect(result.matches.map((item) => item.ruleId).sort()).toEqual([
      "order-payment",
      "refund",
      "refund-accounting",
    ]);
  });

  it("keeps the split operator fixture bounded to three matches and one duplicate-fee exception", () => {
    const result = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: operatorEvidenceSyntheticRecords(),
    });

    expect(result.counts).toEqual({
      input: 8,
      matches: 3,
      exceptions: 1,
      ambiguousCandidates: 0,
    });
    expect(result.matches.map((item) => item.ruleId).sort()).toEqual([
      "order-payment",
      "refund",
      "refund-accounting-split",
    ]);
    expect(result.matches.find((item) => item.ruleId === "refund-accounting-split")).toMatchObject({
      recordIds: [
        "00000000-0000-4000-8000-000000000400",
        "00000000-0000-4000-8000-000000000500",
        "00000000-0000-4000-8000-000000000501",
      ],
      evidence: {
        reasonCode: "REFUND_ACCOUNTING_SPLIT_TOTAL_MATCHED",
        result: "pass",
      },
    });
    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0]).toMatchObject({
      type: "duplicate_processing_fee",
      recordIds: ["00000000-0000-4000-8000-000000000300", "00000000-0000-4000-8000-000000000301"],
      evidence: {
        reasonCode: "DUPLICATE_SOURCE_EXTERNAL_IDENTIFIER",
        result: "fail",
      },
    });
  });

  it("detects a paid order without payment", () => {
    const result = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: [syntheticOrder()],
    });
    expect(result.exceptions.map((item) => item.type)).toContain("paid_order_missing_payment");
  });

  it("detects exact-link amount and currency discrepancies", () => {
    const amountResult = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: [
        syntheticOrder(),
        syntheticPayment({ amount: money(12_499n, asCurrency("USD")) }),
        syntheticFee(),
      ],
    });
    expect(amountResult.exceptions.map((item) => item.type)).toContain(
      "order_payment_amount_mismatch",
    );

    const currencyResult = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: [
        syntheticOrder(),
        syntheticPayment({ amount: money(12_500n, asCurrency("EUR")) }),
        syntheticFee(),
      ],
    });
    expect(currencyResult.exceptions.map((item) => item.type)).toContain("currency_mismatch");
  });

  it("quarantines malformed identifiers instead of matching their trimmed form", () => {
    const order = syntheticOrder({
      externalId: " shopify-order-100 ",
    });
    const result = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: [order, syntheticPayment(), syntheticFee()],
    });
    const malformed = result.exceptions.find((item) => item.type === "malformed_identifier");

    expect(result.matches).toEqual([]);
    expect(result.exceptions.map((item) => item.type).sort()).toEqual([
      "malformed_identifier",
      "payment_missing_order",
    ]);
    expect(malformed).toMatchObject({
      severity: "high",
      recordIds: [order.id],
      evidence: {
        ruleId: "record-identifier-format",
        ruleVersion: "1.5.0",
        ruleSetVersion: "1.5.0",
        reasonCode: "IDENTIFIER_CONTAINS_UNSAFE_FORMAT",
        sourceValues: [
          {
            fieldPath: "externalId",
            value: "\\u0020shopify-order-100\\u0020",
            encoding: "unsafe-code-points-escaped",
          },
        ],
        normalizedValues: [
          {
            fieldPath: "externalId",
            value: "shopify-order-100",
            encoding: "unsafe-code-points-escaped",
            issueCodes: "SURROUNDING_WHITESPACE",
          },
        ],
      },
    });
  });

  it.each([
    ["control character", "reference\u0000value", "FORBIDDEN_CONTROL_CHARACTER"],
    ["line separator", "reference\u2028value", "FORBIDDEN_LINE_SEPARATOR"],
    ["bidi control", "reference\u202Evalue", "BIDI_CONTROL_CHARACTER"],
    ["invisible format", "reference\u200Bvalue", "INVISIBLE_FORMAT_CHARACTER"],
    ["replacement character", "reference\uFFFDvalue", "REPLACEMENT_CHARACTER"],
    ["unpaired surrogate", "reference\uD800value", "UNPAIRED_SURROGATE"],
  ] as const)("detects a %s with display-safe evidence", (_label, externalId, issueCode) => {
    const result = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: [syntheticOrder({ externalId, financialStatus: "pending" })],
    });
    const malformed = result.exceptions.find((item) => item.type === "malformed_identifier");

    expect(malformed?.evidence.normalizedValues[0]).toMatchObject({
      fieldPath: "externalId",
      issueCodes: issueCode,
    });
    expect(malformed?.evidence.sourceValues[0]?.["value"]).toContain("\\u");
    expect(malformed?.evidence.sourceValues[0]).not.toHaveProperty("minor");
  });

  it.each([
    [
      "provenance.externalObjectId",
      () => {
        const baseline = syntheticOrder({ financialStatus: "pending" }, 1_001);
        return syntheticOrder(
          {
            financialStatus: "pending",
            provenance: {
              ...baseline.provenance,
              externalObjectId: "unsafe\u200Bvalue",
            },
          },
          1_001,
        );
      },
    ],
    [
      "externalId",
      () => syntheticOrder({ externalId: "unsafe\u200Bvalue", financialStatus: "pending" }, 1_002),
    ],
    [
      "orderReference",
      () =>
        syntheticOrder({ orderReference: "unsafe\u200Bvalue", financialStatus: "pending" }, 1_003),
    ],
    [
      "customerReference",
      () =>
        syntheticOrder(
          { customerReference: "unsafe\u200Bvalue", financialStatus: "pending" },
          1_004,
        ),
    ],
    [
      "providerOrderReference",
      () => syntheticPayment({ providerOrderReference: "unsafe\u200Bvalue" }, 1_005),
    ],
    [
      "paymentReference",
      () => syntheticRefund("shopify", { paymentReference: "unsafe\u200Bvalue" }, 1_006),
    ],
    [
      "refundReference",
      () => syntheticRefund("shopify", { refundReference: "unsafe\u200Bvalue" }, 1_007),
    ],
    ["paymentReference", () => syntheticFee({ paymentReference: "unsafe\u200Bvalue" }, 1_008)],
    [
      "transactionReference",
      () => syntheticAccountingRefund({ transactionReference: "unsafe\u200Bvalue" }, 1_009),
    ],
  ] as const)("inspects the %s identity-bearing field", (fieldPath, makeRecord) => {
    const result = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: [makeRecord()],
    });
    const malformed = result.exceptions.find((item) => item.type === "malformed_identifier");

    expect(result.exceptions).toHaveLength(1);
    expect(malformed?.evidence.sourceValues).toEqual([
      {
        fieldPath,
        value: "unsafe\\u200Bvalue",
        encoding: "unsafe-code-points-escaped",
      },
    ]);
  });

  it("accepts visible Unicode, interior spaces, and joiners used by legitimate identifiers", () => {
    const result = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: [
        syntheticOrder({
          externalId: "Invoice 2026 α",
          orderReference: "注文 #42",
          customerReference: "👩‍💻 customer",
          financialStatus: "pending",
        }),
      ],
    });

    expect(result.exceptions).toEqual([]);
  });

  it("does not quarantine bounded visible identifier strings", () => {
    const middleCharacter = fc.constantFrom("a", "Z", "0", "-", "_", " ", "é", "日", "👩‍💻");
    const visibleIdentifier = fc
      .tuple(
        fc.constantFrom("a", "é", "日", "👩‍💻"),
        fc.array(middleCharacter, { maxLength: 20 }),
        fc.constantFrom("b", "ß", "界", "🚀"),
      )
      .map(([first, middle, last]) => [first, ...middle, last].join(""));

    fc.assert(
      fc.property(visibleIdentifier, (externalId) => {
        const result = reconcile({
          organizationId: syntheticIds.organization,
          policy: defaultPolicy,
          records: [syntheticOrder({ externalId, financialStatus: "pending" })],
        });
        expect(result.exceptions.some((item) => item.type === "malformed_identifier")).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("keeps malformed-identifier quarantine deterministic across input permutations", () => {
    const records = [
      syntheticOrder({ externalId: "shopify-order-100\u2060" }),
      syntheticPayment(),
      syntheticFee(),
    ];
    const baseline = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records,
    });
    const replay = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: [...records].reverse(),
    });

    expect(replay).toEqual(baseline);
    expect(baseline.engineVersion).toBe(ENGINE_VERSION);
    expect(baseline.ruleSetVersion).toBe(RULE_SET_VERSION);
    expect({ engine: ENGINE_VERSION, rules: RULE_SET_VERSION }).toEqual({
      engine: "0.7.0",
      rules: "1.5.0",
    });
  });

  describe("V1 exception and accounting-link golden coverage", () => {
    it("emits a Shopify-refund missing-Stripe exception while preserving its accounting match", () => {
      const shopifyRefund = syntheticRefund("shopify");
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [shopifyRefund, syntheticAccountingRefund()],
      });

      expect(result.exceptions).toHaveLength(1);
      expect(result.exceptions[0]).toMatchObject({
        type: "shopify_refund_missing_stripe_refund",
        severity: "high",
        recordIds: [shopifyRefund.id],
        evidence: {
          ruleId: "shopify_refund_missing_stripe_refund",
          reasonCode: "SHOPIFY_REFUND_HAS_NO_LINKED_STRIPE_REFUND",
          result: "fail",
        },
      });
      expect(result.matches.map((item) => item.ruleId)).toEqual(["refund-accounting"]);
    });

    it("emits a missing-accounting exception without discarding the provider refund match", () => {
      const shopifyRefund = syntheticRefund("shopify");
      const stripeRefund = syntheticRefund("stripe");
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [shopifyRefund, stripeRefund],
      });

      expect(result.exceptions).toHaveLength(1);
      expect(result.exceptions[0]).toMatchObject({
        type: "refund_missing_accounting_entry",
        recordIds: [shopifyRefund.id],
        evidence: {
          ruleId: "refund_missing_accounting_entry",
          reasonCode: "REFUND_HAS_NO_ACCOUNTING_ENTRY",
        },
      });
      expect(result.matches.map((item) => item.ruleId)).toEqual(["refund"]);
    });

    it("emits a per-refund amount mismatch independently of a balanced cumulative total", () => {
      const shopifyRefund = syntheticRefund("shopify");
      const linkedStripeRefund = syntheticRefund("stripe", {
        amount: money(2_400n, asCurrency("USD")),
      });
      const balancingStripeRefund = syntheticRefund(
        "stripe",
        {
          amount: money(100n, asCurrency("USD")),
          refundReference: "stripe-only-balancing-refund",
        },
        402,
      );
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [
          shopifyRefund,
          linkedStripeRefund,
          balancingStripeRefund,
          syntheticAccountingRefund(),
        ],
      });

      expect(result.exceptions).toHaveLength(1);
      expect(result.exceptions[0]).toMatchObject({
        type: "refund_amount_mismatch",
        amount: money(100n, asCurrency("USD")),
        evidence: {
          ruleId: "refund-amount",
          reasonCode: "REFUND_AMOUNT_OUTSIDE_TOLERANCE",
          toleranceMinor: "0",
        },
      });
    });

    it("emits a cumulative partial-refund discrepancy independently of exact linked refunds", () => {
      const shopifyRefund = syntheticRefund("shopify");
      const stripeRefund = syntheticRefund("stripe");
      const extraStripeRefund = syntheticRefund(
        "stripe",
        {
          amount: money(500n, asCurrency("USD")),
          refundReference: "stripe-only-extra-refund",
        },
        402,
      );
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [shopifyRefund, stripeRefund, extraStripeRefund, syntheticAccountingRefund()],
      });

      expect(result.exceptions).toHaveLength(1);
      expect(result.exceptions[0]).toMatchObject({
        type: "partial_refund_discrepancy",
        evidence: {
          ruleId: "partial-refund-total",
          reasonCode: "CUMULATIVE_PARTIAL_REFUND_TOTAL_MISMATCH",
          sourceValues: [
            { minor: "2500", currency: "USD" },
            { minor: "3000", currency: "USD" },
          ],
        },
      });
      expect(result.matches.map((item) => item.ruleId).sort()).toEqual([
        "refund",
        "refund-accounting",
      ]);
    });

    it("emits a missing processing-fee exception alongside an otherwise valid payment match", () => {
      const payment = syntheticPayment();
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [syntheticOrder(), payment],
      });

      expect(result.exceptions).toHaveLength(1);
      expect(result.exceptions[0]).toMatchObject({
        type: "missing_processing_fee",
        recordIds: [payment.id],
        evidence: {
          ruleId: "missing_processing_fee",
          reasonCode: "SUCCEEDED_PAYMENT_HAS_NO_PROCESSING_FEE",
        },
      });
      expect(result.matches.map((item) => item.ruleId)).toEqual(["order-payment"]);
    });

    it("classifies duplicate source identifiers for every canonical record kind", () => {
      const records = [
        syntheticOrder({ externalId: "duplicate-order", financialStatus: "pending" }, 1_100),
        syntheticOrder({ externalId: "duplicate-order", financialStatus: "pending" }, 1_101),
        syntheticPayment({ externalId: "duplicate-payment", paymentStatus: "failed" }, 1_200),
        syntheticPayment({ externalId: "duplicate-payment", paymentStatus: "failed" }, 1_201),
        syntheticRefund(
          "shopify",
          { externalId: "duplicate-refund", refundStatus: "pending" },
          1_300,
        ),
        syntheticRefund(
          "shopify",
          { externalId: "duplicate-refund", refundStatus: "pending" },
          1_301,
        ),
        syntheticFee({ externalId: "duplicate-fee" }, 1_400),
        syntheticFee({ externalId: "duplicate-fee" }, 1_401),
        syntheticAccountingRefund({ externalId: "duplicate-accounting" }, 1_500),
        syntheticAccountingRefund({ externalId: "duplicate-accounting" }, 1_501),
      ];
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records,
      });

      expect(result.exceptions.map((item) => item.type).sort()).toEqual([
        "duplicate_accounting_entry",
        "duplicate_order",
        "duplicate_payment",
        "duplicate_processing_fee",
        "duplicate_refund",
      ]);
      expect(
        result.exceptions.every(
          (item) =>
            item.evidence.ruleId === "duplicate-external-id" &&
            item.evidence.reasonCode === "DUPLICATE_SOURCE_EXTERNAL_IDENTIFIER" &&
            item.recordIds.length === 2,
        ),
      ).toBe(true);
    });

    it("emits distinct missing-identifier and incomplete-record evidence", () => {
      const completeRecord = syntheticOrder({
        financialStatus: "pending",
        incompleteReasons: ["missing source fields"],
      });
      const {
        externalId: _externalId,
        orderReference: _orderReference,
        ...record
      } = completeRecord;
      void _externalId;
      void _orderReference;
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [record],
      });

      expect(result.exceptions.map((item) => item.type).sort()).toEqual([
        "incomplete_source_record",
        "missing_identifier",
      ]);
      expect(result.exceptions.map((item) => item.evidence.reasonCode).sort()).toEqual([
        "NORMALIZER_MARKED_RECORD_INCOMPLETE",
        "NO_EXTERNAL_OR_ORDER_IDENTIFIER",
      ]);
    });

    it("fails closed when one provider refund has multiple exact Stripe candidates", () => {
      const shopifyRefund = syntheticRefund("shopify");
      const firstStripeRefund = syntheticRefund(
        "stripe",
        { amount: money(1_250n, asCurrency("USD")) },
        401,
      );
      const secondStripeRefund = syntheticRefund(
        "stripe",
        { amount: money(1_250n, asCurrency("USD")) },
        402,
      );
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [
          shopifyRefund,
          firstStripeRefund,
          secondStripeRefund,
          syntheticAccountingRefund(),
        ],
      });

      expect(result.exceptions).toHaveLength(1);
      expect(result.exceptions[0]).toMatchObject({
        type: "ambiguous_identity",
        severity: "medium",
        evidence: {
          ruleId: "refund-identity",
          reasonCode: "REFUND_HAS_MULTIPLE_EXACT_CANDIDATES",
          result: "fail",
        },
      });
      expect(result.matches.map((item) => item.ruleId)).toEqual(["refund-accounting"]);
    });

    it("records one evidence-backed accounting match using normalized references", () => {
      const shopifyRefund = syntheticRefund("shopify");
      const accountingEntryWithOrder = syntheticAccountingRefund({
        transactionReference: "SHOPIFY-REFUND-400",
      });
      const { orderReference: _orderReference, ...accountingEntry } = accountingEntryWithOrder;
      void _orderReference;
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [shopifyRefund, syntheticRefund("stripe"), accountingEntry],
      });
      const accountingMatch = result.matches.find((item) => item.ruleId === "refund-accounting");

      expect(result.exceptions).toEqual([]);
      expect(accountingMatch).toMatchObject({
        confidence: "exact",
        recordIds: [shopifyRefund.id, accountingEntry.id].sort(),
        evidence: {
          ruleId: "refund-accounting",
          ruleVersion: "1.5.0",
          reasonCode: "REFUND_ACCOUNTING_ENTRY_MATCHED",
          result: "pass",
          toleranceMinor: "0",
          sourceValues: [
            { minor: "2500", currency: "USD" },
            { minor: "2500", currency: "USD" },
          ],
        },
      });
    });

    it("matches one complete positive split bucket with exact refund-reference conservation", () => {
      const shopifyRefund = syntheticRefund("shopify");
      const firstEntry = syntheticAccountingRefund(
        {
          amount: money(1_000n, asCurrency("USD")),
        },
        500,
      );
      const secondEntry = syntheticAccountingRefund(
        {
          externalId: "accounting-split-second",
          amount: money(1_500n, asCurrency("USD")),
        },
        501,
      );
      const records = [shopifyRefund, syntheticRefund("stripe"), firstEntry, secondEntry];
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records,
      });
      const replay = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [...records].reverse(),
      });
      const accountingMatch = result.matches.find(
        (item) => item.ruleId === "refund-accounting-split",
      );

      expect(result.exceptions).toEqual([]);
      expect(result.matches.map((item) => item.ruleId).sort()).toEqual([
        "refund",
        "refund-accounting-split",
      ]);
      expect(accountingMatch).toMatchObject({
        confidence: "composite",
        recordIds: [shopifyRefund.id, firstEntry.id, secondEntry.id].sort(),
        evidence: {
          ruleId: "refund-accounting-split",
          ruleVersion: "1.5.0",
          reasonCode: "REFUND_ACCOUNTING_SPLIT_TOTAL_MATCHED",
          result: "pass",
          toleranceMinor: "0",
          sourceRecordCount: 3,
          sourceValues: [
            { minor: "2500", currency: "USD" },
            { minor: "1000", currency: "USD" },
            { minor: "1500", currency: "USD" },
            { minor: "2500", currency: "USD" },
          ],
        },
      });
      expect(replay).toEqual(result);
    });

    it("applies the captured currency tolerance to the complete split total", () => {
      const shopifyRefund = syntheticRefund("shopify");
      const firstEntry = syntheticAccountingRefund(
        {
          amount: money(1_000n, asCurrency("USD")),
        },
        500,
      );
      const secondEntry = syntheticAccountingRefund(
        {
          externalId: "accounting-tolerated-split-second",
          amount: money(1_499n, asCurrency("USD")),
        },
        501,
      );
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: {
          ...defaultPolicy,
          amountToleranceMinor: { [asCurrency("USD")]: 1n },
        },
        records: [shopifyRefund, syntheticRefund("stripe"), firstEntry, secondEntry],
      });

      expect(result.exceptions).toEqual([]);
      expect(
        result.matches.find((item) => item.ruleId === "refund-accounting-split"),
      ).toMatchObject({
        evidence: {
          reasonCode: "REFUND_ACCOUNTING_SPLIT_TOTAL_MATCHED",
          toleranceMinor: "1",
          sourceValues: [
            { minor: "2500", currency: "USD" },
            { minor: "1000", currency: "USD" },
            { minor: "1499", currency: "USD" },
            { minor: "2499", currency: "USD" },
          ],
        },
      });
    });

    it("conserves arbitrary bounded positive partitions without selecting a subset", () => {
      const partitions = fc
        .uniqueArray(fc.integer({ min: 1, max: 2_499 }), {
          minLength: 1,
          maxLength: 9,
        })
        .map((cuts) => {
          const sorted = cuts.sort((left, right) => left - right);
          const boundaries = [0, ...sorted, 2_500];
          return boundaries.slice(1).map((boundary, index) => {
            const previous = boundaries[index];
            if (previous === undefined) throw new Error("partition boundary missing");
            return boundary - previous;
          });
        });

      fc.assert(
        fc.property(partitions, (partition) => {
          const shopifyRefund = syntheticRefund("shopify");
          const entries = partition.map((minor, index) =>
            syntheticAccountingRefund(
              {
                externalId: `accounting-property-split-${index.toString()}`,
                amount: money(BigInt(minor), asCurrency("USD")),
              },
              500 + index,
            ),
          );
          const records = [shopifyRefund, syntheticRefund("stripe"), ...entries];
          const result = reconcile({
            organizationId: syntheticIds.organization,
            policy: defaultPolicy,
            records,
          });
          const replay = reconcile({
            organizationId: syntheticIds.organization,
            policy: defaultPolicy,
            records: [...records].reverse(),
          });

          expect(result.exceptions).toEqual([]);
          expect(result.matches.map((item) => item.ruleId).sort()).toEqual([
            "refund",
            "refund-accounting-split",
          ]);
          expect(replay).toEqual(result);
        }),
        { numRuns: 100 },
      );
    });

    it("records a split-total amount mismatch instead of treating linked rows as missing", () => {
      const shopifyRefund = syntheticRefund("shopify");
      const firstEntry = syntheticAccountingRefund(
        {
          amount: money(1_000n, asCurrency("USD")),
        },
        500,
      );
      const secondEntry = syntheticAccountingRefund(
        {
          externalId: "accounting-split-short-second",
          amount: money(1_400n, asCurrency("USD")),
        },
        501,
      );
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [shopifyRefund, syntheticRefund("stripe"), firstEntry, secondEntry],
      });
      const accountingMismatch = result.exceptions.find(
        (item) => item.evidence.ruleId === "refund-accounting-split-amount",
      );

      expect(accountingMismatch).toMatchObject({
        type: "refund_amount_mismatch",
        severity: "high",
        amount: { minor: 100n, currency: "USD" },
        recordIds: [shopifyRefund.id, firstEntry.id, secondEntry.id].sort(),
        evidence: {
          reasonCode: "REFUND_ACCOUNTING_SPLIT_TOTAL_OUTSIDE_TOLERANCE",
          result: "fail",
          toleranceMinor: "0",
        },
      });
      expect(result.matches.map((item) => item.ruleId)).toEqual(["refund"]);
    });

    it("fails closed when an exact row competes with a possible split representation", () => {
      const shopifyRefund = syntheticRefund("shopify");
      const exactEntry = syntheticAccountingRefund({}, 500);
      const firstSplitEntry = syntheticAccountingRefund(
        {
          externalId: "accounting-alternative-split-first",
          amount: money(1_000n, asCurrency("USD")),
        },
        501,
      );
      const secondSplitEntry = syntheticAccountingRefund(
        {
          externalId: "accounting-alternative-split-second",
          amount: money(1_500n, asCurrency("USD")),
        },
        502,
      );
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [
          shopifyRefund,
          syntheticRefund("stripe"),
          exactEntry,
          firstSplitEntry,
          secondSplitEntry,
        ],
      });

      const ambiguity = result.exceptions.find(
        (item) => item.evidence.ruleId === "refund-accounting-split-identity",
      );
      expect(ambiguity).toMatchObject({
        type: "ambiguous_identity",
        evidence: {
          ruleId: "refund-accounting-split-identity",
          reasonCode: "REFUND_ACCOUNTING_SPLIT_IDENTITY_AMBIGUOUS",
          result: "ambiguous",
        },
      });
      expect(result.matches.some((item) => item.ruleId.startsWith("refund-accounting"))).toBe(
        false,
      );
    });

    it("does not combine rows from distinct refund-identity buckets", () => {
      const shopifyRefund = syntheticRefund("shopify");
      const externalIdEntry = syntheticAccountingRefund(
        {
          amount: money(1_000n, asCurrency("USD")),
        },
        500,
      );
      const refundReferenceEntry = syntheticAccountingRefund(
        {
          externalId: "accounting-refund-reference-bucket",
          transactionReference: "shopify-refund-1",
          amount: money(1_500n, asCurrency("USD")),
        },
        501,
      );
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [shopifyRefund, syntheticRefund("stripe"), externalIdEntry, refundReferenceEntry],
      });

      const ambiguity = result.exceptions.find(
        (item) => item.evidence.ruleId === "refund-accounting-split-identity",
      );
      expect(ambiguity).toMatchObject({
        type: "ambiguous_identity",
        evidence: {
          ruleId: "refund-accounting-split-identity",
          reasonCode: "REFUND_ACCOUNTING_SPLIT_IDENTITY_AMBIGUOUS",
        },
      });
      expect(result.matches.some((item) => item.ruleId.startsWith("refund-accounting"))).toBe(
        false,
      );
    });

    it("does not net non-positive rows into a conserved split total", () => {
      const shopifyRefund = syntheticRefund("shopify");
      const positiveEntry = syntheticAccountingRefund(
        {
          amount: money(2_600n, asCurrency("USD")),
        },
        500,
      );
      const negativeEntry = syntheticAccountingRefund(
        {
          externalId: "accounting-negative-split",
          amount: money(-100n, asCurrency("USD")),
        },
        501,
      );
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [shopifyRefund, syntheticRefund("stripe"), positiveEntry, negativeEntry],
      });

      const ambiguity = result.exceptions.find(
        (item) => item.evidence.ruleId === "refund-accounting-split-sign",
      );
      expect(ambiguity).toMatchObject({
        type: "ambiguous_identity",
        evidence: {
          ruleId: "refund-accounting-split-sign",
          reasonCode: "REFUND_ACCOUNTING_SPLIT_REQUIRES_POSITIVE_ENTRIES",
        },
      });
      expect(result.matches.some((item) => item.ruleId.startsWith("refund-accounting"))).toBe(
        false,
      );
    });

    it("bounds strong-reference split evaluation independently of amount windows", () => {
      const shopifyRefund = syntheticRefund("shopify");
      const accountingEntries = Array.from(
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
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [shopifyRefund, syntheticRefund("stripe"), ...accountingEntries],
      });
      const overflow = result.exceptions.find(
        (item) => item.evidence.ruleId === "refund-accounting-split-overflow",
      );

      expect(overflow).toMatchObject({
        type: "ambiguous_identity",
        recordIds: [shopifyRefund.id],
        evidence: {
          reasonCode: "REFUND_ACCOUNTING_SPLIT_SET_EXCEEDS_LIMIT",
          result: "ambiguous",
          accountingCandidateSearch: {
            eligibleCountLowerBound: MAX_ACCOUNTING_SPLIT_ENTRIES_PER_REFUND + 1,
            evaluationLimit: MAX_ACCOUNTING_SPLIT_ENTRIES_PER_REFUND,
            complete: false,
          },
        },
      });
      expect(result.matches.some((item) => item.ruleId.startsWith("refund-accounting"))).toBe(
        false,
      );
    });

    it("taints an otherwise unique entry hidden inside a strong-reference split overflow", () => {
      const overflowRefund = syntheticRefund(
        "shopify",
        {
          externalId: "strong-overflow-refund",
          orderReference: "strong-overflow-order",
          refundReference: "strong-overflow-alternate",
        },
        410,
      );
      const otherwiseUniqueRefund = syntheticRefund(
        "shopify",
        {
          externalId: "otherwise-unique-refund",
          orderReference: "otherwise-unique-order",
          refundReference: "otherwise-unique-refund-reference",
          amount: money(1_000n, asCurrency("USD")),
        },
        420,
      );
      const accountingEntries = Array.from(
        { length: MAX_ACCOUNTING_SPLIT_ENTRIES_PER_REFUND + 1 },
        (_, index) =>
          syntheticAccountingRefund(
            {
              externalId: `strong-overflow-accounting-${index.toString()}`,
              transactionReference: "strong-overflow-refund",
              orderReference: index === 0 ? "otherwise-unique-order" : "strong-overflow-order",
              amount: money(BigInt(index === 0 ? 1_000 : 1), asCurrency("USD")),
            },
            41_000 + index,
          ),
      );
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [overflowRefund, otherwiseUniqueRefund, ...accountingEntries],
      });
      const accountingReasons = result.exceptions
        .map((item) => item.evidence.reasonCode)
        .filter((reason) => reason.startsWith("REFUND_ACCOUNTING"))
        .sort();

      expect(accountingReasons).toEqual([
        "REFUND_ACCOUNTING_CANDIDATE_TAINTED_BY_OVERFLOW",
        "REFUND_ACCOUNTING_SPLIT_SET_EXCEEDS_LIMIT",
      ]);
      expect(result.matches.some((item) => item.ruleId.startsWith("refund-accounting"))).toBe(
        false,
      );
    });

    it("fails closed when a positive split total exceeds the signed 64-bit money boundary", () => {
      const shopifyRefund = syntheticRefund("shopify");
      const firstEntry = syntheticAccountingRefund(
        {
          amount: money(2n ** 63n - 1n, asCurrency("USD")),
        },
        500,
      );
      const secondEntry = syntheticAccountingRefund(
        {
          externalId: "accounting-split-overflow-minor",
          amount: money(1n, asCurrency("USD")),
        },
        501,
      );
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [shopifyRefund, syntheticRefund("stripe"), firstEntry, secondEntry],
      });

      const ambiguity = result.exceptions.find(
        (item) => item.evidence.ruleId === "refund-accounting-split-amount",
      );
      expect(ambiguity).toMatchObject({
        type: "ambiguous_identity",
        evidence: {
          ruleId: "refund-accounting-split-amount",
          reasonCode: "REFUND_ACCOUNTING_SPLIT_TOTAL_OUT_OF_RANGE",
        },
      });
      expect(result.matches.some((item) => item.ruleId.startsWith("refund-accounting"))).toBe(
        false,
      );
    });

    it("retains source evidence when a safe split total has an unrepresentable difference", () => {
      const shopifyRefund = syntheticRefund("shopify", {
        amount: money(-(2n ** 63n), asCurrency("USD")),
      });
      const firstEntry = syntheticAccountingRefund(
        {
          amount: money(2n ** 63n - 2n, asCurrency("USD")),
        },
        500,
      );
      const secondEntry = syntheticAccountingRefund(
        {
          externalId: "accounting-split-large-difference",
          amount: money(1n, asCurrency("USD")),
        },
        501,
      );
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [shopifyRefund, syntheticRefund("stripe"), firstEntry, secondEntry],
      });
      const accountingMismatch = result.exceptions.find(
        (item) => item.evidence.ruleId === "refund-accounting-split-amount",
      );

      expect(accountingMismatch).toMatchObject({
        type: "refund_amount_mismatch",
        evidence: {
          reasonCode: "REFUND_ACCOUNTING_SPLIT_TOTAL_OUTSIDE_TOLERANCE",
          sourceValues: [
            { minor: "-9223372036854775808", currency: "USD" },
            { minor: "9223372036854775806", currency: "USD" },
            { minor: "1", currency: "USD" },
            { minor: "9223372036854775807", currency: "USD" },
          ],
        },
      });
      expect(accountingMismatch?.amount).toBeUndefined();
    });

    it("never reuses a conserved split bucket across multiple refunds", () => {
      const firstRefund = syntheticRefund(
        "shopify",
        { refundReference: "shared-accounting-split" },
        400,
      );
      const secondRefund = syntheticRefund(
        "shopify",
        {
          externalId: "shopify-refund-second",
          refundReference: "shared-accounting-split",
        },
        402,
      );
      const firstEntry = syntheticAccountingRefund(
        {
          transactionReference: "shared-accounting-split",
          amount: money(1_000n, asCurrency("USD")),
        },
        500,
      );
      const secondEntry = syntheticAccountingRefund(
        {
          externalId: "accounting-shared-split-second",
          transactionReference: "shared-accounting-split",
          amount: money(1_500n, asCurrency("USD")),
        },
        501,
      );
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [firstRefund, secondRefund, firstEntry, secondEntry],
      });
      const accountingAmbiguities = result.exceptions.filter(
        (item) =>
          item.evidence.ruleId === "refund-accounting-identity" &&
          item.evidence.reasonCode === "REFUND_ACCOUNTING_IDENTITY_AMBIGUOUS",
      );

      expect(accountingAmbiguities).toHaveLength(1);
      expect(result.matches.some((item) => item.ruleId.startsWith("refund-accounting"))).toBe(
        false,
      );
    });

    it("fails closed when one refund has multiple eligible accounting entries", () => {
      const shopifyRefund = syntheticRefund("shopify");
      const firstEntry = syntheticAccountingRefund({}, 500);
      const secondEntry = syntheticAccountingRefund(
        {
          externalId: "accounting-second",
          transactionReference: "shopify-refund-400",
        },
        501,
      );
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [shopifyRefund, syntheticRefund("stripe"), firstEntry, secondEntry],
      });
      const accountingAmbiguity = result.exceptions.find(
        (item) => item.evidence.ruleId === "refund-accounting-identity",
      );

      expect(accountingAmbiguity).toMatchObject({
        type: "ambiguous_identity",
        severity: "high",
        evidence: {
          reasonCode: "REFUND_ACCOUNTING_IDENTITY_AMBIGUOUS",
          result: "ambiguous",
          sourceRecordCount: 3,
        },
      });
      expect(result.matches.map((item) => item.ruleId)).toEqual(["refund"]);
    });

    it("never reuses one accounting entry across multiple refunds", () => {
      const firstShopifyRefund = syntheticRefund("shopify", { refundReference: "refund-one" }, 400);
      const firstStripeRefund = syntheticRefund("stripe", { refundReference: "refund-one" }, 401);
      const secondShopifyRefund = syntheticRefund(
        "shopify",
        { refundReference: "refund-two" },
        402,
      );
      const secondStripeRefund = syntheticRefund("stripe", { refundReference: "refund-two" }, 403);
      const accountingEntryWithTransaction = syntheticAccountingRefund();
      const { transactionReference: _transactionReference, ...sharedAccountingEntry } =
        accountingEntryWithTransaction;
      void _transactionReference;
      const records = [
        firstShopifyRefund,
        firstStripeRefund,
        secondShopifyRefund,
        secondStripeRefund,
        sharedAccountingEntry,
      ];
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records,
      });
      const replay = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [...records].reverse(),
      });
      const accountingAmbiguities = result.exceptions.filter(
        (item) => item.evidence.ruleId === "refund-accounting-identity",
      );

      expect(result.matches.filter((item) => item.ruleId === "refund")).toHaveLength(2);
      expect(result.matches.some((item) => item.ruleId === "refund-accounting")).toBe(false);
      expect(accountingAmbiguities).toHaveLength(1);
      expect(accountingAmbiguities[0]).toMatchObject({
        type: "ambiguous_identity",
        evidence: {
          reasonCode: "REFUND_ACCOUNTING_IDENTITY_AMBIGUOUS",
          sourceRecordCount: 3,
        },
      });
      expect(replay).toEqual(result);
    });

    it("evaluates the complete accounting boundary and fails closed above it", () => {
      const shopifyRefund = syntheticRefund("shopify");
      const stripeRefund = syntheticRefund("stripe");
      const accountingEntries = Array.from(
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
      const boundary = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [
          shopifyRefund,
          stripeRefund,
          ...accountingEntries.slice(0, MAX_ACCOUNTING_CANDIDATES_EVALUATED_PER_REFUND),
        ],
      });
      const overflow = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [shopifyRefund, stripeRefund, ...accountingEntries],
      });
      const boundaryAmbiguity = boundary.exceptions.find(
        (item) => item.evidence.ruleId === "refund-accounting-identity",
      );
      const overflowAmbiguity = overflow.exceptions.find(
        (item) => item.evidence.ruleId === "refund-accounting-candidate-overflow",
      );

      expect(boundaryAmbiguity).toMatchObject({
        type: "ambiguous_identity",
        evidence: {
          reasonCode: "REFUND_ACCOUNTING_IDENTITY_AMBIGUOUS",
          sourceRecordCount: MAX_ACCOUNTING_CANDIDATES_EVALUATED_PER_REFUND + 1,
          evidenceTruncated: true,
        },
      });
      expect(overflowAmbiguity).toMatchObject({
        type: "ambiguous_identity",
        recordIds: [shopifyRefund.id],
        evidence: {
          reasonCode: "REFUND_ACCOUNTING_CANDIDATE_SET_EXCEEDS_LIMIT",
          accountingCandidateSearch: {
            eligibleCountLowerBound: MAX_ACCOUNTING_CANDIDATES_EVALUATED_PER_REFUND + 1,
            evaluationLimit: MAX_ACCOUNTING_CANDIDATES_EVALUATED_PER_REFUND,
            complete: false,
          },
        },
      });
      expect(overflow.matches.some((item) => item.ruleId === "refund-accounting")).toBe(false);
    });

    it("taints every lookup key used by an overflowing refund", () => {
      const overflowShopifyRefund = syntheticRefund(
        "shopify",
        {
          externalId: "overflow-safe-transaction-reference",
          orderReference: "overflow-order",
          refundReference: "overflow-refund",
        },
        410,
      );
      const overflowStripeRefund = syntheticRefund(
        "stripe",
        {
          orderReference: "overflow-order",
          refundReference: "overflow-refund",
        },
        411,
      );
      const otherwiseUniqueShopifyRefund = syntheticRefund(
        "shopify",
        {
          externalId: "otherwise-unique-refund",
          orderReference: "otherwise-unique-order",
          refundReference: "otherwise-unique-refund-reference",
          amount: money(1_000n, asCurrency("USD")),
        },
        420,
      );
      const otherwiseUniqueStripeRefund = syntheticRefund(
        "stripe",
        {
          orderReference: "otherwise-unique-order",
          refundReference: "otherwise-unique-refund-reference",
          amount: money(1_000n, asCurrency("USD")),
        },
        421,
      );
      const accountingEntries = Array.from(
        { length: MAX_ACCOUNTING_CANDIDATES_EVALUATED_PER_REFUND + 1 },
        (_, index) =>
          syntheticAccountingRefund(
            {
              externalId: `overflow-taint-accounting-${index.toString()}`,
              transactionReference: `unrelated-accounting-transaction-${index.toString()}`,
              orderReference: "overflow-order",
            },
            30_000 + index,
          ),
      );
      const safeKeyCandidate = syntheticAccountingRefund(
        {
          externalId: "overflow-safe-key-candidate",
          transactionReference: "overflow-safe-transaction-reference",
          orderReference: "otherwise-unique-order",
          amount: money(1_000n, asCurrency("USD")),
        },
        31_000,
      );
      const records = [
        overflowShopifyRefund,
        overflowStripeRefund,
        otherwiseUniqueShopifyRefund,
        otherwiseUniqueStripeRefund,
        safeKeyCandidate,
        ...accountingEntries,
      ];
      const result = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records,
      });
      const replay = reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [...records].reverse(),
      });

      expect(result.exceptions.map((item) => item.evidence.reasonCode).sort()).toEqual([
        "REFUND_ACCOUNTING_CANDIDATE_SET_EXCEEDS_LIMIT",
        "REFUND_ACCOUNTING_CANDIDATE_TAINTED_BY_OVERFLOW",
      ]);
      expect(result.matches.filter((item) => item.ruleId === "refund")).toHaveLength(2);
      expect(result.matches.some((item) => item.ruleId === "refund-accounting")).toBe(false);
      expect(replay).toEqual(result);
    });
  });

  it("never accepts a cross-tenant record in a run snapshot", () => {
    expect(() =>
      reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [syntheticOrder({ organizationId: syntheticIds.otherOrganization })],
      }),
    ).toThrow(/cross-tenant/u);
  });

  it("changes snapshot and artifact identities when record content or version changes", () => {
    const baseline = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: [syntheticOrder()],
    });
    const changedContent = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: [syntheticOrder({ amount: money(12_501n, asCurrency("USD")) })],
    });
    const changedVersion = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: [syntheticOrder({ version: 2 })],
    });

    expect(changedContent.inputSnapshotHash).not.toBe(baseline.inputSnapshotHash);
    expect(changedContent.runKey).not.toBe(baseline.runKey);
    expect(changedContent.exceptions[0]?.id).not.toBe(baseline.exceptions[0]?.id);
    expect(changedVersion.inputSnapshotHash).not.toBe(baseline.inputSnapshotHash);
    expect(changedVersion.exceptions[0]?.id).not.toBe(baseline.exceptions[0]?.id);
    const changedVersionEvidence = changedVersion.exceptions[0]?.evidence.sourceRecordVersions[0];
    expect(changedVersion.exceptions[0]?.evidence.sourceRecordVersions).toHaveLength(1);
    expect(changedVersionEvidence?.id).toBe(syntheticOrder().id);
    expect(changedVersionEvidence?.version).toBe(2);
    expect(changedVersionEvidence?.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects snapshots containing more than one version of the same canonical record", () => {
    expect(() =>
      reconcile({
        organizationId: syntheticIds.organization,
        policy: defaultPolicy,
        records: [syntheticOrder(), syntheticOrder({ version: 2 })],
      }),
    ).toThrow(/multiple versions/u);
  });

  it("keys runs by the complete evaluated policy, not only its display version", () => {
    const withinGrace = reconcile({
      organizationId: syntheticIds.organization,
      policy: {
        ...defaultPolicy,
        evaluatedAt: "2026-07-26T10:30:00.000Z",
      },
      records: [syntheticOrder()],
    });
    const afterGrace = reconcile({
      organizationId: syntheticIds.organization,
      policy: {
        ...defaultPolicy,
        evaluatedAt: "2026-07-27T12:00:00.000Z",
      },
      records: [syntheticOrder()],
    });

    expect(withinGrace.inputSnapshotHash).toBe(afterGrace.inputSnapshotHash);
    expect(withinGrace.policySnapshotHash).not.toBe(afterGrace.policySnapshotHash);
    expect(withinGrace.runKey).not.toBe(afterGrace.runKey);
    expect(withinGrace.exceptions[0]?.type).toBe("delayed_source_record");
    expect(afterGrace.exceptions[0]?.type).toBe("paid_order_missing_payment");
  });

  it("bounds pathological duplicate evidence without changing artifact detection", () => {
    const duplicateCount = MAX_ARTIFACT_EVIDENCE_RECORDS + 1;
    const records = Array.from({ length: duplicateCount }, (_, index) =>
      syntheticOrder(
        {
          externalId: "duplicate-order",
          financialStatus: "pending",
        },
        10_000 + index,
      ),
    );
    const result = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records,
    });
    const duplicate = result.exceptions.find((item) => item.type === "duplicate_order");

    expect(duplicate?.recordIds).toHaveLength(MAX_ARTIFACT_EVIDENCE_RECORDS);
    expect(duplicate?.evidence.sourceRecordVersions).toHaveLength(MAX_ARTIFACT_EVIDENCE_RECORDS);
    expect(duplicate?.evidence.sourceRecordCount).toBe(duplicateCount);
    expect(duplicate?.evidence.evidenceTruncated).toBe(true);
  });

  it("is permutation invariant and replay-idempotent", () => {
    const records = completeSyntheticRecords();
    const baseline = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records,
    });
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...records], {
          minLength: records.length,
          maxLength: records.length,
        }),
        (permutation) => {
          const replay = reconcile({
            organizationId: syntheticIds.organization,
            policy: defaultPolicy,
            records: permutation,
          });
          expect(replay).toEqual(baseline);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("round-trips a JSON-safe policy and identifies a run without executing artifacts", () => {
    const policy = {
      ...defaultPolicy,
      amountToleranceMinor: { USD: 25n },
    };
    const records = completeSyntheticRecords();
    const snapshot = serializeReconciliationPolicy(policy);
    const identity = identifyReconciliation({
      organizationId: syntheticIds.organization,
      policy,
      records,
    });
    const result = reconcile({
      organizationId: syntheticIds.organization,
      policy: parseReconciliationPolicySnapshot(snapshot),
      records,
    });

    expect(snapshot.amountToleranceMinor).toEqual({ USD: "25" });
    expect(identity).toMatchObject({
      runKey: result.runKey,
      inputSnapshotHash: result.inputSnapshotHash,
      policySnapshotHash: result.policySnapshotHash,
    });
    const firstRecord = records[0];
    if (!firstRecord) throw new Error("expected a synthetic reconciliation record");
    expect(reconciliationRecordIdentity(firstRecord).contentSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps an established exact artifact stable when unrelated records are added", () => {
    const baseline = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: [syntheticOrder(), syntheticPayment(), syntheticFee()],
    });
    const expanded = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: [
        syntheticOrder(),
        syntheticPayment(),
        syntheticFee(),
        syntheticOrder(
          {
            externalId: "unrelated-pending-order",
            financialStatus: "pending",
          },
          9_001,
        ),
      ],
    });

    expect(expanded.runKey).not.toBe(baseline.runKey);
    expect(expanded.matches).toContainEqual(baseline.matches[0]);
  });

  it("indexes and aggregates multiple exact payments without scanning unrelated payments", () => {
    const order = syntheticOrder({ amount: money(20_000n, asCurrency("USD")) });
    const firstPayment = syntheticPayment(
      {
        externalId: "pi_split_1",
        amount: money(12_500n, asCurrency("USD")),
      },
      201,
    );
    const secondPayment = syntheticPayment(
      {
        externalId: "pi_split_2",
        amount: money(7_500n, asCurrency("USD")),
      },
      202,
    );
    const result = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: [
        order,
        firstPayment,
        secondPayment,
        syntheticFee({ paymentReference: "pi_split_1" }, 301),
        syntheticFee({ paymentReference: "pi_split_2" }, 302),
        syntheticPayment(
          {
            externalId: "pi_unrelated",
            orderReference: "another-order",
            providerOrderReference: "another-order",
          },
          203,
        ),
        syntheticFee({ paymentReference: "pi_unrelated" }, 303),
      ],
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.ruleId).toBe("order-payment");
    expect(result.matches[0]?.evidence.reasonCode).toBe("ORDER_PAYMENT_TOTAL_MATCHED");
    expect(result.exceptions.map((item) => item.type)).toEqual(["payment_missing_order"]);
  });

  it("evaluates a complete bounded collision set before ranking its strongest candidate", () => {
    const order = syntheticOrder(
      {
        externalId: "collision-order",
        orderReference: "#COLLISION",
        customerReference: "target-customer",
      },
      900,
    );
    const payments = Array.from(
      { length: MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD },
      (_, index) =>
        syntheticPayment(
          {
            orderReference: `unrelated-order-${index.toString()}`,
            providerOrderReference: `unrelated-order-${index.toString()}`,
            customerReference:
              index === MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD - 1
                ? "target-customer"
                : "unrelated-customer",
            effectiveAt:
              index === MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD - 1
                ? order.effectiveAt
                : "2026-07-20T10:00:00.000Z",
          },
          10_000 + index,
        ),
    );
    const strongestPayment = payments.at(-1);
    if (!strongestPayment) throw new Error("expected a strongest payment");

    const result = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: [order, ...payments],
    });
    const orderException = result.exceptions.find((item) => item.recordIds.includes(order.id));
    const strongestCandidate = result.ambiguousCandidates.find((item) =>
      item.recordIds.includes(strongestPayment.id),
    );

    expect(orderException).toMatchObject({
      type: "paid_order_missing_payment",
      evidence: {
        result: "ambiguous",
        candidateSearch: {
          eligibleCount: MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD,
          evaluatedCount: MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD,
          emittedCount: 5,
          evaluationLimit: MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD,
          complete: true,
        },
      },
    });
    expect(strongestCandidate).toMatchObject({
      deterministicScore: 100,
      reasons: ["amount_and_currency", "customer_reference", "date_window"],
    });
  });

  it("fails closed without a partial shortlist when a collision set exceeds the bound", () => {
    const order = syntheticOrder(
      {
        externalId: "overflow-order",
        orderReference: "#OVERFLOW",
        customerReference: "target-customer",
      },
      901,
    );
    const collisionCount = MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD + 1;
    const payments = Array.from({ length: collisionCount }, (_, index) =>
      syntheticPayment(
        {
          orderReference: `unrelated-overflow-order-${index.toString()}`,
          providerOrderReference: `unrelated-overflow-order-${index.toString()}`,
          customerReference:
            index === collisionCount - 1 ? "target-customer" : "unrelated-customer",
          effectiveAt:
            index === collisionCount - 1 ? order.effectiveAt : "2026-07-20T10:00:00.000Z",
        },
        20_000 + index,
      ),
    );
    const baseline = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: [order, ...payments],
    });
    const replay = reconcile({
      organizationId: syntheticIds.organization,
      policy: defaultPolicy,
      records: [...[...payments].reverse(), order],
    });
    const orderException = baseline.exceptions.find((item) => item.recordIds.includes(order.id));

    expect(orderException).toMatchObject({
      type: "ambiguous_identity",
      severity: "high",
      evidence: {
        ruleId: "order-payment-candidate-overflow",
        result: "ambiguous",
        reasonCode: "ORDER_PAYMENT_CANDIDATE_SET_EXCEEDS_LIMIT",
        candidateSearch: {
          eligibleCount: collisionCount,
          evaluatedCount: 0,
          emittedCount: 0,
          evaluationLimit: MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD,
          complete: false,
        },
      },
    });
    expect(baseline.ambiguousCandidates).toEqual([]);
    expect(replay).toEqual(baseline);
  });
});
