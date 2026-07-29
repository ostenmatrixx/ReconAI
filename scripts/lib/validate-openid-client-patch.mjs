import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import YAML from "yaml";

const PATCHED_PACKAGE = "openid-client@5.7.1";
const PATCH_PATH = "patches/openid-client@5.7.1.patch";
const requireFromWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));

export async function validateOpenIdClientPatch() {
  const workspace = YAML.parse(
    await readFile(new URL("../../pnpm-workspace.yaml", import.meta.url), "utf8"),
  );
  assert.equal(
    workspace.patchedDependencies?.[PATCHED_PACKAGE],
    PATCH_PATH,
    `${PATCHED_PACKAGE} must remain bound to the reviewed patch`,
  );

  const lockfileSource = await readFile(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8");
  const lockfile = YAML.parse(lockfileSource);
  const patchHash = lockfile.patchedDependencies?.[PATCHED_PACKAGE];
  assert.match(
    patchHash ?? "",
    /^[a-f0-9]{64}$/u,
    `${PATCHED_PACKAGE} must have a lockfile-bound patch hash`,
  );
  assert.ok(
    lockfileSource.includes(`patch_hash=${patchHash}`),
    `${PATCHED_PACKAGE} resolution must include the reviewed patch hash`,
  );

  const patchSource = await readFile(new URL(`../../${PATCH_PATH}`, import.meta.url), "utf8");
  for (const expectedControl of [
    "new URL(input, 'https://openid-client.invalid')",
    "new URL(this.issuer.end_session_endpoint)",
    "function resolveWebFingerHost(resource)",
    "const parsed = new URL(uri)",
    "new URL(this._issuer.issuer).hostname",
  ]) {
    assert.ok(
      patchSource.includes(expectedControl),
      `${PATCHED_PACKAGE} patch is missing: ${expectedControl}`,
    );
  }

  const nextAuthEntry = requireFromWeb.resolve("next-auth");
  const requireFromNextAuth = createRequire(nextAuthEntry);
  const openIdClientEntry = requireFromNextAuth.resolve("openid-client");
  const openIdClientRoot = dirname(dirname(openIdClientEntry));
  const packageMetadata = JSON.parse(
    await readFile(join(openIdClientRoot, "package.json"), "utf8"),
  );
  assert.equal(packageMetadata.name, "openid-client");
  assert.equal(packageMetadata.version, "5.7.1");

  const runtimeSources = await readJavaScriptSources(join(openIdClientRoot, "lib"));
  assert.ok(runtimeSources.length > 0, "installed openid-client sources must be inspectable");
  for (const { path, source } of runtimeSources) {
    assert.ok(
      !/\burl\.parse\s*\(/u.test(source),
      `deprecated legacy URL parser remains in installed ${path}`,
    );
  }

  const { Issuer, Strategy } = requireFromNextAuth("openid-client");
  verifyKeycloakProviderContract();
  verifyCallbackAndLogoutUrls(Issuer);
  verifyPassportIssuerUrl(Strategy, Issuer);
  await verifyDiscoveryUrl(Issuer);

  return {
    package: PATCHED_PACKAGE,
    patchHash,
    sourceFiles: runtimeSources.length,
  };
}

function verifyKeycloakProviderContract() {
  const importedProvider = requireFromWeb("next-auth/providers/keycloak");
  const keycloakProvider = importedProvider.default ?? importedProvider;
  const provider = keycloakProvider({
    issuer: "https://identity.example.test/realms/reconai",
    clientId: "reconai-web",
    clientSecret: "synthetic-validator-secret",
  });

  assert.equal(
    provider.wellKnown,
    "https://identity.example.test/realms/reconai/.well-known/openid-configuration",
  );
  assert.deepEqual(
    provider.checks,
    ["pkce", "state"],
    "the authorization-code flow must retain PKCE and state verification",
  );
  assert.equal(provider.idToken, true);
}

function verifyCallbackAndLogoutUrls(Issuer) {
  const issuer = new Issuer({
    issuer: "https://identity.example.test/realms/reconai",
    authorization_endpoint:
      "https://identity.example.test/realms/reconai/protocol/openid-connect/auth",
    end_session_endpoint:
      "https://identity.example.test/realms/reconai/protocol/openid-connect/logout?provider=keycloak&resource=first&resource=second",
  });
  const client = new issuer.Client({
    client_id: "reconai-web",
    redirect_uris: ["https://app.example.test/api/auth/callback/keycloak"],
    post_logout_redirect_uris: ["https://app.example.test/"],
  });

  const callback = client.callbackParams(
    "/api/auth/callback/keycloak?code=authorization%20code&state=opaque-state&iss=https%3A%2F%2Fidentity.example.test%2Frealms%2Freconai&ignored=value",
  );
  assert.deepEqual(
    { ...callback },
    {
      code: "authorization code",
      iss: "https://identity.example.test/realms/reconai",
      state: "opaque-state",
    },
    "relative callback URLs must retain the established allowlisted query semantics",
  );

  const logout = new URL(
    client.endSessionUrl({
      id_token_hint: "header.payload.signature",
      resource: "caller-value-must-not-replace-provider-values",
      state: "logout-state",
    }),
  );
  assert.equal(logout.origin, "https://identity.example.test");
  assert.equal(logout.pathname, "/realms/reconai/protocol/openid-connect/logout");
  assert.equal(logout.searchParams.get("provider"), "keycloak");
  assert.deepEqual(logout.searchParams.getAll("resource"), ["first", "second"]);
  assert.equal(logout.searchParams.get("state"), "logout-state");
  assert.equal(logout.searchParams.get("client_id"), "reconai-web");
  assert.equal(logout.searchParams.get("id_token_hint"), "header.payload.signature");
  assert.equal(logout.searchParams.get("post_logout_redirect_uri"), "https://app.example.test/");
}

function verifyPassportIssuerUrl(Strategy, Issuer) {
  const issuer = new Issuer({
    issuer: "https://identity.example.test:8443/realms/reconai",
    authorization_endpoint:
      "https://identity.example.test:8443/realms/reconai/protocol/openid-connect/auth",
  });
  const client = new issuer.Client({
    client_id: "reconai-passport-check",
    redirect_uris: ["https://app.example.test/passport/callback"],
  });
  const strategy = new Strategy({ client }, () => undefined);

  assert.equal(strategy.name, "identity.example.test");
  assert.equal(strategy._key, "oidc:identity.example.test");
}

async function verifyDiscoveryUrl(Issuer) {
  const requests = [];
  let providerOrigin = "";
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (
      request.method !== "GET" ||
      request.url !== "/realms/reconai/.well-known/openid-configuration"
    ) {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        issuer: `${providerOrigin}/realms/reconai`,
        authorization_endpoint: `${providerOrigin}/realms/reconai/authorize`,
        token_endpoint: `${providerOrigin}/realms/reconai/token`,
        jwks_uri: `${providerOrigin}/realms/reconai/certs`,
      }),
    );
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    providerOrigin = `http://127.0.0.1:${address.port}`;
    const discovered = await Issuer.discover(`${providerOrigin}/realms/reconai/`);
    assert.equal(discovered.issuer, `${providerOrigin}/realms/reconai`);
    assert.deepEqual(requests, ["/realms/reconai/.well-known/openid-configuration"]);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function readJavaScriptSources(directory) {
  const sources = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...(await readJavaScriptSources(path)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      sources.push({ path, source: await readFile(path, "utf8") });
    }
  }
  return sources;
}
