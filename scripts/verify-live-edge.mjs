import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { basename, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as nodeSetTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const Fastify = (await import(requireFromApi.resolve("fastify"))).default;
const canonicalConfigurationPath = join(repositoryRoot, "infra/nginx/reconai.conf");
const edgePort = boundedPort("LIVE_EDGE_PORT", 8_088);
const webPort = boundedPort("LIVE_EDGE_WEB_PORT", 3_100);
const apiReplicaOnePort = boundedPort("LIVE_EDGE_API_REPLICA_ONE_PORT", 4_100);
const apiReplicaTwoPort = boundedPort("LIVE_EDGE_API_REPLICA_TWO_PORT", 4_101);
assertDistinctPorts([edgePort, webPort, apiReplicaOnePort, apiReplicaTwoPort]);
const nginxBinary = await validatedNginxBinary(requiredEnvironment("LIVE_EDGE_NGINX_BIN"));
const nginxBinarySha256 = createHash("sha256")
  .update(await readFile(nginxBinary))
  .digest("hex");
const nginxVersionOutput = await runCommand(
  nginxBinary,
  ["-v"],
  process.env,
  "Nginx version inspection",
);
const nginxVersion = requiredCapture(
  nginxVersionOutput,
  /nginx version: nginx\/([0-9]+(?:\.[0-9]+){2})/u,
  "Nginx version",
);
const canonicalConfiguration = await readFile(canonicalConfigurationPath, "utf8");
const canonicalConfigurationSha256 = createHash("sha256")
  .update(canonicalConfiguration)
  .digest("hex");
const temporaryRoot = await mkdtemp(join(tmpdir(), "reconai-live-edge."));
assertSafeTemporaryPath(temporaryRoot);

const apiReplicas = [];
let webServer;
let nginx;
let phaseOneOutput = "";
let phaseTwoOutput = "";
let webRequests = 0;

try {
  await Promise.all([
    mkdir(join(temporaryRoot, "client-body"), { recursive: true }),
    mkdir(join(temporaryRoot, "proxy-temp"), { recursive: true }),
  ]);

  webServer = createServer((request, response) => {
    webRequests += 1;
    const body = JSON.stringify({
      upstream: "web",
      method: request.method,
      path: request.url,
      forwarded: request.headers.forwarded ?? null,
      forwardedFor: request.headers["x-forwarded-for"] ?? null,
      forwardedHost: request.headers["x-forwarded-host"] ?? null,
      forwardedProto: request.headers["x-forwarded-proto"] ?? null,
      host: request.headers.host ?? null,
      realIp: request.headers["x-real-ip"] ?? null,
      requestId: request.headers["x-request-id"] ?? null,
    });
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body).toString(),
    });
    response.end(body);
  });
  await listen(webServer, webPort);

  apiReplicas.push(
    await startApiReplica("api-replica-1", apiReplicaOnePort),
    await startApiReplica("api-replica-2", apiReplicaTwoPort),
  );

  const runtimeConfigurationPath = join(temporaryRoot, "nginx.conf");
  const runtimeConfiguration = renderRuntimeConfiguration(canonicalConfiguration, {
    edgePort,
    webPort,
    apiReplicaOnePort,
    apiReplicaTwoPort,
    temporaryRoot,
  });
  await writeFile(runtimeConfigurationPath, runtimeConfiguration, {
    encoding: "utf8",
    mode: 0o600,
  });
  const syntaxResult = await runCommand(
    nginxBinary,
    ["-p", `${temporaryRoot}/`, "-c", runtimeConfigurationPath, "-t"],
    process.env,
    "Nginx configuration parse",
  );
  if (!/test is successful/u.test(syntaxResult)) {
    throw new Error("Nginx did not confirm a successful configuration parse");
  }

  nginx = startChild("nginx-phase-1", nginxBinary, [
    "-p",
    `${temporaryRoot}/`,
    "-c",
    runtimeConfigurationPath,
    "-g",
    "daemon off;",
  ]);
  await waitForEdge();

  const spoofed = await requestJson("/v1/edge-probe", {
    forwarded: 'for=198.51.100.12;proto=https;host="attacker.example"',
    "x-forwarded-for": "198.51.100.10, 198.51.100.11",
    "x-forwarded-host": "attacker.example",
    "x-forwarded-proto": "https",
    "x-real-ip": "198.51.100.13",
    "x-request-id": "attacker-selected-request-id",
  });
  assertEqual(spoofed.status, 200, "spoofed-header probe status");
  assertEqual(spoofed.body.clientIp, "127.0.0.1", "Fastify proxy-verified client address");
  assertEqual(spoofed.body.forwardedFor, "127.0.0.1", "overwritten forwarding chain");
  assertEqual(spoofed.body.forwardedHost, "127.0.0.1", "overwritten forwarded host");
  assertEqual(spoofed.body.realIp, "127.0.0.1", "overwritten real address");
  assertEqual(spoofed.body.forwardedProto, "http", "edge-derived forwarding protocol");
  assertEqual(spoofed.body.forwarded, null, "removed standardized forwarding metadata");
  assertEqual(spoofed.body.host, "127.0.0.1", "edge-derived upstream host");
  if (
    typeof spoofed.body.requestId !== "string" ||
    !/^[0-9a-f]{32}$/u.test(spoofed.body.requestId) ||
    spoofed.body.requestId === "attacker-selected-request-id"
  ) {
    throw new Error("edge request correlation was not generated independently");
  }
  assertSecurityHeaders(spoofed.headers, "proxied Fastify response");

  const routedReplicas = [spoofed.body.replica];
  for (let index = 0; index < 7; index += 1) {
    const response = await requestJson("/v1/edge-probe");
    assertEqual(response.status, 200, `Fastify route probe ${String(index + 2)} status`);
    routedReplicas.push(response.body.replica);
  }
  assertSetEqual(
    new Set(routedReplicas),
    new Set(["api-replica-1", "api-replica-2"]),
    "Nginx API upstream distribution",
  );

  const browserApi = await requestJson("/api/edge-probe", {
    forwarded: "for=198.51.100.21;proto=https;host=attacker.example",
    "x-forwarded-for": "198.51.100.22",
    "x-forwarded-host": "attacker.example",
    "x-forwarded-proto": "https",
    "x-real-ip": "198.51.100.23",
  });
  assertEqual(browserApi.status, 200, "browser API route status");
  assertEqual(browserApi.body.upstream, "web", "browser API route upstream");
  assertEqual(browserApi.body.path, "/api/edge-probe", "browser API path preservation");
  assertEqual(browserApi.body.forwardedFor, "127.0.0.1", "browser forwarding-chain overwrite");
  assertEqual(browserApi.body.forwardedHost, "127.0.0.1", "browser forwarded-host overwrite");
  assertEqual(browserApi.body.forwardedProto, "http", "browser forwarded-protocol overwrite");
  assertEqual(browserApi.body.forwarded, null, "browser standardized forwarding removal");
  assertEqual(browserApi.body.realIp, "127.0.0.1", "browser real-address overwrite");
  assertSecurityHeaders(browserApi.headers, "proxied browser API response");

  const syntheticAuthorizationCode = "synthetic-one-time-authorization-code";
  const syntheticAuthorizationState = "synthetic-authorization-state";
  const queryLogProbe = await requestJson(
    `/api/edge-probe?code=${syntheticAuthorizationCode}&state=${syntheticAuthorizationState}`,
  );
  assertEqual(queryLogProbe.status, 200, "query-bearing browser callback probe status");
  assertEqual(queryLogProbe.body.upstream, "web", "query-bearing browser callback probe upstream");

  const root = await requestJson("/", {
    forwarded: "for=198.51.100.31;proto=https;host=attacker.example",
    "x-forwarded-for": "198.51.100.32",
    "x-forwarded-host": "attacker.example",
    "x-forwarded-proto": "https",
    "x-real-ip": "198.51.100.33",
  });
  assertEqual(root.status, 200, "root route status");
  assertEqual(root.body.upstream, "web", "root route upstream");
  assertEqual(root.body.forwardedFor, "127.0.0.1", "root forwarding-chain overwrite");
  assertEqual(root.body.forwardedHost, "127.0.0.1", "root forwarded-host overwrite");
  assertEqual(root.body.forwardedProto, "http", "root forwarded-protocol overwrite");
  assertEqual(root.body.forwarded, null, "root standardized forwarding removal");
  assertEqual(root.body.realIp, "127.0.0.1", "root real-address overwrite");
  assertSecurityHeaders(root.headers, "proxied root response");

  const webRequestsBeforeOversize = webRequests;
  const oversized = await fetch(edgeUrl("/api/edge-probe"), {
    method: "POST",
    body: Buffer.alloc(12 * 1024 * 1024 + 1, 0x61),
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  const oversizedBody = await oversized.text();
  assertEqual(oversized.status, 413, "oversized request status");
  assertEqual(webRequests, webRequestsBeforeOversize, "oversized request upstream isolation");
  const oversizedUpstreamRequestsAdded = webRequests - webRequestsBeforeOversize;
  assertSecurityHeaders(oversized.headers, "oversized request response");
  assertNoVersionDisclosure(oversizedBody, oversized.headers);

  await stopChild(nginx);
  phaseOneOutput = nginx.output;
  const accessLog = await readFile(join(temporaryRoot, "access.log"), "utf8");
  if (
    accessLog.includes(syntheticAuthorizationCode) ||
    accessLog.includes(syntheticAuthorizationState) ||
    accessLog.includes("code=") ||
    accessLog.includes("state=")
  ) {
    throw new Error("edge access log retained synthetic OIDC callback query data");
  }
  const accessLogEntries = parseAccessLog(accessLog);
  const queryProbeEntries = accessLogEntries.filter(
    (entry) => entry.method === "GET" && entry.path === "/api/edge-probe" && entry.status === 200,
  );
  if (queryProbeEntries.length < 2) {
    throw new Error("edge access log did not record the query-free browser API probes");
  }
  nginx = startChild("nginx-phase-2", nginxBinary, [
    "-p",
    `${temporaryRoot}/`,
    "-c",
    runtimeConfigurationPath,
    "-g",
    "daemon off;",
  ]);
  await waitForEdge();

  const upstreamRequestsBeforeBurst = apiReplicas.reduce(
    (total, replica) => total + replica.requests,
    0,
  );
  const burstResponses = await Promise.all(
    Array.from({ length: 100 }, async (_value, index) => {
      const response = await fetch(edgeUrl("/v1/edge-probe"), {
        headers: {
          "x-forwarded-for": `198.51.100.${String((index % 200) + 1)}`,
          "x-real-ip": `203.0.113.${String((index % 200) + 1)}`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      return { status: response.status, headers: response.headers, body: await response.text() };
    }),
  );
  const admitted = burstResponses.filter((response) => response.status === 200);
  const rejected = burstResponses.filter((response) => response.status === 429);
  const unexpectedStatuses = burstResponses.filter(
    (response) => response.status !== 200 && response.status !== 429,
  );
  if (unexpectedStatuses.length > 0) {
    throw new Error(
      `edge burst returned unexpected statuses: ${JSON.stringify(
        unexpectedStatuses.map((response) => response.status),
      )}`,
    );
  }
  if (admitted.length < 41 || admitted.length > 50) {
    throw new Error(
      `edge burst admitted ${String(admitted.length)} requests; expected bounded 41–50 behavior`,
    );
  }
  assertEqual(rejected.length, 100 - admitted.length, "edge burst rejection count");
  const upstreamRequestsAfterBurst = apiReplicas.reduce(
    (total, replica) => total + replica.requests,
    0,
  );
  assertEqual(
    upstreamRequestsAfterBurst - upstreamRequestsBeforeBurst,
    admitted.length,
    "edge-rejected requests never reached an API replica",
  );
  if (apiReplicas.some((replica) => replica.requests === 0)) {
    throw new Error("the live edge did not distribute admitted requests across both API replicas");
  }
  const sampleRejected = rejected[0];
  if (!sampleRejected) throw new Error("edge burst produced no 429 response");
  assertSecurityHeaders(sampleRejected.headers, "edge rate-limit response");
  assertNoVersionDisclosure(sampleRejected.body, sampleRejected.headers);

  await stopChild(nginx);
  phaseTwoOutput = nginx.output;
  nginx = undefined;

  const evidence = {
    artifactVersion: 1,
    recordedAt: new Date().toISOString(),
    scope:
      "Reference Nginx query-free structured access logging, forwarding authority, routing, response controls, request ceiling, outer rate budget, and two-upstream distribution",
    sourceState: "uncommitted working tree; no repository commit exists",
    runtime: {
      nginxVersion,
      nginxBinarySha256,
      canonicalConfigurationSha256,
      loopbackOnly: true,
      apiReplicas: 2,
      fastifyProxyTrust: ["127.0.0.1"],
    },
    priorDefect: {
      directive: "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for",
      failureMode:
        "The public API edge preserved a client-selected forwarding prefix, allowing a client to select the address Fastify used for the distributed limiter; the catch-all web route also passed client forwarding metadata through unchanged.",
      correctedContract: [
        "proxy_set_header X-Real-IP $remote_addr",
        "proxy_set_header X-Forwarded-For $remote_addr",
        "proxy_set_header X-Forwarded-Host $host",
        "proxy_set_header X-Forwarded-Proto $scheme",
        'proxy_set_header Forwarded ""',
      ],
    },
    assertions: {
      canonicalConfigurationParsedByNginx: true,
      clientForwardingChainDiscarded: true,
      clientForwardedHostAndProtoOverwritten: true,
      standardizedForwardedHeaderRemoved: true,
      catchAllWebForwardingMetadataSanitized: true,
      fastifyResolvedObservedPeer: true,
      attackerRequestIdDiscarded: true,
      browserApiRoutedOnlyToWebBoundary: true,
      accessLogStructuredJson: true,
      accessLogQueryDataOmitted: true,
      accessLogCookieAuthorizationAndReferrerFieldsOmitted: true,
      versionedApiDistributedAcrossBothReplicas: true,
      pathPreserved: true,
      securityHeadersPresentOn200413And429: true,
      nginxVersionHidden: true,
      oversizedBodyRejectedBeforeUpstream: true,
      forgedForwardingAddressesDidNotSplitOuterBudget: true,
      rateLimitedRequestsDidNotReachUpstreams: true,
      nginxStoppedAfterVerification: true,
    },
    observations: {
      routedReplicaSequence: routedReplicas,
      spoofedHeaderProbe: {
        clientIp: spoofed.body.clientIp,
        forwarded: spoofed.body.forwarded,
        forwardedFor: spoofed.body.forwardedFor,
        forwardedHost: spoofed.body.forwardedHost,
        realIp: spoofed.body.realIp,
        forwardedProto: spoofed.body.forwardedProto,
        generatedRequestIdShape: "32 lowercase hexadecimal characters",
      },
      requestBodyCeiling: {
        configuredBytes: 12 * 1024 * 1024,
        attemptedBytes: 12 * 1024 * 1024 + 1,
        status: oversized.status,
        upstreamRequestsAdded: oversizedUpstreamRequestsAdded,
      },
      accessLog: {
        entriesParsed: accessLogEntries.length,
        fields: [
          "time",
          "request_id",
          "client_ip",
          "method",
          "path",
          "protocol",
          "status",
          "response_bytes",
          "request_seconds",
        ],
        queryBearingProbePathRecordedAs: "/api/edge-probe",
        syntheticAuthorizationCodeRecorded: false,
        syntheticAuthorizationStateRecorded: false,
        cookieAuthorizationAndReferrerFieldsConfigured: false,
      },
      outerBurst: {
        attempted: burstResponses.length,
        admitted: admitted.length,
        rejected: rejected.length,
        rejectedStatus: 429,
        distinctForgedForwardingAddresses: 100,
        upstreamRequestsAdded: upstreamRequestsAfterBurst - upstreamRequestsBeforeBurst,
      },
    },
    limitations: [
      "The verifier uses one host and loopback HTTP; it does not prove TLS, external load balancers, multi-host scheduling, or production network policy.",
      "Two real Fastify instances validate proxy-address semantics, but the full ReconAI API, Redis application limiter, authenticated routes, and Next.js runtime are not composed in this edge-only exercise.",
      "The observed burst is a bounded control test, not representative capacity, latency, availability, or denial-of-service resistance evidence.",
      "No customer payload, production credential, staging deployment, external alert, or hosted CI run is included.",
    ],
    credentialsRecorded: false,
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const diagnostics = [phaseOneOutput, phaseTwoOutput, nginx?.output ?? ""]
    .filter(Boolean)
    .map(sanitizedTail)
    .join("\n");
  process.stderr.write(`${sanitize(message)}${diagnostics ? `\n${diagnostics}\n` : "\n"}`);
  process.exitCode = 1;
} finally {
  if (nginx) await stopChild(nginx).catch(() => undefined);
  await Promise.all(apiReplicas.map((replica) => replica.app.close().catch(() => undefined)));
  if (webServer) await closeServer(webServer);
  await rm(temporaryRoot, { recursive: true, force: true });
}

function renderRuntimeConfiguration(source, ports) {
  let rendered = replaceExactlyOnce(
    source,
    "listen 8088;",
    `listen 127.0.0.1:${ports.edgePort.toString()};`,
  );
  rendered = replaceExactlyOnce(
    rendered,
    "server web:3000;",
    `server 127.0.0.1:${ports.webPort.toString()};`,
  );
  rendered = replaceExactlyOnce(
    rendered,
    "server api:4000;",
    [
      `server 127.0.0.1:${ports.apiReplicaOnePort.toString()};`,
      `  server 127.0.0.1:${ports.apiReplicaTwoPort.toString()};`,
    ].join("\n"),
  );
  rendered = replaceExactlyOnce(
    rendered,
    "access_log /var/log/nginx/access.log reconai_access;",
    `access_log ${ports.temporaryRoot}/access.log reconai_access;`,
  );
  return [
    "worker_processes 1;",
    `pid ${ports.temporaryRoot}/nginx.pid;`,
    `error_log ${ports.temporaryRoot}/error.log notice;`,
    "events { worker_connections 1024; }",
    "http {",
    `  client_body_temp_path ${ports.temporaryRoot}/client-body;`,
    `  proxy_temp_path ${ports.temporaryRoot}/proxy-temp;`,
    rendered,
    "}",
    "",
  ].join("\n");
}

function parseAccessLog(value) {
  const expectedKeys = [
    "client_ip",
    "method",
    "path",
    "protocol",
    "request_id",
    "request_seconds",
    "response_bytes",
    "status",
    "time",
  ];
  const lines = value.split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("edge access log is empty");

  return lines.map((line) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error("edge access log contains invalid JSON");
    }
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(expectedKeys) ||
      typeof entry.time !== "string" ||
      typeof entry.request_id !== "string" ||
      !/^[0-9a-f]{32}$/u.test(entry.request_id) ||
      entry.client_ip !== "127.0.0.1" ||
      typeof entry.method !== "string" ||
      typeof entry.path !== "string" ||
      entry.path.includes("?") ||
      typeof entry.protocol !== "string" ||
      !Number.isSafeInteger(entry.status) ||
      !Number.isSafeInteger(entry.response_bytes) ||
      typeof entry.request_seconds !== "number"
    ) {
      throw new Error("edge access log entry violates the bounded structured contract");
    }
    return entry;
  });
}

async function startApiReplica(label, port) {
  const app = Fastify({ logger: false, trustProxy: ["127.0.0.1"] });
  const replica = { label, app, requests: 0 };
  app.get("/v1/edge-probe", async (request) => {
    replica.requests += 1;
    return {
      replica: label,
      clientIp: request.ip,
      forwarded: request.headers.forwarded ?? null,
      forwardedFor: request.headers["x-forwarded-for"] ?? null,
      forwardedHost: request.headers["x-forwarded-host"] ?? null,
      forwardedProto: request.headers["x-forwarded-proto"] ?? null,
      host: request.headers.host ?? null,
      realIp: request.headers["x-real-ip"] ?? null,
      requestId: request.headers["x-request-id"] ?? null,
      path: request.url,
    };
  });
  await app.listen({ host: "127.0.0.1", port });
  return replica;
}

function startChild(label, command, arguments_) {
  const child = spawn(command, arguments_, {
    cwd: repositoryRoot,
    env: process.env,
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
    delay(5_000).then(() => false),
  ]);
  if (exited) return;
  try {
    process.kill(-record.child.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function runCommand(command, arguments_, environment, label) {
  const child = spawn(command, arguments_, {
    cwd: repositoryRoot,
    env: environment,
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
      `${label} failed (${result.signal ?? `exit ${String(result.code)}`}):\n${sanitizedTail(
        output,
      )}`,
    );
  }
  return output;
}

async function waitForEdge() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (nginx?.exited) throw new Error(`${nginx.label} exited before accepting traffic`);
    try {
      const response = await fetch(edgeUrl("/"), {
        redirect: "manual",
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 200) return;
    } catch {
      // A bounded retry is expected while the local edge starts.
    }
    await delay(100);
  }
  throw new Error("Nginx did not accept loopback traffic within the startup window");
}

async function requestJson(path, headers = {}) {
  const response = await fetch(edgeUrl(path), {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(2_000),
  });
  const rawBody = await response.text();
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = { invalidJson: true };
  }
  return { status: response.status, body, headers: response.headers };
}

function assertSecurityHeaders(headers, label) {
  const expected = {
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
  for (const [name, value] of Object.entries(expected)) {
    assertEqual(headers.get(name), value, `${label} ${name}`);
  }
}

function assertNoVersionDisclosure(body, headers) {
  assertEqual(headers.get("server"), "nginx", "Nginx server header fingerprint");
  if (/nginx\/[0-9]/iu.test(body)) {
    throw new Error("Nginx error response disclosed its runtime version");
  }
}

async function validatedNginxBinary(value) {
  if (!isAbsolute(value)) throw new Error("LIVE_EDGE_NGINX_BIN must be an absolute path");
  const resolved = await realpath(value);
  if (basename(resolved) !== "nginx") {
    throw new Error("LIVE_EDGE_NGINX_BIN must identify an executable named nginx");
  }
  const metadata = await stat(resolved);
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw new Error("LIVE_EDGE_NGINX_BIN must identify an executable file");
  }
  return resolved;
}

function assertSafeTemporaryPath(value) {
  if (!value.startsWith(`${tmpdir()}/reconai-live-edge.`)) {
    throw new Error("live edge temporary directory was outside the expected root");
  }
  if (!/^[A-Za-z0-9_./-]+$/u.test(value)) {
    throw new Error("live edge temporary path contained unsupported characters");
  }
}

function replaceExactlyOnce(source, expected, replacement) {
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`canonical Nginx configuration did not contain one exact ${expected}`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + expected.length)}`;
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

function boundedPort(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]{0,4}$/u.test(raw)) throw new Error(`${name} must be a valid TCP port`);
  const value = Number(raw);
  if (value > 65_535) throw new Error(`${name} must be a valid TCP port`);
  return value;
}

function assertDistinctPorts(ports) {
  if (new Set(ports).size !== ports.length) {
    throw new Error("live edge and upstream ports must be distinct");
  }
}

function edgeUrl(path) {
  return `http://127.0.0.1:${edgePort.toString()}${path}`;
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

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function assertSetEqual(actual, expected, label) {
  if (actual.size !== expected.size || [...actual].some((value) => !expected.has(value))) {
    throw new Error(
      `${label}: expected ${JSON.stringify([...expected])}, received ${JSON.stringify([
        ...actual,
      ])}`,
    );
  }
}

function sanitizedTail(value) {
  return sanitize(value).slice(-8_000);
}

function sanitize(value) {
  return String(value).replace(
    /\b(authorization|cookie|password|secret|token)=\S+/giu,
    "$1=<redacted>",
  );
}
