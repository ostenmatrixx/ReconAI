import { timingSafeEqual } from "node:crypto";

import {
  ConnectorError,
  ProviderAuthorizationStateSchema,
  ProviderOAuthTokenBundleSchema,
  type ProviderOAuthTokenBundle,
} from "@workspace/connectors";
import { z } from "zod";

const stripeOAuthClientIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,255}$/u);
const stripeSecretKeySchema = z
  .string()
  .min(16)
  .max(512)
  .refine((value) => !/[\0\r\n]/u.test(value));
const stripeAuthorizationCodeSchema = z
  .string()
  .min(8)
  .max(1024)
  .refine((value) => !/[\0\r\n]/u.test(value));
const stripeAccountSchema = z.string().regex(/^acct_[A-Za-z0-9]{1,250}$/u);
const stripeTokenResponseBaseShape = {
  access_token: z.string().min(16).max(2048),
  refresh_token: z.string().min(16).max(2048),
  scope: z.literal("stripe_apps"),
  token_type: z.literal("bearer"),
  livemode: z.boolean(),
  stripe_publishable_key: z.string().min(8).max(512).optional(),
} as const;
const stripeAuthorizationTokenResponseSchema = z
  .object({
    ...stripeTokenResponseBaseShape,
    stripe_user_id: stripeAccountSchema,
  })
  .strict();
const stripeRefreshTokenResponseSchema = z
  .object({
    ...stripeTokenResponseBaseShape,
    account_id: stripeAccountSchema,
  })
  .strict();
const stripeGrantTypeSchema = z.enum(["authorization_code", "refresh_token"]);

const stripeTokenEndpoint = "https://api.stripe.com/v1/oauth/token";
const stripeAuthorizationEndpoint = "https://marketplace.stripe.com/oauth/v2/authorize";
const tokenEndpointMaximumBytes = 64 * 1024;
const defaultAuthorizationTimeoutMs = 5000;
const stripeAccessTokenLifetimeMs = 60 * 60 * 1000;
const stripeRefreshTokenLifetimeMs = 365 * 24 * 60 * 60 * 1000;

export interface StripeAuthorizationCallback {
  readonly code: string;
  readonly state: string;
}

export interface StripeAuthorizationClientOptions {
  readonly clientId: string;
  readonly secretKey: string;
  readonly redirectUri: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export class StripeAuthorizationClient {
  readonly #clientId: string;
  readonly #secretKey: string;
  readonly #redirectUri: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #now: () => Date;

  public constructor(options: StripeAuthorizationClientOptions) {
    this.#clientId = stripeOAuthClientIdSchema.parse(options.clientId);
    this.#secretKey = stripeSecretKeySchema.parse(options.secretKey);
    this.#redirectUri = parseExactRedirectUri(options.redirectUri);
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = z
      .number()
      .int()
      .min(100)
      .max(30_000)
      .parse(options.timeoutMs ?? defaultAuthorizationTimeoutMs);
    this.#now = options.now ?? (() => new Date());
  }

  public authorizationUrl(stateInput: string): URL {
    const state = ProviderAuthorizationStateSchema.parse(stateInput);
    const url = new URL(stripeAuthorizationEndpoint);
    url.searchParams.set("client_id", this.#clientId);
    url.searchParams.set("redirect_uri", this.#redirectUri);
    url.searchParams.set("state", state);
    return url;
  }

  public validateCallback(
    queryInput: URLSearchParams,
    expectedStateInput: string,
  ): StripeAuthorizationCallback {
    const expectedState = ProviderAuthorizationStateSchema.parse(expectedStateInput);
    const query = parseUniqueQuery(queryInput);
    const state = ProviderAuthorizationStateSchema.parse(query.get("state"));
    const expectedStateBytes = Buffer.from(expectedState, "ascii");
    const stateBytes = Buffer.from(state, "ascii");
    if (
      stateBytes.byteLength !== expectedStateBytes.byteLength ||
      !timingSafeEqual(stateBytes, expectedStateBytes)
    ) {
      throw new ConnectorError("authentication", "Stripe authorization state is invalid");
    }
    const providerError = query.get("error");
    if (providerError !== null) {
      const error = z
        .string()
        .regex(/^[a-z_]{1,100}$/u)
        .parse(providerError);
      throw new ConnectorError(
        error === "access_denied" ? "authorization" : "authentication",
        "Stripe authorization was not completed",
      );
    }
    return {
      code: stripeAuthorizationCodeSchema.parse(query.get("code")),
      state,
    };
  }

  public async exchangeAuthorizationCode(
    callback: StripeAuthorizationCallback,
  ): Promise<ProviderOAuthTokenBundle & { readonly provider: "stripe" }> {
    return this.#requestTokenBundle({
      code: stripeAuthorizationCodeSchema.parse(callback.code),
      grant_type: "authorization_code",
    });
  }

  public async refresh(
    bundleInput: ProviderOAuthTokenBundle & { readonly provider: "stripe" },
  ): Promise<ProviderOAuthTokenBundle & { readonly provider: "stripe" }> {
    const bundle = ProviderOAuthTokenBundleSchema.parse(bundleInput);
    if (bundle.provider !== "stripe") {
      throw new ConnectorError("authentication", "Stripe refresh received another provider");
    }
    if (Date.parse(bundle.refreshTokenExpiresAt) <= this.#now().getTime()) {
      throw new ConnectorError("authentication", "Stripe refresh token expired");
    }
    const refreshed = await this.#requestTokenBundle(
      {
        refresh_token: bundle.refreshToken,
        grant_type: "refresh_token",
      },
      bundle.authorizationGrantedAt,
    );
    if (
      refreshed.externalAccountId !== bundle.externalAccountId ||
      refreshed.livemode !== bundle.livemode
    ) {
      throw new ConnectorError("authentication", "Stripe refresh changed account authority");
    }
    return refreshed;
  }

