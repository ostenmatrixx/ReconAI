import { randomUUID } from "node:crypto";

import { SourceObjectFamilySchema, type SourceObjectFamily } from "@workspace/connectors";
import { OrganizationIdSchema, type OrganizationId } from "@workspace/domain";
import type { Sql } from "postgres";
import { z } from "zod";

import { computeAuditEventHashV2 } from "./audit.js";

const repairSourceSchema = z.enum(["shopify", "stripe", "accounting_csv"]);
const objectFamiliesSchema = z
  .array(SourceObjectFamilySchema)
  .min(1)
  .max(2)
  .refine((families) => new Set(families).size === families.length, {
    message: "classification repair families must be unique",
  });
const objectKeySchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[a-z0-9][a-z0-9._/-]{0,1023}$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const requestedBySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9@._:/-]{2,99}$/u);
const reasonSchema = z
  .string()
  .min(20)
  .max(500)
  .refine((value) => !containsControlCharacter(value), {
    message: "classification repair reason contains a control character",
  });

export interface SourceEventClassificationRepairCandidate {
  readonly organizationId: OrganizationId;
  readonly sourceEventId: string;
  readonly connectionId: string;
  readonly source: "shopify" | "stripe" | "accounting_csv";
  readonly eventType: string;
  readonly objectKey: string;
  readonly payloadSha256: string;
}

export interface SourceEventClassificationRepairGapCounts {
  readonly total: number;
  readonly repairable: number;
}

export type SourceEventClassificationRepairProcessResult =
  | { readonly kind: "none" }
  | { readonly kind: "classified" }
  | { readonly kind: "already_classified" };

export interface SourceEventClassificationRepairRepository {
  processNext(
    input: {
      readonly repairRunId: string;
      readonly requestedBy: string;
      readonly reason: string;
      readonly repairedAt: string;
    },
    classify: (
      candidate: SourceEventClassificationRepairCandidate,
    ) => Promise<readonly SourceObjectFamily[]>,
  ): Promise<SourceEventClassificationRepairProcessResult>;
  countGaps(): Promise<SourceEventClassificationRepairGapCounts>;
}

export class PostgresSourceEventClassificationRepairRepository implements SourceEventClassificationRepairRepository {
  public constructor(private readonly sql: Sql) {}

  public async processNext(
    inputValue: {
      readonly repairRunId: string;
      readonly requestedBy: string;
      readonly reason: string;
      readonly repairedAt: string;
    },
    classify: (
      candidate: SourceEventClassificationRepairCandidate,
    ) => Promise<readonly SourceObjectFamily[]>,
  ): Promise<SourceEventClassificationRepairProcessResult> {
    const input = z
      .object({
        repairRunId: z.uuid(),
        requestedBy: requestedBySchema,
        reason: reasonSchema,
        repairedAt: z.iso.datetime({ offset: true }),
      })
      .strict()
      .parse(inputValue);
    return this.sql.begin(async (transaction) => {
      const claimed = await transaction`
        select *
        from reconai_claim_source_event_classification_repair_candidate()
      `;
      if (!claimed[0]) return { kind: "none" };
      const candidate = mapCandidate(claimed[0]);
      const objectFamilies = parseRepairFamilies(
        candidate.source,
        candidate.eventType,
        await classify(candidate),
      );

      await transaction`
        select set_config('app.organization_id', ${candidate.organizationId}, true)
      `;
      const auditId = randomUUID();
      const newValue = {
        source: candidate.source,
        eventType: candidate.eventType,
        objectFamilies: [...objectFamilies],
      };
      const versionContext = {
        repairVersion: "source-object-family-repair-v1",
        classifierVersion: "source-object-family-v1",
      };
      const preparedAudit = await transaction`
        select reconai_prepare_source_event_classification_repair_audit(
          ${candidate.organizationId}::uuid,
          ${candidate.sourceEventId}::uuid,
          ${candidate.connectionId}::uuid,
          ${candidate.source},
          ${candidate.eventType},
          ${candidate.objectKey},
          ${candidate.payloadSha256}
        ) as previous_event_hash
      `;
      const previousEventHash = optionalAuditHash(preparedAudit[0]?.["previous_event_hash"]);
      const eventHash = computeAuditEventHashV2({
        id: auditId,
        organizationId: candidate.organizationId,
        actorType: "system",
        actorId: input.requestedBy,
        action: "source_event.classification_repaired",
        resourceType: "source_event",
        resourceId: candidate.sourceEventId,
        occurredAt: input.repairedAt,
        correlationId: input.repairRunId,
        reason: input.reason,
        previousValue: null,
        newValue,
        versionContext,
        previousEventHash,
      });
      const recorded = await transaction`
        select reconai_record_source_event_classification_repair(
          ${candidate.organizationId}::uuid,
          ${candidate.sourceEventId}::uuid,
          ${candidate.connectionId}::uuid,
          ${candidate.source},
          ${candidate.eventType},
          ${candidate.objectKey},
          ${candidate.payloadSha256},
          ${objectFamilies}::text[],
          ${auditId}::uuid,
          ${input.repairRunId}::uuid,
          ${input.requestedBy},
          ${input.reason},
          ${input.repairedAt}::timestamptz,
          ${previousEventHash},
          ${eventHash}
        ) as inserted
      `;
      const inserted = z.boolean().parse(recorded[0]?.["inserted"]);
      if (!inserted) return { kind: "already_classified" };
      return { kind: "classified" };
    });
  }

