import { headers } from "next/headers";
import { getToken } from "next-auth/jwt";
import { NextRequest } from "next/server";

import { readOidcEnvironment } from "./oidc-environment";
import { oidcSessionIdentity, sessionRevocationStore } from "./session-revocation";
import {
  readConfiguredOrigin,
  readSessionRevocationConfiguration,
  readSessionSecret,
} from "./server-environment";

export async function readServerSessionToken() {
  const request = new NextRequest(readConfiguredOrigin("NEXTAUTH_URL", "http://localhost:3000"), {
    headers: await headers(),
  });
  return readRequestSessionToken(request);
}

export async function readRequestSessionToken(request: NextRequest) {
  let token;
  try {
    token = await getToken({
      req: request,
      secret: readSessionSecret(),
      cookieName:
        process.env.NODE_ENV === "production"
          ? "__Secure-reconai.session-token"
          : "reconai.session-token",
    });
  } catch {
    return null;
  }
  if (!token) return null;

  const oidc = readOidcEnvironment();
  const identity = oidcSessionIdentity(token, oidc.issuer);
  if (!identity) return null;
  try {
    const store = sessionRevocationStore(readSessionRevocationConfiguration());
    return (await store.isRevoked(identity)) ? null : token;
  } catch {
    return null;
  }
}
