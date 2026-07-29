import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { access, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { setTimeout as nodeSetTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const requireFromWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));
const postgres = (await import(requireFromApi.resolve("postgres"))).default;
const playwright = await import(requireFromWeb.resolve("@playwright/test"));
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (!chromium) throw new Error("Playwright Chromium runtime is unavailable");

const keycloakHome = await requiredDirectory("LIVE_KEYCLOAK_HOME");
const javaHome = await requiredDirectory("LIVE_JAVA_HOME");
const postgresBin = await requiredDirectory("LIVE_POSTGRES_BIN");
const keycloakVersion = "26.7.0";
const realmName = "reconai-support-verification";
const clientId = "reconai-web-development";
const supportGroup = "/reconai-support";
const supportAuthenticationContext = "2";
const webOrigin = "http://localhost:3000";
const apiOrigin = "http://127.0.0.1:4000";
const ownerUsername = "owner@example.test";
const supportUsername = "support@example.test";
const outsiderUsername = "outsider@example.test";
const ownerPassword = generatedPassword();
const supportPassword = generatedPassword();
const outsiderPassword = generatedPassword();
const clientSecret = randomBytes(32).toString("base64url");
const sessionSecret = randomBytes(32).toString("base64url");
const supportIdentityHmacKey = randomBytes(32).toString("base64url");
const keycloakAdminPassword = generatedPassword();
const databasePasswords = {
  administrator: randomBytes(24).toString("base64url"),
  migrator: randomBytes(24).toString("base64url"),
  application: randomBytes(24).toString("base64url"),
  worker: randomBytes(24).toString("base64url"),
  maintenance: randomBytes(24).toString("base64url"),
};
const runtimeRoot = process.env["LIVE_RUNTIME_ROOT"] ?? "/tmp";
const runtime = await mkdtemp(join(runtimeRoot, "reconai-oidc-support-"));
const postgresData = join(runtime, "postgres");
const postgresSocket = join(runtime, "postgres-socket");
const keycloakRuntime = join(runtime, "keycloak");
const children = [];
const secrets = [
  ownerPassword,
  supportPassword,
  outsiderPassword,
  clientSecret,
  sessionSecret,
  supportIdentityHmacKey,
  keycloakAdminPassword,
  ...Object.values(databasePasswords),
];
let postgresStarted = false;
let browser;
let ownerContext;
let supportContext;
let outsiderContext;
let inspectionDatabase;
let cleanupStarted = false;

const terminate = () => {
  void cleanup().finally(() => {
    process.exitCode = 130;
  });
};
process.on("SIGINT", terminate);
process.on("SIGTERM", terminate);

