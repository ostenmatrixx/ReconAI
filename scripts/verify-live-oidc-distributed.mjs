import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URLSearchParams } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const requireFromWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));
const importedRedis = requireFromWeb("ioredis");
const Redis = importedRedis.default ?? importedRedis;
const { decode } = requireFromWeb("next-auth/jwt");
const { decodeJwt } = await import(requireFromWeb.resolve("jose"));
const importedPlaywright = await import(requireFromWeb.resolve("@playwright/test"));
const chromium = importedPlaywright.chromium ?? importedPlaywright.default?.chromium;
if (!chromium) throw new Error("Playwright Chromium runtime is unavailable");

const ports = {
  canonicalTls: 3040,
  firstDirectTls: 3041,
  secondDirectTls: 3042,
  firstWeb: 3301,
  secondWeb: 3302,
  keycloakTls: 58443,
  backchannelRelay: 58120,
  redis: 56379,
};
const canonicalOrigin = `https://127.0.0.1:${String(ports.canonicalTls)}`;
const directOrigins = [
  `https://127.0.0.1:${String(ports.firstDirectTls)}`,
  `https://127.0.0.1:${String(ports.secondDirectTls)}`,
];
const issuer = `https://127.0.0.1:${String(ports.keycloakTls)}/realms/reconai-development`;
const backchannelRelayUrl = `http://127.0.0.1:${String(ports.backchannelRelay)}/backchannel`;
const clientId = "reconai-web-development";
const environmentName = "live-oidc-dist";
const revocationNamespace = `reconai-${environmentName}-web-session-revocation-v1`;
const credentialFieldPattern =
  /(apiAccessToken|apiRefreshToken|apiIdToken|access_token|refresh_token|id_token)/u;

const runtimeDirectory = await requiredDirectory("OIDC_DISTRIBUTED_RUNTIME_DIR");
const keycloakHome = await requiredDirectory("OIDC_DISTRIBUTED_KEYCLOAK_HOME");
const javaHome = await requiredDirectory("OIDC_DISTRIBUTED_JAVA_HOME");
const redisServer = await requiredExecutable("OIDC_DISTRIBUTED_REDIS_SERVER");
const providerVersion = requiredEnvironment("OIDC_DISTRIBUTED_PROVIDER_VERSION");
const redisVersion = requiredEnvironment("OIDC_DISTRIBUTED_REDIS_VERSION");
const keycloakLauncher = await requiredExecutablePath(join(keycloakHome, "bin", "kc.sh"));
await requiredExecutablePath(join(javaHome, "bin", "java"));
const nextBuildId = resolve(repositoryRoot, "apps/web/.next/BUILD_ID");
await access(nextBuildId);

const stateDirectory = join(runtimeDirectory, "distributed-oidc-state");
const certificateDirectory = join(stateDirectory, "certificates");
const redisDataDirectory = join(stateDirectory, "redis-data");
const certificatePath = join(certificateDirectory, "loopback-cert.pem");
const privateKeyPath = join(certificateDirectory, "loopback-key.pem");
const opensslConfigurationPath = join(certificateDirectory, "openssl.cnf");
const redisConfigurationPath = join(stateDirectory, "redis.conf");
const realmImportDirectory = join(keycloakHome, "data", "import");
const realmImportPath = join(realmImportDirectory, "reconai-development-realm.json");

const sessionSecret = randomBytes(48).toString("base64url");
const clientSecret = randomBytes(32).toString("base64url");
const redisPassword = randomBytes(32).toString("base64url");
const adminPassword = randomBytes(32).toString("base64url");
const syntheticPassword = `Local-${randomBytes(24).toString("base64url")}!`;
const redisUrl = `redis://:${redisPassword}@127.0.0.1:${String(ports.redis)}`;

const childProcesses = [];
const servers = [];
let browser;
let primaryContext;
let unaffectedContext;
let laterContext;
let logoutContext;
let cleanupStarted = false;
let redisProcess;

const interruptHandler = () => {
  void cleanup("SIGINT");
};
const terminationHandler = () => {
  void cleanup("SIGTERM");
};
process.on("SIGINT", interruptHandler);
process.on("SIGTERM", terminationHandler);

