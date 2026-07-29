import { z } from "zod";

export const OrganizationIdSchema = z.uuid().brand<"OrganizationId">();
export const UserIdSchema = z.uuid().brand<"UserId">();
export const MembershipIdSchema = z.uuid().brand<"MembershipId">();
export const OrganizationNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      Array.from(value).every((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && codePoint >= 32 && (codePoint < 127 || codePoint > 159);
      }),
    "organization name cannot contain control characters",
  );
export const InvitationEmailSchema = z
  .preprocess((value) => (typeof value === "string" ? value.trim() : value), z.email().max(320))
  .transform((value) => value.toLocaleLowerCase("en-US"));

export type OrganizationId = z.infer<typeof OrganizationIdSchema>;
export type UserId = z.infer<typeof UserIdSchema>;
export type MembershipId = z.infer<typeof MembershipIdSchema>;

export const PermissionSchema = z.enum([
  "organization:manage",
  "members:manage",
  "connectors:manage",
  "reconciliation:start",
  "financial-records:view",
  "exceptions:review",
  "resolutions:approve",
  "data:export",
  "audit:view",
  "retention:manage",
  "support:manage",
]);

export type Permission = z.infer<typeof PermissionSchema>;

export const RoleSchema = z.enum(["owner", "administrator", "analyst", "reviewer", "auditor"]);
export type Role = z.infer<typeof RoleSchema>;

export const rolePermissions: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  // Keep this list explicit. A new permission must never flow to the most privileged tenant role
  // merely because it was added to the schema.
  owner: new Set([
    "organization:manage",
    "members:manage",
    "connectors:manage",
    "reconciliation:start",
    "financial-records:view",
    "exceptions:review",
    "resolutions:approve",
    "data:export",
    "audit:view",
    "retention:manage",
    "support:manage",
  ]),
  administrator: new Set([
    "organization:manage",
    "members:manage",
    "connectors:manage",
    "reconciliation:start",
    "financial-records:view",
    "exceptions:review",
    "data:export",
    "audit:view",
    "retention:manage",
  ]),
  analyst: new Set([
    "reconciliation:start",
    "financial-records:view",
    "exceptions:review",
    "audit:view",
  ]),
  reviewer: new Set([
    "financial-records:view",
    "exceptions:review",
    "resolutions:approve",
    "audit:view",
  ]),
  auditor: new Set(["financial-records:view", "audit:view"]),
};

export interface ActiveMembership {
  readonly id: MembershipId;
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly role: Role;
  readonly explicitPermissions?: readonly Permission[];
  readonly status: "active";
}

export interface TenantContext {
  readonly organizationId: OrganizationId;
  readonly membershipId: MembershipId;
  readonly actorId: UserId;
  readonly permissions: ReadonlySet<Permission>;
}

export class AuthorizationError extends Error {
  public constructor(message = "resource not found or action not permitted") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class MembershipPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MembershipPolicyError";
  }
}

export function validateMembershipTransition(input: {
  readonly actorMembershipId: string;
  readonly actorRole: Role;
  readonly targetMembershipId: string;
  readonly targetRole: Role;
  readonly targetStatus: "invited" | "active" | "deactivated";
  readonly nextRole: Role;
  readonly nextStatus: "active" | "deactivated";
  readonly otherActiveOwnerCount: number;
}): void {
  if (input.actorMembershipId === input.targetMembershipId) {
    throw new MembershipPolicyError("members cannot change their own role or status");
  }
  if (input.actorRole !== "owner" && (input.targetRole === "owner" || input.nextRole === "owner")) {
    throw new MembershipPolicyError("only an owner can change owner membership");
  }
  if (
    input.targetRole === "owner" &&
    input.targetStatus === "active" &&
    (input.nextRole !== "owner" || input.nextStatus !== "active") &&
    input.otherActiveOwnerCount < 1
  ) {
    throw new MembershipPolicyError("organization must retain an active owner");
  }
}

export function validateInvitationRole(actorRole: Role, invitedRole: Role): void {
  if (actorRole !== "owner" && invitedRole === "owner") {
    throw new MembershipPolicyError("only an owner can invite another owner");
  }
}

export function tenantContextFromMembership(membership: ActiveMembership): TenantContext {
  const permissions = new Set(rolePermissions[membership.role]);
  for (const permission of membership.explicitPermissions ?? []) {
    if (permission === "support:manage" && membership.role !== "owner") {
      throw new AuthorizationError();
    }
    permissions.add(permission);
  }
  return Object.freeze({
    organizationId: membership.organizationId,
    membershipId: membership.id,
    actorId: membership.userId,
    permissions,
  });
}

export function requirePermission(context: TenantContext, permission: Permission): void {
  if (!context.permissions.has(permission)) throw new AuthorizationError();
}

export function requireTenant(
  context: TenantContext,
  resourceOrganizationId: OrganizationId,
): void {
  if (context.organizationId !== resourceOrganizationId) throw new AuthorizationError();
}

export function authorizeTenantAction(
  context: TenantContext,
  resourceOrganizationId: OrganizationId,
  permission: Permission,
): void {
  requireTenant(context, resourceOrganizationId);
  requirePermission(context, permission);
}
