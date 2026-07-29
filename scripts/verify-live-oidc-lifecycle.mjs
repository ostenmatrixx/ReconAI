import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const requireFromWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { decode } = requireFromWeb("next-auth/jwt");
const playwright = await import(requireFromWeb.resolve("@playwright/test"));
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (!chromium) throw new Error("Playwright Chromium runtime is unavailable");

const applicationOrigin = requiredLoopbackOrigin("OIDC_TEST_APP_ORIGIN");
const providerOrigin = requiredLoopbackOrigin("OIDC_TEST_PROVIDER_ORIGIN");
const sessionSecret = requiredEnvironmentValue("SESSION_SECRET");
const providerVersion = requiredEnvironmentValue("OIDC_TEST_PROVIDER_VERSION");
const patchSource = await readFile(
  new URL("../patches/openid-client@5.7.1.patch", import.meta.url),
);
const patchSha256 = createHash("sha256").update(patchSource).digest("hex");
const realmFixture = JSON.parse(
  await readFile(
    new URL("../infra/keycloak/reconai-development-realm.json", import.meta.url),
    "utf8",
  ),
);
const fixtureUser = realmFixture.users?.[0];
const username = fixtureUser?.username;
const initialPassword = fixtureUser?.credentials?.find(({ type }) => type === "password")?.value;
if (!username || !initialPassword) {
  throw new Error("synthetic realm fixture credentials are missing");
}
const replacementPassword = `Local-${randomBytes(24).toString("base64url")}!`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
context.setDefaultTimeout(30_000);
context.setDefaultNavigationTimeout(30_000);
const page = await context.newPage();
let providerAuthorizationRequest;
let providerLogoutRequest;

