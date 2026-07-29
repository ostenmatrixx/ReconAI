import type { Account } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { describe, expect, it, vi } from "vitest";

import { exposeOidcSessionStatus, oidcJwtNeedsRefresh, updateOidcJwt } from "./oidc-session";

const configuration = {
  issuer: "https://identity.example.test/realms/reconai",
  clientId: "reconai-web",
  clientSecret: "test-client-secret",
} as const;
const now = Date.parse("2026-07-27T12:00:00.000Z");

describe("OIDC session rotation", () => {
  it("blocks only sessions that need refresh before BFF traffic starts", () => {
    expect(
      oidcJwtNeedsRefresh(
        {
          apiAccessToken: "valid-access-token",
          apiAccessTokenExpiresAt: Math.floor(now / 1_000) + 61,
        },
        now,
      ),
    ).toBe(false);
    expect(
      oidcJwtNeedsRefresh(
        {
          apiAccessToken: "expiring-access-token",
          apiAccessTokenExpiresAt: Math.floor(now / 1_000) + 60,
        },
        now,
      ),
    ).toBe(true);
  });

  it("exposes only reauthentication status to browser-readable session data", () => {
    const session = {
      expires: "2026-07-27T20:00:00.000Z",
      user: { email: "operator@example.test" },
    };

    const exposed = exposeOidcSessionStatus(session, {
      apiAccessToken: "server-only-access-token",
      apiRefreshToken: "server-only-refresh-token",
      apiIdToken: "server-only-id-token",
      providerTokenError: "REFRESH_FAILED",
    });

    expect(exposed).toEqual({
      ...session,
      reauthenticationRequired: true,
    });
    expect(JSON.stringify(exposed)).not.toContain("server-only");
  });

  it("captures provider credentials only in the encrypted JWT on sign-in", async () => {
    const account = {
      provider: "keycloak",
      type: "oauth",
      providerAccountId: "operator-1",
      access_token: "access-token",
      expires_at: Math.floor(now / 1_000) + 300,
      refresh_token: "refresh-token",
      id_token: "id-token",
    } satisfies Account;

    await expect(
      updateOidcJwt({}, account, configuration, {
        fetch: vi.fn(),
        now: () => now,
      }),
    ).resolves.toMatchObject({
      apiAccessToken: "access-token",
      apiAccessTokenExpiresAt: Math.floor(now / 1_000) + 300,
      apiRefreshToken: "refresh-token",
      apiIdToken: "id-token",
      apiOidcIssuer: configuration.issuer,
      apiOidcSubject: "operator-1",
      apiSessionStartedAt: Math.floor(now / 1_000),
    });
  });

  it("captures sid only from identity claims matching the validated account", async () => {
    const idToken = compactJwt({
      iss: configuration.issuer,
      aud: configuration.clientId,
      sub: "operator-1",
      sid: "provider-session-1",
    });
    await expect(
      updateOidcJwt(
        {
          apiOidcSessionId: "stale-session",
        },
        {
          provider: "keycloak",
          type: "oauth",
          providerAccountId: "operator-1",
          access_token: "access-token",
          expires_at: Math.floor(now / 1_000) + 300,
          id_token: idToken,
        },
        configuration,
        { fetch: vi.fn(), now: () => now },
      ),
    ).resolves.toMatchObject({
      apiOidcIssuer: configuration.issuer,
      apiOidcSubject: "operator-1",
      apiOidcSessionId: "provider-session-1",
      apiSessionStartedAt: Math.floor(now / 1_000),
    });

    const confused = await updateOidcJwt(
      {},
      {
        provider: "keycloak",
        type: "oauth",
        providerAccountId: "operator-1",
        id_token: compactJwt({
          iss: "https://attacker.example.test",
          aud: configuration.clientId,
          sub: "operator-1",
          sid: "attacker-session",
        }),
      },
      configuration,
      { fetch: vi.fn(), now: () => now },
    );
    expect(confused.apiOidcSessionId).toBeUndefined();
  });

  it("keeps a token that remains valid outside the refresh window", async () => {
    const token = {
      apiAccessToken: "current-access-token",
      apiAccessTokenExpiresAt: Math.floor(now / 1_000) + 61,
      apiRefreshToken: "current-refresh-token",
    } satisfies JWT;
    const fetchMock = vi.fn();

    await expect(
      updateOidcJwt(token, null, configuration, {
        fetch: fetchMock,
        now: () => now,
      }),
    ).resolves.toBe(token);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rotates an expiring access token and adopts a rotated refresh token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "rotated-access-token",
          expires_in: 300,
          refresh_token: "rotated-refresh-token",
          id_token: "rotated-id-token",
          token_type: "Bearer",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await expect(
      updateOidcJwt(
        {
          apiAccessToken: "expiring-access-token",
          apiAccessTokenExpiresAt: Math.floor(now / 1_000) + 60,
          apiRefreshToken: "current-refresh-token",
        },
        null,
        configuration,
        { fetch: fetchMock, now: () => now },
      ),
    ).resolves.toMatchObject({
      apiAccessToken: "rotated-access-token",
      apiAccessTokenExpiresAt: Math.floor(now / 1_000) + 300,
      apiRefreshToken: "rotated-refresh-token",
      apiIdToken: "rotated-id-token",
    });

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://identity.example.test/realms/reconai/protocol/openid-connect/token");
    expect(request).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    const body = request.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("current-refresh-token");
  });

  it("preserves the current refresh token when the provider does not rotate it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "rotated-access-token",
          expires_in: 300,
          token_type: "bearer",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await expect(
      updateOidcJwt(
        {
          apiAccessToken: "expired-access-token",
          apiAccessTokenExpiresAt: Math.floor(now / 1_000) - 1,
          apiRefreshToken: "current-refresh-token",
          apiIdToken: "current-id-token",
        },
        null,
        configuration,
        { fetch: fetchMock, now: () => now },
      ),
    ).resolves.toMatchObject({
      apiAccessToken: "rotated-access-token",
      apiRefreshToken: "current-refresh-token",
      apiIdToken: "current-id-token",
    });
  });

  it("fails closed without retry amplification or exposing an expired access token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    const expired = {
      apiAccessToken: "expired-access-token",
      apiAccessTokenExpiresAt: Math.floor(now / 1_000) - 1,
      apiRefreshToken: "revoked-refresh-token",
    } satisfies JWT;

    const failed = await updateOidcJwt(expired, null, configuration, {
      fetch: fetchMock,
      now: () => now,
    });
    expect(failed).toMatchObject({ providerTokenError: "REFRESH_FAILED" });
    expect(failed.apiAccessToken).toBeUndefined();

    await updateOidcJwt(failed, null, configuration, {
      fetch: fetchMock,
      now: () => now,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized or malformed token responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "x".repeat(70_000), expires_in: 300 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const failed = await updateOidcJwt(
      {
        apiAccessToken: "expired-access-token",
        apiAccessTokenExpiresAt: Math.floor(now / 1_000) - 1,
        apiRefreshToken: "refresh-token",
      },
      null,
      configuration,
      { fetch: fetchMock, now: () => now },
    );
    expect(failed).toMatchObject({ providerTokenError: "REFRESH_FAILED" });
    expect(failed).not.toHaveProperty("apiAccessToken");
  });
});

function compactJwt(payload: Readonly<Record<string, unknown>>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${claims}.c3ludGhldGljLXNpZ25hdHVyZQ`;
}
