import { z } from "zod";

import type { Money, MoneyJson } from "./money.js";
import { CurrencySchema, parseMoneyJson, serializeMoney } from "./money.js";
import type { OrganizationId } from "./tenancy.js";
import { OrganizationIdSchema } from "./tenancy.js";

export const CanonicalRecordIdSchema = z.uuid().brand<"CanonicalRecordId">();
export const SourceEventIdSchema = z.uuid().brand<"SourceEventId">();

export type CanonicalRecordId = z.infer<typeof CanonicalRecordIdSchema>;
export type SourceEventId = z.infer<typeof SourceEventIdSchema>;
export type SourceSystem = "shopify" | "stripe" | "accounting_csv";
export type CanonicalRecordKind =
  "order" | "payment" | "refund" | "processing_fee" | "accounting_entry";

export interface Provenance {
  readonly sourceSystem: SourceSystem;
  readonly externalObjectType: string;
  readonly externalObjectId: string;
  readonly sourceTimestamp: string;
  readonly ingestionTimestamp: string;
  readonly sourceEventId: SourceEventId;
  readonly connectorVersion: string;
  readonly normalizerVersion: string;
}

interface BaseCanonicalRecord {
  readonly id: CanonicalRecordId;
  readonly organizationId: OrganizationId;
  readonly version: number;
  readonly kind: CanonicalRecordKind;
  readonly externalId?: string;
  readonly orderReference?: string;
  readonly customerReference?: string;
  readonly effectiveAt: string;
  readonly provenance: Provenance;
  readonly incompleteReasons?: readonly string[];
}

export interface OrderRecord extends BaseCanonicalRecord {
  readonly kind: "order";
  readonly amount: Money;
  readonly financialStatus: "paid" | "partially_refunded" | "refunded" | "pending" | "voided";
}

export interface PaymentRecord extends BaseCanonicalRecord {
  readonly kind: "payment";
  readonly amount: Money;
  readonly paymentStatus: "succeeded" | "pending" | "failed" | "reversed";
  readonly providerOrderReference?: string;
}

export interface RefundRecord extends BaseCanonicalRecord {
  readonly kind: "refund";
  readonly amount: Money;
  readonly refundStatus: "succeeded" | "pending" | "failed" | "reversed";
  readonly paymentReference?: string;
  readonly refundReference?: string;
}

export interface ProcessingFeeRecord extends BaseCanonicalRecord {
  readonly kind: "processing_fee";
  readonly amount: Money;
  readonly paymentReference: string;
}

export interface AccountingEntryRecord extends BaseCanonicalRecord {
  readonly kind: "accounting_entry";
  readonly amount: Money;
  readonly entryType: "payment" | "refund" | "processing_fee" | "other";
  readonly transactionReference?: string;
}

export type CanonicalRecord =
  OrderRecord | PaymentRecord | RefundRecord | ProcessingFeeRecord | AccountingEntryRecord;

export interface CanonicalRecordJson extends Omit<
  BaseCanonicalRecord,
  "kind" | "organizationId" | "id" | "provenance"
> {
  readonly id: string;
  readonly organizationId: string;
  readonly kind: CanonicalRecordKind;
  readonly amount: MoneyJson;
  readonly provenance: Omit<Provenance, "sourceEventId"> & { readonly sourceEventId: string };
  readonly financialStatus?: OrderRecord["financialStatus"];
  readonly paymentStatus?: PaymentRecord["paymentStatus"];
  readonly refundStatus?: RefundRecord["refundStatus"];
  readonly providerOrderReference?: string;
  readonly paymentReference?: string;
  readonly refundReference?: string;
  readonly entryType?: AccountingEntryRecord["entryType"];
  readonly transactionReference?: string;
}

export interface CanonicalFieldProvenance {
  readonly fieldPath: string;
  readonly sourceEventId: SourceEventId;
  readonly sourceValueReference: string;
  readonly normalizedValue: string;
  readonly transformationRule: string;
  readonly transformationVersion: string;
  readonly warnings: readonly string[];
}

