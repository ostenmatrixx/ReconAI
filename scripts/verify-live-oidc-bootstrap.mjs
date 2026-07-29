import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { setTimeout as nodeSetTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const requireFromWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));
const postgres = (await import(requireFromApi.resolve("postgres"))).default;
const playwright = await import(requireFromWeb.resolve("@playwright/test"));
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (!chromium) throw new Error("Playwright Chromium runtime is unavailable");
const expectedMigrationCount = (
  await readdir(new URL("../packages/database/migrations/", import.meta.url))
).filter((file) => /^\d{4}_.+\.sql$/u.test(file)).length;
if (expectedMigrationCount < 1) throw new Error("no database migrations were discovered");

const realmFixture = JSON.parse(
  await readFile(
    new URL("../infra/keycloak/reconai-development-realm.json", import.meta.url),
    "utf8",
  ),
);
const ownerFixture = requiredFixtureUser("owner@example.test");
const reviewerFixture = requiredFixtureUser("reviewer@example.test");
const ownerUsername = ownerFixture.username;
const reviewerUsername = reviewerFixture.username;
if (ownerUsername === reviewerUsername) {
  throw new Error("the synthetic owner and reviewer identities must be distinct");
}

const webOrigin = "http://localhost:3000";
const apiOrigin = "http://127.0.0.1:4000";
const emailRelayOrigin = "http://127.0.0.1:58100";
const emailRelayToken = randomBytes(32).toString("base64url");
const failedDeliveryEmail = "relay-failure@example.test";
const oidcIssuer = requiredLoopbackIssuer("OIDC_ISSUER");
const sessionSecret = requiredEnvironment("SESSION_SECRET");
if (sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET must contain at least 32 characters");
}

const environment = {
  ...process.env,
  NODE_ENV: "development",
  APP_ENV: "live-oidc-bootstrap",
  WEB_ORIGIN: webOrigin,
  NEXTAUTH_URL: webOrigin,
  API_ORIGIN: apiOrigin,
  WEB_PORT: "3000",
  API_HOST: "127.0.0.1",
  API_PORT: "4000",
  OIDC_ISSUER: oidcIssuer,
  OIDC_CLIENT_ID: process.env["OIDC_CLIENT_ID"] ?? "reconai-web-development",
  OIDC_CLIENT_SECRET: process.env["OIDC_CLIENT_SECRET"] ?? "local-oidc-secret-only",
  OIDC_ID_TOKEN_SIGNING_ALGORITHM: "RS256",
  SESSION_SECRET: sessionSecret,
  SESSION_COOKIE_SECURE: "false",
  SESSION_REVOCATION_STORE: "local",
  API_RATE_LIMIT_STORE: "local",
  API_RATE_LIMIT_KEY_SECRET: "",
  EMAIL_PROVIDER: "http_webhook",
  EMAIL_WEBHOOK_URL: `${emailRelayOrigin}/v1/invitations`,
  EMAIL_DELIVERY_TOKEN: emailRelayToken,
  EMAIL_FROM: "no-reply@example.test",
  EMAIL_REQUEST_TIMEOUT_MS: "2000",
  PROVIDER_GAP_REPAIR_ENABLED: "false",
  PROVIDER_PRIVACY_DEADLINE_MONITOR_ENABLED: "false",
  LOG_LEVEL: "error",
};

for (const name of [
  "DATABASE_URL",
  "DATABASE_WORKER_URL",
  "DATABASE_MIGRATION_URL",
  "DATABASE_ADMIN_URL",
  "REDIS_URL",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_FORCE_PATH_STYLE",
  "CONNECTOR_ENCRYPTION_KEYS",
  "CONNECTOR_ENCRYPTION_ACTIVE_KEY_VERSION",
]) {
  requiredEnvironment(name);
}
assertNonProductionLoopbackEnvironment(environment);

const children = [];
let browser;
let context;
let database;
let emailRelay;
let cleanupPromise;
const emailRelayRequests = [];
const emailRelayErrors = [];

const handleInterrupt = () => {
  void terminateFromSignal("SIGINT");
};
const handleTermination = () => {
  void terminateFromSignal("SIGTERM");
};
process.on("SIGINT", handleInterrupt);
process.on("SIGTERM", handleTermination);

