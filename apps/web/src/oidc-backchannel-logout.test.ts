import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  handleOidcBackchannelLogout,
  keycloakJwksUrl,
  oidcLogoutKeyResolver,
  validateOidcLogoutToken,
} from "./oidc-backchannel-logout";
import { InMemorySessionRevocationStore, type SessionRevocationStore } from "./session-revocation";

const issuer = "https://identity.example.test/realms/reconai";
const configuration = {
  issuer,
  clientId: "reconai-web",
  signingAlgorithm: "RS256",
} as const;
const keySecret = "synthetic-session-secret-material-over-thirty-two-characters";
const now = Date.parse("2026-07-28T12:00:00.000Z");
const nowSeconds = Math.floor(now / 1_000);
const logoutEvent = "http://schemas.openid.net/event/backchannel-logout";
let privateKey: CryptoKey;
let publicKey: CryptoKey;
let keyResolver: JWTVerifyGetKey;

beforeAll(async () => {
  ({ privateKey, publicKey } = await generateKeyPair("RS256"));
  keyResolver = async () => publicKey;
});

describe("OIDC back-channel logout", () => {
  it("validates a signed token, revokes sid, and treats replay as success", async () => {
    const store = new InMemorySessionRevocationStore(keySecret, "test", () => now);
    const token = await logoutToken({ sub: "subject-1", sid: "sid-1", jti: "logout-1" });
    const request = logoutRequest(token, { trace: "ignored-by-standard" });

    const first = await handleOidcBackchannelLogout(request, configuration, store, {
      keyResolver,
      now: () => now,
    });
    expect(first.status).toBe(200);
    await expect(
      store.isRevoked({
        issuer,
        subject: "subject-1",
        sessionId: "sid-1",
        startedAt: nowSeconds - 60,
      }),
    ).resolves.toBe(true);
    await expect(
      store.isRevoked({
        issuer,
        subject: "subject-1",
        sessionId: "sid-2",
        startedAt: nowSeconds - 60,
      }),
    ).resolves.toBe(false);

    const replay = await handleOidcBackchannelLogout(logoutRequest(token), configuration, store, {
      keyResolver,
      now: () => now,
    });
    expect(replay.status).toBe(200);
  });

  it("rejects wrong audience, stale tokens, nonce, and unsupported explicit type", async () => {
    const store = new InMemorySessionRevocationStore(keySecret, "test", () => now);
    const tokens = [
      await logoutToken({ sid: "sid-1", jti: "wrong-aud" }, { audience: "another-client" }),
      await logoutToken(
        { sid: "sid-1", jti: "ambiguous-aud" },
        { audience: [configuration.clientId, "another-client"] },
      ),
      await logoutToken({ sid: "sid-1", jti: "stale" }, { issuedAt: nowSeconds - 10 * 60 }),
      await logoutToken({ sid: "sid-1", jti: "nonce", nonce: "prohibited" }),
      await logoutToken({ sid: "sid-1", jti: "wrong-typ" }, { type: "JWT" }),
    ];

    for (const token of tokens) {
      const response = await handleOidcBackchannelLogout(
        logoutRequest(token),
        configuration,
        store,
        { keyResolver, now: () => now },
      );
      expect(response.status).toBe(400);
    }
  });

  it("requires the event and a sid or sub while accepting an omitted recommended typ", async () => {
    const withoutType = await logoutToken(
      { sub: "subject-1", jti: "without-type" },
      { type: null },
    );
    await expect(
      validateOidcLogoutToken(withoutType, configuration, {
        keyResolver,
        now: () => now,
      }),
    ).resolves.toMatchObject({ subject: "subject-1", jwtId: "without-type" });

    const withoutLocator = await logoutToken({ jti: "without-locator" });
    const withoutEvent = await logoutToken(
      { sid: "sid-1", jti: "without-event" },
      { includeEvent: false },
    );
    await expect(
      validateOidcLogoutToken(withoutLocator, configuration, {
        keyResolver,
        now: () => now,
      }),
    ).rejects.toThrow();
    await expect(
      validateOidcLogoutToken(withoutEvent, configuration, {
        keyResolver,
        now: () => now,
      }),
    ).rejects.toThrow();
  });

  it("returns the standard failure status when the distributed index is unavailable", async () => {
    const failures: string[] = [];
    const unavailable = {
      recordLogout: vi.fn().mockRejectedValue(new Error("synthetic Redis outage")),
      isRevoked: vi.fn(),
    } satisfies SessionRevocationStore;
    const response = await handleOidcBackchannelLogout(
      logoutRequest(await logoutToken({ sid: "sid-1", jti: "store-outage" })),
      configuration,
      unavailable,
      {
        keyResolver,
        now: () => now,
        onFailure: (classification) => failures.push(classification),
      },
    );

    expect(response.status).toBe(400);
    expect(failures).toEqual(["REVOCATION_STORE_UNAVAILABLE"]);
  });

  it("bounds and validates the form before cryptographic work", async () => {
    const verify = vi.fn<JWTVerifyGetKey>();
    const store = new InMemorySessionRevocationStore(keySecret);
    const wrongMediaType = new Request("https://app.example.test/api/auth/backchannel-logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logout_token: "x" }),
    });
    expect(
      (
        await handleOidcBackchannelLogout(wrongMediaType, configuration, store, {
          keyResolver: verify,
        })
      ).status,
    ).toBe(400);
    expect(verify).not.toHaveBeenCalled();
  });

  it("derives and fetches only the fixed, bounded Keycloak JWKS endpoint", async () => {
    const isolatedConfiguration = {
      ...configuration,
      issuer: "https://identity-jwks.example.test/realms/reconai",
    };
    const jwk = await exportJWK(publicKey);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ keys: [{ ...jwk, kid: "synthetic-key", alg: "RS256", use: "sig" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const resolver = oidcLogoutKeyResolver(isolatedConfiguration);
      const token = await logoutToken(
        { sid: "sid-1", jti: "remote-jwks" },
        { issuer: isolatedConfiguration.issuer, keyId: "synthetic-key" },
      );
      await expect(
        validateOidcLogoutToken(token, isolatedConfiguration, {
          keyResolver: resolver,
          now: () => now,
        }),
      ).resolves.toMatchObject({ sessionId: "sid-1" });

      const [url, request] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe(
        "https://identity-jwks.example.test/realms/reconai/protocol/openid-connect/certs",
      );
      expect(request).toMatchObject({
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("derives the documented Keycloak certificate endpoint without URL ambiguity", () => {
    expect(keycloakJwksUrl(issuer).toString()).toBe(
      "https://identity.example.test/realms/reconai/protocol/openid-connect/certs",
    );
    expect(() => keycloakJwksUrl("https://user:password@identity.example.test/realm")).toThrow();
  });
});

interface LogoutClaims {
  readonly sub?: string;
  readonly sid?: string;
  readonly jti: string;
  readonly nonce?: string;
}

interface TokenOverrides {
  readonly audience?: string | string[];
  readonly includeEvent?: boolean;
  readonly issuedAt?: number;
  readonly issuer?: string;
  readonly keyId?: string;
  readonly type?: string | null;
}

async function logoutToken(claims: LogoutClaims, overrides: TokenOverrides = {}): Promise<string> {
  const token = new SignJWT({
    ...(claims.sub ? { sub: claims.sub } : {}),
    ...(claims.sid ? { sid: claims.sid } : {}),
    ...(claims.nonce ? { nonce: claims.nonce } : {}),
    ...(overrides.includeEvent === false ? {} : { events: { [logoutEvent]: {} } }),
  })
    .setProtectedHeader({
      alg: "RS256",
      ...(overrides.type === null ? {} : { typ: overrides.type ?? "logout+jwt" }),
      kid: overrides.keyId ?? "test-key",
    })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? configuration.clientId)
    .setIssuedAt(overrides.issuedAt ?? nowSeconds)
    .setJti(claims.jti);
  return token.sign(privateKey);
}

function logoutRequest(token: string, extra: Record<string, string> = {}): Request {
  return new Request("https://app.example.test/api/auth/backchannel-logout", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ logout_token: token, ...extra }),
  });
}
