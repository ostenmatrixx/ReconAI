import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

import YAML from "yaml";

import { validateOpenIdClientPatch } from "./lib/validate-openid-client-patch.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const realm = JSON.parse(
  await readFile(
    new URL("../infra/keycloak/reconai-development-realm.json", import.meta.url),
    "utf8",
  ),
);
const compose = YAML.parse(await readFile(new URL("../compose.yaml", import.meta.url), "utf8"));
const environment = parseEnvironment(
  await readFile(new URL("../.env.example", import.meta.url), "utf8"),
);
const supportIdentitySource = await readFile(
  new URL("../apps/api/src/support-identity.ts", import.meta.url),
  "utf8",
);
const runtimeConfigSource = await readFile(
  new URL("../packages/config/src/index.ts", import.meta.url),
  "utf8",
);
const routeSecuritySource = await readFile(
  new URL("../apps/api/src/route-security.ts", import.meta.url),
  "utf8",
);

const client = realm.clients?.find(({ clientId }) => clientId === "reconai-web-development");
assert(client, "synthetic Keycloak client is missing");
assert(client.enabled === true, "synthetic Keycloak client must be enabled");
assert(client.publicClient === false, "OIDC client must remain confidential");
assert(client.standardFlowEnabled === true, "OIDC authorization-code flow must remain enabled");
assert(
  client.directAccessGrantsEnabled === false,
  "OIDC resource-owner password grants must remain disabled",
);
assert(client.frontchannelLogout === false, "Keycloak front-channel logout must remain disabled");
assert(
  JSON.stringify(client.redirectUris) ===
    JSON.stringify(["http://localhost:3000/api/auth/callback/keycloak"]),
  "OIDC redirect URI must be the exact NextAuth Keycloak callback",
);
assert(
  JSON.stringify(client.webOrigins) === JSON.stringify(["http://localhost:3000"]),
  "OIDC development web origin must remain exact",
);

const attributes = client.attributes ?? {};
assert(attributes["pkce.code.challenge.method"] === "S256", "OIDC PKCE must require S256");
assert(
  attributes["post.logout.redirect.uris"] === "http://localhost:3000/",
  "OIDC post-logout redirect must remain exact",
);
assert(
  attributes["backchannel.logout.url"] ===
    "http://host.docker.internal:3000/api/auth/backchannel-logout",
  "OIDC back-channel URL must remain the fixed development endpoint",
);
assert(
  attributes["backchannel.logout.session.required"] === "true",
  "OIDC back-channel logout must require sid",
);
assert(
  attributes["backchannel.logout.revoke.offline.tokens"] === "false",
  "OIDC logout must not silently expand to offline-session revocation",
);
assert(
  environment.get("OIDC_ID_TOKEN_SIGNING_ALGORITHM") === "RS256",
  "development ID/logout-token signing must remain explicitly pinned",
);
assert(
  environment.get("SESSION_REVOCATION_STORE") === "local",
  "the checked-in environment must label the single-process development store explicitly",
);
assert(
  environment.get("SUPPORT_ACCESS_ENABLED") === "false",
  "restricted support access must remain disabled by default",
);
for (const setting of [
  "SUPPORT_OIDC_GROUP",
  "SUPPORT_OIDC_AUTHENTICATION_CONTEXT",
  "SUPPORT_IDENTITY_HMAC_KEY",
]) {
  assert(
    environment.get(setting) === "",
    `${setting} must not contain checked-in support authority`,
  );
}
assert(
  runtimeConfigSource.includes("validateSupportAccessConfiguration(config)") &&
    runtimeConfigSource.includes(
      "support access settings are only valid when SUPPORT_ACCESS_ENABLED=true",
    ),
  "runtime configuration must reject partial or dormant support authority",
);
for (const requiredSource of [
  'createHmac("sha256"',
  "timingSafeEqual",
  "identity.groups?.some",
  "identity.authenticationContext",
  '.update(identity.issuer, "utf8")',
  '.update("\\0", "utf8")',
  '.update(identity.subject, "utf8")',
  "SupportIdentityDigestSchema.parse",
]) {
  assert(
    supportIdentitySource.includes(requiredSource),
    `support identity boundary is missing required control: ${requiredSource}`,
  );
}
assert(
  routeSecuritySource.includes('path: "/v1/support/access-requests"') &&
    routeSecuritySource.includes('authentication: "support"') &&
    routeSecuritySource.includes('permissions: ["support:manage"]'),
  "support and tenant approval routes must remain explicit in the authorization inventory",
);

const users = realm.users ?? [];
assert(
  users.length === 2,
  "synthetic Keycloak realm must contain exactly two lifecycle-test users",
);
for (const user of users) {
  assert(
    typeof user.username === "string" &&
      user.username === user.email &&
      user.username.endsWith("@example.test"),
    "synthetic Keycloak users must use matching reserved example.test identities",
  );
  assert(user.emailVerified === true, "synthetic Keycloak users must exercise verified email");
  assert(user.enabled === true, "synthetic Keycloak users must be enabled");
  const passwordCredentials = user.credentials?.filter(({ type }) => type === "password") ?? [];
  assert(
    passwordCredentials.length === 1 && passwordCredentials[0]?.temporary === true,
    "synthetic Keycloak users must have one temporary development-only password",
  );
}

const oidcService = compose.services?.oidc;
assert(oidcService, "Compose OIDC service is missing");
assert(
  oidcService.extra_hosts?.includes("host.docker.internal:host-gateway"),
  "Compose OIDC must resolve the host web process for back-channel logout",
);

await readFile(
  new URL("../apps/web/src/app/api/auth/backchannel-logout/route.ts", import.meta.url),
  "utf8",
);
await readFile(new URL("../apps/web/src/oidc-backchannel-logout.ts", import.meta.url), "utf8");
await readFile(new URL("../apps/web/src/session-revocation.ts", import.meta.url), "utf8");

const openIdClientPatch = await validateOpenIdClientPatch();

process.stdout.write(
  `✓ OIDC security configuration validated (${repositoryRoot}, one exact confidential client, two reserved synthetic identities, default-disabled restricted support boundary, ${openIdClientPatch.package} WHATWG patch ${openIdClientPatch.patchHash.slice(0, 12)})\n`,
);

function parseEnvironment(source) {
  const result = new Map();
  for (const line of source.split(/\r?\n/u)) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    result.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
