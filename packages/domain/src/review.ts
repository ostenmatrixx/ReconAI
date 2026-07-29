import { z } from "zod";

import type { OrganizationId, UserId } from "./tenancy.js";

export const ExceptionStatusSchema = z.enum([
  "open",
  "assigned",
  "deferred",
  "proposed",
  "approved",
  "rejected",
  "superseded",
]);
export type ExceptionStatus = z.infer<typeof ExceptionStatusSchema>;

export type ReviewDecision = "approve" | "reject";

export interface ResolutionProposal {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly exceptionId: string;
  readonly version: number;
  readonly proposedBy: UserId | "system";
  readonly type: string;
  readonly reason: string;
  readonly evidenceRecordIds: readonly string[];
  readonly createdAt: string;
}

export interface Approval {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly actorId: UserId;
  readonly decision: ReviewDecision;
  readonly reason: string;
  readonly createdAt: string;
}

export interface DualApprovalPolicy {
  readonly enabled: boolean;
  readonly amountThresholdsMinor: Readonly<Record<string, string>>;
  readonly sensitiveResolutionTypes: readonly string[];
}

export const ResolutionConfidenceSchema = z.enum(["high", "low", "unclassified"]);
export type ResolutionConfidence = z.infer<typeof ResolutionConfidenceSchema>;

export interface ResolutionRisk {
  readonly severity: string;
  readonly proposalType: string;
  /**
   * Deterministic confidence in the rule-backed exception finding. This is not a probability or
   * model score. Unclassified evidence fails closed when dual control is enabled.
   */
  readonly confidence: ResolutionConfidence;
  readonly amountMinor?: bigint;
  readonly currency?: string;
}

export class ReviewPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReviewPolicyError";
  }
}

export function validateApproval(
  proposal: ResolutionProposal,
  approval: Approval,
  previousApprovals: readonly Approval[],
  requiredApprovals: 1 | 2,
): void {
  if (proposal.organizationId !== approval.organizationId) {
    throw new ReviewPolicyError("proposal and approval tenant do not match");
  }
  if (proposal.id !== approval.proposalId || proposal.version !== approval.proposalVersion) {
    throw new ReviewPolicyError("approval must target the current proposal version");
  }
  if (approval.reason.trim().length === 0) {
    throw new ReviewPolicyError("approval decision requires a reason");
  }
  if (proposal.proposedBy === approval.actorId) {
    throw new ReviewPolicyError("proposer cannot decide their own proposal");
  }
  if (previousApprovals.some((item) => item.actorId === approval.actorId)) {
    throw new ReviewPolicyError("the same reviewer cannot approve twice");
  }
  if (previousApprovals.some((item) => item.decision === "reject")) {
    throw new ReviewPolicyError("a rejected proposal cannot receive another decision");
  }
  if (previousApprovals.filter((item) => item.decision === "approve").length >= requiredApprovals) {
    throw new ReviewPolicyError("the proposal already has its required approvals");
  }
}

export function requiredApprovalsForResolution(
  policy: DualApprovalPolicy,
  risk: ResolutionRisk,
): 1 | 2 {
  if (!policy.enabled) return 1;
  if (risk.severity === "high") return 2;
  if (risk.confidence !== "high") return 2;
  if (policy.sensitiveResolutionTypes.includes(risk.proposalType)) return 2;
  if (risk.currency && risk.amountMinor !== undefined) {
    const threshold = policy.amountThresholdsMinor[risk.currency];
    if (threshold !== undefined) {
      const absoluteAmount = risk.amountMinor < 0n ? -risk.amountMinor : risk.amountMinor;
      if (absoluteAmount >= BigInt(threshold)) return 2;
    }
  }
  return 1;
}
