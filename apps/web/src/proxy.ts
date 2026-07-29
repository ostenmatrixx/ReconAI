import { type NextRequest, NextResponse } from "next/server";

import { buildContentSecurityPolicy } from "./content-security-policy";

export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const isProduction = process.env.NODE_ENV === "production";
  const oidcIssuer =
    process.env["OIDC_ISSUER"] ?? "http://127.0.0.1:8080/realms/reconai-development";
  const policy = buildContentSecurityPolicy(nonce, isProduction, oidcIssuer);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
