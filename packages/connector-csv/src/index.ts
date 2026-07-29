import { createHash } from "node:crypto";

import {
  CanonicalRecordIdSchema,
  SourceEventIdSchema,
  asCurrency,
  parseMoneyDecimal,
  type AccountingEntryRecord,
  type OrganizationId,
} from "@workspace/domain";
import type { ConnectorMetadata } from "@workspace/connectors";
import { ConnectorError } from "@workspace/connectors";
import { parse } from "csv-parse/sync";
import { z } from "zod";

export const csvMetadata: ConnectorMetadata = {
  name: "accounting_csv",
  connectorVersion: "1.0.0",
  normalizerVersion: "1.0.0",
  readOnly: true,
};

export const DEFAULT_CSV_LIMITS = {
  maximumBytes: 10 * 1024 * 1024,
  maximumRows: 100_000,
  maximumColumns: 50,
  maximumFieldBytes: 10_000,
  maximumPreviewRows: 25,
  maximumPreviewErrors: 100,
} as const;

export interface CsvLimits {
  readonly maximumBytes: number;
  readonly maximumRows: number;
  readonly maximumColumns: number;
  readonly maximumFieldBytes: number;
  readonly maximumPreviewRows: number;
  readonly maximumPreviewErrors: number;
}

export interface CsvColumnMapping {
  readonly externalId: string;
  readonly transactionReference: string;
  readonly orderReference?: string | undefined;
  readonly amount: string;
  readonly currency: string;
  readonly effectiveAt: string;
  readonly entryType: string;
}

const columnNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !hasAsciiControl(value), "column names cannot contain controls");

export const CsvColumnMappingSchema = z
  .object({
    externalId: columnNameSchema,
    transactionReference: columnNameSchema,
    orderReference: columnNameSchema.optional(),
    amount: columnNameSchema,
    currency: columnNameSchema,
    effectiveAt: columnNameSchema,
    entryType: columnNameSchema,
  })
  .strict();

export const CsvImportMetadataSchema = z
  .object({
    connectionId: z.uuid(),
    templateVersion: z.string().regex(/^[A-Za-z0-9._-]{1,50}$/u),
    mappingVersion: z.string().regex(/^[A-Za-z0-9._-]{1,50}$/u),
    mapping: CsvColumnMappingSchema,
  })
  .strict();

export type CsvImportMetadata = z.infer<typeof CsvImportMetadataSchema>;

export interface CsvRowContext {
  readonly organizationId: OrganizationId;
  readonly canonicalRecordId: string;
  readonly sourceEventId: string;
  readonly ingestionTimestamp: string;
  readonly importId: string;
}

export interface CsvRowError {
  readonly row: number;
  readonly code: string;
  readonly message: string;
}

export const CsvRowErrorSchema = z
  .object({
    row: z.int().min(1),
    code: z.string().regex(/^[A-Z0-9_]{1,100}$/u),
    message: z.string().min(1).max(500),
  })
  .strict();

export interface CsvPreview {
  readonly checksumSha256: string;
  readonly rowCount: number;
  readonly validRowCount: number;
  readonly invalidRowCount: number;
  readonly rows: readonly Readonly<Record<string, string>>[];
  readonly errors: readonly CsvRowError[];
  readonly errorsTruncated: boolean;
}

export interface ParsedAccountingCsv {
  readonly checksumSha256: string;
  readonly rows: readonly Readonly<Record<string, string>>[];
  readonly errors: readonly CsvRowError[];
}

const allowedEntryType = z.enum(["payment", "refund", "processing_fee", "other"]);

export function previewAccountingCsv(
  content: Uint8Array,
  mapping: CsvColumnMapping,
  limits: CsvLimits = DEFAULT_CSV_LIMITS,
): CsvPreview {
  const parsed = parseAccountingCsv(content, mapping, limits);
  const invalidRows = new Set(parsed.errors.map((error) => error.row));
  return {
    checksumSha256: parsed.checksumSha256,
    rowCount: parsed.rows.length,
    validRowCount: parsed.rows.length - invalidRows.size,
    invalidRowCount: invalidRows.size,
    rows: selectPreviewColumns(parsed.rows, mapping).slice(0, limits.maximumPreviewRows),
    errors: parsed.errors.slice(0, limits.maximumPreviewErrors),
    errorsTruncated: parsed.errors.length > limits.maximumPreviewErrors,
  };
}

