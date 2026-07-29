import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as nodeSetTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const requireFromObjectStorage = createRequire(
  new URL("../packages/object-storage/package.json", import.meta.url),
);
const requireFromWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));
const requireFromWorker = createRequire(new URL("../apps/worker/package.json", import.meta.url));

const { exportJWK, generateKeyPair, SignJWT } = await import(requireFromApi.resolve("jose"));
const postgres = (await import(requireFromApi.resolve("postgres"))).default;
const { encode } = requireFromWeb("next-auth/jwt");
const playwright = await import(requireFromWeb.resolve("@playwright/test"));
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (!chromium) throw new Error("Playwright Chromium runtime is unavailable");
const { CreateBucketCommand, HeadBucketCommand, S3Client } =
  requireFromObjectStorage("@aws-sdk/client-s3");
const { Queue } = requireFromWorker("bullmq");
const ioredis = requireFromWorker("ioredis");
const Redis = ioredis.Redis ?? ioredis.default;

const organizationId = "00000000-0000-4000-8000-000000000001";
const otherOrganizationId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000010";
const expectedMigrationCount = 44;
const expectedMatchRules = ["order-payment", "refund", "refund-accounting-split"];
const expectedSplitReason = "REFUND_ACCOUNTING_SPLIT_TOTAL_MATCHED";
const expectedExceptionType = "duplicate_processing_fee";
const expectedExceptionReason = "DUPLICATE_SOURCE_EXTERNAL_IDENTIFIER";
const requestReason = "Verify the isolated browser-to-worker immutable operator evidence journey";

const webPort = boundedPort("LIVE_RECONCILIATION_WEB_PORT", 3000);
const apiPort = boundedPort("LIVE_RECONCILIATION_API_PORT", 4000);
const oidcPort = boundedPort("LIVE_RECONCILIATION_OIDC_PORT", 8180);
if (new Set([webPort, apiPort, oidcPort]).size !== 3) {
  throw new Error("live reconciliation web, API, and OIDC ports must be distinct");
}

const webOrigin = `http://127.0.0.1:${webPort.toString()}`;
const apiOrigin = `http://127.0.0.1:${apiPort.toString()}`;
const oidcOrigin = `http://127.0.0.1:${oidcPort.toString()}`;
const oidcIssuer = `${oidcOrigin}/realms/reconai-live-verification`;
const sessionSecret = requiredEnvironment("SESSION_SECRET");
if (sessionSecret.length < 32)
  throw new Error("SESSION_SECRET must contain at least 32 characters");

