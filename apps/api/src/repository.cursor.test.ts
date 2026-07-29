import { describe, expect, it } from "vitest";

import {
  RepositoryCursorError,
  decodeReconciliationRunArtifactCursor,
  decodeReconciliationRunInputCursor,
  decodeExceptionListCursor,
  encodeReconciliationRunArtifactCursor,
  encodeReconciliationRunInputCursor,
  encodeExceptionListCursor,
  type ExceptionListItem,
  type ExceptionListOptions,
} from "./repository.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const artifactId = "00000000-0000-4000-8000-000000000003";

const item: ExceptionListItem = {
  id: "00000000-0000-4000-8000-000000000010",
  type: "payment_without_order",
  status: "open",
  severity: "high",
  sources: ["stripe"],
  confidence: "high",
  assignee: "unassigned",
  createdAt: "2026-07-27T12:00:00.000Z",
  updatedAt: "2026-07-27T12:00:00.000Z",
};

const options: ExceptionListOptions = {
  status: "open",
  severity: "high",
  search: "Payment Without-Order",
  source: "stripe",
  amountCurrency: "USD",
  minimumAmountMinor: "10000",
  maximumAmountMinor: "20000",
  confidence: "high",
  assignee: "unassigned",
  age: "one_to_seven_days",
  limit: 50,
};
const asOf = "2026-07-29T12:00:00.000Z";

describe("exception list cursor", () => {
  it("round-trips a stable queue position across equivalent normalized filters", () => {
    const encoded = encodeExceptionListCursor(item, options, asOf);
    const decoded = decodeExceptionListCursor(encoded, {
      ...options,
      search: "payment_without_order",
    });

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decoded.filterHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(decoded).toMatchObject({
      version: 2,
      asOf,
      severityRank: 0,
      createdAt: item.createdAt,
      id: item.id,
    });
  });

  it("rejects reuse with a different filter set", () => {
    const encoded = encodeExceptionListCursor(item, options, asOf);

    expect(() => decodeExceptionListCursor(encoded, { ...options, severity: "medium" })).toThrow(
      RepositoryCursorError,
    );
    expect(() =>
      decodeExceptionListCursor(encoded, { ...options, minimumAmountMinor: "10001" }),
    ).toThrow(RepositoryCursorError);
    expect(() => decodeExceptionListCursor(encoded, { ...options, source: "shopify" })).toThrow(
      RepositoryCursorError,
    );
  });

  it.each(["not+base64", "a".repeat(1025), "e30"])(
    "rejects malformed or unbounded cursor input",
    (encoded) => {
      expect(() => decodeExceptionListCursor(encoded, options)).toThrow(RepositoryCursorError);
    },
  );
});

describe("reconciliation run artifact cursor", () => {
  it("round-trips one tenant, run, artifact type, and stable artifact identity", () => {
    const encoded = encodeReconciliationRunArtifactCursor(
      organizationId,
      runId,
      "match",
      artifactId,
    );
    const decoded = decodeReconciliationRunArtifactCursor(encoded, organizationId, runId, "match");

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decoded).toEqual({
      version: 1,
      organizationId,
      runId,
      type: "match",
      id: artifactId,
    });
  });

  it("rejects tenant, run, and artifact-type cursor replay", () => {
    const encoded = encodeReconciliationRunArtifactCursor(
      organizationId,
      runId,
      "match",
      artifactId,
    );

    expect(() =>
      decodeReconciliationRunArtifactCursor(
        encoded,
        "00000000-0000-4000-8000-000000000099",
        runId,
        "match",
      ),
    ).toThrow(RepositoryCursorError);
    expect(() =>
      decodeReconciliationRunArtifactCursor(
        encoded,
        organizationId,
        "00000000-0000-4000-8000-000000000099",
        "match",
      ),
    ).toThrow(RepositoryCursorError);
    expect(() =>
      decodeReconciliationRunArtifactCursor(encoded, organizationId, runId, "exception"),
    ).toThrow(RepositoryCursorError);
  });

  it.each(["not+base64", "a".repeat(1025), "e30"])(
    "rejects malformed or unbounded run-artifact cursor input",
    (encoded) => {
      expect(() =>
        decodeReconciliationRunArtifactCursor(encoded, organizationId, runId, "match"),
      ).toThrow(RepositoryCursorError);
    },
  );
});

describe("reconciliation run input cursor", () => {
  it("round-trips one tenant, run, and pinned input ordinal", () => {
    const encoded = encodeReconciliationRunInputCursor(organizationId, runId, 99);
    const decoded = decodeReconciliationRunInputCursor(encoded, organizationId, runId);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decoded).toEqual({
      version: 1,
      organizationId,
      runId,
      ordinal: 99,
    });
  });

  it("rejects tenant and run cursor replay", () => {
    const encoded = encodeReconciliationRunInputCursor(organizationId, runId, 99);

    expect(() =>
      decodeReconciliationRunInputCursor(encoded, "00000000-0000-4000-8000-000000000099", runId),
    ).toThrow(RepositoryCursorError);
    expect(() =>
      decodeReconciliationRunInputCursor(
        encoded,
        organizationId,
        "00000000-0000-4000-8000-000000000099",
      ),
    ).toThrow(RepositoryCursorError);
  });

  it.each(["not+base64", "a".repeat(1025), "e30"])(
    "rejects malformed or unbounded run-input cursor input",
    (encoded) => {
      expect(() => decodeReconciliationRunInputCursor(encoded, organizationId, runId)).toThrow(
        RepositoryCursorError,
      );
    },
  );
});