  public async countGaps(): Promise<SourceEventClassificationRepairGapCounts> {
    const rows = await this.sql`
      select *
      from reconai_source_event_classification_repair_gap_counts()
    `;
    const row = databaseRow(rows[0]);
    return {
      total: databaseCount(row["total_gaps"], "classification repair total gap count"),
      repairable: databaseCount(
        row["repairable_gaps"],
        "classification repair repairable gap count",
      ),
    };
  }
}

function mapCandidate(value: unknown): SourceEventClassificationRepairCandidate {
  const row = databaseRow(value);
  return {
    organizationId: OrganizationIdSchema.parse(row["organization_id"]),
    sourceEventId: z.uuid().parse(row["source_event_id"]),
    connectionId: z.uuid().parse(row["connection_id"]),
    source: repairSourceSchema.parse(row["source"]),
    eventType: z
      .string()
      .regex(/^[a-z0-9._/-]{1,100}$/u)
      .parse(row["event_type"]),
    objectKey: objectKeySchema.parse(row["payload_object_key"]),
    payloadSha256: sha256Schema.parse(databaseString(row["payload_sha256"]).trim()),
  };
}

function parseRepairFamilies(
  source: SourceEventClassificationRepairCandidate["source"],
  eventType: string,
  value: readonly SourceObjectFamily[],
): readonly SourceObjectFamily[] {
  const families = objectFamiliesSchema.parse(value);
  const compatible =
    (source === "accounting_csv" && families.length === 1 && families[0] === "csv_row") ||
    (source === "shopify" &&
      ((["orders/create", "orders/updated"].includes(eventType) &&
        families.length === 1 &&
        families[0] === "order") ||
        (eventType === "refunds/create" &&
          families.length === 1 &&
          families[0] === "refund_transaction") ||
        (eventType === "orders/snapshot" &&
          ((families.length === 1 && families[0] === "order") ||
            (families.length === 2 &&
              families[0] === "order" &&
              families[1] === "refund_transaction"))))) ||
    (source === "stripe" &&
      ((eventType.startsWith("payment_intent.") &&
        families.length === 1 &&
        families[0] === "payment_intent") ||
        (eventType.startsWith("refund.") && families.length === 1 && families[0] === "refund") ||
        (eventType === "balance_transaction.snapshot" &&
          families.length === 1 &&
          families[0] === "balance_transaction")));
  if (!compatible) {
    throw new Error("classification repair result is incompatible with immutable source evidence");
  }
  return families;
}

function databaseRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("database returned an invalid classification repair row");
  }
  return value as Record<string, unknown>;
}

function databaseString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("database returned an invalid classification repair string");
  }
  return value;
}

function databaseCount(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`database returned an invalid ${field}`);
  }
  return parsed;
}

function optionalAuditHash(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return sha256Schema.parse(databaseString(value).trim());
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) return true;
  }
  return false;
}
