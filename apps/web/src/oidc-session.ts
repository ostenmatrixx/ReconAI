import type { Account, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { decodeJwt } from "jose";
import { z } from "zod";

import { readBoundedJson } from "./bounded-json";

const accessTokenRefreshSkewSeconds = 60;
const maximumTokenResponseBytes = 64 * 1024;
const tokenRequestTimeoutMilliseconds = 5_000;

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1).max(32_768),
    expires_in: z.number().int().positive().max(86_400),
    refresh_token: z.string().min(1).max(32_768).optional(),
    id_token: z.string().min(1).max(32_768).optional(),
    token_type: z.string().max(32).optional(),
  })
  .loose();
const oidcIdentityClaimsSchema = z
  .object({
    iss: z.url(),
    sub: z.string().min(1).max(255),
    aud: z.union([z.string().min(1).max(255), z.array(z.string().min(1).max(255)).min(1).max(10)]),
    sid: z.string().min(1).max(255).optional(),
  })
  .loose();

export interface OidcRefreshConfiguration {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

interface OidcRefreshDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => number;
}

const defaultDependencies: OidcRefreshDependencies = {
  fetch: globalThis.fetch,
  now: Date.now,
};

export function exposeOidcSessionStatus(session: Session, token: JWT): Session {
  return {
    ...session,
    reauthenticationRequired: !token.apiAccessToken || token.providerTokenError !== undefined,
  };
}

export function oidcJwtNeedsRefresh(token: JWT, now = Date.now()): boolean {
  return (
    token.providerTokenError !== undefined ||
    !token.apiAccessToken ||
    typeof token.apiAccessTokenExpiresAt !== "number" ||
    token.apiAccessTokenExpiresAt <= Math.floor(now / 1_000) + accessTokenRefreshSkewSeconds
  );
}

export async function updateOidcJwt(
  token: JWT,
  account: Account | null,
  configuration: OidcRefreshConfiguration,
  dependencies: OidcRefreshDependencies = defaultDependencies,
): Promise<JWT> {
  if (account) {
    const signedInToken = { ...token };
    delete signedInToken.apiAccessToken;
    delete signedInToken.apiAccessTokenExpiresAt;
    delete signedInToken.apiRefreshToken;
    delete signedInToken.apiIdToken;
    delete signedInToken.apiOidcIssuer;
    delete signedInToken.apiOidcSubject;
    delete signedInToken.apiOidcSessionId;
    delete signedInToken.apiSessionStartedAt;
    delete signedInToken.providerTokenError;
    if (account.access_token) signedInToken.apiAccessToken = account.access_token;
    signedInToken.apiAccessTokenExpiresAt =
      typeof account.expires_at === "number" ? account.expires_at : 0;
    if (account.refresh_token) signedInToken.apiRefreshToken = account.refresh_token;
    if (account.id_token) signedInToken.apiIdToken = account.id_token;
    signedInToken.apiOidcIssuer = configuration.issuer;
    signedInToken.apiOidcSubject = account.providerAccountId;
    signedInToken.apiSessionStartedAt = Math.floor(dependencies.now() / 1_000);
    const sessionId = extractValidatedOidcSessionId(account, configuration);
    if (sessionId) signedInToken.apiOidcSessionId = sessionId;
    return signedInToken;
  }

  const nowMilliseconds = dependencies.now();
  const nowSeconds = Math.floor(nowMilliseconds / 1_000);
  if (!oidcJwtNeedsRefresh(token, nowMilliseconds)) return token;

  if (token.providerTokenError) return token;
  if (!token.apiRefreshToken) return failedRefresh(token, "MISSING_REFRESH_TOKEN");

  try {
    const response = await dependencies.fetch(tokenEndpoint(configuration.issuer), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        refresh_token: token.apiRefreshToken,
      }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(tokenRequestTimeoutMilliseconds),
    });
    if (!response.ok) return failedRefresh(token, "REFRESH_FAILED");

    const refreshed = tokenResponseSchema.parse(
      await readBoundedJson(response, maximumTokenResponseBytes),
    );
    if (refreshed.token_type && refreshed.token_type.toLocaleLowerCase("en-US") !== "bearer") {
      return failedRefresh(token, "REFRESH_FAILED");
    }

    const rotatedToken = {
      ...token,
      apiAccessToken: refreshed.access_token,
      apiAccessTokenExpiresAt: nowSeconds + refreshed.expires_in,
      apiRefreshToken: refreshed.refresh_token ?? token.apiRefreshToken,
    };
    if (refreshed.id_token) rotatedToken.apiIdToken = refreshed.id_token;
    delete rotatedToken.providerTokenError;
    return rotatedToken;
  } catch {
    return failedRefresh(token, "REFRESH_FAILED");
  }
}

function extractValidatedOidcSessionId(
  account: Account,
  configuration: OidcRefreshConfiguration,
): string | undefined {
  if (!account.id_token) return undefined;
  try {
    // NextAuth/openid-client has already verified this ID token. Re-checking the identity claims
    // here prevents an unrelated decoded token from supplying the opaque back-channel session ID.
    const claims = oidcIdentityClaimsSchema.parse(decodeJwt(account.id_token));
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      claims.iss !== configuration.issuer ||
      claims.sub !== account.providerAccountId ||
      !audiences.includes(configuration.clientId)
    ) {
      return undefined;
    }
    return claims.sid;
  } catch {
    return undefined;
  }
}

function tokenEndpoint(issuer: string): string {
  const issuerUrl = new URL(issuer.endsWith("/") ? issuer : `${issuer}/`);
  return new URL("protocol/openid-connect/token", issuerUrl).toString();
}

function failedRefresh(token: JWT, error: "MISSING_REFRESH_TOKEN" | "REFRESH_FAILED"): JWT {
  const failedToken = { ...token, providerTokenError: error };
  delete failedToken.apiAccessToken;
  delete failedToken.apiAccessTokenExpiresAt;
  return failedToken;
}
