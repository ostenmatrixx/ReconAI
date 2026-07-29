import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { readBoundedResponseBytes } from "./bounded-response";
import { readConfiguredOrigin } from "./server-environment";

const organizationIdSchema = z.uuid();
const organizationContextCookieVersion = "v1";
const organizationContextSignaturePattern = /^[A-Za-z0-9_-]{43}$/u;
const organizationDirectoryCursorPattern = /^[A-Za-z0-9_-]{1,1024}$/u;
const maximumOrganizationDirectoryBytes = 64 * 1024;
const organizationContextLifetimeSeconds = 8 * 60 * 60;

const organizationAccessSchema = z
  .object({
    id: organizationIdSchema,
    name: z.string().trim().min(1).max(200),
    membershipId: z.uuid(),
    role: z.enum(["owner", "administrator", "analyst", "reviewer", "auditor"]),
  })
  .strict();

const organizationDirectorySchema = z
  .object({
    data: z.array(organizationAccessSchema).max(100),
    meta: z
      .object({
        correlationId: z.uuid(),
        truncated: z.boolean(),
        maximumItems: z.literal(100),
        nextCursor: z.string().regex(organizationDirectoryCursorPattern).optional(),
      })
      .strict(),
  })
  .strict();
const organizationBootstrapResponseSchema = z
  .object({
    data: organizationAccessSchema
      .extend({
        businessTimeZone: z.string().trim().min(1).max(100),
      })
      .strict(),
    meta: z
      .object({
        correlationId: z.uuid(),
        replayed: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type OrganizationAccess = z.infer<typeof organizationAccessSchema>;
export type OrganizationDirectoryPage = z.infer<typeof organizationDirectorySchema>;
export type OrganizationBootstrapResponse = z.infer<typeof organizationBootstrapResponseSchema>;

export interface OrganizationDirectoryQuery {
  readonly limit?: number;
  readonly search?: string;
  readonly organizationId?: string;
  readonly cursor?: string;
}

export interface OrganizationBootstrapInput {
  readonly name: string;
  readonly businessTimeZone: string;
  readonly idempotencyKey: string;
}

const organizationBootstrapInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !containsControlCharacter(value)),
    businessTimeZone: z.string().trim().min(1).max(100).refine(isIanaTimeZone),
    idempotencyKey: z.uuid(),
  })
  .strict();

const organizationDirectoryQuerySchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    search: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((value) => !containsControlCharacter(value))
      .optional(),
    organizationId: organizationIdSchema.optional(),
    cursor: z.string().regex(organizationDirectoryCursorPattern).optional(),
  })
  .strict()
  .refine(
    (value) => !(value.organizationId && (value.search ?? value.cursor)),
    "exact organization lookup cannot be combined with search or cursor",
  );

interface OrganizationDirectoryDependencies {
  readonly fetch: typeof fetch;
  readonly apiOrigin: string;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}

export class OrganizationDirectoryError extends Error {
  public constructor(public readonly status?: number) {
    super("organization directory is unavailable");
    this.name = "OrganizationDirectoryError";
  }
}

export function organizationContextCookieName(): string {
  return process.env.NODE_ENV === "production"
    ? "__Secure-reconai.organization-context"
    : "reconai.organization-context";
}

export function organizationContextCookieMaxAge(): number {
  return organizationContextLifetimeSeconds;
}

export function issueOrganizationContext(
  organizationId: string,
  subject: string,
  secret: string,
): string {
  const parsedOrganizationId = organizationIdSchema.parse(organizationId);
  const signature = organizationContextSignature(parsedOrganizationId, subject, secret);
  return `${organizationContextCookieVersion}.${parsedOrganizationId}.${signature}`;
}

export function verifyOrganizationContext(
  cookieValue: string | undefined,
  subject: string,
  secret: string,
): string | undefined {
  if (!cookieValue || cookieValue.length > 128) return undefined;
  const [version, organizationId, signature, extra] = cookieValue.split(".");
  if (
    extra !== undefined ||
    version !== organizationContextCookieVersion ||
    !organizationId ||
    !signature ||
    !organizationIdSchema.safeParse(organizationId).success ||
    !organizationContextSignaturePattern.test(signature)
  ) {
    return undefined;
  }
  const expected = organizationContextSignature(organizationId, subject, secret);
  return safeEqual(signature, expected) ? organizationId : undefined;
}