try {
  await assertOidcDiscovery();
  reportPhase("OIDC discovery verified");
  await runCommand(
    "database migration",
    "pnpm",
    ["--filter", "@workspace/database", "db:migrate"],
    environment,
  );
  reportPhase("database migrated");

  database = postgres(environment.DATABASE_ADMIN_URL, { max: 2 });
  const initial = numericRow(
    requiredRow(
      await database`
        select
          (select count(*)::integer from reconai_schema_migrations) as migrations,
          (select count(*)::integer from organizations) as organizations,
          (select count(*)::integer from users) as users,
          (select count(*)::integer from memberships) as memberships,
          (select count(*)::integer from organization_bootstrap_requests) as bootstrap_requests,
          (select count(*)::integer from audit_events) as audit_events
      `,
      "initial database counts",
    ),
  );
  assertEqual(initial.migrations, expectedMigrationCount, "migration count");
  for (const field of [
    "organizations",
    "users",
    "memberships",
    "bootstrap_requests",
    "audit_events",
  ]) {
    assertEqual(initial[field], 0, `initial ${field} count`);
  }

  await Promise.all([
    assertTcpPortAvailable("127.0.0.1", 4000, "API"),
    assertTcpPortAvailable("127.0.0.1", 3000, "web"),
    assertTcpPortAvailable("127.0.0.1", 58100, "email relay"),
  ]);
  emailRelay = await startInvitationEmailRelay();
  children.push(
    startChild("api", "pnpm", ["exec", "tsx", "--conditions=development", "apps/api/src/main.ts"]),
  );
  children.push(
    startChild("web", "pnpm", [
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
    ]),
  );
  await waitForHttp(`${apiOrigin}/health/live`, children, 30_000);
  await waitForHttp(webOrigin, children, 60_000);
  reportPhase("application processes ready");

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(30_000);
  const firstPage = await context.newPage();
  const browserErrors = [];
  observeBrowserErrors(firstPage, browserErrors);

  await firstPage.goto(webOrigin);
  await startFixtureSignInThroughUi(firstPage);
  await completeFixtureLogin(firstPage, ownerFixture, "/dashboard");
  await firstPage.getByText("No active memberships", { exact: true }).waitFor();
  reportPhase("verified identity reached empty-membership dashboard");

  const sessionResponse = await context.request.get(`${webOrigin}/api/auth/session`);
  assertEqual(sessionResponse.status(), 200, "browser session response");
  const sessionBody = await sessionResponse.text();
  assert(
    !/(apiAccessToken|apiRefreshToken|apiIdToken|access_token|refresh_token)/u.test(sessionBody),
    "browser-readable session disclosed a provider credential field",
  );

  const secondPage = await context.newPage();
  observeBrowserErrors(secondPage, browserErrors);
  await secondPage.goto(`${webOrigin}/dashboard`);
  await secondPage.getByText("No active memberships", { exact: true }).waitFor();
  reportPhase("second same-session tab reached empty-membership dashboard");

  const names = ["OIDC Concurrent Tenant A", "OIDC Concurrent Tenant B"];
  await firstPage.getByRole("textbox", { name: "Organization name" }).fill(names[0]);
  await secondPage.getByRole("textbox", { name: "Organization name" }).fill(names[1]);

  const firstResponsePromise = waitForBootstrapResponse(firstPage);
  const secondResponsePromise = waitForBootstrapResponse(secondPage);
  await Promise.all([
    firstPage.getByRole("button", { name: "Create" }).click({ noWaitAfter: true }),
    secondPage.getByRole("button", { name: "Create" }).click({ noWaitAfter: true }),
  ]);
  const bootstrapResponses = await Promise.all([firstResponsePromise, secondResponsePromise]);
  const statuses = bootstrapResponses.map(({ response }) => response.status()).sort();
  assertJsonEqual(statuses, [201, 409], "concurrent browser bootstrap statuses");
  reportPhase("concurrent bootstrap responses verified");

  const winningName = requiredRow(
    await database`select name from organizations`,
    "concurrent bootstrap winner",
  )["name"];
  assert(names.includes(winningName), "persisted bootstrap winner was unexpected");

  const convergencePages = await Promise.all([context.newPage(), context.newPage()]);
  for (const page of convergencePages) observeBrowserErrors(page, browserErrors);
  await Promise.all(
    convergencePages.map((page) =>
      page.goto(`${webOrigin}/dashboard`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      }),
    ),
  );
  await Promise.all(
    convergencePages.map((page) =>
      page.getByText(winningName, { exact: true }).first().waitFor({ timeout: 30_000 }),
    ),
  );
  reportPhase("both tabs converged after fresh dashboard navigation");

  const databaseState = requiredRow(
    await database`
      select
        users.email,
        organizations.id as organization_id,
        organizations.name as organization_name,
        organizations.business_time_zone,
        organizations.ai_enabled,
        memberships.role,
        memberships.status as membership_status,
        (select count(*)::integer from users) as user_count,
        (select count(*)::integer from organizations) as organization_count,
        (select count(*)::integer from memberships) as membership_count,
        (select count(*)::integer from organization_bootstrap_requests) as request_count,
        (select count(*)::integer from audit_events) as audit_count,
        events.action as audit_action,
        events.actor_type as audit_actor_type,
        events.reason as audit_reason,
        events.hash_version as audit_hash_version,
        events.previous_event_hash,
        events.event_hash
      from users
      inner join memberships on memberships.user_id = users.id
      inner join organizations on organizations.id = memberships.organization_id
      inner join audit_events events on events.organization_id = organizations.id
      where users.issuer = ${oidcIssuer}
        and users.email = ${ownerUsername}
    `,
    "created organization database state",
  );
  assertEqual(databaseState["email"], ownerUsername, "verified identity email");
  assertEqual(databaseState["organization_name"], winningName, "persisted organization name");
  assertEqual(databaseState["ai_enabled"], false, "AI default");
  assertEqual(databaseState["role"], "owner", "persisted membership role");
  assertEqual(databaseState["membership_status"], "active", "persisted membership status");
  for (const field of [
    "user_count",
    "organization_count",
    "membership_count",
    "request_count",
    "audit_count",
  ]) {
    assertEqual(Number(databaseState[field]), 1, field);
  }
  assertEqual(databaseState["audit_action"], "organization.created", "audit action");
  assertEqual(databaseState["audit_actor_type"], "user", "audit actor type");
  assertEqual(
    databaseState["audit_reason"],
    "Initial organization created by verified owner",
    "audit reason",
  );
  assertEqual(databaseState["audit_hash_version"], 2, "audit hash version");
  assertEqual(databaseState["previous_event_hash"], null, "audit predecessor");
  assert(
    typeof databaseState["event_hash"] === "string" &&
      /^[0-9a-f]{64}$/u.test(databaseState["event_hash"]),
    "audit event hash was not canonical SHA-256",
  );
  reportPhase("database cardinality and audit invariants verified");

  const inviteeContext = await browser.newContext();
  inviteeContext.setDefaultTimeout(30_000);
  inviteeContext.setDefaultNavigationTimeout(30_000);
  const reviewerBootstrapPage = await inviteeContext.newPage();
  observeBrowserErrors(reviewerBootstrapPage, browserErrors);
  await reviewerBootstrapPage.goto(webOrigin);
  await startFixtureSignInThroughUi(reviewerBootstrapPage);
  await completeFixtureLogin(reviewerBootstrapPage, reviewerFixture, "/dashboard");
  await reviewerBootstrapPage.getByText("No active memberships", { exact: true }).waitFor();

  const reviewerOrganizationName = "OIDC Reviewer Independent Tenant";
  await reviewerBootstrapPage
    .getByRole("textbox", { name: "Organization name" })
    .fill(reviewerOrganizationName);
  const reviewerBootstrapResponse = waitForBootstrapResponse(reviewerBootstrapPage);
  await reviewerBootstrapPage.getByRole("button", { name: "Create" }).click({ noWaitAfter: true });
  assertEqual(
    (await reviewerBootstrapResponse).response.status(),
    201,
    "second identity bootstrap response",
  );
  await reviewerBootstrapPage
    .getByText(reviewerOrganizationName, { exact: true })
    .first()
    .waitFor();

  const reviewerOrganizationState = requiredRow(
    await database`
      select
        organizations.id as organization_id,
        organizations.name as organization_name,
        organizations.ai_enabled,
        memberships.role,
        memberships.status,
        events.action as audit_action,
        events.hash_version as audit_hash_version,
        events.previous_event_hash,
        events.event_hash
      from users
      inner join memberships on memberships.user_id = users.id
      inner join organizations on organizations.id = memberships.organization_id
      inner join audit_events events on events.organization_id = organizations.id
      where users.issuer = ${oidcIssuer}
        and users.email = ${reviewerUsername}
    `,
    "second identity organization state",
  );
  const reviewerOrganizationId = reviewerOrganizationState["organization_id"];
  assert(
    typeof reviewerOrganizationId === "string" && /^[0-9a-f-]{36}$/u.test(reviewerOrganizationId),
    "second identity organization ID was invalid",
  );
  assertEqual(
    reviewerOrganizationState["organization_name"],
    reviewerOrganizationName,
    "second identity organization name",
  );
  assertEqual(reviewerOrganizationState["ai_enabled"], false, "second organization AI default");
  assertEqual(reviewerOrganizationState["role"], "owner", "second identity membership role");
  assertEqual(reviewerOrganizationState["status"], "active", "second identity membership status");
  assertEqual(
    reviewerOrganizationState["audit_action"],
    "organization.created",
    "second organization audit action",
  );
  assertEqual(
    reviewerOrganizationState["audit_hash_version"],
    2,
    "second organization audit hash version",
  );
  assertEqual(
    reviewerOrganizationState["previous_event_hash"],
    null,
    "second organization audit predecessor",
  );
  assert(
    typeof reviewerOrganizationState["event_hash"] === "string" &&
      /^[0-9a-f]{64}$/u.test(reviewerOrganizationState["event_hash"]),
    "second organization audit event hash was not canonical SHA-256",
  );
  reportPhase("second verified identity created an independent first organization");

  // Compile the state-changing BFF route before asking it to return the only copy of an
  // invitation token. A first-request webpack refresh would otherwise remount the client
  // component and discard that intentionally ephemeral value before it can be verified.
  const actionsWarmupResponse = await context.request.get(`${webOrigin}/api/recon/actions`);
  assertEqual(actionsWarmupResponse.status(), 405, "actions BFF warmup response");

  const organizationId = databaseState["organization_id"];
  const ownerSettingsPage = await context.newPage();
  observeBrowserErrors(ownerSettingsPage, browserErrors);
  await ownerSettingsPage.goto(`${webOrigin}/dashboard/settings`);
  await ownerSettingsPage.getByRole("heading", { name: "Members & roles" }).waitFor();

  const acceptedInvitationUrl = await createInvitationThroughUi(ownerSettingsPage, {
    email: reviewerUsername,
    role: "auditor",
    reason: "Grant the synthetic reviewer read-only onboarding access",
    expectedDelivery: "accepted",
  });
  const acceptedInvitationToken = invitationToken(acceptedInvitationUrl);
  assertEqual(emailRelayRequests.length, 1, "accepted relay request count");
  assertEqual(emailRelayRequests[0]?.recipient, reviewerUsername, "accepted relay recipient");
  assertEqual(emailRelayRequests[0]?.outcome, "accepted", "accepted relay outcome");
  assertEqual(emailRelayErrors.length, 0, "email relay validation error count");
  reportPhase("owner created an email-delivered auditor invitation");

  const invitationPage = await inviteeContext.newPage();
  observeBrowserErrors(invitationPage, browserErrors);
  await invitationPage.goto(acceptedInvitationUrl);
  await invitationPage.getByText("Identity ready", { exact: true }).waitFor();
  await invitationPage.waitForFunction("window.location.hash.length === 0");
  await clickWithConfirmation(
    invitationPage,
    invitationPage.getByRole("button", { name: "Accept access" }),
    "Accept this organization invitation?",
  );
  await invitationPage.getByText("Invitation accepted", { exact: true }).waitFor();

  const multiOrganizationDirectoryResponse = await inviteeContext.request.get(
    `${webOrigin}/api/recon?view=organizations`,
  );
  assertEqual(
    multiOrganizationDirectoryResponse.status(),
    200,
    "multi-organization directory response",
  );
  const multiOrganizationDirectory = await multiOrganizationDirectoryResponse.json();
  assert(
    isRecord(multiOrganizationDirectory) &&
      isRecord(multiOrganizationDirectory["data"]) &&
      Array.isArray(multiOrganizationDirectory["data"]["organizations"]),
    "multi-organization directory response was malformed",
  );
  assertEqual(
    multiOrganizationDirectory["data"]["selectedOrganizationId"],
    organizationId,
    "invitation-selected organization",
  );
  assertJsonEqual(
    multiOrganizationDirectory["data"]["organizations"]
      .map((organization) => ({
        id: organization?.id,
        name: organization?.name,
        role: organization?.role,
      }))
      .sort((left, right) => String(left.name).localeCompare(String(right.name))),
    [
      { id: reviewerOrganizationId, name: reviewerOrganizationName, role: "owner" },
      { id: organizationId, name: winningName, role: "auditor" },
    ].sort((left, right) => left.name.localeCompare(right.name)),
    "multi-organization directory authority",
  );

  const inviteeContextCookies = await inviteeContext.cookies(webOrigin);
  const inviteeOrganizationCookies = inviteeContextCookies.filter(
    ({ name }) => name === "reconai.organization-context",
  );
  assertEqual(inviteeOrganizationCookies.length, 1, "invitee organization context cookie count");
  assertEqual(
    inviteeOrganizationCookies[0]?.httpOnly,
    true,
    "invitee organization context cookie HttpOnly",
  );
  await Promise.all([
    invitationPage.waitForURL(`${webOrigin}/dashboard`, { timeout: 30_000 }),
    invitationPage.getByRole("link", { name: "Open control desk" }).click({ noWaitAfter: true }),
  ]);
  await invitationPage.getByText(winningName, { exact: true }).first().waitFor();
  assertEqual(
    await invitationPage.getByRole("combobox", { name: "Organization" }).locator("option").count(),
    2,
    "multi-organization browser option count",
  );
  await switchOrganizationThroughUi(
    invitationPage,
    reviewerOrganizationId,
    reviewerOrganizationName,
  );
  const independentOrganizationMembers = await inviteeContext.request.get(
    `${webOrigin}/api/recon?view=members`,
  );
  assertEqual(
    independentOrganizationMembers.status(),
    200,
    "independent owner organization member-directory access",
  );
  await switchOrganizationThroughUi(invitationPage, organizationId, winningName);
  reportPhase("second verified identity accepted and switched between both organizations");

  const inviteeSessionResponse = await inviteeContext.request.get(`${webOrigin}/api/auth/session`);
  assertEqual(inviteeSessionResponse.status(), 200, "invitee browser session response");
  const inviteeSessionBody = await inviteeSessionResponse.text();
  assert(
    !/(apiAccessToken|apiRefreshToken|apiIdToken|access_token|refresh_token)/u.test(
      inviteeSessionBody,
    ),
    "invitee browser-readable session disclosed a provider credential field",
  );

  const auditorMembersResponse = await inviteeContext.request.get(
    `${webOrigin}/api/recon?view=members`,
  );
  assertEqual(auditorMembersResponse.status(), 404, "auditor member-directory denial");

  await updateMemberThroughUi(ownerSettingsPage, reviewerUsername, {
    role: "administrator",
    status: "active",
    reason: "Promote the synthetic reviewer to verify permission activation",
  });
  const administratorMembersResponse = await inviteeContext.request.get(
    `${webOrigin}/api/recon?view=members`,
  );
  assertEqual(administratorMembersResponse.status(), 200, "administrator member-directory access");
  const administratorMembersBody = await administratorMembersResponse.json();
  assert(
    Array.isArray(administratorMembersBody?.data) && administratorMembersBody.data.length === 2,
    "administrator member directory did not contain exactly two members",
  );

  await updateMemberThroughUi(ownerSettingsPage, reviewerUsername, {
    role: "reviewer",
    status: "deactivated",
    reason: "Verify immediate session denial after account deactivation",
  });
  const deactivatedSummaryResponse = await inviteeContext.request.get(
    `${webOrigin}/api/recon?view=summary`,
  );
  assertEqual(deactivatedSummaryResponse.status(), 404, "deactivated member summary denial");
  const deactivatedDirectoryResponse = await inviteeContext.request.get(
    `${webOrigin}/api/recon?view=organizations`,
  );
  assertEqual(deactivatedDirectoryResponse.status(), 200, "deactivated organization directory");
  const deactivatedDirectory = await deactivatedDirectoryResponse.json();
  assertJsonEqual(
    deactivatedDirectory?.data?.organizations?.map(({ id, role }) => ({ id, role })),
    [{ id: reviewerOrganizationId, role: "owner" }],
    "deactivation remained tenant-scoped in the identity directory",
  );
  await selectOrganizationThroughBff(
    inviteeContext,
    reviewerOrganizationId,
    "unaffected independent organization",
  );
  const unaffectedOrganizationSummary = await inviteeContext.request.get(
    `${webOrigin}/api/recon?view=summary`,
  );
  assertEqual(
    unaffectedOrganizationSummary.status(),
    200,
    "unaffected independent organization summary access",
  );
  const unaffectedOrganizationMembers = await inviteeContext.request.get(
    `${webOrigin}/api/recon?view=members`,
  );
  assertEqual(
    unaffectedOrganizationMembers.status(),
    200,
    "unaffected independent organization owner access",
  );

  await updateMemberThroughUi(ownerSettingsPage, reviewerUsername, {
    role: "reviewer",
    status: "active",
    reason: "Reactivate the synthetic reviewer with least-privilege review access",
  });
  await selectOrganizationThroughBff(
    inviteeContext,
    organizationId,
    "reactivated invited organization",
  );
  const reviewerSummaryResponse = await inviteeContext.request.get(
    `${webOrigin}/api/recon?view=summary`,
  );
  assertEqual(reviewerSummaryResponse.status(), 200, "reactivated reviewer summary access");
  const reviewerMembersResponse = await inviteeContext.request.get(
    `${webOrigin}/api/recon?view=members`,
  );
  assertEqual(reviewerMembersResponse.status(), 404, "reviewer member-directory denial");
  reportPhase(
    "role promotion, tenant-scoped deactivation, unaffected access, and reactivation verified",
  );

  const rejectedInvitationUrl = await createInvitationThroughUi(ownerSettingsPage, {
    email: failedDeliveryEmail,
    role: "auditor",
    reason: "Exercise provider rejection and the one-time manual fallback",
    expectedDelivery: "failed",
  });
  const rejectedInvitationToken = invitationToken(rejectedInvitationUrl);
  assertEqual(emailRelayRequests.length, 2, "total relay request count");
  assertEqual(emailRelayRequests[1]?.recipient, failedDeliveryEmail, "rejected relay recipient");
  assertEqual(emailRelayRequests[1]?.outcome, "rejected", "rejected relay outcome");
  assertEqual(emailRelayErrors.length, 0, "email relay validation error count");

  const invitationPanel = ownerSettingsPage.locator("section.invitation-panel");
  const rejectedInvitationRow = invitationPanel
    .getByRole("row")
    .filter({ hasText: failedDeliveryEmail });
  await rejectedInvitationRow
    .getByRole("button", { name: `Revoke invitation for ${failedDeliveryEmail}` })
    .click();
  const revokeEditor = invitationPanel.locator(".invitation-revoke");
  await revokeEditor
    .getByLabel("Reason · required and audit-visible")
    .fill("Revoke the intentionally rejected synthetic delivery");
  const revokeResponse = ownerSettingsPage.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/recon/actions",
    { timeout: 30_000 },
  );
  const refreshedInvitationsResponse = ownerSettingsPage.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        url.pathname === "/api/recon" &&
        url.searchParams.get("view") === "invitations"
      );
    },
    { timeout: 30_000 },
  );
  await clickWithConfirmation(
    ownerSettingsPage,
    revokeEditor.getByRole("button", { name: "Revoke access link" }),
    "Revoke this invitation?",
  );
  assertEqual((await revokeResponse).status(), 200, "invitation revocation BFF response");
  assertEqual(
    (await refreshedInvitationsResponse).status(),
    200,
    "post-revocation invitation-directory response",
  );
  await rejectedInvitationRow.locator(".status-text").filter({ hasText: "Revoked" }).waitFor();

  const replayedAcceptance = await inviteeContext.request.post(
    `${webOrigin}/api/recon/invitations/accept`,
    {
      headers: sameOriginHeaders(),
      data: { token: acceptedInvitationToken },
    },
  );
  assertEqual(replayedAcceptance.status(), 404, "accepted invitation replay denial");
  const revokedAcceptance = await inviteeContext.request.post(
    `${webOrigin}/api/recon/invitations/accept`,
    {
      headers: sameOriginHeaders(),
      data: { token: rejectedInvitationToken },
    },
  );
  assertEqual(revokedAcceptance.status(), 404, "revoked invitation denial");
  reportPhase("relay rejection, manual fallback, revocation, and token replay denial verified");

  const lifecycleCounts = numericRow(
    requiredRow(
      await database`
        select
          (select count(*)::integer from users) as users,
          (select count(*)::integer from organizations) as organizations,
          (select count(*)::integer from memberships) as memberships,
          (select count(*)::integer from organization_bootstrap_requests) as bootstrap_requests,
          (select count(*)::integer from organization_invitations) as invitations,
          (select count(*)::integer from audit_events) as audit_events
      `,
      "membership lifecycle counts",
    ),
  );
  assertJsonEqual(
    lifecycleCounts,
    {
      users: 2,
      organizations: 2,
      memberships: 3,
      bootstrap_requests: 2,
      invitations: 2,
      audit_events: 11,
    },
    "membership lifecycle counts",
  );
  const membershipRows = await database`
    select users.email, memberships.role, memberships.status
    from memberships
    inner join users on users.id = memberships.user_id
    where memberships.organization_id = ${organizationId}::uuid
    order by users.email
  `;
  assertJsonEqual(
    membershipRows.map((row) => ({
      email: row["email"],
      role: row["role"],
      status: row["status"],
    })),
    [
      { email: ownerUsername, role: "owner", status: "active" },
      { email: reviewerUsername, role: "reviewer", status: "active" },
    ],
    "terminal membership authority",
  );
  const invitationRows = await database`
    select email, role, status, token_sha256
    from organization_invitations
    where organization_id = ${organizationId}::uuid
    order by email
  `;
  assertJsonEqual(
    invitationRows.map((row) => ({
      email: row["email"],
      role: row["role"],
      status: row["status"],
      digestOnly:
        typeof row["token_sha256"] === "string" && /^[0-9a-f]{64}$/u.test(row["token_sha256"]),
    })),
    [
      { email: failedDeliveryEmail, role: "auditor", status: "revoked", digestOnly: true },
      { email: reviewerUsername, role: "auditor", status: "accepted", digestOnly: true },
    ],
    "terminal invitation evidence",
  );
  const auditActionRows = await database`
    select action, count(*)::integer as count
    from audit_events
    where organization_id = ${organizationId}::uuid
    group by action
    order by action
  `;
  assertJsonEqual(
    auditActionRows.map((row) => ({ action: row["action"], count: Number(row["count"]) })),
    [
      { action: "organization.created", count: 1 },
      { action: "organization.invitation.accepted", count: 1 },
      { action: "organization.invitation.created", count: 2 },
      { action: "organization.invitation.delivery.accepted", count: 1 },
      { action: "organization.invitation.delivery.failed", count: 1 },
      { action: "organization.invitation.revoked", count: 1 },
      { action: "organization.membership.updated", count: 3 },
    ],
    "membership lifecycle audit actions",
  );
  const auditIntegrity = numericRow(
    requiredRow(
      await database`
        select
          count(*)::integer as events,
          count(*) filter (where hash_version = 2)::integer as version_two,
          count(*) filter (where previous_event_hash is null)::integer as genesis_events,
          count(distinct event_hash)::integer as distinct_hashes,
          (
            select count(*)::integer
            from audit_events current_event
            left join audit_events predecessor
              on predecessor.organization_id = current_event.organization_id
             and predecessor.event_hash = current_event.previous_event_hash
            where current_event.organization_id = ${organizationId}::uuid
              and current_event.previous_event_hash is not null
              and predecessor.id is null
          ) as missing_predecessors
        from audit_events
        where organization_id = ${organizationId}::uuid
      `,
      "membership lifecycle audit integrity",
    ),
  );
  assertJsonEqual(
    auditIntegrity,
    {
      events: 10,
      version_two: 10,
      genesis_events: 1,
      distinct_hashes: 10,
      missing_predecessors: 0,
    },
    "membership lifecycle audit integrity",
  );
  const auditPayloads = await database`
    select previous_value::text, new_value::text, reason, version_context::text
    from audit_events
    where organization_id = ${organizationId}::uuid
  `;
  const serializedAuditPayloads = JSON.stringify(auditPayloads);
  assert(
    !serializedAuditPayloads.includes(acceptedInvitationToken) &&
      !serializedAuditPayloads.includes(rejectedInvitationToken),
    "raw invitation token entered audit evidence",
  );
  reportPhase("multi-user cardinality, digest-only tokens, and canonical audit chain verified");

  const cookies = await context.cookies(webOrigin);
  const sessionCookies = cookies.filter(
    ({ name }) => name === "reconai.session-token" || /^reconai\.session-token\.\d+$/u.test(name),
  );
  const organizationCookies = cookies.filter(({ name }) => name === "reconai.organization-context");
  assert(sessionCookies.length > 0, "OIDC session cookie was not issued");
  assert(
    sessionCookies.every(({ httpOnly }) => httpOnly),
    "OIDC session cookie was not HttpOnly",
  );
  assertEqual(organizationCookies.length, 1, "organization context cookie count");
  assertEqual(organizationCookies[0]?.httpOnly, true, "organization context cookie HttpOnly");
  assertEqual(organizationCookies[0]?.sameSite, "Lax", "organization context cookie SameSite");
  const inviteeSessionCookies = inviteeContextCookies.filter(
    ({ name }) => name === "reconai.session-token" || /^reconai\.session-token\.\d+$/u.test(name),
  );
  assert(inviteeSessionCookies.length > 0, "invitee OIDC session cookie was not issued");
  assert(
    inviteeSessionCookies.every(({ httpOnly }) => httpOnly),
    "invitee OIDC session cookie was not HttpOnly",
  );
  assertEqual(
    inviteeOrganizationCookies[0]?.sameSite,
    "Lax",
    "invitee organization context cookie SameSite",
  );
  const expectedConflictResponse = "HTTP 409 POST /api/recon/organizations";
  const expectedMembershipAbsenceResponses = new Set([
    "HTTP 404 GET /api/recon?view=members",
    "HTTP 404 GET /api/recon?view=summary",
  ]);
  const expectedConflictResponses = browserErrors.filter(
    (error) => error === expectedConflictResponse,
  );
  const expectedMembershipAbsenceResponseCount = browserErrors.filter((error) =>
    expectedMembershipAbsenceResponses.has(error),
  ).length;
  const unexpectedBrowserErrors = browserErrors.filter(
    (error) => error !== expectedConflictResponse && !expectedMembershipAbsenceResponses.has(error),
  );
  assert(
    expectedConflictResponses.length >= 1 && expectedConflictResponses.length <= 8,
    `expected bounded 409 response signals, received ${expectedConflictResponses.length.toString()}`,
  );
  assert(
    expectedMembershipAbsenceResponseCount >= 3 && expectedMembershipAbsenceResponseCount <= 12,
    `expected bounded membership-absence response signals, received ${expectedMembershipAbsenceResponseCount.toString()}`,
  );
  assertJsonEqual(unexpectedBrowserErrors, [], "unexpected browser errors");
  reportPhase("browser credential and cookie assertions verified");

  const result = {
    artifactVersion: 1,
    recordedAt: new Date().toISOString(),
    scope:
      "real OIDC first-owner bootstrap, two-organization identity selection, invitation, relay, and tenant-scoped membership lifecycle",
    sourceState: "uncommitted working tree; no repository commit exists",
    outcome: "passed with explicit local-identity and staging exclusions",
    runtime: {
      applicationOrigin: webOrigin,
      apiOrigin,
      oidcIssuer,
      emailRelayOrigin,
      oidcProvider: process.env["LIVE_OIDC_PROVIDER_NAME"] ?? "Keycloak",
      oidcProviderVersion: process.env["LIVE_OIDC_PROVIDER_VERSION"] ?? "unverified",
      transport: "loopback development HTTP",
      productionTlsClaim: false,
      migrationCount: expectedMigrationCount,
    },
    assertions: {
      authorizationCodePkceLoginCompleted: true,
      providerVerifiedEmailPersisted: true,
      emptyMembershipStateRenderedInBothTabs: true,
      concurrentBootstrapStatuses: statuses,
      winningOrganizationName: winningName,
      exactlyOneUserAfterBootstrap: true,
      exactlyOneOrganization: true,
      exactlyOneOwnerMembershipAfterBootstrap: true,
      exactlyOneBootstrapRequest: true,
      exactlyOneOrganizationCreatedAudit: true,
      aiDisabledByDefault: true,
      canonicalAuditHashVersion: 2,
      bothTabsResolveTheCreatedOrganizationAfterFreshNavigation: true,
      secondVerifiedIdentityCreatedIndependentOrganization: true,
      secondIdentityIndependentRole: "owner",
      secondVerifiedIdentityInvitationAccepted: true,
      invitationAcceptanceSelectedOrganizationContext: true,
      invitationAcceptanceSelectedInvitingOrganization: true,
      invitedIdentityOrganizationDirectoryCount:
        multiOrganizationDirectory["data"]["organizations"].length,
      invitedIdentityRolesAcrossOrganizations: ["auditor", "owner"],
      browserOrganizationOptionCount: 2,
      browserSwitchedToIndependentOrganizationAndBack: true,
      independentOrganizationMemberDirectoryStatus: independentOrganizationMembers.status(),
      invitationTokenRemovedFromBrowserUrl: true,
      acceptedEmailRelayRequests: 1,
      rejectedEmailRelayRequests: 1,
      providerRejectionExposedOneTimeManualFallback: true,
      acceptedInvitationReplayStatus: replayedAcceptance.status(),
      revokedInvitationAcceptanceStatus: revokedAcceptance.status(),
      initialInvitedRole: "auditor",
      auditorMemberDirectoryStatus: auditorMembersResponse.status(),
      administratorMemberDirectoryStatus: administratorMembersResponse.status(),
      deactivatedMemberSummaryStatus: deactivatedSummaryResponse.status(),
      deactivatedInvitedOrganizationAbsentFromDirectory: true,
      unaffectedIndependentOrganizationSummaryStatus: unaffectedOrganizationSummary.status(),
      unaffectedIndependentOrganizationMemberDirectoryStatus:
        unaffectedOrganizationMembers.status(),
      terminalInvitedRole: "reviewer",
      reviewerSummaryStatus: reviewerSummaryResponse.status(),
      reviewerMemberDirectoryStatus: reviewerMembersResponse.status(),
      terminalUsers: lifecycleCounts.users,
      terminalOrganizations: lifecycleCounts.organizations,
      terminalMemberships: lifecycleCounts.memberships,
      terminalInvitations: lifecycleCounts.invitations,
      terminalAuditEvents: lifecycleCounts.audit_events,
      invitationTokensStoredAsDigestsOnly: true,
      rawInvitationTokenInAuditEvidence: false,
      canonicalAuditEvents: auditIntegrity.events,
      missingAuditPredecessors: auditIntegrity.missing_predecessors,
      browserProviderCredentialDisclosure: false,
      inviteeBrowserProviderCredentialDisclosure: false,
      sessionCookieCount: sessionCookies.length,
      sessionCookiesHttpOnly: true,
      inviteeSessionCookieCount: inviteeSessionCookies.length,
      inviteeSessionCookiesHttpOnly: true,
      organizationContextCookieHttpOnly: true,
      organizationContextCookieSameSite: "Lax",
      inviteeOrganizationContextCookieHttpOnly: true,
      inviteeOrganizationContextCookieSameSite: "Lax",
      expectedConflictResponses: expectedConflictResponses.length,
      expectedMembershipAbsenceResponses: expectedMembershipAbsenceResponseCount,
      unexpectedBrowserErrors: 0,
    },
    limitations: [
      "The identity provider, email relay, users, database, and application processes are isolated local fixtures, not staging or production evidence.",
      "The exercise uses loopback HTTP and does not prove production TLS, ingress, external identity federation, third-party email delivery, asynchronous bounce handling, or provider availability.",
      "It proves one invited identity with two organizations and tenant-specific roles/status; it does not prove more-than-100 memberships, concurrent administrative mutations, MFA, or production account recovery.",
      "No raw invitation token, access token, refresh token, ID token, session cookie, authorization code, state, password, client secret, email relay credential, or database credential is recorded.",
    ],
    credentialsOrCustomerDataRecorded: false,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const childDiagnostics = children
    .map(({ label, output }) => `${label}:\n${sanitizedTail(output)}`)
    .join("\n");
  process.stderr.write(
    `${sanitize(message)}${childDiagnostics ? `\n${childDiagnostics}\n` : "\n"}`,
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", handleInterrupt);
  process.removeListener("SIGTERM", handleTermination);
  await cleanupResources();
}

function requiredFixtureUser(username) {
  const user = realmFixture.users?.find((candidate) => candidate?.username === username);
  const initialPassword = user?.credentials?.find(({ type }) => type === "password")?.value;
  if (
    !user ||
    user.email !== username ||
    user.emailVerified !== true ||
    user.enabled !== true ||
    typeof initialPassword !== "string"
  ) {
    throw new Error(`the synthetic realm fixture is missing verified user ${username}`);
  }
  return { username, initialPassword };
}

async function startFixtureSignInThroughUi(page) {
  const signInButton = page.getByRole("button", { name: "Sign in securely" });
  await signInButton.waitFor({ state: "visible" });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const initiationResponse = page
      .waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/auth/signin/keycloak",
        { timeout: 5_000 },
      )
      .catch(() => undefined);
    await signInButton.click({ noWaitAfter: true });
    const response = await initiationResponse;
    if (!response) {
      await page.waitForTimeout(attempt * 250);
      continue;
    }
    assertEqual(response.status(), 200, "OIDC sign-in initiation response");
    await page.waitForURL((url) => url.origin === new URL(oidcIssuer).origin, {
      timeout: 30_000,
    });
    return;
  }
  throw new Error("OIDC sign-in initiation did not leave the application origin");
}

