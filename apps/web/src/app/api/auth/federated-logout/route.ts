import { getToken } from "next-auth/jwt";
import { NextResponse, type NextRequest } from "next/server";

import { readFederatedLogoutConfiguration } from "../../../../auth";
import {
  buildProviderLogoutUrl,
  readLogoutCsrfToken,
  sessionCookieNamesToClear,
  verifyNextAuthCsrfToken,
} from "../../../../federated-logout";
import { organizationContextCookieName } from "../../../../organization-context";
import { privateResponseHeaders } from "../../../../server-environment";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const configuration = readFederatedLogoutConfiguration();
  if (request.headers.get("origin") !== configuration.applicationOrigin) {
    return forbiddenResponse();
  }

  const csrfToken = await readLogoutCsrfToken(request);
  const csrfCookie = request.cookies.get(configuration.csrfCookieName)?.value;
  if (!verifyNextAuthCsrfToken(csrfCookie, csrfToken, configuration.sessionSecret)) {
    return forbiddenResponse();
  }

  let idToken: string | undefined;
  try {
    const token = await getToken({
      req: request,
      secret: configuration.sessionSecret,
      cookieName: configuration.sessionCookieName,
    });
    idToken = typeof token?.apiIdToken === "string" ? token.apiIdToken : undefined;
  } catch {
    // A malformed or undecryptable session still receives complete local cleanup below.
  }

  let destination = new URL("/", configuration.applicationOrigin);
  if (idToken) {
    try {
      destination = buildProviderLogoutUrl(configuration, idToken);
    } catch {
      // Invalid provider state must not prevent local logout or select a client-controlled URL.
    }
  }

  const response = NextResponse.redirect(destination, 303);
  for (const [name, value] of Object.entries(privateResponseHeaders)) {
    response.headers.set(name, value);
  }
  response.headers.set("Referrer-Policy", "no-referrer");

  const cookieNames = sessionCookieNamesToClear(
    request.cookies.getAll().map(({ name }) => name),
    configuration.sessionCookieName,
  );
  for (const name of cookieNames) {
    response.cookies.set(name, "", {
      expires: new Date(0),
      httpOnly: true,
      maxAge: 0,
      path: "/",
      sameSite: "lax",
      secure: configuration.secureSessionCookie,
    });
  }
  response.cookies.set(organizationContextCookieName(), "", {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax",
    secure: configuration.secureSessionCookie,
  });

  return response;
}

function forbiddenResponse() {
  return NextResponse.json(
    { error: "forbidden" },
    {
      status: 403,
      headers: privateResponseHeaders,
    },
  );
}
