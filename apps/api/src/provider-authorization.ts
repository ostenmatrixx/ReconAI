import {
  shopifyMetadata,
  type ShopifyAuthorizationClient,
  type ShopifyAuthorizationCallback,
} from "@workspace/connector-shopify";
import {
  stripeMetadata,
  type StripeAuthorizationClient,
  type StripeAuthorizationCallback,
} from "@workspace/connector-stripe";
import {
  ConnectorError,
  ProviderAuthorizationStateSchema,
  type ConnectorFailureKind,
} from "@workspace/connectors";
import {
  ProviderAuthorizationConflictError,
  type ProviderAuthorizationManager,
  type ProviderAuthorizationProvider,
} from "@workspace/database";
import type { TenantContext } from "@workspace/domain";
import { z } from "zod";

const callbackEntrySchema = z.tuple([
  z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
  z.string().max(4096),
]);
const callbackEntriesSchema = z.array(callbackEntrySchema).min(1).max(20);

interface ProviderAuthorizationConfiguration<TClient> {
  readonly client: TClient;
  readonly apiVersion: string;
}

export interface ProviderAuthorizationCoordinatorOptions {
  readonly manager: ProviderAuthorizationManager;
  readonly shopify?: ProviderAuthorizationConfiguration<ShopifyAuthorizationClient>;
  readonly stripe?: ProviderAuthorizationConfiguration<StripeAuthorizationClient>;
}

export interface ProviderAuthorizationStartResult {
  readonly attemptId: string;
  readonly connectionId: string;
  readonly provider: ProviderAuthorizationProvider;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
  readonly requestedAccountId?: string;
}

export interface ProviderAuthorizationCallbackResult {
  readonly attemptId: string;
  readonly connectionId?: string;
  readonly provider: ProviderAuthorizationProvider;
  readonly status: "succeeded" | "denied";
  readonly replayed: boolean;
  readonly externalAccountId?: string;
}

export interface ProviderAuthorizationFlow {
  start(
    tenant: TenantContext,
    input: {
      readonly provider: ProviderAuthorizationProvider;
      readonly connectionId?: string;
      readonly requestedAccountId?: string;
      readonly correlationId: string;
    },
  ): Promise<ProviderAuthorizationStartResult>;
  callback(
    tenant: TenantContext,
    input: {
      readonly attemptId: string;
      readonly provider: ProviderAuthorizationProvider;
      readonly query: readonly (readonly [string, string])[];
      readonly correlationId: string;
    },
  ): Promise<ProviderAuthorizationCallbackResult>;
}

export class ProviderAuthorizationDisabledError extends Error {
  public constructor() {
    super("provider authorization is not configured");
    this.name = "ProviderAuthorizationDisabledError";
  }
}

export class ProviderAuthorizationProviderError extends Error {
  public constructor(
    public readonly kind: ConnectorFailureKind,
    message = "provider authorization could not be completed",
  ) {
    super(message);
    this.name = "ProviderAuthorizationProviderError";
  }
}

export class ProviderAuthorizationCoordinator implements ProviderAuthorizationFlow {
  public constructor(private readonly options: ProviderAuthorizationCoordinatorOptions) {}

  public async start(
    tenant: TenantContext,
    input: {
      readonly provider: ProviderAuthorizationProvider;
      readonly connectionId?: string;
      readonly requestedAccountId?: string;
      readonly correlationId: string;
    },
  ): Promise<ProviderAuthorizationStartResult> {
    if (input.provider === "shopify") {
      const configuration = this.options.shopify;
      if (!configuration) throw new ProviderAuthorizationDisabledError();
      const started = await this.options.manager.begin(tenant, {
        provider: "shopify",
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        ...(input.requestedAccountId ? { requestedAccountId: input.requestedAccountId } : {}),
        connectorVersion: shopifyMetadata.connectorVersion,
        apiVersion: configuration.apiVersion,
        correlationId: input.correlationId,
      });
      if (!started.requestedAccountId) {
        throw new ProviderAuthorizationConflictError(
          "a canonical Shopify shop is required to begin authorization",
        );
      }
      return {
        attemptId: started.attemptId,
        connectionId: started.connectionId,
        provider: started.provider,
        authorizationUrl: configuration.client
          .authorizationUrl(started.requestedAccountId, started.state)
          .toString(),
        expiresAt: started.expiresAt,
        requestedAccountId: started.requestedAccountId,
      };
    }

    const configuration = this.options.stripe;
    if (!configuration) throw new ProviderAuthorizationDisabledError();
    const started = await this.options.manager.begin(tenant, {
      provider: "stripe",
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(input.requestedAccountId ? { requestedAccountId: input.requestedAccountId } : {}),
      connectorVersion: stripeMetadata.connectorVersion,
      apiVersion: configuration.apiVersion,
      correlationId: input.correlationId,
    });
    return {
      attemptId: started.attemptId,
      connectionId: started.connectionId,
      provider: started.provider,
      authorizationUrl: configuration.client.authorizationUrl(started.state).toString(),
      expiresAt: started.expiresAt,
      ...(started.requestedAccountId ? { requestedAccountId: started.requestedAccountId } : {}),
    };
  }

