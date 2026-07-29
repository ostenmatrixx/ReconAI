import { createHash } from "node:crypto";

import {
  CsvImportMetadataSchema,
  DEFAULT_CSV_LIMITS,
  csvImportIdempotencyKey,
  normalizeAccountingRow,
  parseAccountingCsv,
  previewAccountingCsv,
  type CsvColumnMapping,
  type CsvImportMetadata,
  type CsvRowError,
} from "@workspace/connector-csv";
import {
  ConnectorError,
  CsvImportJobEnvelopeSchema,
  createDurableTraceContext,
  type CsvImportJobEnvelope,
  type DurableTraceContext,
} from "@workspace/connectors";
import {
  OrganizationIdSchema,
  type AccountingEntryRecord,
  type OrganizationId,
  type TenantContext,
} from "@workspace/domain";
import {
  ObjectIntegrityError,
  ObjectNotFoundError,
  buildTenantObjectKey,
  type ImmutableObjectStore,
} from "@workspace/object-storage";
import { z } from "zod";

export * from "./provider-webhooks.js";
export * from "./provider-sync.js";
export * from "./provider-deauthorization.js";
export * from "./provider-privacy.js";
export * from "./provider-privacy-data-package.js";

export const CsvImportStatusSchema = z.enum([
  "previewed",
  "validation_failed",
  "queued",
  "succeeded",
  "failed",
  "rolled_back",
]);
export type CsvImportStatus = z.infer<typeof CsvImportStatusSchema>;

export interface CsvImportReceipt {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly connectionId: string;
  readonly status: CsvImportStatus;
  readonly objectKey: string;
  readonly payloadSha256: string;
  readonly byteCount: number;
  readonly contentType: "text/csv" | "application/csv";
  readonly originalFilename: string;
  readonly templateVersion: string;
  readonly mappingVersion: string;
  readonly mapping: CsvColumnMapping;
  readonly idempotencyKey: string;
  readonly rowCount: number;
  readonly validRowCount: number;
  readonly invalidRowCount: number;
  readonly previewRows: readonly Readonly<Record<string, string>>[];
  readonly previewErrors: readonly CsvRowError[];
  readonly errorsTruncated: boolean;
  readonly uploadedBy: string;
  readonly uploadedAt: string;
  readonly committedAt?: string;
  readonly completedAt?: string;
  readonly rolledBackAt?: string;
  readonly supersededRecordCount?: number;
  readonly lastErrorCode?: string;
}

export type CsvImportDraft = CsvImportReceipt;

export interface ProcessedCsvRow {
  readonly rowNumber: number;
  readonly record: AccountingEntryRecord;
}

export interface CsvImportRepository {
  assertAccountingConnection(tenant: TenantContext, connectionId: string): Promise<void>;
  savePreview(
    tenant: TenantContext,
    draft: CsvImportDraft,
  ): Promise<{ readonly receipt: CsvImportReceipt; readonly inserted: boolean }>;
  getImport(tenant: TenantContext, importId: string): Promise<CsvImportReceipt | undefined>;
  listImports(tenant: TenantContext, limit: number): Promise<readonly CsvImportReceipt[]>;
  queueImport(
    tenant: TenantContext,
    input: {
      readonly importId: string;
      readonly correlationId: string;
      readonly reason: string;
      readonly now: string;
      readonly traceContext?: DurableTraceContext;
    },
  ): Promise<{ readonly receipt: CsvImportReceipt; readonly envelope: CsvImportJobEnvelope }>;
  markOutboxPublished(
    tenant: TenantContext,
    idempotencyKey: string,
    publishedAt: string,
  ): Promise<void>;
  loadForProcessing(
    organizationId: OrganizationId,
    importId: string,
  ): Promise<CsvImportReceipt | undefined>;
  completeImport(
    envelope: CsvImportJobEnvelope,
    rows: readonly ProcessedCsvRow[],
    completedAt: string,
  ): Promise<"processed" | "already_processed">;
  markImportFailed(
    envelope: CsvImportJobEnvelope,
    errorCode: string,
    failedAt: string,
  ): Promise<void>;
  rollbackImport(
    tenant: TenantContext,
    input: {
      readonly importId: string;
      readonly correlationId: string;
      readonly reason: string;
      readonly now: string;
    },
  ): Promise<CsvImportReceipt>;
}

