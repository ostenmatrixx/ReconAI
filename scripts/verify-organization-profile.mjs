import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const requireFromWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));
const postgres = (await import(requireFromApi.resolve("postgres"))).default;
const playwright = await import(requireFromWeb.resolve("@playwright/test"));
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (!chromium) throw new Error("Playwright Chromium runtime is unavailable");

const postgresBin = await requiredDirectory("LIVE_POSTGRES_BIN");
const runtimeRoot = process.env["LIVE_RUNTIME_ROOT"] ?? "/tmp";
const runtime = await mkdtemp(join(runtimeRoot, "reconai-organization-profile-"));
const postgresData = join(runtime, "postgres");
const postgresSocket = join(runtime, "postgres-socket");
const artifactPath = join(
  repositoryRoot,
  "artifacts",
  "organization-profile-concurrent-api-verification-2026-07-30.json",
);
const passwords = {
  administrator: randomBytes(24).toString("base64url"),
  migrator: randomBytes(24).toString("base64url"),
  application: randomBytes(24).toString("base64url"),
  worker: randomBytes(24).toString("base64url"),
  maintenance: randomBytes(24).toString("base64url"),
};
const secrets = Object.values(passwords);
let postgresStarted = false;
let inspectionDatabase;
let restrictedDatabase;
let browser;
let cleanupStarted = false;

const terminate = () => {
  void cleanup().finally(() => {
    process.exitCode = 130;
  });
};
process.on("SIGINT", terminate);
process.on("SIGTERM", terminate);

