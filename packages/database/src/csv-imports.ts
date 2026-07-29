import { createHash, randomUUID } from "node:crypto";

import { CsvColumnMappingSchema, CsvRowErrorSchema, csvMetadata } from "@workspace/connector-csv";
import { CsvImportJobEnvelopeSchema, type CsvImportJobEnvelope } from "@workspace/connectors";
import {
  serializeCanonicalRecord,
  type OrganizationId,
  type TenantContext,
} from "@workspace/domain";
import {
  CsvImportConflictError,
  CsvImportNotFoundError,
  CsvImportStatusSchema,
  type CsvImportDraft,
  type CsvImportReceipt,
  type CsvImportRepository,
  type ProcessedCsvRow,
} from "@workspace/ingestion";
import type { JSONValue, Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { insertTenantAuditEvent } from "./audit.js";
import { insertCanonicalFieldProvenance } from "./canonical-provenance.js";

const previewRowsSchema = z.array(z.record(z.string(), z.string())).max(25);
const previewErrorsSchema = z.array(CsvRowErrorSchema).max(100);
const batchSize = 500;

export class PostgresCsvImportRepository implements CsvImportRepository {
  public constructor(private readonly sql: Sql) {}

  public async assertAccountingConnection(
    tenant: TenantContext,
    connectionId: string,
  ): Promise<void> {
    await withTenantContextTransaction(this.sql, tenant, async (transaction) => {
      await requireActiveAccountingConnection(transaction, tenant.organizationId, connectionId);
    });
  }

  public async savePreview(
    tenant: TenantContext,
    draft: CsvImportDraft,
  ): Promise<{ readonly receipt: CsvImportReceipt; readonly inserted: boolean }> {
    return withTenantContextTransaction(this.sql, tenant, async (transaction) => {
      await requireActiveAccountingConnection(
        transaction,
        tenant.organizationId,
        draft.connectionId,
      );
      const inserted = await transaction`
        insert into imports (
          id, organization_id, connection_id, source, object_key, payload_sha256, byte_count,
          content_type, original_filename, template_version, mapping_version, mapping, status,
          idempotency_key, row_count, valid_row_count, invalid_row_count, preview_rows,
          preview_errors, errors_truncated, uploaded_by, uploaded_at
        ) values (
          ${draft.id}, ${tenant.organizationId}, ${draft.connectionId}, 'accounting_csv',
          ${draft.objectKey}, ${draft.payloadSha256}, ${draft.byteCount}, ${draft.contentType},
          ${draft.originalFilename}, ${draft.templateVersion}, ${draft.mappingVersion},
          ${transaction.json(toJsonValue(draft.mapping))}, ${draft.status},
          ${draft.idempotencyKey}, ${draft.rowCount}, ${draft.validRowCount},
          ${draft.invalidRowCount}, ${transaction.json(toJsonValue(draft.previewRows))},
          ${transaction.json(toJsonValue(draft.previewErrors))}, ${draft.errorsTruncated},
          ${tenant.actorId}, ${draft.uploadedAt}
        )
        on conflict (organization_id, idempotency_key) do nothing
        returning *
      `;
      const row =
        inserted[0] ??
        (
          await transaction`
            select *
            from imports
            where organization_id = ${tenant.organizationId}
              and idempotency_key = ${draft.idempotencyKey}
            limit 1
          `
        )[0];
      if (!row) throw new Error("CSV import receipt could not be persisted");
      if (inserted.length > 0) {
        await insertTenantAuditEvent(transaction, {
          organizationId: tenant.organizationId,
          actorType: "user",
          actorId: tenant.actorId,
          action: "csv_import.previewed",
          resourceType: "csv_import",
          resourceId: draft.id,
          correlationId: randomUUID(),
          reason: "Accounting CSV uploaded for bounded preview",
          newValue: {
            status: draft.status,
            rowCount: draft.rowCount,
            invalidRowCount: draft.invalidRowCount,
            checksumSha256: draft.payloadSha256,
          },
          versionContext: {
            connectorVersion: csvMetadata.connectorVersion,
            normalizerVersion: csvMetadata.normalizerVersion,
            templateVersion: draft.templateVersion,
            mappingVersion: draft.mappingVersion,
          },
          occurredAt: draft.uploadedAt,
        });
      }
      return { receipt: mapImportReceipt(row), inserted: inserted.length > 0 };
    });
  }

  public async getImport(
    tenant: TenantContext,
    importId: string,
  ): Promise<CsvImportReceipt | undefined> {
    return withTenantContextTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select *
        from imports
        where organization_id = ${tenant.organizationId}
          and id = ${importId}::uuid
        limit 1
      `;
      return rows[0] ? mapImportReceipt(rows[0]) : undefined;
    });
  }

  public async listImports(
    tenant: TenantContext,
    limit: number,
  ): Promise<readonly CsvImportReceipt[]> {
    return withTenantContextTransaction(this.sql, tenant, async (transaction) => {
      const rows = await transaction`
        select *
        from imports
        where organization_id = ${tenant.organizationId}
        order by uploaded_at desc, id desc
        limit ${limit}
      `;
      return rows.map((row) => mapImportReceipt(row));
    });
  }

  public async queueImport(
    tenant: TenantContext,
    input: {
      readonly importId: string;
      readonly correlationId: string;
      readonly reason: string;
      readonly now: string;
      readonly traceContext?: NonNullable<CsvImportJobEnvelope["traceContext"]>;
    },
  ): Promise<{ readonly receipt: CsvImportReceipt; readonly envelope: CsvImportJobEnvelope }> {
    return withTenantContextTransaction(this.sql, tenant, async (transaction) => {
      const locked = await transaction`
        select *
        from imports
        where organization_id = ${tenant.organizationId}
          and id = ${input.importId}::uuid
        limit 1
        for update
      `;
      const row = locked[0];
      if (!row) throw new CsvImportNotFoundError();
      const current = mapImportReceipt(row);
      if (current.status === "validation_failed") {
        throw new CsvImportConflictError("CSV import has validation errors");
      }
      if (current.status === "rolled_back") {
        throw new CsvImportConflictError("rolled-back CSV import cannot be committed again");
      }
      await requireActiveAccountingConnection(
        transaction,
        tenant.organizationId,
        current.connectionId,
      );
      const idempotencyKey = `csv-import:${current.id}:commit:v1`;
      const existingOutbox = await transaction`
        select payload
        from outbox_events
        where organization_id = ${tenant.organizationId}
          and idempotency_key = ${idempotencyKey}
        limit 1
      `;
      let envelope: CsvImportJobEnvelope;
      if (existingOutbox[0]) {
        envelope = CsvImportJobEnvelopeSchema.parse(existingOutbox[0]["payload"]);
      } else {
        envelope = CsvImportJobEnvelopeSchema.parse({
          schemaVersion: 1,
          type: "csv.import.commit",
          organizationId: tenant.organizationId,
          connectionId: current.connectionId,
          importId: current.id,
          correlationId: input.correlationId,
          idempotencyKey,
          requestedBy: tenant.actorId,
          createdAt: input.now,
          ...(input.traceContext ? { traceContext: input.traceContext } : {}),
        });
        await transaction`
          insert into outbox_events (
            id, organization_id, event_type, schema_version, idempotency_key,
            payload, correlation_id, execution_tracking_version
          ) values (
            ${randomUUID()}, ${tenant.organizationId}, ${envelope.type}, ${envelope.schemaVersion},
            ${envelope.idempotencyKey}, ${transaction.json(toJsonValue(envelope))},
            ${envelope.correlationId}, 1
          )
        `;
      }
      if (current.status === "previewed" || current.status === "failed") {
        await transaction`
          update imports
          set status = 'queued', committed_at = coalesce(committed_at, ${input.now}),
              last_error_code = null, updated_at = now()
          where organization_id = ${tenant.organizationId}
            and id = ${current.id}::uuid
        `;
        await insertTenantAuditEvent(transaction, {
          organizationId: tenant.organizationId,
          actorType: "user",
          actorId: tenant.actorId,
          action: "csv_import.committed",
          resourceType: "csv_import",
          resourceId: current.id,
          correlationId: input.correlationId,
          reason: input.reason,
          newValue: { status: "queued", rowCount: current.rowCount },
          versionContext: {
            connectorVersion: csvMetadata.connectorVersion,
            normalizerVersion: csvMetadata.normalizerVersion,
            templateVersion: current.templateVersion,
            mappingVersion: current.mappingVersion,
          },
          occurredAt: input.now,
        });
      }
      const updated = await transaction`
        select *
        from imports
        where organization_id = ${tenant.organizationId}
          and id = ${current.id}::uuid
        limit 1
      `;
      const updatedRow = updated[0];
      if (!updatedRow) throw new Error("CSV import disappeared during commit");
      return { receipt: mapImportReceipt(updatedRow), envelope };
    });
  }

  public async markOutboxPublished(
    tenant: TenantContext,
    idempotencyKey: string,
    publishedAt: string,
  ): Promise<void> {
    await withTenantContextTransaction(this.sql, tenant, async (transaction) => {
      await transaction`
        update outbox_events
        set published_at = coalesce(published_at, ${publishedAt}),
            attempts = attempts + 1,
            last_error_code = null
        where organization_id = ${tenant.organizationId}
          and idempotency_key = ${idempotencyKey}
          and published_at is null
          and dead_lettered_at is null
      `;
    });
  }

  public async loadForProcessing(
    organizationId: OrganizationId,
    importId: string,
  ): Promise<CsvImportReceipt | undefined> {
    return withOrganizationTransaction(this.sql, organizationId, async (transaction) => {
      const rows = await transaction`
        select *
        from imports
        where organization_id = ${organizationId}
          and id = ${importId}::uuid
        limit 1
      `;
      return rows[0] ? mapImportReceipt(rows[0]) : undefined;
    });
  }

  public async completeImport(
    envelope: CsvImportJobEnvelope,
    rows: readonly ProcessedCsvRow[],
    completedAt: string,
  ): Promise<"processed" | "already_processed"> {
    return withOrganizationTransaction(this.sql, envelope.organizationId, async (transaction) => {
      const locked = await transaction`
          select *
          from imports
          where organization_id = ${envelope.organizationId}
            and id = ${envelope.importId}::uuid
          limit 1
          for update
        `;
      const rawReceipt = locked[0];
      if (!rawReceipt) throw new CsvImportNotFoundError();
      const receipt = mapImportReceipt(rawReceipt);
      if (receipt.status === "succeeded") return "already_processed";
      if (receipt.status !== "queued" && receipt.status !== "failed") {
        throw new CsvImportConflictError("CSV import is not processable");
      }
      if (rows.length !== receipt.rowCount) {
        throw new CsvImportConflictError("CSV import row count changed before persistence");
      }

      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const batch = rows.slice(offset, offset + batchSize);
        const sourceValues = batch.map(({ rowNumber, record }) => ({
          id: record.provenance.sourceEventId,
          organization_id: receipt.organizationId,
          connection_id: receipt.connectionId,
          import_id: receipt.id,
          source: "accounting_csv",
          external_event_id: `csv:${receipt.id}:${rowNumber.toString()}`,
          external_object_type: record.provenance.externalObjectType,
          external_object_id: requiredExternalId(record.externalId),
          source_timestamp: record.provenance.sourceTimestamp,
          received_at: receipt.uploadedAt,
          connector_version: record.provenance.connectorVersion,
          payload_object_key: receipt.objectKey,
          payload_sha256: receipt.payloadSha256,
          status: "processed",
        }));
        await transaction`
            insert into source_events ${transaction(
              sourceValues,
              "id",
              "organization_id",
              "connection_id",
              "import_id",
              "source",
              "external_event_id",
              "external_object_type",
              "external_object_id",
              "source_timestamp",
              "received_at",
              "connector_version",
              "payload_object_key",
              "payload_sha256",
              "status",
            )}
            on conflict (organization_id, connection_id, source, external_event_id) do nothing
          `;
        const classificationValues = sourceValues.map((source) => ({
          organization_id: source.organization_id,
          source_event_id: source.id,
          object_families: ["csv_row"],
          classifier_version: "source-object-family-v1",
        }));
        await transaction`
            insert into source_event_object_classifications ${transaction(
              classificationValues,
              "organization_id",
              "source_event_id",
              "object_families",
              "classifier_version",
            )}
            on conflict (organization_id, source_event_id) do nothing
          `;

        const canonicalValues = batch.map(({ record }) => {
          const serialized = serializeCanonicalRecord(record);
          return {
            id: record.id,
            organization_id: receipt.organizationId,
            version: record.version,
            kind: record.kind,
            source_event_id: record.provenance.sourceEventId,
            source: record.provenance.sourceSystem,
            external_object_type: record.provenance.externalObjectType,
            external_object_id: record.provenance.externalObjectId,
            source_timestamp: record.provenance.sourceTimestamp,
            ingestion_timestamp: record.provenance.ingestionTimestamp,
            effective_at: record.effectiveAt,
            connector_version: record.provenance.connectorVersion,
            normalizer_version: record.provenance.normalizerVersion,
            amount_minor: record.amount.minor.toString(),
            currency: record.amount.currency,
            order_reference: record.orderReference ?? null,
            customer_reference: record.customerReference ?? null,
            normalized_data: transaction.json(toJsonValue(serialized)),
            content_sha256: createHash("sha256").update(stableStringify(serialized)).digest("hex"),
            is_incomplete: (record.incompleteReasons?.length ?? 0) > 0,
          };
        });
        await transaction`
            insert into canonical_records ${transaction(
              canonicalValues,
              "id",
              "organization_id",
              "version",
              "kind",
              "source_event_id",
              "source",
              "external_object_type",
              "external_object_id",
              "source_timestamp",
              "ingestion_timestamp",
              "effective_at",
              "connector_version",
              "normalizer_version",
              "amount_minor",
              "currency",
              "order_reference",
              "customer_reference",
              "normalized_data",
              "content_sha256",
              "is_incomplete",
            )}
            on conflict (
              organization_id, source_event_id, normalizer_version, kind, external_object_id
            ) do nothing
          `;
        await insertCanonicalFieldProvenance(
          transaction,
          batch.map(({ record }) => record),
        );
      }

      const persisted = await transaction`
          select
            count(*)::integer as source_count,
            count(canonical_records.id)::integer as canonical_count,
            count(source_event_object_classifications.source_event_id)::integer
              as classification_count,
            count(*) filter (
              where source_event_object_classifications.object_families
                is distinct from ARRAY['csv_row']::text[]
                or source_event_object_classifications.classifier_version
                  is distinct from 'source-object-family-v1'
            )::integer as classification_conflict_count
          from source_events
          left join canonical_records
            on canonical_records.organization_id = source_events.organization_id
           and canonical_records.source_event_id = source_events.id
           and canonical_records.normalizer_version = ${csvMetadata.normalizerVersion}
          left join source_event_object_classifications
            on source_event_object_classifications.organization_id = source_events.organization_id
           and source_event_object_classifications.source_event_id = source_events.id
          where source_events.organization_id = ${receipt.organizationId}
            and source_events.import_id = ${receipt.id}::uuid
        `;
      const counts = persisted[0];
      if (
        Number(counts?.["source_count"]) !== rows.length ||
        Number(counts?.["canonical_count"]) !== rows.length ||
        Number(counts?.["classification_count"]) !== rows.length ||
        Number(counts?.["classification_conflict_count"]) !== 0
      ) {
        throw new Error("CSV import idempotency verification failed");
      }
      await transaction`
          update imports
          set status = 'succeeded', completed_at = ${completedAt},
              last_error_code = null, updated_at = now()
          where organization_id = ${receipt.organizationId}
            and id = ${receipt.id}::uuid
        `;
      await insertTenantAuditEvent(transaction, {
        organizationId: receipt.organizationId,
        actorType: "worker",
        actorId: "csv-import-worker",
        action: "csv_import.completed",
        resourceType: "csv_import",
        resourceId: receipt.id,
        correlationId: envelope.correlationId,
        reason: "Durable accounting CSV normalization completed",
        newValue: { status: "succeeded", rowCount: rows.length },
        versionContext: {
          connectorVersion: csvMetadata.connectorVersion,
          normalizerVersion: csvMetadata.normalizerVersion,
          templateVersion: receipt.templateVersion,
          mappingVersion: receipt.mappingVersion,
        },
        occurredAt: completedAt,
      });
      return "processed";
    });
  }

  public async markImportFailed(
    envelope: CsvImportJobEnvelope,
    errorCode: string,
    failedAt: string,
  ): Promise<void> {
    await withOrganizationTransaction(this.sql, envelope.organizationId, async (transaction) => {
      const updated = await transaction`
        update imports
        set status = 'failed', last_error_code = ${errorCode}, updated_at = now()
        where organization_id = ${envelope.organizationId}
          and id = ${envelope.importId}::uuid
          and status <> 'succeeded'
          and (status <> 'failed' or last_error_code is distinct from ${errorCode})
        returning id
      `;
      if (updated.length > 0) {
        await insertTenantAuditEvent(transaction, {
          organizationId: envelope.organizationId,
          actorType: "worker",
          actorId: "csv-import-worker",
          action: "csv_import.failed",
          resourceType: "csv_import",
          resourceId: envelope.importId,
          correlationId: envelope.correlationId,
          reason: errorCode,
          newValue: { status: "failed", errorCode },
          versionContext: { schemaVersion: envelope.schemaVersion },
          occurredAt: failedAt,
        });
      }
    });
  }

  public async rollbackImport(
    tenant: TenantContext,
    input: {
      readonly importId: string;
      readonly correlationId: string;
      readonly reason: string;
      readonly now: string;
    },
  ): Promise<CsvImportReceipt> {
    return withTenantContextTransaction(this.sql, tenant, async (transaction) => {
      await transaction`
        select pg_advisory_xact_lock(hashtextextended(${tenant.organizationId}, 1))
      `;
      const locked = await transaction`
        select *
        from imports
        where organization_id = ${tenant.organizationId}
          and id = ${input.importId}::uuid
        limit 1
        for update
      `;
      const row = locked[0];
      if (!row) throw new CsvImportNotFoundError();
      const current = mapImportReceipt(row);
      if (current.status === "rolled_back") return current;
      if (current.status !== "succeeded") {
        throw new CsvImportConflictError("only a succeeded CSV import can be rolled back");
      }

      const canonicalCounts = await transaction`
        select
          count(distinct source_events.id)::integer as source_count,
          count(canonical_records.id)::integer as canonical_count
        from source_events
        left join canonical_records
          on canonical_records.organization_id = source_events.organization_id
         and canonical_records.source_event_id = source_events.id
        where source_events.organization_id = ${tenant.organizationId}
          and source_events.import_id = ${current.id}::uuid
      `;
      const sourceCount = databaseInteger(
        canonicalCounts[0]?.["source_count"],
        "rollback source event count",
      );
      const canonicalCount = databaseInteger(
        canonicalCounts[0]?.["canonical_count"],
        "canonical rollback count",
      );
      if (sourceCount !== current.rowCount || canonicalCount < sourceCount) {
        throw new CsvImportConflictError(
          "CSV import evidence does not match its immutable receipt",
        );
      }

      await transaction`
        insert into canonical_record_supersessions (
          organization_id, record_id, record_version, source_import_id, actor_id,
          correlation_id, reason, superseded_at
        )
        select
          canonical_records.organization_id,
          canonical_records.id,
          canonical_records.version,
          ${current.id}::uuid,
          ${tenant.actorId},
          ${input.correlationId}::uuid,
          ${input.reason},
          ${input.now}
        from canonical_records
        join source_events
          on source_events.organization_id = canonical_records.organization_id
         and source_events.id = canonical_records.source_event_id
        where canonical_records.organization_id = ${tenant.organizationId}
          and source_events.import_id = ${current.id}::uuid
        on conflict (organization_id, record_id, record_version) do nothing
      `;
      const supersessionCounts = await transaction`
        select count(*)::integer as supersession_count
        from canonical_record_supersessions
        where organization_id = ${tenant.organizationId}
          and source_import_id = ${current.id}::uuid
      `;
      const supersededRecordCount = databaseInteger(
        supersessionCounts[0]?.["supersession_count"],
        "canonical supersession count",
      );
      if (supersededRecordCount !== canonicalCount) {
        throw new CsvImportConflictError("CSV import supersession could not be verified");
      }

      const updated = await transaction`
        update imports
        set status = 'rolled_back',
            rolled_back_at = ${input.now},
            superseded_record_count = ${supersededRecordCount},
            updated_at = now()
        where organization_id = ${tenant.organizationId}
          and id = ${current.id}::uuid
        returning *
      `;
      const updatedRow = updated[0];
      if (!updatedRow) throw new Error("CSV import disappeared during rollback");
      await insertTenantAuditEvent(transaction, {
        organizationId: tenant.organizationId,
        actorType: "user",
        actorId: tenant.actorId,
        action: "csv_import.rolled_back",
        resourceType: "csv_import",
        resourceId: current.id,
        correlationId: input.correlationId,
        reason: input.reason,
        previousValue: { status: "succeeded" },
        newValue: {
          status: "rolled_back",
          supersededRecordCount,
        },
        versionContext: {
          connectorVersion: csvMetadata.connectorVersion,
          normalizerVersion: csvMetadata.normalizerVersion,
          templateVersion: current.templateVersion,
          mappingVersion: current.mappingVersion,
        },
        occurredAt: input.now,
      });
      return mapImportReceipt(updatedRow);
    });
  }
}

async function withOrganizationTransaction<T>(
  sql: Sql,
  organizationId: OrganizationId,
  operation: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
    return operation(transaction);
  }) as Promise<T>;
}

async function withTenantContextTransaction<T>(
  sql: Sql,
  tenant: TenantContext,
  operation: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return withOrganizationTransaction(sql, tenant.organizationId, operation);
}

function mapImportReceipt(value: unknown): CsvImportReceipt {
  const row = databaseRow(value);
  const receipt: CsvImportReceipt = {
    id: databaseString(row["id"], "imports.id"),
    organizationId: z
      .uuid()
      .transform((value) => value as OrganizationId)
      .parse(databaseString(row["organization_id"], "imports.organization_id")),
    connectionId: z.uuid().parse(databaseString(row["connection_id"], "imports.connection_id")),
    status: CsvImportStatusSchema.parse(row["status"]),
    objectKey: databaseString(row["object_key"], "imports.object_key"),
    payloadSha256: databaseString(row["payload_sha256"], "imports.payload_sha256").trim(),
    byteCount: databaseInteger(row["byte_count"], "imports.byte_count"),
    contentType: z
      .enum(["text/csv", "application/csv"])
      .parse(databaseString(row["content_type"], "imports.content_type")),
    originalFilename: databaseString(row["original_filename"], "imports.original_filename"),
    templateVersion: databaseString(row["template_version"], "imports.template_version"),
    mappingVersion: databaseString(row["mapping_version"], "imports.mapping_version"),
    mapping: CsvColumnMappingSchema.parse(row["mapping"]),
    idempotencyKey: databaseString(row["idempotency_key"], "imports.idempotency_key").trim(),
    rowCount: databaseInteger(row["row_count"], "imports.row_count"),
    validRowCount: databaseInteger(row["valid_row_count"], "imports.valid_row_count"),
    invalidRowCount: databaseInteger(row["invalid_row_count"], "imports.invalid_row_count"),
    previewRows: previewRowsSchema.parse(row["preview_rows"]),
    previewErrors: previewErrorsSchema.parse(row["preview_errors"]),
    errorsTruncated: z.boolean().parse(row["errors_truncated"]),
    uploadedBy: z.uuid().parse(databaseString(row["uploaded_by"], "imports.uploaded_by")),
    uploadedAt: databaseTimestamp(row["uploaded_at"], "imports.uploaded_at"),
    ...(row["committed_at"]
      ? { committedAt: databaseTimestamp(row["committed_at"], "imports.committed_at") }
      : {}),
    ...(row["completed_at"]
      ? { completedAt: databaseTimestamp(row["completed_at"], "imports.completed_at") }
      : {}),
    ...(row["rolled_back_at"]
      ? { rolledBackAt: databaseTimestamp(row["rolled_back_at"], "imports.rolled_back_at") }
      : {}),
    ...(row["superseded_record_count"] !== null && row["superseded_record_count"] !== undefined
      ? {
          supersededRecordCount: databaseInteger(
            row["superseded_record_count"],
            "imports.superseded_record_count",
          ),
        }
      : {}),
    ...(row["last_error_code"]
      ? { lastErrorCode: databaseString(row["last_error_code"], "imports.last_error_code") }
      : {}),
  };
  return receipt;
}

function requiredExternalId(value: string | undefined): string {
  if (!value) throw new Error("normalized accounting row has no external identity");
  return value;
}

async function requireActiveAccountingConnection(
  transaction: TransactionSql,
  organizationId: string,
  connectionId: string,
): Promise<void> {
  const connection = await transaction`
    select provider, status
    from data_source_connections
    where organization_id = ${organizationId}
      and id = ${connectionId}::uuid
    limit 1
  `;
  const connectionRow = connection[0];
  if (!connectionRow) throw new CsvImportNotFoundError();
  if (connectionRow["provider"] !== "accounting_csv" || connectionRow["status"] !== "healthy") {
    throw new CsvImportConflictError("accounting CSV connection is not active");
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      return item;
    }),
  ) as JSONValue;
}

function databaseRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("database returned an invalid CSV import row");
  }
  return value as Record<string, unknown>;
}

function databaseString(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  throw new Error(`database returned an invalid ${field}`);
}

function databaseInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`database returned an invalid ${field}`);
  }
  return parsed;
}

function databaseTimestamp(value: unknown, field: string): string {
  const parsed = value instanceof Date ? value : new Date(databaseString(value, field));
  if (Number.isNaN(parsed.getTime())) throw new Error(`database returned an invalid ${field}`);
  return parsed.toISOString();
}
