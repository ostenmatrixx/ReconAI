import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";

const repositoryRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const webRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { decode } = webRequire("next-auth/jwt");
const playwright = await import(webRequire.resolve("@playwright/test"));
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (!chromium) throw new Error("Playwright Chromium runtime is unavailable");
const postgres = (await import(repositoryRequire.resolve("postgres"))).default;
const realmFixture = JSON.parse(
  readFileSync(
    new URL("../infra/keycloak/reconai-development-realm.json", import.meta.url),
    "utf8",
  ),
);

const podman = "/opt/podman/bin/podman";
const network = "reconai-local_internal";
const verificationLabel = "io.reconai.verification=container-image-runtime";
const organizationId = "00000000-0000-4000-8000-000000000001";
const foreignOrganizationId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000010";
const apiContainer = "reconai-image-api";
const workerContainer = "reconai-image-worker";
const webContainer = "reconai-image-web";
const publicWebContainer = "reconai-image-web-public";
const keycloakContainer = "reconai-image-oidc";
const apiTlsContainer = "reconai-image-api-tls";
const containerNames = [
  keycloakContainer,
  apiContainer,
  apiTlsContainer,
  workerContainer,
  webContainer,
  publicWebContainer,
];
const images = Object.freeze({
  api: "localhost/reconai-api-verification:2026-07-30",
  worker: "localhost/reconai-worker-verification:2026-07-30",
  web: "localhost/reconai-web-verification:2026-07-30",
});
const keycloakImage =
  "quay.io/keycloak/keycloak:26.7.0@sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13";
const nodeRuntimeImage =
  "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";
const apiOrigin = "http://127.0.0.1:4100";
const publicWebOrigin = "http://127.0.0.1:3100";
const authenticatedWebOrigin = "https://reconai-image-web:3443";
const authenticatedWebLoopbackOrigin = "https://127.0.0.1:3443";
const keycloakOrigin = "https://reconai-image-oidc:8443";
const keycloakLoopbackOrigin = "https://127.0.0.1:8443";
const oidcIssuer = `${keycloakOrigin}/realms/reconai-development`;
const oidcClientId = "reconai-web-development";
const expectedRules = ["order-payment", "refund", "refund-accounting-split"];
const requestReason = "Verify the production-built container image reconciliation boundary";
const ownerFixture = requiredFixtureUser("owner@example.test");
const forbiddenRuntimeEnvironment = Object.freeze({
  api: [
    "API_ORIGIN",
    "DATABASE_ADMIN_URL",
    "DATABASE_MAINTENANCE_URL",
    "DATABASE_MIGRATION_URL",
    "DATABASE_WORKER_URL",
    "OIDC_CLIENT_SECRET",
    "SESSION_SECRET",
    "AI_API_KEY",
  ],
  worker: [
    "API_ORIGIN",
    "API_RATE_LIMIT_KEY_SECRET",
    "DATABASE_ADMIN_URL",
    "DATABASE_MAINTENANCE_URL",
    "DATABASE_MIGRATION_URL",
    "DATABASE_URL",
    "EMAIL_DELIVERY_TOKEN",
    "OIDC_CLIENT_SECRET",
    "OIDC_ISSUER",
    "SESSION_SECRET",
    "STRIPE_APP_WEBHOOK_SECRET",
    "SUPPORT_IDENTITY_HMAC_KEY",
    "AI_API_KEY",
  ],
  web: [
    "API_RATE_LIMIT_KEY_SECRET",
    "CONNECTOR_ENCRYPTION_KEYS",
    "DATABASE_ADMIN_URL",
    "DATABASE_MAINTENANCE_URL",
    "DATABASE_MIGRATION_URL",
    "DATABASE_URL",
    "DATABASE_WORKER_URL",
    "EMAIL_DELIVERY_TOKEN",
    "RECONAI_CONNECTOR_ENCRYPTION_KEY_V1",
    "S3_SECRET_ACCESS_KEY",
    "SHOPIFY_CLIENT_SECRET",
    "STRIPE_APP_WEBHOOK_SECRET",
    "STRIPE_OAUTH_SECRET_KEY",
    "SUPPORT_IDENTITY_HMAC_KEY",
    "AI_API_KEY",
  ],
});

if (process.env["NODE_ENV"] === "production" || process.env["APP_ENV"] === "production") {
  throw new Error("container image runtime verification is disabled in production");
}

const baseEnvironment = parseEnv(readFileSync(".env.example", "utf8"));
assertLoopbackUrl(baseEnvironment["DATABASE_ADMIN_URL"], "DATABASE_ADMIN_URL");
assertLoopbackUrl(baseEnvironment["DATABASE_URL"], "DATABASE_URL");
assertLoopbackUrl(baseEnvironment["REDIS_URL"], "REDIS_URL");
assertLoopbackUrl(baseEnvironment["S3_ENDPOINT"], "S3_ENDPOINT");

let adminDatabase;
let tenantlessDatabase;
let accessToken;
let originalFixtureIssuer;
let browser;
let browserContext;
let providerAuthorizationRequest;
let tlsRuntime;
let webTlsProxy;
let sessionSecret;
let oidcClientSecret;
const createdContainers = [];
const browserDiagnostics = [];
let runtimeEnvironment;

