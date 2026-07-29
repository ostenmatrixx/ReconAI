import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, request as createHttpRequest } from "node:http";
import { createRequire } from "node:module";
import { connect as createConnection } from "node:net";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const ioredis = requireFromApi("ioredis");
const Redis = ioredis.Redis ?? ioredis.default;
const {
  API_RATE_LIMIT_MAXIMUM_REQUESTS: rateLimitMaximum,
  API_RATE_LIMIT_WINDOW_MS: rateLimitWindowMilliseconds,
} = await import(new URL("../apps/api/dist/rate-limit.js", import.meta.url));
assert(
  Number.isSafeInteger(rateLimitMaximum) && rateLimitMaximum > 0,
  "compiled API rate-limit maximum is invalid",
);
assert(
  Number.isSafeInteger(rateLimitWindowMilliseconds) && rateLimitWindowMilliseconds > 0,
  "compiled API rate-limit window is invalid",
);

const runtimeRoot = await requiredDirectory("API_RATE_LIMIT_RUNTIME_DIR");
const redisServerPath = await requiredExecutable("API_RATE_LIMIT_REDIS_SERVER");
const expectedRedisVersion = requiredEnvironment("API_RATE_LIMIT_REDIS_VERSION");
const expectedRedisServerSha256 = requiredSha256("API_RATE_LIMIT_REDIS_SERVER_SHA256");
const redisServerSha256 = await sha256File(redisServerPath);
assert(
  redisServerSha256 === expectedRedisServerSha256,
  "Redis server binary did not match the caller-supplied SHA-256",
);
const redisVersionOutput = await captureExecutable(redisServerPath, ["--version"]);
const observedRedisVersion = requiredCapture(
  redisVersionOutput,
  /\bv=([0-9]+(?:\.[0-9]+){2,3})\b/u,
  "Redis server version",
);
assert(
  observedRedisVersion === expectedRedisVersion,
  "Redis server version did not match the caller-supplied version",
);

const ports = {
  redis: boundedPort("API_RATE_LIMIT_REDIS_PORT", 56_380),
  proxy: boundedPort("API_RATE_LIMIT_PROXY_PORT", 4_310),
  replicaOne: boundedPort("API_RATE_LIMIT_REPLICA_ONE_PORT", 4_311),
  replicaTwo: boundedPort("API_RATE_LIMIT_REPLICA_TWO_PORT", 4_312),
  startupProbe: boundedPort("API_RATE_LIMIT_STARTUP_PROBE_PORT", 4_313),
};
assertDistinctPorts(ports);

const environmentName = "live-api-rate-limit";
const namespace = `reconai-${environmentName}-api-rate-limit-v1-`;
const primarySyntheticAddress = "198.51.100.77";
const secondarySyntheticAddress = "198.51.100.78";
const redisPassword = randomBytes(48).toString("base64url");
const firstKeySecret = randomBytes(48).toString("base64url");
const secondKeySecret = randomBytes(48).toString("base64url");
const sessionSecret = randomBytes(48).toString("base64url");
const connectorKey = randomBytes(32).toString("base64url");
const objectStorageAccessKeyId = randomBytes(24).toString("base64url");
const objectStorageSecretAccessKey = randomBytes(48).toString("base64url");
const oidcClientSecret = randomBytes(32).toString("base64url");
const databaseFixturePassword = randomBytes(32).toString("base64url");
const databaseScheme = "postgresql";
const apiDatabaseUrl =
  `${databaseScheme}://api_runtime:${databaseFixturePassword}` +
  "@database.reconai.invalid/reconai";
const workerDatabaseUrl =
  `${databaseScheme}://worker_runtime:${databaseFixturePassword}` +
  "@database.reconai.invalid/reconai";
const runtimeDirectory = await mkdtemp(join(runtimeRoot, "reconai-api-rate-limit-"));
const redisUrl = new URL(
  `redis://:${encodeURIComponent(redisPassword)}@lvh.me:${ports.redis.toString()}/13`,
);
const replicaDefinitions = [
  { label: "api-replica-1", port: ports.replicaOne },
  { label: "api-replica-2", port: ports.replicaTwo },
];
const children = [];
let redisProcess;
let inspectionRedis;
let proxy;
let evidence;
let failure;
let interruptedSignal;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interruptedSignal = signal;
  });
}

