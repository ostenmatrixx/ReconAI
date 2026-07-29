import { createHash } from "node:crypto";

import {
  absoluteMinorDifference,
  money,
  MoneyError,
  serializeCanonicalRecord,
  serializeMoney,
  sumMoney,
  type AccountingEntryRecord,
  type CanonicalRecord,
  type Currency,
  type Money,
  type OrderRecord,
  type OrganizationId,
  type PaymentRecord,
  type ProcessingFeeRecord,
  type RefundRecord,
} from "@workspace/domain";
import { CurrencySchema } from "@workspace/domain";
import { z } from "zod";

export const RULE_SET_VERSION = "1.5.0";
export const ENGINE_VERSION = "0.7.0";
export const MAX_RECONCILIATION_RECORDS = 100_000;
export const MAX_ARTIFACT_EVIDENCE_RECORDS = 500;
export const MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD = 500;
export const MAX_ACCOUNTING_CANDIDATES_EVALUATED_PER_REFUND = 500;
export const MAX_ACCOUNTING_SPLIT_ENTRIES_PER_REFUND = 50;
const RULE_VERSION = "1.5.0";

export type ExceptionType =
  | "paid_order_missing_payment"
  | "payment_missing_order"
  | "order_payment_amount_mismatch"
  | "currency_mismatch"
  | "shopify_refund_missing_stripe_refund"
  | "refund_missing_accounting_entry"
  | "refund_amount_mismatch"
  | "partial_refund_discrepancy"
  | "missing_processing_fee"
  | "duplicate_order"
  | "duplicate_payment"
  | "duplicate_refund"
  | "duplicate_processing_fee"
  | "duplicate_accounting_entry"
  | "missing_identifier"
  | "malformed_identifier"
  | "delayed_source_record"
  | "ambiguous_identity"
  | "incomplete_source_record";

export type RuleResult = "pass" | "fail" | "defer" | "ambiguous";

export interface ReconciliationPolicy {
  readonly version: string;
  readonly evaluatedAt: string;
  readonly amountToleranceMinor: Readonly<Partial<Record<Currency, bigint>>>;
  readonly dateWindowSeconds: number;
  readonly delayedEventGraceSeconds: number;
  readonly businessTimeZone: string;
}

export interface ReconciliationPolicySnapshot {
  readonly version: string;
  readonly evaluatedAt: string;
  readonly amountToleranceMinor: Readonly<Record<string, string>>;
  readonly dateWindowSeconds: number;
  readonly delayedEventGraceSeconds: number;
  readonly businessTimeZone: string;
}

export interface ReconciliationIdentity {
  readonly runKey: string;
  readonly engineVersion: string;
  readonly ruleSetVersion: string;
  readonly inputSnapshotHash: string;
  readonly policySnapshotHash: string;
}

export interface ReconciliationRecordIdentity {
  readonly id: string;
  readonly version: number;
  readonly contentSha256: string;
}

export interface RuleEvidence {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly ruleSetVersion: string;
  readonly sourceRecordIds: readonly string[];
  readonly sourceRecordCount: number;
  readonly evidenceTruncated: boolean;
  readonly sourceRecordVersions: readonly {
    readonly id: string;
    readonly version: number;
    readonly contentSha256: string;
  }[];
  readonly sourceValues: readonly Readonly<Record<string, string>>[];
  readonly normalizedValues: readonly Readonly<Record<string, string>>[];
  readonly toleranceMinor?: string;
  readonly candidateSearch?: CandidateSearchEvidence;
  readonly accountingCandidateSearch?: AccountingCandidateSearchEvidence;
  readonly result: RuleResult;
  readonly reasonCode: string;
  readonly evaluatedAt: string;
}

export interface CandidateSearchEvidence {
  readonly eligibleCount: number;
  readonly evaluatedCount: number;
  readonly emittedCount: number;
  readonly evaluationLimit: number;
  readonly complete: boolean;
}

export interface AccountingCandidateSearchEvidence {
  readonly eligibleCountLowerBound: number;
  readonly evaluationLimit: number;
  readonly complete: false;
}

const evidenceCodeSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u);
const evidenceVersionSchema = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/u);
const evidenceComparisonValueSchema = z
  .record(z.string().min(1).max(100), z.string().max(4_096))
  .refine((value) => Object.keys(value).length <= 20, "at most 20 comparison fields");
const candidateSearchEvidenceSchema = z
  .object({
    eligibleCount: z.number().int().min(0).max(MAX_RECONCILIATION_RECORDS),
    evaluatedCount: z.number().int().min(0).max(MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD),
    emittedCount: z.number().int().min(0).max(5),
    evaluationLimit: z.literal(MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD),
    complete: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.evaluatedCount > value.eligibleCount ||
      value.emittedCount > value.evaluatedCount ||
      (value.complete && value.evaluatedCount !== value.eligibleCount) ||
      (!value.complete && (value.evaluatedCount !== 0 || value.emittedCount !== 0))
    ) {
      context.addIssue({
        code: "custom",
        message: "candidate search counts are inconsistent",
      });
    }
  });
const accountingCandidateSearchEvidenceSchema = z.discriminatedUnion("evaluationLimit", [
  z
    .object({
      eligibleCountLowerBound: z
        .number()
        .int()
        .min(MAX_ACCOUNTING_CANDIDATES_EVALUATED_PER_REFUND + 1)
        .max(MAX_RECONCILIATION_RECORDS),
      evaluationLimit: z.literal(MAX_ACCOUNTING_CANDIDATES_EVALUATED_PER_REFUND),
      complete: z.literal(false),
    })
    .strict(),
  z
    .object({
      eligibleCountLowerBound: z
        .number()
        .int()
        .min(MAX_ACCOUNTING_SPLIT_ENTRIES_PER_REFUND + 1)
        .max(MAX_RECONCILIATION_RECORDS),
      evaluationLimit: z.literal(MAX_ACCOUNTING_SPLIT_ENTRIES_PER_REFUND),
      complete: z.literal(false),
    })
    .strict(),
]);

/**
 * Runtime authority for persisted deterministic evidence. Stored JSON is untrusted until it
 * satisfies this exact, bounded schema; future evidence fields require an intentional contract
 * version change rather than silently crossing API or browser boundaries.
 */
export const RuleEvidenceSchema = z
  .object({
    ruleId: evidenceCodeSchema,
    ruleVersion: evidenceVersionSchema,
    ruleSetVersion: evidenceVersionSchema,
    sourceRecordIds: z.array(z.uuid()).max(MAX_ARTIFACT_EVIDENCE_RECORDS),
    sourceRecordCount: z.number().int().min(0).max(MAX_RECONCILIATION_RECORDS),
    evidenceTruncated: z.boolean(),
    sourceRecordVersions: z
      .array(
        z
          .object({
            id: z.uuid(),
            version: z.number().int().positive(),
            contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .max(MAX_ARTIFACT_EVIDENCE_RECORDS),
    sourceValues: z.array(evidenceComparisonValueSchema).max(MAX_ARTIFACT_EVIDENCE_RECORDS),
    normalizedValues: z.array(evidenceComparisonValueSchema).max(MAX_ARTIFACT_EVIDENCE_RECORDS),
    toleranceMinor: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,18})$/u)
      .optional(),
    candidateSearch: candidateSearchEvidenceSchema.optional(),
    accountingCandidateSearch: accountingCandidateSearchEvidenceSchema.optional(),
    result: z.enum(["pass", "fail", "defer", "ambiguous"]),
    reasonCode: evidenceCodeSchema,
    evaluatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    const versionIds = value.sourceRecordVersions.map((record) => record.id);
    if (
      value.sourceValues.length !== value.normalizedValues.length ||
      value.sourceRecordIds.length !== value.sourceRecordVersions.length ||
      value.sourceRecordIds.some((id, index) => id !== versionIds[index]) ||
      value.sourceRecordCount < value.sourceRecordVersions.length ||
      (!value.evidenceTruncated && value.sourceRecordCount !== value.sourceRecordVersions.length)
    ) {
      context.addIssue({
        code: "custom",
        message: "evidence record and comparison cardinalities are inconsistent",
      });
    }
  });

interface EvidenceComparisonValue {
  readonly source: Readonly<Record<string, string>>;
  readonly normalized: Readonly<Record<string, string>>;
}

export interface ReconciliationMatch {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly confidence: "exact" | "composite";
  readonly recordIds: readonly string[];
  readonly evidence: RuleEvidence;
}