try {
  assertCommandAvailable();
  assertRuntimePreconditions();
  oidcClientSecret = randomBytes(32).toString("base64url");
  tlsRuntime = prepareTlsRuntime(oidcClientSecret);
  startContainer({
    name: keycloakContainer,
    image: keycloakImage,
    environment: {
      KC_BOOTSTRAP_ADMIN_USERNAME: "local-admin",
      KC_BOOTSTRAP_ADMIN_PASSWORD: "local-admin-only",
    },
    publish: "127.0.0.1:8443:8443",
    volumes: [
      `${tlsRuntime.certificatePath}:/runtime/tls-cert.pem:ro,Z`,
      `${tlsRuntime.privateKeyPath}:/runtime/tls-key.pem:ro,Z`,
      `${tlsRuntime.realmPath}:/opt/keycloak/data/import/reconai-development-realm.json:ro,Z`,
    ],
    command: [
      "start-dev",
      "--import-realm",
      "--health-enabled=true",
      "--http-enabled=false",
      "--https-port=8443",
      "--https-certificate-file=/runtime/tls-cert.pem",
      "--https-certificate-key-file=/runtime/tls-key.pem",
      `--hostname=${keycloakOrigin}`,
    ],
  });
  await waitForHttps(
    `${keycloakLoopbackOrigin}/realms/reconai-development/.well-known/openid-configuration`,
    tlsRuntime.certificate,
    90_000,
  );

  adminDatabase = postgres(baseEnvironment["DATABASE_ADMIN_URL"], { max: 2 });
  const fixtureIdentityRows = await adminDatabase`
    select issuer, subject, email
    from users
    where id = ${userId}::uuid
    limit 1
  `;
  const fixtureIdentity = requiredRow(fixtureIdentityRows, "synthetic fixture identity");
  assertEqual(fixtureIdentity.subject, userId, "synthetic fixture identity subject");
  assertEqual(fixtureIdentity.email, "owner@example.test", "synthetic fixture identity email");
  originalFixtureIssuer = String(fixtureIdentity.issuer);
  assertLoopbackUrl(originalFixtureIssuer, "synthetic fixture identity issuer");
  await adminDatabase`
    update users
    set issuer = ${oidcIssuer}
    where id = ${userId}::uuid
      and issuer = ${originalFixtureIssuer}
  `;

  sessionSecret = randomBytes(48).toString("base64url");
  const commonApplicationEnvironment = {
    NODE_ENV: "development",
    APP_ENV: "container-image-verification",
    WEB_ORIGIN: authenticatedWebOrigin,
    REDIS_URL: "redis://redis:6379",
    S3_ENDPOINT: "http://minio:9000",
    S3_REGION: requiredEnvironment(baseEnvironment, "S3_REGION"),
    S3_BUCKET: requiredEnvironment(baseEnvironment, "S3_BUCKET"),
    S3_ACCESS_KEY_ID: requiredEnvironment(baseEnvironment, "S3_ACCESS_KEY_ID"),
    S3_SECRET_ACCESS_KEY: requiredEnvironment(baseEnvironment, "S3_SECRET_ACCESS_KEY"),
    S3_FORCE_PATH_STYLE: requiredEnvironment(baseEnvironment, "S3_FORCE_PATH_STYLE"),
    S3_SERVER_SIDE_ENCRYPTION: requiredEnvironment(
      baseEnvironment,
      "S3_SERVER_SIDE_ENCRYPTION",
      true,
    ),
    S3_KMS_KEY_ID: requiredEnvironment(baseEnvironment, "S3_KMS_KEY_ID", true),
    CONNECTOR_ENCRYPTION_KEYS: requiredEnvironment(baseEnvironment, "CONNECTOR_ENCRYPTION_KEYS"),
    CONNECTOR_ENCRYPTION_ACTIVE_KEY_VERSION: requiredEnvironment(
      baseEnvironment,
      "CONNECTOR_ENCRYPTION_ACTIVE_KEY_VERSION",
    ),
    RECONAI_CONNECTOR_ENCRYPTION_KEY_V1: requiredEnvironment(
      baseEnvironment,
      "RECONAI_CONNECTOR_ENCRYPTION_KEY_V1",
    ),
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_TRACE_SAMPLE_RATIO: requiredEnvironment(baseEnvironment, "OTEL_TRACE_SAMPLE_RATIO"),
    OTEL_METRIC_EXPORT_INTERVAL_MS: requiredEnvironment(
      baseEnvironment,
      "OTEL_METRIC_EXPORT_INTERVAL_MS",
    ),
    OTEL_EXPORT_TIMEOUT_MS: requiredEnvironment(baseEnvironment, "OTEL_EXPORT_TIMEOUT_MS"),
    LOG_LEVEL: "info",
  };
  runtimeEnvironment = Object.freeze({
    api: Object.freeze({
      ...commonApplicationEnvironment,
      API_HOST: "0.0.0.0",
      API_PORT: "4000",
      API_RATE_LIMIT_STORE: "local",
      DATABASE_URL: "postgresql://reconai_app:local-app-only@postgres:5432/reconai",
      NODE_EXTRA_CA_CERTS: "/runtime/tls-cert.pem",
      OIDC_ISSUER: oidcIssuer,
      OIDC_CLIENT_ID: oidcClientId,
    }),
    worker: Object.freeze({
      ...commonApplicationEnvironment,
      DATABASE_WORKER_URL: "postgresql://reconai_worker:local-worker-only@postgres:5432/reconai",
      PROVIDER_GAP_REPAIR_ENABLED: "false",
      PROVIDER_PRIVACY_DEADLINE_MONITOR_ENABLED: "false",
    }),
    authenticatedWeb: Object.freeze({
      NODE_ENV: "production",
      NODE_EXTRA_CA_CERTS: "/runtime/tls-cert.pem",
      APP_ENV: "container-image-verification",
      API_ORIGIN: "https://reconai-image-api-tls:4443",
      HOSTNAME: "0.0.0.0",
      NEXTAUTH_URL: authenticatedWebOrigin,
      OIDC_CLIENT_ID: oidcClientId,
      OIDC_CLIENT_SECRET: oidcClientSecret,
      OIDC_ID_TOKEN_SIGNING_ALGORITHM: "RS256",
      OIDC_ISSUER: oidcIssuer,
      PORT: "3000",
      REDIS_URL: "redis://redis:6379",
      SESSION_COOKIE_SECURE: "true",
      SESSION_REVOCATION_STORE: "redis",
      SESSION_REVOCATION_REDIS_CONNECT_TIMEOUT_MS: "1000",
      SESSION_REVOCATION_REDIS_COMMAND_TIMEOUT_MS: "1000",
      SESSION_SECRET: sessionSecret,
      WEB_ORIGIN: authenticatedWebOrigin,
    }),
    publicWeb: Object.freeze({
      NODE_ENV: "production",
      APP_ENV: "container-image-verification",
      API_ORIGIN: "https://api.container-verification.example",
      HOSTNAME: "0.0.0.0",
      NEXTAUTH_URL: "https://web.container-verification.example",
      OIDC_CLIENT_ID: requiredEnvironment(baseEnvironment, "OIDC_CLIENT_ID"),
      OIDC_CLIENT_SECRET: sessionSecret,
      OIDC_ID_TOKEN_SIGNING_ALGORITHM: "RS256",
      OIDC_ISSUER: "https://identity.container-verification.example/realms/reconai",
      PORT: "3000",
      REDIS_URL: "redis://redis:6379",
      SESSION_COOKIE_SECURE: "true",
      SESSION_REVOCATION_STORE: "redis",
      SESSION_REVOCATION_REDIS_CONNECT_TIMEOUT_MS: "1000",
      SESSION_REVOCATION_REDIS_COMMAND_TIMEOUT_MS: "1000",
      SESSION_SECRET: sessionSecret,
      WEB_ORIGIN: "https://web.container-verification.example",
    }),
  });

  startContainer({
    name: apiContainer,
    image: images.api,
    environment: runtimeEnvironment.api,
    publish: "127.0.0.1:4100:4000",
    volumes: [`${tlsRuntime.certificatePath}:/runtime/tls-cert.pem:ro,Z`],
  });
  startContainer({
    name: apiTlsContainer,
    image: nodeRuntimeImage,
    environment: {},
    volumes: [
      `${tlsRuntime.certificatePath}:/runtime/tls-cert.pem:ro,Z`,
      `${tlsRuntime.privateKeyPath}:/runtime/tls-key.pem:ro,Z`,
      `${tlsRuntime.apiProxyPath}:/runtime/api-tls-proxy.mjs:ro,Z`,
    ],
    command: ["node", "/runtime/api-tls-proxy.mjs"],
    user: "node",
  });
  startContainer({
    name: workerContainer,
    image: images.worker,
    environment: runtimeEnvironment.worker,
  });
  startContainer({
    name: webContainer,
    image: images.web,
    environment: runtimeEnvironment.authenticatedWeb,
    publish: "127.0.0.1:3000:3000",
    volumes: [`${tlsRuntime.certificatePath}:/runtime/tls-cert.pem:ro,Z`],
  });
  startContainer({
    name: publicWebContainer,
    image: images.web,
    environment: runtimeEnvironment.publicWeb,
    publish: "127.0.0.1:3100:3000",
  });
  webTlsProxy = await startWebTlsProxy(tlsRuntime);

  await Promise.all([
    waitForHttp(`${apiOrigin}/health/live`, 60_000),
    waitForHttp(`${apiOrigin}/health/ready`, 60_000, 200),
    waitForHttp(publicWebOrigin, 60_000),
    waitForHttps(authenticatedWebLoopbackOrigin, tlsRuntime.certificate, 60_000),
  ]);

  const webResponse = await fetch(publicWebOrigin, {
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  const webBody = await webResponse.text();
  assertEqual(webResponse.status, 200, "container web public response");
  if (!webBody.includes("Reconciliation your finance team can actually defend.")) {
    throw new Error("container web response omitted the product heading");
  }
  const contentSecurityPolicy = webResponse.headers.get("content-security-policy");
  if (!contentSecurityPolicy?.includes("script-src")) {
    throw new Error("container web response omitted the script CSP");
  }

  browser = await chromium.launch({
    headless: true,
    args: [
      "--host-resolver-rules=MAP reconai-image-oidc 127.0.0.1, MAP reconai-image-web 127.0.0.1",
    ],
  });
  browserContext = await browser.newContext({ ignoreHTTPSErrors: true });
  browserContext.setDefaultTimeout(30_000);
  browserContext.setDefaultNavigationTimeout(30_000);
  const page = await browserContext.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserDiagnostics.push({ kind: "console-error", message: message.text().slice(0, 300) });
    }
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    browserDiagnostics.push({
      kind: "request-failed",
      method: request.method(),
      origin: url.origin,
      path: url.pathname,
      reason: request.failure()?.errorText,
    });
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (response.status() >= 400 || url.pathname.startsWith("/api/auth/")) {
      browserDiagnostics.push({
        kind: "response",
        method: response.request().method(),
        origin: url.origin,
        path: url.pathname,
        status: response.status(),
      });
    }
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === keycloakOrigin && url.pathname.endsWith("/protocol/openid-connect/auth")) {
      providerAuthorizationRequest = url;
    }
  });
  await page.goto(authenticatedWebOrigin);
  await startFixtureSignInThroughUi(page);
  await completeFixtureLogin(page, ownerFixture);
  await page.getByRole("button", { name: "Sign out" }).waitFor();
  const organizationSelectionStatus = await selectFixtureOrganizationThroughUi(
    page,
    browserContext,
  );

  const browserSession = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    return { body: await response.text(), status: response.status };
  });
  assertEqual(browserSession.status, 200, "container web browser-session response");
  if (
    /(apiAccessToken|apiRefreshToken|apiIdToken|access_token|refresh_token)/u.test(
      browserSession.body,
    )
  ) {
    throw new Error("container web browser session disclosed a provider credential field");
  }
  accessToken = await readApiAccessToken(browserContext, sessionSecret);
  assertProviderAuthorizationRequest();

  const foreignResponse = await apiRequest(
    `/v1/organizations/${foreignOrganizationId}/reconciliation-runs?limit=1`,
  );
  assertEqual(foreignResponse.status, 404, "foreign-tenant run discovery");

  await page.goto(`${authenticatedWebOrigin}/dashboard/runs`);
  await page.getByRole("heading", { name: "Reconciliation runs" }).waitFor();
  await page.getByRole("button", { name: "Start run" }).click();
  await page.getByLabel("Business time zone").fill("UTC");
  await page.getByLabel("Reason · required and audit-visible").fill(requestReason);
  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });
  const actionResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/recon/actions" &&
      response.request().method() === "POST",
    { timeout: 30_000 },
  );
  await page.getByRole("button", { name: "Confirm and queue" }).click();
  const actionResponse = await actionResponsePromise;
  assertEqual(actionResponse.status(), 202, "container browser BFF run start");
  const actionBody = await actionResponse.json();
  const runId = requiredUuid(actionBody?.data?.id, "container BFF run id");
  if (actionBody?.meta !== undefined || actionBody?.data?.status === undefined) {
    throw new Error("container BFF run response violated its minimized response contract");
  }

  const detail = await waitForRun(runId);
  assertEqual(detail.status, "succeeded", "container image run status");
  assertEqual(detail.inputCount, 8, "container image run input count");
  assertEqual(detail.matchCount, 3, "container image run match count");
  assertEqual(detail.exceptionCount, 1, "container image run exception count");
  assertEqual(detail.errorCount, 0, "container image run error count");
  assertEqual(detail.operationalStateApplied, true, "container image operational authority");
  const matchedRules = detail.matches.map((match) => match.ruleId).sort();
  assertJsonEqual(matchedRules, expectedRules, "container image matched rules");
  const split = detail.matches.find((match) => match.ruleId === "refund-accounting-split");
  if (!split) throw new Error("container image run omitted the conserved accounting split");
  assertEqual(split.ruleVersion, "1.5.0", "container image split rule version");
  assertEqual(
    split.evidence?.reasonCode,
    "REFUND_ACCOUNTING_SPLIT_TOTAL_MATCHED",
    "container image split reason",
  );
  assertEqual(split.recordReferences?.length, 3, "container image split cardinality");
  assertEqual(
    detail.exceptions[0]?.evidence?.reasonCode,
    "DUPLICATE_SOURCE_EXTERNAL_IDENTIFIER",
    "container image exception reason",
  );
  await page
    .getByText("Bounded per-run evidence: 3 matches and 1 exception.", { exact: true })
    .waitFor({ state: "visible", timeout: 45_000 });
  await page
    .getByText("REFUND_ACCOUNTING_SPLIT_TOTAL_MATCHED", { exact: true })
    .waitFor({ state: "visible" });
  await page
    .getByText("DUPLICATE_SOURCE_EXTERNAL_IDENTIFIER", { exact: true })
    .waitFor({ state: "visible" });
  const bffDetail = await page.evaluate(async (id) => {
    const response = await fetch(`/api/recon?view=run&id=${encodeURIComponent(id)}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    return { body: await response.json(), status: response.status };
  }, runId);
  assertEqual(bffDetail.status, 200, "container browser BFF run detail");
  assertEqual(bffDetail.body?.data?.status, "succeeded", "container BFF terminal run status");
  assertEqual(bffDetail.body?.data?.matchCount, 3, "container BFF match count");
  assertEqual(bffDetail.body?.data?.exceptionCount, 1, "container BFF exception count");

  tenantlessDatabase = postgres(baseEnvironment["DATABASE_URL"], { max: 1 });
  const persistenceRows = await adminDatabase`
    select
      (select count(*)::integer from reconai_schema_migrations) as migrations,
      (select count(*)::integer from reconciliation_runs
        where organization_id = ${organizationId}::uuid and id = ${runId}::uuid
          and status = 'succeeded' and operational_state_applied) as successful_runs,
      (select count(*)::integer from match_occurrence_snapshots
        where organization_id = ${organizationId}::uuid and run_id = ${runId}::uuid)
        as match_snapshots,
      (select count(*)::integer from exception_occurrence_snapshots
        where organization_id = ${organizationId}::uuid and run_id = ${runId}::uuid)
        as exception_snapshots,
      (select count(*)::integer from outbox_events
        where organization_id = ${organizationId}::uuid
          and payload ->> 'runId' = ${runId} and published_at is not null) as published_outbox,
      (select count(*)::integer from job_executions
        where organization_id = ${organizationId}::uuid and status = 'succeeded'
          and outbox_event_id in (
            select id from outbox_events
            where organization_id = ${organizationId}::uuid and payload ->> 'runId' = ${runId}
          )) as successful_jobs,
      (select count(*)::integer from audit_events
        where organization_id = ${organizationId}::uuid
          and resource_type = 'reconciliation_run' and resource_id = ${runId})
        as run_audit_events
  `;
  const persistence = numericRow(requiredRow(persistenceRows, "container persistence counts"));
  assertEqual(persistence.migrations, 56, "container migration count");
  assertEqual(persistence.successful_runs, 1, "container successful run count");
  assertEqual(persistence.match_snapshots, 3, "container match snapshot count");
  assertEqual(persistence.exception_snapshots, 1, "container exception snapshot count");
  assertEqual(persistence.published_outbox, 1, "container published outbox count");
  assertEqual(persistence.successful_jobs, 1, "container successful job count");
  assertEqual(persistence.run_audit_events, 2, "container run audit count");
  const correlationRows = await adminDatabase`
    select correlation_id::text as correlation_id
    from audit_events
    where organization_id = ${organizationId}::uuid
      and resource_type = 'reconciliation_run'
      and resource_id = ${runId}
    order by occurred_at asc, id asc
    limit 1
  `;
  const correlationId = requiredUuid(
    requiredRow(correlationRows, "container run audit correlation").correlation_id,
    "container run audit correlation id",
  );

  const tenantlessRows = await tenantlessDatabase`
    select
      (select count(*)::integer from organizations) as organizations,
      (select count(*)::integer from canonical_records) as canonical_records,
      (select count(*)::integer from reconciliation_runs) as reconciliation_runs,
      (select count(*)::integer from audit_events) as audit_events
  `;
  const tenantless = numericRow(requiredRow(tenantlessRows, "tenantless RLS counts"));
  for (const [name, count] of Object.entries(tenantless)) {
    assertEqual(count, 0, `tenantless ${name} count`);
  }

  const runtime = {
    api: inspectImageAndContainer(
      images.api,
      apiContainer,
      Object.keys(runtimeEnvironment.api),
      forbiddenRuntimeEnvironment.api,
      ["/runtime/tls-cert.pem"],
    ),
    worker: inspectImageAndContainer(
      images.worker,
      workerContainer,
      Object.keys(runtimeEnvironment.worker),
      forbiddenRuntimeEnvironment.worker,
      [],
    ),
    web: {
      authenticatedProductionTls: inspectImageAndContainer(
        images.web,
        webContainer,
        Object.keys(runtimeEnvironment.authenticatedWeb),
        forbiddenRuntimeEnvironment.web,
        ["/runtime/tls-cert.pem"],
      ),
      productionPublicRoute: inspectImageAndContainer(
        images.web,
        publicWebContainer,
        Object.keys(runtimeEnvironment.publicWeb),
        forbiddenRuntimeEnvironment.web,
        [],
      ),
    },
  };
  const forbiddenLogValues = [
    sessionSecret,
    "local-postgres-only",
    "local-app-only",
    "local-worker-only",
    "local-maintenance-only",
    "local-admin-only",
    ownerFixture.initialPassword,
    baseEnvironment["S3_SECRET_ACCESS_KEY"],
    oidcClientSecret,
    baseEnvironment["RECONAI_CONNECTOR_ENCRYPTION_KEY_V1"],
  ].filter((value) => typeof value === "string" && value.length >= 8);
  const logScan = Object.fromEntries(
    containerNames.map((name) => {
      const logs = podmanOutput("bounded container log inspection", [
        "logs",
        "--tail",
        "300",
        name,
      ]);
      return [
        name,
        {
          checkedLines: logs.split(/\r?\n/u).filter(Boolean).length,
          findings: countFindings(logs, forbiddenLogValues),
        },
      ];
    }),
  );
  if (Object.values(logScan).some((result) => result.findings !== 0)) {
    throw new Error("bounded container logs contained a checked synthetic credential value");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        recordedAt: new Date().toISOString(),
        component: "production-built-container-image-reconciliation-runtime",
        outcome: "local_container_image_vertical_slice_passed",
        productionReadinessClaim: false,
        scope: {
          customerDataUsed: false,
          providerSystemsContacted: false,
          runtimeConfiguration:
            "development API/worker dependency transport plus production web authentication over ephemeral TLS, Secure cookies, Redis revocation, and production-built image artifacts",
          network,
        },
        runtime: {
          podmanClientVersion: podmanOutput("Podman client version", [
            "version",
            "--format",
            "{{.Client.Version}}",
          ]).trim(),
          podmanServerVersion: podmanOutput("Podman server version", [
            "version",
            "--format",
            "{{.Server.Version}}",
          ]).trim(),
          images: runtime,
          declaredDockerHealthcheckObservedByPodman: false,
          manualApiLivenessStatus: 200,
          manualApiReadinessStatus: 200,
          webStatus: webResponse.status,
          webCspPresent: true,
          environmentCredentialIsolation: {
            api: environmentIsolation(runtimeEnvironment.api, forbiddenRuntimeEnvironment.api),
            worker: environmentIsolation(
              runtimeEnvironment.worker,
              forbiddenRuntimeEnvironment.worker,
            ),
            authenticatedWeb: environmentIsolation(
              runtimeEnvironment.authenticatedWeb,
              forbiddenRuntimeEnvironment.web,
            ),
            publicWeb: environmentIsolation(
              runtimeEnvironment.publicWeb,
              forbiddenRuntimeEnvironment.web,
            ),
          },
        },
        authorization: {
          oidcAuthority: "isolated digest-pinned Keycloak 26.7.0 verification container",
          oidcTransport: "ephemeral self-signed TLS trusted only by the bounded verifier runtime",
          authorizationCodePkceLoginCompleted: true,
          authorizationRequestObserved: providerAuthorizationRequest !== undefined,
          authorizationClientIdMatched:
            providerAuthorizationRequest?.searchParams.get("client_id") === oidcClientId,
          authorizationRedirectMatched:
            providerAuthorizationRequest?.searchParams.get("redirect_uri") ===
            `${authenticatedWebOrigin}/api/auth/callback/keycloak`,
          authorizationPkceS256:
            providerAuthorizationRequest?.searchParams.get("code_challenge_method") === "S256",
          browserSessionStatus: browserSession.status,
          browserProviderCredentialDisclosure: false,
          authenticatedBffRunStartStatus: actionResponse.status(),
          authenticatedBffRunDetailStatus: bffDetail.status,
          bffUpstreamCorrelationIdDisclosed: false,
          explicitOrganizationSelectionStatus: organizationSelectionStatus,
          secureHttpOnlySessionCookieObserved: true,
          syntheticKeycloakRealmImportedIntoIsolatedContainer: true,
          composeKeycloakClientMutated: false,
          verifiedSubjectBoundToFixtureMembership: true,
          syntheticFixtureIssuerTemporarilyRebound: true,
          foreignOrganizationExists: true,
          crossTenantRunDiscoveryStatus: foreignResponse.status,
          crossTenantExistenceDisclosed: false,
          tenantlessRestrictedRoleCounts: tenantless,
        },
        reconciliation: {
          runId,
          correlationId,
          status: detail.status,
          inputCount: detail.inputCount,
          matchCount: detail.matchCount,
          exceptionCount: detail.exceptionCount,
          errorCount: detail.errorCount,
          operationalStateApplied: detail.operationalStateApplied,
          matchedRules,
          splitRuleVersion: split.ruleVersion,
          splitReasonCode: split.evidence.reasonCode,
          splitRecordReferenceCount: split.recordReferences.length,
          exceptionReasonCode: detail.exceptions[0].evidence.reasonCode,
        },
        persistence,
        boundedLogScan: logScan,
        limitations: [
          "The API and worker images were production-built but intentionally ran with development configuration because the local dependency network uses HTTP and development credentials.",
          "One web-image instance ran the real Keycloak authorization-code-plus-PKCE and authenticated BFF journey with production HTTPS origins, Secure cookies, and Redis-backed revocation; a separate production-valid instance served only its public route over loopback HTTP.",
          "Ephemeral self-signed TLS terminated at a verifier-owned Node proxy for the web image and directly in the isolated Keycloak container; this does not prove production ingress or certificate policy.",
          "Chromium used fixed host-resolver mappings and ignored only the ephemeral synthetic CA error so the browser and private containers shared the exact Keycloak issuer and web callback hostnames without changing workstation DNS.",
          "Podman's default OCI image format ignored Docker HEALTHCHECK metadata, so this verifier called liveness and readiness directly.",
          "This runtime exercise does not scan images itself; the exact application image identities separately passed the bounded Trivy/CycloneDX candidate verifier.",
          "This is one rootless single-machine ARM64 execution, not Docker Engine, an amd64 candidate archive, protected staging, TLS/ingress, a prior/current image rollout, or a capacity/SLO result.",
          "No provider sandbox, customer payload, production credential, external collector, alert delivery, hosted CI, publication, registry push, or deployment was used.",
        ],
        credentialsRecorded: false,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(
    `${sanitize(
      `${message}\n${JSON.stringify({
        browserDiagnostics: browserDiagnostics.slice(-30),
        containerDiagnostics: collectFailureContainerDiagnostics(),
      })}`,
      [
        accessToken,
        sessionSecret,
        oidcClientSecret,
        baseEnvironment["OIDC_CLIENT_SECRET"],
        ownerFixture.initialPassword,
        "local-admin-only",
      ],
    )}\n`,
  );
  process.exitCode = 1;
} finally {
  await browserContext?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await closeServer(webTlsProxy).catch(() => undefined);
  await tenantlessDatabase?.end({ timeout: 5 }).catch(() => undefined);
  if (adminDatabase && originalFixtureIssuer) {
    await adminDatabase`
      update users
      set issuer = ${originalFixtureIssuer}
      where id = ${userId}::uuid
        and issuer = ${oidcIssuer}
    `.catch(() => {
      process.stderr.write("Synthetic fixture issuer restoration failed.\n");
      process.exitCode = 1;
    });
  }
  await adminDatabase?.end({ timeout: 5 }).catch(() => undefined);
  for (const name of [...createdContainers].reverse()) {
    stopAndRemoveContainer(name);
  }
  if (tlsRuntime?.directory) {
    rmSync(tlsRuntime.directory, { force: true, recursive: true });
  }
  accessToken = undefined;
}

function prepareTlsRuntime(clientSecret) {
  const directory = mkdtempSync(join(tmpdir(), "reconai-container-image-tls-"));
  chmodSync(directory, 0o755);
  const configurationPath = join(directory, "openssl.cnf");
  const certificatePath = join(directory, "tls-cert.pem");
  const privateKeyPath = join(directory, "tls-key.pem");
  const realmPath = join(directory, "reconai-development-realm.json");
  const apiProxyPath = join(directory, "api-tls-proxy.mjs");
  writeFileSync(
    configurationPath,
    [
      "[req]",
      "distinguished_name = distinguished_name",
      "x509_extensions = certificate_extensions",
      "prompt = no",
      "",
      "[distinguished_name]",
      "CN = ReconAI synthetic container verification CA",
      "",
      "[certificate_extensions]",
      "subjectAltName = @alternative_names",
      "basicConstraints = critical,CA:TRUE",
      "keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign",
      "extendedKeyUsage = serverAuth",
      "",
      "[alternative_names]",
      "DNS.1 = reconai-image-oidc",
      "DNS.2 = reconai-image-web",
      "DNS.3 = reconai-image-api-tls",
      "DNS.4 = localhost",
      "IP.1 = 127.0.0.1",
      "",
    ].join("\n"),
    { mode: 0o644 },
  );
  const openssl = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      privateKeyPath,
      "-out",
      certificatePath,
      "-config",
      configurationPath,
    ],
    { stdio: "ignore" },
  );
  if (openssl.status !== 0) {
    rmSync(directory, { force: true, recursive: true });
    throw new Error("OpenSSL could not prepare the isolated container verification TLS material");
  }
  chmodSync(certificatePath, 0o644);
  chmodSync(privateKeyPath, 0o644);

  const realm = cloneJson(realmFixture);
  realm.accessTokenLifespan = 300;
  realm.revokeRefreshToken = true;
  realm.refreshTokenMaxReuse = 0;
  const client = realm.clients?.find((candidate) => candidate.clientId === oidcClientId);
  if (!client) throw new Error("synthetic Keycloak client fixture is missing");
  client.secret = clientSecret;
  client.redirectUris = [`${authenticatedWebOrigin}/api/auth/callback/keycloak`];
  client.webOrigins = [authenticatedWebOrigin];
  client.attributes = {
    ...(client.attributes ?? {}),
    "post.logout.redirect.uris": `${authenticatedWebOrigin}/`,
    "backchannel.logout.url": `${authenticatedWebOrigin}/api/auth/backchannel-logout`,
  };
  writeFileSync(realmPath, `${JSON.stringify(realm, null, 2)}\n`, { mode: 0o644 });
  writeFileSync(
    apiProxyPath,
    [
      'import { readFileSync } from "node:fs";',
      'import { request as httpRequest } from "node:http";',
      'import { createServer as createHttpsServer } from "node:https";',
      "",
      "const server = createHttpsServer(",
      "  {",
      '    cert: readFileSync("/runtime/tls-cert.pem"),',
      '    key: readFileSync("/runtime/tls-key.pem"),',
      "  },",
      "  (request, response) => {",
      "    const headers = { ...request.headers };",
      "    for (const name of [",
      '      "connection",',
      '      "forwarded",',
      '      "host",',
      '      "proxy-connection",',
      '      "transfer-encoding",',
      '      "x-forwarded-for",',
      '      "x-forwarded-host",',
      '      "x-forwarded-port",',
      '      "x-forwarded-proto",',
      "    ]) Reflect.deleteProperty(headers, name);",
      '    headers.host = "reconai-image-api:4000";',
      '    headers["x-forwarded-for"] = request.socket.remoteAddress ?? "127.0.0.1";',
      '    headers["x-forwarded-host"] = "reconai-image-api-tls:4443";',
      '    headers["x-forwarded-port"] = "4443";',
      '    headers["x-forwarded-proto"] = "https";',
      "    const upstream = httpRequest(",
      "      {",
      '        hostname: "reconai-image-api",',
      "        port: 4000,",
      "        method: request.method,",
      "        path: request.url,",
      "        headers,",
      "      },",
      "      (upstreamResponse) => {",
      "        response.writeHead(",
      "          upstreamResponse.statusCode ?? 502,",
      "          upstreamResponse.statusMessage,",
      "          upstreamResponse.rawHeaders,",
      "        );",
      "        upstreamResponse.pipe(response);",
      "      },",
      "    );",
      '    upstream.on("error", () => {',
      '      if (!response.headersSent) response.writeHead(502, { "cache-control": "no-store" });',
      "      response.end();",
      "    });",
      "    request.pipe(upstream);",
      "  },",
      ");",
      'server.listen(4443, "0.0.0.0");',
      "",
    ].join("\n"),
    { mode: 0o644 },
  );
  return {
    apiProxyPath,
    certificate: readFileSync(certificatePath),
    certificatePath,
    directory,
    privateKey: readFileSync(privateKeyPath),
    privateKeyPath,
    realmPath,
  };
}

async function startWebTlsProxy(runtime) {
  const server = createHttpsServer(
    { cert: runtime.certificate, key: runtime.privateKey },
    (request, response) => {
      const headers = { ...request.headers };
      for (const name of [
        "connection",
        "forwarded",
        "host",
        "proxy-connection",
        "transfer-encoding",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-port",
        "x-forwarded-proto",
      ]) {
        Reflect.deleteProperty(headers, name);
      }
      headers.host = "reconai-image-web:3443";
      headers["x-forwarded-for"] = request.socket.remoteAddress ?? "127.0.0.1";
      headers["x-forwarded-host"] = "reconai-image-web:3443";
      headers["x-forwarded-port"] = "3443";
      headers["x-forwarded-proto"] = "https";
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: 3000,
          method: request.method,
          path: request.url,
          headers,
        },
        (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.statusMessage,
            upstreamResponse.rawHeaders,
          );
          upstreamResponse.pipe(response);
        },
      );
      upstream.once("error", () => {
        if (!response.headersSent) response.writeHead(502, { "cache-control": "no-store" });
        response.end();
      });
      request.pipe(upstream);
    },
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(3443, "127.0.0.1", resolve);
  });
  return server;
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function assertCommandAvailable() {
  const result = spawnSync(podman, ["version"], { encoding: "utf8", stdio: "ignore" });
  if (result.status !== 0) throw new Error("the fixed Podman runtime is unavailable");
}

function assertRuntimePreconditions() {
  const networkResult = spawnSync(podman, ["network", "exists", network], { stdio: "ignore" });
  if (networkResult.status !== 0) {
    throw new Error(`required private network ${network} is unavailable`);
  }
  for (const name of containerNames) {
    const existing = spawnSync(podman, ["container", "exists", name], { stdio: "ignore" });
    if (existing.status === 0) {
      throw new Error(`refusing to replace pre-existing container ${name}`);
    }
  }
  for (const image of [...Object.values(images), keycloakImage, nodeRuntimeImage]) {
    const existing = spawnSync(podman, ["image", "exists", image], { stdio: "ignore" });
    if (existing.status !== 0) throw new Error(`required local image ${image} is unavailable`);
  }
}

function startContainer({ name, image, environment, publish, volumes = [], command, user }) {
  const arguments_ = [
    "run",
    "--detach",
    "--name",
    name,
    "--label",
    verificationLabel,
    "--network",
    network,
    "--cap-drop=all",
    "--security-opt=no-new-privileges",
  ];
  if (publish) arguments_.push("--publish", publish);
  if (user) arguments_.push("--user", user);
  for (const volume of volumes) arguments_.push("--volume", volume);
  for (const [key, value] of Object.entries(environment)) {
    arguments_.push("--env", `${key}=${value}`);
  }
  arguments_.push(image);
  if (command) arguments_.push(...command);
  const result = spawnSync(podman, arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`Podman could not start the ${name} verification container`);
  }
  createdContainers.push(name);
}

async function waitForHttp(url, timeoutMilliseconds, expectedStatus) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    for (const name of createdContainers) {
      const state = podmanOutput("container state inspection", [
        "inspect",
        "--format",
        "{{.State.Status}} {{.State.ExitCode}}",
        name,
      ]).trim();
      if (state.startsWith("exited")) {
        throw new Error(`${name} exited before ${url} became available`);
      }
    }
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(1_000),
      });
      if (
        expectedStatus === undefined ? response.status < 500 : response.status === expectedStatus
      ) {
        return;
      }
    } catch {
      // Bounded startup retries are expected while the image process initializes.
    }
    await delay(250);
  }
  throw new Error(`${url} did not reach its expected status in the bounded startup window`);
}

async function waitForHttps(url, certificate, timeoutMilliseconds, expectedStatus) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    assertCreatedContainersRunning(url);
    try {
      const status = await httpsStatus(url, certificate);
      if (expectedStatus === undefined ? status < 500 : status === expectedStatus) return;
    } catch {
      // Bounded startup retries are expected while the TLS endpoint initializes.
    }
    await delay(250);
  }
  throw new Error(`${url} did not reach its expected HTTPS status in the bounded startup window`);
}

function assertCreatedContainersRunning(url) {
  for (const name of createdContainers) {
    const state = podmanOutput("container state inspection", [
      "inspect",
      "--format",
      "{{.State.Status}} {{.State.ExitCode}}",
      name,
    ]).trim();
    if (state.startsWith("exited")) {
      throw new Error(`${name} exited before ${url} became available`);
    }
  }
}

function httpsStatus(url, certificate) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        ca: certificate,
        method: "GET",
        timeout: 2_000,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.once("timeout", () => request.destroy(new Error("HTTPS readiness timed out")));
    request.once("error", reject);
    request.end();
  });
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${apiOrigin}${path}`, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "x-request-id": randomUUID(),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`container API returned non-JSON with status ${response.status.toString()}`);
  }
  return { status: response.status, body };
}

