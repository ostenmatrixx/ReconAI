import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { performance } from "node:perf_hooks";
import { setTimeout as nodeSetTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const requireFromObjectStorage = createRequire(
  new URL("../packages/object-storage/package.json", import.meta.url),
);
const postgres = (await import(requireFromApi.resolve("postgres"))).default;
const ioredis = requireFromApi("ioredis");
const Redis = ioredis.Redis ?? ioredis.default;
const { CreateBucketCommand, DeleteBucketCommand, HeadBucketCommand, S3Client } =
  requireFromObjectStorage("@aws-sdk/client-s3");

const readinessCacheMilliseconds = 1_000;
const readinessTimeoutMilliseconds = 1_000;
const transitionWindowMilliseconds = 15_000;
const directDatabaseUrl = validatedServiceUrl(
  requiredEnvironment("DATABASE_URL"),
  "DATABASE_URL",
  ["postgresql:"],
  5432,
);
const directRedisUrl = validatedServiceUrl(
  requiredEnvironment("REDIS_URL"),
  "REDIS_URL",
  ["redis:"],
  6379,
);
const directObjectStorageUrl = validatedServiceUrl(
  requiredEnvironment("S3_ENDPOINT"),
  "S3_ENDPOINT",
  ["http:"],
  80,
);
const s3Region = requiredEnvironment("S3_REGION");
const s3AccessKeyId = requiredEnvironment("S3_ACCESS_KEY_ID");
const s3SecretAccessKey = requiredEnvironment("S3_SECRET_ACCESS_KEY");
const s3ForcePathStyle = requiredEnvironment("S3_FORCE_PATH_STYLE") === "true";
const sessionSecret = requiredEnvironment("SESSION_SECRET");
if (sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET must contain at least 32 characters");
}

const ports = {
  postgresqlProxy: boundedPort("LIVE_READINESS_POSTGRES_PROXY_PORT", 15_432),
  redisProxy: boundedPort("LIVE_READINESS_REDIS_PROXY_PORT", 16_379),
  objectStorageProxy: boundedPort("LIVE_READINESS_OBJECT_STORAGE_PROXY_PORT", 19_000),
  apiReplicaOne: boundedPort("LIVE_READINESS_API_REPLICA_ONE_PORT", 4_010),
  apiReplicaTwo: boundedPort("LIVE_READINESS_API_REPLICA_TWO_PORT", 4_011),
};
assertDistinctPorts(ports, [
  servicePort(directDatabaseUrl, 5432),
  servicePort(directRedisUrl, 6379),
  servicePort(directObjectStorageUrl, 80),
]);

const bucket = `reconai-live-readiness-${randomBytes(8).toString("hex")}`;
const proxies = [
  createFaultProxy(
    "postgresql",
    directDatabaseUrl.hostname,
    servicePort(directDatabaseUrl, 5432),
    ports.postgresqlProxy,
  ),
  createFaultProxy(
    "redis",
    directRedisUrl.hostname,
    servicePort(directRedisUrl, 6379),
    ports.redisProxy,
  ),
  createFaultProxy(
    "object_storage",
    directObjectStorageUrl.hostname,
    servicePort(directObjectStorageUrl, 80),
    ports.objectStorageProxy,
  ),
];
const proxiesByName = new Map(proxies.map((proxy) => [proxy.name, proxy]));
const replicaDefinitions = [
  { label: "api-replica-1", port: ports.apiReplicaOne },
  { label: "api-replica-2", port: ports.apiReplicaTwo },
];
const children = [];
let database;
let redis;
let objectStorage;
let bucketCreated = false;
let interruptedSignal;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interruptedSignal = signal;
  });
}

