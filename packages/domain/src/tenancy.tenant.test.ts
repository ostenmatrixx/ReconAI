import { describe, expect, it } from "vitest";

import {
  AuthorizationError,
  InvitationEmailSchema,
  MembershipPolicyError,
  MembershipIdSchema,
  OrganizationNameSchema,
  OrganizationIdSchema,
  PermissionSchema,
  UserIdSchema,
  authorizeTenantAction,
  rolePermissions,
  tenantContextFromMembership,
  validateInvitationRole,
  validateMembershipTransition,
} from "./tenancy.js";

describe("tenant authorization", () => {
  const organizationId = OrganizationIdSchema.parse("00000000-0000-4000-8000-000000000001");
  const otherOrganizationId = OrganizationIdSchema.parse("00000000-0000-4000-8000-000000000002");
  const context = tenantContextFromMembership({
    id: MembershipIdSchema.parse("00000000-0000-4000-8000-000000000003"),
    organizationId,
    userId: UserIdSchema.parse("00000000-0000-4000-8000-000000000004"),
    role: "analyst",
    status: "active",
  });

  it("permits an explicit role permission within its tenant", () => {
    expect(() =>
      authorizeTenantAction(context, organizationId, "reconciliation:start"),
    ).not.toThrow();
  });

  it("keeps tenant support administration explicit and out of non-owner roles", () => {
    expect(rolePermissions.owner.has("support:manage")).toBe(true);
    for (const role of ["administrator", "analyst", "reviewer", "auditor"] as const) {
      expect(rolePermissions[role].has("support:manage"), role).toBe(false);
    }
    expect([...rolePermissions.owner].sort()).toEqual([...PermissionSchema.options].sort());
    expect(PermissionSchema.safeParse("support:access").success).toBe(false);
    expect(() =>
      tenantContextFromMembership({
        id: context.membershipId,
        organizationId,
        userId: context.actorId,
        role: "administrator",
        status: "active",
        explicitPermissions: ["support:manage"],
      }),
    ).toThrow(AuthorizationError);
  });

  it("returns the same authorization error for a foreign tenant or missing permission", () => {
    expect(() =>
      authorizeTenantAction(context, otherOrganizationId, "reconciliation:start"),
    ).toThrow(AuthorizationError);
    expect(() => authorizeTenantAction(context, organizationId, "members:manage")).toThrow(
      AuthorizationError,
    );
  });

  it("prevents self-mutation, owner escalation, and last-owner lockout", () => {
    const base = {
      actorMembershipId: context.membershipId,
      targetMembershipId: "00000000-0000-4000-8000-000000000099",
      targetRole: "analyst" as const,
      targetStatus: "active" as const,
      nextRole: "reviewer" as const,
      nextStatus: "active" as const,
      otherActiveOwnerCount: 1,
    };
    expect(() =>
      validateMembershipTransition({
        ...base,
        actorRole: "administrator",
        targetMembershipId: context.membershipId,
      }),
    ).toThrow(MembershipPolicyError);
    expect(() =>
      validateMembershipTransition({
        ...base,
        actorRole: "administrator",
        nextRole: "owner",
      }),
    ).toThrow(MembershipPolicyError);
    expect(() =>
      validateMembershipTransition({
        ...base,
        actorRole: "owner",
        targetRole: "owner",
        nextRole: "reviewer",
        otherActiveOwnerCount: 0,
      }),
    ).toThrow(MembershipPolicyError);
  });

  it("allows an owner to reassign another member while retaining an active owner", () => {
    expect(() =>
      validateMembershipTransition({
        actorMembershipId: context.membershipId,
        actorRole: "owner",
        targetMembershipId: "00000000-0000-4000-8000-000000000099",
        targetRole: "analyst",
        targetStatus: "active",
        nextRole: "reviewer",
        nextStatus: "active",
        otherActiveOwnerCount: 1,
      }),
    ).not.toThrow();
  });

  it("limits owner invitations to an existing owner", () => {
    expect(() => validateInvitationRole("administrator", "owner")).toThrow(MembershipPolicyError);
    expect(() => validateInvitationRole("administrator", "reviewer")).not.toThrow();
    expect(() => validateInvitationRole("owner", "owner")).not.toThrow();
  });

  it("normalizes invitation email identity and rejects malformed addresses", () => {
    expect(InvitationEmailSchema.parse(" Reviewer@Example.Test ")).toBe("reviewer@example.test");
    expect(() => InvitationEmailSchema.parse("not-an-email")).toThrow();
    expect(() => InvitationEmailSchema.parse(`${"a".repeat(310)}@example.test`)).toThrow();
  });

  it("normalizes bounded organization names and rejects control characters", () => {
    expect(OrganizationNameSchema.parse("  North Operations  ")).toBe("North Operations");
    expect(() => OrganizationNameSchema.parse("")).toThrow();
    expect(() => OrganizationNameSchema.parse("North\nOperations")).toThrow();
    expect(() => OrganizationNameSchema.parse("a".repeat(201))).toThrow();
  });
});
