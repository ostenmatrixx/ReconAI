import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";

import { chromium } from "../apps/web/node_modules/@playwright/test/index.mjs";

const applicationOrigin = requiredLoopbackOrigin("OIDC_TEST_APP_ORIGIN");
const providerOrigin = requiredLoopbackOrigin("OIDC_TEST_PROVIDER_ORIGIN");
const realmFixture = JSON.parse(
  await readFile(
    new URL("../infra/keycloak/reconai-development-realm.json", import.meta.url),
    "utf8",
  ),
);
const fixtureUser = realmFixture.users?.[0];
const username = fixtureUser?.username;
const initialPassword = fixtureUser?.credentials?.find(({ type }) => type === "password")?.value;
if (!username || !initialPassword)
  throw new Error("synthetic realm fixture credentials are missing");
const replacementPassword = `Local-${randomBytes(24).toString("base64url")}!`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
let providerLogoutRequest;

page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.origin === providerOrigin && url.pathname.endsWith("/protocol/openid-connect/logout")) {
    providerLogoutRequest = url;
  }
});

try {
  await page.goto(applicationOrigin);
  await page.getByRole("button", { name: "Sign in securely" }).click();
  await page.waitForURL((url) => url.origin === providerOrigin);
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(initialPassword);
  await page.locator("#kc-login").click();

  const newPassword = page.locator("#password-new");
  if (await newPassword.isVisible()) {
    await newPassword.fill(replacementPassword);
    await page.locator("#password-confirm").fill(replacementPassword);
    await page.locator("#kc-passwd-update-form button[type=submit]").click();
  }

  await page.waitForURL(`${applicationOrigin}/dashboard`, { timeout: 30_000 });
  await page.getByRole("button", { name: "Sign out" }).waitFor();

  const sessionResponse = await context.request.get(`${applicationOrigin}/api/auth/session`);
  const browserSession = await sessionResponse.json();
  const serializedSession = JSON.stringify(browserSession);
  const sessionCookiesBeforeLogout = (await context.cookies(applicationOrigin)).filter(
    ({ name }) => name === "reconai.session-token" || /^reconai\.session-token\.\d+$/.test(name),
  );

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(`${applicationOrigin}/`, { timeout: 30_000 });
  await page.getByRole("button", { name: "Sign in securely" }).waitFor();

  const sessionCookiesAfterLogout = (await context.cookies(applicationOrigin)).filter(
    ({ name }) => name === "reconai.session-token" || /^reconai\.session-token\.\d+$/.test(name),
  );

  await page.getByRole("button", { name: "Sign in securely" }).click();
  await page.waitForURL((url) => url.origin === providerOrigin, { timeout: 30_000 });
  await page.locator("#username").waitFor({ state: "visible", timeout: 10_000 });

  const result = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    provider: {
      name: "Keycloak",
      version: "26.7.0",
      realmData: "synthetic",
    },
    runtime: {
      applicationOrigin,
      providerOrigin,
      transport: "loopback development HTTP",
      productionTlsClaim: false,
    },
    assertions: {
      authorizationCodePkceLoginCompleted: true,
      browserSessionStatus: sessionResponse.status(),
      browserCredentialDisclosure:
        serializedSession.includes("apiAccessToken") ||
        serializedSession.includes("apiRefreshToken") ||
        serializedSession.includes("apiIdToken"),
      providerLogoutRequestObserved: providerLogoutRequest !== undefined,
      providerLogoutIdTokenHintPresent:
        (providerLogoutRequest?.searchParams.get("id_token_hint")?.length ?? 0) > 0,
      providerLogoutClientIdMatched:
        providerLogoutRequest?.searchParams.get("client_id") === "reconai-web-development",
      providerLogoutRedirectMatched:
        providerLogoutRequest?.searchParams.get("post_logout_redirect_uri") ===
        `${applicationOrigin}/`,
      sessionCookieChunkCountBeforeLogout: sessionCookiesBeforeLogout.length,
      sessionCookieHttpOnlyBeforeLogout: sessionCookiesBeforeLogout.every(
        ({ httpOnly }) => httpOnly,
      ),
      sessionCookieSameSiteBeforeLogout: [
        ...new Set(sessionCookiesBeforeLogout.map(({ sameSite }) => sameSite)),
      ],
      sessionCookieCountAfterLogout: sessionCookiesAfterLogout.length,
      localSessionCleared: sessionCookiesAfterLogout.length === 0,
      providerLoginFormShownAfterLogout: true,
    },
    limitations: [
      "This is one isolated local Keycloak exercise, not staging or production identity evidence.",
      "The exercise proves browser SSO termination for one local realm session; it does not prove upstream identity-provider logout propagation.",
      "No raw ID token, access token, refresh token, session cookie, authorization code, password, or client secret is recorded.",
    ],
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser.close();
}

function requiredEnvironmentValue(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredLoopbackOrigin(name) {
  const value = requiredEnvironmentValue(name);
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be a loopback HTTP(S) origin`);
  }
  return url.origin;
}