try {
  database = postgres(directDatabaseUrl.toString(), {
    connect_timeout: 2,
    idle_timeout: 2,
    max: 1,
  });
  const databaseRows = await database`select current_setting('server_version') as version`;
  const databaseVersion = databaseRows[0]?.version;
  if (typeof databaseVersion !== "string" || databaseVersion.length === 0) {
    throw new Error("PostgreSQL did not return a bounded server version");
  }

  redis = new Redis(directRedisUrl.toString(), {
    connectTimeout: 2_000,
    commandTimeout: 2_000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  redis.on("error", () => {
    // Direct dependency diagnostics are reported through bounded verifier failures.
  });
  await redis.connect();
  const redisInfo = await redis.info("server");
  const redisVersion = requiredCapture(
    redisInfo,
    /^redis_version:([0-9]+(?:\.[0-9]+){1,3})\r?$/mu,
    "Redis server version",
  );

  objectStorage = new S3Client({
    endpoint: directObjectStorageUrl.toString(),
    region: s3Region,
    credentials: {
      accessKeyId: s3AccessKeyId,
      secretAccessKey: s3SecretAccessKey,
    },
    forcePathStyle: s3ForcePathStyle,
    maxAttempts: 1,
  });
  await objectStorage.send(new CreateBucketCommand({ Bucket: bucket }));
  bucketCreated = true;
  await objectStorage.send(new HeadBucketCommand({ Bucket: bucket }));

  await Promise.all(proxies.map((proxy) => proxy.listen()));

  for (const replica of replicaDefinitions) {
    const environment = replicaEnvironment(replica.port);
    children.push(
      startChild(
        replica.label,
        "pnpm",
        ["exec", "tsx", "--conditions=development", "apps/api/src/main.ts"],
        environment,
      ),
    );
  }

  await Promise.all(
    replicaDefinitions.map((replica) =>
      waitForExactHealth(replica, "live", 200, { status: "ok" }, 30_000),
    ),
  );
  const initialReady = await waitForAllReadiness(200, { status: "ready" });
  const outageEvidence = [];

  for (const dependency of ["postgresql", "redis", "object_storage"]) {
    throwIfInterrupted();
    const proxy = requiredProxy(dependency);
    proxy.disable();
    await delay(readinessCacheMilliseconds + 100);

    const unavailable = await waitForAllReadiness(503, { status: "not_ready" });
    const liveness = await Promise.all(
      replicaDefinitions.map((replica) =>
        requestExactHealth(replica, "live", 200, { status: "ok" }),
      ),
    );
    assertOnlyProxyDisabled(dependency);

    proxy.enable();
    await delay(readinessCacheMilliseconds + 100);
    const recovered = await waitForAllReadiness(200, { status: "ready" });
    assertAllProxiesEnabled();

    outageEvidence.push({
      dependency,
      unavailable: unavailable.map(publicObservation),
      livenessDuringOutage: liveness.map(publicObservation),
      recovered: recovered.map(publicObservation),
    });
  }

  // The health response can reach the verifier just before the child's stdout data event.
  await delay(250);
  const logEvidence = children.map((child) => verifyReadinessTransitions(child));
  for (const child of children) assertNoSensitiveOutput(child);

  const evidence = {
    artifactVersion: 1,
    recordedAt: new Date().toISOString(),
    scope:
      "Two live API replicas under independent PostgreSQL, Redis, and object-storage transport outages and recovery",
    sourceState: "uncommitted working tree; no repository commit exists",
    topology: {
      apiReplicas: replicaDefinitions.length,
      backingServices: {
        postgresql: { live: true, serverVersion: boundedMetadata(databaseVersion) },
        redis: { live: true, serverVersion: boundedMetadata(redisVersion) },
        objectStorage: {
          live: true,
          privateEphemeralBucketVerified: true,
          implementation:
            optionalBoundedMetadata("LIVE_READINESS_OBJECT_STORAGE_IMPLEMENTATION") ?? "unreported",
        },
      },
      faultInjection:
        "Per-dependency loopback TCP transport proxies reject new connections and destroy active sockets",
    },
    contract: {
      readinessTimeoutMilliseconds,
      readinessCacheMilliseconds,
      publicReady: { httpStatus: 200, body: { status: "ready" } },
      publicNotReady: { httpStatus: 503, body: { status: "not_ready" } },
      livenessDuringDependencyOutage: { httpStatus: 200, body: { status: "ok" } },
      internalCheckNames: ["postgresql", "redis", "object_storage"],
    },
    observations: {
      initialReady: initialReady.map(publicObservation),
      outages: outageEvidence,
      replicaLogs: logEvidence,
    },
    assertions: {
      everyOutageObservedByEveryReplica: true,
      everyReplicaRecoveredAfterEveryOutage: true,
      livenessRemainedDependencyIndependent: true,
      publicFailureResponsesWereOpaque: true,
      internalTransitionsNamedOnlyTheUnavailableDependency: true,
      credentialsEndpointsAndRawErrorsAbsentFromReadinessTransitions: true,
      allFaultProxiesRecovered: true,
    },
    limitations: [
      "The verifier injects dependency transport loss on one host; it does not crash service processes, exercise a scheduler, or prove multi-host behavior.",
      "Loopback HTTP is used; TLS, ingress, external load balancers, alert delivery, and production IAM are outside this evidence.",
      "This is bounded failure-containment evidence, not a capacity, availability, or production-readiness claim.",
      "No customer payload, provider sandbox, production credential, staging deployment, or hosted CI run is included.",
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
  for (const proxy of proxies) proxy.enable();
  await Promise.all(children.reverse().map((child) => stopChild(child)));
  await Promise.all(proxies.map((proxy) => proxy.close()));
  if (bucketCreated && objectStorage) {
    await objectStorage.send(new DeleteBucketCommand({ Bucket: bucket })).catch((error) => {
      process.exitCode = 1;
      process.stderr.write(
        `Ephemeral object-storage bucket cleanup failed: ${sanitize(
          error instanceof Error ? error.message : String(error),
        )}\n`,
      );
    });
  }
  objectStorage?.destroy();
  if (redis?.status === "ready") await redis.quit().catch(() => undefined);
  else redis?.disconnect();
  await database?.end({ timeout: 5 }).catch(() => undefined);
}

if (interruptedSignal) {
  process.stderr.write(`Live readiness verification stopped after ${interruptedSignal}.\n`);
  process.exitCode = 1;
}

function replicaEnvironment(apiPort) {
  const proxiedDatabaseUrl = proxyUrl(directDatabaseUrl, ports.postgresqlProxy);
  const proxiedRedisUrl = proxyUrl(directRedisUrl, ports.redisProxy);
  const proxiedObjectStorageUrl = proxyUrl(directObjectStorageUrl, ports.objectStorageProxy);
  return {
    ...process.env,
    NODE_ENV: "development",
    APP_ENV: "live-readiness-verification",
    WEB_ORIGIN: "http://127.0.0.1:3000",
    API_ORIGIN: `http://127.0.0.1:${apiPort.toString()}`,
    API_HOST: "127.0.0.1",
    API_PORT: apiPort.toString(),
    API_READINESS_TIMEOUT_MS: readinessTimeoutMilliseconds.toString(),
    API_RATE_LIMIT_STORE: "local",
    API_RATE_LIMIT_KEY_SECRET: "",
    DATABASE_URL: proxiedDatabaseUrl,
    REDIS_URL: proxiedRedisUrl,
    S3_ENDPOINT: proxiedObjectStorageUrl,
    S3_BUCKET: bucket,
    S3_SERVER_SIDE_ENCRYPTION: "",
    S3_KMS_KEY_ID: "",
    OIDC_ISSUER: "http://127.0.0.1:18180/realms/live-readiness-verification",
    OIDC_CLIENT_ID: "reconai-live-readiness-verification",
    SESSION_SECRET: sessionSecret,
    SESSION_COOKIE_SECURE: "false",
    SESSION_REVOCATION_STORE: "local",
    PROVIDER_GAP_REPAIR_ENABLED: "false",
    PROVIDER_PRIVACY_DEADLINE_MONITOR_ENABLED: "false",
    SHOPIFY_OAUTH_ENABLED: "false",
    STRIPE_OAUTH_ENABLED: "false",
    EMAIL_PROVIDER: "disabled",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    LOG_LEVEL: "info",
  };
}

function createFaultProxy(name, targetHost, targetPort, listenPort) {
  let enabled = true;
  let listening = false;
  const sockets = new Set();
  const server = createServer((client) => {
    trackSocket(client);
    if (!enabled) {
      client.destroy();
      return;
    }
    const upstream = createConnection({ host: targetHost, port: targetPort });
    trackSocket(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  });
  server.on("error", () => {
    // listen() observes startup errors; established socket failures are intentionally contained.
  });

  function trackSocket(socket) {
    sockets.add(socket);
    socket.on("error", () => {
      socket.destroy();
    });
    socket.once("close", () => sockets.delete(socket));
  }

  return {
    name,
    get enabled() {
      return enabled;
    },
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(listenPort, "127.0.0.1", () => {
          listening = true;
          server.off("error", reject);
          resolve();
        });
      }),
    disable: () => {
      enabled = false;
      for (const socket of sockets) socket.destroy();
    },
    enable: () => {
      enabled = true;
    },
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

function startChild(label, command, arguments_, environment) {
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

async function waitForAllReadiness(expectedStatus, expectedBody) {
  const startedAt = Date.now();
  let lastObservations = [];
  while (Date.now() - startedAt < transitionWindowMilliseconds) {
    throwIfInterrupted();
    const observations = await Promise.all(
      replicaDefinitions.map((replica) => requestHealth(replica, "ready")),
    );
    lastObservations = observations;
    if (
      observations.every(
        (observation) =>
          observation.httpStatus === expectedStatus && jsonEqual(observation.body, expectedBody),
      )
    ) {
      return observations;
    }
    assertChildrenRunning();
    await delay(200);
  }
  throw new Error(
    `API replicas did not reach readiness ${String(expectedStatus)}: ${JSON.stringify(
      lastObservations.map(publicObservation),
    )}`,
  );
}

async function waitForExactHealth(
  replica,
  route,
  expectedStatus,
  expectedBody,
  timeoutMilliseconds,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMilliseconds) {
    throwIfInterrupted();
    const observation = await requestHealth(replica, route);
    if (observation.httpStatus === expectedStatus && jsonEqual(observation.body, expectedBody)) {
      return observation;
    }
    assertChildrenRunning();
    await delay(200);
  }
  throw new Error(`${replica.label} /health/${route} did not return the expected bounded response`);
}

async function requestExactHealth(replica, route, expectedStatus, expectedBody) {
  const observation = await requestHealth(replica, route);
  if (observation.httpStatus !== expectedStatus || !jsonEqual(observation.body, expectedBody)) {
    throw new Error(
      `${replica.label} /health/${route}: expected ${String(
        expectedStatus,
      )} ${JSON.stringify(expectedBody)}, received ${String(
        observation.httpStatus,
      )} ${JSON.stringify(observation.body)}`,
    );
  }
  return observation;
}

async function requestHealth(replica, route) {
  const startedAt = performance.now();
  try {
    const response = await fetch(`http://127.0.0.1:${replica.port.toString()}/health/${route}`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(2_500),
    });
    const rawBody = await response.text();
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = { invalidJson: true };
    }
    return {
      replica: replica.label,
      httpStatus: response.status,
      body,
      elapsedMilliseconds: Number((performance.now() - startedAt).toFixed(3)),
    };
  } catch {
    return {
      replica: replica.label,
      httpStatus: 0,
      body: { requestFailed: true },
      elapsedMilliseconds: Number((performance.now() - startedAt).toFixed(3)),
    };
  }
}

function verifyReadinessTransitions(child) {
  const transitions = child.output
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event.msg === "API readiness state changed" ? [event] : [];
      } catch {
        return [];
      }
    });
  const expected = [
    { ready: true, failedChecks: [], timedOut: false },
    { ready: false, failedChecks: ["postgresql"], timedOut: false },
    { ready: true, failedChecks: [], timedOut: false },
    { ready: false, failedChecks: ["redis"], timedOut: false },
    { ready: true, failedChecks: [], timedOut: false },
    { ready: false, failedChecks: ["object_storage"], timedOut: false },
    { ready: true, failedChecks: [], timedOut: false },
  ];
  const actual = transitions.map(({ ready, failedChecks, timedOut }) => ({
    ready,
    failedChecks,
    timedOut,
  }));
  if (!jsonEqual(actual, expected)) {
    throw new Error(`${child.label} readiness transitions differed: ${JSON.stringify(actual)}`);
  }
  for (const event of transitions) {
    if ("error" in event || "err" in event || "endpoint" in event || "url" in event) {
      throw new Error(`${child.label} readiness transition included raw diagnostic fields`);
    }
  }
  return {
    replica: child.label,
    transitionCount: transitions.length,
    sequence: actual,
    rawErrorsOrEndpointsLogged: false,
  };
}