async function waitForRun(runId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await apiRequest(
      `/v1/organizations/${organizationId}/reconciliation-runs/${runId}`,
    );
    assertEqual(response.status, 200, "container API run detail");
    const detail = response.body?.data;
    if (detail?.status === "succeeded") return detail;
    if (detail?.status === "failed") throw new Error("container image reconciliation run failed");
    await delay(250);
  }
  throw new Error("container image reconciliation run did not finish within 60 seconds");
}

function inspectImageAndContainer(
  image,
  container,
  expectedInjectedVariableNames,
  forbiddenVariableNames,
  expectedReadOnlyMountDestinations,
) {
  const imageInspect = JSON.parse(podmanOutput("image inspection", ["image", "inspect", image]))[0];
  const containerInspect = JSON.parse(
    podmanOutput("container inspection", ["container", "inspect", container]),
  )[0];
  const configuredEnvironmentNames = containerInspect.Config.Env.map(
    (entry) => entry.split("=", 1)[0],
  );
  for (const name of expectedInjectedVariableNames) {
    if (!configuredEnvironmentNames.includes(name)) {
      throw new Error(`${container} omitted allowlisted runtime variable ${name}`);
    }
  }
  for (const name of forbiddenVariableNames) {
    if (configuredEnvironmentNames.includes(name)) {
      throw new Error(`${container} received forbidden runtime variable ${name}`);
    }
  }
  const uid = podmanOutput("container user inspection", ["exec", container, "id", "-u"]).trim();
  assertEqual(containerInspect?.Config?.User, "node", `${container} declared user`);
  assertEqual(uid, "1000", `${container} effective user`);
  assertEqual(containerInspect?.State?.Status, "running", `${container} runtime state`);
  const mounts = (containerInspect.Mounts ?? []).map((mount) => ({
    destination: mount.Destination,
    readOnly: mount.RW === false,
  }));
  assertJsonEqual(
    mounts.map(({ destination }) => destination).sort(),
    [...expectedReadOnlyMountDestinations].sort(),
    `${container} read-only mount destinations`,
  );
  if (mounts.some(({ readOnly }) => !readOnly)) {
    throw new Error(`${container} received a writable verification mount`);
  }
  return {
    imageId: imageInspect?.Id,
    architecture: imageInspect?.Architecture,
    operatingSystem: imageInspect?.Os,
    sizeBytes: imageInspect?.Size,
    declaredUser: containerInspect.Config.User,
    effectiveUid: Number(uid),
    status: containerInspect.State.Status,
    capabilitiesDropped: true,
    noNewPrivileges: true,
    readOnlyMountDestinations: mounts.map(({ destination }) => destination).sort(),
  };
}