page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.origin === providerOrigin) {
    if (url.pathname.endsWith("/protocol/openid-connect/auth")) {
      providerAuthorizationRequest = url;
    } else if (url.pathname.endsWith("/protocol/openid-connect/logout")) {
      providerLogoutRequest = url;
    }
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

  const initialCookieState = await readSessionCookie(context, applicationOrigin);
  const initialToken = await decode({ token: initialCookieState.value, secret: sessionSecret });
  const initialAccessToken = requiredTokenString(initialToken, "apiAccessToken");
  const initialRefreshToken = requiredTokenString(initialToken, "apiRefreshToken");
  const initialIdToken = requiredTokenString(initialToken, "apiIdToken");
  const initialAccessExpiry = requiredTokenNumber(initialToken, "apiAccessTokenExpiresAt");
  const waitMilliseconds = Math.max(0, initialAccessExpiry * 1_000 - Date.now() - 59_000);
  if (waitMilliseconds > 15_000) {
    throw new Error("provider access-token lifetime is outside the bounded refresh exercise");
  }
  if (waitMilliseconds > 0) {
    await page.waitForTimeout(waitMilliseconds);
  }

  const browserSession = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    return {
      body: await response.text(),
      status: response.status,
    };
  });
  const browserSessionJson = JSON.parse(browserSession.body);
  const rotatedCookieState = await readSessionCookie(context, applicationOrigin);
  const rotatedToken = await decode({ token: rotatedCookieState.value, secret: sessionSecret });
  const rotatedAccessToken = requiredTokenString(rotatedToken, "apiAccessToken");
  const rotatedRefreshToken = requiredTokenString(rotatedToken, "apiRefreshToken");
  const rotatedIdToken = requiredTokenString(rotatedToken, "apiIdToken");
  const rotatedAccessExpiry = requiredTokenNumber(rotatedToken, "apiAccessTokenExpiresAt");
  const rotatedSessionCookies = sessionCookies(await context.cookies(applicationOrigin));

  const serializedSession = JSON.stringify(browserSessionJson);
  const disclosedProviderCredential = [
    initialAccessToken,
    initialRefreshToken,
    initialIdToken,
    rotatedAccessToken,
    rotatedRefreshToken,
    rotatedIdToken,
  ].some((credential) => serializedSession.includes(credential));

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(`${applicationOrigin}/`, { timeout: 30_000 });
  await page.getByRole("button", { name: "Sign in securely" }).waitFor();
  const sessionCookiesAfterLogout = sessionCookies(await context.cookies(applicationOrigin));

  const revokedContext = await browser.newContext();
  let revokedBrowserSession;
  try {
    await revokedContext.addCookies(rotatedSessionCookies);
    const revokedResponse = await revokedContext.request.get(
      `${applicationOrigin}/api/auth/session`,
      {
        headers: { "cache-control": "no-store" },
      },
    );
    revokedBrowserSession = {
      body: await revokedResponse.text(),
      status: revokedResponse.status(),
    };
  } finally {
    await revokedContext.close();
  }
  const revokedBrowserSessionJson = JSON.parse(revokedBrowserSession.body);
  const serializedRevokedSession = JSON.stringify(revokedBrowserSessionJson);
  const revokedSessionDisclosedProviderCredential = [
    initialAccessToken,
    initialRefreshToken,
    initialIdToken,
    rotatedAccessToken,
    rotatedRefreshToken,
    rotatedIdToken,
  ].some((credential) => serializedRevokedSession.includes(credential));

  await page.getByRole("button", { name: "Sign in securely" }).click();
  await page.waitForURL((url) => url.origin === providerOrigin, { timeout: 30_000 });
  await page.locator("#username").waitFor({ state: "visible", timeout: 10_000 });

  const result = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    component: "post-patch-real-oidc-refresh-and-logout-lifecycle",
    outcome: "local_isolated_real_oidc_browser_lifecycle_passed",
    productionReadinessClaim: false,
    provider: {
      name: "Keycloak",
      version: providerVersion,
      realmData: "synthetic",
    },
    patchedDependency: {
      package: "openid-client@5.7.1",
      patchSha256,
    },
    runtime: {
      applicationOrigin,
      providerOrigin,
      transport: "loopback development HTTP",
      productionTlsClaim: false,
    },
    assertions: {
      providerAuthorizationRequestObserved: providerAuthorizationRequest !== undefined,
      providerAuthorizationClientIdMatched:
        providerAuthorizationRequest?.searchParams.get("client_id") === "reconai-web-development",
      providerAuthorizationRedirectMatched:
        providerAuthorizationRequest?.searchParams.get("redirect_uri") ===
        `${applicationOrigin}/api/auth/callback/keycloak`,
      providerAuthorizationResponseTypeCode:
        providerAuthorizationRequest?.searchParams.get("response_type") === "code",
      providerAuthorizationStatePresent:
        (providerAuthorizationRequest?.searchParams.get("state")?.length ?? 0) > 0,
      providerAuthorizationPkceChallengePresent:
        (providerAuthorizationRequest?.searchParams.get("code_challenge")?.length ?? 0) > 0,
      providerAuthorizationPkceS256:
        providerAuthorizationRequest?.searchParams.get("code_challenge_method") === "S256",
      authorizationCodePkceLoginCompleted: true,
      browserSessionStatus: browserSession.status,
      browserReauthenticationRequired: browserSessionJson?.reauthenticationRequired === true,
      browserCredentialDisclosure: disclosedProviderCredential,
      accessTokenRotated: initialAccessToken !== rotatedAccessToken,
      refreshTokenRotated: initialRefreshToken !== rotatedRefreshToken,
      accessTokenExpiryAdvancedSeconds: rotatedAccessExpiry - initialAccessExpiry,
      sessionCookieChunkCountBeforeRefresh: initialCookieState.count,
      sessionCookieChunkCountAfterRefresh: rotatedCookieState.count,
      sessionCookieHttpOnlyAfterRefresh: rotatedCookieState.httpOnly,
      sessionCookieSameSiteAfterRefresh: rotatedCookieState.sameSite,
      providerLogoutRequestObserved: providerLogoutRequest !== undefined,
      providerLogoutIdTokenHintPresent:
        (providerLogoutRequest?.searchParams.get("id_token_hint")?.length ?? 0) > 0,
      providerLogoutClientIdMatched:
        providerLogoutRequest?.searchParams.get("client_id") === "reconai-web-development",
      providerLogoutRedirectMatched:
        providerLogoutRequest?.searchParams.get("post_logout_redirect_uri") ===
        `${applicationOrigin}/`,
      backchannelReplayedSessionStatus: revokedBrowserSession.status,
      backchannelReplayedSessionRequiresReauthentication:
        revokedBrowserSessionJson?.reauthenticationRequired === true,
      backchannelReplayedSessionCredentialDisclosure: revokedSessionDisclosedProviderCredential,
      sessionCookieCountAfterLogout: sessionCookiesAfterLogout.length,
      localSessionCleared: sessionCookiesAfterLogout.length === 0,
      providerLoginFormShownAfterLogout: true,
    },
    limitations: [
      "This is one isolated local Keycloak exercise, not staging or production identity evidence.",
      "The web process must be started separately with NODE_OPTIONS=--throw-deprecation; this verifier does not inspect process-manager configuration.",
      "The exercise proves one browser authorization, refresh, RP logout, and single-process signed back-channel invalidation lifecycle; it does not prove multi-replica revocation, Redis recovery, clock/secret rotation, or alert delivery.",
      "No raw ID token, access token, refresh token, session cookie, authorization code, password, client secret, or token digest is recorded.",
    ],
  };

  for (const [assertion, value] of Object.entries(result.assertions)) {
    if (
      value === false &&
      ![
        "browserReauthenticationRequired",
        "browserCredentialDisclosure",
        "backchannelReplayedSessionCredentialDisclosure",
      ].includes(assertion)
    ) {
      throw new Error(`OIDC lifecycle assertion failed: ${assertion}`);
    }
  }
  if (
    result.assertions.browserSessionStatus !== 200 ||
    result.assertions.browserReauthenticationRequired ||
    result.assertions.browserCredentialDisclosure ||
    result.assertions.backchannelReplayedSessionStatus !== 200 ||
    !result.assertions.backchannelReplayedSessionRequiresReauthentication ||
    result.assertions.backchannelReplayedSessionCredentialDisclosure ||
    result.assertions.accessTokenExpiryAdvancedSeconds <= 0 ||
    result.assertions.sessionCookieChunkCountBeforeRefresh < 1 ||
    result.assertions.sessionCookieChunkCountAfterRefresh < 1 ||
    !result.assertions.sessionCookieHttpOnlyAfterRefresh ||
    result.assertions.sessionCookieSameSiteAfterRefresh !== "Lax" ||
    result.assertions.sessionCookieCountAfterLogout !== 0
  ) {
    throw new Error("OIDC lifecycle contract did not pass");
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser.close();
}

