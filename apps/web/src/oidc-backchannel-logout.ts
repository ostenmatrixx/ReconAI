import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

import { readBoundedUrlEncodedForm } from "./bounded-form";
import { readBoundedResponseBytes } from "./bounded-response";
import type { OidcSigningAlgorithm } from "./oidc-environment";
import {
  logoutTokenClockToleranceSeconds,
  logoutTokenMaximumAgeSeconds,
  type OidcLogoutEvent,
  type SessionRevocationStore,
} from "./session-revocation";
import { privateResponseHeaders } from "./server-environment";

const backchannelLogoutEvent = "http://schemas.openid.net/event/backchannel-logout";
const maximumLogoutRequestBytes = 36 * 1024;
const maximumJwksResponseBytes = 256 * 1024;
const opaqueIdentifier = z.string().min(1).max(255).refine(withoutControlCharacters);
const logoutClaimsSchema = z
  .object({
    iat: z.number().int().positive(),
    jti: opaqueIdentifier,
    sub: opaqueIdentifier.optional(),
    sid: opaqueIdentifier.optional(),
    events: z
      .record(z.string().min(1).max(255), z.unknown())
      .refine((value) => Object.keys(value).length <= 10),
  })
  .loose();

export interface OidcBackchannelLogoutConfiguration {
  readonly issuer: string;
  readonly clientId: string;
  readonly signingAlgorithm: OidcSigningAlgorithm;
}

export interface BackchannelLogoutDependencies {
  readonly keyResolver: JWTVerifyGetKey;
  readonly now?: () => number;
  readonly onFailure?: (
    classification: "INVALID_LOGOUT_REQUEST" | "REVOCATION_STORE_UNAVAILABLE",
  ) => void;
}

const remoteKeyResolvers = new Map<string, JWTVerifyGetKey>();

export function oidcLogoutKeyResolver(
  configuration: OidcBackchannelLogoutConfiguration,
): JWTVerifyGetKey {
  const jwksUrl = keycloakJwksUrl(configuration.issuer);
  const cacheKey = `${jwksUrl.toString()}\0${configuration.signingAlgorithm}`;
  const existing = remoteKeyResolvers.get(cacheKey);
  if (existing) return existing;

  const resolver = createRemoteJWKSet(jwksUrl, {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60 * 1000,
    [customFetch]: async (requestedUrl, options) => {
      if (requestedUrl !== jwksUrl.toString()) {
        throw new Error("OIDC JWKS request escaped the configured endpoint");
      }
      const response = await fetch(requestedUrl, {
        method: "GET",
        headers: options.headers,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: options.signal,
      });
      const body = await readBoundedResponseBytes(response, maximumJwksResponseBytes);
      const responseBody = new ArrayBuffer(body.byteLength);
      new Uint8Array(responseBody).set(body);
      return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
  remoteKeyResolvers.set(cacheKey, resolver);
  return resolver;
}

export async function validateOidcLogoutToken(
  logoutToken: string,
  configuration: OidcBackchannelLogoutConfiguration,
  dependencies: Pick<BackchannelLogoutDependencies, "keyResolver" | "now">,
): Promise<OidcLogoutEvent> {
  if (logoutToken.length === 0 || logoutToken.length > 32_768) {
    throw new Error("logout token is outside the permitted bounds");
  }
  const now = dependencies.now?.() ?? Date.now();
  const { payload, protectedHeader } = await jwtVerify(logoutToken, dependencies.keyResolver, {
    issuer: configuration.issuer,
    audience: configuration.clientId,
    algorithms: [configuration.signingAlgorithm],
    maxTokenAge: logoutTokenMaximumAgeSeconds,
    clockTolerance: logoutTokenClockToleranceSeconds,
    requiredClaims: ["iat", "jti", "events"],
    currentDate: new Date(now),
  });
  if (protectedHeader.typ !== undefined && protectedHeader.typ !== "logout+jwt") {
    throw new Error("logout token type is invalid");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "nonce")) {
    throw new Error("logout token contains a prohibited nonce");
  }
  if (
    (payload.azp !== undefined && payload.azp !== configuration.clientId) ||
    (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== configuration.clientId)
  ) {
    throw new Error("logout token authorized party is invalid");
  }

  const claims = logoutClaimsSchema.parse(payload);
  if (!claims.sub && !claims.sid) {
    throw new Error("logout token has no session locator");
  }
  const event = claims.events[backchannelLogoutEvent];
  if (!isJsonObject(event)) {
    throw new Error("logout token has no back-channel logout event");
  }

  return {
    issuer: configuration.issuer,
    ...(claims.sub ? { subject: claims.sub } : {}),
    ...(claims.sid ? { sessionId: claims.sid } : {}),
    issuedAt: claims.iat,
    jwtId: claims.jti,
  };
}

export async function handleOidcBackchannelLogout(
  request: Request,
  configuration: OidcBackchannelLogoutConfiguration,
  store: SessionRevocationStore,
  dependencies: BackchannelLogoutDependencies,
): Promise<Response> {
  let event: OidcLogoutEvent;
  try {
    const logoutToken = await readOidcLogoutToken(request);
    event = await validateOidcLogoutToken(logoutToken, configuration, dependencies);
  } catch {
    dependencies.onFailure?.("INVALID_LOGOUT_REQUEST");
    return logoutFailure();
  }

  try {
    await store.recordLogout(event);
  } catch {
    dependencies.onFailure?.("REVOCATION_STORE_UNAVAILABLE");
    return logoutFailure();
  }
  return new Response(null, { status: 200, headers: privateResponseHeaders });
}

export function keycloakJwksUrl(issuer: string): URL {
  const issuerUrl = new URL(issuer.endsWith("/") ? issuer : `${issuer}/`);
  if (
    !["http:", "https:"].includes(issuerUrl.protocol) ||
    issuerUrl.username ||
    issuerUrl.password ||
    issuerUrl.search ||
    issuerUrl.hash
  ) {
    throw new Error("OIDC issuer is invalid");
  }
  return new URL("protocol/openid-connect/certs", issuerUrl);
}

async function readOidcLogoutToken(request: Request): Promise<string> {
  const form = await readBoundedUrlEncodedForm(request, maximumLogoutRequestBytes);

  const entries = [...form.entries()];
  if (
    entries.length === 0 ||
    entries.length > 10 ||
    entries.some(
      ([name, value]) => !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(name) || value.length > 32_768,
    )
  ) {
    throw new Error("logout request parameters are invalid");
  }
  const logoutTokens = form.getAll("logout_token");
  if (logoutTokens.length !== 1 || !logoutTokens[0]) {
    throw new Error("logout request must contain one logout token");
  }
  return logoutTokens[0];
}

function logoutFailure(): Response {
  return new Response(null, { status: 400, headers: privateResponseHeaders });
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return false;
  }
  return true;
}
