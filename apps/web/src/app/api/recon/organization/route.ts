import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { readBoundedJson, RequestBodyError } from "../../../../bounded-json";
import {
  fetchAuthorizedOrganizationPage,
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

const selectionSchema = z.object({ organizationId: z.uuid() }).strict();

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

  const secret = readSessionSecret();
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
  const parsed = selectionSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { code: "INVALID_ORGANIZATION_SELECTION" },
      { status: 400, headers: privateResponseHeaders },
    );
  }

  try {
    const directory = await fetchAuthorizedOrganizationPage(token.apiAccessToken, {
      limit: 1,
      organizationId: parsed.data.organizationId,
    });
    const selected = directory.data.find(({ id }) => id === parsed.data.organizationId);
    if (!selected) {
      return NextResponse.json(
        { code: "ORGANIZATION_NOT_FOUND" },
        { status: 404, headers: privateResponseHeaders },
      );
    }

    const response = NextResponse.json(
      { data: selected },
      { status: 200, headers: privateResponseHeaders },
    );
    response.cookies.set(
      organizationContextCookieName(),
      issueOrganizationContext(selected.id, token.sub, secret),
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
    const status = error instanceof OrganizationDirectoryError && error.status === 401 ? 401 : 502;
    return NextResponse.json(
      { code: status === 401 ? "AUTHENTICATION_REQUIRED" : "UPSTREAM_UNAVAILABLE" },
      { status, headers: privateResponseHeaders },
    );
  }
}