const environment = {
  ...process.env,
  NODE_ENV: "development",
  APP_ENV: "live-verification",
  WEB_ORIGIN: webOrigin,
  NEXTAUTH_URL: webOrigin,
  API_ORIGIN: apiOrigin,
  WEB_PORT: webPort.toString(),
  API_HOST: "127.0.0.1",
  API_PORT: apiPort.toString(),
  OIDC_ISSUER: oidcIssuer,
  OIDC_CLIENT_ID: process.env["OIDC_CLIENT_ID"] ?? "reconai-web-development",
  OIDC_CLIENT_SECRET: process.env["OIDC_CLIENT_SECRET"] ?? "local-oidc-secret-only",
  OIDC_ID_TOKEN_SIGNING_ALGORITHM: "RS256",
  SESSION_SECRET: sessionSecret,
  SESSION_COOKIE_SECURE: "false",
  SESSION_REVOCATION_STORE: "local",
  API_RATE_LIMIT_STORE: "local",
  API_RATE_LIMIT_KEY_SECRET: "",
  RECONAI_DEFAULT_ORGANIZATION_ID: organizationId,
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
let browserContext;
let database;
let inspectionRedis;
let queueRedis;
let durableQueue;
let objectStorage;
let jwksServer;
let jwksRequests = 0;
let bucketCreated = false;

try {
  const signingKeys = await generateKeyPair("RS256", {
    modulusLength: 2048,
    extractable: true,
  });
  const publicJwk = await exportJWK(signingKeys.publicKey);
  const keyId = randomUUID();
  const jwksBody = JSON.stringify({
    keys: [{ ...publicJwk, alg: "RS256", kid: keyId, use: "sig" }],
  });
  jwksServer = createServer((request, response) => {
    if (
      request.method === "GET" &&
      request.url === "/realms/reconai-live-verification/protocol/openid-connect/certs"
    ) {
      jwksRequests += 1;
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(jwksBody).toString(),
      });
      response.end(jwksBody);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"code":"NOT_FOUND"}');
  });
  await listen(jwksServer, oidcPort);

  inspectionRedis = new Redis(environment.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  await inspectionRedis.ping();
  const initialRedisKeyCount = await inspectionRedis.dbsize();
  assertEqual(initialRedisKeyCount, 0, "the live verification Redis database must begin empty");

  await runCommand(
    "database migration",
    "pnpm",
    ["--filter", "@workspace/database", "db:migrate"],
    environment,
  );

  database = postgres(environment.DATABASE_ADMIN_URL, { max: 2 });
  const initialDatabaseRows = await database`
    select
      (select count(*)::integer from organizations) as organizations,
      (select count(*)::integer from canonical_records) as canonical_records,
      (select count(*)::integer from reconciliation_runs) as reconciliation_runs,
      (select count(*)::integer from outbox_events) as outbox_events
  `;
  const initialDatabase = requiredRow(initialDatabaseRows, "initial database counts");
  for (const [field, value] of Object.entries(initialDatabase)) {
    assertEqual(
      Number(value),
      0,
      `the live verification database ${field} count must begin at zero`,
    );
  }

  objectStorage = new S3Client({
    endpoint: environment.S3_ENDPOINT,
    region: environment.S3_REGION,
    credentials: {
      accessKeyId: environment.S3_ACCESS_KEY_ID,
      secretAccessKey: environment.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: environment.S3_FORCE_PATH_STYLE === "true",
  });
  try {
    await objectStorage.send(new HeadBucketCommand({ Bucket: environment.S3_BUCKET }));
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status !== 404) throw error;
    await objectStorage.send(new CreateBucketCommand({ Bucket: environment.S3_BUCKET }));
    bucketCreated = true;
  }

  await runCommand(
    "synthetic fixture loading",
    "pnpm",
    ["--filter", "@workspace/test-support", "fixtures:load"],
    environment,
  );

  const fixtureRows = await database`
    select
      (select count(*)::integer from canonical_records
        where organization_id = ${organizationId}::uuid) as canonical_records,
      (select count(*)::integer from source_events
        where organization_id = ${organizationId}::uuid) as source_events,
      (select count(*)::integer from canonical_field_provenance
        where organization_id = ${organizationId}::uuid) as field_provenance,
      (select count(*)::integer from imports
        where organization_id = ${organizationId}::uuid and status = 'succeeded') as imports,
      (select count(*)::integer from canonical_records
        where organization_id = ${organizationId}::uuid
          and kind = 'processing_fee'
          and normalized_data ->> 'externalId' = 'txn_300') as duplicate_fee_records,
      (select count(*)::integer from canonical_records
        where organization_id = ${organizationId}::uuid
          and kind = 'accounting_entry'
          and normalized_data ->> 'entryType' = 'refund') as accounting_refund_records,
      (select count(*)::integer from organizations
        where id = ${otherOrganizationId}::uuid) as foreign_organizations,
      (select count(*)::integer from memberships
        where organization_id = ${otherOrganizationId}::uuid
          and status = 'active') as foreign_active_memberships
  `;
  const fixture = numericRow(requiredRow(fixtureRows, "fixture counts"));
  assertEqual(fixture.canonical_records, 8, "fixture canonical record count");
  assertEqual(fixture.source_events, 8, "fixture source-event count");
  assertEqual(fixture.imports, 1, "fixture succeeded-import count");
  assertEqual(fixture.duplicate_fee_records, 2, "fixture duplicate-fee record count");
  assertEqual(fixture.accounting_refund_records, 2, "fixture accounting-refund record count");
  assertEqual(fixture.foreign_organizations, 1, "fixture foreign-organization count");
  assertEqual(fixture.foreign_active_memberships, 1, "fixture foreign active-membership count");

  children.push(
    startChild("api", "pnpm", ["exec", "tsx", "--conditions=development", "apps/api/src/main.ts"]),
  );
  children.push(
    startChild("worker", "pnpm", [
      "exec",
      "tsx",
      "--conditions=development",
      "apps/worker/src/main.ts",
    ]),
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
      webPort.toString(),
    ]),
  );

  await Promise.all([
    waitForHttp(`${apiOrigin}/health/live`, children, 30_000),
    waitForHttp(webOrigin, children, 60_000),
  ]);
  await delay(750);

  const now = Math.floor(Date.now() / 1000);
  const accessToken = await new SignJWT({
    email: "owner@example.test",
    email_verified: true,
  })
    .setProtectedHeader({ alg: "RS256", kid: keyId, typ: "JWT" })
    .setIssuer(oidcIssuer)
    .setAudience(environment.OIDC_CLIENT_ID)
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + 3_600)
    .setJti(randomUUID())
    .sign(signingKeys.privateKey);
  const sessionToken = await encode({
    secret: sessionSecret,
    maxAge: 3_600,
    token: {
      sub: userId,
      name: "Synthetic Operator",
      email: "owner@example.test",
      apiOidcIssuer: oidcIssuer,
      apiOidcSubject: userId,
      apiSessionStartedAt: now,
      apiAccessToken: accessToken,
      apiAccessTokenExpiresAt: now + 3_600,
    },
  });

  const crossTenantResponse = await fetch(
    `${apiOrigin}/v1/organizations/${otherOrganizationId}/reconciliation-runs?limit=1`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "x-request-id": randomUUID(),
      },
    },
  );
  assertEqual(
    crossTenantResponse.status,
    404,
    "cross-tenant run discovery must resolve as not found",
  );

  browser = await chromium.launch({ headless: true });
  browserContext = await browser.newContext();
  await browserContext.addCookies([
    {
      name: "reconai.session-token",
      value: sessionToken,
      url: webOrigin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await browserContext.newPage();
  await page.goto(`${webOrigin}/dashboard/runs`);
  await page.getByRole("heading", { name: "Reconciliation runs" }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
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
  assertEqual(actionResponse.status(), 202, "browser BFF run-start response status");
  const actionBody = await actionResponse.json();
  const runId = requiredUuid(actionBody?.data?.id, "run-start response id");
  const correlationId = requiredUuid(
    actionBody?.meta?.correlationId,
    "run-start response correlation id",
  );

  await page
    .getByText("Bounded per-run evidence: 3 matches and 1 exception.", { exact: true })
    .waitFor({ state: "visible", timeout: 45_000 });
  await page.getByText(expectedSplitReason, { exact: true }).waitFor({ state: "visible" });
  await page
    .getByRole("region", { name: "Matches observed in this run" })
    .getByRole("cell", { name: "3", exact: true })
    .waitFor({ state: "visible" });
  await page.getByText(expectedExceptionReason, { exact: true }).waitFor({ state: "visible" });
  assertEqual(
    await page.getByText("Exact at observation", { exact: true }).count(),
    4,
    "browser exact-at-observation marker count",
  );
  assertEqual(
    await page.getByText("Legacy evidence projection present", { exact: true }).count(),
    0,
    "browser legacy evidence warning count",
  );
  const exceptionLink = page.getByRole("link", { name: "Duplicate processing fee" });
  await exceptionLink.waitFor({ state: "visible" });
  const exceptionHref = await exceptionLink.getAttribute("href");
  if (!exceptionHref?.startsWith("/dashboard/exceptions/")) {
    throw new Error("duplicate processing fee did not expose a bounded exception detail link");
  }
  const exceptionId = requiredUuid(
    exceptionHref.slice("/dashboard/exceptions/".length),
    "browser exception link id",
  );

  const detailResponse = await browserContext.request.get(
    `${webOrigin}/api/recon?view=run&id=${encodeURIComponent(runId)}`,
  );
  assertEqual(detailResponse.status(), 200, "browser-session BFF run-detail response status");
  const detailBody = await detailResponse.json();
  const detail = detailBody?.data;
  if (!detail || typeof detail !== "object") {
    throw new Error("browser-session BFF returned no run detail");
  }
  assertEqual(detail.status, "succeeded", "run detail status");
  assertEqual(detail.inputCount, 8, "run detail input count");
  assertEqual(detail.matchCount, 3, "run detail match count");
  assertEqual(detail.exceptionCount, 1, "run detail exception count");
  assertEqual(detail.operationalStateApplied, true, "run detail operational authority");
  assertEqual(detail.matches?.length, 3, "run detail bounded match artifact count");
  assertEqual(detail.exceptions?.length, 1, "run detail bounded exception artifact count");
  assertEqual(detail.matchesTruncated, false, "run match preview truncation");
  assertEqual(detail.exceptionsTruncated, false, "run exception preview truncation");
  if (
    ![...detail.matches, ...detail.exceptions].every(
      (artifact) => artifact.evidenceFidelity === "exact_at_observation",
    )
  ) {
    throw new Error("run detail included evidence that was not exact at observation");
  }
  const apiMatchRules = detail.matches.map((match) => match.ruleId).sort();
  assertJsonEqual(apiMatchRules, expectedMatchRules, "run detail match rules");
  const splitMatch = detail.matches.find((match) => match.ruleId === "refund-accounting-split");
  if (!splitMatch) throw new Error("run detail omitted the conserved refund-accounting split");
  assertEqual(splitMatch.ruleVersion, "1.5.0", "run detail split rule version");
  assertEqual(splitMatch.evidence?.reasonCode, expectedSplitReason, "run detail split reason code");
  assertEqual(
    Array.isArray(splitMatch.recordReferences) ? splitMatch.recordReferences.length : -1,
    3,
    "run detail split record-reference count",
  );
  assertEqual(detail.exceptions[0]?.id, exceptionId, "browser and API exception identity");
  assertEqual(detail.exceptions[0]?.type, expectedExceptionType, "run detail exception type");
  assertEqual(
    detail.exceptions[0]?.evidence?.reasonCode,
    expectedExceptionReason,
    "run detail exception reason",
  );

  const runRows = await database`
    select
      id::text,
      stable_run_key,
      input_snapshot_hash,
      policy_snapshot_hash,
      policy_version,
      rule_set_version,
      engine_version,
      status::text,
      input_count,
      match_count,
      exception_count,
      error_count,
      dispatch_count,
      operational_state_applied,
      started_at,
      completed_at
    from reconciliation_runs
    where organization_id = ${organizationId}::uuid
      and id = ${runId}::uuid
    limit 1
  `;
  const run = requiredRow(runRows, "persisted reconciliation run");
  assertEqual(run.status, "succeeded", "persisted run status");
  assertEqual(Number(run.input_count), 8, "persisted run input count");
  assertEqual(Number(run.match_count), 3, "persisted run match count");
  assertEqual(Number(run.exception_count), 1, "persisted run exception count");
  assertEqual(Number(run.error_count), 0, "persisted run error count");
  assertEqual(Number(run.dispatch_count), 1, "persisted run dispatch count");
  assertEqual(run.operational_state_applied, true, "persisted run operational authority");

  const occurrenceRows = await database`
    select
      (select count(*)::integer from match_occurrences
        where organization_id = ${organizationId}::uuid and run_id = ${runId}::uuid)
        as match_occurrences,
      (select count(*)::integer from match_occurrence_snapshots
        where organization_id = ${organizationId}::uuid and run_id = ${runId}::uuid)
        as match_snapshots,
      (select count(*)::integer from exception_occurrences
        where organization_id = ${organizationId}::uuid and run_id = ${runId}::uuid)
        as exception_occurrences,
      (select count(*)::integer from exception_occurrence_snapshots
        where organization_id = ${organizationId}::uuid and run_id = ${runId}::uuid)
        as exception_snapshots
  `;
  const occurrences = numericRow(requiredRow(occurrenceRows, "occurrence counts"));
  assertEqual(occurrences.match_occurrences, 3, "match occurrence count");
  assertEqual(occurrences.match_snapshots, 3, "match occurrence snapshot count");
  assertEqual(occurrences.exception_occurrences, 1, "exception occurrence count");
  assertEqual(occurrences.exception_snapshots, 1, "exception occurrence snapshot count");

  const matchSnapshotRows = await database`
    select
      snapshot_version,
      rule_id,
      rule_version,
      evidence ->> 'reasonCode' as reason_code,
      jsonb_array_length(record_references) as record_count
    from match_occurrence_snapshots
    where organization_id = ${organizationId}::uuid
      and run_id = ${runId}::uuid
    order by rule_id
  `;
  assertJsonEqual(
    matchSnapshotRows.map((row) => row.rule_id),
    expectedMatchRules,
    "persisted match snapshot rules",
  );
  if (
    !matchSnapshotRows.every(
      (row) => row.snapshot_version === "artifact-occurrence-v1" && row.rule_version === "1.5.0",
    )
  ) {
    throw new Error("persisted match snapshots did not use the expected immutable schema/version");
  }
  const persistedSplitMatch = matchSnapshotRows.find(
    (row) => row.rule_id === "refund-accounting-split",
  );
  if (!persistedSplitMatch) {
    throw new Error("persisted snapshots omitted the conserved refund-accounting split");
  }
  assertEqual(persistedSplitMatch.reason_code, expectedSplitReason, "persisted split reason code");
  assertEqual(Number(persistedSplitMatch.record_count), 3, "persisted split record count");

  const exceptionSnapshotRows = await database`
    select
      snapshot_version,
      exception_id::text,
      type,
      observed_status::text,
      severity,
      evidence ->> 'reasonCode' as reason_code
    from exception_occurrence_snapshots
    where organization_id = ${organizationId}::uuid
      and run_id = ${runId}::uuid
    limit 1
  `;
  const exceptionSnapshot = requiredRow(
    exceptionSnapshotRows,
    "persisted exception occurrence snapshot",
  );
  assertEqual(
    exceptionSnapshot.snapshot_version,
    "artifact-occurrence-v1",
    "exception snapshot schema version",
  );
  assertEqual(exceptionSnapshot.exception_id, exceptionId, "exception snapshot identity");
  assertEqual(exceptionSnapshot.type, expectedExceptionType, "exception snapshot type");
  assertEqual(exceptionSnapshot.reason_code, expectedExceptionReason, "exception snapshot reason");

  const outboxRows = await database`
    select
      id::text,
      event_type,
      schema_version,
      idempotency_key,
      correlation_id::text,
      published_at,
      attempts,
      execution_tracking_version,
      payload
    from outbox_events
    where organization_id = ${organizationId}::uuid
      and event_type = 'reconciliation.run.requested'
      and payload ->> 'runId' = ${runId}
    limit 1
  `;
  const outbox = requiredRow(outboxRows, "reconciliation outbox event");
  assertEqual(outbox.event_type, "reconciliation.run.requested", "outbox event type");
  assertEqual(Number(outbox.schema_version), 1, "outbox schema version");
  assertEqual(Number(outbox.execution_tracking_version), 1, "outbox execution tracking version");
  assertEqual(outbox.correlation_id, correlationId, "outbox correlation identity");
  if (!(outbox.published_at instanceof Date)) {
    throw new Error("reconciliation outbox event was not published");
  }

  const executionRows = await database`
    select
      job_id,
      queue_name,
      status,
      attempts,
      maximum_attempts,
      completed_at,
      last_error_code
    from job_executions
    where organization_id = ${organizationId}::uuid
      and outbox_event_id = ${outbox.id}::uuid
    limit 1
  `;
  const execution = requiredRow(executionRows, "durable job execution");
  assertEqual(execution.status, "succeeded", "durable job execution status");
  assertEqual(Number(execution.attempts), 1, "durable job execution attempts");
  assertEqual(Number(execution.maximum_attempts), 6, "durable job maximum attempts");
  assertEqual(execution.last_error_code, null, "durable job terminal error");
  if (!(execution.completed_at instanceof Date)) {
    throw new Error("durable job execution did not record completion");
  }

  queueRedis = new Redis(environment.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  durableQueue = new Queue(execution.queue_name, { connection: queueRedis });
  const redisJob = await durableQueue.getJob(execution.job_id);
  if (!redisJob) throw new Error("BullMQ no longer exposed the completed durable job");
  const redisJobState = await redisJob.getState();
  assertEqual(redisJobState, "completed", "BullMQ durable job state");

  const auditRows = await database`
    select action, actor_type, reason, event_hash
    from audit_events
    where organization_id = ${organizationId}::uuid
      and resource_type = 'reconciliation_run'
      and resource_id = ${runId}
    order by occurred_at, id
  `;
  assertJsonEqual(
    auditRows.map((row) => row.action),
    ["reconciliation.run.requested", "reconciliation.run.completed"],
    "run audit event actions",
  );
  assertEqual(auditRows[0]?.reason, requestReason, "operator audit reason");
  if (!auditRows.every((row) => /^[a-f0-9]{64}$/u.test(String(row.event_hash)))) {
    throw new Error("run audit events did not contain hash-chain identities");
  }

  const migrationRows = await database`
    select count(*)::integer as count from reconai_schema_migrations
  `;
  const migrationCount = Number(requiredRow(migrationRows, "migration count").count);
  assertEqual(migrationCount, expectedMigrationCount, "applied migration count");
  const postgresqlVersionRows = await database`
    select current_setting('server_version') as version
  `;
  const postgresqlVersion = String(
    requiredRow(postgresqlVersionRows, "PostgreSQL version").version,
  );
  const redisServerInformation = await inspectionRedis.info("server");
  const redisVersion =
    /^redis_version:([^\r\n]+)$/mu.exec(redisServerInformation)?.[1] ?? "unknown";

  const evidence = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    component: "continuous-reconciliation-operator-evidence-journey",
    outcome: "local_isolated_continuous_journey_passed",
    productionReadinessClaim: false,
    scope: {
      boundaries: [
        "Chromium operator interface",
        "encrypted HttpOnly NextAuth session",
        "same-origin state-changing BFF",
        "RS256 API bearer verification through loopback JWKS",
        "tenant membership and permission resolution",
        "transactional PostgreSQL run/input/outbox persistence",
        "outbox relay and Redis/BullMQ delivery",
        "restricted worker execution",
        "immutable match and exception occurrence snapshots",
        "bounded browser-visible exact evidence",
      ],
      customerDataUsed: false,
      providerSystemsContacted: false,
    },
    runtime: {
      topology: "isolated host processes over loopback",
      webOrigin,
      apiOrigin,
      oidcAuthority: "minimal in-process JWKS authority",
      oidcAlgorithm: "RS256",
      postgresqlVersion,
      redisVersion,
      objectStorageEndpointLoopback: true,
      objectStorageBucketCreatedByVerifier: bucketCreated,
    },
    fixture: {
      canonicalRecords: fixture.canonical_records,
      sourceEvents: fixture.source_events,
      fieldProvenanceEntries: fixture.field_provenance,
      completedImports: fixture.imports,
      duplicateFeeRecords: fixture.duplicate_fee_records,
      accountingRefundRecords: fixture.accounting_refund_records,
      foreignOrganizations: fixture.foreign_organizations,
      foreignActiveMemberships: fixture.foreign_active_memberships,
    },
    browserJourney: {
      startStatus: actionResponse.status(),
      runId,
      correlationId,
      terminalStatus: detail.status,
      queueAuthority: detail.operationalStateApplied ? "live_queue" : "historical_only",
      inputCount: detail.inputCount,
      matchCount: detail.matchCount,
      exceptionCount: detail.exceptionCount,
      exactEvidenceMarkers: 4,
      legacyEvidenceWarnings: 0,
      matchedRules: apiMatchRules,
      splitRuleVersion: splitMatch.ruleVersion,
      splitReasonCode: splitMatch.evidence.reasonCode,
      splitRecordReferenceCount: splitMatch.recordReferences.length,
      exceptionType: detail.exceptions[0].type,
      exceptionReasonCode: detail.exceptions[0].evidence.reasonCode,
      exceptionDetailLinkPresent: true,
      rawSessionOrProviderCredentialRecorded: false,
    },
    authorization: {
      jwksRequests,
      verifiedSubjectBoundToFixtureMembership: true,
      foreignOrganizationExisted: fixture.foreign_organizations === 1,
      crossTenantRunDiscoveryStatus: crossTenantResponse.status,
      crossTenantExistenceDisclosed: false,
    },
    persistence: {
      appliedMigrations: migrationCount,
      run: {
        status: run.status,
        policyVersion: run.policy_version,
        ruleSetVersion: run.rule_set_version,
        engineVersion: run.engine_version,
        dispatchCount: Number(run.dispatch_count),
        errorCount: Number(run.error_count),
        stableRunKeySha256Present: /^[a-f0-9]{64}$/u.test(String(run.stable_run_key)),
        inputSnapshotSha256Present: /^[a-f0-9]{64}$/u.test(String(run.input_snapshot_hash)),
        policySnapshotSha256Present: /^[a-f0-9]{64}$/u.test(String(run.policy_snapshot_hash)),
      },
      occurrenceCounts: occurrences,
      occurrenceSnapshotVersion: "artifact-occurrence-v1",
      matchSnapshotRules: matchSnapshotRows.map((row) => ({
        ruleId: row.rule_id,
        ruleVersion: row.rule_version,
        reasonCode: row.reason_code,
        recordCount: Number(row.record_count),
      })),
      exceptionSnapshot: {
        type: exceptionSnapshot.type,
        observedStatus: exceptionSnapshot.observed_status,
        severity: exceptionSnapshot.severity,
        reasonCode: exceptionSnapshot.reason_code,
      },
      auditActions: auditRows.map((row) => row.action),
      auditReasonMatched: auditRows[0]?.reason === requestReason,
      auditHashesPresent: true,
    },
    durableDelivery: {
      outboxEventType: outbox.event_type,
      outboxSchemaVersion: Number(outbox.schema_version),
      executionTrackingVersion: Number(outbox.execution_tracking_version),
      outboxPublished: true,
      queueName: execution.queue_name,
      bullmqState: redisJobState,
      executionStatus: execution.status,
      executionAttempts: Number(execution.attempts),
      maximumAttempts: Number(execution.maximum_attempts),
      terminalErrorCode: execution.last_error_code,
    },
    limitations: [
      "The OIDC authority is a minimal local RS256/JWKS verifier fixture, not Keycloak, staging, or a production identity provider.",
      "The journey uses loopback HTTP and isolated host processes; it does not exercise TLS, ingress, containers, multi-host scheduling, or managed infrastructure.",
      "The evidence covers one bounded eight-record synthetic run and is not a capacity, latency, reliability, or production-readiness claim.",
      "No provider sandbox, customer payload, production credential, staging deployment, external alert, or hosted CI run is included.",
    ],
    credentialsRecorded: false,
  };

  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  const childDiagnostics = children
    .map((child) => `${child.label}:\n${sanitizedTail(child.output)}`)
    .join("\n");
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(
    `${sanitize(message)}${childDiagnostics ? `\n${childDiagnostics}\n` : "\n"}`,
  );
  process.exitCode = 1;
} finally {
  await browserContext?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await durableQueue?.close().catch(() => undefined);
  if (queueRedis?.status === "ready") await queueRedis.quit().catch(() => undefined);
  else queueRedis?.disconnect();
  if (inspectionRedis?.status === "ready") {
    await inspectionRedis.quit().catch(() => undefined);
  } else {
    inspectionRedis?.disconnect();
  }
  objectStorage?.destroy();
  await database?.end({ timeout: 5 }).catch(() => undefined);
  await Promise.all(children.reverse().map((child) => stopChild(child)));
  if (jwksServer) await closeServer(jwksServer);
}

function requiredEnvironment(name) {
  const value = environmentValue(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function environmentValue(name) {
  return process.env[name];
}

function assertNonProductionLoopbackEnvironment(candidate) {
  if (process.env["NODE_ENV"] === "production" || process.env["APP_ENV"] === "production") {
    throw new Error("live reconciliation verification is disabled in production");
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

function boundedPort(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]{0,4}$/u.test(raw)) throw new Error(`${name} must be a valid TCP port`);
  const value = Number(raw);
  if (value > 65_535) throw new Error(`${name} must be a valid TCP port`);
  return value;
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
  return output;
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

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
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

function requiredUuid(value, label) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new Error(`${label} was not a UUID`);
  }
  return value;
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
    );
}
