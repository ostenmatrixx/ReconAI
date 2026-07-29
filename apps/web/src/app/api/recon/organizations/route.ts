import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { readBoundedJson, RequestBodyError } from "../../../../bounded-json";
import {
  createAuthorizedOrganization,
  issueOrganizationContext,
  organizationContextCookieMaxAge,
  organizationContextCookieName,
  OrganizationDirectoryError,
} from "../../../../organization-context";
import {
  privateResponseHeaders,
  readConfiguredOrigin,
  readSessionSecret,
} from "../../../../server-environment";
import { readRequestSessionToken } from "../../../../server-session";

const organizationBootstrapSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    businessTimeZone: z.string().trim().min(1).max(100).refine(isIanaTimeZone),
    idempotencyKey: z.uuid(),
  })
  .strict();

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

  const token = await readRequestSessionToken(request);
  if (!token?.apiAccessToken || typeof token.sub !== "string") {
    return NextResponse.json(
      { code: "AUTHENTICATION_REQUIRED" },
      { status: 401, headers: privateResponseHeaders },
    );
  }
  if (
    typeof token.apiAccessTokenExpiresAt === "number" &&
    token.apiAccessTokenExpiresAt > 0 &&
    token.apiAccessTokenExpiresAt <= Math.floor(Date.now() / 1000)
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
  const parsed = organizationBootstrapSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { code: "INVALID_ORGANIZATION_BOOTSTRAP" },
      { status: 400, headers: privateResponseHeaders },
    );
  }

  try {
    const result = await createAuthorizedOrganization(token.apiAccessToken, parsed.data);
    const response = NextResponse.json(result, {
      status: result.meta.replayed ? 200 : 201,
      headers: privateResponseHeaders,
    });
    response.cookies.set(
      organizationContextCookieName(),
      issueOrganizationContext(result.data.id, token.sub, readSessionSecret()),
      {
        httpOnly: true,
        maxAge: organizationContextCookieMaxAge(),
        path: "/",
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      },
    );
    return response;
  } catch (error) {
    const upstreamStatus = error instanceof OrganizationDirectoryError ? error.status : undefined;
    const status =
      upstreamStatus === 400 || upstreamStatus === 403 || upstreamStatus === 409
        ? upstreamStatus
        : upstreamStatus === 401
          ? 401
          : 502;
    const code =
      status === 400
        ? "INVALID_ORGANIZATION_BOOTSTRAP"
        : status === 403
          ? "VERIFIED_EMAIL_REQUIRED"
          : status === 409
            ? "ORGANIZATION_BOOTSTRAP_NOT_AVAILABLE"
            : status === 401
              ? "AUTHENTICATION_REQUIRED"
              : "UPSTREAM_UNAVAILABLE";
    return NextResponse.json({ code }, { status, headers: privateResponseHeaders });
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
