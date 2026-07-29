import { describe, expect, it } from "vitest";

import { OrganizationIdSchema, UserIdSchema } from "./tenancy.js";
import { ReviewPolicyError, requiredApprovalsForResolution, validateApproval } from "./review.js";

const organizationId = OrganizationIdSchema.parse("00000000-0000-4000-8000-000000000001");
const proposer = UserIdSchema.parse("00000000-0000-4000-8000-000000000002");
const reviewer = UserIdSchema.parse("00000000-0000-4000-8000-000000000003");

describe("review policy", () => {
  const proposal = {
    id: "proposal",
    organizationId,
    exceptionId: "exception",
    version: 1,
    proposedBy: proposer,
    type: "investigate_source",
    reason: "Evidence is incomplete",
    evidenceRecordIds: ["record"],
    createdAt: "2026-07-27T00:00:00.000Z",
  } as const;

  it("accepts an independent, reasoned approval", () => {
    expect(() =>
      validateApproval(
        proposal,
        {
          id: "approval",
          organizationId,
          proposalId: proposal.id,
          proposalVersion: 1,
          actorId: reviewer,
          decision: "approve",
          reason: "Verified against the source evidence",
          createdAt: "2026-07-27T00:01:00.000Z",
        },
        [],
        2,
      ),
    ).not.toThrow();
  });

  it("rejects self-approval for every review policy", () => {
    expect(() =>
      validateApproval(
        proposal,
        {
          id: "approval",
          organizationId,
          proposalId: proposal.id,
          proposalVersion: 1,
          actorId: proposer,
          decision: "approve",
          reason: "Self approval",
          createdAt: "2026-07-27T00:01:00.000Z",
        },
        [],
        1,
      ),
    ).toThrow(ReviewPolicyError);
  });

  it("requires dual approval for high-severity, sensitive, or threshold-level resolutions", () => {
    const policy = {
      enabled: true,
      amountThresholdsMinor: { USD: "10000" },
      sensitiveResolutionTypes: ["write_off"],
    } as const;
    expect(
      requiredApprovalsForResolution(policy, {
        severity: "high",
        proposalType: "investigate",
        confidence: "high",
      }),
    ).toBe(2);
    expect(
      requiredApprovalsForResolution(policy, {
        severity: "low",
        proposalType: "write_off",
        confidence: "high",
      }),
    ).toBe(2);
    expect(
      requiredApprovalsForResolution(policy, {
        severity: "low",
        proposalType: "investigate",
        confidence: "high",
        amountMinor: -10_000n,
        currency: "USD",
      }),
    ).toBe(2);
    expect(
      requiredApprovalsForResolution(policy, {
        severity: "low",
        proposalType: "investigate",
        confidence: "high",
        amountMinor: 9_999n,
        currency: "USD",
      }),
    ).toBe(1);
    expect(
      requiredApprovalsForResolution(policy, {
        severity: "low",
        proposalType: "investigate",
        confidence: "low",
      }),
    ).toBe(2);
    expect(
      requiredApprovalsForResolution(policy, {
        severity: "low",
        proposalType: "investigate",
        confidence: "unclassified",
      }),
    ).toBe(2);
  });

  it("uses one independent reviewer when dual approval is disabled", () => {
    expect(
      requiredApprovalsForResolution(
        {
          enabled: false,
          amountThresholdsMinor: { USD: "1" },
          sensitiveResolutionTypes: ["write_off"],
        },
        {
          severity: "high",
          proposalType: "write_off",
          confidence: "unclassified",
          amountMinor: 100_000n,
          currency: "USD",
        },
      ),
    ).toBe(1);
  });
});