function assertNoSensitiveOutput(child) {
  for (const value of sensitiveValues()) {
    if (value.length >= 4 && child.output.includes(value)) {
      throw new Error(`${child.label} output contained configured sensitive material`);
    }
  }
}

function sensitiveValues() {
  return [
    directDatabaseUrl.password,
    directRedisUrl.password,
    s3AccessKeyId,
    s3SecretAccessKey,
    sessionSecret,
    process.env["OIDC_CLIENT_SECRET"] ?? "",
    process.env["RECONAI_CONNECTOR_ENCRYPTION_KEY_V1"] ?? "",
  ].filter(Boolean);
}

function assertChildrenRunning() {
  const exited = children.find((child) => child.exited);
  if (exited) throw new Error(`${exited.label} exited during live readiness verification`);
}

function assertOnlyProxyDisabled(expectedName) {
  for (const proxy of proxies) {
    if (proxy.enabled !== (proxy.name !== expectedName)) {
      throw new Error(`fault-proxy state was not isolated to ${expectedName}`);
    }
  }
}

function assertAllProxiesEnabled() {
  if (proxies.some((proxy) => !proxy.enabled)) {
    throw new Error("a dependency fault proxy remained disabled after recovery");
  }
}

function requiredProxy(name) {
  const proxy = proxiesByName.get(name);
  if (!proxy) throw new Error(`unknown dependency proxy: ${name}`);
  return proxy;
}

