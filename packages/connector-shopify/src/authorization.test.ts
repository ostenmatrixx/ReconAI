import { createHmac } from "node:crypto";

import { ConnectorError, type ProviderOAuthTokenBundle } from "@workspace/connectors";
import { describe, expect, it, vi } from "vitest";

import { ShopifyAuthorizationClient } from "./authorization.js";

const clientId = "synthetic_shopify_client_id";
const clientSecret = "synthetic-shopify-client-secret-value";
const redirectUri = "https://app.example.test/api/recon/connectors/oauth/shopify/callback";
const shop = "reconai-test.myshopify.com";
const state = Buffer.alloc(32, 7).toString("base64url");
const now = new Date("2026-07-28T00:00:00.000Z");

describe("Shopify authorization client", () => {
  it("builds a fixed read-only offline authorization URL", () => {
    const client = shopifyClient();
    const url = client.authorizationUrl(shop.toUpperCase(), state);

    expect(url.origin).toBe(`https://${shop}`);
    expect(url.pathname).toBe("/admin/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(clientId);
    expect(url.searchParams.get("scope")).toBe("read_orders");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.has("grant_options[]")).toBe(false);
    expect(url.href).not.toContain(clientSecret);
  });

  it("validates HMAC, nonce, shop, uniqueness, and callback freshness", () => {
    const client = shopifyClient();
    const query = signedCallback();

    expect(client.validateCallback(query, state)).toEqual({
      shop,
      code: "synthetic-authorization-code",
      state,
      timestamp: Math.floor(now.getTime() / 1000),
    });

    const tampered = new URLSearchParams(query);
    tampered.set("shop", "other-shop.myshopify.com");
    expect(() => client.validateCallback(tampered, state)).toThrow(/callback is invalid/u);
    expect(() => client.validateCallback(query, Buffer.alloc(32, 8).toString("base64url"))).toThrow(
      /state is invalid/u,
    );

    const duplicate = new URLSearchParams(query);
    duplicate.append("state", state);
    expect(() => client.validateCallback(duplicate, state)).toThrow(/query is invalid/u);

    const staleTimestamp = String(Math.floor(now.getTime() / 1000) - 901);
    expect(() =>
      client.validateCallback(signedCallback({ timestamp: staleTimestamp }), state),
    ).toThrow(/expired/u);
  });

  it("exchanges a code for an expiring offline token bundle without exposing secrets in the URL", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      tokenResponse({
        access_token: "synthetic-shopify-access-token-value",
        refresh_token: "synthetic-shopify-refresh-token-value",
      }),
    );
    const client = shopifyClient(fetchMock);
    const callback = client.validateCallback(signedCallback(), state);

    await expect(client.exchangeAuthorizationCode(callback)).resolves.toEqual({
      schemaVersion: 1,
      credentialType: "oauth_refreshable",
      provider: "shopify",
      externalAccountId: shop,
      accessToken: "synthetic-shopify-access-token-value",
      refreshToken: "synthetic-shopify-refresh-token-value",
      accessTokenExpiresAt: "2026-07-28T01:00:00.000Z",
      refreshTokenExpiresAt: "2026-10-26T00:00:00.000Z",
      scopes: ["read_orders"],
      issuedAt: "2026-07-28T00:00:00.000Z",
    });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(input).toBe(`https://${shop}/admin/oauth/access_token`);
    expect(init?.redirect).toBe("error");
    const body = init?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get("client_secret")).toBe(clientSecret);
    expect((body as URLSearchParams).get("expiring")).toBe("1");
    expect((body as URLSearchParams).get("grant_options[]")).toBeNull();
  });

  it("rotates both Shopify tokens and rejects missing or write scopes", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      tokenResponse({
        access_token: "synthetic-shopify-access-token-rotated",
        refresh_token: "synthetic-shopify-refresh-token-rotated",
      }),
    );
    const client = shopifyClient(fetchMock);
    const current = shopifyBundle();

    await expect(client.refresh(current)).resolves.toMatchObject({
      accessToken: "synthetic-shopify-access-token-rotated",
      refreshToken: "synthetic-shopify-refresh-token-rotated",
      accessTokenExpiresAt: "2026-07-28T01:00:00.000Z",
      refreshTokenExpiresAt: "2026-10-26T00:00:00.000Z",
    });
    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe(current.refreshToken);

    const missingScope = shopifyClient(
      vi.fn(async () =>
        tokenResponse({
          access_token: "synthetic-shopify-access-token-value",
          refresh_token: "synthetic-shopify-refresh-token-value",
          scope: "read_products",
        }),
      ),
    );
    await expect(
      missingScope.exchangeAuthorizationCode(
        missingScope.validateCallback(signedCallback(), state),
      ),
    ).rejects.toMatchObject({ kind: "authorization" });

    const writeScope = shopifyClient(
      vi.fn(async () =>
        tokenResponse({
          access_token: "synthetic-shopify-access-token-value",
          refresh_token: "synthetic-shopify-refresh-token-value",
          scope: "read_orders,write_orders",
        }),
      ),
    );
    await expect(
      writeScope.exchangeAuthorizationCode(writeScope.validateCallback(signedCallback(), state)),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it("uninstalls only through the fixed shop Admin GraphQL endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const body = JSON.stringify({
        data: { appUninstall: { userErrors: [] } },
      });
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
      });
    });
    const client = shopifyClient(fetchMock);
    const accessToken = "synthetic-shopify-access-token-value";

    await expect(client.uninstall(shop, accessToken, "2026-07")).resolves.toBeUndefined();
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(input).toBe(`https://${shop}/admin/api/2026-07/graphql.json`);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(new Headers(init?.headers).get("X-Shopify-Access-Token")).toBe(accessToken);
    if (typeof init?.body !== "string") throw new Error("expected a JSON request body");
    expect(init.body).toContain("appUninstall");
    expect(init.body).not.toContain(accessToken);
  });

  it("does not claim uninstall when Shopify rejects or returns an ambiguous payload", async () => {
    const rejected = shopifyClient(
      vi.fn(async () =>
        Response.json({
          data: {
            appUninstall: {
              userErrors: [{ field: null, message: "App cannot be uninstalled" }],
            },
          },
        }),
      ),
    );
    await expect(
      rejected.uninstall(shop, "synthetic-shopify-access-token-value", "2026-07"),
    ).rejects.toMatchObject({ kind: "authorization" });

    const unauthorized = shopifyClient(vi.fn(async () => new Response(null, { status: 401 })));
    await expect(
      unauthorized.uninstall(shop, "synthetic-shopify-access-token-value", "2026-07"),
    ).rejects.toMatchObject({ kind: "authentication" });
  });
});