async function completeFixtureLogin(page, fixture, expectedPath) {
  await page.locator("#username").fill(fixture.username);
  await page.locator("#password").fill(fixture.initialPassword);
  await page.locator("#kc-login").click();

  const finalUrl = (url) => url.origin === webOrigin && url.pathname === expectedPath;
  const newPassword = page.locator("#password-new");
  const requiresPasswordUpdate = await Promise.race([
    newPassword.waitFor({ state: "visible", timeout: 30_000 }).then(() => true),
    page.waitForURL(finalUrl, { timeout: 30_000 }).then(() => false),
  ]);
  if (requiresPasswordUpdate) {
    const replacementPassword = `Local-${randomBytes(24).toString("base64url")}!`;
    await newPassword.fill(replacementPassword);
    await page.locator("#password-confirm").fill(replacementPassword);
    await page.locator("#kc-passwd-update-form button[type=submit]").click();
  }
  await page.waitForURL(finalUrl, { timeout: 30_000 });
}

async function createInvitationThroughUi(page, { email, role, reason, expectedDelivery }) {
  const panel = page.locator("section.invitation-panel");
  const editor = panel.locator(".invitation-create");
  await editor.getByLabel("Verified email").fill(email);
  await editor.getByLabel("Initial role").selectOption(role);
  await editor.getByLabel("Reason · required and audit-visible").fill(reason);
  await clickWithConfirmation(
    page,
    editor.getByRole("button", { name: "Create invitation" }),
    `Invite ${email} as`,
  );
  const deliveryMessage =
    expectedDelivery === "accepted"
      ? "Email delivery accepted. Copy this backup link now."
      : "Email delivery failed. Copy this link now.";
  await panel.getByText(deliveryMessage, { exact: true }).waitFor();
  const invitationUrl = await panel
    .getByRole("textbox", { name: "One-time invitation link" })
    .inputValue();
  const parsed = new URL(invitationUrl);
  assertEqual(parsed.origin, webOrigin, "invitation link origin");
  assertEqual(parsed.pathname, "/invitations/accept", "invitation link path");
  assertEqual(parsed.search, "", "invitation link query");
  invitationToken(invitationUrl);
  return invitationUrl;
}