function throwIfInterrupted() {
  if (interruptedSignal) throw new Error(`verification interrupted by ${interruptedSignal}`);
}

function validatedServiceUrl(value, name, protocols, fallbackPort) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new Error(`${name} must use ${protocols.join(" or ")}`);
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error(`${name} must target loopback infrastructure`);
  }
  if (
    name === "S3_ENDPOINT" &&
    (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
  ) {
    throw new Error("S3_ENDPOINT must be a credential-free loopback origin");
  }
  servicePort(url, fallbackPort);
  return url;
}

function servicePort(url, fallback) {
  if (!url.port) return fallback;
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("dependency URL contains an invalid TCP port");
  }
  return port;
}

function proxyUrl(directUrl, port) {
  const result = new URL(directUrl);
  result.hostname = "127.0.0.1";
  result.port = port.toString();
  return result.toString();
}

function assertDistinctPorts(namedPorts, directPorts) {
  const values = Object.values(namedPorts);
  if (new Set(values).size !== values.length) {
    throw new Error("live readiness proxy and API ports must be distinct");
  }
  if (values.some((port) => directPorts.includes(port))) {
    throw new Error("live readiness ports must not overlap direct dependency ports");
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

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredCapture(value, pattern, label) {
  const capture = pattern.exec(value)?.[1];
  if (!capture) throw new Error(`${label} was unavailable`);
  return capture;
}

function boundedMetadata(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._+:/()-]{0,127}$/u.test(value)) {
    throw new Error("dependency metadata contained unsupported characters");
  }
  return value;
}

function optionalBoundedMetadata(name) {
  const value = process.env[name];
  return value ? boundedMetadata(value) : undefined;
}

function publicObservation(observation) {
  return {
    replica: observation.replica,
    httpStatus: observation.httpStatus,
    body: observation.body,
    elapsedMilliseconds: observation.elapsedMilliseconds,
  };
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function delay(milliseconds) {
  return new Promise((resolve) => nodeSetTimeout(resolve, milliseconds));
}

function sanitizedTail(value) {
  return sanitize(value).slice(-8_000);
}

function sanitize(value) {
  let result = String(value)
    .replace(
      /\b(postgresql|postgres|redis):\/\/([^:@/\s]+):([^@/\s]+)@/giu,
      (_match, scheme, username) => `${scheme}://${username}:<redacted>@`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/giu, "Bearer <redacted>");
  for (const secret of sensitiveValues()) {
    if (secret.length >= 4) result = result.split(secret).join("<redacted>");
  }
  return result;
}
