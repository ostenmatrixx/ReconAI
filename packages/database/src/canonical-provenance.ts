import { canonicalFieldProvenance, type CanonicalRecord } from "@workspace/domain";
import type { JSONValue, TransactionSql } from "postgres";

const provenanceBatchSize = 500;

export async function insertCanonicalFieldProvenance(
  transaction: TransactionSql,
  records: readonly CanonicalRecord[],
): Promise<void> {
  const values = records.flatMap((record) =>
    canonicalFieldProvenance(record).map((entry) => ({
      organization_id: record.organizationId,
      record_id: record.id,
      record_version: record.version,
      field_path: entry.fieldPath,
      source_event_id: entry.sourceEventId,
      source_value_reference: entry.sourceValueReference,
      normalized_value: transaction.json(entry.normalizedValue as JSONValue),
      transformation_rule: entry.transformationRule,
      transformation_version: entry.transformationVersion,
      warnings: transaction.json(toJsonValue(entry.warnings)),
    })),
  );
  for (let offset = 0; offset < values.length; offset += provenanceBatchSize) {
    const batch = values.slice(offset, offset + provenanceBatchSize);
    await transaction`
      insert into canonical_field_provenance ${transaction(
        batch,
        "organization_id",
        "record_id",
        "record_version",
        "field_path",
        "source_event_id",
        "source_value_reference",
        "normalized_value",
        "transformation_rule",
        "transformation_version",
        "warnings",
      )}
      on conflict (organization_id, record_id, record_version, field_path) do nothing
    `;
  }
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}