async function updateMemberThroughUi(page, email, { role, status, reason }) {
  const memberDirectoryResponse = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        url.pathname === "/api/recon" &&
        url.searchParams.get("view") === "members"
      );
    },
    { timeout: 30_000 },
  );
  await page.goto(`${webOrigin}/dashboard/settings`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.getByRole("heading", { name: "Members & roles" }).waitFor();
  const directoryResponse = await memberDirectoryResponse;
  assertEqual(directoryResponse.status(), 200, "owner member-directory response");
  const memberPanel = page.locator("section.queue-panel").filter({
    has: page.getByRole("table", {
      name: "Organization members, roles, and account status",
    }),
  });
  const memberRow = memberPanel.getByRole("row").filter({ hasText: email });
  await memberRow.getByRole("button", { name: `Manage ${email}` }).click();
  const editor = memberPanel.locator(".member-editor");
  await editor.waitFor({ state: "visible" });
  const accessSelectors = editor.locator("select");
  assertEqual(await accessSelectors.count(), 2, "membership editor selector count");
  await accessSelectors.nth(0).selectOption(role);
  await accessSelectors.nth(1).selectOption(status);
  await editor.getByLabel("Reason · required and audit-visible").fill(reason);
  const updateResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/recon/actions",
    { timeout: 30_000 },
  );
  await clickWithConfirmation(
    page,
    editor.getByRole("button", { name: "Save access" }),
    "Apply role",
  );
  assertEqual((await updateResponse).status(), 200, "membership update BFF response");
  await memberPanel.getByText("Membership change recorded.", { exact: true }).waitFor();
  await editor.waitFor({ state: "hidden" });
}

