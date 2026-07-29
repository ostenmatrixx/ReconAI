import { describe, expect, it } from "vitest";

import {
  MAX_EXCEPTION_EXPORT_BYTES,
  RepositoryExportLimitError,
  serializeExceptionExport,
  type ExceptionListItem,
} from "./repository.js";

describe("exception CSV export", () => {
  it("produces deterministic RFC 4180 rows with formula-safe cells and a UTF-8 BOM", () => {
    const items: readonly ExceptionListItem[] = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        type: '  =HYPERLINK("https://example.test","open")',
        status: "open",
        severity: "high",
        sources: ["stripe"],
        confidence: "high",
        assignee: "unassigned",
        amountMinor: "-12500",
        currency: "USD",
        createdAt: "2026-07-27T12:00:00.000Z",
        updatedAt: "2026-07-27T12:01:00.000Z",
      },
    ];

    const csv = serializeExceptionExport(items);

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain(
      '"exception_id","type","status","severity","sources","confidence","assignee","amount_minor","currency","created_at","updated_at"\r\n',
    );
    expect(csv).toContain(
      '"\'  =HYPERLINK(""https://example.test"",""open"")","open","high","stripe","high","unassigned","\'-12500"',
    );
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(Buffer.byteLength(csv, "utf8")).toBeGreaterThan(0);
  });

  it("rejects a prepared payload above the fixed byte ceiling", () => {
    const oversized: ExceptionListItem = {
      id: "00000000-0000-4000-8000-000000000001",
      type: "x".repeat(MAX_EXCEPTION_EXPORT_BYTES),
      status: "open",
      severity: "high",
      sources: [],
      confidence: "unclassified",
      assignee: "unassigned",
      createdAt: "2026-07-27T12:00:00.000Z",
      updatedAt: "2026-07-27T12:01:00.000Z",
    };

    expect(() => serializeExceptionExport([oversized])).toThrow(RepositoryExportLimitError);
  });
});