export interface ReconciliationException {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly type: ExceptionType;
  readonly status: "open" | "deferred";
  readonly severity: "low" | "medium" | "high";
  readonly recordIds: readonly string[];
  readonly amount?: Money;
  readonly evidence: RuleEvidence;
}

export interface AmbiguousCandidate {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly recordIds: readonly string[];
  readonly deterministicScore: number;
  readonly reasons: readonly string[];
}

export interface ReconciliationResult {
  readonly runKey: string;
  readonly organizationId: OrganizationId;
  readonly engineVersion: string;
  readonly ruleSetVersion: string;
  readonly inputSnapshotHash: string;
  readonly policySnapshotHash: string;
  readonly matches: readonly ReconciliationMatch[];
  readonly exceptions: readonly ReconciliationException[];
  readonly ambiguousCandidates: readonly AmbiguousCandidate[];
  readonly counts: {
    readonly input: number;
    readonly matches: number;
    readonly exceptions: number;
    readonly ambiguousCandidates: number;
  };
}

export interface ReconciliationInput {
  readonly organizationId: OrganizationId;
  readonly records: readonly CanonicalRecord[];
  readonly policy: ReconciliationPolicy;
}

export class ReconciliationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReconciliationError";
  }
}

const policySnapshotSchema = z
  .object({
    version: z.string().trim().min(1).max(50),
    evaluatedAt: z.iso.datetime({ offset: true }),
    amountToleranceMinor: z
      .record(CurrencySchema, z.string().regex(/^(0|[1-9][0-9]{0,18})$/u))
      .refine((value) => Object.keys(value).length <= 50, "at most 50 currency tolerances"),
    dateWindowSeconds: z
      .number()
      .int()
      .min(0)
      .max(31 * 86_400),
    delayedEventGraceSeconds: z
      .number()
      .int()
      .min(0)
      .max(31 * 86_400),
    businessTimeZone: z.string().trim().min(1).max(100),
  })
  .strict();

export function serializeReconciliationPolicy(
  policy: ReconciliationPolicy,
): ReconciliationPolicySnapshot {
  const amountToleranceMinor = Object.fromEntries(
    Object.entries(policy.amountToleranceMinor)
      .filter((entry): entry is [string, bigint] => entry[1] !== undefined)
      .map(([currency, amount]) => [currency, amount.toString()]),
  );
  return policySnapshotSchema.parse({
    ...policy,
    amountToleranceMinor,
  });
}

export function parseReconciliationPolicySnapshot(value: unknown): ReconciliationPolicy {
  const parsed = policySnapshotSchema.parse(value);
  const amountToleranceMinor = Object.fromEntries(
    Object.entries(parsed.amountToleranceMinor).map(([currency, amount]) => [
      CurrencySchema.parse(currency),
      BigInt(amount),
    ]),
  );
  return {
    ...parsed,
    amountToleranceMinor,
  };
}

export function identifyReconciliation(input: ReconciliationInput): ReconciliationIdentity {
  validateInput(input);
  const records = [...input.records].sort(compareRecords);
  const inputSnapshotHash = stableHash(records.map(recordSnapshotIdentity));
  const policySnapshotHash = stableHash(input.policy);
  return {
    runKey: stableHash([
      input.organizationId,
      inputSnapshotHash,
      policySnapshotHash,
      RULE_SET_VERSION,
      ENGINE_VERSION,
    ]),
    engineVersion: ENGINE_VERSION,
    ruleSetVersion: RULE_SET_VERSION,
    inputSnapshotHash,
    policySnapshotHash,
  };
}

export function reconciliationRecordIdentity(
  record: CanonicalRecord,
): ReconciliationRecordIdentity {
  const [id, version, contentSha256] = recordSnapshotIdentity(record);
  return { id, version, contentSha256 };
}