export interface ConnectorJobPublisher {
  publish(envelope: CsvImportJobEnvelope): Promise<void>;
}

export interface CsvImportServiceOptions {
  readonly environment: string;
  readonly repository: CsvImportRepository;
  readonly objectStore: ImmutableObjectStore;
  readonly publisher?: ConnectorJobPublisher;
  readonly now?: () => Date;
}

export interface CsvUpload {
  readonly filename: string;
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly metadata: CsvImportMetadata;
}

export interface CsvImportPreviewResult {
  readonly receipt: CsvImportReceipt;
  readonly duplicate: boolean;
}

export class CsvImportValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CsvImportValidationError";
  }
}

export class CsvImportNotFoundError extends Error {
  public constructor() {
    super("CSV import was not found");
    this.name = "CsvImportNotFoundError";
  }
}

export class CsvImportConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CsvImportConflictError";
  }
}

export class CsvImportDispatchError extends Error {
  public constructor() {
    super("CSV import is durably queued but dispatch is temporarily unavailable");
    this.name = "CsvImportDispatchError";
  }
}

export class CsvImportTerminalError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CsvImportTerminalError";
  }
}

export class CsvImportService {
  readonly #now: () => Date;

  public constructor(private readonly options: CsvImportServiceOptions) {
    this.#now = options.now ?? (() => new Date());
  }

  public async createPreview(
    tenant: TenantContext,
    upload: CsvUpload,
  ): Promise<CsvImportPreviewResult> {
    const metadata = CsvImportMetadataSchema.parse(upload.metadata);
    await this.options.repository.assertAccountingConnection(tenant, metadata.connectionId);
    const contentType = parseCsvContentType(upload.contentType);
    const originalFilename = parseCsvFilename(upload.filename);
    const preview = previewAccountingCsv(upload.body, metadata.mapping);
    const idempotencyKey = csvImportIdempotencyKey(
      tenant.organizationId,
      preview.checksumSha256,
      metadata.templateVersion,
      metadata.mappingVersion,
      metadata.mapping,
    );
    const importId = stableUuid(`csv-import\0${idempotencyKey}`);
    const objectKey = buildTenantObjectKey(
      this.options.environment,
      tenant.organizationId,
      "imports",
      importId,
      "payload.csv",
    );
    await this.options.objectStore.putImmutable({
      key: objectKey,
      body: upload.body,
      contentType,
      checksumSha256: preview.checksumSha256,
      metadata: {
        "organization-id": tenant.organizationId,
        "import-id": importId,
      },
    });
    const uploadedAt = this.#now().toISOString();
    const draft: CsvImportDraft = {
      id: importId,
      organizationId: tenant.organizationId,
      connectionId: metadata.connectionId,
      status: preview.invalidRowCount === 0 ? "previewed" : "validation_failed",
      objectKey,
      payloadSha256: preview.checksumSha256,
      byteCount: upload.body.byteLength,
      contentType,
      originalFilename,
      templateVersion: metadata.templateVersion,
      mappingVersion: metadata.mappingVersion,
      mapping: metadata.mapping,
      idempotencyKey,
      rowCount: preview.rowCount,
      validRowCount: preview.validRowCount,
      invalidRowCount: preview.invalidRowCount,
      previewRows: preview.rows,
      previewErrors: preview.errors,
      errorsTruncated: preview.errorsTruncated,
      uploadedBy: tenant.actorId,
      uploadedAt,
    };
    const saved = await this.options.repository.savePreview(tenant, draft);
    const receipt = saved.receipt;
    assertSameImportIdentity(receipt, draft);
    return { receipt, duplicate: !saved.inserted };
  }

