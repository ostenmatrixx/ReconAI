import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { readBoundedJson, RequestBodyError } from "../../../../bounded-json";
import { readBoundedResponseBytes } from "../../../../bounded-response";
import { privateResponseHeaders, readConfiguredOrigin } from "../../../../server-environment";
import { readRequestSessionToken } from "../../../../server-session";
import { readAllowlistedApiError, type ApiErrorPolicy } from "../../../../upstream-api-error";

const uuid = z.uuid();
const createRequestSchema = z
  .object({
    action: z.literal("create_request"),
    requestedDurationMinutes: z.number().int().min(5).max(60),
  })
  .strict();
const requestSuccessSchema = z
  .object({
    data: z
      .object({
        requestCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
        requestExpiresAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
    meta: z.unknown().optional(),
  })
  .strict()
  .transform(({ data }) => ({ data }));
const optionalTimestamp = z.iso.datetime({ offset: true }).optional();
const boundedCount = z.number().int().min(0).max(2_147_483_647);
const diagnosticsSuccessSchema = z
  .object({
    data: z
      .object({
        schemaVersion: z.literal("support-diagnostics-v1"),
        generatedAt: z.iso.datetime({ offset: true }),
        grantExpiresAt: z.iso.datetime({ offset: true }),
        countsCapped: z.boolean(),
        connections: z
          .object({
            total: boundedCount,
            nonHealthy: boundedCount,
            latestSuccessfulSyncAt: optionalTimestamp,
          })
          .strict(),
        providerSyncs: z
          .object({
            active: boundedCount,
            failed: boundedCount,
            latestCompletedAt: optionalTimestamp,
          })
          .strict(),
        reconciliations: z
          .object({
            active: boundedCount,
            failedOrPartial: boundedCount,
            latestCompletedAt: optionalTimestamp,
          })
          .strict(),
        exceptions: z
          .object({
            unresolved: boundedCount,
            oldestUnresolvedAt: optionalTimestamp,
          })
          .strict(),
        outbox: z
          .object({
            unpublished: boundedCount,
            deadLettered: boundedCount,
            oldestUnpublishedAt: optionalTimestamp,
          })
          .strict(),
      })
      .strict(),
    meta: z.unknown().optional(),
  })
  .strict()
  .transform(({ data }) => ({ data }));
const maximumUpstreamJsonBytes = 64 * 1024;
const supportErrorPolicy = {
  AUTHENTICATION_REQUIRED: {
    status: 401,
    message: "Sign in again to use restricted support tools.",
  },
  RESOURCE_NOT_FOUND: {
    status: 404,
    message: "Restricted support access is unavailable.",
  },
  RATE_LIMITED: {
    status: 429,
    message: "Too many restricted support requests. Try again shortly.",
  },
} as const satisfies ApiErrorPolicy;

export async function POST(request: NextRequest) {
  const csrfFailure = rejectCrossSiteMutation(request);
  if (csrfFailure) return csrfFailure;

  const accessToken = await authenticatedAccessToken(request);
  if (!accessToken) return authenticationRequired();

  let raw: unknown;
  try {
    raw = await readBoundedJson(request);
  } catch (error) {
    const failure =
      error instanceof RequestBodyError ? error : new RequestBodyError("INVALID_JSON", 400);
    return NextResponse.json(
      { code: failure.code },
      { status: failure.status, headers: privateResponseHeaders },
    );
  }
  const parsed = createRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { code: "INVALID_SUPPORT_ACTION" },
      { status: 400, headers: privateResponseHeaders },
    );
  }

  return proxySupportRequest(
    "/v1/support/access-requests",
    accessToken,
    "POST",
    201,
    requestSuccessSchema,
    JSON.stringify({ requestedDurationMinutes: parsed.data.requestedDurationMinutes }),
  );
}

export async function GET(request: NextRequest) {
  const accessToken = await authenticatedAccessToken(request);
  if (!accessToken) return authenticationRequired();

  const organizationId = uuid.safeParse(request.nextUrl.searchParams.get("organizationId"));
  const grantId = uuid.safeParse(request.nextUrl.searchParams.get("grantId"));
  if (!organizationId.success || !grantId.success || request.nextUrl.searchParams.size !== 2) {
    return NextResponse.json(
      { code: "INVALID_SUPPORT_DIAGNOSTIC_QUERY" },
      { status: 400, headers: privateResponseHeaders },
    );
  }
  const query = new URLSearchParams({ grantId: grantId.data });
  return proxySupportRequest(
    `/v1/support/organizations/${organizationId.data}/diagnostics?${query.toString()}`,
    accessToken,
    "GET",
    200,
    diagnosticsSuccessSchema,
  );
}

function rejectCrossSiteMutation(request: NextRequest): NextResponse | undefined {
  const webOrigin = readConfiguredOrigin("WEB_ORIGIN", "http://localhost:3000");
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin === webOrigin && (!fetchSite || fetchSite === "same-origin")) return undefined;
  return NextResponse.json(
    { code: "CSRF_ORIGIN_REJECTED" },
    { status: 403, headers: privateResponseHeaders },
  );
}

async function authenticatedAccessToken(request: NextRequest): Promise<string | undefined> {
  const token = await readRequestSessionToken(request);
  if (!token?.apiAccessToken || typeof token.sub !== "string") return undefined;
  if (
    typeof token.apiAccessTokenExpiresAt === "number" &&
    token.apiAccessTokenExpiresAt > 0 &&
    token.apiAccessTokenExpiresAt <= Math.floor(Date.now() / 1000)
  ) {
    return undefined;
  }
  return token.apiAccessToken;
}

function authenticationRequired(): NextResponse {
  return NextResponse.json(
    { code: "AUTHENTICATION_REQUIRED" },
    { status: 401, headers: privateResponseHeaders },
  );
}

async function proxySupportRequest(
  endpoint: string,
  accessToken: string,
  method: "GET" | "POST",
  successStatus: 200 | 201,
  successSchema: z.ZodType,
  body?: string,
): Promise<NextResponse> {
  const apiOrigin = readConfiguredOrigin("API_ORIGIN", "http://127.0.0.1:4000");
  try {
    const response = await fetch(new URL(endpoint, apiOrigin), {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        "x-request-id": crypto.randomUUID(),
      },
      ...(body ? { body } : {}),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      const clientError = await readAllowlistedApiError(response, supportErrorPolicy);
      return NextResponse.json(clientError, {
        status: response.status,
        headers: privateResponseHeaders,
      });
    }
    if (response.status !== successStatus) {
      throw new Error("upstream returned an unexpected restricted support status");
    }
    const responseBody = await safeJsonResponse(response);
    const parsed = successSchema.safeParse(responseBody);
    if (!parsed.success) throw new Error("upstream returned an invalid support response");
    return NextResponse.json(parsed.data, {
      status: response.status,
      headers: privateResponseHeaders,
    });
  } catch {
    return NextResponse.json(
      { code: "UPSTREAM_UNAVAILABLE", message: "The support API is unavailable." },
      { status: 502, headers: privateResponseHeaders },
    );
  }
}

async function safeJsonResponse(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("upstream returned a non-JSON response");
  }
  const bytes = await readBoundedResponseBytes(response, maximumUpstreamJsonBytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("upstream returned invalid JSON");
  }
}