  async #requestTokenBundle(
    fields: Readonly<Record<string, string>>,
    authorizationGrantedAtInput?: string,
  ): Promise<ProviderOAuthTokenBundle & { readonly provider: "stripe" }> {
    const grantType = stripeGrantTypeSchema.parse(fields["grant_type"]);
    let response: Response;
    try {
      response = await this.#fetch(stripeTokenEndpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(`${this.#secretKey}:`, "utf8").toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(fields),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new ConnectorError("timeout", "Stripe token request timed out");
      }
      throw new ConnectorError("provider_unavailable", "Stripe token request failed");
    }
    if (response.status === 429) {
      throw new ConnectorError("rate_limited", "Stripe token request was rate limited");
    }
    if (response.status >= 500) {
      throw new ConnectorError("provider_unavailable", "Stripe token service is unavailable");
    }
    if (!response.ok) {
      throw new ConnectorError("authentication", "Stripe rejected the token request");
    }
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      throw new ConnectorError("invalid_payload", "Stripe returned a non-JSON token response");
    }

    const token = parseTokenResponse(
      await readBoundedResponse(response, tokenEndpointMaximumBytes),
      grantType,
    );
    const issuedAt = this.#now();
    const authorizationGrantedAt = authorizationGrantedAtInput
      ? z.iso.datetime({ offset: true }).parse(authorizationGrantedAtInput)
      : issuedAt.toISOString();
    return ProviderOAuthTokenBundleSchema.parse({
      schemaVersion: 1,
      credentialType: "oauth_refreshable",
      provider: "stripe",
      externalAccountId: token.accountId,
      livemode: token.livemode,
      authorizationGrantedAt,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessTokenExpiresAt: new Date(
        issuedAt.getTime() + stripeAccessTokenLifetimeMs,
      ).toISOString(),
      refreshTokenExpiresAt: new Date(
        issuedAt.getTime() + stripeRefreshTokenLifetimeMs,
      ).toISOString(),
      scopes: [token.scope],
      issuedAt: issuedAt.toISOString(),
    }) as ProviderOAuthTokenBundle & { readonly provider: "stripe" };
  }
}

function parseExactRedirectUri(value: string): string {
  const url = new URL(z.url().parse(value));
  if (
    (url.protocol !== "https:" && url.hostname !== "localhost") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Stripe redirect URI must be a fixed HTTPS URL without credentials/query");
  }
  return url.toString();
}

function parseUniqueQuery(input: URLSearchParams): URLSearchParams {
  const query = new URLSearchParams();
  const names = new Set<string>();
  let count = 0;
  for (const [name, value] of input) {
    count += 1;
    if (
      count > 10 ||
      !/^[a-z][a-z0-9_]{0,63}$/u.test(name) ||
      value.length > 4096 ||
      names.has(name)
    ) {
      throw new ConnectorError("authentication", "Stripe authorization query is invalid");
    }
    names.add(name);
    query.append(name, value);
  }
  return query;
}

function parseTokenResponse(body: Uint8Array, grantType: z.infer<typeof stripeGrantTypeSchema>) {
  try {
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (grantType === "authorization_code") {
      const token = stripeAuthorizationTokenResponseSchema.parse(decoded);
      return { ...token, accountId: token.stripe_user_id };
    }
    const token = stripeRefreshTokenResponseSchema.parse(decoded);
    return { ...token, accountId: token.account_id };
  } catch {
    throw new ConnectorError("invalid_payload", "Stripe returned an invalid token response");
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      throw new ConnectorError("invalid_payload", "Stripe token response exceeds policy");
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ConnectorError("invalid_payload", "Stripe token response exceeds policy");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
