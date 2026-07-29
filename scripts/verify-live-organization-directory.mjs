import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { performance } from "node:perf_hooks";
import { setTimeout as nodeSetTimeout } from "node:timers";
import { fileURLToPath, URLSearchParams } from "node:url";

import { insertTenantAuditEvent } from "../packages/database/src/audit.ts";

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
const directoryMembershipCount = directoryMembershipCountFromEnvironment();
const browserAccumulationLimit = 500;
const accumulationCeilingMode = directoryMembershipCount > browserAccumulationLimit;
const directApplicationLimit = Math.min(directoryMembershipCount, 101);
const expectedDirectoryPageSizes = directoryPageSizes(directoryMembershipCount);
const verificationLabel = accumulationCeilingMode
  ? "live-org-directory-ceiling"
  : "live-organization-directory";
const webOrigin = "http://localhost:3000";
const apiOrigin = "http://127.0.0.1:4000";
const oidcIssuer = requiredLoopbackIssuer("OIDC_ISSUER");
const sessionSecret = requiredEnvironment("SESSION_SECRET");
if (sessionSecret.length < 32)
  throw new Error("SESSION_SECRET must contain at least 32 characters");

const environment = {
  ...process.env,
  NODE_ENV: "development",
  APP_ENV: verificationLabel,
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
  EMAIL_PROVIDER: "disabled",
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
let database;
let applicationDatabase;
let cleanupPromise;

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
  applicationDatabase = postgres(environment.DATABASE_URL, { max: 2 });
  const initial = numericRow(
    requiredRow(
      await database`
        select
          (select count(*)::integer from reconai_schema_migrations) as migrations,
          (select count(*)::integer from organizations) as organizations,
          (select count(*)::integer from users) as users,
          (select count(*)::integer from memberships) as memberships,
          (select count(*)::integer from audit_events) as audit_events
      `,
      "initial database counts",
    ),
  );
  assertEqual(initial.migrations, expectedMigrationCount, "migration count");
  for (const field of ["organizations", "users", "memberships", "audit_events"]) {
    assertEqual(initial[field], 0, `initial ${field} count`);
  }

  const fixture = await seedDirectoryFixture(database);
  reportPhase("tenant-complete directory fixture seeded");

  const directApplicationRows = await applicationDatabase`
    select organization_id, organization_name, membership_id, membership_role
    from public.reconai_list_active_organization_page(
      ${oidcIssuer},
      ${reviewerFixture.id},
      null,
      null,
      null,
      null,
      ${directApplicationLimit}
    )
  `;
  assertEqual(
    directApplicationRows.length,
    directApplicationLimit,
    "restricted-role directory count",
  );
  assert(
    directApplicationRows.every((row) => row["membership_role"] === "reviewer"),
    "restricted-role directory returned an unexpected role",
  );
  const directForeignExact = await applicationDatabase`
    select organization_id
    from public.reconai_list_active_organization_page(
      ${oidcIssuer},
      ${reviewerFixture.id},
      null,
      ${fixture.foreignOrganizationId}::uuid,
      null,
      null,
      2
    )
  `;
  assertEqual(directForeignExact.length, 0, "restricted-role foreign exact lookup");
  const directRlsRows = await applicationDatabase`select id from organizations`;
  assertEqual(directRlsRows.length, 0, "application-role tenantless direct rows");
  reportPhase("restricted application-role authority verified");

  await Promise.all([
    assertTcpPortAvailable("127.0.0.1", 4000, "API"),
    assertTcpPortAvailable("127.0.0.1", 3000, "web"),
  ]);
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
  const reviewerContext = await browser.newContext();
  reviewerContext.setDefaultTimeout(30_000);
  reviewerContext.setDefaultNavigationTimeout(30_000);
  const reviewerPage = await reviewerContext.newPage();
  const browserErrors = [];
  observeBrowserErrors(reviewerPage, browserErrors);
  await reviewerPage.goto(webOrigin);
  await startFixtureSignInThroughUi(reviewerPage);
  await completeFixtureLogin(reviewerPage, reviewerFixture, "/dashboard");
  await reviewerPage.getByText("Select organization", { exact: true }).waitFor();
  reportPhase("reviewer identity reached the unselected live directory");

  const reviewerSessionResponse = await reviewerContext.request.get(
    `${webOrigin}/api/auth/session`,
  );
  assertEqual(reviewerSessionResponse.status(), 200, "reviewer browser session response");
  const reviewerSessionBody = await reviewerSessionResponse.text();
  assert(
    !/(apiAccessToken|apiRefreshToken|apiIdToken|access_token|refresh_token)/u.test(
      reviewerSessionBody,
    ),
    "browser-readable reviewer session disclosed a provider credential field",
  );

  const firstTraversalStartedAt = performance.now();
  const reviewerDirectory = await traverseOrganizationDirectory(reviewerContext);
  const firstTraversalMilliseconds = performance.now() - firstTraversalStartedAt;
  assertJsonEqual(
    reviewerDirectory.pageSizes,
    expectedDirectoryPageSizes,
    "reviewer directory page sizes",
  );
  assertEqual(
    reviewerDirectory.organizations.length,
    directoryMembershipCount,
    "reviewer directory item count",
  );
  assertEqual(
    new Set(reviewerDirectory.organizations.map(({ id }) => id)).size,
    directoryMembershipCount,
    "reviewer directory unique organization count",
  );
  assertJsonEqual(
    reviewerDirectory.organizations.map(({ name }) => name),
    fixture.scaleOrganizations.map(({ name }) => name),
    "reviewer directory order",
  );
  assert(
    reviewerDirectory.organizations.every(({ role }) => role === "reviewer"),
    "reviewer directory contained a non-reviewer role",
  );

  const literalWildcardResponse = await reviewerContext.request.get(
    `${webOrigin}/api/recon?view=organizations&search=${encodeURIComponent("%_")}`,
  );
  assertEqual(literalWildcardResponse.status(), 200, "literal wildcard search response");
  const literalWildcardBody = await literalWildcardResponse.json();
  assertEqual(
    literalWildcardBody?.data?.organizations?.length,
    0,
    "literal wildcard search result count",
  );

  const exactSearchResponse = await reviewerContext.request.get(
    `${webOrigin}/api/recon?view=organizations&search=${encodeURIComponent(
      fixture.targetOrganizationName,
    )}`,
  );
  assertEqual(exactSearchResponse.status(), 200, "exact name search response");
  const exactSearchBody = await exactSearchResponse.json();
  assertJsonEqual(
    exactSearchBody?.data?.organizations?.map(({ id, name, role }) => ({ id, name, role })),
    [
      {
        id: fixture.targetOrganizationId,
        name: fixture.targetOrganizationName,
        role: "reviewer",
      },
    ],
    "exact name search authority",
  );

  const firstCursor = reviewerDirectory.cursors[0];
  assert(typeof firstCursor === "string", "first directory cursor was absent");
  const searchBoundCursorResponse = await reviewerContext.request.get(
    `${webOrigin}/api/recon?view=organizations&search=Scale&cursor=${encodeURIComponent(
      firstCursor,
    )}`,
  );
  assertEqual(searchBoundCursorResponse.status(), 400, "search-bound cursor rejection");
  const malformedCursorResponse = await reviewerContext.request.get(
    `${webOrigin}/api/recon?view=organizations&cursor=not%2Bbase64`,
  );
  assertEqual(malformedCursorResponse.status(), 400, "malformed cursor rejection");
  reportPhase("complete BFF traversal, search, and cursor binding verified");

  const selector = reviewerPage.getByRole("combobox", { name: "Organization" });
  await expectOptionCount(selector, 50);
  for (
    let expectedCount = 100;
    expectedCount <= Math.min(directoryMembershipCount, browserAccumulationLimit);
    expectedCount += 50
  ) {
    await clickMoreAndExpectOptions(reviewerPage, selector, expectedCount);
  }
  if (!accumulationCeilingMode && directoryMembershipCount % 50 !== 0) {
    await clickMoreAndExpectOptions(reviewerPage, selector, directoryMembershipCount);
  }
  assertEqual(
    await reviewerPage.getByRole("button", { name: "More", exact: true }).count(),
    0,
    "terminal More button count",
  );
  assertEqual(
    await reviewerPage
      .getByText("Refine search to see additional memberships.", { exact: true })
      .count(),
    accumulationCeilingMode ? 1 : 0,
    "accumulation ceiling guidance count",
  );
  const browserAccumulatedOptionCount = Math.min(
    directoryMembershipCount,
    browserAccumulationLimit,
  );
  assertEqual(
    new Set(
      await selector.locator("option").evaluateAll((options) => options.map(({ value }) => value)),
    ).size,
    browserAccumulatedOptionCount,
    "browser unique organization option count",
  );
  if (accumulationCeilingMode) {
    await searchOrganizationThroughUi(
      reviewerPage,
      selector,
      fixture.targetOrganizationName,
      fixture.targetOrganizationId,
    );
  }
  await switchOrganizationThroughUi(
    reviewerPage,
    fixture.targetOrganizationId,
    fixture.targetOrganizationName,
  );
  assertEqual(
    await reviewerPage.getByRole("combobox", { name: "Organization" }).locator("option").count(),
    51,
    "selected beyond-page initial option count",
  );
  const selectedSummary = await reviewerContext.request.get(`${webOrigin}/api/recon?view=summary`);
  assertEqual(selectedSummary.status(), 200, "selected beyond-page summary access");
  reportPhase(
    accumulationCeilingMode
      ? "browser enforced the 500-item ceiling and selected membership 501 through exact search"
      : "browser accumulated 101 memberships and selected beyond page two",
  );

  const foreignSelection = await reviewerContext.request.post(
    `${webOrigin}/api/recon/organization`,
    {
      headers: sameOriginHeaders(),
      data: { organizationId: fixture.foreignOrganizationId },
    },
  );
  assertEqual(foreignSelection.status(), 404, "reviewer foreign exact selection denial");
  const summaryAfterForeignDenial = await reviewerContext.request.get(
    `${webOrigin}/api/recon?view=summary`,
  );
  assertEqual(
    summaryAfterForeignDenial.status(),
    200,
    "foreign denial preserved selected organization",
  );

  const ownerContext = await browser.newContext();
  ownerContext.setDefaultTimeout(30_000);
  ownerContext.setDefaultNavigationTimeout(30_000);
  const ownerPage = await ownerContext.newPage();
  observeBrowserErrors(ownerPage, browserErrors);
  await ownerPage.goto(webOrigin);
  await startFixtureSignInThroughUi(ownerPage);
  await completeFixtureLogin(ownerPage, ownerFixture, "/dashboard");
  await ownerPage.getByText("Select organization", { exact: true }).waitFor();
  const ownerDirectory = await traverseOrganizationDirectory(ownerContext);
  assertJsonEqual(ownerDirectory.pageSizes, [1], "foreign identity directory page sizes");
  assertJsonEqual(
    ownerDirectory.organizations.map(({ id, name, role }) => ({ id, name, role })),
    [
      {
        id: fixture.foreignOrganizationId,
        name: fixture.foreignOrganizationName,
        role: "owner",
      },
    ],
    "foreign identity directory authority",
  );
  const ownerCrossIdentitySelection = await ownerContext.request.post(
    `${webOrigin}/api/recon/organization`,
    {
      headers: sameOriginHeaders(),
      data: { organizationId: fixture.targetOrganizationId },
    },
  );
  assertEqual(ownerCrossIdentitySelection.status(), 404, "owner cross-identity exact denial");
  reportPhase("cross-identity enumeration and exact selection denial verified");

  await setReviewerFixtureMembershipStatus(database, fixture, "deactivated");
  const deactivatedSummary = await reviewerContext.request.get(
    `${webOrigin}/api/recon?view=summary`,
  );
  assertEqual(deactivatedSummary.status(), 404, "deactivated beyond-page summary denial");
  const deactivatedDirectory = await traverseOrganizationDirectory(reviewerContext);
  assertJsonEqual(
    deactivatedDirectory.pageSizes,
    directoryPageSizes(directoryMembershipCount - 1),
    "deactivated directory page sizes",
  );
  assertEqual(
    deactivatedDirectory.organizations.length,
    directoryMembershipCount - 1,
    "deactivated directory count",
  );
  assert(
    !deactivatedDirectory.organizations.some(({ id }) => id === fixture.targetOrganizationId),
    "deactivated organization remained in the identity directory",
  );
  const unaffectedOwnerDirectory = await traverseOrganizationDirectory(ownerContext);
  assertEqual(
    unaffectedOwnerDirectory.organizations.length,
    1,
    "unaffected foreign identity directory count",
  );

  await setReviewerFixtureMembershipStatus(database, fixture, "active");
  const reactivatedSummary = await reviewerContext.request.get(
    `${webOrigin}/api/recon?view=summary`,
  );
  assertEqual(reactivatedSummary.status(), 200, "reactivated beyond-page summary access");
  const reactivatedTraversalStartedAt = performance.now();
  const reactivatedDirectory = await traverseOrganizationDirectory(reviewerContext);
  const reactivatedTraversalMilliseconds = performance.now() - reactivatedTraversalStartedAt;
  assertJsonEqual(
    reactivatedDirectory.pageSizes,
    expectedDirectoryPageSizes,
    "reactivated directory page sizes",
  );
  assertEqual(
    reactivatedDirectory.organizations.length,
    directoryMembershipCount,
    "reactivated directory count",
  );
  reportPhase("beyond-page deactivation and immediate reactivation verified");

  const terminal = numericRow(
    requiredRow(
      await database`
        select
          (select count(*)::integer from users) as users,
          (select count(*)::integer from organizations) as organizations,
          (select count(*)::integer from memberships) as memberships,
          (select count(*)::integer from audit_events) as audit_events,
          (
            select count(*)::integer
            from audit_events
            where hash_version = 2
          ) as version_two_audits,
          (
            select count(*)::integer
            from audit_events
            where previous_event_hash is null
          ) as genesis_audits,
          (
            select count(*)::integer
            from audit_events child
            where child.previous_event_hash is not null
              and not exists (
                select 1
                from audit_events parent
                where parent.organization_id = child.organization_id
                  and parent.event_hash = child.previous_event_hash
              )
          ) as missing_predecessors
      `,
      "terminal directory fixture counts",
    ),
  );
  assertJsonEqual(
    terminal,
    {
      users: 3,
      organizations: directoryMembershipCount + 1,
      memberships: directoryMembershipCount * 2 + 1,
      audit_events: directoryMembershipCount * 2 + 3,
      version_two_audits: directoryMembershipCount * 2 + 3,
      genesis_audits: directoryMembershipCount + 1,
      missing_predecessors: 0,
    },
    "terminal directory fixture counts",
  );

  const reviewerCookies = await reviewerContext.cookies(webOrigin);
  const sessionCookies = reviewerCookies.filter(
    ({ name }) => name === "reconai.session-token" || /^reconai\.session-token\.\d+$/u.test(name),
  );
  const organizationCookies = reviewerCookies.filter(
    ({ name }) => name === "reconai.organization-context",
  );
  assert(sessionCookies.length > 0, "reviewer OIDC session cookie was not issued");
  assert(
    sessionCookies.every(({ httpOnly }) => httpOnly),
    "reviewer OIDC session cookie was not HttpOnly",
  );
  assertEqual(organizationCookies.length, 1, "reviewer organization context cookie count");
  assertEqual(
    organizationCookies[0]?.httpOnly,
    true,
    "reviewer organization context cookie HttpOnly",
  );
  assertEqual(
    organizationCookies[0]?.sameSite,
    "Lax",
    "reviewer organization context cookie SameSite",
  );

  const expectedNoContextResponsesAllowed = new Set([
    "HTTP 404 GET /api/recon?view=summary",
    "HTTP 409 GET /api/recon?view=summary",
  ]);
  const expectedNoContextResponses = browserErrors.filter((error) =>
    expectedNoContextResponsesAllowed.has(error),
  );
  const unexpectedBrowserErrors = browserErrors.filter(
    (error) => !expectedNoContextResponsesAllowed.has(error),
  );
  assert(
    expectedNoContextResponses.length >= 2 && expectedNoContextResponses.length <= 8,
    `expected bounded unselected-context signals, received ${expectedNoContextResponses.length.toString()}`,
  );
  assertJsonEqual(unexpectedBrowserErrors, [], "unexpected browser errors");

  const result = {
    artifactVersion: 1,
    recordedAt: new Date().toISOString(),
    scope: accumulationCeilingMode
      ? "real OIDC identity-derived organization directory 500-item browser ceiling and exact-search selection of membership 501"
      : "real OIDC identity-derived organization directory traversal and exact selection beyond 100 memberships",
    sourceState: "uncommitted working tree; no repository commit exists",
    outcome: "passed with explicit synthetic-fixture and protected-runtime exclusions",
    runtime: {
      applicationOrigin: webOrigin,
      apiOrigin,
      oidcIssuer,
      oidcProvider: process.env["LIVE_OIDC_PROVIDER_NAME"] ?? "Keycloak",
      oidcProviderVersion: process.env["LIVE_OIDC_PROVIDER_VERSION"] ?? "unverified",
      transport: "loopback development HTTP",
      productionTlsClaim: false,
      migrationCount: expectedMigrationCount,
    },
    assertions: {
      authorizationCodePkceLoginsCompleted: 2,
      providerVerifiedReviewerMemberships: directoryMembershipCount,
      reviewerDirectoryPageSizes: reviewerDirectory.pageSizes,
      reviewerDirectoryDuplicateCount: 0,
      reviewerRoleOnEveryScaleMembership: "reviewer",
      restrictedApplicationRoleDirectoryCount: directApplicationRows.length,
      applicationRoleTenantlessRows: directRlsRows.length,
      browserInitialOptionCount: 50,
      browserAccumulatedOptionCount,
      browserAccumulationLimit,
      browserAccumulationLimitReached: accumulationCeilingMode,
      exactSearchUsedToReachTarget: accumulationCeilingMode,
      selectedBeyondSecondPage: true,
      selectedBeyondPageInitialOptionCount: 51,
      selectedSummaryStatus: selectedSummary.status(),
      reviewerForeignExactSelectionStatus: foreignSelection.status(),
      ownerCrossIdentityExactSelectionStatus: ownerCrossIdentitySelection.status(),
      foreignIdentityDirectoryCount: ownerDirectory.organizations.length,
      literalWildcardSearchCount: literalWildcardBody?.data?.organizations?.length,
      exactNameSearchCount: exactSearchBody?.data?.organizations?.length,
      searchBoundCursorStatus: searchBoundCursorResponse.status(),
      malformedCursorStatus: malformedCursorResponse.status(),
      deactivatedSummaryStatus: deactivatedSummary.status(),
      deactivatedDirectoryCount: deactivatedDirectory.organizations.length,
      reactivatedSummaryStatus: reactivatedSummary.status(),
      reactivatedDirectoryCount: reactivatedDirectory.organizations.length,
      firstTraversalMilliseconds: Number(firstTraversalMilliseconds.toFixed(2)),
      reactivatedTraversalMilliseconds: Number(reactivatedTraversalMilliseconds.toFixed(2)),
      terminalUsers: terminal.users,
      terminalOrganizations: terminal.organizations,
      terminalMemberships: terminal.memberships,
      terminalAuditEvents: terminal.audit_events,
      canonicalAuditEvents: terminal.version_two_audits,
      auditGenesisEvents: terminal.genesis_audits,
      missingAuditPredecessors: terminal.missing_predecessors,
      browserProviderCredentialDisclosure: false,
      sessionCookiesHttpOnly: true,
      organizationContextCookieHttpOnly: true,
      organizationContextCookieSameSite: "Lax",
      expectedUnselectedContextResponses: expectedNoContextResponses.length,
      unexpectedBrowserErrors: 0,
    },
    limitations: [
      "The identity provider, database, users, tenant-complete scale fixtures, and application processes are isolated local fixtures, not staging or production evidence.",
      `The ${directoryMembershipCount.toString()} reviewer memberships are seeded solely to exercise directory authority and each organization retains an independent active fixture owner plus canonical audit evidence; no product organization-creation or invitation lifecycle claim follows.`,
      "The exercise uses loopback HTTP and does not prove production TLS, ingress, external identity federation, multi-host behavior, managed PostgreSQL, provider availability, or alerting.",
      "Single-host timings are regression observations only, not an SLO, capacity guarantee, or production projection.",
      accumulationCeilingMode
        ? "It proves the 500-item browser accumulation ceiling with exactly one additional membership; it does not prove substantially larger directories, concurrent organization rename or membership mutation, representative query distributions, or prior/new-image rolling deployment."
        : "It does not prove the 500-item browser accumulation ceiling, concurrent organization rename or membership mutation, representative query distributions, or prior/new-image rolling deployment.",
      "No access token, refresh token, ID token, session cookie, authorization code, state, password, client secret, database credential, or customer data is recorded.",
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

async function seedDirectoryFixture(adminDatabase) {
  const reviewerUserId = randomUUID();
  const ownerUserId = randomUUID();
  const scaleOwnerUserId = randomUUID();
  const scaleOrganizations = Array.from({ length: directoryMembershipCount }, (_, index) => ({
    id: randomUUID(),
    name: `Scale Tenant ${index.toString().padStart(3, "0")}`,
    ownerMembershipId: randomUUID(),
    reviewerMembershipId: randomUUID(),
  }));
  const target = requiredRow(scaleOrganizations.at(-1), "target scale organization");
  const foreignOrganizationId = randomUUID();
  const foreignOrganizationName = "Foreign Identity Tenant";
  const foreignOwnerMembershipId = randomUUID();

  await adminDatabase.begin(async (transaction) => {
    await transaction`
      insert into users (id, issuer, subject, email, status)
      values
        (
          ${reviewerUserId},
          ${oidcIssuer},
          ${reviewerFixture.id},
          ${reviewerFixture.username},
          'active'
        ),
        (
          ${ownerUserId},
          ${oidcIssuer},
          ${ownerFixture.id},
          ${ownerFixture.username},
          'active'
        ),
        (
          ${scaleOwnerUserId},
          'urn:reconai:directory-scale-fixture',
          'independent-active-owner',
          'directory-scale-owner@example.test',
          'active'
        )
    `;
    for (const organization of scaleOrganizations) {
      await transaction`
        insert into organizations (id, name, business_time_zone, status, ai_enabled)
        values (${organization.id}, ${organization.name}, 'UTC', 'active', false)
      `;
      await transaction`
        insert into memberships (id, organization_id, user_id, role, status)
        values
          (
            ${organization.ownerMembershipId},
            ${organization.id},
            ${scaleOwnerUserId},
            'owner',
            'active'
          ),
          (
            ${organization.reviewerMembershipId},
            ${organization.id},
            ${reviewerUserId},
            'reviewer',
            'active'
          )
      `;
      await insertTenantAuditEvent(transaction, {
        organizationId: organization.id,
        actorType: "system",
        actorId: scaleOwnerUserId,
        action: "organization.fixture.created",
        resourceType: "organization",
        resourceId: organization.id,
        correlationId: randomUUID(),
        reason: "Seed the isolated organization-directory scale fixture",
        newValue: {
          businessTimeZone: "UTC",
          name: organization.name,
          ownerMembershipId: organization.ownerMembershipId,
          status: "active",
        },
        versionContext: { directoryScaleFixtureSchemaVersion: 1 },
      });
      await insertTenantAuditEvent(transaction, {
        organizationId: organization.id,
        actorType: "system",
        actorId: scaleOwnerUserId,
        action: "organization.fixture.membership-assigned",
        resourceType: "membership",
        resourceId: organization.reviewerMembershipId,
        correlationId: randomUUID(),
        reason: "Assign the provider identity for isolated directory scale verification",
        newValue: {
          role: "reviewer",
          status: "active",
          userId: reviewerUserId,
        },
        versionContext: { directoryScaleFixtureSchemaVersion: 1 },
      });
    }
    await transaction`
      insert into organizations (id, name, business_time_zone, status, ai_enabled)
      values (${foreignOrganizationId}, ${foreignOrganizationName}, 'UTC', 'active', false)
    `;
    await transaction`
      insert into memberships (id, organization_id, user_id, role, status)
      values (
        ${foreignOwnerMembershipId},
        ${foreignOrganizationId},
        ${ownerUserId},
        'owner',
        'active'
      )
    `;
    await insertTenantAuditEvent(transaction, {
      organizationId: foreignOrganizationId,
      actorType: "system",
      actorId: ownerUserId,
      action: "organization.fixture.created",
      resourceType: "organization",
      resourceId: foreignOrganizationId,
      correlationId: randomUUID(),
      reason: "Seed the isolated cross-identity directory fixture",
      newValue: {
        businessTimeZone: "UTC",
        name: foreignOrganizationName,
        ownerMembershipId: foreignOwnerMembershipId,
        status: "active",
      },
      versionContext: { directoryScaleFixtureSchemaVersion: 1 },
    });
  });

  return {
    reviewerUserId,
    scaleOwnerUserId,
    scaleOrganizations,
    targetOrganizationId: target.id,
    targetOrganizationName: target.name,
    targetReviewerMembershipId: target.reviewerMembershipId,
    foreignOrganizationId,
    foreignOrganizationName,
  };
}

async function setReviewerFixtureMembershipStatus(adminDatabase, fixture, status) {
  assert(["active", "deactivated"].includes(status), "fixture membership status was invalid");
  const previousStatus = status === "active" ? "deactivated" : "active";
  await adminDatabase.begin(async (transaction) => {
    const rows = await transaction`
      update memberships
      set status = ${status}, updated_at = now()
      where organization_id = ${fixture.targetOrganizationId}
        and id = ${fixture.targetReviewerMembershipId}
        and user_id = ${fixture.reviewerUserId}
        and status = ${previousStatus}
      returning id
    `;
    assertEqual(rows.length, 1, `fixture membership ${status} update count`);
    await insertTenantAuditEvent(transaction, {
      organizationId: fixture.targetOrganizationId,
      actorType: "system",
      actorId: fixture.scaleOwnerUserId,
      action: "organization.fixture.membership-status-updated",
      resourceType: "membership",
      resourceId: fixture.targetReviewerMembershipId,
      correlationId: randomUUID(),
      reason: `Verify immediate directory re-resolution after fixture membership ${status}`,
      previousValue: { role: "reviewer", status: previousStatus },
      newValue: { role: "reviewer", status },
      versionContext: { directoryScaleFixtureSchemaVersion: 1 },
    });
  });
}

async function traverseOrganizationDirectory(browserContext) {
  const organizations = [];
  const pageSizes = [];
  const cursors = [];
  let cursor;
  const maximumPages = Math.ceil(directoryMembershipCount / 50) + 1;
  for (let page = 0; page < maximumPages; page += 1) {
    const query = new URLSearchParams({ view: "organizations" });
    if (cursor) query.set("cursor", cursor);
    const response = await browserContext.request.get(`${webOrigin}/api/recon?${query.toString()}`);
    assertEqual(response.status(), 200, `organization directory page ${page + 1}`);
    const body = await response.json();
    const pageOrganizations = body?.data?.organizations;
    assert(Array.isArray(pageOrganizations), "organization directory page was malformed");
    for (const organization of pageOrganizations) {
      assertOrganizationAccess(organization);
      organizations.push({
        id: organization.id,
        name: organization.name,
        role: organization.role,
      });
    }
    pageSizes.push(pageOrganizations.length);
    const nextCursor = body?.meta?.nextCursor;
    if (nextCursor === undefined) return { organizations, pageSizes, cursors };
    assert(
      typeof nextCursor === "string" && /^[A-Za-z0-9_-]{1,1024}$/u.test(nextCursor),
      "organization directory cursor was malformed",
    );
    assert(!cursors.includes(nextCursor), "organization directory cursor repeated");
    cursors.push(nextCursor);
    cursor = nextCursor;
  }
  throw new Error("organization directory exceeded the bounded page ceiling");
}

function assertOrganizationAccess(value) {
  assert(isRecord(value), "organization access was not an object");
  assert(
    typeof value["id"] === "string" && /^[0-9a-f-]{36}$/u.test(value["id"]),
    "organization access ID was invalid",
  );
  assert(
    typeof value["name"] === "string" &&
      value["name"].trim().length > 0 &&
      value["name"].length <= 200,
    "organization access name was invalid",
  );
  assert(
    ["owner", "administrator", "analyst", "reviewer", "auditor"].includes(value["role"]),
    "organization access role was invalid",
  );
}

async function clickMoreAndExpectOptions(page, selector, expectedCount) {
  const directoryResponse = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        url.pathname === "/api/recon" &&
        url.searchParams.get("view") === "organizations" &&
        url.searchParams.has("cursor")
      );
    },
    { timeout: 30_000 },
  );
  await page.getByRole("button", { name: "More", exact: true }).click();
  assertEqual(
    (await directoryResponse).status(),
    200,
    `directory page for ${expectedCount} options`,
  );
  await expectOptionCount(selector, expectedCount);
}