async function switchOrganizationThroughUi(page, organizationId, expectedName) {
  const organizationSelector = page.getByRole("combobox", { name: "Organization" });
  await organizationSelector.selectOption(organizationId);
  const selectionResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/recon/organization",
    { timeout: 30_000 },
  );
  const navigation = page.waitForNavigation({
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Switch", exact: true }).click({ noWaitAfter: true });
  assertEqual((await selectionResponse).status(), 200, `switch to ${expectedName}`);
  await navigation;
  await page.getByText(expectedName, { exact: true }).first().waitFor();
  assertEqual(
    await page.getByRole("combobox", { name: "Organization" }).inputValue(),
    organizationId,
    `selected organization ${expectedName}`,
  );
}

async function selectOrganizationThroughBff(browserContext, organizationId, label) {
  const response = await browserContext.request.post(`${webOrigin}/api/recon/organization`, {
    headers: sameOriginHeaders(),
    data: { organizationId },
  });
  assertEqual(response.status(), 200, `${label} selection response`);
  const body = await response.json();
  assertEqual(body?.data?.id, organizationId, `${label} selection authority`);
}

async function clickWithConfirmation(page, locator, expectedMessage) {
  const dialogPromise = page.waitForEvent("dialog", { timeout: 10_000 });
  const clickPromise = locator.click({ noWaitAfter: true });
  const dialog = await dialogPromise;
  assertEqual(dialog.type(), "confirm", "browser dialog type");
  assert(
    dialog.message().includes(expectedMessage),
    `browser confirmation did not include ${expectedMessage}`,
  );
  await dialog.accept();
  await clickPromise;
}

function invitationToken(invitationUrl) {
  const hash = new URL(invitationUrl).hash;
  const token = hash.startsWith("#token=") ? hash.slice("#token=".length) : undefined;
  if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new Error("invitation link did not contain one canonical 32-byte fragment token");
  }
  return token;
}

