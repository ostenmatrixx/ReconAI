import type { NextAuthOptions } from "next-auth";
import KeycloakProvider from "next-auth/providers/keycloak";

import { readOidcEnvironment } from "./oidc-environment";
import { exposeOidcSessionStatus, updateOidcJwt } from "./oidc-session";
import {
  enforceOidcSessionRevocation,
  oidcSessionMaximumAgeSeconds,
  sessionRevocationStore,
} from "./session-revocation";
import { readConfiguredOrigin, readSessionRevocationConfiguration } from "./server-environment";

const environment = readOidcEnvironment({ allowProductionBuild: true });
const sessionRevocationConfiguration = readSessionRevocationConfiguration({
  allowProductionBuild: true,
});

export function readFederatedLogoutConfiguration() {
  const applicationOrigin = readConfiguredOrigin("NEXTAUTH_URL", "http://localhost:3000");

  return {
    issuer: environment.issuer,
    clientId: environment.clientId,
    applicationOrigin,
    sessionSecret: environment.sessionSecret,
    sessionCookieName:
      process.env.NODE_ENV === "production"
        ? "__Secure-reconai.session-token"
        : "reconai.session-token",
    csrfCookieName:
      new URL(applicationOrigin).protocol === "https:"
        ? "__Host-next-auth.csrf-token"
        : "next-auth.csrf-token",
    secureSessionCookie: process.env.NODE_ENV === "production",
  } as const;
}

export const authOptions: NextAuthOptions = {
  secret: environment.sessionSecret,
  session: {
    strategy: "jwt",
    maxAge: oidcSessionMaximumAgeSeconds,
    updateAge: 30 * 60,
  },
  providers: [
    KeycloakProvider({
      issuer: environment.issuer,
      clientId: environment.clientId,
      clientSecret: environment.clientSecret,
      authorization: {
        params: {
          scope: "openid email profile",
          ...(environment.authenticationContextValues
            ? { acr_values: environment.authenticationContextValues }
            : {}),
        },
      },
      client: { id_token_signed_response_alg: environment.signingAlgorithm },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      const updated = await updateOidcJwt(token, account, environment);
      return enforceOidcSessionRevocation(
        updated,
        environment.issuer,
        sessionRevocationStore(sessionRevocationConfiguration),
      );
    },
    session({ session, token }) {
      // Provider tokens intentionally stay in the encrypted HttpOnly session token and never enter
      // the browser-readable session response.
      return exposeOidcSessionStatus(session, token);
    },
  },
  pages: {
    signIn: "/",
    error: "/?auth=error",
  },
  cookies: {
    sessionToken: {
      name:
        process.env.NODE_ENV === "production"
          ? "__Secure-reconai.session-token"
          : "reconai.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
  },
};