try {
  await assertPortsAvailable(Object.values(ports));
  await prepareRuntimeFiles();

  redisProcess = startRedis("redis-initial");
  await waitForRedisReady(15_000);

  const backchannel = await startBackchannelRelay();
  servers.push(backchannel.server);

  const keycloak = startKeycloak();
  childProcesses.push(keycloak);
  await waitForHttpsStatus(
    `${issuer}/.well-known/openid-configuration`,
    certificatePath,
    [keycloak],
    90_000,
  );

  const webEnvironment = {
    ...process.env,
    NODE_ENV: "production",
    NODE_OPTIONS: mergeNodeOptions(process.env.NODE_OPTIONS, "--throw-deprecation"),
    NODE_EXTRA_CA_CERTS: certificatePath,
    APP_ENV: environmentName,
    WEB_ORIGIN: canonicalOrigin,
    NEXTAUTH_URL: canonicalOrigin,
    API_ORIGIN: canonicalOrigin,
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: clientId,
    OIDC_CLIENT_SECRET: clientSecret,
    OIDC_ID_TOKEN_SIGNING_ALGORITHM: "RS256",
    SESSION_SECRET: sessionSecret,
    SESSION_REVOCATION_STORE: "redis",
    SESSION_REVOCATION_REDIS_CONNECT_TIMEOUT_MS: "1000",
    SESSION_REVOCATION_REDIS_COMMAND_TIMEOUT_MS: "1000",
    REDIS_URL: redisUrl,
    LOG_LEVEL: "error",
  };
  const firstWeb = startChild(
    "web-replica-one",
    "pnpm",
    [
      "--filter",
      "@workspace/web",
      "exec",
      "next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(ports.firstWeb),
    ],
    webEnvironment,
  );
  const secondWeb = startChild(
    "web-replica-two",
    "pnpm",
    [
      "--filter",
      "@workspace/web",
      "exec",
      "next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(ports.secondWeb),
    ],
    webEnvironment,
  );
  childProcesses.push(firstWeb, secondWeb);
  await Promise.all([
    waitForHttpStatus(`http://127.0.0.1:${String(ports.firstWeb)}/`, [firstWeb], 60_000),
    waitForHttpStatus(`http://127.0.0.1:${String(ports.secondWeb)}/`, [secondWeb], 60_000),
  ]);

  const tls = await readTlsMaterial();
  const canonicalProxy = createTlsProxy({
    tls,
    listenPort: ports.canonicalTls,
    upstreamPorts: [ports.firstWeb, ports.secondWeb],
    canonicalHost: `127.0.0.1:${String(ports.canonicalTls)}`,
  });
  const firstDirectProxy = createTlsProxy({
    tls,
    listenPort: ports.firstDirectTls,
    upstreamPorts: [ports.firstWeb],
    canonicalHost: `127.0.0.1:${String(ports.canonicalTls)}`,
  });
  const secondDirectProxy = createTlsProxy({
    tls,
    listenPort: ports.secondDirectTls,
    upstreamPorts: [ports.secondWeb],
    canonicalHost: `127.0.0.1:${String(ports.canonicalTls)}`,
  });
  servers.push(canonicalProxy.server, firstDirectProxy.server, secondDirectProxy.server);
  await Promise.all([
    listen(canonicalProxy.server, ports.canonicalTls),
    listen(firstDirectProxy.server, ports.firstDirectTls),
    listen(secondDirectProxy.server, ports.secondDirectTls),
  ]);

  browser = await chromium.launch({ headless: true });
  primaryContext = await newBrowserContext(browser);
  unaffectedContext = await newBrowserContext(browser);

  const fixture = await readSyntheticFixture();
  const primaryPage = await primaryContext.newPage();
  await completeLogin(primaryPage, fixture.username, syntheticPassword);
  const primaryBrowserCookies = await primaryContext.cookies();
  const primaryCookies = await readSessionCookies(primaryContext);
  const primaryToken = await decodeSessionCookie(primaryCookies);

  const unaffectedPage = await unaffectedContext.newPage();
  await completeLogin(unaffectedPage, fixture.username, syntheticPassword);
  const unaffectedCookies = await readSessionCookies(unaffectedContext);
  const unaffectedToken = await decodeSessionCookie(unaffectedCookies);
  assert(
    primaryToken.apiOidcSessionId &&
      unaffectedToken.apiOidcSessionId &&
      primaryToken.apiOidcSessionId !== unaffectedToken.apiOidcSessionId,
    "the two provider sessions did not receive distinct sid values",
  );

  const primaryBeforeLogout = await sessionAcrossReplicas(browser, primaryCookies);
  const unaffectedBeforeLogout = await sessionAcrossReplicas(browser, unaffectedCookies);
  assertSessions(primaryBeforeLogout, false, "primary session before logout");
  assertSessions(unaffectedBeforeLogout, false, "unaffected session before logout");

  const providerLogoutRequests = [];
  logoutContext = await newBrowserContext(browser);
  await logoutContext.addCookies(primaryBrowserCookies);
  const logoutPage = await logoutContext.newPage();
  logoutPage.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === new URL(issuer).origin && url.pathname.endsWith("/logout")) {
      providerLogoutRequests.push({
        clientMatched: url.searchParams.get("client_id") === clientId,
        idTokenHintPresent: (url.searchParams.get("id_token_hint")?.length ?? 0) > 0,
        returnMatched: url.searchParams.get("post_logout_redirect_uri") === `${canonicalOrigin}/`,
      });
    }
  });
  await logoutPage.goto(`${canonicalOrigin}/dashboard`);
  await logoutPage.getByRole("button", { name: "Sign out" }).click();
  await logoutPage.waitForURL((url) => url.origin === canonicalOrigin && url.pathname === "/", {
    timeout: 30_000,
  });
  await logoutPage.getByRole("button", { name: "Sign in securely" }).waitFor();
  await waitFor(() => backchannel.deliveries.length >= 1, 15_000);
  assert(
    providerLogoutRequests.length === 1 &&
      providerLogoutRequests[0].clientMatched &&
      providerLogoutRequests[0].idTokenHintPresent &&
      providerLogoutRequests[0].returnMatched,
    "the RP-initiated provider logout request violated its fixed contract",
  );
  assert(backchannel.deliveries.length === 1, "Keycloak delivered an unexpected logout count");
  const capturedDelivery = backchannel.deliveries[0];
  assert(capturedDelivery.upstreamStatus === 200, "the first back-channel delivery did not pass");
  const capturedLogoutToken = new URLSearchParams(capturedDelivery.body).get("logout_token");
  assert(capturedLogoutToken, "the captured delivery had no logout token");
  const logoutClaims = decodeJwt(capturedLogoutToken);

  const primaryAfterLogout = await sessionAcrossReplicas(browser, primaryCookies);
  const unaffectedAfterLogout = await sessionAcrossReplicas(browser, unaffectedCookies);
  assertSessions(primaryAfterLogout, true, "targeted session after logout");
  assertSessions(unaffectedAfterLogout, false, "unaffected session after targeted logout");

  const replayBeforeOutage = await postCapturedLogout(
    browser,
    directOrigins[1],
    capturedDelivery.body,
  );
  assert(replayBeforeOutage === 200, "a healthy cross-replica replay did not remain idempotent");

  const keysBeforeOutage = await inspectRevocationKeys([
    primaryToken.apiOidcSubject,
    primaryToken.apiOidcSessionId,
    logoutClaims.jti,
  ]);
  await forceRedisSnapshot();
  await stopChild(redisProcess, "SIGKILL");
  await waitForPortClosed("127.0.0.1", ports.redis, 10_000);

  const unaffectedDuringOutage = await sessionAcrossReplicas(browser, unaffectedCookies);
  assertSessions(unaffectedDuringOutage, true, "unaffected session during Redis outage");
  const livenessDuringOutage = await anonymousRootAcrossReplicas(browser);
  assert(
    livenessDuringOutage.every((status) => status === 200),
    "web process liveness failed during the Redis outage",
  );
  const logoutDuringOutage = await postCapturedLogout(
    browser,
    directOrigins[1],
    capturedDelivery.body,
  );
  assert(
    logoutDuringOutage === 400,
    "logout incorrectly reported success while Redis was unavailable",
  );

  redisProcess = startRedis("redis-recovered");
  await waitForRedisReady(15_000);
  await waitFor(async () => {
    const sessions = await sessionAcrossReplicas(browser, unaffectedCookies);
    return sessions.every((session) => !session.reauthenticationRequired);
  }, 15_000);

  const primaryAfterRecovery = await sessionAcrossReplicas(browser, primaryCookies);
  const unaffectedAfterRecovery = await sessionAcrossReplicas(browser, unaffectedCookies);
  assertSessions(primaryAfterRecovery, true, "targeted session after Redis recovery");
  assertSessions(unaffectedAfterRecovery, false, "unaffected session after Redis recovery");
  const replayAfterRecovery = await postCapturedLogout(
    browser,
    directOrigins[1],
    capturedDelivery.body,
  );
  assert(replayAfterRecovery === 200, "the durable replay marker did not recover");
  const keysAfterRecovery = await inspectRevocationKeys([
    primaryToken.apiOidcSubject,
    primaryToken.apiOidcSessionId,
    logoutClaims.jti,
  ]);
  assertJsonEqual(
    keysAfterRecovery.shape,
    keysBeforeOutage.shape,
    "Redis key shape after recovery",
  );

  laterContext = await newBrowserContext(browser);
  const laterPage = await laterContext.newPage();
  await completeLogin(laterPage, fixture.username, syntheticPassword);
  const laterCookies = await readSessionCookies(laterContext);
  const laterToken = await decodeSessionCookie(laterCookies);
  const laterSession = await sessionAcrossReplicas(browser, laterCookies);
  assertSessions(laterSession, false, "later login after recovery");
  assert(
    laterToken.apiOidcSessionId && laterToken.apiOidcSessionId !== primaryToken.apiOidcSessionId,
    "the later login did not receive a new provider session",
  );

  const allProcessesHealthy = await Promise.all([
    httpsStatus(`${directOrigins[0]}/`, certificatePath),
    httpsStatus(`${directOrigins[1]}/`, certificatePath),
    httpsStatus(`${issuer}/.well-known/openid-configuration`, certificatePath),
  ]);
  assert(
    allProcessesHealthy.every((status) => status === 200),
    "one or more runtime processes stopped responding after the exercise",
  );
  assert(
    canonicalProxy.requestCounts.every((count) => count > 0),
    "the canonical proxy did not route requests to both web replicas",
  );

  const sourceHashes = Object.fromEntries(
    await Promise.all(
      [
        "scripts/verify-live-oidc-distributed.mjs",
        "apps/web/src/auth.ts",
        "apps/web/src/oidc-backchannel-logout.ts",
        "apps/web/src/session-revocation.ts",
        "apps/web/src/server-session.ts",
        "pnpm-lock.yaml",
        "patches/openid-client@5.7.1.patch",
      ].map(async (relativePath) => [
        relativePath,
        createHash("sha256")
          .update(await readFile(resolve(repositoryRoot, relativePath)))
          .digest("hex"),
      ]),
    ),
  );

  const result = {
    schemaVersion: "reconai-live-oidc-distributed-v1",
    completedAt: new Date().toISOString(),
    status: "local_pass_real_keycloak_two_nextjs_replicas_shared_redis_failure_and_recovery",
    productionReadinessClaim: false,
    runtime: {
      identityProvider: `Keycloak ${providerVersion}`,
      redis: `Redis ${redisVersion}`,
      application: "two production-built Next.js 16.2.12 processes started with next start",
      topology: {
        webReplicaCount: 2,
        canonicalTlsProxyCount: 1,
        directTlsProbeProxyCount: 2,
        backchannelReceiverReplica: 1,
        sharedRedisAuthority: true,
      },
      transport:
        "ephemeral self-signed loopback TLS for browser/OIDC traffic; loopback HTTP relay for Keycloak back-channel delivery",
      data: "synthetic repository identity fixture only",
    },
    assertions: {
      distinctProviderSessionsForOneSubject:
        primaryToken.apiOidcSessionId !== unaffectedToken.apiOidcSessionId,
      bothSessionsInitiallyAcceptedByBothReplicas: true,
      signedKeycloakBackchannelDeliveries: backchannel.deliveries.length,
      firstBackchannelDeliveryStatus: capturedDelivery.upstreamStatus,
      providerLogoutRequestObserved: providerLogoutRequests.length > 0,
      providerLogoutRequestContract:
        providerLogoutRequests.length === 1 &&
        providerLogoutRequests[0].clientMatched &&
        providerLogoutRequests[0].idTokenHintPresent &&
        providerLogoutRequests[0].returnMatched,
      targetedOldCookieRejectedByBothReplicas: true,
      differentSidForSameSubjectAcceptedByBothReplicas: true,
      crossReplicaReplayStatusBeforeOutage: replayBeforeOutage,
      redisKeysBeforeOutage: keysBeforeOutage,
      redisAbruptStopSignal: "SIGKILL",
      unaffectedCookieFailedClosedOnBothReplicasDuringOutage: true,
      anonymousWebLivenessStatusesDuringOutage: livenessDuringOutage,
      logoutStatusDuringRedisOutage: logoutDuringOutage,
      persistentRedisRestartCompleted: true,
      targetedOldCookieStillRejectedByBothReplicasAfterRecovery: true,
      unaffectedCookieAcceptedByBothReplicasAfterRecovery: true,
      crossReplicaReplayStatusAfterRecovery: replayAfterRecovery,
      redisKeysAfterRecovery: keysAfterRecovery,
      laterLoginAcceptedByBothReplicas: true,
      laterLoginReceivedDifferentSid: laterToken.apiOidcSessionId !== primaryToken.apiOidcSessionId,
      canonicalProxyUpstreamRequestCounts: canonicalProxy.requestCounts,
      directProxyUpstreamRequestCounts: [
        firstDirectProxy.requestCounts[0],
        secondDirectProxy.requestCounts[0],
      ],
      processesResponsiveAfterExercise: true,
    },
    credentialHandling: {
      providerTokensDecodedOnlyInVerifierMemory: true,
      capturedLogoutTokenRetainedOnlyInVerifierMemory: true,
      rawCookieRecorded: false,
      rawLogoutTokenRecorded: false,
      rawSubjectOrSidRecorded: false,
      rawRedisKeyRecorded: false,
      redisPasswordRecorded: false,
      oidcClientSecretRecorded: false,
      syntheticPasswordRecorded: false,
      childProcessOutputRecorded: false,
    },
    sourceSha256: sourceHashes,
    limitations: [
      "This is an isolated single-host synthetic loopback exercise, not protected staging, multi-host, external IdP, managed Redis, production ingress, compliance, penetration-test, or production-readiness evidence.",
      "Ephemeral self-signed loopback TLS terminates in verifier-owned Node proxies; it does not prove the deployable Nginx policy or an external load balancer, CDN, certificate, collector, or network policy.",
      "Keycloak delivered the signed Logout Token through a loopback HTTP relay that retained it only in process memory for bounded replay and outage assertions; production back-channel transport must use the exact approved HTTPS route.",
      "The exercise covers one abrupt Redis process loss and persistent restart. It does not prove managed failover, cross-host partitions, Sentinel/Cluster behavior, alert delivery, clock boundaries, or coordinated SESSION_SECRET/provider-signing-key rotation.",
      "No raw provider credential, browser cookie, logout token, authorization code, state, PKCE value, Redis credential/key, password, subject, or session identifier is emitted.",
    ],
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await cleanup();
}