export function resolveOrganizationContext(
  cookieValue: string | undefined,
  subject: string,
  secret: string,
): string | undefined {
  const selected = verifyOrganizationContext(cookieValue, subject, secret);
  if (selected) return selected;

  const developmentDefault = process.env["RECONAI_DEFAULT_ORGANIZATION_ID"];
  return process.env.NODE_ENV !== "production" &&
    developmentDefault &&
    organizationIdSchema.safeParse(developmentDefault).success
    ? developmentDefault
    : undefined;
}

export async function fetchAuthorizedOrganizations(
  accessToken: string,
  dependencies?: OrganizationDirectoryDependencies,
): Promise<OrganizationDirectoryPage> {
  return fetchAuthorizedOrganizationPage(accessToken, {}, dependencies);
}

export async function fetchAuthorizedOrganizationPage(
  accessToken: string,
  query: OrganizationDirectoryQuery,
  dependencies?: OrganizationDirectoryDependencies,
): Promise<OrganizationDirectoryPage> {
  if (accessToken.length < 1 || accessToken.length > 32_768) {
    throw new OrganizationDirectoryError(401);
  }
  const parsedQuery = organizationDirectoryQuerySchema.safeParse(query);
  if (!parsedQuery.success) throw new OrganizationDirectoryError(400);

  const requestDependencies = dependencies ?? {
    fetch: globalThis.fetch,
    apiOrigin: readConfiguredOrigin("API_ORIGIN", "http://127.0.0.1:4000"),
  };
  const endpoint = new URL("/v1/organizations", requestDependencies.apiOrigin);
  if (parsedQuery.data.limit !== undefined) {
    endpoint.searchParams.set("limit", String(parsedQuery.data.limit));
  }
  if (parsedQuery.data.search) endpoint.searchParams.set("search", parsedQuery.data.search);
  if (parsedQuery.data.organizationId) {
    endpoint.searchParams.set("organizationId", parsedQuery.data.organizationId);
  }
  if (parsedQuery.data.cursor) endpoint.searchParams.set("cursor", parsedQuery.data.cursor);
  let response: Response;
  try {
    response = await requestDependencies.fetch(endpoint, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "x-request-id": crypto.randomUUID(),
      },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new OrganizationDirectoryError();
  }

  if (!response.ok) throw new OrganizationDirectoryError(response.status);
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new OrganizationDirectoryError();
  }

  try {
    const bytes = await readBoundedResponseBytes(response, maximumOrganizationDirectoryBytes);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return organizationDirectorySchema.parse(JSON.parse(body) as unknown);
  } catch {
    throw new OrganizationDirectoryError();
  }
}

export async function createAuthorizedOrganization(
  accessToken: string,
  input: OrganizationBootstrapInput,
  dependencies?: OrganizationDirectoryDependencies,
): Promise<OrganizationBootstrapResponse> {
  if (accessToken.length < 1 || accessToken.length > 32_768) {
    throw new OrganizationDirectoryError(401);
  }
  const parsedInput = organizationBootstrapInputSchema.safeParse(input);
  if (!parsedInput.success) throw new OrganizationDirectoryError(400);
  const requestDependencies = dependencies ?? {
    fetch: globalThis.fetch,
    apiOrigin: readConfiguredOrigin("API_ORIGIN", "http://127.0.0.1:4000"),
  };
  let response: Response;
  try {
    response = await requestDependencies.fetch(
      new URL("/v1/organizations", requestDependencies.apiOrigin),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "x-request-id": crypto.randomUUID(),
        },
        body: JSON.stringify(parsedInput.data),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      },
    );
  } catch {
    throw new OrganizationDirectoryError();
  }

  if (!response.ok) throw new OrganizationDirectoryError(response.status);
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new OrganizationDirectoryError();
  }
  try {
    const bytes = await readBoundedResponseBytes(response, maximumOrganizationDirectoryBytes);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return organizationBootstrapResponseSchema.parse(JSON.parse(body) as unknown);
  } catch {
    throw new OrganizationDirectoryError();
  }
}

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function organizationContextSignature(
  organizationId: string,
  subject: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${organizationContextCookieVersion}\0${subject}\0${organizationId}`)
    .digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