try {
  await assertPortClosed(ports.redis, "127.0.0.1");
  await assertPortClosed(ports.proxy, "127.0.0.1");
  await Promise.all(
    [ports.replicaOne, ports.replicaTwo, ports.startupProbe].map((port) =>
      assertPortClosed(port, "::1"),
    ),
  );

  const localStoreStartup = startApi(
    "production-local-rate-limit-rejection",
    ports.startupProbe,
    firstKeySecret,
    {
      API_RATE_LIMIT_STORE: "local",
      API_RATE_LIMIT_KEY_SECRET: "",
    },
  );
  children.push(localStoreStartup);
  const localStoreExit = await waitForChildExit(localStoreStartup, 8_000);
  assert(localStoreExit.exited, "production local-store rejection did not exit");
  assert(localStoreExit.exitCode !== 0, "production accepted a process-local rate limiter");
  await assertPortClosed(ports.startupProbe, "::1");

  const unavailableStoreStartup = startApi(
    "production-unavailable-rate-limit-store-rejection",
    ports.startupProbe,
    firstKeySecret,
  );
  children.push(unavailableStoreStartup);
  const unavailableStoreExit = await waitForChildExit(unavailableStoreStartup, 10_000);
  assert(unavailableStoreExit.exited, "missing Redis startup rejection did not exit");
  assert(unavailableStoreExit.exitCode !== 0, "production listened without its limiter authority");
  await assertPortClosed(ports.startupProbe, "::1");

  redisProcess = startRedis();
  await waitForRedis(redisUrl, 15_000);
  inspectionRedis = await connectRedis("inspection-initial");
  assert((await inspectionRedis.dbsize()) === 0, "fresh verifier Redis database was not empty");

  startReplicaSet(firstKeySecret, "initial");
  await waitForReplicaLiveness(20_000);
  proxy = createOverwritingProxy();
  await proxy.listen();

  const initialLiveness = await directLiveness();
  const initialLoadResponses = await Promise.all(
    Array.from({ length: rateLimitMaximum + 1 }, (_, index) =>
      proxyRequest({
        forwarded: `for=203.0.113.${((index % 100) + 1).toString()};proto=http`,
        "x-forwarded-for": `203.0.113.${((index % 100) + 1).toString()}`,
        "x-forwarded-host": "attacker.invalid",
        "x-forwarded-proto": "http",
      }),
    ),
  );
  const initialLoad = classifyAdmissionResponses(initialLoadResponses);
  assert(
    initialLoad.admitted === rateLimitMaximum,
    "initial shared budget admitted the wrong count",
  );
  assert(initialLoad.exceeded === 1, "initial shared budget did not reject exactly one request");
  assert(
    proxy.upstreamCounts.every((count) => count > 0),
    "proxy did not reach both API replicas",
  );
  assertSecurityHeaders(initialLoadResponses);

  const firstExpectedKey = rateLimitKey(firstKeySecret, primarySyntheticAddress);
  const initialKeys = await limiterKeys();
  assertSameMembers(initialKeys, [firstExpectedKey], "initial limiter keys");
  const initialTtls = await positiveTtls(initialKeys);
  assertKeysArePseudonymous(initialKeys);

  await inspectionRedis.save();
  inspectionRedis.disconnect();
  inspectionRedis = undefined;
  await stopChild(redisProcess, "SIGKILL", 5_000);
  const redisKilled = redisProcess.exitSignal === "SIGKILL";
  assert(redisKilled, "Redis did not stop through the required SIGKILL fault");
  redisProcess = undefined;

  const outageAdmission = await Promise.all(
    replicaDefinitions.map((replica) =>
      directRequest(replica.port, "/v1/organizations", primarySyntheticAddress),
    ),
  );
  for (const response of outageAdmission) {
    assertSafeErrorResponse(response, 500, "INTERNAL_ERROR", "request could not be completed");
  }
  const outageLiveness = await directLiveness();

  redisProcess = startRedis();
  await waitForRedis(redisUrl, 15_000);
  inspectionRedis = await connectRedis("inspection-recovered");
  const recoveryPrimary = await Promise.all(
    replicaDefinitions.map((replica) =>
      waitForAdmissionStatus(replica.port, primarySyntheticAddress, 429, 15_000),
    ),
  );
  const recoveredKeys = await limiterKeys();
  assertSameMembers(recoveredKeys, [firstExpectedKey], "recovered limiter keys");
  const recoveredTtls = await positiveTtls(recoveredKeys);

  const recoverySecondary = await Promise.all(
    replicaDefinitions.map((replica) =>
      directRequest(replica.port, "/v1/organizations", secondarySyntheticAddress),
    ),
  );
  for (const response of recoverySecondary) {
    assertSafeErrorResponse(response, 401, "AUTHENTICATION_REQUIRED", "authentication required");
  }
  const secondaryExpectedKey = rateLimitKey(firstKeySecret, secondarySyntheticAddress);
  const postRecoveryKeys = await limiterKeys();
  assertSameMembers(
    postRecoveryKeys,
    [firstExpectedKey, secondaryExpectedKey],
    "post-recovery limiter keys",
  );
  const postRecoveryTtls = await positiveTtls(postRecoveryKeys);
  assertKeysArePseudonymous(postRecoveryKeys);

  await stopReplicaSet();
  await Promise.all(replicaDefinitions.map((replica) => assertPortClosed(replica.port, "::1")));
  startReplicaSet(secondKeySecret, "rotated");
  await waitForReplicaLiveness(20_000);

  const rotatedInitial = await Promise.all(
    replicaDefinitions.map((replica) =>
      directRequest(replica.port, "/v1/organizations", primarySyntheticAddress),
    ),
  );
  for (const response of rotatedInitial) {
    assertSafeErrorResponse(response, 401, "AUTHENTICATION_REQUIRED", "authentication required");
  }
  const rotatedExpectedKey = rateLimitKey(secondKeySecret, primarySyntheticAddress);
  const proxyCountsBeforeRotationLoad = [...proxy.upstreamCounts];
  const rotatedLoadResponses = await Promise.all(
    Array.from({ length: rateLimitMaximum - 1 }, () => proxyRequest()),
  );
  const rotatedLoad = classifyAdmissionResponses(rotatedLoadResponses);
  assert(
    rotatedLoad.admitted === rateLimitMaximum - 2,
    "rotated shared budget admitted the wrong count",
  );
  assert(rotatedLoad.exceeded === 1, "rotated shared budget did not reject exactly one request");
  const rotationUpstreamDelta = proxy.upstreamCounts.map(
    (count, index) => count - requiredCount(proxyCountsBeforeRotationLoad[index]),
  );
  assert(
    rotationUpstreamDelta.every((count) => count > 0),
    "rotated load missed an API replica",
  );

  const rotatedKeys = await limiterKeys();
  assertSameMembers(
    rotatedKeys,
    [firstExpectedKey, secondaryExpectedKey, rotatedExpectedKey],
    "rotated limiter keys",
  );
  const rotatedTtls = await positiveTtls(rotatedKeys);
  assertKeysArePseudonymous(rotatedKeys);
  const processLivenessAfterRotation = await directLiveness();

  evidence = {
    artifactVersion: 1,
    recordedAt: new Date().toISOString(),
    scope:
      "Two compiled production API replicas sharing authenticated persistent Redis for distributed request admission, abrupt loss/recovery, and coordinated HMAC-key rotation",
    sourceState: "uncommitted working tree; no repository commit exists",
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      redis: {
        version: observedRedisVersion,
        serverSha256: redisServerSha256,
        authenticated: true,
        persistence: "appendonly yes; appendfsync always; explicit SAVE before SIGKILL",
      },
      api: {
        replicas: replicaDefinitions.length,
        entrypoint: "node apps/api/dist/main.js",
        nodeEnvironment: "production",
        nodeOptions: "--throw-deprecation",
        processLocalLimiterRejectedBeforeListen: true,
        unavailableRedisRejectedBeforeListen: true,
      },
      proxy: {
        implementation: "bounded verifier-owned HTTP reverse proxy",
        overwritesForwardingHeaders: true,
        removesForwarded: true,
        trustedApiPeer: "IPv6 loopback CIDR",
      },
    },
    contract: {
      maximumRequests: rateLimitMaximum,
      windowMilliseconds: rateLimitWindowMilliseconds,
      sharedEnvironmentNamespace: true,
      clientAddressIndex: "HMAC-SHA-256 rendered as 64 lowercase hexadecimal characters",
      limiterStoreErrorPolicy: "fail closed before authentication or route execution",
      livenessPolicy: "independent from the request limiter",
      rotationPolicy: "drain every old replica, then start every replica with one new shared key",
    },
    observations: {
      initial: {
        liveness: initialLiveness.map(publicObservation),
        admitted: initialLoad.admitted,
        exceeded: initialLoad.exceeded,
        proxyUpstreamCounts: [...proxyCountsBeforeRotationLoad],
        limiterKeyCount: initialKeys.length,
        limiterKeyShape: "environment namespace plus 64 lowercase hexadecimal characters",
        minimumTtlMilliseconds: Math.min(...initialTtls),
      },
      redisLoss: {
        signal: "SIGKILL",
        requestAdmission: outageAdmission.map(publicObservation),
        liveness: outageLiveness.map(publicObservation),
      },
      redisRecovery: {
        persistentRestart: true,
        exhaustedPrimaryBudget: recoveryPrimary.map(publicObservation),
        unaffectedSecondaryBudget: recoverySecondary.map(publicObservation),
        limiterKeyCount: postRecoveryKeys.length,
        minimumRecoveredTtlMilliseconds: Math.min(...recoveredTtls),
        minimumPostRecoveryTtlMilliseconds: Math.min(...postRecoveryTtls),
      },
      coordinatedKeyRotation: {
        oldReplicasDrainedBeforeRestart: true,
        newReplicaCount: replicaDefinitions.length,
        initialResponses: rotatedInitial.map(publicObservation),
        additionalAdmitted: rotatedLoad.admitted,
        exceeded: rotatedLoad.exceeded,
        upstreamRequestDelta: rotationUpstreamDelta,
        oldKeysLeftOnlyForBoundedExpiry: 2,
        newKeyCount: 1,
        minimumTtlMilliseconds: Math.min(...rotatedTtls),
        liveness: processLivenessAfterRotation.map(publicObservation),
      },
    },
    assertions: {
      productionRejectedProcessLocalLimiterBeforeListen: true,
      productionRejectedUnavailableLimiterAuthorityBeforeListen: true,
      bothActualApiProcessesReceivedLoad: true,
      exactlyOneSharedInitialBudgetEnforced: true,
      forgedForwardingChainsDidNotCreateParallelKeys: true,
      rawAddressesAbsentFromRedisKeys: true,
      limiterKeysContainedNoAuthorizationTenantOrCustomerData: true,
      redisSigkillMadeBothReplicasFailAdmissionClosed: true,
      livenessRemainedAvailableDuringRedisLoss: true,
      persistentRestartPreservedTheExhaustedBudget: true,
      unaffectedAddressRecoveredThroughBothReplicas: true,
      coordinatedRotationUsedOneNewSharedBudgetAcrossBothReplicas: true,
      securityHeadersCoveredAdmissionResponses: true,
      childProcessOutputDiscarded: true,
      customerOrProductionDataUsed: false,
    },
    evidenceMinimization: {
      rawClientAddressRecorded: false,
      rawForwardingHeaderRecorded: false,
      rawRedisKeyRecorded: false,
      redisCredentialRecorded: false,
      rateLimitHmacKeyRecorded: false,
      connectorKeyRecorded: false,
      sessionSecretRecorded: false,
      objectStorageCredentialRecorded: false,
      oidcClientSecretRecorded: false,
      authorizationHeaderRecorded: false,
      correlationIdRecorded: false,
      childProcessOutputRecorded: false,
    },
    sourceSha256: {
      "scripts/verify-live-api-rate-limit.mjs": await sha256File(
        join(repositoryRoot, "scripts/verify-live-api-rate-limit.mjs"),
      ),
      "apps/api/src/main.ts": await sha256File(join(repositoryRoot, "apps/api/src/main.ts")),
      "apps/api/src/app.ts": await sha256File(join(repositoryRoot, "apps/api/src/app.ts")),
      "apps/api/src/rate-limit.ts": await sha256File(
        join(repositoryRoot, "apps/api/src/rate-limit.ts"),
      ),
      "packages/config/src/index.ts": await sha256File(
        join(repositoryRoot, "packages/config/src/index.ts"),
      ),
      "package.json": await sha256File(join(repositoryRoot, "package.json")),
      "pnpm-lock.yaml": await sha256File(join(repositoryRoot, "pnpm-lock.yaml")),
    },
    limitations: [
      "This is a bounded single-host loopback exercise, not protected staging, multi-host scheduling, managed Redis, capacity, availability, penetration-test, compliance, or production-readiness evidence.",
      "The verifier-owned HTTP proxy proves overwrite composition with actual API processes but does not replace the separate exact Nginx proof or establish external TLS, CDN, hosting, network, or collector policy.",
      "One abrupt Redis process loss and persistent restart is exercised. Sentinel/Cluster behavior, managed failover, cross-host partitions, replica lag, eviction policy, and alert delivery remain unverified.",
      "The HMAC-key exercise intentionally drains all old processes before starting the new set. A mixed-key rolling deployment would create parallel budgets and remains prohibited.",
      "Synthetic documentation-range addresses are used only in memory. No customer request, credential, token, tenant, organization, provider payload, or production system is used.",
      "No database, source-system, financial, reconciliation-rule, provider-scope, tenant-authority, session, or AI behavior changes.",
    ],
  };
} catch (error) {
  failure = error;
} finally {
  await stopReplicaSet().catch((error) => {
    failure ??= error;
  });
  await proxy?.close().catch((error) => {
    failure ??= error;
  });
  if (inspectionRedis) {
    if (inspectionRedis.status === "ready") {
      await inspectionRedis.quit().catch(() => inspectionRedis?.disconnect());
    } else {
      inspectionRedis.disconnect();
    }
  }
  if (redisProcess) {
    await stopChild(redisProcess, "SIGTERM", 5_000).catch((error) => {
      failure ??= error;
    });
  }
  for (const child of children) {
    if (!child.exited) {
      await stopChild(child, "SIGTERM", 5_000).catch((error) => {
        failure ??= error;
      });
    }
  }
  await rm(runtimeDirectory, { recursive: true, force: true }).catch((error) => {
    failure ??= error;
  });
}

