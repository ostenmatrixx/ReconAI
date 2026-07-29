import { completeSyntheticRecords, defaultPolicy, syntheticIds } from "@workspace/test-support";
import { describe, expect, it } from "vitest";

import { RuleEvidenceSchema, reconcile } from "./index.js";

function currentEvidence() {
  const result = reconcile({
    organizationId: syntheticIds.organization,
    policy: defaultPolicy,
    records: completeSyntheticRecords(),
  });
  const evidence = result.matches[0]?.evidence;
  if (!evidence) throw new Error("synthetic reconciliation did not create evidence");
  return evidence;
}

describe("deterministic evidence runtime contract", () => {
  it("accepts evidence emitted by the current engine", () => {
    expect(RuleEvidenceSchema.parse(currentEvidence())).toEqual(currentEvidence());
  });

  it("rejects unknown fields instead of forwarding future or injected content implicitly", () => {
    expect(
      RuleEvidenceSchema.safeParse({
        ...currentEvidence(),
        credentialReference: "must-not-cross-the-contract",
      }).success,
    ).toBe(false);
  });

  it("rejects mismatched comparison and record-version cardinality", () => {
    const evidence = currentEvidence();
    expect(
      RuleEvidenceSchema.safeParse({
        ...evidence,
        normalizedValues: [],
      }).success,
    ).toBe(false);
    expect(
      RuleEvidenceSchema.safeParse({
        ...evidence,
        sourceRecordIds: [...evidence.sourceRecordIds].reverse(),
      }).success,
    ).toBe(false);
  });

  it("rejects oversized comparison values and inconsistent candidate-search counts", () => {
    const evidence = currentEvidence();
    expect(
      RuleEvidenceSchema.safeParse({
        ...evidence,
        sourceValues: [{ value: "x".repeat(4_097) }],
        normalizedValues: [{ value: "bounded" }],
      }).success,
    ).toBe(false);
    expect(
      RuleEvidenceSchema.safeParse({
        ...evidence,
        candidateSearch: {
          eligibleCount: 2,
          evaluatedCount: 1,
          emittedCount: 1,
          evaluationLimit: 500,
          complete: true,
        },
      }).success,
    ).toBe(false);
  });

  it("accepts only accounting overflow bounds that match the selected evaluation mode", () => {
    const evidence = currentEvidence();
    for (const accountingCandidateSearch of [
      {
        eligibleCountLowerBound: 501,
        evaluationLimit: 500,
        complete: false,
      },
      {
        eligibleCountLowerBound: 51,
        evaluationLimit: 50,
        complete: false,
      },
    ] as const) {
      expect(
        RuleEvidenceSchema.safeParse({
          ...evidence,
          accountingCandidateSearch,
        }).success,
      ).toBe(true);
    }
    expect(
      RuleEvidenceSchema.safeParse({
        ...evidence,
        accountingCandidateSearch: {
          eligibleCountLowerBound: 51,
          evaluationLimit: 500,
          complete: false,
        },
      }).success,
    ).toBe(false);
  });
});
