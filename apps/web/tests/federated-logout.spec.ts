import { expect, test } from "@playwright/test";
import { encode } from "next-auth/jwt";

const sessionCookieName = "reconai.session-token";
const syntheticIdToken = `header.${"i".repeat(6_000)}.signature`;
const nextAuthChunkSize = 3_933;

test.beforeEach(async ({ context }) => {
  const sessionToken = await encode({
    secret: "development-only-session-secret-change-me",
    maxAge: 3_600,
    token: {
      sub: "00000000-0000-4000-8000-000000000004",
      name: "Synthetic Operator",
      email: "operator@example.test",
      apiOidcIssuer: "http://localhost:8080/realms/reconai-development",
      apiOidcSubject: "synthetic-operator",
      apiSessionStartedAt: Math.floor(Date.now() / 1_000),
      apiAccessToken: "synthetic-browser-access-token",
      apiAccessTokenExpiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      apiRefreshToken: "synthetic-browser-refresh-token",
      apiIdToken: syntheticIdToken,
    },
  });
  const chunks = Array.from(
    { length: Math.ceil(sessionToken.length / nextAuthChunkSize) },
    (_, index) => ({
      name: `${sessionCookieName}.${String(index)}`,
      value: sessionToken.slice(index * nextAuthChunkSize, (index + 1) * nextAuthChunkSize),
      url: "http://127.0.0.1:3000",
      httpOnly: true,
      sameSite: "Lax" as const,
    }),
  );
  await context.addCookies(chunks);
  await context.addCookies([
    {
      name: "reconai.organization-context",
      value: "synthetic-organization-context",
      url: "http://127.0.0.1:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
});

test("ends the provider session after CSRF validation and clears every local session chunk", async ({
  context,
  page,
}) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  const browserSession = await page.request.get("/api/auth/session");
  const browserSessionBody = await browserSession.text();
  expect(browserSessionBody).not.toContain("synthetic-browser-access-token");
  expect(browserSessionBody).not.toContain("synthetic-browser-refresh-token");
  expect(browserSessionBody).not.toContain(syntheticIdToken);

  const csrfResponse = await page.request.get("/api/auth/csrf");
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };
  const rejected = await page.request.post("/api/auth/federated-logout", {
    form: { csrfToken },
    headers: { origin: "https://attacker.example.test" },
    maxRedirects: 0,
  });
  expect(rejected.status()).toBe(403);
  expect(
    (await context.cookies("http://127.0.0.1:3000")).some(({ name }) =>
      name.startsWith(`${sessionCookieName}.`),
    ),
  ).toBe(true);

  const logoutResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/federated-logout"),
  );
  const providerRequestPromise = page.waitForRequest((request) =>
    request.url().startsWith("http://localhost:8080/realms/reconai-development/"),
  );
  await page.getByRole("button", { name: "Sign out" }).click();
  const logoutResponse = await logoutResponsePromise;
  const providerRequest = await providerRequestPromise;
  expect(logoutResponse.status()).toBe(303);
  expect(logoutResponse.headers()["cache-control"]).toContain("no-store");
  expect(logoutResponse.headers()["referrer-policy"]).toBe("no-referrer");

  const providerLogoutUrl = new URL(providerRequest.url());
  expect(providerLogoutUrl.pathname).toBe(
    "/realms/reconai-development/protocol/openid-connect/logout",
  );
  expect(providerLogoutUrl.searchParams.get("client_id")).toBe("reconai-web-development");
  expect(providerLogoutUrl.searchParams.get("id_token_hint")).toBe(syntheticIdToken);
  expect(providerLogoutUrl.searchParams.get("post_logout_redirect_uri")).toBe(
    "http://127.0.0.1:3000/",
  );

  const remainingCookies = await context.cookies("http://127.0.0.1:3000");
  expect(remainingCookies.some(({ name }) => name === sessionCookieName)).toBe(false);
  expect(remainingCookies.some(({ name }) => name.startsWith(`${sessionCookieName}.`))).toBe(false);
  expect(remainingCookies.some(({ name }) => name === "reconai.organization-context")).toBe(false);
});

test("does not expose logout as a state-changing GET", async ({ page }) => {
  const response = await page.request.get("/api/auth/federated-logout", {
    maxRedirects: 0,
  });
  expect(response.status()).toBe(405);
});