const cleanupPorts = [
  { port: ports.redis, host: "127.0.0.1" },
  { port: ports.proxy, host: "127.0.0.1" },
  { port: ports.replicaOne, host: "::1" },
  { port: ports.replicaTwo, host: "::1" },
  { port: ports.startupProbe, host: "::1" },
];
const cleanupResults = await Promise.all(
  cleanupPorts.map(async ({ port, host }) => ({
    port,
    closed: !(await canConnect(port, host)),
  })),
);
if (cleanupResults.some((result) => !result.closed)) {
  failure ??= new Error("one or more verifier listeners remained open after cleanup");
}
if (interruptedSignal) {
  failure ??= new Error(`verification interrupted by ${interruptedSignal}`);
}

if (failure) {
  process.stderr.write(`${sanitizeFailure(failure)}\n`);
  process.exitCode = 1;
} else {
  evidence.cleanup = {
    ephemeralRedisStateRemoved: true,
    listenersClosed: cleanupResults,
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

function startReplicaSet(keySecret, phase) {
  assert(
    !replicaDefinitions.some((replica) =>
      children.some((child) => child.label === `${phase}-${replica.label}` && !child.exited),
    ),
    "replica set already started",
  );
  for (const replica of replicaDefinitions) {
    children.push(startApi(`${phase}-${replica.label}`, replica.port, keySecret));
  }
}

async function stopReplicaSet() {
  const running = children.filter((child) => child.label.includes("api-replica") && !child.exited);
  await Promise.all(running.map((child) => stopChild(child, "SIGTERM", 8_000)));
}

function startApi(label, port, keySecret, overrides = {}) {
  return startChild(label, process.execPath, [join(repositoryRoot, "apps/api/dist/main.js")], {
    ...process.env,
    NODE_ENV: "production",
    NODE_OPTIONS: "--throw-deprecation",
    APP_ENV: environmentName,
    WEB_ORIGIN: "https://web.reconai.invalid",
    API_ORIGIN: "https://api.reconai.invalid",
    API_HOST: "::1",
    API_PORT: port.toString(),
    API_READINESS_TIMEOUT_MS: "250",
    API_TRUST_PROXY_CIDRS: "::1/128",
    API_RATE_LIMIT_STORE: "redis",
    API_RATE_LIMIT_KEY_SECRET: keySecret,
    API_RATE_LIMIT_REDIS_CONNECT_TIMEOUT_MS: "250",
    API_RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS: "250",
    DATABASE_URL: apiDatabaseUrl,
    DATABASE_WORKER_URL: workerDatabaseUrl,
    REDIS_URL: redisUrl.toString(),
    S3_ENDPOINT: "https://object-storage.reconai.invalid",
    S3_REGION: "us-east-1",
    S3_BUCKET: `reconai-live-rate-limit-${ports.redis.toString()}`,
    S3_ACCESS_KEY_ID: objectStorageAccessKeyId,
    S3_SECRET_ACCESS_KEY: objectStorageSecretAccessKey,
    S3_FORCE_PATH_STYLE: "true",
    S3_SERVER_SIDE_ENCRYPTION: "AES256",
    S3_KMS_KEY_ID: "",
    OIDC_ISSUER: "https://identity.reconai.invalid/realms/live-api-rate-limit",
    OIDC_CLIENT_ID: "reconai-live-api-rate-limit",
    OIDC_CLIENT_SECRET: oidcClientSecret,
    OIDC_ID_TOKEN_SIGNING_ALGORITHM: "RS256",
    SUPPORT_ACCESS_ENABLED: "false",
    SUPPORT_OIDC_GROUP: "",
    SUPPORT_OIDC_AUTHENTICATION_CONTEXT: "",
    SUPPORT_IDENTITY_HMAC_KEY: "",
    SESSION_SECRET: sessionSecret,
    SESSION_COOKIE_SECURE: "true",
    SESSION_REVOCATION_STORE: "redis",
    CONNECTOR_ENCRYPTION_KEYS: "v1=env:RECONAI_CONNECTOR_ENCRYPTION_KEY_LIVE_API_RATE_LIMIT",
    CONNECTOR_ENCRYPTION_ACTIVE_KEY_VERSION: "v1",
    RECONAI_CONNECTOR_ENCRYPTION_KEY_LIVE_API_RATE_LIMIT: connectorKey,
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://telemetry.reconai.invalid",
    OTEL_TRACE_SAMPLE_RATIO: "0",
    OTEL_METRIC_EXPORT_INTERVAL_MS: "300000",
    OTEL_EXPORT_TIMEOUT_MS: "100",
    LOG_LEVEL: "error",
    EMAIL_PROVIDER: "disabled",
    EMAIL_WEBHOOK_URL: "",
    EMAIL_DELIVERY_TOKEN: "",
    EMAIL_FROM: "",
    PROVIDER_GAP_REPAIR_ENABLED: "false",
    PROVIDER_PRIVACY_DEADLINE_MONITOR_ENABLED: "false",
    SHOPIFY_OAUTH_ENABLED: "false",
    STRIPE_OAUTH_ENABLED: "false",
    AI_ENABLED: "false",
    AI_PROVIDER: "disabled",
    AI_API_KEY: "",
    ...overrides,
  });
}

function startRedis() {
  return startChild(
    "redis",
    redisServerPath,
    [
      "--bind",
      "127.0.0.1",
      "--protected-mode",
      "yes",
      "--port",
      ports.redis.toString(),
      "--requirepass",
      redisPassword,
      "--appendonly",
      "yes",
      "--appendfsync",
      "always",
      "--save",
      "",
      "--dir",
      runtimeDirectory,
      "--dbfilename",
      "dump.rdb",
      "--daemonize",
      "no",
      "--loglevel",
      "warning",
      "--logfile",
      "",
    ],
    process.env,
  );
}

function startChild(label, command, arguments_, environment) {
  const child = spawn(command, arguments_, {
    cwd: repositoryRoot,
    env: environment,
    detached: true,
    shell: false,
    stdio: "ignore",
  });
  const record = {
    label,
    child,
    exited: false,
    exitCode: undefined,
    exitSignal: undefined,
  };
  child.once("exit", (code, signal) => {
    record.exited = true;
    record.exitCode = code ?? undefined;
    record.exitSignal = signal ?? undefined;
  });
  child.once("error", () => {
    record.exited = true;
    record.exitCode = 1;
  });
  return record;
}

async function stopChild(record, signal, timeoutMilliseconds) {
  if (record.exited || record.child.pid === undefined) return;
  try {
    process.kill(-record.child.pid, signal);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") return;
    throw error;
  }
  const result = await waitForChildExit(record, timeoutMilliseconds);
  if (result.exited) return;
  if (signal !== "SIGKILL") {
    try {
      process.kill(-record.child.pid, "SIGKILL");
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ESRCH")) throw error;
    }
    const killed = await waitForChildExit(record, 3_000);
    assert(killed.exited, `${record.label} did not exit after SIGKILL`);
    return;
  }
  throw new Error(`${record.label} did not exit after ${signal}`);
}

async function waitForChildExit(record, timeoutMilliseconds) {
  if (record.exited) {
    return { exited: true, exitCode: record.exitCode, exitSignal: record.exitSignal };
  }
  await Promise.race([
    new Promise((resolve) => record.child.once("exit", resolve)),
    delay(timeoutMilliseconds),
  ]);
  return {
    exited: record.exited,
    exitCode: record.exitCode,
    exitSignal: record.exitSignal,
  };
}

function createOverwritingProxy() {
  let listening = false;
  let nextUpstream = 0;
  const upstreamCounts = replicaDefinitions.map(() => 0);
  const sockets = new Set();
  const server = createServer((request, response) => {
    const upstreamIndex = nextUpstream % replicaDefinitions.length;
    nextUpstream += 1;
    upstreamCounts[upstreamIndex] += 1;
    const upstream = replicaDefinitions[upstreamIndex];
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      const normalized = name.toLowerCase();
      if (
        normalized === "forwarded" ||
        normalized === "x-forwarded-for" ||
        normalized === "x-forwarded-host" ||
        normalized === "x-forwarded-proto" ||
        normalized === "host"
      ) {
        continue;
      }
      headers[name] = value;
    }
    headers.host = "api.reconai.invalid";
    headers["x-forwarded-for"] = primarySyntheticAddress;
    headers["x-forwarded-host"] = "api.reconai.invalid";
    headers["x-forwarded-proto"] = "https";
    const upstreamRequest = createHttpRequest(
      {
        hostname: "::1",
        port: upstream.port,
        method: request.method,
        path: request.url,
        headers,
        timeout: 3_000,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstreamRequest.on("error", () => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
      }
      response.end('{"status":"upstream_unavailable"}');
    });
    upstreamRequest.on("timeout", () => upstreamRequest.destroy());
    request.pipe(upstreamRequest);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("error", () => {
    // listen() and request assertions surface bounded failures.
  });
  return {
    upstreamCounts,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(ports.proxy, "127.0.0.1", () => {
          listening = true;
          server.off("error", reject);
          resolve();
        });
      }),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        if (!listening) {
          resolve();
          return;
        }
        server.close(() => {
          listening = false;
          resolve();
        });
      }),
  };
}