  public async callback(
    tenant: TenantContext,
    input: {
      readonly attemptId: string;
      readonly provider: ProviderAuthorizationProvider;
      readonly query: readonly (readonly [string, string])[];
      readonly correlationId: string;
    },
  ): Promise<ProviderAuthorizationCallbackResult> {
    const entries = callbackEntriesSchema.parse(input.query);
    const query = new URLSearchParams(entries);
    if (input.provider === "stripe" && query.get("error") !== null) {
      return this.denyStripe(tenant, {
        attemptId: input.attemptId,
        query,
        correlationId: input.correlationId,
      });
    }

    let callback: ShopifyAuthorizationCallback | StripeAuthorizationCallback;
    try {
      callback =
        input.provider === "shopify"
          ? this.requireShopify().client.validateCallback(query, requireUniqueState(entries))
          : this.requireStripe().client.validateCallback(query, requireUniqueState(entries));
    } catch (error) {
      throw providerError(error);
    }
    const claimed = await this.options.manager.claim(tenant, {
      attemptId: input.attemptId,
      provider: input.provider,
      state: callback.state,
    });
    if (claimed.kind === "replayed") {
      return {
        attemptId: claimed.attemptId,
        connectionId: claimed.connectionId,
        provider: claimed.provider,
        status: "succeeded",
        replayed: true,
      };
    }

    if (
      input.provider === "shopify" &&
      "shop" in callback &&
      claimed.claim.requestedAccountId !== callback.shop
    ) {
      await this.options.manager.fail(tenant, {
        claim: claimed.claim,
        errorCode: "PROVIDER_ACCOUNT_MISMATCH",
        correlationId: input.correlationId,
      });
      throw new ProviderAuthorizationProviderError(
        "authentication",
        "provider account did not match the authorization request",
      );
    }

    let tokenBundle;
    try {
      tokenBundle =
        input.provider === "shopify"
          ? await this.requireShopify().client.exchangeAuthorizationCode(
              callback as ShopifyAuthorizationCallback,
            )
          : await this.requireStripe().client.exchangeAuthorizationCode(callback);
    } catch (error) {
      const failure = providerError(error);
      await this.options.manager.fail(tenant, {
        claim: claimed.claim,
        errorCode: providerFailureCode(failure.kind),
        correlationId: input.correlationId,
      });
      throw failure;
    }

    const completed = await this.options.manager.complete(tenant, {
      claim: claimed.claim,
      tokenBundle,
      correlationId: input.correlationId,
    });
    return {
      attemptId: completed.attemptId,
      connectionId: completed.connectionId,
      provider: completed.provider,
      status: "succeeded",
      replayed: false,
      externalAccountId: completed.externalAccountId,
    };
  }

  private async denyStripe(
    tenant: TenantContext,
    input: {
      readonly attemptId: string;
      readonly query: URLSearchParams;
      readonly correlationId: string;
    },
  ): Promise<ProviderAuthorizationCallbackResult> {
    const query = parseStripeDenial(input.query);
    const denied = await this.options.manager.deny(tenant, {
      attemptId: input.attemptId,
      provider: "stripe",
      state: query.state,
      errorCode: query.error === "access_denied" ? "PROVIDER_ACCESS_DENIED" : "PROVIDER_DENIED",
      correlationId: input.correlationId,
    });
    return {
      attemptId: denied.attemptId,
      provider: "stripe",
      status: denied.status,
      replayed: denied.status === "succeeded",
    };
  }

  private requireShopify(): NonNullable<ProviderAuthorizationCoordinatorOptions["shopify"]> {
    if (!this.options.shopify) throw new ProviderAuthorizationDisabledError();
    return this.options.shopify;
  }

  private requireStripe(): NonNullable<ProviderAuthorizationCoordinatorOptions["stripe"]> {
    if (!this.options.stripe) throw new ProviderAuthorizationDisabledError();
    return this.options.stripe;
  }
}

function requireUniqueState(entries: readonly (readonly [string, string])[]): string {
  const states = entries.filter(([name]) => name === "state");
  if (states.length !== 1) {
    throw new ConnectorError("authentication", "provider authorization state is invalid");
  }
  return ProviderAuthorizationStateSchema.parse(states[0]?.[1]);
}

function parseStripeDenial(query: URLSearchParams): {
  readonly state: string;
  readonly error: string;
} {
  const entries = [...query.entries()];
  const names = new Set<string>();
  for (const [name] of entries) {
    if (names.has(name) || !["state", "error", "error_description"].includes(name)) {
      throw new ProviderAuthorizationProviderError(
        "authentication",
        "provider denial callback is invalid",
      );
    }
    names.add(name);
  }
  const state = ProviderAuthorizationStateSchema.safeParse(query.get("state"));
  const error = z
    .string()
    .regex(/^[a-z_]{1,100}$/u)
    .safeParse(query.get("error"));
  if (!state.success || !error.success) {
    throw new ProviderAuthorizationProviderError(
      "authentication",
      "provider denial callback is invalid",
    );
  }
  return { state: state.data, error: error.data };
}

function providerError(error: unknown): ProviderAuthorizationProviderError {
  return error instanceof ConnectorError
    ? new ProviderAuthorizationProviderError(error.kind)
    : new ProviderAuthorizationProviderError("provider_unavailable");
}

function providerFailureCode(kind: ConnectorFailureKind): string {
  return `PROVIDER_${kind.toUpperCase()}`;
}
