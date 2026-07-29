import {
  MembershipIdSchema,
  OrganizationIdSchema,
  UserIdSchema,
  tenantContextFromMembership,
} from "@workspace/domain";
import type {
  ConnectorDisconnectAuthority,
  ConnectorProviderDisconnectStore,
} from "@workspace/database";
import { describe, expect, it, vi } from "vitest";

import {
  ProviderDisconnectCoordinator,
  ProviderDisconnectProviderError,
} from "./provider-disconnect.js";

const organizationId = OrganizationIdSchema.parse("71000000-0000-4000-8000-000000000001");
const connectionId = "72000000-0000-4000-8000-000000000001";
const tenant = tenantContextFromMembership({
  id: MembershipIdSchema.parse("73000000-0000-4000-8000-000000000001"),
  organizationId,
  userId: UserIdSchema.parse("74000000-0000-4000-8000-000000000001"),
  role: "administrator",
  status: "active",
});
const input = {
  connectionId,
  confirmConnectionId: connectionId,
  reason: "Operator requested complete provider revocation",
  correlationId: "75000000-0000-4000-8000-000000000001",
} as const;

describe("provider-confirmed disconnect coordinator", () => {
  it("confirms Shopify uninstall before revoking local credentials", async () => {
    const calls: string[] = [];
    const store = storeStub({
      provider: "shopify",
      externalAccountId: "reconai-test.myshopify.com",
      apiCredentialReference: "sealed:76000000-0000-4000-8000-000000000001",
      apiVersion: "2026-07",
    });
    store.disconnect.mockImplementation(async () => {
      calls.push("local");
      return { connectionId, status: "disconnected", revoked: 2 };
    });
    const resolve = vi.fn(async () => "synthetic-shopify-access-token-value");
    const uninstall = vi.fn(async () => {
      calls.push("provider");
    });
    const coordinator = new ProviderDisconnectCoordinator({
      store,
      secrets: { resolve },
      shopify: { client: { uninstall }, apiVersion: "2026-07" },
    });

    await expect(coordinator.disconnect(tenant, input)).resolves.toEqual({
      connectionId,
      provider: "shopify",
      status: "disconnected",
      revoked: 2,
      providerConfirmation: "confirmed",
      replayed: false,
    });
    expect(calls).toEqual(["provider", "local"]);
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, connectionId, provider: "shopify" }),
    );
    expect(uninstall).toHaveBeenCalledWith(
      "reconai-test.myshopify.com",
      "synthetic-shopify-access-token-value",
      "2026-07",
    );
  });

  it("retains local authority when Shopify does not confirm uninstall", async () => {
    const store = storeStub({
      provider: "shopify",
      externalAccountId: "reconai-test.myshopify.com",
      apiCredentialReference: "sealed:76000000-0000-4000-8000-000000000001",
    });
    const coordinator = new ProviderDisconnectCoordinator({
      store,
      secrets: { resolve: async () => "synthetic-shopify-access-token-value" },
      shopify: {
        client: {
          uninstall: async () => {
            throw new Error("synthetic provider outage");
          },
        },
        apiVersion: "2026-07",
      },
    });

    await expect(coordinator.disconnect(tenant, input)).rejects.toBeInstanceOf(
      ProviderDisconnectProviderError,
    );
    expect(store.disconnect).not.toHaveBeenCalled();
  });

  it("stops Stripe reads and returns only the fixed provider uninstall destination", async () => {
    const store = storeStub({
      provider: "stripe",
      externalAccountId: "acct_synthetic",
    });
    store.markProviderActionRequired.mockResolvedValue({
      status: "provider_action_required",
      replayed: false,
    });
    const coordinator = new ProviderDisconnectCoordinator({
      store,
      secrets: { resolve: vi.fn() },
      stripe: { appId: "com.reconai.production" },
    });

    await expect(coordinator.disconnect(tenant, input)).resolves.toEqual({
      connectionId,
      provider: "stripe",
      status: "provider_action_required",
      providerActionUrl: "https://dashboard.stripe.com/settings/apps/com.reconai.production",
      providerConfirmation: "pending",
      replayed: false,
    });
    expect(store.markProviderActionRequired).toHaveBeenCalledWith(tenant, input);
    expect(store.disconnect).not.toHaveBeenCalled();
  });

  it("does not invent provider confirmation for a pre-existing disconnected row", async () => {
    const store = storeStub({
      provider: "shopify",
      externalAccountId: "reconai-test.myshopify.com",
      status: "disconnected",
    });
    const resolve = vi.fn();
    const uninstall = vi.fn();
    const coordinator = new ProviderDisconnectCoordinator({
      store,
      secrets: { resolve },
      shopify: { client: { uninstall }, apiVersion: "2026-07" },
    });

    await expect(coordinator.disconnect(tenant, input)).resolves.toEqual({
      connectionId,
      provider: "shopify",
      status: "disconnected",
      revoked: 0,
      providerConfirmation: "not_recorded",
      replayed: true,
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(uninstall).not.toHaveBeenCalled();
    expect(store.disconnect).not.toHaveBeenCalled();
  });
});

function storeStub(overrides: Partial<ConnectorDisconnectAuthority>): {
  readonly loadDisconnectAuthority: ReturnType<
    typeof vi.fn<ConnectorProviderDisconnectStore["loadDisconnectAuthority"]>
  >;
  readonly markProviderActionRequired: ReturnType<
    typeof vi.fn<ConnectorProviderDisconnectStore["markProviderActionRequired"]>
  >;
  readonly disconnect: ReturnType<typeof vi.fn<ConnectorProviderDisconnectStore["disconnect"]>>;
} {
  const authority: ConnectorDisconnectAuthority = {
    connectionId,
    provider: "stripe",
    externalAccountId: "acct_synthetic",
    status: "healthy",
    ...overrides,
  };
  return {
    loadDisconnectAuthority: vi.fn(async () => authority),
    markProviderActionRequired: vi.fn(async () => ({
      status: "provider_action_required",
      replayed: false,
    })),
    disconnect: vi.fn(async () => ({ connectionId, status: "disconnected", revoked: 1 })),
  };
}