async function waitForReplicaLiveness(timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    throwIfInterrupted();
    const statuses = await Promise.all(
      replicaDefinitions.map(async (replica) => {
        try {
          return (await directRequest(replica.port, "/health/live")).statusCode;
        } catch {
          return 0;
        }
      }),
    );
    if (statuses.every((status) => status === 200)) return;
    const exited = children
      .filter((child) => child.label.includes("api-replica"))
      .slice(-replicaDefinitions.length)
      .find((child) => child.exited);
    assert(!exited, `${exited?.label ?? "API replica"} exited before liveness`);
    await delay(100);
  }
  throw new Error("API replicas did not become live before the deadline");
}

async function directLiveness() {
  const responses = await Promise.all(
    replicaDefinitions.map((replica) => directRequest(replica.port, "/health/live")),
  );
  for (const response of responses) {
    assert(response.statusCode === 200, "API liveness was not 200");
    assertSameJson(response.json, { status: "ok" }, "API liveness body");
  }
  return responses;
}

async function proxyRequest(headers = {}) {
  return boundedRequest({
    hostname: "127.0.0.1",
    port: ports.proxy,
    path: "/v1/organizations",
    headers,
  });
}

async function directRequest(port, path, forwardedAddress) {
  return boundedRequest({
    hostname: "::1",
    port,
    path,
    headers: forwardedAddress
      ? {
          host: "api.reconai.invalid",
          "x-forwarded-for": forwardedAddress,
          "x-forwarded-host": "api.reconai.invalid",
          "x-forwarded-proto": "https",
        }
      : { host: "api.reconai.invalid" },
  });
}

