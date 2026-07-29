import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { readBoundedJson, RequestBodyError } from "../../../../../bounded-json";
import { readBoundedResponseBytes } from "../../../../../bounded-response";
import {
  issueOrganizationContext,
  organizationContextCookieMaxAge,
  organizationContextCookieName,
} from "../../../../../organization-context";
import {
  privateResponseHeaders,
  readConfiguredOrigin,
  readSessionSecret,
} from "../../../../../server-environment";
import { readRequestSessionToken } from "../../../../../server-session";
import { readAllowlistedApiError, type ApiErrorPolicy } from "../../../../../upstream-api-error";

const AcceptInvitationSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict();
const maximumInvitationAcceptanceResponseBytes = 64 * 1024;
const AcceptedInvitationResponseSchema = z
  .object({
    data: z
      .object({
        organizationId: z.uuid(),
        invitationId: z.uuid(),
        membershipId: z.uuid(),
        userId: z.uuid(),
        role: z.enum(["owner", "administrator", "analyst", "reviewer", "auditor"]),
      })
      .strict(),
    meta: z.object({ correlationId: z.uuid() }).strict(),
  })
  .strict();
const invitationAcceptanceErrorPolicy = {
  AUTHENTICATION_REQUIRED: {
    status: 401,
    message: "Sign in again to accept the invitation.",
  },
  VERIFIED_EMAIL_REQUIRED: {
    status: 403,
    message: "A provider-verified email is required.",
  },
  RESOURCE_NOT_FOUND: {
    status: 404,
    message: "The invitation is invalid or unavailable.",
  },
  RATE_LIMITED: {
    status: 429,
    message: "Too many invitation requests. Try again shortly.",
  },
} as const satisfies ApiErrorPolicy;

export async function POST(request: NextRequest) {
  const webOrigin = readConfiguredOrigin("WEB_ORIGIN", "http://localhost:3000");
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin !== webOrigin || (fetchSite && fetchSite !== "same-origin")) {
    return NextResponse.json(
      { code: "CSRF_ORIGIN_REJECTED" },
      { status: 403, headers: privateResponseHeaders },
    );
  }

  const session = await readRequestSessionToken(request);
  if (!session?.apiAccessToken || typeof session.sub !== "string") {
    return NextResponse.json(
      { code: "AUTHENTICATION_REQUIRED" },
      { status: 401, headers: privateResponseHeaders },
    );
  }
  if (
    typeof session.apiAccessTokenExpiresAt === "number" &&
    session.apiAccessTokenExpiresAt > 0 &&
    session.apiAccessTokenExpiresAt <= Math.floor(Date.now() / 1000)
  ) {
    return NextResponse.json(
      { code: "SESSION_REAUTHENTICATION_REQUIRED" },
      { status: 401, headers: privateResponseHeaders },
    );
  }

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
  const parsed = AcceptInvitationSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { code: "INVALID_INVITATION_TOKEN" },
      { status: 400, headers: privateResponseHeaders },
    );
  }

  const apiOrigin = readConfiguredOrigin("API_ORIGIN", "http://127.0.0.1:4000");
  try {
    const response = await fetch(new URL("/v1/invitations/accept", apiOrigin), {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.apiAccessToken}`,
        "content-type": "application/json",
        accept: "application/json",
        "x-request-id": crypto.randomUUID(),
      },
      body: JSON.stringify(parsed.data),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      const body = await readAllowlistedApiError(response, invitationAcceptanceErrorPolicy);
      return NextResponse.json(body, {
        status: response.status,
        headers: privateResponseHeaders,
      });
    }
    const body = await safeJsonResponse(response);
    const accepted = AcceptedInvitationResponseSchema.safeParse(body);
    if (!accepted.success || response.status !== 201) {
      return NextResponse.json(
        { code: "UPSTREAM_INVALID_RESPONSE" },
        { status: 502, headers: privateResponseHeaders },
      );
    }
    const result = NextResponse.json(accepted.data, {
      status: response.status,
      headers: privateResponseHeaders,
    });
    result.cookies.set(
      organizationContextCookieName(),
      issueOrganizationContext(accepted.data.data.organizationId, session.sub, readSessionSecret()),
      {
        httpOnly: true,
        maxAge: organizationContextCookieMaxAge(),
        path: "/",
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      },
    );
    return result;
  } catch {
    return NextResponse.json(
      { code: "UPSTREAM_UNAVAILABLE", message: "The invitation service is unavailable." },
      { status: 502, headers: privateResponseHeaders },
    );
  }
}

async function safeJsonResponse(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("upstream returned a non-JSON response");
  }
  const bytes = await readBoundedResponseBytes(response, maximumInvitationAcceptanceResponseBytes);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}