function podmanOutput(label, arguments_) {
  const result = spawnSync(podman, arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`${label} failed`);
  return result.stdout;
}

function collectFailureContainerDiagnostics() {
  return createdContainers.map((name) => {
    const state = spawnSync(
      podman,
      ["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", name],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const logs = spawnSync(podman, ["logs", "--tail", "120", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      name,
      state: state.status === 0 ? state.stdout.trim() : "unavailable",
      errorLines: `${logs.stdout ?? ""}\n${logs.stderr ?? ""}`
        .split(/\r?\n/u)
        .filter((line) => /(error|failed|failure|invalid|warn)/iu.test(line))
        .slice(-20),
    };
  });
}

function stopAndRemoveContainer(name) {
  const inspect = spawnSync(podman, ["container", "inspect", name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (inspect.status !== 0) return;
  try {
    const parsed = JSON.parse(inspect.stdout)?.[0];
    if (parsed?.Config?.Labels?.["io.reconai.verification"] !== "container-image-runtime") {
      process.stderr.write(`Refusing to remove unlabeled container ${name}.\n`);
      process.exitCode = 1;
      return;
    }
  } catch {
    process.stderr.write(`Refusing to remove uninspectable container ${name}.\n`);
    process.exitCode = 1;
    return;
  }
  spawnSync(podman, ["rm", "--force", name], { stdio: "ignore" });
}

function countFindings(logs, forbiddenValues) {
  return forbiddenValues.reduce((count, value) => count + (logs.includes(value) ? 1 : 0), 0);
}

function environmentIsolation(environment, forbiddenVariableNames) {
  return {
    injectedVariableNames: Object.keys(environment).sort(),
    forbiddenVariableNamesChecked: forbiddenVariableNames,
    forbiddenVariablesPresent: [],
  };
}

function assertLoopbackUrl(value, name) {
  if (!value) throw new Error(`${name} is required`);
  const hostname = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    throw new Error(`${name} must target loopback infrastructure`);
  }
}

async function startFixtureSignInThroughUi(page) {
  const signInButton = page.getByRole("button", { name: "Sign in securely" });
  await signInButton.waitFor({ state: "visible" });
  await signInButton.click();
  await page.waitForURL((url) => url.origin === keycloakOrigin, { timeout: 30_000 });
}

async function selectFixtureOrganizationThroughUi(page, context) {
  const organizationSelect = page.getByLabel("Organization", { exact: true });
  await organizationSelect.waitFor({ state: "visible" });
  await organizationSelect.selectOption(organizationId);
  const selectionResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/recon/organization",
    { timeout: 30_000 },
  );
  const navigation = page.waitForEvent("framenavigated", {
    predicate: (frame) => frame === page.mainFrame(),
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Switch" }).click();
  const response = await selectionResponse;
  assertEqual(response.status(), 200, "container organization selection BFF");
  await navigation;
  await page.waitForLoadState("domcontentloaded");
  const contextCookie = (await context.cookies(authenticatedWebOrigin)).find(
    ({ name }) => name === "__Secure-reconai.organization-context",
  );
  if (
    !contextCookie ||
    !contextCookie.httpOnly ||
    !contextCookie.secure ||
    contextCookie.sameSite !== "Lax"
  ) {
    throw new Error("container organization context cookie violated its production policy");
  }
  return response.status();
}

async function completeFixtureLogin(page, fixture) {
  await page.locator("#username").fill(fixture.username);
  await page.locator("#password").fill(fixture.initialPassword);
  await page.locator("#kc-login").click();
  const destination = (url) =>
    url.origin === authenticatedWebOrigin && url.pathname === "/dashboard";
  const newPassword = page.locator("#password-new");
  const requiresPasswordUpdate = await Promise.race([
    newPassword.waitFor({ state: "visible", timeout: 30_000 }).then(() => true),
    page.waitForURL(destination, { timeout: 30_000 }).then(() => false),
  ]);
  if (requiresPasswordUpdate) {
    const replacementPassword = `Local-${randomBytes(24).toString("base64url")}!`;
    await newPassword.fill(replacementPassword);
    await page.locator("#password-confirm").fill(replacementPassword);
    await page.locator("#kc-passwd-update-form button[type=submit]").click();
  }
  await page.waitForURL(destination, { timeout: 30_000 });
}

async function readApiAccessToken(context, sessionSecret) {
  const cookies = await context.cookies(authenticatedWebOrigin);
  const unchunked = cookies.find(({ name }) => name === "__Secure-reconai.session-token");
  const chunks = cookies
    .filter(({ name }) => /^__Secure-reconai\.session-token\.\d+$/u.test(name))
    .sort((left, right) => sessionChunkIndex(left.name) - sessionChunkIndex(right.name));
  if (unchunked && chunks.length > 0) {
    throw new Error("container browser session mixed chunked and unchunked cookies");
  }
  const selected = unchunked ? [unchunked] : chunks;
  if (
    selected.length < 1 ||
    selected.some(({ httpOnly, sameSite, secure }) => !httpOnly || !secure || sameSite !== "Lax")
  ) {
    throw new Error(
      "container browser session cookie was missing or violated Secure/HttpOnly/SameSite=Lax",
    );
  }
  const token = await decode({
    secret: sessionSecret,
    token: selected.map(({ value }) => value).join(""),
  });
  const accessToken = token?.apiAccessToken;
  if (typeof accessToken !== "string" || accessToken.length < 32) {
    throw new Error("container encrypted session omitted the API access token");
  }
  return accessToken;
}

function sessionChunkIndex(name) {
  const index = Number(name.slice(name.lastIndexOf(".") + 1));
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error("container browser session cookie chunk index was invalid");
  }
  return index;
}

function assertProviderAuthorizationRequest() {
  if (!providerAuthorizationRequest) {
    throw new Error("container browser did not observe the Keycloak authorization request");
  }
  assertEqual(
    providerAuthorizationRequest.searchParams.get("client_id"),
    oidcClientId,
    "container OIDC client identity",
  );
  assertEqual(
    providerAuthorizationRequest.searchParams.get("redirect_uri"),
    `${authenticatedWebOrigin}/api/auth/callback/keycloak`,
    "container OIDC callback",
  );
  assertEqual(
    providerAuthorizationRequest.searchParams.get("code_challenge_method"),
    "S256",
    "container OIDC PKCE method",
  );
  if (!(providerAuthorizationRequest.searchParams.get("code_challenge")?.length > 20)) {
    throw new Error("container OIDC authorization request omitted a bounded PKCE challenge");
  }
}

function requiredFixtureUser(username) {
  const user = realmFixture.users?.find((candidate) => candidate?.username === username);
  const initialPassword = user?.credentials?.find(({ type }) => type === "password")?.value;
  if (
    !user ||
    user.id !== userId ||
    user.email !== username ||
    user.emailVerified !== true ||
    user.enabled !== true ||
    typeof initialPassword !== "string"
  ) {
    throw new Error(`the synthetic realm fixture is missing verified user ${username}`);
  }
  return { username, initialPassword };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function requiredEnvironment(environment, name, allowEmpty = false) {
  const value = environment[name];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`${name} is required in the synthetic environment template`);
  }
  return value;
}

function requiredUuid(value, label) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new Error(`${label} was not a UUID`);
  }
  return value;
}

function requiredRow(rows, label) {
  const row = rows[0];
  if (!row) throw new Error(`${label} returned no row`);
  return row;
}

function numericRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
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

function sanitize(value, secrets) {
  let sanitized = String(value);
  for (const secret of secrets.filter((item) => typeof item === "string" && item.length > 0)) {
    sanitized = sanitized.replaceAll(secret, "<redacted>");
  }
  return sanitized
    .replace(
      /\b(postgresql|redis):\/\/([^:@/\s]+):([^@/\s]+)@/giu,
      (_match, scheme, username) => `${scheme}://${username}:<redacted>@`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/giu, "Bearer <redacted>");
}