export function parseAccountingCsv(
  content: Uint8Array,
  mappingInput: CsvColumnMapping,
  limits: CsvLimits = DEFAULT_CSV_LIMITS,
): ParsedAccountingCsv {
  validateLimits(content, limits);
  const mapping = CsvColumnMappingSchema.parse(mappingInput);
  let rows: Readonly<Record<string, string>>[];
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
    rows = parse(decoded, {
      bom: true,
      columns: (header: string[]) => {
        if (header.length > limits.maximumColumns) {
          throw new Error("CSV exceeds the configured column limit");
        }
        if (header.some((column) => column.trim().length === 0)) {
          throw new Error("CSV contains an empty header");
        }
        if (new Set(header).size !== header.length) {
          throw new Error("CSV contains duplicate headers");
        }
        return header;
      },
      relax_column_count: false,
      skip_empty_lines: true,
      trim: true,
      max_record_size: limits.maximumFieldBytes * limits.maximumColumns,
      to: limits.maximumRows + 1,
    });
  } catch {
    throw new ConnectorError(
      "invalid_payload",
      "CSV could not be parsed with the selected template",
    );
  }
  if (rows.length > limits.maximumRows) {
    throw new ConnectorError("invalid_payload", "CSV exceeds the configured row limit");
  }
  if (rows.length === 0) {
    throw new ConnectorError("invalid_payload", "CSV must contain at least one data row");
  }
  const errors: CsvRowError[] = [];
  for (const [index, row] of rows.entries()) {
    const columns = Object.keys(row);
    if (columns.length > limits.maximumColumns) {
      errors.push({
        row: index + 2,
        code: "TOO_MANY_COLUMNS",
        message: "row exceeds column limit",
      });
      continue;
    }
    if (
      Object.values(row).some(
        (value) => Buffer.byteLength(value, "utf8") > limits.maximumFieldBytes,
      )
    ) {
      errors.push({
        row: index + 2,
        code: "FIELD_TOO_LARGE",
        message: "row contains a field larger than the configured limit",
      });
      continue;
    }
    for (const required of requiredColumns(mapping)) {
      if (!(required in row) || (row[required] ?? "").trim().length === 0) {
        errors.push({
          row: index + 2,
          code: "MISSING_REQUIRED_VALUE",
          message: `required mapped column is empty: ${required}`,
        });
      }
    }
    const currencyValue = row[mapping.currency];
    const amountValue = row[mapping.amount];
    const effectiveAt = row[mapping.effectiveAt];
    const entryType = row[mapping.entryType];
    try {
      const currency = asCurrency((currencyValue ?? "").toUpperCase());
      parseMoneyDecimal(amountValue ?? "", currency);
      z.iso.datetime({ offset: true }).parse(effectiveAt);
      allowedEntryType.parse(entryType);
    } catch {
      errors.push({
        row: index + 2,
        code: "INVALID_FINANCIAL_ROW",
        message: "amount, currency, timestamp, or entry type is invalid",
      });
    }
  }
  return {
    checksumSha256: createHash("sha256").update(content).digest("hex"),
    rows,
    errors,
  };
}

export function normalizeAccountingRow(
  row: Readonly<Record<string, string>>,
  mapping: CsvColumnMapping,
  context: CsvRowContext,
): AccountingEntryRecord {
  const currency = asCurrency(requiredValue(row, mapping.currency).toUpperCase());
  const externalId = requiredValue(row, mapping.externalId);
  const effectiveAt = z.iso
    .datetime({ offset: true })
    .parse(requiredValue(row, mapping.effectiveAt));
  const orderReference = mapping.orderReference
    ? optionalValue(row, mapping.orderReference)
    : undefined;
  return {
    id: CanonicalRecordIdSchema.parse(context.canonicalRecordId),
    organizationId: context.organizationId,
    version: 1,
    kind: "accounting_entry",
    externalId,
    transactionReference: requiredValue(row, mapping.transactionReference),
    ...(orderReference ? { orderReference } : {}),
    effectiveAt,
    amount: parseMoneyDecimal(requiredValue(row, mapping.amount), currency),
    entryType: allowedEntryType.parse(requiredValue(row, mapping.entryType)),
    provenance: {
      sourceSystem: "accounting_csv",
      externalObjectType: "csv_row",
      externalObjectId: externalId,
      sourceTimestamp: effectiveAt,
      ingestionTimestamp: context.ingestionTimestamp,
      sourceEventId: SourceEventIdSchema.parse(context.sourceEventId),
      connectorVersion: csvMetadata.connectorVersion,
      normalizerVersion: csvMetadata.normalizerVersion,
    },
  };
}

export function protectCsvFormula(value: string): string {
  return /^[ \u00a0]*[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
}

export function csvImportIdempotencyKey(
  organizationId: OrganizationId,
  checksumSha256: string,
  templateVersion: string,
  mappingVersion: string,
  mapping?: CsvColumnMapping,
): string {
  return createHash("sha256")
    .update(
      [
        organizationId,
        checksumSha256,
        templateVersion,
        mappingVersion,
        mapping ? stableMapping(mapping) : "",
      ].join("\0"),
    )
    .digest("hex");
}

function validateLimits(content: Uint8Array, limits: CsvLimits): void {
  if (content.byteLength === 0) throw new ConnectorError("invalid_payload", "CSV is empty");
  if (content.byteLength > limits.maximumBytes) {
    throw new ConnectorError("invalid_payload", "CSV exceeds the configured byte limit");
  }
  if (content.includes(0)) {
    throw new ConnectorError("invalid_payload", "CSV contains a binary NUL byte");
  }
}

function requiredColumns(mapping: CsvColumnMapping): readonly string[] {
  return [
    mapping.externalId,
    mapping.transactionReference,
    mapping.amount,
    mapping.currency,
    mapping.effectiveAt,
    mapping.entryType,
  ];
}

function requiredValue(row: Readonly<Record<string, string>>, column: string): string {
  const value = row[column]?.trim();
  if (!value) throw new ConnectorError("invalid_payload", `missing mapped column: ${column}`);
  if (Buffer.byteLength(value, "utf8") > DEFAULT_CSV_LIMITS.maximumFieldBytes) {
    throw new ConnectorError("invalid_payload", `mapped field is too large: ${column}`);
  }
  return value;
}

function optionalValue(row: Readonly<Record<string, string>>, column: string): string | undefined {
  const value = row[column]?.trim();
  return value === "" ? undefined : value;
}

function stableMapping(mapping: CsvColumnMapping): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(CsvColumnMappingSchema.parse(mapping)).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
  );
}

function selectPreviewColumns(
  rows: readonly Readonly<Record<string, string>>[],
  mapping: CsvColumnMapping,
): readonly Readonly<Record<string, string>>[] {
  const columns = [...new Set([...requiredColumns(mapping), mapping.orderReference])].filter(
    (value): value is string => typeof value === "string",
  );
  return rows.map((row) =>
    Object.fromEntries(columns.map((column) => [column, row[column] ?? ""])),
  );
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
