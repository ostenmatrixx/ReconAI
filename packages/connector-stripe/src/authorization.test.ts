import { ConnectorError, type ProviderOAuthTokenBundle } from "@workspace/connectors";
import { describe, expect, it, vi } from "vitest";

import { StripeAuthorizationClient } from "./authorization.js";

const clientId = "synthetic_stripe_oauth_client";
const secretKey = "synthetic-stripe-secret-key-value";
const redirectUri = "https://app.example.test/api/recon/connectors/oauth/stripe/callback";
const accountId = "acct_SyntheticAccount123";
const state = Buffer.alloc(32, 9).toString("base64url");
const now = new Date("2026-07-28T00:00:00.000Z");

describe("Stripe Apps authorization client", () => {
  it("builds a fixed Marketplace OAuth URL with opaque state", () => {
    const client = stripeClient();
    const url = client.authorizationUrl(state);

    expect(url.origin).toBe("https://marketplace.stripe.com");
    expect(url.pathname).toBe("/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe(clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.href).not.toContain(secretKey);
  });

  it("validates state, denial, and duplicate callback fields before code exchange", () => {
    const client = stripeClient();
    expect(
      client.validateCallback(
        new URLSearchParams({ code: "synthetic-stripe-authorization-code", state }),
        state,
      ),
    ).toEqual({ code: "synthetic-stripe-authorization-code", state });

    expect(() =>
      client.validateCallback(
        new URLSearchParams({ code: "synthetic-stripe-authorization-code", state }),
        Buffer.alloc(32, 8).toString("base64url"),
      ),
    ).toThrow(/state is invalid/u);
    expect(() =>
      client.validateCallback(new URLSearchParams({ error: "access_denied", state }), state),
    ).toThrow(/not completed/u);
    const duplicate = new URLSearchParams({ code: "synthetic-stripe-authorization-code", state });
    duplicate.append("state", state);
    expect(() => client.validateCallback(duplicate, state)).toThrow(/query is invalid/u);
  });

  it("exchanges a one-time code into a bounded rolled token bundle", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => stripeTokenResponse("authorization_code"));
    const client = stripeClient(fetchMock);
    const callback = client.validateCallback(
      new URLSearchParams({ code: "synthetic-stripe-authorization-code", state }),
      state,
    );

    await expect(client.exchangeAuthorizationCode(callback)).resolves.toEqual({
      schemaVersion: 1,
      credentialType: "oauth_refreshable",
      provider: "stripe",
      externalAccountId: accountId,
      livemode: false,
      authorizationGrantedAt: "2026-07-28T00:00:00.000Z",
      accessToken: "synthetic-stripe-access-token-value",
      refreshToken: "synthetic-stripe-refresh-token-value",
      accessTokenExpiresAt: "2026-07-28T01:00:00.000Z",
      refreshTokenExpiresAt: "2027-07-28T00:00:00.000Z",
      scopes: ["stripe_apps"],
      issuedAt: "2026-07-28T00:00:00.000Z",
    });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(input).toBe("https://api.stripe.com/v1/oauth/token");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(
      `Basic ${Buffer.from(`${secretKey}:`, "utf8").toString("base64")}`,
    );
    const body = init?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("synthetic-stripe-authorization-code");
  });

  it("rotates both Stripe tokens and rejects account-authority changes", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      stripeTokenResponse("refresh_token", {
        access_token: "synthetic-stripe-access-token-rotated",
        refresh_token: "synthetic-stripe-refresh-token-rotated",
      }),
    );
    const client = stripeClient(fetchMock);
    const current = stripeBundle();

    await expect(client.refresh(current)).resolves.toMatchObject({
      externalAccountId: accountId,
      authorizationGrantedAt: current.authorizationGrantedAt,
      accessToken: "synthetic-stripe-access-token-rotated",
      refreshToken: "synthetic-stripe-refresh-token-rotated",
    });
    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe(current.refreshToken);

    const changedAccount = stripeClient(
      vi.fn(async () =>
        stripeTokenResponse("refresh_token", { account_id: "acct_DifferentAccount456" }),
      ),
    );
    await expect(changedAccount.refresh(current)).rejects.toMatchObject({
      kind: "authentication",
    });
    const changedMode = stripeClient(
      vi.fn(async () => stripeTokenResponse("refresh_token", { livemode: true })),
    );
    await expect(changedMode.refresh(current)).rejects.toMatchObject({
      kind: "authentication",
    });

    const wrongScope = stripeClient(
      vi.fn(async () => stripeTokenResponse("authorization_code", { scope: "read_write" })),
    );
    await expect(
      wrongScope.exchangeAuthorizationCode({
        code: "synthetic-stripe-authorization-code",
        state,
      }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it("rejects the account field from the wrong OAuth grant response", async () => {
    const authorizationWithRefreshShape = stripeClient(
      vi.fn(async () => stripeTokenResponse("refresh_token")),
    );
    await expect(
      authorizationWithRefreshShape.exchangeAuthorizationCode({
        code: "synthetic-stripe-authorization-code",
        state,
      }),
    ).rejects.toMatchObject({ kind: "invalid_payload" });

    const refreshWithAuthorizationShape = stripeClient(
      vi.fn(async () => stripeTokenResponse("authorization_code")),
    );
    await expect(refreshWithAuthorizationShape.refresh(stripeBundle())).rejects.toMatchObject({
      kind: "invalid_payload",
    });
  });
});

function stripeClient(fetchMock?: typeof fetch): StripeAuthorizationClient {
  return new StripeAuthorizationClient({
    clientId,
    secretKey,
    redirectUri,
    ...(fetchMock ? { fetch: fetchMock } : {}),
    now: () => now,
  });
}

function stripeTokenResponse(
  grantType: "authorization_code" | "refresh_token",
  overrides: Readonly<Record<string, unknown>> = {},
): Response {
  const payload = {
    access_token: "synthetic-stripe-access-token-value",
    refresh_token: "synthetic-stripe-refresh-token-value",
    scope: "stripe_apps",
    ...(grantType === "authorization_code"
      ? { stripe_user_id: accountId }
      : { account_id: accountId }),
    token_type: "bearer",
    livemode: false,
    stripe_publishable_key: "pk_test_synthetic_publishable_value",
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

function stripeBundle(): ProviderOAuthTokenBundle & { readonly provider: "stripe" } {
  return {
    schemaVersion: 1,
    credentialType: "oauth_refreshable",
    provider: "stripe",
    externalAccountId: accountId,
    livemode: false,
    authorizationGrantedAt: "2026-07-27T23:10:00.000Z",
    accessToken: "synthetic-stripe-access-token-current",
    refreshToken: "synthetic-stripe-refresh-token-current",
    accessTokenExpiresAt: "2026-07-28T00:10:00.000Z",
    refreshTokenExpiresAt: "2027-07-27T23:00:00.000Z",
    scopes: ["stripe_apps"],
    issuedAt: "2026-07-27T23:10:00.000Z",
  };
}
