import { StripeAuthorizationClient } from "@workspace/connector-stripe";
import type {
  ClaimedProviderAuthorization,
  ProviderAuthorizationManager,
} from "@workspace/database";
import {
  MembershipIdSchema,
  OrganizationIdSchema,
  UserIdSchema,
  tenantContextFromMembership,
} from "@workspace/domain";
import { describe, expect, it, vi } from "vitest";

import {
  ProviderAuthorizationCoordinator,
  ProviderAuthorizationDisabledError,
} from "./provider-authorization.js";

const state = "A".repeat(43);
const attemptId = "00000000-0000-4000-8000-000000000041";
const connectionId = "00000000-0000-4000-8000-000000000042";
const claimedAt = "2026-07-28T00:00:00.000Z";
const claim: ClaimedProviderAuthorization = {
  attemptId,
  connectionId,
  provider: "stripe",
  claimedAt,
};
const tenant = tenantContextFromMembership({
  id: MembershipIdSchema.parse("00000000-0000-4000-8000-000000000043"),
  organizationId: OrganizationIdSchema.parse("00000000-0000-4000-8000-000000000044"),
  userId: UserIdSchema.parse("00000000-0000-4000-8000-000000000045"),
  role: "administrator",
  status: "active",
});

describe("provider authorization coordinator", () => {
  it("starts a configured flow with server-owned connector and API versions", async () => {
    const authorization = managerStub();
    const coordinator = new ProviderAuthorizationCoordinator({
      manager: authorization.manager,
      stripe: {
        client: stripeClient(async () => {
          throw new Error("token exchange should not run");
        }),
        apiVersion: "2025-06-30.basil",
      },
    });
    const started = await coordinator.start(tenant, {
      provider: "stripe",
      correlationId: "00000000-0000-4000-8000-000000000046",
    });
    expect(authorization.begin).toHaveBeenCalledWith(
      tenant,
      expect.objectContaining({
        provider: "stripe",
        connectorVersion: "1.1.0",
        apiVersion: "2025-06-30.basil",
      }),
    );
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://marketplace.stripe.com");
    expect(authorizationUrl.pathname).toBe("/oauth/v2/authorize");
    expect(authorizationUrl.searchParams.get("state")).toBe(state);
  });

  it("claims, exchanges, and completes a Stripe callback without returning tokens", async () => {
    const authorization = managerStub();
    const providerFetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        access_token: "synthetic-access-token-value",
        refresh_token: "synthetic-refresh-token-value",
        scope: "stripe_apps",
        stripe_user_id: "acct_synthetic",
        token_type: "bearer",
        livemode: false,
      }),
    );
    const coordinator = new ProviderAuthorizationCoordinator({
      manager: authorization.manager,
      stripe: {
        client: stripeClient(providerFetch),
        apiVersion: "2025-06-30.basil",
      },
    });
    const result = await coordinator.callback(tenant, {
      attemptId,
      provider: "stripe",
      query: [
        ["code", "synthetic-code-value"],
        ["state", state],
      ],
      correlationId: "00000000-0000-4000-8000-000000000047",
    });
    expect(authorization.claim).toHaveBeenCalledWith(tenant, {
      attemptId,
      provider: "stripe",
      state,
    });
    const completionInput = authorization.complete.mock.calls[0]?.[1];
    expect(completionInput).toMatchObject({
      claim,
      tokenBundle: {
        provider: "stripe",
        externalAccountId: "acct_synthetic",
      },
    });
    expect(result).toEqual({
      attemptId,
      connectionId,
      provider: "stripe",
      status: "succeeded",
      replayed: false,
      externalAccountId: "acct_synthetic",
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-access-token-value");
    expect(JSON.stringify(result)).not.toContain("synthetic-refresh-token-value");
  });

  it("does not exchange a code again after the durable attempt reports success", async () => {
    const authorization = managerStub({
      claim: vi.fn<ProviderAuthorizationManager["claim"]>(async () => ({
        kind: "replayed",
        attemptId,
        connectionId,
        provider: "stripe",
        status: "succeeded",
      })),
    });
    const providerFetch = vi.fn<typeof fetch>();
    const coordinator = new ProviderAuthorizationCoordinator({
      manager: authorization.manager,
      stripe: {
        client: stripeClient(providerFetch),
        apiVersion: "2025-06-30.basil",
      },
    });
    await expect(
      coordinator.callback(tenant, {
        attemptId,
        provider: "stripe",
        query: [
          ["code", "synthetic-code-value"],
          ["state", state],
        ],
        correlationId: "00000000-0000-4000-8000-000000000048",
      }),
    ).resolves.toMatchObject({ status: "succeeded", replayed: true });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(authorization.complete).not.toHaveBeenCalled();
  });

  it("records a state-bound provider denial without attempting token exchange", async () => {
    const authorization = managerStub();
    const providerFetch = vi.fn<typeof fetch>();
    const coordinator = new ProviderAuthorizationCoordinator({
      manager: authorization.manager,
      stripe: {
        client: stripeClient(providerFetch),
        apiVersion: "2025-06-30.basil",
      },
    });
    await expect(
      coordinator.callback(tenant, {
        attemptId,
        provider: "stripe",
        query: [
          ["error", "access_denied"],
          ["error_description", "The user cancelled installation"],
          ["state", state],
        ],
        correlationId: "00000000-0000-4000-8000-000000000049",
      }),
    ).resolves.toMatchObject({ status: "denied", replayed: false });
    expect(authorization.deny).toHaveBeenCalledWith(
      tenant,
      expect.objectContaining({
        attemptId,
        provider: "stripe",
        state,
        errorCode: "PROVIDER_ACCESS_DENIED",
      }),
    );
    expect(authorization.claim).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("fails closed when a provider flow is not configured", async () => {
    const coordinator = new ProviderAuthorizationCoordinator({
      manager: managerStub().manager,
    });
    await expect(
      coordinator.start(tenant, {
        provider: "shopify",
        requestedAccountId: "example.myshopify.com",
        correlationId: "00000000-0000-4000-8000-000000000050",
      }),
    ).rejects.toBeInstanceOf(ProviderAuthorizationDisabledError);
  });
});

function managerStub(
  overrides: {
    readonly claim?: ReturnType<typeof vi.fn<ProviderAuthorizationManager["claim"]>>;
  } = {},
) {
  const begin = vi.fn<ProviderAuthorizationManager["begin"]>(async () => ({
    attemptId,
    connectionId,
    provider: "stripe",
    state,
    expiresAt: "2026-07-28T00:10:00.000Z",
  }));
  const claimMock =
    overrides.claim ??
    vi.fn<ProviderAuthorizationManager["claim"]>(async () => ({
      kind: "claimed",
      claim,
    }));
  const complete = vi.fn<ProviderAuthorizationManager["complete"]>(async () => ({
    attemptId,
    connectionId,
    provider: "stripe",
    externalAccountId: "acct_synthetic",
    credentialId: "00000000-0000-4000-8000-000000000051",
    connectionStatus: "backfilling",
    completedAt: "2026-07-28T00:00:01.000Z",
  }));
  const deny = vi.fn<ProviderAuthorizationManager["deny"]>(async () => ({
    attemptId,
    status: "denied",
  }));
  const fail = vi.fn<ProviderAuthorizationManager["fail"]>(async () => ({
    attemptId,
    status: "failed",
  }));
  return {
    manager: {
      begin,
      claim: claimMock,
      complete,
      deny,
      fail,
    } satisfies ProviderAuthorizationManager,
    begin,
    claim: claimMock,
    complete,
    deny,
    fail,
  };
}

function stripeClient(providerFetch: typeof fetch): StripeAuthorizationClient {
  return new StripeAuthorizationClient({
    clientId: "stripe-client-id",
    secretKey: "synthetic-stripe-secret",
    redirectUri: "https://web.example.test/api/recon/provider-authorizations/callback/stripe",
    fetch: providerFetch,
    now: () => new Date("2026-07-28T00:00:00.000Z"),
  });
}