function sameOriginHeaders() {
  return {
    origin: webOrigin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
}

async function startInvitationEmailRelay() {
  const server = createServer((request, response) => {
    void handleInvitationEmailRequest(request, response).catch((error) => {
      emailRelayErrors.push(sanitize(error instanceof Error ? error.message : String(error)));
      if (!response.headersSent) {
        response.writeHead(400, { "content-type": "application/json" });
      }
      response.end('{"accepted":false}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(58100, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}

async function handleInvitationEmailRequest(request, response) {
  assertEqual(request.method, "POST", "email relay method");
  assertEqual(request.url, "/v1/invitations", "email relay request target");
  assert(
    safeTextEqual(request.headers.authorization ?? "", `Bearer ${emailRelayToken}`),
    "email relay authorization was invalid",
  );
  assert(
    request.headers["content-type"]?.toLowerCase().startsWith("application/json"),
    "email relay content type was invalid",
  );
  const requestBody = JSON.parse(await readBoundedRequestBody(request, 64 * 1024));
  assert(isRecord(requestBody), "email relay body was not an object");
  assertEqual(requestBody["template"], "organization_invitation_v1", "email template");
  assertEqual(requestBody["from"], "no-reply@example.test", "email sender");
  const recipient = requestBody["to"];
  assert(
    recipient === reviewerUsername || recipient === failedDeliveryEmail,
    "email relay recipient was unexpected",
  );
  const metadata = requestBody["metadata"];
  assert(isRecord(metadata), "email relay metadata was invalid");
  assert(
    typeof metadata["invitationId"] === "string" &&
      /^[0-9a-f-]{36}$/u.test(metadata["invitationId"]),
    "email relay invitation ID was invalid",
  );
  assertEqual(
    metadata["correlationId"],
    request.headers["x-request-id"],
    "email relay correlation binding",
  );
  const textBody = requestBody["text"];
  const htmlBody = requestBody["html"];
  assert(typeof textBody === "string", "email relay text body was invalid");
  assert(typeof htmlBody === "string", "email relay HTML body was invalid");
  const deliveredLink = textBody
    .split("\n")
    .find((line) => line.startsWith(`${webOrigin}/invitations/accept#token=`));
  assert(deliveredLink !== undefined, "email relay text omitted the fragment invitation link");
  const deliveredToken = invitationToken(deliveredLink);
  assert(
    htmlBody.includes(`/invitations/accept#token=${deliveredToken}`),
    "email relay HTML and text links diverged",
  );
  assert(
    !request.url?.includes(deliveredToken),
    "invitation token entered the email relay HTTP request target",
  );
  const outcome = recipient === failedDeliveryEmail ? "rejected" : "accepted";
  emailRelayRequests.push({
    recipient,
    outcome,
    template: requestBody["template"],
    correlationBound: true,
    tokenDeliveredInFragment: true,
  });
  if (outcome === "rejected") {
    response.writeHead(503, { "content-type": "application/json" });
    response.end('{"accepted":false}');
    return;
  }
  response.writeHead(202, {
    "content-type": "application/json",
    "x-message-id": "local-invitation-accepted-1",
  });
  response.end('{"accepted":true}');
}

async function readBoundedRequestBody(request, maximumBytes) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > maximumBytes) throw new Error("email relay request exceeded its byte limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeTextEqual(actual, expected) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertOidcDiscovery() {
  const discoveryUrl = `${oidcIssuer}/.well-known/openid-configuration`;
  const response = await fetch(discoveryUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`OIDC discovery returned ${response.status}`);
  const body = await response.json();
  assertEqual(body?.issuer, oidcIssuer, "OIDC discovery issuer");
  for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    const value = body?.[field];
    assert(
      typeof value === "string" && new URL(value).origin === new URL(oidcIssuer).origin,
      `OIDC discovery ${field} left the configured provider origin`,
    );
  }
}

function waitForBootstrapResponse(page) {
  return page
    .waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/recon/organizations",
      { timeout: 30_000 },
    )
    .then((response) => ({ page, response }));
}

function observeBrowserErrors(page, errors) {
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource: the server responded with a status of")
    ) {
      errors.push(`console: ${sanitize(message.text())}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`page: ${sanitize(error.message)}`));
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    if (url.origin !== webOrigin || !url.pathname.startsWith("/api/")) return;
    const view = url.searchParams.get("view");
    errors.push(
      `HTTP ${response.status().toString()} ${response.request().method()} ${url.pathname}${view ? `?view=${view}` : ""}`,
    );
  });
}

function reportPhase(phase) {
  process.stderr.write(`[live-oidc-bootstrap] ${phase}\n`);
}

async function terminateFromSignal(signal) {
  await cleanupResources();
  process.exit(signal === "SIGINT" ? 130 : 143);
}

function cleanupResources() {
  cleanupPromise ??= (async () => {
    const closeBrowser = browser
      ? Promise.race([browser.close().catch(() => undefined), delay(5_000)])
      : Promise.resolve();
    const closeDatabase = database
      ? database.end({ timeout: 5 }).catch(() => undefined)
      : Promise.resolve();
    const closeEmailRelay = emailRelay
      ? Promise.race([
          new Promise((resolve) => {
            emailRelay.closeAllConnections();
            emailRelay.close(() => resolve());
          }),
          delay(5_000),
        ])
      : Promise.resolve();
    await Promise.all([
      closeBrowser,
      closeDatabase,
      closeEmailRelay,
      ...children
        .slice()
        .reverse()
        .map((child) => stopChild(child)),
    ]);
  })();
  return cleanupPromise;
}

async function assertTcpPortAvailable(host, port, label) {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`${label} port ${host}:${port} is already in use`));
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error?.code === "ECONNREFUSED") {
        resolve();
        return;
      }
      reject(error);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`${label} port ${host}:${port} availability probe timed out`));
    });
  });
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredLoopbackIssuer(name) {
  const value = requiredEnvironment(name);
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith("/realms/")
  ) {
    throw new Error(`${name} must be a loopback HTTP Keycloak realm URL`);
  }
  return url.toString().replace(/\/$/u, "");
}

function assertNonProductionLoopbackEnvironment(candidate) {
  if (process.env["NODE_ENV"] === "production" || process.env["APP_ENV"] === "production") {
    throw new Error("live OIDC bootstrap verification is disabled in production");
  }
  for (const name of [
    "DATABASE_URL",
    "DATABASE_WORKER_URL",
    "DATABASE_MIGRATION_URL",
    "DATABASE_ADMIN_URL",
    "REDIS_URL",
    "S3_ENDPOINT",
  ]) {
    const value = candidate[name];
    if (!value) throw new Error(`${name} is required`);
    const hostname = new URL(value).hostname;
    if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
      throw new Error(`${name} must target loopback infrastructure`);
    }
  }
}

function startChild(label, command, arguments_) {
  const child = spawn(command, arguments_, {
    cwd: repositoryRoot,
    env: environment,
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = { label, child, output: "", exited: false };
  const capture = (chunk) => {
    record.output = `${record.output}${chunk.toString("utf8")}`.slice(-256 * 1024);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("exit", () => {
    record.exited = true;
  });
  child.on("error", capture);
  return record;
}

async function stopChild(record) {
  if (record.exited || record.child.pid === undefined) return;
  try {
    process.kill(-record.child.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return;
  }
  const exited = await Promise.race([
    new Promise((resolve) => record.child.once("exit", () => resolve(true))),
    delay(8_000).then(() => false),
  ]);
  if (exited) return;
  try {
    process.kill(-record.child.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function runCommand(label, command, arguments_, commandEnvironment) {
  const child = spawn(command, arguments_, {
    cwd: repositoryRoot,
    env: commandEnvironment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-256 * 1024);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(
      `${label} failed (${result.signal ?? `exit ${String(result.code)}`}):\n${sanitizedTail(output)}`,
    );
  }
}

async function waitForHttp(url, childRecords, timeoutMilliseconds) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMilliseconds) {
    const exited = childRecords.find((record) => record.exited);
    if (exited) throw new Error(`${exited.label} exited before ${url} became available`);
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status < 500) return;
    } catch {
      // A bounded retry is expected while the local process starts.
    }
    await delay(200);
  }
  throw new Error(`${url} did not become available within the bounded startup window`);
}

function delay(milliseconds) {
  return new Promise((resolve) => nodeSetTimeout(resolve, milliseconds));
}

function requiredRow(rows, label) {
  const row = rows[0];
  if (!row) throw new Error(`${label} returned no row`);
  return row;
}

function numericRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function assertJsonEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function sanitizedTail(value) {
  return sanitize(value).slice(-8_000);
}

function sanitize(value) {
  return String(value)
    .replace(
      /\b(postgresql|redis):\/\/([^:@/\s]+):([^@/\s]+)@/giu,
      (_match, scheme, username) => `${scheme}://${username}:<redacted>@`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/giu, "Bearer <redacted>")
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
      "<redacted-jwt>",
    )
    .replace(
      /([?&](?:code|state|session_state)=)[^&\s]+/giu,
      (_match, prefix) => `${prefix}<redacted>`,
    );
}