  public async getImport(
    tenant: TenantContext,
    importId: string,
  ): Promise<CsvImportReceipt | undefined> {
    return this.options.repository.getImport(tenant, z.uuid().parse(importId));
  }

  public async listImports(
    tenant: TenantContext,
    limit = 50,
  ): Promise<readonly CsvImportReceipt[]> {
    return this.options.repository.listImports(
      tenant,
      z.number().int().min(1).max(100).parse(limit),
    );
  }

  public async commitImport(
    tenant: TenantContext,
    input: {
      readonly importId: string;
      readonly correlationId: string;
      readonly reason: string;
      readonly traceparent?: string;
    },
  ): Promise<CsvImportReceipt> {
    const traceContext = createDurableTraceContext(input.traceparent);
    const now = this.#now().toISOString();
    const queued = await this.options.repository.queueImport(tenant, {
      importId: z.uuid().parse(input.importId),
      correlationId: z.uuid().parse(input.correlationId),
      reason: z.string().trim().min(3).max(2000).parse(input.reason),
      now,
      ...(traceContext ? { traceContext } : {}),
    });
    try {
      if (!this.options.publisher) throw new CsvImportDispatchError();
      await this.options.publisher.publish(queued.envelope);
      await this.options.repository.markOutboxPublished(
        tenant,
        queued.envelope.idempotencyKey,
        now,
      );
    } catch {
      throw new CsvImportDispatchError();
    }
    return queued.receipt;
  }

  public async rollbackImport(
    tenant: TenantContext,
    input: {
      readonly importId: string;
      readonly confirmImportId: string;
      readonly correlationId: string;
      readonly reason: string;
    },
  ): Promise<CsvImportReceipt> {
    const importId = z.uuid().parse(input.importId);
    const confirmImportId = z.uuid().parse(input.confirmImportId);
    if (importId !== confirmImportId) {
      throw new CsvImportValidationError("rollback confirmation does not match the import");
    }
    return this.options.repository.rollbackImport(tenant, {
      importId,
      correlationId: z.uuid().parse(input.correlationId),
      reason: z.string().trim().min(3).max(2000).parse(input.reason),
      now: this.#now().toISOString(),
    });
  }

