import {
  CanonicalRecordIdSchema,
  MembershipIdSchema,
  OrganizationIdSchema,
  SourceEventIdSchema,
  UserIdSchema,
  asCurrency,
  money,
  type AccountingEntryRecord,
  type CanonicalRecord,
  type OrderRecord,
  type PaymentRecord,
  type ProcessingFeeRecord,
  type RefundRecord,
} from "@workspace/domain";

export const syntheticIds = {
  organization: OrganizationIdSchema.parse("00000000-0000-4000-8000-000000000001"),
  otherOrganization: OrganizationIdSchema.parse("00000000-0000-4000-8000-000000000002"),
  user: UserIdSchema.parse("00000000-0000-4000-8000-000000000010"),
  otherUser: UserIdSchema.parse("00000000-0000-4000-8000-000000000011"),
  membership: MembershipIdSchema.parse("00000000-0000-4000-8000-000000000020"),
  otherMembership: MembershipIdSchema.parse("00000000-0000-4000-8000-000000000021"),
} as const;

export const defaultPolicy = {
  version: "policy-1",
  evaluatedAt: "2026-07-27T12:00:00.000Z",
  amountToleranceMinor: {},
  dateWindowSeconds: 86_400,
  delayedEventGraceSeconds: 3_600,
  businessTimeZone: "UTC",
};

const baseProvenance = {
  sourceTimestamp: "2026-07-26T10:00:00.000Z",
  ingestionTimestamp: "2026-07-26T10:01:00.000Z",
  connectorVersion: "test-1",
  normalizerVersion: "test-1",
} as const;

export function syntheticOrder(overrides: Partial<OrderRecord> = {}, sequence = 100): OrderRecord {
  return {
    id: recordId(sequence),
    organizationId: syntheticIds.organization,
    version: 1,
    kind: "order",
    externalId: `shopify-order-${sequence.toString()}`,
    orderReference: `#R${sequence.toString()}`,
    customerReference: `customer-${sequence.toString()}`,
    effectiveAt: "2026-07-26T10:00:00.000Z",
    amount: money(12_500n, asCurrency("USD")),
    financialStatus: "paid",
    provenance: {
      ...baseProvenance,
      sourceSystem: "shopify",
      externalObjectType: "order",
      externalObjectId: `shopify-order-${sequence.toString()}`,
      sourceEventId: eventId(sequence),
    },
    ...overrides,
  };
}

export function syntheticPayment(
  overrides: Partial<PaymentRecord> = {},
  sequence = 200,
): PaymentRecord {
  return {
    id: recordId(sequence),
    organizationId: syntheticIds.organization,
    version: 1,
    kind: "payment",
    externalId: `pi_${sequence.toString()}`,
    orderReference: "shopify-order-100",
    providerOrderReference: "shopify-order-100",
    customerReference: "customer-100",
    effectiveAt: "2026-07-26T10:02:00.000Z",
    amount: money(12_500n, asCurrency("USD")),
    paymentStatus: "succeeded",
    provenance: {
      ...baseProvenance,
      sourceSystem: "stripe",
      externalObjectType: "payment_intent",
      externalObjectId: `pi_${sequence.toString()}`,
      sourceEventId: eventId(sequence),
    },
    ...overrides,
  };
}

export function syntheticFee(
  overrides: Partial<ProcessingFeeRecord> = {},
  sequence = 300,
): ProcessingFeeRecord {
  return {
    id: recordId(sequence),
    organizationId: syntheticIds.organization,
    version: 1,
    kind: "processing_fee",
    externalId: `txn_${sequence.toString()}`,
    paymentReference: "pi_200",
    effectiveAt: "2026-07-26T10:03:00.000Z",
    amount: money(393n, asCurrency("USD")),
    provenance: {
      ...baseProvenance,
      sourceSystem: "stripe",
      externalObjectType: "balance_transaction",
      externalObjectId: `txn_${sequence.toString()}`,
      sourceEventId: eventId(sequence),
    },
    ...overrides,
  };
}

export function syntheticRefund(
  source: "shopify" | "stripe",
  overrides: Partial<RefundRecord> = {},
  sequence = source === "shopify" ? 400 : 401,
): RefundRecord {
  return {
    id: recordId(sequence),
    organizationId: syntheticIds.organization,
    version: 1,
    kind: "refund",
    externalId: `${source}-refund-${sequence.toString()}`,
    orderReference: "shopify-order-100",
    paymentReference: "pi_200",
    refundReference: "shopify-refund-1",
    effectiveAt: "2026-07-26T11:00:00.000Z",
    amount: money(2_500n, asCurrency("USD")),
    refundStatus: "succeeded",
    provenance: {
      ...baseProvenance,
      sourceSystem: source,
      externalObjectType: "refund",
      externalObjectId: `${source}-refund-${sequence.toString()}`,
      sourceEventId: eventId(sequence),
    },
    ...overrides,
  };
}

export function syntheticAccountingRefund(
  overrides: Partial<AccountingEntryRecord> = {},
  sequence = 500,
): AccountingEntryRecord {
  return {
    id: recordId(sequence),
    organizationId: syntheticIds.organization,
    version: 1,
    kind: "accounting_entry",
    externalId: `accounting-${sequence.toString()}`,
    transactionReference: "shopify-refund-400",
    orderReference: "shopify-order-100",
    effectiveAt: "2026-07-26T11:05:00.000Z",
    amount: money(2_500n, asCurrency("USD")),
    entryType: "refund",
    provenance: {
      ...baseProvenance,
      sourceSystem: "accounting_csv",
      externalObjectType: "csv_row",
      externalObjectId: `accounting-${sequence.toString()}`,
      sourceEventId: eventId(sequence),
    },
    ...overrides,
  };
}

export function completeSyntheticRecords(): readonly CanonicalRecord[] {
  return [
    syntheticOrder(),
    syntheticPayment(),
    syntheticFee(),
    syntheticRefund("shopify"),
    syntheticRefund("stripe"),
    syntheticAccountingRefund(),
  ];
}

/**
 * Development data for the operator journey. The second fee is a distinct source object whose
 * normalized provider identifier duplicates the first fee. The two positive accounting entries
 * conserve the Shopify refund total under one strong transaction reference, so one live run
 * exercises immutable single-record matches, a conserved split match, and exception evidence
 * without changing the general-purpose complete fixture.
 */
export function operatorEvidenceSyntheticRecords(): readonly CanonicalRecord[] {
  const { customerReference: omittedShopifyCustomerReference, ...privacySafeOrder } =
    syntheticOrder();
  void omittedShopifyCustomerReference;
  return [
    privacySafeOrder,
    syntheticPayment(),
    syntheticFee(),
    syntheticRefund("shopify"),
    syntheticRefund("stripe"),
    syntheticAccountingRefund({ amount: money(1_000n, asCurrency("USD")) }, 500),
    syntheticAccountingRefund({ amount: money(1_500n, asCurrency("USD")) }, 501),
    syntheticFee({ externalId: "txn_300" }, 301),
  ];
}

function recordId(sequence: number) {
  return CanonicalRecordIdSchema.parse(
    `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
  );
}

function eventId(sequence: number) {
  return SourceEventIdSchema.parse(
    `10000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
  );
}
