import { describe, expect, it, vi } from "vitest";

import {
  issueProviderAuthorizationCookie,
  providerAuthorizationCookieName,
  verifyProviderAuthorizationCookie,
} from "./provider-authorization-cookie";

const secret = "synthetic-session-secret-over-thirty-two-characters";
const subject = "identity-provider|user-1";
const now = new Date("2026-07-28T00:00:00.000Z");
const input = {
  attemptId: "00000000-0000-4000-8000-000000000061",
  organizationId: "00000000-0000-4000-8000-000000000062",
  provider: "stripe" as const,
  stateSha256: "a".repeat(64),
  expiresAt: Math.floor(now.getTime() / 1000) + 600,
};

describe("provider authorization transaction cookie", () => {
  it("binds an unexpired attempt to the exact identity and signed state digest", () => {
    const cookie = issueProviderAuthorizationCookie(input, subject, secret, now);
    expect(verifyProviderAuthorizationCookie(cookie, subject, secret, now)).toEqual({
      schemaVersion: 1,
      ...input,
      issuedAt: Math.floor(now.getTime() / 1000),
    });
    expect(cookie).not.toContain(input.stateSha256);
  });

  it("rejects tampering, another subject, expiration, and excessive lifetime", () => {
    const cookie = issueProviderAuthorizationCookie(input, subject, secret, now);
    expect(verifyProviderAuthorizationCookie(`${cookie}x`, subject, secret, now)).toBeUndefined();
    expect(
      verifyProviderAuthorizationCookie(cookie, "identity-provider|user-2", secret, now),
    ).toBeUndefined();
    expect(
      verifyProviderAuthorizationCookie(cookie, subject, secret, new Date(now.getTime() + 601_000)),
    ).toBeUndefined();
    expect(() =>
      issueProviderAuthorizationCookie(
        { ...input, expiresAt: Math.floor(now.getTime() / 1000) + 901 },
        subject,
        secret,
        now,
      ),
    ).toThrow("lifetime");
  });

  it("uses a host-only cookie prefix in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(providerAuthorizationCookieName()).toBe("__Host-reconai.provider-authorization");
    vi.unstubAllEnvs();
  });
});
