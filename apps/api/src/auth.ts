import { createHash, randomUUID } from "node:crypto";

import { insertTenantAuditEvent } from "@workspace/database";
import {
  InvitationEmailSchema,
  MembershipIdSchema,
  OrganizationIdSchema,
  RoleSchema,
  UserIdSchema,
  tenantContextFromMembership,
  type ActiveMembership,
  type MembershipId,
  type OrganizationId,
  type Role,
  type TenantContext,
} from "@workspace/domain";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Sql } from "postgres";
import { z } from "zod";

export interface VerifiedIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly groups?: readonly string[];
  readonly authenticationContext?: string;
}

export interface IdentityVerifier {
  verifyAuthorizationHeader(header: string | undefined): Promise<VerifiedIdentity>;
}

export class AuthenticationError extends Error {
  public constructor() {
    super("authentication required");
    this.name = "AuthenticationError";
  }
}

export class OidcIdentityVerifier implements IdentityVerifier {
  readonly #issuer: string;
  readonly #audience: string;
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;

  public constructor(issuer: string, audience: string) {
    this.#issuer = issuer.replace(/\/$/u, "");
    this.#audience = audience;
    this.#jwks = createRemoteJWKSet(new URL(`${this.#issuer}/protocol/openid-connect/certs`), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
    });
  }

  public async verifyAuthorizationHeader(header: string | undefined): Promise<VerifiedIdentity> {
    if (!header?.startsWith("Bearer ")) throw new AuthenticationError();
    const token = header.slice("Bearer ".length);
    if (token.length < 20 || token.length > 16_384) throw new AuthenticationError();
    try {
      const result = await jwtVerify(token, this.#jwks, {
        issuer: this.#issuer,
        audience: this.#audience,
        algorithms: ["RS256", "ES256"],
        clockTolerance: 5,
        maxTokenAge: "15m",
      });
      if (!result.payload.sub) throw new AuthenticationError();
      const verifiedEmail =
        result.payload.email_verified === true
          ? InvitationEmailSchema.safeParse(result.payload.email)
          : undefined;
      const groups = oidcStringArrayClaim(result.payload.groups, 100, 200);
      const authenticationContext = oidcStringClaim(result.payload.acr, 200);
      return {
        issuer: this.#issuer,
        subject: result.payload.sub,
        ...(verifiedEmail?.success ? { email: verifiedEmail.data } : {}),
        emailVerified: verifiedEmail?.success === true,
        ...(groups ? { groups } : {}),
        ...(authenticationContext ? { authenticationContext } : {}),
      };
    } catch {
      throw new AuthenticationError();
    }
  }
}

function oidcStringArrayClaim(
  value: unknown,
  maximumItems: number,
  maximumItemLength: number,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const parsed = z
    .array(z.string().min(1).max(maximumItemLength))
    .max(maximumItems)
    .safeParse(value);
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
    throw new AuthenticationError();
  }
  return Object.freeze([...parsed.data]);
}

function oidcStringClaim(value: unknown, maximumLength: number): string | undefined {
  if (value === undefined) return undefined;
  const parsed = z.string().min(1).max(maximumLength).safeParse(value);
  if (!parsed.success) throw new AuthenticationError();
  return parsed.data;
}

export interface MembershipDirectory {
  list(
    identity: VerifiedIdentity,
    options: OrganizationDirectoryOptions,
  ): Promise<OrganizationAccessPage>;
  resolve(
    identity: VerifiedIdentity,
    requestedOrganizationId: OrganizationId,
  ): Promise<TenantContext | undefined>;
}

export interface OrganizationAccess {
  readonly id: OrganizationId;
  readonly name: string;
  readonly membershipId: MembershipId;
  readonly role: Role;
}

export interface OrganizationDirectoryOptions {
  readonly limit: number;
  readonly search?: string;
  readonly organizationId?: OrganizationId;
  readonly cursor?: string;
}

export interface OrganizationAccessPage {
  readonly items: readonly OrganizationAccess[];
  readonly nextCursor?: string;
}

