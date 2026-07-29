import type { ShopifyAuthorizationClient } from "@workspace/connector-shopify";
import {
  ConnectorError,
  type ConnectorFailureKind,
  type ConnectorSecretResolver,
} from "@workspace/connectors";
import {
  ConnectorCredentialConflictError,
  type ConnectorProviderDisconnectStore,
} from "@workspace/database";
import type { TenantContext } from "@workspace/domain";
import { z } from "zod";

const stripeAppIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/u);

export type ProviderDisconnectResult =
  | {
      readonly connectionId: string;
      readonly provider: "shopify" | "stripe";
      readonly status: "disconnected";
      readonly revoked: number;
      readonly providerConfirmation: "confirmed" | "not_recorded";
      readonly replayed: boolean;
    }
  | {
      readonly connectionId: string;
      readonly provider: "stripe";
      readonly status: "provider_action_required";
      readonly providerActionUrl: string;
      readonly providerConfirmation: "pending";
      readonly replayed: boolean;
    };

export interface ProviderDisconnectFlow {
  disconnect(
    tenant: TenantContext,
    input: {
      readonly connectionId: string;
      readonly confirmConnectionId: string;
      readonly reason: string;
      readonly correlationId: string;
    },
  ): Promise<ProviderDisconnectResult>;
}

export interface ProviderDisconnectCoordinatorOptions {
  readonly store: ConnectorProviderDisconnectStore;
  readonly secrets: ConnectorSecretResolver;
  readonly shopify?: {
    readonly client: Pick<ShopifyAuthorizationClient, "uninstall">;
    readonly apiVersion: string;
  };
  readonly stripe?: {
    readonly appId: string;
  };
}

export class ProviderDisconnectDisabledError extends Error {
  public constructor() {
    super("provider disconnect is not configured");
    this.name = "ProviderDisconnectDisabledError";
  }
}

export class ProviderDisconnectProviderError extends Error {
  public constructor(public readonly kind: ConnectorFailureKind) {
    super("provider disconnect could not be confirmed");
    this.name = "ProviderDisconnectProviderError";
  }
}

export class ProviderDisconnectCoordinator implements ProviderDisconnectFlow {
  readonly #stripeSettingsUrl?: string;

  public constructor(private readonly options: ProviderDisconnectCoordinatorOptions) {
    if (options.stripe) {
      const appId = stripeAppIdSchema.parse(options.stripe.appId);
      this.#stripeSettingsUrl = `https://dashboard.stripe.com/settings/apps/${encodeURIComponent(appId)}`;
    }
  }

  public async disconnect(
    tenant: TenantContext,
    input: {
      readonly connectionId: string;
      readonly confirmConnectionId: string;
      readonly reason: string;
      readonly correlationId: string;
    },
  ): Promise<ProviderDisconnectResult> {
    const connectionId = z.uuid().parse(input.connectionId);
    if (connectionId !== z.uuid().parse(input.confirmConnectionId)) {
      throw new ConnectorCredentialConflictError(
        "connection confirmation does not match the disconnect target",
      );
    }
    const authority = await this.options.store.loadDisconnectAuthority(tenant, connectionId);
    if (authority.status === "disconnected") {
      return {
        connectionId,
        provider: authority.provider,
        status: "disconnected",
        revoked: 0,
        providerConfirmation: "not_recorded",
        replayed: true,
      };
    }

    if (authority.provider === "stripe") {
      if (!this.#stripeSettingsUrl) throw new ProviderDisconnectDisabledError();
      const marked = await this.options.store.markProviderActionRequired(tenant, input);
      if (marked.status === "disconnected") {
        return {
          connectionId,
          provider: "stripe",
          status: "disconnected",
          revoked: 0,
          providerConfirmation: "not_recorded",
          replayed: true,
        };
      }
      return {
        connectionId,
        provider: "stripe",
        status: "provider_action_required",
        providerActionUrl: this.#stripeSettingsUrl,
        providerConfirmation: "pending",
        replayed: marked.replayed,
      };
    }

    const configuration = this.options.shopify;
    if (!configuration) throw new ProviderDisconnectDisabledError();
    if (!authority.apiCredentialReference) {
      throw new ConnectorCredentialConflictError(
        "Shopify connection has no active read credential to revoke",
      );
    }
    let accessToken: string;
    try {
      accessToken = await this.options.secrets.resolve({
        reference: authority.apiCredentialReference,
        organizationId: tenant.organizationId,
        connectionId,
        provider: "shopify",
        purpose: "api_read",
      });
      await configuration.client.uninstall(
        authority.externalAccountId,
        accessToken,
        authority.apiVersion ?? configuration.apiVersion,
      );
    } catch (error) {
      throw new ProviderDisconnectProviderError(
        error instanceof ConnectorError ? error.kind : "provider_unavailable",
      );
    }
    const disconnected = await this.options.store.disconnect(tenant, input);
    return {
      connectionId,
      provider: "shopify",
      status: "disconnected",
      revoked: disconnected.revoked,
      providerConfirmation: "confirmed",
      replayed: false,
    };
  }
}