const instantSchema = z.iso.datetime({ offset: true });
const moneyJsonSchema = z.object({
  minor: z.string().regex(/^-?(?:0|[1-9]\d*)$/u),
  currency: CurrencySchema,
});
const provenanceSchema = z.object({
  sourceSystem: z.enum(["shopify", "stripe", "accounting_csv"]),
  externalObjectType: z.string().min(1).max(100),
  externalObjectId: z.string().min(1).max(255),
  sourceTimestamp: instantSchema,
  ingestionTimestamp: instantSchema,
  sourceEventId: SourceEventIdSchema,
  connectorVersion: z.string().min(1).max(50),
  normalizerVersion: z.string().min(1).max(50),
});
const baseRecordSchema = z.object({
  id: CanonicalRecordIdSchema,
  organizationId: OrganizationIdSchema,
  version: z.int().positive(),
  externalId: z.string().min(1).max(255).optional(),
  orderReference: z.string().min(1).max(255).optional(),
  customerReference: z.string().min(1).max(255).optional(),
  effectiveAt: instantSchema,
  provenance: provenanceSchema,
  incompleteReasons: z.array(z.string().min(1).max(200)).max(20).optional(),
});

export const CanonicalRecordSchema = z.discriminatedUnion("kind", [
  baseRecordSchema.extend({
    kind: z.literal("order"),
    amount: moneyJsonSchema.transform(parseMoneyJson),
    financialStatus: z.enum(["paid", "partially_refunded", "refunded", "pending", "voided"]),
  }),
  baseRecordSchema.extend({
    kind: z.literal("payment"),
    amount: moneyJsonSchema.transform(parseMoneyJson),
    paymentStatus: z.enum(["succeeded", "pending", "failed", "reversed"]),
    providerOrderReference: z.string().min(1).max(255).optional(),
  }),
  baseRecordSchema.extend({
    kind: z.literal("refund"),
    amount: moneyJsonSchema.transform(parseMoneyJson),
    refundStatus: z.enum(["succeeded", "pending", "failed", "reversed"]),
    paymentReference: z.string().min(1).max(255).optional(),
    refundReference: z.string().min(1).max(255).optional(),
  }),
  baseRecordSchema.extend({
    kind: z.literal("processing_fee"),
    amount: moneyJsonSchema.transform(parseMoneyJson),
    paymentReference: z.string().min(1).max(255),
  }),
  baseRecordSchema.extend({
    kind: z.literal("accounting_entry"),
    amount: moneyJsonSchema.transform(parseMoneyJson),
    entryType: z.enum(["payment", "refund", "processing_fee", "other"]),
    transactionReference: z.string().min(1).max(255).optional(),
  }),
]);

export function serializeCanonicalRecord(record: CanonicalRecord): CanonicalRecordJson {
  return {
    ...record,
    id: record.id,
    organizationId: record.organizationId,
    amount: serializeMoney(record.amount),
    provenance: { ...record.provenance, sourceEventId: record.provenance.sourceEventId },
  };
}

export function canonicalFieldProvenance(
  record: CanonicalRecord,
): readonly CanonicalFieldProvenance[] {
  const values: [fieldPath: string, normalizedValue: string | undefined][] = [
    ["externalId", record.externalId],
    ["orderReference", record.orderReference],
    ["customerReference", record.customerReference],
    ["effectiveAt", record.effectiveAt],
    ["amount.minor", record.amount.minor.toString()],
    ["amount.currency", record.amount.currency],
    ...kindSpecificProvenance(record),
  ];
  return values
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([fieldPath, normalizedValue]) => ({
      fieldPath,
      sourceEventId: record.provenance.sourceEventId,
      sourceValueReference: `source-event:${record.provenance.sourceEventId}#${fieldPath}`,
      normalizedValue,
      transformationRule: `${record.provenance.sourceSystem}.${fieldPath}`,
      transformationVersion: record.provenance.normalizerVersion,
      warnings: record.incompleteReasons ?? [],
    }));
}

function kindSpecificProvenance(
  record: CanonicalRecord,
): readonly [fieldPath: string, normalizedValue: string | undefined][] {
  switch (record.kind) {
    case "order":
      return [["financialStatus", record.financialStatus]];
    case "payment":
      return [
        ["paymentStatus", record.paymentStatus],
        ["providerOrderReference", record.providerOrderReference],
      ];
    case "refund":
      return [
        ["refundStatus", record.refundStatus],
        ["paymentReference", record.paymentReference],
        ["refundReference", record.refundReference],
      ];
    case "processing_fee":
      return [["paymentReference", record.paymentReference]];
    case "accounting_entry":
      return [
        ["entryType", record.entryType],
        ["transactionReference", record.transactionReference],
      ];
  }
}
