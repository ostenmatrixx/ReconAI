import {
  createDatabase,
  PostgresProviderPrivacyOperationsRepository,
  PostgresSupportAccessRepository,
} from "../packages/database/src/index.ts";

import { buildApi } from "../apps/api/src/app.js";
import {
  OidcIdentityVerifier,
  PostgresMembershipDirectory,
  PostgresOrganizationBootstrapper,
} from "../apps/api/src/auth.js";
import { PostgresReconciliationRepository } from "../apps/api/src/repository.js";
import { ConfiguredSupportIdentityAuthorizer } from "../apps/api/src/support-identity.js";

const databaseUrl = requiredEnvironment("DATABASE_URL");
const issuer = requiredLoopbackIssuer("OIDC_ISSUER");
const clientId = requiredEnvironment("OIDC_CLIENT_ID");
const supportGroup = requiredEnvironment("SUPPORT_OIDC_GROUP");
const supportAuthenticationContext = requiredEnvironment("SUPPORT_OIDC_AUTHENTICATION_CONTEXT");
const supportIdentityHmacKey = requiredEnvironment("SUPPORT_IDENTITY_HMAC_KEY");
const port = boundedPort("API_PORT", 4000);
const database = createDatabase(databaseUrl, 10);
const sql = database.sql;

const api = await buildApi({
  identityVerifier: new OidcIdentityVerifier(issuer, clientId),
  memberships: new PostgresMembershipDirectory(sql),
  organizationBootstrap: new PostgresOrganizationBootstrapper(sql),
  repository: new PostgresReconciliationRepository(sql),
  csvImports: unavailableCsvImports(),
  providerWebhooks: unavailableProviderWebhooks(),
  providerPrivacyOperations: new PostgresProviderPrivacyOperationsRepository(sql),
  supportIdentityAuthorizer: new ConfiguredSupportIdentityAuthorizer({
    enabled: true,
    requiredGroup: supportGroup,
    requiredAuthenticationContext: supportAuthenticationContext,
    identityHmacKey: supportIdentityHmacKey,
  }),
  supportAccess: new PostgresSupportAccessRepository(sql),
  webOrigin: requiredLoopbackOrigin("WEB_ORIGIN", "http://localhost:3000"),
  environment: "test",
  rateLimit: { store: "local" },
});

await api.listen({ host: "127.0.0.1", port });

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdown(signal);
  });
}

async function shutdown(signal) {
  let exitCode = 0;
  try {
    await api.close();
    await database.close();
  } catch {
    exitCode = 1;
  }
  process.stderr.write(`live restricted-support API harness stopped after ${signal}\n`);
  process.exit(exitCode);
}

function unavailableCsvImports() {
  return {
    createPreview: async () => unavailable("CSV imports"),
    getImport: async () => unavailable("CSV imports"),
    listImports: async () => unavailable("CSV imports"),
    commitImport: async () => unavailable("CSV imports"),
    rollbackImport: async () => unavailable("CSV imports"),
  };
}

function unavailableProviderWebhooks() {
  return {
    receiveShopify: async () => unavailable("provider webhooks"),
    receiveStripe: async () => unavailable("provider webhooks"),
  };
}

function unavailable(component) {
  throw new Error(`${component} are outside the live restricted-support verification`);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the live restricted-support API harness`);
  return value;
}

function boundedPort(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!/^[1-9][0-9]{0,4}$/u.test(raw)) throw new Error(`${name} must be a TCP port`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 65_535) {
    throw new Error(`${name} must be a TCP port`);
  }
  return value;
}

function requiredLoopbackIssuer(name) {
  const value = requiredEnvironment(name);
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === "/"
  ) {
    throw new Error(`${name} must be a loopback HTTP realm issuer`);
  }
  return url.toString().replace(/\/$/u, "");
}

function requiredLoopbackOrigin(name, fallback) {
  const value = process.env[name] ?? fallback;
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be a loopback HTTP origin`);
  }
  return url.origin;
}