  public async processImport(
    envelopeInput: CsvImportJobEnvelope,
  ): Promise<"processed" | "already_processed"> {
    const envelope = CsvImportJobEnvelopeSchema.parse(envelopeInput);
    const receipt = await this.options.repository.loadForProcessing(
      envelope.organizationId,
      envelope.importId,
    );
    if (!receipt) throw new CsvImportTerminalError("IMPORT_NOT_FOUND", "CSV import was not found");
    if (
      receipt.connectionId !== envelope.connectionId ||
      `csv-import:${receipt.id}:commit:v1` !== envelope.idempotencyKey
    ) {
      throw new CsvImportTerminalError(
        "IMPORT_AUTHORITY_MISMATCH",
        "CSV import job does not match its durable receipt",
      );
    }
    if (receipt.status === "succeeded") return "already_processed";
    if (receipt.status !== "queued" && receipt.status !== "failed") {
      throw new CsvImportTerminalError(
        "IMPORT_STATE_INVALID",
        "CSV import is not in a processable state",
      );
    }

    try {
      const body = await this.options.objectStore.getVerified({
        key: receipt.objectKey,
        expectedChecksumSha256: receipt.payloadSha256,
        maximumBytes: DEFAULT_CSV_LIMITS.maximumBytes,
      });
      const parsed = parseAccountingCsv(body, receipt.mapping);
      if (parsed.errors.length > 0) {
        throw new CsvImportTerminalError(
          "IMPORT_VALIDATION_CHANGED",
          "CSV no longer validates against its committed mapping",
        );
      }
      if (parsed.rows.length !== receipt.rowCount) {
        throw new CsvImportTerminalError(
          "IMPORT_ROW_COUNT_CHANGED",
          "CSV row count does not match its committed preview",
        );
      }
      const rows = parsed.rows.map((row, index): ProcessedCsvRow => {
        const rowNumber = index + 2;
        const sourceEventId = stableUuid(`${receipt.id}\0source-event\0${rowNumber.toString()}`);
        const canonicalRecordId = stableUuid(
          `${receipt.id}\0canonical-record\0${rowNumber.toString()}`,
        );
        return {
          rowNumber,
          record: normalizeAccountingRow(row, receipt.mapping, {
            organizationId: receipt.organizationId,
            canonicalRecordId,
            sourceEventId,
            ingestionTimestamp: receipt.uploadedAt,
            importId: receipt.id,
          }),
        };
      });
      return await this.options.repository.completeImport(
        envelope,
        rows,
        this.#now().toISOString(),
      );
    } catch (error) {
      const terminal =
        error instanceof CsvImportTerminalError
          ? error
          : error instanceof ObjectIntegrityError || error instanceof ObjectNotFoundError
            ? new CsvImportTerminalError(
                "IMPORT_OBJECT_INVALID",
                "CSV import object could not be verified",
              )
            : error instanceof ConnectorError || error instanceof z.ZodError
              ? new CsvImportTerminalError(
                  "IMPORT_NORMALIZATION_INVALID",
                  "CSV import failed committed normalization",
                )
              : undefined;
      if (terminal) {
        await this.options.repository.markImportFailed(
          envelope,
          terminal.code,
          this.#now().toISOString(),
        );
        throw terminal;
      }
      throw error;
    }
  }
}

export function stableUuid(input: string): string {
  const bytes = createHash("sha256").update(input).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return z
    .uuid()
    .parse(
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    );
}

function parseCsvContentType(value: string): "text/csv" | "application/csv" {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "text/csv" || normalized === "application/csv") return normalized;
  throw new CsvImportValidationError("file content type must be text/csv or application/csv");
}

function parseCsvFilename(value: string): string {
  const normalized = value.normalize("NFC");
  if (
    normalized.length < 1 ||
    normalized.length > 255 ||
    !normalized.toLowerCase().endsWith(".csv") ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    hasAsciiControl(normalized)
  ) {
    throw new CsvImportValidationError("file name must be a safe .csv display name");
  }
  return normalized;
}

function assertSameImportIdentity(receipt: CsvImportReceipt, draft: CsvImportDraft): void {
  const left = [
    receipt.id,
    receipt.organizationId,
    receipt.connectionId,
    receipt.objectKey,
    receipt.payloadSha256,
    receipt.templateVersion,
    receipt.mappingVersion,
    stableMappingIdentity(receipt.mapping),
    receipt.idempotencyKey,
    receipt.byteCount.toString(),
    receipt.contentType,
    receipt.rowCount.toString(),
    receipt.validRowCount.toString(),
    receipt.invalidRowCount.toString(),
  ];
  const right = [
    draft.id,
    draft.organizationId,
    draft.connectionId,
    draft.objectKey,
    draft.payloadSha256,
    draft.templateVersion,
    draft.mappingVersion,
    stableMappingIdentity(draft.mapping),
    draft.idempotencyKey,
    draft.byteCount.toString(),
    draft.contentType,
    draft.rowCount.toString(),
    draft.validRowCount.toString(),
    draft.invalidRowCount.toString(),
  ];
  if (left.some((value, index) => value !== right[index])) {
    throw new CsvImportConflictError("existing CSV import identity does not match this upload");
  }
}

function stableMappingIdentity(mapping: CsvColumnMapping): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(mapping)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  );
}

export function parseOrganizationId(value: string): OrganizationId {
  return OrganizationIdSchema.parse(value);
}

function hasAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      code <= 31 ||
      code === 127 ||
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    );
  });
}