export interface OrganizationBootstrapRequest {
  readonly name: string;
  readonly businessTimeZone: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export type OrganizationBootstrapStatus =
  "created" | "replayed" | "not_eligible" | "identity_conflict" | "idempotency_conflict";

export interface OrganizationBootstrapResult {
  readonly status: OrganizationBootstrapStatus;
  readonly access?: OrganizationAccess;
  readonly businessTimeZone?: string;
}

export interface OrganizationBootstrapper {
  bootstrap(
    identity: VerifiedIdentity,
    request: OrganizationBootstrapRequest,
  ): Promise<OrganizationBootstrapResult>;
}

export class OrganizationDirectoryCursorError extends Error {
  public constructor() {
    super("organization directory cursor is invalid");
    this.name = "OrganizationDirectoryCursorError";
  }
}

const organizationDirectoryCursorSchema = z
  .object({
    version: z.literal(1),
    search: z.string().min(1).max(100).nullable(),
    afterName: z.string().min(1).max(200),
    afterId: z.uuid(),
  })
  .strict();
const organizationBootstrapStatusSchema = z.enum([
  "created",
  "replayed",
  "not_eligible",
  "identity_conflict",
  "idempotency_conflict",
]);

export class PostgresOrganizationBootstrapper implements OrganizationBootstrapper {
  public constructor(private readonly sql: Sql) {}

  public async bootstrap(
    identity: VerifiedIdentity,
    request: OrganizationBootstrapRequest,
  ): Promise<OrganizationBootstrapResult> {
    const email = identity.email;
    if (!identity.emailVerified || !email) {
      return { status: "identity_conflict" };
    }
    const inputSha256 = createHash("sha256")
      .update(
        JSON.stringify({
          businessTimeZone: request.businessTimeZone,
          name: request.name,
          schemaVersion: 1,
        }),
      )
      .digest("hex");
    const organizationId = randomUUID();
    const membershipId = randomUUID();
    const bootstrapRequestId = randomUUID();
    const newUserId = randomUUID();

    return this.sql.begin(async (transaction) => {
      const rows = await transaction`
        select
          bootstrap_status,
          organization_id,
          organization_name,
          business_time_zone,
          membership_id,
          user_id,
          membership_role
        from public.reconai_bootstrap_first_organization(
          ${identity.issuer},
          ${identity.subject},
          ${email},
          ${organizationId},
          ${membershipId},
          ${bootstrapRequestId},
          ${request.idempotencyKey},
          ${inputSha256},
          ${request.name},
          ${request.businessTimeZone},
          ${newUserId}
        )
      `;
      const row = rows[0];
      if (!row) throw new Error("organization bootstrap returned no outcome");
      const status = organizationBootstrapStatusSchema.parse(row["bootstrap_status"]);
      if (status !== "created" && status !== "replayed") return { status };

      const access: OrganizationAccess = {
        id: OrganizationIdSchema.parse(row["organization_id"]),
        name: organizationName(row["organization_name"]),
        membershipId: MembershipIdSchema.parse(row["membership_id"]),
        role: RoleSchema.parse(row["membership_role"]),
      };
      const businessTimeZone = organizationBusinessTimeZone(row["business_time_zone"]);
      const userId = UserIdSchema.parse(row["user_id"]);
      if (access.role !== "owner")
        throw new Error("organization bootstrap did not return an owner");

      if (status === "created") {
        await transaction`select set_config('app.organization_id', ${access.id}, true)`;
        await insertTenantAuditEvent(transaction, {
          organizationId: access.id,
          actorType: "user",
          actorId: userId,
          action: "organization.created",
          resourceType: "organization",
          resourceId: access.id,
          correlationId: request.correlationId,
          reason: "Initial organization created by verified owner",
          newValue: {
            businessTimeZone,
            name: access.name,
            ownerMembershipId: access.membershipId,
            status: "active",
          },
          versionContext: { organizationBootstrapSchemaVersion: 1 },
        });
      }

      return { status, access, businessTimeZone };
    });
  }
}

export class PostgresMembershipDirectory implements MembershipDirectory {
  public constructor(private readonly sql: Sql) {}