async function readSessionCookie(context, origin) {
  const cookies = sessionCookies(await context.cookies(origin));
  if (cookies.length === 0) {
    throw new Error("encrypted session cookie is missing");
  }
  const unchunked = cookies.find(({ name }) => name === "reconai.session-token");
  const chunks = cookies
    .filter(({ name }) => /^reconai\.session-token\.\d+$/u.test(name))
    .sort((left, right) => sessionChunkIndex(left.name) - sessionChunkIndex(right.name));
  if (unchunked && chunks.length > 0) {
    throw new Error("session cookie mixes chunked and unchunked forms");
  }
  if (chunks.some(({ name }, index) => sessionChunkIndex(name) !== index)) {
    throw new Error("session cookie chunks are not continuous");
  }
  const selected = unchunked ? [unchunked] : chunks;
  if (selected.length === 0) {
    throw new Error("session cookie has no valid chunks");
  }
  return {
    count: selected.length,
    httpOnly: selected.every(({ httpOnly }) => httpOnly),
    sameSite: [...new Set(selected.map(({ sameSite }) => sameSite))].join(","),
    value: selected.map(({ value }) => value).join(""),
  };
}

function sessionCookies(cookies) {
  return cookies.filter(
    ({ name }) => name === "reconai.session-token" || /^reconai\.session-token\.\d+$/u.test(name),
  );
}

function sessionChunkIndex(name) {
  const index = Number(name.slice(name.lastIndexOf(".") + 1));
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error("session cookie chunk index is invalid");
  }
  return index;
}

function requiredTokenString(token, field) {
  const value = token?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`encrypted session ${field} is missing`);
  }
  return value;
}

function requiredTokenNumber(token, field) {
  const value = token?.[field];
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`encrypted session ${field} is invalid`);
  }
  return value;
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