try {
  const postgresPort = await availablePort();
  const adminDatabaseUrl =
    `postgresql://postgres:${passwords.administrator}` +
    `@127.0.0.1:${String(postgresPort)}/reconai`;
  const migrationDatabaseUrl =
    `postgresql://reconai_migrator:${passwords.migrator}` +
    `@127.0.0.1:${String(postgresPort)}/reconai`;
  const applicationDatabaseUrl =
    `postgresql://reconai_app:${passwords.application}` +
    `@127.0.0.1:${String(postgresPort)}/reconai`;
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    APP_ENV: "organization-profile-verification",
    DATABASE_ADMIN_URL: adminDatabaseUrl,
    DATABASE_MIGRATION_URL: migrationDatabaseUrl,
    DATABASE_URL: applicationDatabaseUrl,
    LOG_LEVEL: "error",
  };

  await startPostgres(postgresPort);
  postgresStarted = true;
  await initializeDatabase(postgresPort);
  reportPhase("fresh PostgreSQL cluster initialized with restricted roles");

  await runCommand(
    "organization profile PostgreSQL/API integration test",
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--project",
      "integration",
      "apps/api/src/organization-profile.integration.test.ts",
      "--reporter=verbose",
    ],
    environment,
  );
  reportPhase("concurrent API, authorization, RLS, and audit integration passed");

  await runCommand(
    "organization profile browser test",
    "pnpm",
    [
      "--filter",
      "@workspace/web",
      "exec",
      "playwright",
      "test",
      "tests/organization-profile-settings.spec.ts",
      "--workers=1",
      "--reporter=line",
    ],
    process.env,
  );
  reportPhase("browser conflict recovery, switcher refresh, and accessibility passed");

  inspectionDatabase = postgres(adminDatabaseUrl, { max: 1 });
  restrictedDatabase = postgres(applicationDatabaseUrl, { max: 1 });
  const expectedMigrationCount = (
    await readdir(join(repositoryRoot, "packages", "database", "migrations"))
  ).filter((file) => /^\d{4}_.+\.sql$/u.test(file)).length;
  const state = requiredRow(
    await inspectionDatabase`
      select
        (select count(*)::integer from reconai_schema_migrations) as migrations,
        (
          select count(*)::integer
          from organizations
          where name = 'Final Operations'
            and profile_version = 3
            and business_time_zone = 'America/New_York'
        ) as terminal_profiles,
        (
          select count(*)::integer
          from audit_events
          where action = 'organization.profile.updated'
        ) as profile_audits
    `,
    "terminal verification state",
  );
  assertEqual(Number(state["migrations"]), expectedMigrationCount, "applied migration count");
  assertEqual(Number(state["terminal_profiles"]), 1, "terminal organization profile count");
  assertEqual(Number(state["profile_audits"]), 2, "organization profile audit count");

  const auditRows = await inspectionDatabase`
    select event_hash, previous_event_hash, hash_version, previous_value, new_value, version_context
    from audit_events
    where action = 'organization.profile.updated'
  `;
  assertLinearAuditChain(auditRows);
  assert(
    auditRows.every((row) => Number(row["hash_version"]) === 2),
    "organization profile audit hash version was not uniformly v2",
  );
  assert(
    auditRows.every(
      (row) =>
        isRecord(row["version_context"]) &&
        Number(row["version_context"]["organizationProfileSchemaVersion"]) === 1,
    ),
    "organization profile audit schema version context was incomplete",
  );

  const tenantless = requiredRow(
    await restrictedDatabase`
      select
        (select count(*)::integer from organizations) as organizations,
        (select count(*)::integer from memberships) as memberships,
        (select count(*)::integer from audit_events) as audit_events
    `,
    "tenantless restricted-role state",
  );
  for (const field of ["organizations", "memberships", "audit_events"]) {
    assertEqual(Number(tenantless[field]), 0, `tenantless ${field}`);
  }

  const postgresqlVersion = String(
    requiredRow(await inspectionDatabase`select version() as version`, "PostgreSQL version")[
      "version"
    ],
  )
    .split(" ")
    .slice(0, 2)
    .join(" ");
  browser = await chromium.launch({ headless: true });
  const browserVersion = await browser.version();
  await browser.close();
  browser = undefined;

  const sourceHashes = {};
  for (const relativePath of [
    "scripts/verify-organization-profile.mjs",
    "apps/api/src/organization-profile.integration.test.ts",
    "apps/api/src/app.ts",
    "apps/api/src/repository.ts",
    "apps/web/src/app/api/recon/actions/route.ts",
    "apps/web/src/components/organization-profile-settings.tsx",
    "apps/web/tests/organization-profile-settings.spec.ts",
    "packages/database/migrations/0055_organization_profile_version.sql",
  ]) {
    sourceHashes[relativePath] = await sha256File(join(repositoryRoot, relativePath));
  }

  const evidence = {
    schemaVersion: "reconai-verification-v1",
    verification: "organization-profile-concurrent-api-and-browser",
    result: "passed",
    generatedAt: new Date().toISOString(),
    scope: {
      customerDataUsed: false,
      providerSystemsContacted: false,
      productionSystemsContacted: false,
      topology: "fresh isolated PostgreSQL cluster and local Chromium browser",
    },
    runtime: {
      postgresqlVersion,
      browserVersion,
      appliedMigrations: expectedMigrationCount,
      sourceHashes,
    },
    apiAndPersistence: {
      initialProfileVersion: 1,
      concurrentMutationStatuses: [200, 409],
      staleRetryStatus: 409,
      authorizedFinalProfileVersion: 3,
      noOpRetainedProfileVersion: 3,
      analystReadStatus: 404,
      analystMutationStatus: 404,
      foreignTenantMutationStatus: 404,
      malformedMutationStatus: 400,
      expandedMutationStatus: 400,
      organizationProfileAuditEvents: 2,
      auditHashVersion: 2,
      auditLinearChain: true,
      tenantlessApplicationRoleCounts: {
        organizations: Number(tenantless["organizations"]),
        memberships: Number(tenantless["memberships"]),
        auditEvents: Number(tenantless["audit_events"]),
      },
    },
    browser: {
      testsPassed: 3,
      explicitConfirmationExercised: true,
      switcherRefreshExercised: true,
      conflictReloadExercised: true,
      automatedAccessibilityViolations: 0,
    },
    controlsExercised: [
      "strict bounded profile read and mutation contracts at API and BFF boundaries",
      "current organization-management permission resolution before every profile operation",
      "optimistic profile-version concurrency with one accepted and one conflicting simultaneous write",
      "same-transaction organization update and v2 append-only audit event",
      "immediate exact organization-directory name re-resolution",
      "lower-privilege and foreign-tenant uniform not-found denials without audit state",
      "tenantless restricted-role RLS reads for organizations, memberships, and audit events",
      "browser confirmation, stale-conflict reload, live switcher refresh, and accessibility scan",
    ],
    limitations: [
      "This is one isolated local PostgreSQL and Chromium exercise; it is not staging or production evidence.",
      "The concurrent mutation test uses one API process and one PostgreSQL primary; it does not prove multi-region, failover, replica-lag, or sustained-load behavior.",
      "The browser test intercepts the BFF endpoints while the API integration independently exercises the real Fastify and PostgreSQL composition.",
      "Business-time-zone mutation is intentionally outside this slice because it can change financial business-date interpretation.",
      "No credential, customer payload, production identifier, or external-provider data is recorded.",
    ],
    credentialsRecorded: false,
  };
  await mkdir(join(repositoryRoot, "artifacts"), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${sanitize(message)}\n`);
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
      `ALTER ROLE postgres PASSWORD '${passwords.administrator}';`,
      `CREATE ROLE reconai_migrator LOGIN PASSWORD '${passwords.migrator}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;`,
      `CREATE ROLE reconai_app LOGIN PASSWORD '${passwords.application}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`,
      `CREATE ROLE reconai_worker LOGIN PASSWORD '${passwords.worker}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`,
      `CREATE ROLE reconai_maintenance LOGIN PASSWORD '${passwords.maintenance}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`,
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

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  await browser?.close();
  await restrictedDatabase?.end({ timeout: 5 });
  await inspectionDatabase?.end({ timeout: 5 });
  if (postgresStarted) {
    await runCommand(
      "PostgreSQL stop",
      join(postgresBin, "pg_ctl"),
      ["-D", postgresData, "-m", "fast", "-w", "stop"],
      process.env,
    );
    postgresStarted = false;
  }
  if (!runtime.startsWith(join(runtimeRoot, "reconai-organization-profile-"))) {
    throw new Error("refusing to remove an unexpected organization-profile runtime path");
  }
  await rm(runtime, { recursive: true, force: true });
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
  if (!address || typeof address === "string") {
    throw new Error("could not allocate a loopback port");
  }
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return address.port;
}

async function requiredDirectory(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  const directory = resolve(value);
  await access(directory);
  return directory;
}

function requiredRow(rows, label) {
  const row = rows[0];
  if (!row) throw new Error(`${label} returned no row`);
  return row;
}

function assertLinearAuditChain(rows) {
  const genesis = rows.filter((row) => row["previous_event_hash"] === null);
  assertEqual(genesis.length, 1, "organization profile audit genesis count");
  let current = genesis[0];
  let visited = 0;
  while (current) {
    visited += 1;
    current = rows.find((row) => row["previous_event_hash"] === current?.["event_hash"]);
  }
  assertEqual(visited, rows.length, "organization profile audit chain coverage");
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
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportPhase(phase) {
  process.stderr.write(`[organization-profile] ${phase}\n`);
}

function sanitize(value) {
  let sanitized = String(value);
  for (const secret of secrets) {
    sanitized = sanitized.replaceAll(secret, "<redacted>");
  }
  return sanitized;
}