try {
  await Promise.all([assertTcpPortAvailable(3000, "web"), assertTcpPortAvailable(4000, "API")]);
  const [postgresPort, keycloakPort] = await Promise.all([availablePort(), availablePort()]);
  const keycloakOrigin = `http://127.0.0.1:${String(keycloakPort)}`;
  const oidcIssuer = `${keycloakOrigin}/realms/${realmName}`;
  const adminDatabaseUrl =
    `postgresql://postgres:${databasePasswords.administrator}` +
    `@127.0.0.1:${String(postgresPort)}/reconai`;
  const migrationDatabaseUrl =
    `postgresql://reconai_migrator:${databasePasswords.migrator}` +
    `@127.0.0.1:${String(postgresPort)}/reconai`;
  const applicationDatabaseUrl =
    `postgresql://reconai_app:${databasePasswords.application}` +
    `@127.0.0.1:${String(postgresPort)}/reconai`;

  await startPostgres(postgresPort);
  postgresStarted = true;
  await initializeDatabase(postgresPort);
  reportPhase("fresh PostgreSQL cluster initialized with restricted roles");

  const applicationEnvironment = {
    ...process.env,
    NODE_ENV: "development",
    APP_ENV: "live-oidc-support",
    WEB_ORIGIN: webOrigin,
    NEXTAUTH_URL: webOrigin,
    API_ORIGIN: apiOrigin,
    API_HOST: "127.0.0.1",
    API_PORT: "4000",
    DATABASE_URL: applicationDatabaseUrl,
    DATABASE_MIGRATION_URL: migrationDatabaseUrl,
    OIDC_ISSUER: oidcIssuer,
    OIDC_CLIENT_ID: clientId,
    OIDC_CLIENT_SECRET: clientSecret,
    OIDC_ID_TOKEN_SIGNING_ALGORITHM: "RS256",
    OIDC_ACR_VALUES: supportAuthenticationContext,
    SESSION_SECRET: sessionSecret,
    SESSION_REVOCATION_STORE: "local",
    SUPPORT_ACCESS_ENABLED: "true",
    SUPPORT_OIDC_GROUP: supportGroup,
    SUPPORT_OIDC_AUTHENTICATION_CONTEXT: supportAuthenticationContext,
    SUPPORT_IDENTITY_HMAC_KEY: supportIdentityHmacKey,
    LOG_LEVEL: "error",
  };

  await runCommand(
    "database migration",
    "pnpm",
    ["--filter", "@workspace/database", "db:migrate"],
    applicationEnvironment,
  );
  reportPhase("all repository migrations applied");

  await prepareKeycloakRealm();
  children.push(
    startChild(
      "keycloak",
      join(keycloakRuntime, "bin", "kc.sh"),
      [
        "start-dev",
        "--import-realm",
        "--http-host",
        "127.0.0.1",
        "--http-port",
        String(keycloakPort),
      ],
      {
        ...process.env,
        JAVA_HOME: javaHome,
        KC_BOOTSTRAP_ADMIN_USERNAME: "admin",
        KC_BOOTSTRAP_ADMIN_PASSWORD: keycloakAdminPassword,
        KC_LOG_LEVEL: "warn",
        KC_HEALTH_ENABLED: "true",
      },
    ),
  );
  await waitForHttp(`${oidcIssuer}/.well-known/openid-configuration`, children, 90_000);
  await assertOidcDiscovery(oidcIssuer);
  reportPhase("isolated Keycloak realm imported and OIDC discovery verified");

  children.push(
    startChild(
      "api",
      "pnpm",
      ["exec", "tsx", "--conditions=development", "scripts/live-support-api-harness.mjs"],
      applicationEnvironment,
    ),
  );
  children.push(
    startChild(
      "web",
      "pnpm",
      [
        "--filter",
        "@workspace/web",
        "exec",
        "next",
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        "3000",
        "--webpack",
      ],
      applicationEnvironment,
    ),
  );
  await waitForHttp(`${apiOrigin}/health/live`, children, 30_000);
  await waitForHttp(webOrigin, children, 60_000);
  reportPhase("actual web and focused API processes ready");

  inspectionDatabase = postgres(adminDatabaseUrl, { max: 2 });
  const initialState = requiredRow(
    await inspectionDatabase`
      select
        (select count(*)::integer from organizations) as organizations,
        (select count(*)::integer from memberships) as memberships,
        (select count(*)::integer from support_access_requests) as support_requests,
        (select count(*)::integer from support_access_grants) as support_grants,
        (select count(*)::integer from audit_events) as audit_events,
        (select count(*)::integer from reconai_schema_migrations) as migrations
    `,
    "initial database state",
  );
  for (const field of [
    "organizations",
    "memberships",
    "support_requests",
    "support_grants",
    "audit_events",
  ]) {
    assertEqual(Number(initialState[field]), 0, `initial ${field}`);
  }
  const migrationCount = Number(initialState["migrations"]);
  assert(migrationCount > 0, "no migrations were applied");

  browser = await chromium.launch({ headless: true });
  ownerContext = await browser.newContext();
  supportContext = await browser.newContext();
  outsiderContext = await browser.newContext();
  for (const context of [ownerContext, supportContext, outsiderContext]) {
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(30_000);
  }
  const browserErrors = [];

  const ownerPage = await ownerContext.newPage();
  observeBrowserErrors(ownerPage, browserErrors);
  await ownerPage.goto(webOrigin);
  await startSignIn(ownerPage, keycloakOrigin);
  await completePasswordLogin(ownerPage, ownerUsername, ownerPassword);
  await ownerPage.waitForURL(`${webOrigin}/dashboard`, { timeout: 30_000 });
  await ownerPage.getByText("No active memberships", { exact: true }).waitFor();
  const organizationName = "Keycloak MFA Support Verification";
  await ownerPage.getByRole("textbox", { name: "Organization name" }).fill(organizationName);
  const bootstrapResponse = ownerPage.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/recon/organizations",
  );
  await ownerPage.getByRole("button", { name: "Create" }).click();
  assertEqual((await bootstrapResponse).status(), 201, "owner organization bootstrap");
  await ownerPage.getByText(organizationName, { exact: true }).first().waitFor();
  const organization = requiredRow(
    await inspectionDatabase`
      select id, name
      from organizations
      where name = ${organizationName}
    `,
    "bootstrapped organization",
  );
  const organizationId = databaseUuid(organization, "id");
  reportPhase("tenant owner authenticated and bootstrapped an organization");

  const supportTotpEnrollment = await enrollTotpThroughApplication(
    supportContext,
    keycloakOrigin,
    supportUsername,
    supportPassword,
    "Synthetic support verification authenticator",
    browserErrors,
  );
  const outsiderTotpEnrollment = await enrollTotpThroughApplication(
    outsiderContext,
    keycloakOrigin,
    outsiderUsername,
    outsiderPassword,
    "Synthetic outsider verification authenticator",
    browserErrors,
  );
  const supportTotpSecret = supportTotpEnrollment.secret;
  const outsiderTotpSecret = outsiderTotpEnrollment.secret;
  secrets.push(supportTotpSecret, outsiderTotpSecret);
  await supportContext.close();
  await outsiderContext.close();
  await configureKeycloakStepUpFlow(keycloakOrigin);
  await waitForUnusedTotpWindows([supportTotpEnrollment, outsiderTotpEnrollment]);
  reportPhase("native Keycloak LoA 2 password-plus-OTP browser flow bound to the realm");

  supportContext = await browser.newContext();
  outsiderContext = await browser.newContext();
  for (const context of [supportContext, outsiderContext]) {
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(30_000);
  }

  const supportPage = await supportContext.newPage();
  observeBrowserErrors(supportPage, browserErrors);
  await supportPage.goto(webOrigin);
  await startSignIn(supportPage, keycloakOrigin);
  await completePasswordLogin(supportPage, supportUsername, supportPassword);
  const otpInput = supportPage.locator("#otp");
  await otpInput.waitFor({ state: "visible", timeout: 30_000 });

  const preOtpSession = await supportContext.request.get(`${webOrigin}/api/auth/session`);
  assertEqual(preOtpSession.status(), 200, "pre-OTP browser session response");
  assertSessionAbsent(await preOtpSession.json(), "pre-OTP browser session");
  await otpInput.fill(wrongTotp(supportTotpSecret));
  const deniedOtpResponse = supportPage.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).origin === keycloakOrigin &&
      new URL(response.url()).pathname.includes("/login-actions/authenticate"),
  );
  await supportPage.locator("#kc-login").click();
  assertEqual((await deniedOtpResponse).status(), 200, "wrong-OTP Keycloak response");
  assert(
    new URL(supportPage.url()).origin === keycloakOrigin,
    "wrong OTP escaped the identity-provider boundary",
  );
  const wrongOtpSession = await supportContext.request.get(`${webOrigin}/api/auth/session`);
  assertEqual(wrongOtpSession.status(), 200, "wrong-OTP browser session response");
  assertSessionAbsent(await wrongOtpSession.json(), "wrong-OTP browser session");
  if (await supportPage.locator("#username").isVisible()) {
    await completePasswordLogin(supportPage, supportUsername, supportPassword);
    await otpInput.waitFor({ state: "visible", timeout: 30_000 });
  } else {
    await otpInput.waitFor({ state: "visible", timeout: 30_000 });
  }
  await otpInput.fill(currentTotp(supportTotpSecret));
  await supportPage.locator("#kc-login").click();
  await supportPage.waitForURL(`${webOrigin}/dashboard`, { timeout: 30_000 });
  await supportPage.goto(`${webOrigin}/support`);
  await supportPage.getByRole("heading", { name: "Restricted support console" }).waitFor();
  reportPhase("support identity completed password-plus-TOTP login after wrong-code denial");

  const supportSessionResponse = await supportContext.request.get(`${webOrigin}/api/auth/session`);
  assertEqual(supportSessionResponse.status(), 200, "support session response");
  const supportSessionText = await supportSessionResponse.text();
  assert(
    !/(apiAccessToken|apiRefreshToken|apiIdToken|access_token|refresh_token|id_token)/u.test(
      supportSessionText,
    ),
    "browser-readable support session disclosed a provider credential",
  );
  const supportCookies = await supportContext.cookies(webOrigin);
  const sessionCookies = supportCookies.filter(
    (cookie) =>
      cookie.name === "reconai.session-token" || /^reconai\.session-token\.\d+$/u.test(cookie.name),
  );
  assert(sessionCookies.length > 0, "support session cookie was not issued");
  assert(
    sessionCookies.every((cookie) => cookie.httpOnly),
    "support session cookie was not HttpOnly",
  );

  const createRequestResponse = supportPage.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/recon/support",
  );
  await supportPage.getByRole("button", { name: "Create approval request" }).click();
  assertEqual((await createRequestResponse).status(), 201, "support request creation");
  const requestCode = await supportPage
    .getByRole("textbox", { name: "One-time request code" })
    .inputValue();
  assert(
    /^[A-Za-z0-9_-]{43}$/u.test(requestCode),
    "support request did not expose one bounded transfer code",
  );

  await ownerPage.goto(`${webOrigin}/dashboard/security`);
  await ownerPage.getByRole("heading", { name: "Restricted support access" }).waitFor();
  await ownerPage.getByText("No restricted support grants", { exact: true }).waitFor();
  await ownerPage.getByLabel("One-time request code").fill(requestCode);
  const ticketReference = "SUP-KEYCLOAK-MFA-001";
  const approvalReason = "Verify bounded read-only diagnostics after live MFA authentication";
  await ownerPage.getByLabel("Support ticket reference").fill(ticketReference);
  await ownerPage.getByLabel("Approval reason · audit-visible").fill(approvalReason);
  await ownerPage
    .getByText(
      "I confirm this request belongs to the currently selected organization and may expose bounded operational aggregates for at most 60 minutes.",
      { exact: true },
    )
    .click();
  const approvalResponse = ownerPage.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/recon/actions",
  );
  await ownerPage.getByRole("button", { name: "Approve restricted access" }).click();
  assertEqual((await approvalResponse).status(), 201, "owner support approval");
  await ownerPage
    .getByText("Restricted diagnostic access approved and recorded in audit history.", {
      exact: true,
    })
    .waitFor();
  const grantRow = requiredRow(
    await inspectionDatabase`
      select
        id,
        support_identity_digest,
        status,
        ticket_reference
      from support_access_grants
      where organization_id = ${organizationId}
    `,
    "approved support grant",
  );
  const grantId = databaseUuid(grantRow, "id");
  assertEqual(grantRow["status"], "active", "approved grant status");
  assertEqual(grantRow["ticket_reference"], ticketReference, "grant ticket reference");
  reportPhase("organization owner approved the one-time request through the product UI");

  await supportPage.getByLabel("Organization ID").fill(organizationId);
  await supportPage.getByLabel("Grant ID").fill(grantId);
  const diagnosticsResponse = supportPage.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/recon/support",
  );
  await supportPage.getByRole("button", { name: "Load approved diagnostics" }).click();
  assertEqual((await diagnosticsResponse).status(), 200, "approved diagnostics read");
  await supportPage.getByRole("heading", { name: "Diagnostic ledger" }).waitFor();
  for (const label of [
    "Connections",
    "Provider syncs",
    "Reconciliations",
    "Exceptions",
    "Outbox",
  ]) {
    await supportPage.getByText(label, { exact: true }).waitFor();
  }
  assert(
    !(await supportPage.locator("body").innerText()).includes(organizationName),
    "support diagnostics console disclosed the organization name",
  );
  reportPhase("approved support identity read only the fixed aggregate diagnostic schema");

  const outsiderPage = await outsiderContext.newPage();
  observeBrowserErrors(outsiderPage, browserErrors);
  await outsiderPage.goto(webOrigin);
  await startSignIn(outsiderPage, keycloakOrigin);
  await completePasswordLogin(outsiderPage, outsiderUsername, outsiderPassword);
  await outsiderPage.locator("#otp").fill(currentTotp(outsiderTotpSecret));
  await outsiderPage.locator("#kc-login").click();
  await outsiderPage.waitForURL(`${webOrigin}/dashboard`, { timeout: 30_000 });
  await outsiderPage.goto(`${webOrigin}/support`);
  const supportRequestCountBeforeOutsider = Number(
    (await inspectionDatabase`select count(*)::integer as count from support_access_requests`)[0]?.[
      "count"
    ],
  );
  const outsiderRequestResponse = outsiderPage.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/recon/support",
  );
  await outsiderPage.getByRole("button", { name: "Create approval request" }).click();
  assertEqual((await outsiderRequestResponse).status(), 404, "non-support group denial");
  await outsiderPage
    .getByText("A restricted support request could not be created.", { exact: true })
    .waitFor();
  const supportRequestCountAfterOutsider = Number(
    (await inspectionDatabase`select count(*)::integer as count from support_access_requests`)[0]?.[
      "count"
    ],
  );
  assertEqual(
    supportRequestCountAfterOutsider,
    supportRequestCountBeforeOutsider,
    "outsider support request persistence",
  );
  reportPhase("valid non-support identity was denied without creating durable state");

  const grantRecord = ownerPage.locator("article.support-grant-record", {
    hasText: ticketReference,
  });
  const revocationReason = "Live verification confirms immediate authority revocation";
  await grantRecord.getByLabel("Revocation reason · audit-visible").fill(revocationReason);
  await grantRecord
    .getByText("I confirm this grant must no longer authorize diagnostics.", { exact: true })
    .click();
  const revocationResponse = ownerPage.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/recon/actions",
  );
  await grantRecord.getByRole("button", { name: "Revoke access" }).click();
  assertEqual((await revocationResponse).status(), 200, "owner support revocation");
  await ownerPage
    .getByText("Restricted diagnostic access revoked and recorded in audit history.", {
      exact: true,
    })
    .waitFor();

  await supportPage.reload();
  await supportPage.getByRole("heading", { name: "Restricted support console" }).waitFor();
  await supportPage.getByLabel("Organization ID").fill(organizationId);
  await supportPage.getByLabel("Grant ID").fill(grantId);
  const revokedDiagnosticsResponse = supportPage.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/recon/support",
  );
  await supportPage.getByRole("button", { name: "Load approved diagnostics" }).click();
  assertEqual((await revokedDiagnosticsResponse).status(), 404, "revoked diagnostics denial");
  await supportPage
    .getByText(
      "Diagnostics are unavailable. Verify the approved identifiers and grant state in the authenticated support ticket.",
      { exact: true },
    )
    .waitFor();
  reportPhase("revocation immediately removed diagnostic authority with a uniform denial");

  const persistence = requiredRow(
    await inspectionDatabase`
      select
        (select count(*)::integer from organizations) as organizations,
        (select count(*)::integer from memberships) as memberships,
        (select count(*)::integer from support_access_requests) as support_requests,
        (select count(*)::integer from support_access_grants) as support_grants,
        (select count(*)::integer from users where email = ${supportUsername}) as support_users,
        (
          select count(*)::integer
          from support_access_requests
          where claimed_at is not null
            and claimed_grant_id = ${grantId}
        ) as claimed_requests,
        (
          select count(*)::integer
          from support_access_grants
          where id = ${grantId}
            and organization_id = ${organizationId}
            and status = 'revoked'
            and revoked_at is not null
        ) as revoked_grants
    `,
    "terminal support state",
  );
  assertEqual(Number(persistence["organizations"]), 1, "organization count");
  assertEqual(Number(persistence["memberships"]), 1, "membership count");
  assertEqual(Number(persistence["support_requests"]), 1, "support request count");
  assertEqual(Number(persistence["support_grants"]), 1, "support grant count");
  assertEqual(Number(persistence["support_users"]), 0, "support identity tenant user count");
  assertEqual(Number(persistence["claimed_requests"]), 1, "claimed request count");
  assertEqual(Number(persistence["revoked_grants"]), 1, "revoked grant count");

  const supportRequestRow = requiredRow(
    await inspectionDatabase`
      select support_identity_digest, request_token_sha256
      from support_access_requests
    `,
    "support request persistence",
  );
  for (const field of ["support_identity_digest", "request_token_sha256"]) {
    assert(
      /^[a-f0-9]{64}$/u.test(String(supportRequestRow[field])),
      `${field} was not a SHA-256-shaped digest`,
    );
  }
  assertEqual(
    supportRequestRow["support_identity_digest"],
    grantRow["support_identity_digest"],
    "request/grant support identity binding",
  );
  const supportTableColumns = (
    await inspectionDatabase`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('support_access_requests', 'support_access_grants')
    `
  ).map((row) => `${String(row["table_name"])}.${String(row["column_name"])}`);
  assert(
    supportTableColumns.every(
      (column) => !/(issuer|subject|email|username|access_token|refresh_token)/u.test(column),
    ),
    "support persistence schema contained a raw identity or token column",
  );

  const auditRows = await inspectionDatabase`
    select
      action,
      actor_type,
      resource_id,
      event_hash,
      previous_event_hash,
      hash_version,
      reason
    from audit_events
    where organization_id = ${organizationId}
      and action in (
        'support.access.approved',
        'support.diagnostics.viewed',
        'support.access.revoked'
      )
    order by occurred_at, id
  `;
  assertEqual(auditRows.length, 3, "support audit event count");
  assertJsonEqual(
    auditRows.map((row) => row["action"]),
    ["support.access.approved", "support.diagnostics.viewed", "support.access.revoked"],
    "support audit actions",
  );
  assert(
    auditRows.every(
      (row) =>
        row["hash_version"] === 2 &&
        /^[a-f0-9]{64}$/u.test(String(row["event_hash"])) &&
        row["resource_id"] === grantId,
    ),
    "support audit events lacked v2 hash/resource authority",
  );
  const completeAuditRows = await inspectionDatabase`
    select event_hash, previous_event_hash
    from audit_events
    where organization_id = ${organizationId}
    order by occurred_at, id
  `;
  assert(
    completeAuditRows.length >= auditRows.length + 1,
    "complete tenant audit chain omitted the bootstrap predecessor",
  );
  assertLinearAuditChain(completeAuditRows);

  const restrictedDatabase = postgres(applicationDatabaseUrl, { max: 1 });
  const tenantlessCounts = requiredRow(
    await restrictedDatabase`
      select
        (select count(*)::integer from organizations) as organizations,
        (select count(*)::integer from memberships) as memberships,
        (select count(*)::integer from audit_events) as audit_events
    `,
    "tenantless application-role counts",
  );
  await restrictedDatabase.end({ timeout: 5 });
  assertEqual(Number(tenantlessCounts["organizations"]), 0, "tenantless organizations");
  assertEqual(Number(tenantlessCounts["memberships"]), 0, "tenantless memberships");
  assertEqual(Number(tenantlessCounts["audit_events"]), 0, "tenantless audit events");

  assertJsonEqual(browserErrors, [], "browser console/page errors");
  const postgresqlVersion = String(
    requiredRow(await inspectionDatabase`select version() as version`, "PostgreSQL version")[
      "version"
    ],
  )
    .split(" ")
    .slice(0, 2)
    .join(" ");
  const browserVersion = await browser.version();
  const sourceHashes = {
    verifierSha256: await sha256File(
      join(repositoryRoot, "scripts", "verify-live-oidc-support.mjs"),
    ),
    apiHarnessSha256: await sha256File(
      join(repositoryRoot, "scripts", "live-support-api-harness.mjs"),
    ),
  };

  const evidence = {
    schemaVersion: "reconai-verification-v1",
    verification: "live-keycloak-restricted-support-mfa",
    result: "passed",
    generatedAt: new Date().toISOString(),
    scope: {
      customerDataUsed: false,
      providerSystemsContacted: false,
      productionSystemsContacted: false,
      topology: "isolated loopback host processes",
    },
    runtime: {
      keycloakVersion,
      javaRuntime: "Eclipse Temurin OpenJDK 21.0.11+10",
      postgresqlVersion,
      browserVersion,
      appliedMigrations: migrationCount,
      sourceHashes,
    },
    identityAssurance: {
      supportGroup,
      acceptedAuthenticationContext: supportAuthenticationContext,
      supportPasswordChallengeCompleted: true,
      supportTotpChallengeCompleted: true,
      wrongTotpDeniedBeforeApplicationSession: true,
      preTotpApplicationSessionAbsent: true,
      nonSupportGroupIdentityDenied: true,
      nonSupportDenialCreatedDurableRequest: false,
      supportIdentityHadTenantMembership: false,
      authenticationContextMapper:
        "Keycloak native acr loa level mapper emitted the achieved LoA 2",
    },
    productJourney: {
      ownerBootstrapStatus: 201,
      supportRequestStatus: 201,
      ownerApprovalStatus: 201,
      diagnosticsStatus: 200,
      ownerRevocationStatus: 200,
      revokedDiagnosticsStatus: 404,
      outsiderRequestStatus: 404,
      fixedDiagnosticSections: 5,
      organizationNameDisclosedToSupportConsole: false,
      browserReadableProviderCredentialDisclosed: false,
      supportSessionCookieHttpOnly: true,
    },
    persistence: {
      organizations: Number(persistence["organizations"]),
      tenantMemberships: Number(persistence["memberships"]),
      supportRequests: Number(persistence["support_requests"]),
      supportGrants: Number(persistence["support_grants"]),
      requestClaimedExactlyOnce: Number(persistence["claimed_requests"]) === 1,
      terminalGrantStatus: "revoked",
      identityAndRequestValuesPersistedAsDigests: true,
      rawSupportIdentityColumnsPresent: false,
      supportAuditActions: auditRows.map((row) => row["action"]),
      supportAuditHashVersion: 2,
      supportAuditLinearChain: true,
      tenantlessApplicationRoleCounts: {
        organizations: Number(tenantlessCounts["organizations"]),
        memberships: Number(tenantlessCounts["memberships"]),
        auditEvents: Number(tenantlessCounts["audit_events"]),
      },
    },
    controlsExercised: [
      "real RS256 Keycloak token verification with exact issuer and audience",
      "real Keycloak group claim and exact authentication-context authorization",
      "password-plus-TOTP support authentication with wrong-code negative path",
      "organization-blind request creation and owner-controlled one-time approval",
      "fixed aggregate-only diagnostics and immediate revocation",
      "digest-only support identity persistence and v2 append-only audit chain",
      "tenantless restricted-role RLS checks",
    ],
    limitations: [
      "This is one isolated local Keycloak, PostgreSQL, API, web, and Chromium exercise over loopback HTTP; it is not staging or production identity evidence.",
      "The verifier configures Keycloak's native LoA 2 browser flow and requests acr_values=2. The API independently requires the exact signed acr, but this local run does not prove production IdP policy governance, recovery flows, administrator-bypass resistance, or configuration drift detection.",
      "The run does not exercise TLS ingress, multiple application replicas, hosted ticket-system integration, support offboarding, device binding, WebAuthn, recovery codes, alert delivery, or managed infrastructure.",
      "No raw password, TOTP secret, client secret, provider token, session token, request code, database credential, identity digest, customer payload, or production identifier is recorded.",
    ],
    credentialsRecorded: false,
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  const diagnostics = children
    .map((child) => `${child.label}:\n${sanitizedTail(child.output)}`)
    .join("\n");
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${sanitize(message)}${diagnostics ? `\n${diagnostics}\n` : "\n"}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}