async function searchOrganizationThroughUi(page, selector, organizationName, organizationId) {
  const directoryResponse = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        url.pathname === "/api/recon" &&
        url.searchParams.get("view") === "organizations" &&
        url.searchParams.get("search") === organizationName &&
        !url.searchParams.has("cursor")
      );
    },
    { timeout: 30_000 },
  );
  await page.getByRole("searchbox", { name: "Search organizations" }).fill(organizationName);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  assertEqual((await directoryResponse).status(), 200, "exact browser search response");
  await expectOptionCount(selector, 1);
  assertEqual(await selector.inputValue(), organizationId, "exact browser search target");
  await page.getByText(`Results for “${organizationName}” ·`, { exact: false }).waitFor();
  assertEqual(
    await page.getByText("Refine search to see additional memberships.", { exact: true }).count(),
    0,
    "post-search accumulation guidance count",
  );
}

async function expectOptionCount(selector, expectedCount) {
  await selector
    .locator("option")
    .nth(expectedCount - 1)
    .waitFor({ state: "attached" });
  assertEqual(await selector.locator("option").count(), expectedCount, "browser option count");
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

function requiredFixtureUser(username) {
  const user = realmFixture.users?.find((candidate) => candidate?.username === username);
  const initialPassword = user?.credentials?.find(({ type }) => type === "password")?.value;
  if (
    !user ||
    typeof user.id !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(user.id) ||
    user.email !== username ||
    user.emailVerified !== true ||
    user.enabled !== true ||
    typeof initialPassword !== "string"
  ) {
    throw new Error(`the synthetic realm fixture is missing verified user ${username}`);
  }
  return { id: user.id, username, initialPassword };
}

function directoryMembershipCountFromEnvironment() {
  const value = process.env["LIVE_ORGANIZATION_DIRECTORY_MEMBERSHIPS"] ?? "101";
  if (value !== "101" && value !== "501") {
    throw new Error("LIVE_ORGANIZATION_DIRECTORY_MEMBERSHIPS must be exactly 101 or 501");
  }
  return Number(value);
}

function directoryPageSizes(itemCount) {
  assert(Number.isSafeInteger(itemCount) && itemCount > 0, "directory item count was invalid");
  const pageSizes = Array.from({ length: Math.floor(itemCount / 50) }, () => 50);
  const remainder = itemCount % 50;
  if (remainder > 0) pageSizes.push(remainder);
  return pageSizes;
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

function sameOriginHeaders() {
  return {
    origin: webOrigin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
}

async function assertOidcDiscovery() {
  const discoveryUrl = `${oidcIssuer}/.well-known/openid-configuration`;
  const response = await fetch(discoveryUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  assertEqual(response.status, 200, "OIDC discovery response");
  const body = await response.json();
  assertEqual(body?.issuer, oidcIssuer, "OIDC discovery issuer");
  for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    const value = body?.[field];
    assert(typeof value === "string", `OIDC discovery ${field} was missing`);
    assertEqual(
      new URL(value).origin,
      new URL(oidcIssuer).origin,
      `OIDC discovery ${field} left the configured provider origin`,
    );
  }
}

function reportPhase(phase) {
  process.stderr.write(`[${verificationLabel}] ${phase}\n`);
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
    const closeApplicationDatabase = applicationDatabase
      ? applicationDatabase.end({ timeout: 5 }).catch(() => undefined)
      : Promise.resolve();
    await Promise.all([
      closeBrowser,
      closeDatabase,
      closeApplicationDatabase,
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
    throw new Error("live organization-directory verification is disabled in production");
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

function numericRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new Error(`${key} was not a safe integer`);
      return [key, number];
    }),
  );
}

function requiredRow(rows, label) {
  if (Array.isArray(rows)) {
    if (rows.length !== 1) throw new Error(`${label} did not contain exactly one row`);
    return rows[0];
  }
  if (!isRecord(rows)) throw new Error(`${label} was not an object`);
  return rows;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, received ${actualJson}`);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => nodeSetTimeout(resolve, milliseconds));
}

function sanitizedTail(output) {
  return sanitize(output).split("\n").slice(-120).join("\n");
}

function sanitize(value) {
  return String(value)
    .replaceAll(repositoryRoot, "<repository>")
    .replace(/([?&](?:code|state|session_state)=)[^&\s]*/giu, "$1<redacted>")
    .replace(/(authorization:\s*Bearer\s+)[^\s]+/giu, "$1<redacted>")
    .replace(/(reconai\.(?:session-token|organization-context)=)[^;\s]+/giu, "$1<redacted>");
}
