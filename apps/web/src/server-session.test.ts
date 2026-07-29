import { getToken } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionRevocationStore } from "./session-revocation";
import { readSessionRevocationConfiguration } from "./server-environment";
import { readRequestSessionToken } from "./server-session";

vi.mock("next-auth/jwt", () => ({ getToken: vi.fn() }));

const issuer = "https://identity.example.test/realms/reconai";
const subject = "operator-1";
const sessionId = "provider-session-1";
const nowSeconds = Math.floor(Date.parse("2026-07-28T12:00:00.000Z") / 1_000);

describe("revocation-aware server session", { concurrent: false }, () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("APP_ENV", "server-session-test");
    vi.stubEnv("OIDC_ISSUER", issuer);
    vi.stubEnv("OIDC_CLIENT_ID", "reconai-web");
    vi.stubEnv("OIDC_CLIENT_SECRET", "synthetic-oidc-client-secret");
    vi.stubEnv("SESSION_SECRET", "synthetic-server-session-secret-over-thirty-two-characters");
    vi.stubEnv("SESSION_REVOCATION_STORE", "local");
    vi.mocked(getToken).mockResolvedValue({
      sub: subject,
      apiAccessToken: "access-token",
      apiAccessTokenExpiresAt: nowSeconds + 300,
      apiOidcIssuer: issuer,
      apiOidcSubject: subject,
      apiOidcSessionId: sessionId,
      apiSessionStartedAt: nowSeconds - 60,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("accepts a valid unrevoked cookie and rejects it after provider logout", async () => {
    const request = new NextRequest("https://app.example.test/dashboard");
    await expect(readRequestSessionToken(request)).resolves.toMatchObject({
      apiAccessToken: "access-token",
    });

    await sessionRevocationStore(readSessionRevocationConfiguration()).recordLogout({
      issuer,
      subject,
      sessionId,
      issuedAt: nowSeconds,
      jwtId: "server-session-logout-1",
    });

    await expect(readRequestSessionToken(request)).resolves.toBeNull();
  });

  it("rejects a cookie missing the provider-bound session identity", async () => {
    vi.mocked(getToken).mockResolvedValue({
      sub: subject,
      apiAccessToken: "access-token",
    });
    await expect(
      readRequestSessionToken(new NextRequest("https://app.example.test/dashboard")),
    ).resolves.toBeNull();
  });
});