function boundedRequest(options) {
  return new Promise((resolve, reject) => {
    const request = createHttpRequest(
      {
        method: "GET",
        timeout: 3_000,
        ...options,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 64 * 1024) {
            response.destroy(new Error("response exceeded the 64 KiB verifier ceiling"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = JSON.parse(body);
          } catch {
            reject(new Error("API returned a non-JSON response"));
            return;
          }
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            json,
          });
        });
      },
    );
    request.once("error", reject);
    request.once("timeout", () => request.destroy(new Error("API request timed out")));
    request.end();
  });
}

function classifyAdmissionResponses(responses) {
  let admitted = 0;
  let exceeded = 0;
  for (const response of responses) {
    if (response.statusCode === 401) {
      assertSafeErrorResponse(response, 401, "AUTHENTICATION_REQUIRED", "authentication required");
      admitted += 1;
      continue;
    }
    if (response.statusCode === 429) {
      assertSafeErrorResponse(response, 429, "RATE_LIMITED", "request rate exceeded");
      exceeded += 1;
      continue;
    }
    throw new Error(`unexpected request-admission status ${response.statusCode.toString()}`);
  }
  return { admitted, exceeded };
}

function assertSafeErrorResponse(response, statusCode, code, message) {
  assert(response.statusCode === statusCode, `expected HTTP ${statusCode.toString()}`);
  assert(
    response.json &&
      typeof response.json === "object" &&
      !Array.isArray(response.json) &&
      response.json.code === code &&
      response.json.message === message &&
      typeof response.json.correlationId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        response.json.correlationId,
      ) &&
      Object.keys(response.json).sort().join(",") === "code,correlationId,message",
    `HTTP ${statusCode.toString()} did not use the exact safe error envelope`,
  );
  const serialized = JSON.stringify(response.json);
  assert(!serialized.includes(primarySyntheticAddress), "safe error body exposed a client address");
  assert(!serialized.includes(redisPassword), "safe error body exposed a Redis credential");
}