export function reconcile(input: ReconciliationInput): ReconciliationResult {
  const identity = identifyReconciliation(input);
  const records = [...input.records].sort(compareRecords);
  const matches = new Map<string, ReconciliationMatch>();
  const exceptions = new Map<string, ReconciliationException>();
  const ambiguousCandidates = new Map<string, AmbiguousCandidate>();

  const quarantinedRecordIds = detectRecordProblems(input, records, exceptions);
  const eligibleRecords = records.filter((record) => !quarantinedRecordIds.has(record.id));
  detectDuplicates(input, eligibleRecords, exceptions);

  const orders = eligibleRecords.filter((record): record is OrderRecord => record.kind === "order");
  const payments = eligibleRecords.filter(
    (record): record is PaymentRecord =>
      record.kind === "payment" && record.paymentStatus === "succeeded",
  );
  const fees = eligibleRecords.filter(
    (record): record is ProcessingFeeRecord => record.kind === "processing_fee",
  );
  const refunds = eligibleRecords.filter(
    (record): record is RefundRecord =>
      record.kind === "refund" && record.refundStatus === "succeeded",
  );
  const accountingEntries = eligibleRecords.filter(
    (record): record is AccountingEntryRecord => record.kind === "accounting_entry",
  );
  const paymentIndexes = buildPaymentIndexes(payments);
  const feePaymentReferences = new Set(
    fees
      .map((fee) => fee.paymentReference)
      .filter(isDefined)
      .map(normalizeReference),
  );

  const matchedPayments = new Set<string>();
  for (const order of orders.filter((record) =>
    ["paid", "partially_refunded", "refunded"].includes(record.financialStatus),
  )) {
    const exact = findExactOrderPayments(order, paymentIndexes);

    if (exact.length === 0) {
      const search = findAmountCandidatePayments(order, input.policy, paymentIndexes);
      if (!search.complete) {
        addException(input, exceptions, {
          type: "ambiguous_identity",
          severity: "high",
          records: [order],
          reasonCode: "ORDER_PAYMENT_CANDIDATE_SET_EXCEEDS_LIMIT",
          ruleId: "order-payment-candidate-overflow",
          result: "ambiguous",
          candidateSearch: {
            eligibleCount: search.eligibleCount,
            evaluatedCount: 0,
            emittedCount: 0,
            evaluationLimit: MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD,
            complete: false,
          },
        });
        continue;
      }

      const candidates = search.payments
        .map((payment) => scoreOrderPaymentCandidate(order, payment, input.policy))
        .filter((candidate): candidate is AmbiguousCandidate => candidate !== undefined)
        .sort(
          (left, right) =>
            right.deterministicScore - left.deterministicScore || left.id.localeCompare(right.id),
        )
        .slice(0, 5);

      for (const candidate of candidates) ambiguousCandidates.set(candidate.id, candidate);
      addMissingOrDelayedException(
        input,
        exceptions,
        "paid_order_missing_payment",
        order,
        "ORDER_HAS_NO_LINKED_SUCCEEDED_PAYMENT",
        candidates.length > 0 ? "ambiguous" : undefined,
        {
          eligibleCount: search.eligibleCount,
          evaluatedCount: search.payments.length,
          emittedCount: candidates.length,
          evaluationLimit: MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD,
          complete: true,
        },
      );
      continue;
    }

    for (const payment of exact) matchedPayments.add(payment.id);
    const matchRecords = [order, ...exact];
    const recordIds = recordIdsForEvidence(matchRecords);
    const currencies = new Set([
      order.amount.currency,
      ...exact.map((record) => record.amount.currency),
    ]);

    if (currencies.size > 1) {
      addException(input, exceptions, {
        type: "currency_mismatch",
        severity: "high",
        records: [order, ...exact],
        reasonCode: "ORDER_PAYMENT_CURRENCY_MISMATCH",
        ruleId: "order-payment-currency",
        sourceValues: [order.amount, ...exact.map((record) => record.amount)],
      });
      continue;
    }

    const paymentTotal = sumMoney(
      exact.map((record) => record.amount),
      order.amount.currency,
    );
    const tolerance = toleranceFor(input.policy, order.amount.currency);
    const difference = absoluteMinorDifference(order.amount, paymentTotal);

    if (difference > tolerance) {
      const differenceAmount = moneyIfRepresentable(difference, order.amount.currency);
      addException(input, exceptions, {
        type: "order_payment_amount_mismatch",
        severity: "high",
        records: [order, ...exact],
        ...(differenceAmount === undefined ? {} : { amount: differenceAmount }),
        reasonCode: "ORDER_PAYMENT_TOTAL_OUTSIDE_TOLERANCE",
        ruleId: "order-payment-amount",
        tolerance,
        sourceValues: [order.amount, paymentTotal],
      });
      continue;
    }

    const id = stableArtifactId(input.organizationId, "match", "order-payment", matchRecords);
    matches.set(id, {
      id,
      organizationId: input.organizationId,
      ruleId: "order-payment",
      ruleVersion: RULE_VERSION,
      confidence: "exact",
      recordIds,
      evidence: evidence(input, {
        ruleId: "order-payment",
        records: matchRecords,
        result: "pass",
        reasonCode: "ORDER_PAYMENT_TOTAL_MATCHED",
        tolerance,
        sourceValues: [order.amount, paymentTotal],
      }),
    });
  }

  for (const payment of payments) {
    if (!matchedPayments.has(payment.id)) {
      addMissingOrDelayedException(
        input,
        exceptions,
        "payment_missing_order",
        payment,
        "SUCCEEDED_PAYMENT_HAS_NO_LINKED_ORDER",
      );
    }
    if (!payment.externalId || !feePaymentReferences.has(normalizeReference(payment.externalId))) {
      addMissingOrDelayedException(
        input,
        exceptions,
        "missing_processing_fee",
        payment,
        "SUCCEEDED_PAYMENT_HAS_NO_PROCESSING_FEE",
      );
    }
  }

  reconcileRefunds(input, refunds, accountingEntries, matches, exceptions);

  const sortedMatches = [...matches.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const sortedExceptions = [...exceptions.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const sortedCandidates = [...ambiguousCandidates.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );

  return {
    runKey: identity.runKey,
    organizationId: input.organizationId,
    engineVersion: identity.engineVersion,
    ruleSetVersion: identity.ruleSetVersion,
    inputSnapshotHash: identity.inputSnapshotHash,
    policySnapshotHash: identity.policySnapshotHash,
    matches: sortedMatches,
    exceptions: sortedExceptions,
    ambiguousCandidates: sortedCandidates,
    counts: {
      input: records.length,
      matches: sortedMatches.length,
      exceptions: sortedExceptions.length,
      ambiguousCandidates: sortedCandidates.length,
    },
  };
}

function reconcileRefunds(
  input: ReconciliationInput,
  refunds: readonly RefundRecord[],
  accountingEntries: readonly AccountingEntryRecord[],
  matches: Map<string, ReconciliationMatch>,
  exceptions: Map<string, ReconciliationException>,
): void {
  const shopifyRefunds = refunds.filter((record) => record.provenance.sourceSystem === "shopify");
  const stripeRefunds = refunds.filter((record) => record.provenance.sourceSystem === "stripe");
  const stripeRefundIndexes = buildRefundIndexes(stripeRefunds);
  const accountingIndexes = buildAccountingIndexes(accountingEntries);
  const shopifyRefundsByOrder = groupRefundsByOrder(shopifyRefunds);
  const stripeRefundsByOrder = groupRefundsByOrder(stripeRefunds);
  reconcileRefundAccounting(input, shopifyRefunds, accountingIndexes, matches, exceptions);

  for (const shopifyRefund of shopifyRefunds) {
    const candidates = findExactRefunds(shopifyRefund, stripeRefundIndexes);
    if (candidates.length === 0) {
      addMissingOrDelayedException(
        input,
        exceptions,
        "shopify_refund_missing_stripe_refund",
        shopifyRefund,
        "SHOPIFY_REFUND_HAS_NO_LINKED_STRIPE_REFUND",
      );
    } else if (candidates.length > 1) {
      addException(input, exceptions, {
        type: "ambiguous_identity",
        severity: "medium",
        records: [shopifyRefund, ...candidates],
        reasonCode: "REFUND_HAS_MULTIPLE_EXACT_CANDIDATES",
        ruleId: "refund-identity",
      });
    } else {
      const stripeRefund = candidates[0];
      if (!stripeRefund) throw new ReconciliationError("refund candidate unexpectedly missing");
      const refundRecords = [shopifyRefund, stripeRefund];
      const recordIds = recordIdsForEvidence(refundRecords);
      if (shopifyRefund.amount.currency !== stripeRefund.amount.currency) {
        addException(input, exceptions, {
          type: "currency_mismatch",
          severity: "high",
          records: [shopifyRefund, stripeRefund],
          reasonCode: "REFUND_CURRENCY_MISMATCH",
          ruleId: "refund-currency",
          sourceValues: [shopifyRefund.amount, stripeRefund.amount],
        });
      } else {
        const tolerance = toleranceFor(input.policy, shopifyRefund.amount.currency);
        const difference = absoluteMinorDifference(shopifyRefund.amount, stripeRefund.amount);
        if (difference > tolerance) {
          const differenceAmount = moneyIfRepresentable(difference, shopifyRefund.amount.currency);
          addException(input, exceptions, {
            type: "refund_amount_mismatch",
            severity: "high",
            records: [shopifyRefund, stripeRefund],
            ...(differenceAmount === undefined ? {} : { amount: differenceAmount }),
            reasonCode: "REFUND_AMOUNT_OUTSIDE_TOLERANCE",
            ruleId: "refund-amount",
            tolerance,
            sourceValues: [shopifyRefund.amount, stripeRefund.amount],
          });
        } else {
          const id = stableArtifactId(input.organizationId, "match", "refund", refundRecords);
          matches.set(id, {
            id,
            organizationId: input.organizationId,
            ruleId: "refund",
            ruleVersion: RULE_VERSION,
            confidence: "exact",
            recordIds,
            evidence: evidence(input, {
              ruleId: "refund",
              records: [shopifyRefund, stripeRefund],
              result: "pass",
              reasonCode: "SHOPIFY_STRIPE_REFUND_MATCHED",
              tolerance,
              sourceValues: [shopifyRefund.amount, stripeRefund.amount],
            }),
          });
        }
      }
    }
  }

  for (const [orderReference, shopGroup] of shopifyRefundsByOrder) {
    const stripeGroup = stripeRefundsByOrder.get(orderReference) ?? [];
    if (shopGroup.length === 0 || stripeGroup.length === 0) continue;
    const currency = shopGroup[0]?.amount.currency;
    if (
      currency === undefined ||
      ![...shopGroup, ...stripeGroup].every((record) => record.amount.currency === currency)
    ) {
      continue;
    }
    const shopTotal = sumMoney(
      shopGroup.map((record) => record.amount),
      currency,
    );
    const stripeTotal = sumMoney(
      stripeGroup.map((record) => record.amount),
      currency,
    );
    if (absoluteMinorDifference(shopTotal, stripeTotal) > toleranceFor(input.policy, currency)) {
      addException(input, exceptions, {
        type: "partial_refund_discrepancy",
        severity: "high",
        records: [...shopGroup, ...stripeGroup],
        reasonCode: "CUMULATIVE_PARTIAL_REFUND_TOTAL_MISMATCH",
        ruleId: "partial-refund-total",
        sourceValues: [shopTotal, stripeTotal],
      });
    }
  }
}

function reconcileRefundAccounting(
  input: ReconciliationInput,
  refunds: readonly RefundRecord[],
  indexes: AccountingIndexes,
  matches: Map<string, ReconciliationMatch>,
  exceptions: Map<string, ReconciliationException>,
): void {
  const resolutionCandidates: {
    readonly refund: RefundRecord;
    readonly entries: readonly AccountingEntryRecord[];
    readonly total: Money;
    readonly kind: "single" | "split";
  }[] = [];
  const usageByAccountingEntryId = new Map<
    string,
    {
      count: number;
      first: RefundRecord;
      second?: RefundRecord;
    }
  >();
  const overflowRangesByLookupKey = new Map<string, AccountingAmountRange[]>();
  const overflowedStrongLookupKeys = new Set<string>();

  for (const refund of refunds) {
    const search = findEligibleAccountingCandidates(refund, indexes, input.policy);
    if (!search.complete) {
      for (const range of search.overflowRanges) {
        addToIndex(overflowRangesByLookupKey, range.lookupKey, range);
      }
      for (const lookupKey of accountingStrongLookupKeys(refund)) {
        overflowedStrongLookupKeys.add(lookupKey);
      }
      addException(input, exceptions, {
        type: "ambiguous_identity",
        severity: "high",
        records: [refund],
        reasonCode: "REFUND_ACCOUNTING_CANDIDATE_SET_EXCEEDS_LIMIT",
        ruleId: "refund-accounting-candidate-overflow",
        result: "ambiguous",
        accountingCandidateSearch: {
          eligibleCountLowerBound: search.eligibleCountLowerBound,
          evaluationLimit: MAX_ACCOUNTING_CANDIDATES_EVALUATED_PER_REFUND,
          complete: false,
        },
      });
      continue;
    }
    const strongSearch = findStrongReferenceAccountingCandidates(refund, indexes);
    if (!strongSearch.complete) {
      for (const lookupKey of strongSearch.lookupKeys) {
        overflowedStrongLookupKeys.add(lookupKey);
      }
      addException(input, exceptions, {
        type: "ambiguous_identity",
        severity: "high",
        records: [refund],
        reasonCode: "REFUND_ACCOUNTING_SPLIT_SET_EXCEEDS_LIMIT",
        ruleId: "refund-accounting-split-overflow",
        result: "ambiguous",
        accountingCandidateSearch: {
          eligibleCountLowerBound: strongSearch.eligibleCountLowerBound,
          evaluationLimit: MAX_ACCOUNTING_SPLIT_ENTRIES_PER_REFUND,
          complete: false,
        },
      });
      continue;
    }

    const observedEntries = uniqueAccountingEntries([
      ...search.candidates,
      ...strongSearch.entries,
    ]);
    for (const entry of observedEntries) {
      recordAccountingEntryUsage(usageByAccountingEntryId, entry, refund);
    }
    if (search.candidates.length > 1) {
      addException(input, exceptions, {
        type: "ambiguous_identity",
        severity: "high",
        records: [refund, ...search.candidates],
        reasonCode: "REFUND_ACCOUNTING_IDENTITY_AMBIGUOUS",
        ruleId: "refund-accounting-identity",
        result: "ambiguous",
      });
      continue;
    }

    const exactEntry = search.candidates[0];
    if (strongSearch.entries.length >= 2) {
      if (exactEntry !== undefined || strongSearch.lookupKeys.length !== 1) {
        addException(input, exceptions, {
          type: "ambiguous_identity",
          severity: "high",
          records: [refund, ...observedEntries],
          reasonCode: "REFUND_ACCOUNTING_SPLIT_IDENTITY_AMBIGUOUS",
          ruleId: "refund-accounting-split-identity",
          result: "ambiguous",
        });
        continue;
      }
      if (strongSearch.entries.some((entry) => entry.amount.minor <= 0n)) {
        addException(input, exceptions, {
          type: "ambiguous_identity",
          severity: "high",
          records: [refund, ...strongSearch.entries],
          reasonCode: "REFUND_ACCOUNTING_SPLIT_REQUIRES_POSITIVE_ENTRIES",
          ruleId: "refund-accounting-split-sign",
          result: "ambiguous",
        });
        continue;
      }
      const total = sumAccountingEntryAmounts(strongSearch.entries, refund.amount.currency);
      if (total === undefined) {
        addException(input, exceptions, {
          type: "ambiguous_identity",
          severity: "high",
          records: [refund, ...strongSearch.entries],
          reasonCode: "REFUND_ACCOUNTING_SPLIT_TOTAL_OUT_OF_RANGE",
          ruleId: "refund-accounting-split-amount",
          result: "ambiguous",
        });
        continue;
      }
      const tolerance = toleranceFor(input.policy, refund.amount.currency);
      const difference = absoluteMinorDifference(refund.amount, total);
      if (difference > tolerance) {
        const differenceAmount = moneyIfRepresentable(difference, refund.amount.currency);
        addException(input, exceptions, {
          type: "refund_amount_mismatch",
          severity: "high",
          records: [refund, ...strongSearch.entries],
          reasonCode: "REFUND_ACCOUNTING_SPLIT_TOTAL_OUTSIDE_TOLERANCE",
          ruleId: "refund-accounting-split-amount",
          tolerance,
          ...(differenceAmount === undefined ? {} : { amount: differenceAmount }),
          sourceValues: [
            refund.amount,
            ...strongSearch.entries.map((entry) => entry.amount),
            total,
          ],
        });
        continue;
      }
      resolutionCandidates.push({
        refund,
        entries: strongSearch.entries,
        total,
        kind: "split",
      });
      continue;
    }

    const strongEntry = strongSearch.entries[0];
    if (exactEntry !== undefined) {
      if (strongEntry !== undefined && strongEntry.id !== exactEntry.id) {
        addException(input, exceptions, {
          type: "ambiguous_identity",
          severity: "high",
          records: [refund, strongEntry, exactEntry],
          reasonCode: "REFUND_ACCOUNTING_IDENTITY_AMBIGUOUS",
          ruleId: "refund-accounting-identity",
          result: "ambiguous",
        });
        continue;
      }
      resolutionCandidates.push({
        refund,
        entries: [exactEntry],
        total: exactEntry.amount,
        kind: "single",
      });
      continue;
    }

    if (strongEntry !== undefined) {
      const tolerance = toleranceFor(input.policy, refund.amount.currency);
      const difference = absoluteMinorDifference(refund.amount, strongEntry.amount);
      const differenceAmount = moneyIfRepresentable(difference, refund.amount.currency);
      addException(input, exceptions, {
        type: "refund_amount_mismatch",
        severity: "high",
        records: [refund, strongEntry],
        reasonCode: "REFUND_ACCOUNTING_ENTRY_AMOUNT_OUTSIDE_TOLERANCE",
        ruleId: "refund-accounting-amount",
        tolerance,
        ...(differenceAmount === undefined ? {} : { amount: differenceAmount }),
        sourceValues: [refund.amount, strongEntry.amount],
      });
      continue;
    }

    addMissingOrDelayedException(
      input,
      exceptions,
      "refund_missing_accounting_entry",
      refund,
      "REFUND_HAS_NO_ACCOUNTING_ENTRY",
    );
  }

  const mergedOverflowRanges = new Map<string, readonly AccountingAmountRange[]>();
  for (const [lookupKey, ranges] of overflowRangesByLookupKey) {
    mergedOverflowRanges.set(lookupKey, mergeAccountingAmountRanges(ranges));
  }

  for (const candidate of resolutionCandidates) {
    let competingRefund: RefundRecord | undefined;
    for (const entry of candidate.entries) {
      const usage = usageByAccountingEntryId.get(entry.id);
      if (!usage) throw new ReconciliationError("accounting candidate usage unexpectedly missing");
      if (usage.count > 1) {
        competingRefund = usage.first.id === candidate.refund.id ? usage.second : usage.first;
        break;
      }
    }
    if (competingRefund !== undefined) {
      addException(input, exceptions, {
        type: "ambiguous_identity",
        severity: "high",
        records: [candidate.refund, ...candidate.entries, competingRefund],
        reasonCode: "REFUND_ACCOUNTING_IDENTITY_AMBIGUOUS",
        ruleId: "refund-accounting-identity",
        result: "ambiguous",
      });
      continue;
    }
    const taintedByOverflow = candidate.entries.some((entry) =>
      accountingEntryLookupKeys(entry).some(
        (lookupKey) =>
          overflowedStrongLookupKeys.has(lookupKey) ||
          amountFallsWithinRanges(entry.amount.minor, mergedOverflowRanges.get(lookupKey) ?? []),
      ),
    );
    if (taintedByOverflow) {
      addException(input, exceptions, {
        type: "ambiguous_identity",
        severity: "high",
        records: [candidate.refund, ...candidate.entries],
        reasonCode: "REFUND_ACCOUNTING_CANDIDATE_TAINTED_BY_OVERFLOW",
        ruleId: "refund-accounting-candidate-overflow",
        result: "ambiguous",
      });
      continue;
    }
    addRefundAccountingMatch(input, candidate, matches);
  }
}

function addRefundAccountingMatch(
  input: ReconciliationInput,
  candidate: {
    readonly refund: RefundRecord;
    readonly entries: readonly AccountingEntryRecord[];
    readonly total: Money;
    readonly kind: "single" | "split";
  },
  matches: Map<string, ReconciliationMatch>,
): void {
  const records = [candidate.refund, ...candidate.entries];
  const ruleId = candidate.kind === "single" ? "refund-accounting" : "refund-accounting-split";
  const id = stableArtifactId(input.organizationId, "match", ruleId, records);
  const tolerance = toleranceFor(input.policy, candidate.refund.amount.currency);
  const sourceValues =
    candidate.kind === "single"
      ? [candidate.refund.amount, candidate.total]
      : [
          candidate.refund.amount,
          ...candidate.entries.map((entry) => entry.amount),
          candidate.total,
        ];
  matches.set(id, {
    id,
    organizationId: input.organizationId,
    ruleId,
    ruleVersion: RULE_VERSION,
    confidence: candidate.kind === "single" ? "exact" : "composite",
    recordIds: recordIdsForEvidence(records),
    evidence: evidence(input, {
      ruleId,
      records,
      result: "pass",
      reasonCode:
        candidate.kind === "single"
          ? "REFUND_ACCOUNTING_ENTRY_MATCHED"
          : "REFUND_ACCOUNTING_SPLIT_TOTAL_MATCHED",
      tolerance,
      sourceValues,
    }),
  });
}

function recordAccountingEntryUsage(
  usageByAccountingEntryId: Map<
    string,
    {
      count: number;
      first: RefundRecord;
      second?: RefundRecord;
    }
  >,
  entry: AccountingEntryRecord,
  refund: RefundRecord,
): void {
  const usage = usageByAccountingEntryId.get(entry.id);
  if (!usage) {
    usageByAccountingEntryId.set(entry.id, { count: 1, first: refund });
  } else if (usage.first.id !== refund.id && usage.second?.id !== refund.id) {
    usage.count += 1;
    usage.second ??= refund;
  }
}

function detectRecordProblems(
  input: ReconciliationInput,
  records: readonly CanonicalRecord[],
  exceptions: Map<string, ReconciliationException>,
): ReadonlySet<string> {
  const quarantinedRecordIds = new Set<string>();
  for (const record of records) {
    if (!record.externalId && !record.orderReference) {
      addException(input, exceptions, {
        type: "missing_identifier",
        severity: "medium",
        records: [record],
        reasonCode: "NO_EXTERNAL_OR_ORDER_IDENTIFIER",
        ruleId: "record-identifiers",
      });
    }
    const malformedIdentifiers = identifierValues(record)
      .map(({ fieldPath, value }) => ({
        fieldPath,
        value,
        issueCodes: identifierIssueCodes(value),
      }))
      .filter(({ issueCodes }) => issueCodes.length > 0);
    if (malformedIdentifiers.length > 0) {
      quarantinedRecordIds.add(record.id);
      addException(input, exceptions, {
        type: "malformed_identifier",
        severity: "high",
        records: [record],
        reasonCode: "IDENTIFIER_CONTAINS_UNSAFE_FORMAT",
        ruleId: "record-identifier-format",
        comparisonValues: malformedIdentifiers.map(({ fieldPath, value, issueCodes }) => ({
          source: {
            fieldPath,
            value: escapeIdentifierForEvidence(value),
            encoding: "unsafe-code-points-escaped",
          },
          normalized: {
            fieldPath,
            value: escapeIdentifierForEvidence(normalizeReference(value)),
            encoding: "unsafe-code-points-escaped",
            issueCodes: issueCodes.join(","),
          },
        })),
      });
    }
    if ((record.incompleteReasons?.length ?? 0) > 0) {
      addException(input, exceptions, {
        type: "incomplete_source_record",
        severity: "medium",
        records: [record],
        reasonCode: "NORMALIZER_MARKED_RECORD_INCOMPLETE",
        ruleId: "record-completeness",
      });
    }
  }
  return quarantinedRecordIds;
}

function detectDuplicates(
  input: ReconciliationInput,
  records: readonly CanonicalRecord[],
  exceptions: Map<string, ReconciliationException>,
): void {
  const groups = new Map<string, CanonicalRecord[]>();
  for (const record of records) {
    if (!record.externalId) continue;
    const key = [record.kind, record.provenance.sourceSystem, record.externalId].join("\0");
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const firstRecord = group[0];
    if (!firstRecord) continue;
    addException(input, exceptions, {
      type: duplicateExceptionType(firstRecord),
      severity: "high",
      records: group,
      reasonCode: "DUPLICATE_SOURCE_EXTERNAL_IDENTIFIER",
      ruleId: "duplicate-external-id",
    });
  }
}

function duplicateExceptionType(record: CanonicalRecord): ExceptionType {
  switch (record.kind) {
    case "order":
      return "duplicate_order";
    case "payment":
      return "duplicate_payment";
    case "refund":
      return "duplicate_refund";
    case "processing_fee":
      return "duplicate_processing_fee";
    case "accounting_entry":
      return "duplicate_accounting_entry";
  }
}

function exactRefundLink(left: RefundRecord, right: RefundRecord): boolean {
  if (left.refundReference && right.refundReference) {
    return normalizeReference(left.refundReference) === normalizeReference(right.refundReference);
  }
  return (
    left.orderReference !== undefined &&
    right.orderReference !== undefined &&
    normalizeReference(left.orderReference) === normalizeReference(right.orderReference) &&
    left.amount.currency === right.amount.currency &&
    left.amount.minor === right.amount.minor
  );
}

interface PaymentIndexes {
  readonly byReference: ReadonlyMap<string, readonly PaymentRecord[]>;
  readonly byCurrencyAndAmount: ReadonlyMap<Currency, readonly PaymentRecord[]>;
}

function buildPaymentIndexes(payments: readonly PaymentRecord[]): PaymentIndexes {
  const byReference = new Map<string, PaymentRecord[]>();
  const byCurrencyAndAmount = new Map<Currency, PaymentRecord[]>();
  for (const payment of payments) {
    for (const reference of [payment.providerOrderReference, payment.orderReference].filter(
      isDefined,
    )) {
      addToIndex(byReference, normalizeReference(reference), payment);
    }
    addToIndex(byCurrencyAndAmount, payment.amount.currency, payment);
  }
  for (const values of byReference.values()) values.sort(compareRecords);
  for (const values of byCurrencyAndAmount.values()) {
    values.sort(
      (left, right) =>
        compareBigInt(left.amount.minor, right.amount.minor) || compareRecords(left, right),
    );
  }
  return { byReference, byCurrencyAndAmount };
}

function findExactOrderPayments(
  order: OrderRecord,
  indexes: PaymentIndexes,
): readonly PaymentRecord[] {
  const found = new Map<string, PaymentRecord>();
  for (const reference of [order.externalId, order.orderReference].filter(isDefined)) {
    for (const payment of indexes.byReference.get(normalizeReference(reference)) ?? []) {
      found.set(payment.id, payment);
    }
  }
  return [...found.values()].sort(compareRecords);
}

interface AmountCandidateSearch {
  readonly payments: readonly PaymentRecord[];
  readonly eligibleCount: number;
  readonly complete: boolean;
}

function findAmountCandidatePayments(
  order: OrderRecord,
  policy: ReconciliationPolicy,
  indexes: PaymentIndexes,
): AmountCandidateSearch {
  const payments = indexes.byCurrencyAndAmount.get(order.amount.currency) ?? [];
  const tolerance = toleranceFor(policy, order.amount.currency);
  const minimum = order.amount.minor - tolerance;
  const maximum = order.amount.minor + tolerance;
  const start = lowerBoundPaymentAmount(payments, minimum);
  const end = upperBoundPaymentAmount(payments, maximum);
  const eligibleCount = end - start;
  if (eligibleCount > MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD) {
    return { payments: [], eligibleCount, complete: false };
  }
  return { payments: payments.slice(start, end), eligibleCount, complete: true };
}

function lowerBoundPaymentAmount(payments: readonly PaymentRecord[], target: bigint): number {
  let low = 0;
  let high = payments.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const payment = payments[middle];
    if (!payment) break;
    if (payment.amount.minor < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBoundPaymentAmount(payments: readonly PaymentRecord[], target: bigint): number {
  let low = 0;
  let high = payments.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const payment = payments[middle];
    if (!payment) break;
    if (payment.amount.minor <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

interface RefundIndexes {
  readonly byRefundReference: ReadonlyMap<string, readonly RefundRecord[]>;
  readonly byComposite: ReadonlyMap<string, readonly RefundRecord[]>;
}

function buildRefundIndexes(refunds: readonly RefundRecord[]): RefundIndexes {
  const byRefundReference = new Map<string, RefundRecord[]>();
  const byComposite = new Map<string, RefundRecord[]>();
  for (const refund of refunds) {
    if (refund.refundReference) {
      addToIndex(byRefundReference, normalizeReference(refund.refundReference), refund);
    }
    if (refund.orderReference) {
      addToIndex(byComposite, refundCompositeKey(refund), refund);
    }
  }
  return { byRefundReference, byComposite };
}

function findExactRefunds(refund: RefundRecord, indexes: RefundIndexes): readonly RefundRecord[] {
  const candidates = refund.refundReference
    ? (indexes.byRefundReference.get(normalizeReference(refund.refundReference)) ?? [])
    : refund.orderReference
      ? (indexes.byComposite.get(refundCompositeKey(refund)) ?? [])
      : [];
  return candidates.filter((candidate) => exactRefundLink(refund, candidate)).sort(compareRecords);
}

function refundCompositeKey(refund: RefundRecord): string {
  return [
    normalizeReference(refund.orderReference ?? ""),
    refund.amount.currency,
    refund.amount.minor.toString(),
  ].join("\0");
}

interface AccountingIndexes {
  readonly byTransactionReference: ReadonlyMap<string, readonly AccountingEntryRecord[]>;
  readonly byOrderReference: ReadonlyMap<string, readonly AccountingEntryRecord[]>;
}

function buildAccountingIndexes(entries: readonly AccountingEntryRecord[]): AccountingIndexes {
  const byTransactionReference = new Map<string, AccountingEntryRecord[]>();
  const byOrderReference = new Map<string, AccountingEntryRecord[]>();
  for (const entry of entries) {
    if (entry.entryType !== "refund") continue;
    if (entry.transactionReference) {
      addToIndex(
        byTransactionReference,
        accountingLookupKey("transaction", entry.transactionReference, entry.amount.currency),
        entry,
      );
    }
    if (entry.orderReference) {
      addToIndex(
        byOrderReference,
        accountingLookupKey("order", entry.orderReference, entry.amount.currency),
        entry,
      );
    }
  }
  for (const entriesForReference of [
    ...byTransactionReference.values(),
    ...byOrderReference.values(),
  ]) {
    entriesForReference.sort(
      (left, right) =>
        compareBigInt(left.amount.minor, right.amount.minor) || compareRecords(left, right),
    );
  }
  return { byTransactionReference, byOrderReference };
}

interface StrongReferenceAccountingCandidateSearch {
  readonly entries: readonly AccountingEntryRecord[];
  readonly lookupKeys: readonly string[];
  readonly complete: boolean;
  readonly eligibleCountLowerBound: number;
}

function findStrongReferenceAccountingCandidates(
  refund: RefundRecord,
  indexes: AccountingIndexes,
): StrongReferenceAccountingCandidateSearch {
  const lookupKeys = accountingStrongLookupKeys(refund);
  const matchedLookupKeys: string[] = [];
  const found = new Map<string, AccountingEntryRecord>();

  for (const lookupKey of lookupKeys) {
    const entries = indexes.byTransactionReference.get(lookupKey) ?? [];
    if (entries.length === 0) continue;
    matchedLookupKeys.push(lookupKey);
    if (entries.length > MAX_ACCOUNTING_SPLIT_ENTRIES_PER_REFUND) {
      return {
        entries: [],
        lookupKeys,
        complete: false,
        eligibleCountLowerBound: entries.length,
      };
    }
    for (const entry of entries) {
      found.set(entry.id, entry);
      if (found.size > MAX_ACCOUNTING_SPLIT_ENTRIES_PER_REFUND) {
        return {
          entries: [],
          lookupKeys,
          complete: false,
          eligibleCountLowerBound: found.size,
        };
      }
    }
  }

  return {
    entries: [...found.values()].sort(compareRecords),
    lookupKeys: matchedLookupKeys,
    complete: true,
    eligibleCountLowerBound: found.size,
  };
}

function accountingStrongLookupKeys(refund: RefundRecord): readonly string[] {
  return [
    ...new Set(
      [refund.externalId, refund.refundReference]
        .filter(isDefined)
        .map((reference) => accountingLookupKey("transaction", reference, refund.amount.currency)),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function uniqueAccountingEntries(
  entries: readonly AccountingEntryRecord[],
): readonly AccountingEntryRecord[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()].sort(compareRecords);
}

function sumAccountingEntryAmounts(
  entries: readonly AccountingEntryRecord[],
  currency: Currency,
): Money | undefined {
  const totalMinor = entries.reduce((total, entry) => total + entry.amount.minor, 0n);
  try {
    return money(totalMinor, currency);
  } catch (error) {
    if (error instanceof MoneyError) return undefined;
    throw error;
  }
}

function moneyIfRepresentable(minor: bigint, currency: Currency): Money | undefined {
  try {
    return money(minor, currency);
  } catch (error) {
    if (error instanceof MoneyError) return undefined;
    throw error;
  }
}

interface AccountingAmountRange {
  readonly lookupKey: string;
  readonly minimum: bigint;
  readonly maximum: bigint;
}

interface AccountingCandidateSearch {
  readonly candidates: readonly AccountingEntryRecord[];
  readonly lookupKeys: readonly string[];
  readonly complete: boolean;
  readonly eligibleCountLowerBound: number;
  readonly overflowRanges: readonly AccountingAmountRange[];
}

function findEligibleAccountingCandidates(
  refund: RefundRecord,
  indexes: AccountingIndexes,
  policy: ReconciliationPolicy,
): AccountingCandidateSearch {
  const lookupEntries = new Map<string, readonly AccountingEntryRecord[]>();
  for (const reference of [refund.externalId, refund.refundReference].filter(isDefined)) {
    const lookupKey = accountingLookupKey("transaction", reference, refund.amount.currency);
    lookupEntries.set(lookupKey, indexes.byTransactionReference.get(lookupKey) ?? []);
  }
  if (refund.orderReference) {
    const lookupKey = accountingLookupKey("order", refund.orderReference, refund.amount.currency);
    lookupEntries.set(lookupKey, indexes.byOrderReference.get(lookupKey) ?? []);
  }

  const tolerance = toleranceFor(policy, refund.amount.currency);
  const minimum = refund.amount.minor - tolerance;
  const maximum = refund.amount.minor + tolerance;
  const found = new Map<string, AccountingEntryRecord>();
  const overflowRanges: AccountingAmountRange[] = [];
  let eligibleCountLowerBound = 0;

  for (const [lookupKey, entries] of lookupEntries) {
    const start = lowerBoundAccountingAmount(entries, minimum);
    const end = upperBoundAccountingAmount(entries, maximum);
    const rangeCount = end - start;
    eligibleCountLowerBound = Math.max(eligibleCountLowerBound, rangeCount);
    if (rangeCount > MAX_ACCOUNTING_CANDIDATES_EVALUATED_PER_REFUND) {
      overflowRanges.push({ lookupKey, minimum, maximum });
      continue;
    }
    for (const entry of entries.slice(start, end)) {
      if (accountingReferencesMatch(entry, refund)) found.set(entry.id, entry);
    }
  }

  const lookupKeys = [...lookupEntries.keys()];
  if (overflowRanges.length > 0) {
    return {
      candidates: [],
      lookupKeys,
      complete: false,
      eligibleCountLowerBound,
      overflowRanges: lookupKeys.map((lookupKey) => ({ lookupKey, minimum, maximum })),
    };
  }
  if (found.size > MAX_ACCOUNTING_CANDIDATES_EVALUATED_PER_REFUND) {
    return {
      candidates: [],
      lookupKeys,
      complete: false,
      eligibleCountLowerBound: found.size,
      overflowRanges: lookupKeys.map((lookupKey) => ({ lookupKey, minimum, maximum })),
    };
  }
  return {
    candidates: [...found.values()].sort(compareRecords),
    lookupKeys,
    complete: true,
    eligibleCountLowerBound: found.size,
    overflowRanges: [],
  };
}

function accountingLookupKey(
  kind: "transaction" | "order",
  reference: string,
  currency: Currency,
): string {
  return [kind, normalizeReference(reference), currency].join("\0");
}

function accountingEntryLookupKeys(entry: AccountingEntryRecord): readonly string[] {
  const keys: string[] = [];
  if (entry.transactionReference) {
    keys.push(
      accountingLookupKey("transaction", entry.transactionReference, entry.amount.currency),
    );
  }
  if (entry.orderReference) {
    keys.push(accountingLookupKey("order", entry.orderReference, entry.amount.currency));
  }
  return keys;
}

function lowerBoundAccountingAmount(
  entries: readonly AccountingEntryRecord[],
  target: bigint,
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const entry = entries[middle];
    if (!entry) break;
    if (entry.amount.minor < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBoundAccountingAmount(
  entries: readonly AccountingEntryRecord[],
  target: bigint,
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const entry = entries[middle];
    if (!entry) break;
    if (entry.amount.minor <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function mergeAccountingAmountRanges(
  ranges: readonly AccountingAmountRange[],
): readonly AccountingAmountRange[] {
  const sorted = [...ranges].sort(
    (left, right) =>
      compareBigInt(left.minimum, right.minimum) || compareBigInt(left.maximum, right.maximum),
  );
  const merged: AccountingAmountRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.minimum <= previous.maximum) {
      merged[merged.length - 1] = {
        lookupKey: previous.lookupKey,
        minimum: previous.minimum,
        maximum: range.maximum > previous.maximum ? range.maximum : previous.maximum,
      };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function amountFallsWithinRanges(
  amount: bigint,
  ranges: readonly AccountingAmountRange[],
): boolean {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const range = ranges[middle];
    if (!range) break;
    if (amount < range.minimum) high = middle;
    else if (amount > range.maximum) low = middle + 1;
    else return true;
  }
  return false;
}

function accountingReferencesMatch(entry: AccountingEntryRecord, refund: RefundRecord): boolean {
  return (
    referencesEqual(entry.transactionReference, refund.externalId) ||
    referencesEqual(entry.transactionReference, refund.refundReference) ||
    referencesEqual(entry.orderReference, refund.orderReference)
  );
}

function referencesEqual(left: string | undefined, right: string | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    normalizeReference(left) === normalizeReference(right)
  );
}

function groupRefundsByOrder(
  refunds: readonly RefundRecord[],
): ReadonlyMap<string, readonly RefundRecord[]> {
  const groups = new Map<string, RefundRecord[]>();
  for (const refund of refunds) {
    if (refund.orderReference) {
      addToIndex(groups, normalizeReference(refund.orderReference), refund);
    }
  }
  return groups;
}

function scoreOrderPaymentCandidate(
  order: OrderRecord,
  payment: PaymentRecord,
  policy: ReconciliationPolicy,
): AmbiguousCandidate | undefined {
  if (order.amount.currency !== payment.amount.currency) return undefined;
  const reasons: string[] = [];
  let score = 0;
  if (
    absoluteMinorDifference(order.amount, payment.amount) <=
    toleranceFor(policy, order.amount.currency)
  ) {
    score += 60;
    reasons.push("amount_and_currency");
  }
  if (
    order.customerReference &&
    payment.customerReference &&
    normalizeReference(order.customerReference) === normalizeReference(payment.customerReference)
  ) {
    score += 20;
    reasons.push("customer_reference");
  }
  const seconds = Math.abs(
    (new Date(order.effectiveAt).getTime() - new Date(payment.effectiveAt).getTime()) / 1000,
  );
  if (seconds <= policy.dateWindowSeconds) {
    score += 20;
    reasons.push("date_window");
  }
  if (score < 60) return undefined;
  const candidateRecords = [order, payment];
  const recordIds = recordIdsForEvidence(candidateRecords);
  return {
    id: stableArtifactId(order.organizationId, "candidate", "order-payment", candidateRecords),
    organizationId: order.organizationId,
    recordIds,
    deterministicScore: score,
    reasons,
  };
}

function addMissingOrDelayedException(
  input: ReconciliationInput,
  target: Map<string, ReconciliationException>,
  type: ExceptionType,
  record: CanonicalRecord,
  reasonCode: string,
  forcedResult?: "ambiguous",
  candidateSearch?: CandidateSearchEvidence,
): void {
  const elapsedSeconds =
    (new Date(input.policy.evaluatedAt).getTime() - new Date(record.effectiveAt).getTime()) / 1000;
  const delayed = elapsedSeconds >= 0 && elapsedSeconds < input.policy.delayedEventGraceSeconds;
  addException(input, target, {
    type: delayed ? "delayed_source_record" : type,
    severity: delayed ? "low" : "high",
    records: [record],
    reasonCode: delayed ? "SOURCE_RECORD_WITHIN_GRACE_WINDOW" : reasonCode,
    ruleId: delayed ? "delayed-source-grace" : type,
    result: forcedResult ?? (delayed ? "defer" : "fail"),
    ...(candidateSearch === undefined ? {} : { candidateSearch }),
  });
}

interface AddExceptionOptions {
  readonly type: ExceptionType;
  readonly severity: ReconciliationException["severity"];
  readonly records: readonly CanonicalRecord[];
  readonly reasonCode: string;
  readonly ruleId: string;
  readonly result?: RuleResult;
  readonly tolerance?: bigint;
  readonly amount?: Money;
  readonly sourceValues?: readonly Money[];
  readonly comparisonValues?: readonly EvidenceComparisonValue[];
  readonly candidateSearch?: CandidateSearchEvidence;
  readonly accountingCandidateSearch?: AccountingCandidateSearchEvidence;
}

function addException(
  input: ReconciliationInput,
  target: Map<string, ReconciliationException>,
  options: AddExceptionOptions,
): void {
  const recordIds = recordIdsForEvidence(options.records);
  const id = stableArtifactId(input.organizationId, "exception", options.type, options.records);
  target.set(id, {
    id,
    organizationId: input.organizationId,
    type: options.type,
    status: options.result === "defer" ? "deferred" : "open",
    severity: options.severity,
    recordIds,
    ...(options.amount ? { amount: options.amount } : {}),
    evidence: evidence(input, {
      ruleId: options.ruleId,
      records: options.records,
      result: options.result ?? "fail",
      reasonCode: options.reasonCode,
      ...(options.tolerance === undefined ? {} : { tolerance: options.tolerance }),
      ...(options.sourceValues === undefined ? {} : { sourceValues: options.sourceValues }),
      ...(options.comparisonValues === undefined
        ? {}
        : { comparisonValues: options.comparisonValues }),
      ...(options.candidateSearch === undefined
        ? {}
        : { candidateSearch: options.candidateSearch }),
      ...(options.accountingCandidateSearch === undefined
        ? {}
        : { accountingCandidateSearch: options.accountingCandidateSearch }),
    }),
  });
}

interface EvidenceOptions {
  readonly ruleId: string;
  readonly records: readonly CanonicalRecord[];
  readonly result: RuleResult;
  readonly reasonCode: string;
  readonly tolerance?: bigint;
  readonly sourceValues?: readonly Money[];
  readonly comparisonValues?: readonly EvidenceComparisonValue[];
  readonly candidateSearch?: CandidateSearchEvidence;
  readonly accountingCandidateSearch?: AccountingCandidateSearchEvidence;
}

function evidence(input: ReconciliationInput, options: EvidenceOptions): RuleEvidence {
  const rawMoneyValues = options.sourceValues ?? options.records.map((record) => record.amount);
  const rawComparisonValues =
    options.comparisonValues ??
    rawMoneyValues.map((value) => {
      const serialized = serializeMoney(value);
      return {
        source: {
          minor: value.minor.toString(),
          currency: value.currency,
        },
        normalized: {
          minor: serialized.minor,
          currency: serialized.currency,
        },
      };
    });
  const comparisonValues = rawComparisonValues.slice(0, MAX_ARTIFACT_EVIDENCE_RECORDS);
  const sourceRecordVersions = options.records
    .map(recordSnapshotEvidence)
    .sort(compareSnapshotEvidence)
    .slice(0, MAX_ARTIFACT_EVIDENCE_RECORDS);
  return RuleEvidenceSchema.parse({
    ruleId: options.ruleId,
    ruleVersion: RULE_VERSION,
    ruleSetVersion: RULE_SET_VERSION,
    sourceRecordIds: sourceRecordVersions.map((record) => record.id),
    sourceRecordCount: options.records.length,
    evidenceTruncated:
      options.records.length > MAX_ARTIFACT_EVIDENCE_RECORDS ||
      rawComparisonValues.length > MAX_ARTIFACT_EVIDENCE_RECORDS,
    sourceRecordVersions,
    sourceValues: comparisonValues.map((value) => value.source),
    normalizedValues: comparisonValues.map((value) => value.normalized),
    ...(options.tolerance === undefined ? {} : { toleranceMinor: options.tolerance.toString() }),
    ...(options.candidateSearch === undefined ? {} : { candidateSearch: options.candidateSearch }),
    ...(options.accountingCandidateSearch === undefined
      ? {}
      : { accountingCandidateSearch: options.accountingCandidateSearch }),
    result: options.result,
    reasonCode: options.reasonCode,
    evaluatedAt: input.policy.evaluatedAt,
  }) as RuleEvidence;
}

function toleranceFor(policy: ReconciliationPolicy, currency: Currency): bigint {
  const tolerance = policy.amountToleranceMinor[currency] ?? 0n;
  if (tolerance < 0n) throw new ReconciliationError("amount tolerance cannot be negative");
  return tolerance;
}

function stableArtifactId(
  organizationId: OrganizationId,
  kind: string,
  rule: string,
  records: readonly CanonicalRecord[],
): string {
  return stableHash([
    organizationId,
    kind,
    rule,
    records.map(recordSnapshotIdentity).sort(compareSnapshotIdentity),
    RULE_SET_VERSION,
  ]);
}

function recordIdsForEvidence(records: readonly CanonicalRecord[]): readonly string[] {
  return records
    .map(recordSnapshotIdentity)
    .sort(compareSnapshotIdentity)
    .slice(0, MAX_ARTIFACT_EVIDENCE_RECORDS)
    .map(([id]) => id);
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

type SnapshotIdentity = readonly [id: string, version: number, contentSha256: string];

function recordSnapshotIdentity(record: CanonicalRecord): SnapshotIdentity {
  return [record.id, record.version, stableHash(serializeCanonicalRecord(record))];
}

function recordSnapshotEvidence(
  record: CanonicalRecord,
): RuleEvidence["sourceRecordVersions"][number] {
  const [id, version, contentSha256] = recordSnapshotIdentity(record);
  return { id, version, contentSha256 };
}

function compareSnapshotIdentity(left: SnapshotIdentity, right: SnapshotIdentity): number {
  return left[0].localeCompare(right[0]) || left[1] - right[1] || left[2].localeCompare(right[2]);
}

function compareSnapshotEvidence(
  left: RuleEvidence["sourceRecordVersions"][number],
  right: RuleEvidence["sourceRecordVersions"][number],
): number {
  return (
    left.id.localeCompare(right.id) ||
    left.version - right.version ||
    left.contentSha256.localeCompare(right.contentSha256)
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

interface IdentifierValue {
  readonly fieldPath: string;
  readonly value: string;
}

const forbiddenIdentifierLineSeparator = /[\u2028\u2029]/u;
const forbiddenIdentifierBidiControl = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const forbiddenIdentifierInvisibleFormat = /[\u00ad\u200b\u2060\ufeff]/u;

function identifierValues(record: CanonicalRecord): readonly IdentifierValue[] {
  const values: IdentifierValue[] = [
    { fieldPath: "provenance.externalObjectId", value: record.provenance.externalObjectId },
  ];
  for (const [fieldPath, value] of [
    ["externalId", record.externalId],
    ["orderReference", record.orderReference],
    ["customerReference", record.customerReference],
  ] as const) {
    if (value !== undefined) values.push({ fieldPath, value });
  }
  switch (record.kind) {
    case "order":
      break;
    case "payment":
      if (record.providerOrderReference !== undefined) {
        values.push({
          fieldPath: "providerOrderReference",
          value: record.providerOrderReference,
        });
      }
      break;
    case "refund":
      if (record.paymentReference !== undefined) {
        values.push({ fieldPath: "paymentReference", value: record.paymentReference });
      }
      if (record.refundReference !== undefined) {
        values.push({ fieldPath: "refundReference", value: record.refundReference });
      }
      break;
    case "processing_fee":
      values.push({ fieldPath: "paymentReference", value: record.paymentReference });
      break;
    case "accounting_entry":
      if (record.transactionReference !== undefined) {
        values.push({
          fieldPath: "transactionReference",
          value: record.transactionReference,
        });
      }
      break;
  }
  return values;
}

function identifierIssueCodes(value: string): readonly string[] {
  const issueCodes: string[] = [];
  if (value !== value.trim()) issueCodes.push("SURROUNDING_WHITESPACE");
  if (containsForbiddenIdentifierControl(value)) {
    issueCodes.push("FORBIDDEN_CONTROL_CHARACTER");
  }
  if (forbiddenIdentifierLineSeparator.test(value)) {
    issueCodes.push("FORBIDDEN_LINE_SEPARATOR");
  }
  if (forbiddenIdentifierBidiControl.test(value)) {
    issueCodes.push("BIDI_CONTROL_CHARACTER");
  }
  if (forbiddenIdentifierInvisibleFormat.test(value)) {
    issueCodes.push("INVISIBLE_FORMAT_CHARACTER");
  }
  if (value.includes("\uFFFD")) issueCodes.push("REPLACEMENT_CHARACTER");
  if (containsUnpairedSurrogate(value)) issueCodes.push("UNPAIRED_SURROGATE");
  return issueCodes;
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function containsForbiddenIdentifierControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)) return true;
  }
  return false;
}

function escapeIdentifierForEvidence(value: string): string {
  const leadingBoundary = value.length - value.trimStart().length;
  const trailingBoundary = value.trimEnd().length;
  let escaped = "";
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    const next = value.charCodeAt(index + 1);
    if (current >= 0xd800 && current <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      escaped += value.slice(index, index + 2);
      index += 1;
      continue;
    }
    const character = value[index] ?? "";
    const unsafe =
      index < leadingBoundary ||
      index >= trailingBoundary ||
      current <= 0x1f ||
      (current >= 0x7f && current <= 0x9f) ||
      forbiddenIdentifierLineSeparator.test(character) ||
      forbiddenIdentifierBidiControl.test(character) ||
      forbiddenIdentifierInvisibleFormat.test(character) ||
      character === "\uFFFD" ||
      (current >= 0xd800 && current <= 0xdfff);
    if (unsafe) {
      escaped += `\\u${current.toString(16).toUpperCase().padStart(4, "0")}`;
    } else if (character === "\\") {
      escaped += "\\\\";
    } else {
      escaped += character;
    }
  }
  return escaped;
}

function normalizeReference(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function compareRecords(left: CanonicalRecord, right: CanonicalRecord): number {
  return left.id.localeCompare(right.id) || left.version - right.version;
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addToIndex<Key, Value>(target: Map<Key, Value[]>, key: Key, value: Value): void {
  const values = target.get(key) ?? [];
  values.push(value);
  target.set(key, values);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function validateInput(input: ReconciliationInput): void {
  if (input.records.length > MAX_RECONCILIATION_RECORDS) {
    throw new ReconciliationError(
      `input snapshot exceeds the ${MAX_RECONCILIATION_RECORDS.toString()} record limit`,
    );
  }
  if (!Number.isInteger(input.policy.dateWindowSeconds) || input.policy.dateWindowSeconds < 0) {
    throw new ReconciliationError("date window must be a non-negative integer");
  }
  if (
    !Number.isInteger(input.policy.delayedEventGraceSeconds) ||
    input.policy.delayedEventGraceSeconds < 0
  ) {
    throw new ReconciliationError("grace window must be a non-negative integer");
  }
  if (Number.isNaN(new Date(input.policy.evaluatedAt).getTime())) {
    throw new ReconciliationError("evaluatedAt must be an ISO instant");
  }
  if (input.policy.version.trim().length < 1 || input.policy.version.length > 50) {
    throw new ReconciliationError("policy version must contain between 1 and 50 characters");
  }
  if (input.policy.businessTimeZone.length < 1 || input.policy.businessTimeZone.length > 100) {
    throw new ReconciliationError("business time zone is invalid");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.policy.businessTimeZone }).format(new Date(0));
  } catch {
    throw new ReconciliationError("business time zone is invalid");
  }
  for (const tolerance of Object.values(input.policy.amountToleranceMinor)) {
    if (tolerance !== undefined && tolerance < 0n) {
      throw new ReconciliationError("amount tolerance cannot be negative");
    }
  }
  const recordIds = new Set<string>();
  for (const record of input.records) {
    if (record.organizationId !== input.organizationId) {
      throw new ReconciliationError("cross-tenant record found in input snapshot");
    }
    if (recordIds.has(record.id)) {
      throw new ReconciliationError("input snapshot contains multiple versions of one record");
    }
    recordIds.add(record.id);
  }
}