  public async list(
    identity: VerifiedIdentity,
    options: OrganizationDirectoryOptions,
  ): Promise<OrganizationAccessPage> {
    validateOrganizationDirectoryOptions(options);
    const cursor = options.cursor ? decodeOrganizationDirectoryCursor(options.cursor) : undefined;
    if (cursor && cursor.search !== (options.search ?? null)) {
      throw new OrganizationDirectoryCursorError();
    }
    const rows = await this.sql`
      select
        organization_id,
        organization_name,
        organization_sort_name,
        membership_id,
        membership_role
      from public.reconai_list_active_organization_page(
        ${identity.issuer},
        ${identity.subject},
        ${options.search ?? null},
        ${options.organizationId ?? null},
        ${cursor?.afterName ?? null},
        ${cursor?.afterId ?? null},
        ${options.limit + 1}
      )
    `;
    const parsed = rows.map((row) => ({
      id: OrganizationIdSchema.parse(row["organization_id"]),
      name: organizationName(row["organization_name"]),
      sortName: organizationSortName(row["organization_sort_name"]),
      membershipId: MembershipIdSchema.parse(row["membership_id"]),
      role: RoleSchema.parse(row["membership_role"]),
    }));
    const items = parsed
      .slice(0, options.limit)
      .map(({ sortName: _sortName, ...access }) => access);
    const last = parsed.at(options.limit - 1);
    return {
      items,
      ...(parsed.length > options.limit && last
        ? {
            nextCursor: encodeOrganizationDirectoryCursor({
              version: 1,
              search: options.search ?? null,
              afterName: last.sortName,
              afterId: last.id,
            }),
          }
        : {}),
    };
  }

  public async resolve(
    identity: VerifiedIdentity,
    requestedOrganizationId: OrganizationId,
  ): Promise<TenantContext | undefined> {
    const rows = await this.sql.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${requestedOrganizationId}, true)`;
      return transaction`
        select
          m.id as membership_id,
          m.organization_id,
          m.user_id,
          m.role,
          m.status
        from memberships m
        inner join users u on u.id = m.user_id
        where m.organization_id = ${requestedOrganizationId}
          and u.issuer = ${identity.issuer}
          and u.subject = ${identity.subject}
          and u.status = 'active'
          and m.status = 'active'
        limit 1
      `;
    });
    const row = rows[0];
    if (!row) return undefined;
    const membership: ActiveMembership = {
      id: MembershipIdSchema.parse(row["membership_id"]),
      organizationId: OrganizationIdSchema.parse(row["organization_id"]),
      userId: UserIdSchema.parse(row["user_id"]),
      role: RoleSchema.parse(row["role"]),
      status: "active",
    };
    return tenantContextFromMembership(membership);
  }
}

function organizationName(value: unknown): string {
  if (typeof value !== "string") throw new Error("organization name is invalid");
  const name = value.trim();
  if (name.length < 1 || name.length > 200) throw new Error("organization name is invalid");
  return name;
}

function organizationSortName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    throw new Error("organization sort name is invalid");
  }
  return value;
}

function organizationBusinessTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) {
    throw new Error("organization business time zone is invalid");
  }
  return value;
}

function validateOrganizationDirectoryOptions(options: OrganizationDirectoryOptions): void {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new TypeError("organization directory limit must be between 1 and 100");
  }
  if (
    options.search !== undefined &&
    (options.search !== options.search.trim() ||
      options.search.length < 1 ||
      options.search.length > 100 ||
      containsControlCharacter(options.search))
  ) {
    throw new TypeError("organization directory search is invalid");
  }
  if (options.organizationId && (options.search ?? options.cursor)) {
    throw new TypeError("exact organization lookup cannot be combined with search or cursor");
  }
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}

function encodeOrganizationDirectoryCursor(
  value: z.infer<typeof organizationDirectoryCursorSchema>,
): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeOrganizationDirectoryCursor(
  cursor: string,
): z.infer<typeof organizationDirectoryCursorSchema> {
  try {
    if (
      cursor.length < 1 ||
      cursor.length > 1024 ||
      !/^[A-Za-z0-9_-]+$/u.test(cursor) ||
      Buffer.from(cursor, "base64url").toString("base64url") !== cursor
    ) {
      throw new Error("invalid encoding");
    }
    const json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(cursor, "base64url"));
    return organizationDirectoryCursorSchema.parse(JSON.parse(json) as unknown);
  } catch {
    throw new OrganizationDirectoryCursorError();
  }
}