function assertSecurityHeaders(responses) {
  for (const response of responses) {
    assert(
      response.headers["x-content-type-options"] === "nosniff",
      "admission response omitted X-Content-Type-Options",
    );
    assert(
      response.headers["x-frame-options"] === "SAMEORIGIN",
      "admission response omitted X-Frame-Options",
    );
    assert(
      response.headers["referrer-policy"] === "no-referrer",
      "admission response omitted Referrer-Policy",
    );
  }
}

async function waitForAdmissionStatus(port, address, statusCode, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    throwIfInterrupted();
    try {
      const response = await directRequest(port, "/v1/organizations", address);
      lastStatus = response.statusCode;
      if (lastStatus === statusCode) {
        if (statusCode === 429) {
          assertSafeErrorResponse(response, 429, "RATE_LIMITED", "request rate exceeded");
        }
        return response;
      }
    } catch {
      lastStatus = 0;
    }
    await delay(100);
  }
  throw new Error(
    `API admission did not recover to ${statusCode.toString()}; last status ${lastStatus.toString()}`,
  );
}

async function connectRedis(suffix) {
  const client = new Redis(redisUrl.toString(), {
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
    commandTimeout: 1_000,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    lazyConnect: true,
    connectionName: `reconai-live-rate-limit-${suffix}`,
  });
  client.on("error", () => {
    // Bounded Redis assertions report only safe classifications.
  });
  await client.connect();
  await client.ping();
  return client;
}