function shopifyClient(fetchMock?: typeof fetch): ShopifyAuthorizationClient {
  return new ShopifyAuthorizationClient({
    clientId,
    clientSecret,
    redirectUri,
    requiredScopes: ["read_orders"],
    ...(fetchMock ? { fetch: fetchMock } : {}),
    now: () => now,
  });
}

function signedCallback(overrides: Readonly<Record<string, string>> = {}): URLSearchParams {
  const fields = {
    code: "synthetic-authorization-code",
    shop,
    state,
    timestamp: String(Math.floor(now.getTime() / 1000)),
    ...overrides,
  };
  const message = Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  return new URLSearchParams({
    ...fields,
    hmac: createHmac("sha256", clientSecret).update(message).digest("hex"),
  });
}

function tokenResponse(overrides: Readonly<Record<string, string>> = {}): Response {
  const payload = {
    access_token: "synthetic-shopify-access-token-value",
    refresh_token: "synthetic-shopify-refresh-token-value",
    expires_in: 3600,
    refresh_token_expires_in: 7_776_000,
    scope: "read_orders",
    ...overrides,
  };
  const body = JSON.stringify(payload);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    },
  });
}

function shopifyBundle(): ProviderOAuthTokenBundle & { readonly provider: "shopify" } {
  return {
    schemaVersion: 1,
    credentialType: "oauth_refreshable",
    provider: "shopify",
    externalAccountId: shop,
    accessToken: "synthetic-shopify-access-token-current",
    refreshToken: "synthetic-shopify-refresh-token-current",
    accessTokenExpiresAt: "2026-07-28T00:10:00.000Z",
    refreshTokenExpiresAt: "2026-10-25T00:00:00.000Z",
    scopes: ["read_orders"],
    issuedAt: "2026-07-27T23:10:00.000Z",
  };
}