async function startPostgres(port) {
  await mkdir(postgresSocket, { recursive: true });
  await runCommand(
    "PostgreSQL initdb",
    join(postgresBin, "initdb"),
    [
      "--no-locale",
      "--encoding=UTF8",
      "--auth-local=trust",
      "--auth-host=scram-sha-256",
      "--username=postgres",
      "-D",
      postgresData,
    ],
    process.env,
  );
  await runCommand(
    "PostgreSQL start",
    join(postgresBin, "pg_ctl"),
    [
      "-D",
      postgresData,
      "-o",
      `-h 127.0.0.1 -p ${String(port)} -k ${postgresSocket}`,
      "-w",
      "start",
    ],
    process.env,
  );
}

async function initializeDatabase(port) {
  const rolesFile = join(runtime, "roles.sql");
  await writeFile(
    rolesFile,
    [
      "\\set ON_ERROR_STOP on",
      `ALTER ROLE postgres PASSWORD '${databasePasswords.administrator}';`,
      `CREATE ROLE reconai_migrator LOGIN PASSWORD '${databasePasswords.migrator}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;`,
      `CREATE ROLE reconai_app LOGIN PASSWORD '${databasePasswords.application}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`,
      `CREATE ROLE reconai_worker LOGIN PASSWORD '${databasePasswords.worker}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`,
      `CREATE ROLE reconai_maintenance LOGIN PASSWORD '${databasePasswords.maintenance}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`,
      "CREATE DATABASE reconai;",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  await runCommand(
    "PostgreSQL role creation",
    join(postgresBin, "psql"),
    ["-h", postgresSocket, "-p", String(port), "-U", "postgres", "-d", "postgres", "-f", rolesFile],
    process.env,
  );

  const grantsFile = join(runtime, "grants.sql");
  await writeFile(
    grantsFile,
    [
      "\\set ON_ERROR_STOP on",
      "GRANT CONNECT ON DATABASE reconai TO reconai_migrator, reconai_app, reconai_worker, reconai_maintenance;",
      "GRANT CREATE, USAGE ON SCHEMA public TO reconai_migrator;",
      "GRANT USAGE ON SCHEMA public TO reconai_app, reconai_worker, reconai_maintenance;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE reconai_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO reconai_app;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE reconai_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO reconai_app;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE reconai_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO reconai_worker;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE reconai_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO reconai_worker;",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  await runCommand(
    "PostgreSQL grants",
    join(postgresBin, "psql"),
    ["-h", postgresSocket, "-p", String(port), "-U", "postgres", "-d", "reconai", "-f", grantsFile],
    process.env,
  );
}

async function prepareKeycloakRealm() {
  await cp(keycloakHome, keycloakRuntime, { recursive: true });
  const importDirectory = join(keycloakRuntime, "data", "import");
  await mkdir(importDirectory, { recursive: true });
  const realm = {
    realm: realmName,
    enabled: true,
    displayName: "ReconAI restricted support verification",
    registrationAllowed: false,
    resetPasswordAllowed: false,
    rememberMe: false,
    verifyEmail: true,
    bruteForceProtected: true,
    accessTokenLifespan: 300,
    ssoSessionIdleTimeout: 600,
    ssoSessionMaxLifespan: 1800,
    otpPolicyType: "totp",
    otpPolicyAlgorithm: "HmacSHA1",
    otpPolicyDigits: 6,
    otpPolicyPeriod: 30,
    clients: [
      {
        clientId,
        name: "ReconAI restricted support verification",
        enabled: true,
        clientAuthenticatorType: "client-secret",
        secret: clientSecret,
        standardFlowEnabled: true,
        directAccessGrantsEnabled: false,
        publicClient: false,
        frontchannelLogout: false,
        redirectUris: [`${webOrigin}/api/auth/callback/keycloak`],
        webOrigins: [webOrigin],
        attributes: {
          "pkce.code.challenge.method": "S256",
          "post.logout.redirect.uris": `${webOrigin}/`,
        },
        protocol: "openid-connect",
        protocolMappers: [
          {
            name: "ReconAI API audience",
            protocol: "openid-connect",
            protocolMapper: "oidc-audience-mapper",
            consentRequired: false,
            config: {
              "included.client.audience": clientId,
              "access.token.claim": "true",
              "id.token.claim": "false",
            },
          },
          {
            name: "ReconAI group membership",
            protocol: "openid-connect",
            protocolMapper: "oidc-group-membership-mapper",
            consentRequired: false,
            config: {
              "full.path": "true",
              "claim.name": "groups",
              "access.token.claim": "true",
              "id.token.claim": "true",
              "userinfo.token.claim": "true",
            },
          },
        ],
      },
    ],
    groups: [{ name: basename(supportGroup) }],
    users: [
      keycloakUser(
        "00000000-0000-4000-8000-000000000101",
        ownerUsername,
        "Synthetic",
        "Owner",
        ownerPassword,
      ),
      {
        ...keycloakUser(
          "00000000-0000-4000-8000-000000000102",
          supportUsername,
          "Synthetic",
          "Support",
          supportPassword,
        ),
        groups: [supportGroup],
        requiredActions: ["CONFIGURE_TOTP"],
      },
      {
        ...keycloakUser(
          "00000000-0000-4000-8000-000000000103",
          outsiderUsername,
          "Synthetic",
          "Outsider",
          outsiderPassword,
        ),
        requiredActions: ["CONFIGURE_TOTP"],
      },
    ],
  };
  await writeFile(
    join(importDirectory, `${realmName}-realm.json`),
    `${JSON.stringify(realm, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function keycloakUser(id, username, firstName, lastName, password) {
  return {
    id,
    username,
    email: username,
    emailVerified: true,
    enabled: true,
    firstName,
    lastName,
    credentials: [passwordCredential(password)],
  };
}

function passwordCredential(value) {
  return { type: "password", value, temporary: false };
}

async function enrollTotpThroughApplication(
  context,
  keycloakOrigin,
  username,
  password,
  deviceLabel,
  browserErrors,
) {
  const page = await context.newPage();
  observeBrowserErrors(page, browserErrors);
  await page.goto(webOrigin);
  await startSignIn(page, keycloakOrigin);
  await completePasswordLogin(page, username, password);
  await page.locator("#kc-totp-settings-form").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.locator("#mode-manual").click();
  const secret = (await page.locator("#kc-totp-secret-key").innerText()).replaceAll(/\s/gu, "");
  assert(/^[A-Z2-7]{16,128}$/u.test(secret), "Keycloak manual TOTP secret was not bounded base32");
  const enrollmentCode = currentTotp(secret);
  await page.locator("#totp").fill(enrollmentCode);
  await page.locator("#userLabel").fill(deviceLabel);
  await page.locator("#saveTOTPBtn").click();
  await page.waitForURL(`${webOrigin}/dashboard`, { timeout: 30_000 });
  return { secret, enrollmentCode };
}

async function waitForUnusedTotpWindows(enrollments) {
  const deadline = Date.now() + 35_000;
  while (enrollments.some(({ secret, enrollmentCode }) => currentTotp(secret) === enrollmentCode)) {
    if (Date.now() >= deadline) {
      throw new Error("a fresh TOTP window did not begin within the bounded wait");
    }
    await nodeSetTimeout(250);
  }
}

async function configureKeycloakStepUpFlow(keycloakOrigin) {
  const tokenResponse = await fetch(
    `${keycloakOrigin}/realms/master/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new globalThis.URLSearchParams({
        client_id: "admin-cli",
        grant_type: "password",
        username: "admin",
        password: keycloakAdminPassword,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    },
  );
  assertEqual(tokenResponse.status, 200, "Keycloak bootstrap administrator token");
  const tokenBody = await tokenResponse.json();
  assert(
    isRecord(tokenBody) &&
      typeof tokenBody["access_token"] === "string" &&
      tokenBody["access_token"].length > 100,
    "Keycloak bootstrap administrator token response was invalid",
  );
  const adminToken = tokenBody["access_token"];
  secrets.push(adminToken);

  const topFlow = "ReconAI browser step-up";
  const authenticationFlow = "ReconAI authentication";
  const levelOneFlow = "ReconAI LoA 1";
  const levelTwoFlow = "ReconAI LoA 2";
  await keycloakAdminJson(keycloakOrigin, adminToken, "POST", "/authentication/flows", 201, {
    alias: topFlow,
    description: "Synthetic verification flow with native Keycloak LoA conditions",
    providerId: "basic-flow",
    topLevel: true,
    builtIn: false,
  });
  await addFlowExecution(keycloakOrigin, adminToken, topFlow, "auth-cookie", "ALTERNATIVE");
  await addSubflow(keycloakOrigin, adminToken, topFlow, authenticationFlow, "ALTERNATIVE");
  await addSubflow(keycloakOrigin, adminToken, authenticationFlow, levelOneFlow, "CONDITIONAL");
  await addLoaCondition(
    keycloakOrigin,
    adminToken,
    levelOneFlow,
    "ReconAI LoA 1 condition",
    "1",
    "36000",
  );
  await addFlowExecution(
    keycloakOrigin,
    adminToken,
    levelOneFlow,
    "auth-username-password-form",
    "REQUIRED",
  );
  await addSubflow(keycloakOrigin, adminToken, authenticationFlow, levelTwoFlow, "CONDITIONAL");
  await addLoaCondition(
    keycloakOrigin,
    adminToken,
    levelTwoFlow,
    "ReconAI LoA 2 condition",
    "2",
    "0",
  );
  await addFlowExecution(keycloakOrigin, adminToken, levelTwoFlow, "auth-otp-form", "REQUIRED");

  const realm = await keycloakAdminJson(keycloakOrigin, adminToken, "GET", "", 200);
  assert(isRecord(realm), "Keycloak realm representation was invalid");
  await keycloakAdminJson(keycloakOrigin, adminToken, "PUT", "", 204, {
    ...realm,
    browserFlow: topFlow,
  });
  const reboundRealm = await keycloakAdminJson(keycloakOrigin, adminToken, "GET", "", 200);
  assert(
    isRecord(reboundRealm) && reboundRealm["browserFlow"] === topFlow,
    "Keycloak native step-up browser flow was not bound",
  );
}

async function addSubflow(keycloakOrigin, adminToken, parentAlias, childAlias, requirement) {
  await keycloakAdminJson(
    keycloakOrigin,
    adminToken,
    "POST",
    `/authentication/flows/${encodeURIComponent(parentAlias)}/executions/flow`,
    201,
    {
      alias: childAlias,
      type: "basic-flow",
      provider: "registration-page-form",
      description: "",
    },
  );
  const execution = await flowExecution(
    keycloakOrigin,
    adminToken,
    parentAlias,
    (candidate) => candidate["displayName"] === childAlias,
    `subflow ${childAlias}`,
  );
  await setFlowExecutionRequirement(
    keycloakOrigin,
    adminToken,
    parentAlias,
    execution,
    requirement,
  );
}

async function addFlowExecution(keycloakOrigin, adminToken, flowAlias, provider, requirement) {
  await keycloakAdminJson(
    keycloakOrigin,
    adminToken,
    "POST",
    `/authentication/flows/${encodeURIComponent(flowAlias)}/executions/execution`,
    201,
    { provider },
  );
  const execution = await flowExecution(
    keycloakOrigin,
    adminToken,
    flowAlias,
    (candidate) => candidate["providerId"] === provider,
    `execution ${provider}`,
  );
  await setFlowExecutionRequirement(keycloakOrigin, adminToken, flowAlias, execution, requirement);
}

async function addLoaCondition(
  keycloakOrigin,
  adminToken,
  flowAlias,
  configAlias,
  level,
  maximumAge,
) {
  const provider = "conditional-level-of-authentication";
  await addFlowExecution(keycloakOrigin, adminToken, flowAlias, provider, "REQUIRED");
  const execution = await flowExecution(
    keycloakOrigin,
    adminToken,
    flowAlias,
    (candidate) => candidate["providerId"] === provider,
    `${configAlias} execution`,
  );
  const executionId = execution["id"];
  assert(typeof executionId === "string", `${configAlias} execution omitted its ID`);
  await keycloakAdminJson(
    keycloakOrigin,
    adminToken,
    "POST",
    `/authentication/executions/${encodeURIComponent(executionId)}/config`,
    201,
    {
      alias: configAlias,
      config: {
        "loa-condition-level": level,
        "loa-max-age": maximumAge,
      },
    },
  );
}

async function flowExecution(keycloakOrigin, adminToken, flowAlias, predicate, label) {
  const executions = await keycloakAdminJson(
    keycloakOrigin,
    adminToken,
    "GET",
    `/authentication/flows/${encodeURIComponent(flowAlias)}/executions`,
    200,
  );
  assert(Array.isArray(executions), `${flowAlias} executions response was invalid`);
  const execution = executions.find((candidate) => isRecord(candidate) && predicate(candidate));
  assert(isRecord(execution), `${label} was not present in ${flowAlias}`);
  return execution;
}

async function setFlowExecutionRequirement(
  keycloakOrigin,
  adminToken,
  flowAlias,
  execution,
  requirement,
) {
  await keycloakAdminJson(
    keycloakOrigin,
    adminToken,
    "PUT",
    `/authentication/flows/${encodeURIComponent(flowAlias)}/executions`,
    204,
    { ...execution, requirement },
  );
}

async function keycloakAdminJson(keycloakOrigin, adminToken, method, path, expectedStatus, body) {
  const response = await fetch(
    `${keycloakOrigin}/admin/realms/${encodeURIComponent(realmName)}${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${adminToken}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status !== expectedStatus) {
    const responseText = sanitize((await response.text()).slice(0, 2_000));
    throw new Error(
      `Keycloak Admin REST ${method} ${path || "/"}: expected ${String(
        expectedStatus,
      )}, received ${String(response.status)}${responseText ? `: ${responseText}` : ""}`,
    );
  }
  if (expectedStatus === 204 || response.headers.get("content-length") === "0") {
    return undefined;
  }
  return response.json();
}

async function startSignIn(page, keycloakOrigin) {
  const signInButton = page.getByRole("button", { name: "Sign in securely" });
  await signInButton.waitFor({ state: "visible" });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const initiation = page
      .waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/auth/signin/keycloak",
        { timeout: 5_000 },
      )
      .catch(() => undefined);
    await signInButton.click({ noWaitAfter: true });
    const response = await initiation;
    if (!response) {
      await page.waitForTimeout(attempt * 250);
      continue;
    }
    assertEqual(response.status(), 200, "OIDC sign-in initiation");
    await page.waitForURL((url) => url.origin === keycloakOrigin, { timeout: 30_000 });
    return;
  }
  throw new Error("OIDC sign-in initiation did not leave the application origin");
}

async function completePasswordLogin(page, username, password) {
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
}

function currentTotp(secret) {
  const counter = Math.floor(Date.now() / 1000 / 30);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counterBytes).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
}

function wrongTotp(secret) {
  const valid = currentTotp(secret);
  return valid === "000000" ? "000001" : "000000";
}

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let accumulator = 0;
  const bytes = [];
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("generated TOTP secret was not base32");
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function generatedPassword() {
  return `Local-${randomBytes(24).toString("base64url")}!`;
}

function assertSessionAbsent(value, label) {
  assert(
    isRecord(value) && Object.keys(value).length === 0,
    `${label} existed before successful callback completion`,
  );
}

function assertLinearAuditChain(rows) {
  const byHash = new Map(rows.map((row) => [String(row["event_hash"]), row]));
  const genesis = rows.filter((row) => row["previous_event_hash"] === null);
  assertEqual(genesis.length, 1, "support audit genesis count");
  let current = genesis[0];
  let visited = 0;
  while (current) {
    visited += 1;
    const next = rows.find((row) => row["previous_event_hash"] === current?.["event_hash"]);
    current = next;
  }
  assertEqual(visited, byHash.size, "support audit chain coverage");
}

async function assertOidcDiscovery(issuer) {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  assertEqual(response.status, 200, "OIDC discovery status");
  const body = await response.json();
  assert(isRecord(body), "OIDC discovery body was not an object");
  assertEqual(body["issuer"], issuer, "OIDC discovery issuer");
  for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    const value = body[field];
    assert(typeof value === "string", `OIDC discovery omitted ${field}`);
    const url = new URL(value);
    assert(
      url.hostname === "127.0.0.1" && url.protocol === "http:",
      `OIDC discovery ${field} was not loopback HTTP`,
    );
  }
}

function observeBrowserErrors(page, errors) {
  page.on("pageerror", (error) => {
    errors.push(`page:${sanitize(error.message)}`);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = sanitize(message.text());
    if (isExpectedNegativeHttpConsoleError(text)) return;
    errors.push(`console:${text}`);
  });
}

function isExpectedNegativeHttpConsoleError(message) {
  return /^Failed to load resource: the server responded with a status of (?:404 \(Not Found\)|409 \(Conflict\))$/u.test(
    message,
  );
}

function startChild(label, command, arguments_, environment) {
  const child = spawn(command, arguments_, {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = { label, child, output: "" };
  const append = (chunk) => {
    record.output = `${record.output}${chunk.toString("utf8")}`.slice(-32_768);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return record;
}

async function stopChild(record) {
  if (record.child.exitCode !== null || record.child.signalCode !== null) return;
  record.child.kill("SIGTERM");
  const stopped = await Promise.race([
    new Promise((resolveStopped) => record.child.once("exit", () => resolveStopped(true))),
    nodeSetTimeout(5_000).then(() => false),
  ]);
  if (!stopped && record.child.exitCode === null) {
    record.child.kill("SIGKILL");
    await new Promise((resolveStopped) => record.child.once("exit", resolveStopped));
  }
}

async function runCommand(label, command, arguments_, environment) {
  await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-32_768);
    });
    child.stderr.on("data", (chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-32_768);
    });
    child.once("error", rejectCommand);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      rejectCommand(new Error(`${label} failed (${signal ?? String(code)}):\n${sanitize(output)}`));
    });
  });
}

async function waitForHttp(url, childRecords, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastStatus;
  while (Date.now() < deadline) {
    for (const record of childRecords) {
      if (record.child.exitCode !== null) {
        throw new Error(
          `${record.label} exited before ${url} became ready:\n${sanitizedTail(record.output)}`,
        );
      }
    }
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(1_000),
      });
      lastStatus = response.status;
      if (response.status >= 200 && response.status < 500) return;
    } catch {
      // The bounded readiness loop retries until the deadline.
    }
    await nodeSetTimeout(250);
  }
  throw new Error(`${url} did not become ready; last status ${String(lastStatus)}`);
}

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  await Promise.all(
    [ownerContext, supportContext, outsiderContext]
      .filter(Boolean)
      .map((context) => context.close().catch(() => undefined)),
  );
  await browser?.close().catch(() => undefined);
  await inspectionDatabase?.end({ timeout: 5 }).catch(() => undefined);
  await Promise.all(children.reverse().map((child) => stopChild(child)));
  if (postgresStarted) {
    await runCommand(
      "PostgreSQL stop",
      join(postgresBin, "pg_ctl"),
      ["-D", postgresData, "-m", "fast", "-w", "stop"],
      process.env,
    );
    postgresStarted = false;
  }
  if (runtime.startsWith(join(runtimeRoot, "reconai-oidc-support-"))) {
    await rm(runtime, { recursive: true, force: true });
  }
  reportPhase("isolated runtime cleanup completed");
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("could not allocate a loopback port");
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return address.port;
}

async function assertTcpPortAvailable(port, label) {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", () => rejectListen(new Error(`${label} port ${String(port)} is in use`)));
    server.listen(port, "127.0.0.1", () => {
      server.removeAllListeners("error");
      resolveListen();
    });
  });
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function requiredDirectory(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  const directory = resolve(value);
  return access(directory).then(
    () => directory,
    () => {
      throw new Error(`${name} does not identify a readable directory`);
    },
  );
}

function requiredRow(rows, label) {
  const row = rows[0];
  if (!row) throw new Error(`${label} returned no row`);
  return row;
}

function databaseUuid(row, field) {
  const value = row[field];
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error(`${field} was not a UUID`);
  }
  return value;
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual === expected) return;
  throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
}

function assertJsonEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (safeTextEqual(actualJson, expectedJson)) return;
  throw new Error(`${label}: expected ${expectedJson}, received ${actualJson}`);
}

function safeTextEqual(left, right) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportPhase(phase) {
  process.stderr.write(`[live-oidc-support] ${phase}\n`);
}

function sanitize(value) {
  let sanitized = String(value);
  for (const secret of secrets) {
    sanitized = sanitized.replaceAll(secret, "<redacted>");
  }
  return sanitized
    .replace(/(authorization:\s*Bearer\s+)[^\s]+/giu, "$1<redacted>")
    .replace(/(code=)[^&\s]+/giu, "$1<redacted>");
}

function sanitizedTail(value) {
  return sanitize(value.slice(-8_192));
}
