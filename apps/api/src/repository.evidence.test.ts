import type { RuleEvidence } from "@workspace/reconciliation";
import { describe, expect, it } from "vitest";

import { toBrowserRecordReferences, toDeterministicEvidenceView } from "./repository.js";

function currentEvidence(): RuleEvidence {
  const recordId = "00000000-0000-4000-8000-000000000011";
  return {
    ruleId: "payment-order",
    ruleVersion: "1.5.0",
    ruleSetVersion: "1.5.0",
    sourceRecordIds: [recordId],
    sourceRecordCount: 1,
    evidenceTruncated: false,
    sourceRecordVersions: [
      {
        id: recordId,
        version: 1,
        contentSha256: "a".repeat(64),
      },
    ],
    sourceValues: [{ providerAmount: "42.00" }],
    normalizedValues: [{ amountMinor: "4200", currency: "USD" }],
    toleranceMinor: "0",
    result: "pass",
    reasonCode: "PAYMENT_ORDER_MATCHED",
    evaluatedAt: "2026-07-29T00:00:00.000Z",
  };
}

describe("browser-safe deterministic evidence projection", () => {
  it("reconstructs only bounded operator evidence and pairs source with normalized values", () => {
    const source = currentEvidence();
    const view = toDeterministicEvidenceView(source);

    expect(view).toMatchObject({
      schemaVersion: "deterministic-evidence-view-v1",
      status: "available",
      ruleId: source.ruleId,
      ruleVersion: source.ruleVersion,
      ruleSetVersion: source.ruleSetVersion,
      result: source.result,
      reasonCode: source.reasonCode,
      comparisons: source.sourceValues.map((value, index) => ({
        source: value,
        normalized: source.normalizedValues[index],
      })),
    });
    expect(view).not.toHaveProperty("sourceRecordIds");
    expect(view).not.toHaveProperty("sourceRecordVersions");
  });

  it("returns one fixed unavailable state for malformed, expanded, or future evidence", () => {
    const unavailable = {
      schemaVersion: "deterministic-evidence-view-v1",
      status: "unavailable",
      reasonCode: "EVIDENCE_UNSUPPORTED_OR_MALFORMED",
    };
    expect(
      toDeterministicEvidenceView({
        ...currentEvidence(),
        credentialReference: "must-not-reach-the-browser",
      }),
    ).toEqual(unavailable);
    expect(toDeterministicEvidenceView({ sourceValues: "not-an-array" })).toEqual(unavailable);
    expect(JSON.stringify(unavailable)).not.toContain("credential");
  });

  it("accepts only a bounded UUID array as browser record references", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(toBrowserRecordReferences([id])).toEqual({
      values: [id],
      status: "available",
    });
    expect(toBrowserRecordReferences(["not-a-uuid"])).toEqual({
      values: [],
      status: "unavailable",
    });
    expect(toBrowserRecordReferences(Array.from({ length: 501 }, () => id))).toEqual({
      values: [],
      status: "unavailable",
    });
  });
});