async function waitForRedis(url, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    throwIfInterrupted();
    let client;
    try {
      client = new Redis(url.toString(), {
        maxRetriesPerRequest: 1,
        connectTimeout: 250,
        commandTimeout: 250,
        enableReadyCheck: true,
        enableOfflineQueue: false,
        lazyConnect: true,
      });
      client.on("error", () => {
        // Startup retry reports only the final bounded classification.
      });
      await client.connect();
      await client.ping();
      await client.quit();
      return;
    } catch {
      client?.disconnect();
      await delay(100);
    }
  }
  throw new Error("Redis did not become ready before the deadline");
}

async function limiterKeys() {
  assert(inspectionRedis?.status === "ready", "inspection Redis client is not ready");
  const keys = [];
  let cursor = "0";
  do {
    const [nextCursor, page] = await inspectionRedis.scan(
      cursor,
      "MATCH",
      `${namespace}*`,
      "COUNT",
      100,
    );
    cursor = nextCursor;
    keys.push(...page);
    assert(keys.length <= 10, "limiter namespace contained an unexpected number of keys");
  } while (cursor !== "0");
  return keys.sort((left, right) => left.localeCompare(right, "en"));
}

async function positiveTtls(keys) {
  const ttls = await Promise.all(keys.map((key) => inspectionRedis.pttl(key)));
  assert(
    ttls.every((ttl) => ttl > 0),
    "limiter key did not have a positive TTL",
  );
  return ttls;
}

