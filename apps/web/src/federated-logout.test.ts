import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildProviderLogoutUrl,
  readLogoutCsrfToken,
  sessionCookieNamesToClear,
  verifyNextAuthCsrfToken,
} from "./federated-logout";

const secret = "development-only-session-secret-change-me";
const csrfToken = "a".repeat(64);

describe("federated logout", () => {
  it("builds a fixed Keycloak RP-initiated logout URL", () => {
    const logoutUrl = buildProviderLogoutUrl(
      {
        issuer: "https://identity.example.test/realms/reconai",
        clientId: "reconai-web",
        applicationOrigin: "https://app.example.test",
      },
      "signed-id-token",
    );

    expect(logoutUrl.origin).toBe("https://identity.example.test");
    expect(logoutUrl.pathname).toBe("/realms/reconai/protocol/openid-connect/logout");
    expect(logoutUrl.searchParams.get("client_id")).toBe("reconai-web");
    expect(logoutUrl.searchParams.get("id_token_hint")).toBe("signed-id-token");
    expect(logoutUrl.searchParams.get("post_logout_redirect_uri")).toBe(
      "https://app.example.test/",
    );
  });

  it("rejects invalid fixed redirect and token configuration", () => {
    expect(() =>
      buildProviderLogoutUrl(
        {
          issuer: "https://identity.example.test/realms/reconai",
          clientId: "reconai-web",
          applicationOrigin: "https://app.example.test/untrusted-path",
        },
        "signed-id-token",
      ),
    ).toThrow("Logout URL configuration is invalid");

    expect(() =>
      buildProviderLogoutUrl(
        {
          issuer: "https://identity.example.test/realms/reconai",
          clientId: "reconai-web",
          applicationOrigin: "https://app.example.test",
        },
        "x".repeat(32_769),
      ),
    ).toThrow("ID token is outside the permitted bounds");
  });

  it("validates NextAuth's signed double-submit token in decoded and encoded cookies", () => {
    const hash = createHash("sha256").update(`${csrfToken}${secret}`).digest("hex");
    const cookie = `${csrfToken}|${hash}`;

    expect(verifyNextAuthCsrfToken(cookie, csrfToken, secret)).toBe(true);
    expect(verifyNextAuthCsrfToken(encodeURIComponent(cookie), csrfToken, secret)).toBe(true);
    expect(verifyNextAuthCsrfToken(cookie, "b".repeat(64), secret)).toBe(false);
    expect(verifyNextAuthCsrfToken(`${csrfToken}|${"0".repeat(64)}`, csrfToken, secret)).toBe(
      false,
    );
    expect(verifyNextAuthCsrfToken(cookie, csrfToken, `${secret}-wrong`)).toBe(false);
  });

  it("accepts exactly one bounded URL-encoded CSRF field", async () => {
    const validRequest = new Request("https://app.example.test/api/auth/federated-logout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ csrfToken }),
    });
    await expect(readLogoutCsrfToken(validRequest)).resolves.toBe(csrfToken);

    const duplicateRequest = new Request("https://app.example.test/api/auth/federated-logout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `csrfToken=${csrfToken}&csrfToken=${csrfToken}`,
    });
    await expect(readLogoutCsrfToken(duplicateRequest)).resolves.toBeUndefined();

    const oversizedRequest = new Request("https://app.example.test/api/auth/federated-logout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `csrfToken=${csrfToken}&padding=${"x".repeat(4_096)}`,
    });
    await expect(readLogoutCsrfToken(oversizedRequest)).resolves.toBeUndefined();
  });

  it("clears only the exact session cookie and numeric NextAuth chunks", () => {
    expect(
      sessionCookieNamesToClear(
        [
          "reconai.session-token.2",
          "other-cookie",
          "reconai.session-token.attacker",
          "reconai.session-token.0",
          "reconai.session-token.0",
        ],
        "reconai.session-token",
      ),
    ).toEqual(["reconai.session-token", "reconai.session-token.2", "reconai.session-token.0"]);
  });
});
