import type { JWT } from "next-auth/jwt";
import { describe, expect, it, vi } from "vitest";

import {
  enforceOidcSessionRevocation,
  InMemorySessionRevocationStore,
  oidcSessionIdentity,
  type SessionRevocationStore,
} from "./session-revocation";

const issuer = "https://identity.example.test/realms/reconai";
const keySecret = "synthetic-session-secret-material-over-thirty-two-characters";
const now = Date.parse("2026-07-28T12:00:00.000Z");
const nowSeconds = Math.floor(now / 1_000);

describe("OIDC session revocation index", () => {
  it("revokes only the identified provider session when sid is present", async () => {
    const store = new InMemorySessionRevocationStore(keySecret, "test", () => now);
    const first = session("subject-1", "sid-1", nowSeconds - 60);
    const second = session("subject-1", "sid-2", nowSeconds - 60);

    await expect(
      store.recordLogout({
        issuer,
        subject: "subject-1",
        sessionId: "sid-1",
        issuedAt: nowSeconds,
        jwtId: "logout-1",
      }),
    ).resolves.toBe("recorded");

    await expect(store.isRevoked(first)).resolves.toBe(true);
    await expect(store.isRevoked(second)).resolves.toBe(false);
  });

  it("uses a subject cutoff only when sid is absent and allows a later login", async () => {
    const store = new InMemorySessionRevocationStore(keySecret, "test", () => now);
    await store.recordLogout({
      issuer,
      subject: "subject-1",
      issuedAt: nowSeconds,
      jwtId: "logout-all-1",
    });

    await expect(store.isRevoked(session("subject-1", "sid-1", nowSeconds - 60))).resolves.toBe(
      true,
    );
    await expect(store.isRevoked(session("subject-1", "sid-2", nowSeconds + 1))).resolves.toBe(
      false,
    );
    await expect(store.isRevoked(session("subject-2", "sid-3", nowSeconds - 60))).resolves.toBe(
      false,
    );
  });

  it("records the replay marker and revocation atomically from the caller's perspective", async () => {
    const store = new InMemorySessionRevocationStore(keySecret, "test", () => now);
    const event = {
      issuer,
      sessionId: "sid-1",
      issuedAt: nowSeconds,
      jwtId: "logout-1",
    } as const;

    await expect(store.recordLogout(event)).resolves.toBe("recorded");
    await expect(store.recordLogout(event)).resolves.toBe("replayed");
    await expect(store.isRevoked(session("subject-1", "sid-1", nowSeconds - 60))).resolves.toBe(
      true,
    );
  });

  it("fails closed and removes provider credentials when the index is unavailable", async () => {
    const unavailable = {
      recordLogout: vi.fn(),
      isRevoked: vi.fn().mockRejectedValue(new Error("synthetic outage")),
    } satisfies SessionRevocationStore;
    const token = {
      sub: "subject-1",
      apiAccessToken: "access-token",
      apiAccessTokenExpiresAt: nowSeconds + 300,
      apiRefreshToken: "refresh-token",
      apiIdToken: "id-token",
      apiOidcIssuer: issuer,
      apiOidcSubject: "subject-1",
      apiOidcSessionId: "sid-1",
      apiSessionStartedAt: nowSeconds - 60,
    } satisfies JWT;

    const enforced = await enforceOidcSessionRevocation(token, issuer, unavailable);
    expect(enforced.providerTokenError).toBe("SESSION_REVOCATION_UNAVAILABLE");
    expect(enforced.apiAccessToken).toBeUndefined();
    expect(enforced.apiRefreshToken).toBeUndefined();
    expect(enforced.apiIdToken).toBeUndefined();
  });

  it("rejects missing or issuer-confused session identity before an index lookup", () => {
    expect(oidcSessionIdentity({ sub: "subject-1" }, issuer)).toBeUndefined();
    expect(
      oidcSessionIdentity(
        {
          apiOidcIssuer: "https://attacker.example.test",
          apiOidcSubject: "subject-1",
          apiSessionStartedAt: nowSeconds,
        },
        issuer,
      ),
    ).toBeUndefined();
  });
});

function session(
  subject: string,
  sessionId: string,
  startedAt: number,
): {
  readonly issuer: string;
  readonly subject: string;
  readonly sessionId: string;
  readonly startedAt: number;
} {
  return { issuer, subject, sessionId, startedAt };
}