function rateLimitKey(secret, address) {
  return `${namespace}${createHmac("sha256", Buffer.from(secret, "base64url"))
    .update("client-ip\0", "utf8")
    .update(address, "utf8")
    .digest("hex")}`;
}

function assertKeysArePseudonymous(keys) {
  for (const key of keys) {
    assert(
      new RegExp(`^${escapeRegExp(namespace)}[a-f0-9]{64}$`, "u").test(key),
      "limiter key did not use the expected pseudonymous shape",
    );
    assert(!key.includes(primarySyntheticAddress), "limiter key exposed the primary address");
    assert(!key.includes(secondarySyntheticAddress), "limiter key exposed the secondary address");
  }
}

function assertSameMembers(actual, expected, label) {
  const normalizedActual = [...actual].sort((left, right) => left.localeCompare(right, "en"));
  const normalizedExpected = [...expected].sort((left, right) => left.localeCompare(right, "en"));
  assertSameJson(normalizedActual, normalizedExpected, label);
}

function assertSameJson(actual, expected, label) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} did not match`);
}

function publicObservation(response) {
  return {
    httpStatus: response.statusCode,
    bodyClass:
      response.statusCode === 200
        ? "ok"
        : response.statusCode === 401
          ? "authentication_required"
          : response.statusCode === 429
            ? "rate_limited"
            : response.statusCode === 500
              ? "internal_error"
              : "unexpected",
  };
}

async function assertPortClosed(port, host) {
  assert(!(await canConnect(port, host)), `required verifier port ${port.toString()} is in use`);
}

function canConnect(port, host) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const done = (connected) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(250, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function requiredDirectory(name) {
  const value = requiredEnvironment(name);
  assert(isAbsolute(value), `${name} must be an absolute path`);
  const metadata = await stat(value);
  assert(metadata.isDirectory(), `${name} must identify a directory`);
  return value;
}

async function requiredExecutable(name) {
  const value = requiredEnvironment(name);
  assert(isAbsolute(value), `${name} must be an absolute path`);
  const metadata = await stat(value);
  assert(metadata.isFile(), `${name} must identify a file`);
  assert((metadata.mode & 0o111) !== 0, `${name} must identify an executable file`);
  return value;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredSha256(name) {
  const value = requiredEnvironment(name);
  assert(/^[a-f0-9]{64}$/u.test(value), `${name} must be a lowercase SHA-256`);
  return value;
}

function boundedPort(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  assert(/^[1-9][0-9]{0,4}$/u.test(raw), `${name} must be a decimal TCP port`);
  const value = Number(raw);
  assert(Number.isSafeInteger(value) && value <= 65_535, `${name} is outside the TCP port range`);
  return value;
}

function assertDistinctPorts(values) {
  const ports_ = Object.values(values);
  assert(new Set(ports_).size === ports_.length, "verifier ports must be distinct");
}

function requiredCapture(value, pattern, label) {
  const match = pattern.exec(value);
  if (!match?.[1]) throw new Error(`${label} was unavailable`);
  return match[1];
}

function requiredCount(value) {
  if (typeof value !== "number") throw new Error("proxy count was unavailable");
  return value;
}

function captureExecutable(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const capture = (chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-16 * 1024);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error("runtime metadata command failed"));
    });
  });
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function throwIfInterrupted() {
  if (interruptedSignal) throw new Error(`verification interrupted by ${interruptedSignal}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sanitizeFailure(error) {
  let message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  for (const secret of [
    redisPassword,
    firstKeySecret,
    secondKeySecret,
    sessionSecret,
    connectorKey,
    objectStorageAccessKeyId,
    objectStorageSecretAccessKey,
    oidcClientSecret,
    encodeURIComponent(redisPassword),
  ]) {
    message = message.split(secret).join("[REDACTED]");
  }
  return message
    .replace(/redis:\/\/[^\s]+/gu, "redis://[REDACTED]")
    .replace(/[A-Za-z0-9_-]{43,86}/gu, "[REDACTED]");
}
