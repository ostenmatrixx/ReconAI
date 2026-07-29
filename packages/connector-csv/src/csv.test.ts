import { describe, expect, it } from "vitest";

import {
  DEFAULT_CSV_LIMITS,
  parseAccountingCsv,
  previewAccountingCsv,
  protectCsvFormula,
} from "./index.js";

const mapping = {
  externalId: "id",
  transactionReference: "reference",
  orderReference: "order",
  amount: "amount",
  currency: "currency",
  effectiveAt: "effective_at",
  entryType: "type",
} as const;

describe("accounting CSV", () => {
  it("previews a valid bounded row with a stable checksum", () => {
    const content = Buffer.from(
      [
        "id,reference,order,amount,currency,effective_at,type",
        "entry-1,refund-1,order-1,25.00,USD,2026-07-27T00:00:00.000Z,refund",
      ].join("\n"),
    );
    const preview = previewAccountingCsv(content, mapping);
    expect(preview.rows).toHaveLength(1);
    expect(preview.rowCount).toBe(1);
    expect(preview.validRowCount).toBe(1);
    expect(preview.invalidRowCount).toBe(0);
    expect(preview.errors).toEqual([]);
    expect(preview.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("reports invalid financial rows instead of guessing", () => {
    const content = Buffer.from(
      [
        "id,reference,order,amount,currency,effective_at,type",
        "entry-1,refund-1,order-1,1,234.00,USD,not-a-date,refund",
      ].join("\n"),
    );
    expect(() => previewAccountingCsv(content, mapping)).toThrow();
  });

  it("neutralizes spreadsheet formula prefixes on export", () => {
    for (const value of [
      "=2+2",
      "+cmd",
      "-1+2",
      "@SUM(A1)",
      "\tformula",
      "\rformula",
      "  =2+2",
      "\u00a0@SUM(A1)",
    ]) {
      expect(protectCsvFormula(value)).toBe(`'${value}`);
    }
    expect(protectCsvFormula("ordinary value")).toBe("ordinary value");
  });

  it("rejects invalid UTF-8 and duplicate headers", () => {
    expect(() => previewAccountingCsv(Uint8Array.from([0xc3, 0x28]), mapping)).toThrow();
    expect(() =>
      parseAccountingCsv(
        Buffer.from(
          [
            "id,id,order,amount,currency,effective_at,type",
            "entry-1,refund-1,order-1,25.00,USD,2026-07-27T00:00:00.000Z,refund",
          ].join("\n"),
        ),
        mapping,
      ),
    ).toThrow();
  });

  it("bounds preview rows without dropping processing rows", () => {
    const content = Buffer.from(
      [
        "id,reference,order,amount,currency,effective_at,type",
        ...Array.from(
          { length: DEFAULT_CSV_LIMITS.maximumPreviewRows + 2 },
          (_, index) =>
            `entry-${index.toString()},refund-${index.toString()},order-1,25.00,USD,2026-07-27T00:00:00.000Z,refund`,
        ),
      ].join("\n"),
    );
    const preview = previewAccountingCsv(content, mapping);
    expect(preview.rowCount).toBe(DEFAULT_CSV_LIMITS.maximumPreviewRows + 2);
    expect(preview.rows).toHaveLength(DEFAULT_CSV_LIMITS.maximumPreviewRows);
  });
});