async function prepareRuntimeFiles() {
  await mkdir(certificateDirectory, { recursive: true });
  await mkdir(redisDataDirectory, { recursive: true });
  await mkdir(realmImportDirectory, { recursive: true });
  await writeFile(
    opensslConfigurationPath,
    [
      "[req]",
      "distinguished_name = distinguished_name",
      "x509_extensions = certificate_extensions",
      "prompt = no",
      "",
      "[distinguished_name]",
      "CN = 127.0.0.1",
      "",
      "[certificate_extensions]",
      "subjectAltName = @alternative_names",
      "basicConstraints = critical,CA:TRUE",
      "keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign",
      "extendedKeyUsage = serverAuth",
      "",
      "[alternative_names]",
      "IP.1 = 127.0.0.1",
      "DNS.1 = localhost",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await runCommand("openssl", [
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
    opensslConfigurationPath,
  ]);

  const realm = JSON.parse(
    await readFile(
      resolve(repositoryRoot, "infra/keycloak/reconai-development-realm.json"),
      "utf8",
    ),
  );
  realm.accessTokenLifespan = 300;
  realm.revokeRefreshToken = true;
  realm.refreshTokenMaxReuse = 0;
  const client = realm.clients?.find((candidate) => candidate.clientId === clientId);
  assert(client, "the synthetic Keycloak client fixture is missing");
  client.secret = clientSecret;
  client.redirectUris = [`${canonicalOrigin}/api/auth/callback/keycloak`];
  client.webOrigins = [canonicalOrigin];
  client.attributes = {
    ...client.attributes,
    "post.logout.redirect.uris": `${canonicalOrigin}/`,
    "backchannel.logout.url": backchannelRelayUrl,
    "backchannel.logout.session.required": "true",
  };
  const user = realm.users?.find((candidate) => candidate.username === "owner@example.test");
  assert(user, "the synthetic Keycloak user fixture is missing");
  user.credentials = [
    {
      type: "password",
      value: syntheticPassword,
      temporary: false,
    },
  ];
  await writeFile(realmImportPath, `${JSON.stringify(realm, null, 2)}\n`, { mode: 0o600 });

  await writeFile(
    redisConfigurationPath,
    [
      "bind 127.0.0.1",
      `port ${String(ports.redis)}`,
      "protected-mode yes",
      "daemonize no",
      'save ""',
      "appendonly yes",
      "appendfsync always",
      `dir ${redisDataDirectory}`,
      `requirepass ${redisPassword}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

function startRedis(label) {
  const child = startChild(label, redisServer, [redisConfigurationPath], process.env);
  childProcesses.push(child);
  return child;
}

function startKeycloak() {
  return startChild(
    "keycloak",
    keycloakLauncher,
    [
      "start-dev",
      "--import-realm",
      "--http-enabled=false",
      `--https-port=${String(ports.keycloakTls)}`,
      `--https-certificate-file=${certificatePath}`,
      `--https-certificate-key-file=${privateKeyPath}`,
      `--hostname=https://127.0.0.1:${String(ports.keycloakTls)}`,
      "--health-enabled=true",
    ],
    {
      ...process.env,
      JAVA_HOME: javaHome,
      KC_BOOTSTRAP_ADMIN_USERNAME: "local-admin",
      KC_BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      KC_DB: "dev-file",
      KC_CACHE: "local",
    },
  );
}

async function startBackchannelRelay() {
  const deliveries = [];
  const server = createHttpServer(async (request, response) => {
    try {
      if (
        request.method !== "POST" ||
        request.url !== "/backchannel" ||
        request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !==
          "application/x-www-form-urlencoded"
      ) {
        response.writeHead(404, { "cache-control": "no-store" });
        response.end();
        return;
      }
      const body = await readBoundedRequestBody(request, 36 * 1024);
      const upstream = await fetch(
        `http://127.0.0.1:${String(ports.firstWeb)}/api/auth/backchannel-logout`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      deliveries.push({ body, upstreamStatus: upstream.status });
      response.writeHead(upstream.status, {
        "cache-control": "no-store, private",
        pragma: "no-cache",
      });
      response.end();
    } catch {
      response.writeHead(502, { "cache-control": "no-store" });
      response.end();
    }
  });
  await listen(server, ports.backchannelRelay);
  return { server, deliveries };
}

function createTlsProxy({ tls, listenPort, upstreamPorts, canonicalHost }) {
  const requestCounts = upstreamPorts.map(() => 0);
  let cursor = 0;
  const server = createHttpsServer(tls, (request, response) => {
    const upstreamIndex = cursor % upstreamPorts.length;
    cursor += 1;
    requestCounts[upstreamIndex] += 1;
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
    headers.host = canonicalHost;
    headers["x-forwarded-for"] = request.socket.remoteAddress ?? "127.0.0.1";
    headers["x-forwarded-host"] = canonicalHost;
    headers["x-forwarded-port"] = String(listenPort);
    headers["x-forwarded-proto"] = "https";

    const upstreamRequest = httpRequest(
      {
        hostname: "127.0.0.1",
        port: upstreamPorts[upstreamIndex],
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
    upstreamRequest.on("error", () => {
      if (!response.headersSent) response.writeHead(502, { "cache-control": "no-store" });
      response.end();
    });
    request.pipe(upstreamRequest);
  });
  return { server, requestCounts };
}

async function completeLogin(page, username, password) {
  await page.goto(canonicalOrigin);
  await page.getByRole("button", { name: "Sign in securely" }).click();
  await page.waitForURL((url) => url.origin === new URL(issuer).origin, { timeout: 30_000 });
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await page.waitForURL((url) => url.origin === canonicalOrigin && url.pathname === "/dashboard", {
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Sign out" }).waitFor();
}

async function readSessionCookies(context) {
  const cookies = (await context.cookies(canonicalOrigin))
    .filter(
      ({ name }) =>
        name === "__Secure-reconai.session-token" ||
        /^__Secure-reconai\.session-token\.[0-9]+$/u.test(name),
    )
    .sort((left, right) => cookieChunkIndex(left.name) - cookieChunkIndex(right.name));
  assert(cookies.length > 0, "the encrypted production session cookie is missing");
  assert(
    cookies.every(({ httpOnly }) => httpOnly),
    "a session cookie was not HttpOnly",
  );
  assert(
    cookies.every(({ secure }) => secure),
    "a session cookie was not Secure",
  );
  assert(
    cookies.every(({ sameSite }) => sameSite === "Lax"),
    "a session cookie was not SameSite=Lax",
  );
  const chunkIndexes = cookies.map(({ name }) => cookieChunkIndex(name));
  if (cookies.length > 1) {
    assert(
      chunkIndexes.every((index, position) => index === position),
      "the encrypted session cookie chunks were not continuous",
    );
  }
  return cookies;
}

async function decodeSessionCookie(cookies) {
  const token = cookies.map(({ value }) => value).join("");
  const decoded = await decode({ token, secret: sessionSecret });
  assert(decoded, "the verifier could not decode its synthetic encrypted session");
  assert(
    typeof decoded.apiOidcSubject === "string" && decoded.apiOidcSubject.length > 0,
    "the encrypted session had no provider subject",
  );
  return decoded;
}

async function sessionAcrossReplicas(activeBrowser, cookies) {
  return Promise.all(
    directOrigins.map(async (origin) => {
      const context = await newBrowserContext(activeBrowser);
      try {
        await context.addCookies(cookies);
        const response = await context.request.get(`${origin}/api/auth/session`);
        const text = await response.text();
        assert(
          !credentialFieldPattern.test(text),
          "the session response disclosed a provider credential",
        );
        const body = JSON.parse(text);
        return {
          status: response.status(),
          reauthenticationRequired: body.reauthenticationRequired === true,
          credentialDisclosure: false,
        };
      } finally {
        await context.close();
      }
    }),
  );
}

function assertSessions(sessions, expectedReauthentication, label) {
  assert(sessions.length === 2, `${label} did not exercise two replicas`);
  for (const session of sessions) {
    assert(session.status === 200, `${label} returned a non-success session response`);
    assert(
      session.reauthenticationRequired === expectedReauthentication,
      `${label} had the wrong reauthentication result`,
    );
    assert(!session.credentialDisclosure, `${label} disclosed a provider credential`);
  }
}

async function postCapturedLogout(activeBrowser, origin, body) {
  const context = await newBrowserContext(activeBrowser);
  try {
    const response = await context.request.post(`${origin}/api/auth/backchannel-logout`, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: body,
    });
    const responseBody = await response.body();
    assert(responseBody.byteLength === 0, "the back-channel response echoed data");
    return response.status();
  } finally {
    await context.close();
  }
}

async function anonymousRootAcrossReplicas(activeBrowser) {
  return Promise.all(
    directOrigins.map(async (origin) => {
      const context = await newBrowserContext(activeBrowser);
      try {
        return (await context.request.get(`${origin}/`)).status();
      } finally {
        await context.close();
      }
    }),
  );
}

async function inspectRevocationKeys(rawIdentifiers) {
  const redis = redisClient("reconai-live-oidc-distributed-inspection");
  try {
    await redis.connect();
    const keys = [];
    let cursor = "0";
    do {
      const [next, page] = await redis.scan(
        cursor,
        "MATCH",
        `${revocationNamespace}:*`,
        "COUNT",
        100,
      );
      cursor = next;
      keys.push(...page);
      assert(keys.length <= 10, "the revocation namespace contained too many keys");
    } while (cursor !== "0");
    keys.sort((left, right) => left.localeCompare(right, "en"));
    assert(keys.length === 2, "the revocation namespace did not contain exactly two keys");
    const shape = [];
    const ttlSeconds = [];
    for (const key of keys) {
      const match = key.match(
        new RegExp(`^${revocationNamespace}:(replay|sid):([a-f0-9]{64})$`, "u"),
      );
      assert(match, "a Redis revocation key violated the pseudonymous shape");
      for (const rawIdentifier of rawIdentifiers) {
        if (typeof rawIdentifier === "string" && rawIdentifier.length > 0) {
          assert(!key.includes(rawIdentifier), "a Redis key contained a raw provider identifier");
        }
      }
      const ttl = await redis.ttl(key);
      assert(ttl > 0, "a Redis revocation key had no positive TTL");
      shape.push(match[1]);
      ttlSeconds.push(ttl);
    }
    return {
      count: keys.length,
      shape: shape.sort((left, right) => left.localeCompare(right, "en")),
      allIndexesAre64Hex: true,
      rawIdentifierPresent: false,
      allTtlsPositive: true,
      minimumTtlSeconds: Math.min(...ttlSeconds),
    };
  } finally {
    if (redis.status === "ready") await redis.quit();
    else redis.disconnect();
  }
}

async function forceRedisSnapshot() {
  const redis = redisClient("reconai-live-oidc-distributed-snapshot");
  try {
    await redis.connect();
    await redis.save();
  } finally {
    if (redis.status === "ready") await redis.quit();
    else redis.disconnect();
  }
}

function redisClient(connectionName) {
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
    commandTimeout: 1_000,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    lazyConnect: true,
    connectionName,
  });
  redis.on("error", () => undefined);
  return redis;
}

async function waitForRedisReady(timeoutMilliseconds) {
  await waitFor(async () => {
    const redis = redisClient("reconai-live-oidc-distributed-readiness");
    try {
      await redis.connect();
      return (await redis.ping()) === "PONG";
    } catch {
      return false;
    } finally {
      if (redis.status === "ready") await redis.quit();
      else redis.disconnect();
    }
  }, timeoutMilliseconds);
}

async function readSyntheticFixture() {
  const realm = JSON.parse(
    await readFile(
      resolve(repositoryRoot, "infra/keycloak/reconai-development-realm.json"),
      "utf8",
    ),
  );
  const user = realm.users?.find((candidate) => candidate.username === "owner@example.test");
  assert(user?.username, "the synthetic owner fixture is incomplete");
  return { username: user.username };
}

async function readTlsMaterial() {
  return {
    cert: await readFile(certificatePath),
    key: await readFile(privateKeyPath),
  };
}

async function newBrowserContext(activeBrowser) {
  const context = await activeBrowser.newContext({ ignoreHTTPSErrors: true });
  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(30_000);
  return context;
}

function startChild(label, command, arguments_, environment) {
  const child = spawn(command, arguments_, {
    cwd: repositoryRoot,
    env: environment,
    detached: true,
    shell: false,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const record = { label, child, exited: false, exitCode: undefined, signal: undefined };
  child.once("exit", (code, signal) => {
    record.exited = true;
    record.exitCode = code;
    record.signal = signal ?? undefined;
  });
  child.once("error", () => {
    record.exited = true;
  });
  return record;
}

async function stopChild(record, signal = "SIGTERM") {
  if (!record || record.exited || !record.child.pid) return;
  try {
    process.kill(-record.child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await waitFor(() => record.exited, signal === "SIGKILL" ? 5_000 : 8_000).catch(async () => {
    if (signal !== "SIGKILL" && !record.exited && record.child.pid) {
      try {
        process.kill(-record.child.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
      await waitFor(() => record.exited, 5_000);
    }
  });
}

async function cleanup(signal) {
  if (cleanupStarted) return;
  cleanupStarted = true;
  process.off("SIGINT", interruptHandler);
  process.off("SIGTERM", terminationHandler);
  for (const context of [laterContext, logoutContext, unaffectedContext, primaryContext]) {
    await context?.close().catch(() => undefined);
  }
  await browser?.close().catch(() => undefined);
  await Promise.all(servers.map((server) => closeServer(server)));
  for (const child of [...childProcesses].reverse()) {
    await stopChild(child).catch(() => undefined);
  }
  if (signal) process.kill(process.pid, signal);
}

async function runCommand(command, arguments_) {
  const child = spawn(command, arguments_, {
    cwd: runtimeDirectory,
    env: process.env,
    shell: false,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const result = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(`${command} failed while preparing the isolated runtime`);
  }
}

async function waitForHttpStatus(url, children, timeoutMilliseconds) {
  await waitFor(async () => {
    assertChildrenRunning(children);
    try {
      return (await httpStatus(url)) === 200;
    } catch {
      return false;
    }
  }, timeoutMilliseconds);
}

async function waitForHttpsStatus(url, caPath, children, timeoutMilliseconds) {
  await waitFor(async () => {
    assertChildrenRunning(children);
    try {
      return (await httpsStatus(url, caPath)) === 200;
    } catch {
      return false;
    }
  }, timeoutMilliseconds);
}

function httpStatus(url) {
  return new Promise((resolveStatus, reject) => {
    const request = httpRequest(url, { method: "GET", timeout: 2_000 }, (response) => {
      response.resume();
      resolveStatus(response.statusCode ?? 0);
    });
    request.once("timeout", () => request.destroy(new Error("HTTP readiness timed out")));
    request.once("error", reject);
    request.end();
  });
}

async function httpsStatus(url, caPath) {
  const ca = await readFile(caPath);
  return new Promise((resolveStatus, reject) => {
    const request = httpsRequest(
      url,
      { method: "GET", timeout: 2_000, ca, rejectUnauthorized: true },
      (response) => {
        response.resume();
        resolveStatus(response.statusCode ?? 0);
      },
    );
    request.once("timeout", () => request.destroy(new Error("HTTPS readiness timed out")));
    request.once("error", reject);
    request.end();
  });
}

async function waitFor(check, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  if (lastError) throw lastError;
  throw new Error(`condition did not pass within ${String(timeoutMilliseconds)} ms`);
}

function assertChildrenRunning(children) {
  const failed = children.find((record) => record.exited);
  if (failed) {
    throw new Error(`${failed.label} exited before readiness`);
  }
}

async function assertPortsAvailable(portValues) {
  await Promise.all(
    portValues.map(async (port) => {
      if (await portOpen("127.0.0.1", port)) {
        throw new Error(`required loopback port ${String(port)} is already in use`);
      }
    }),
  );
}

function portOpen(host, port) {
  return new Promise((resolveOpen) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(250);
    socket.once("connect", () => {
      socket.destroy();
      resolveOpen(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolveOpen(false);
    });
    socket.once("error", () => resolveOpen(false));
  });
}

async function waitForPortClosed(host, port, timeoutMilliseconds) {
  await waitFor(async () => !(await portOpen(host, port)), timeoutMilliseconds);
}

function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
    server.closeAllConnections?.();
  });
}

async function readBoundedRequestBody(request, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maximumBytes) throw new Error("request body exceeded its limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function cookieChunkIndex(name) {
  if (name === "__Secure-reconai.session-token") return 0;
  const match = name.match(/\.([0-9]+)$/u);
  assert(match, "the session cookie name is malformed");
  return Number(match[1]);
}

function mergeNodeOptions(existing, required) {
  const values = new Set((existing ?? "").split(/\s+/u).filter(Boolean));
  values.add(required);
  return [...values].join(" ");
}

async function requiredDirectory(name) {
  const value = requiredEnvironment(name);
  const canonical = await realpath(value);
  const details = await stat(canonical);
  if (!details.isDirectory()) throw new Error(`${name} must reference a directory`);
  return canonical;
}

async function requiredExecutable(name) {
  return requiredExecutablePath(requiredEnvironment(name));
}

async function requiredExecutablePath(value) {
  const canonical = await realpath(value);
  await access(canonical);
  return canonical;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertJsonEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} did not match`);
  }
}
