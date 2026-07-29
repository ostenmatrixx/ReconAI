import { createHmac, timingSafeEqual } from "node:crypto";

import {
  ConnectorError,
  ProviderAuthorizationStateSchema,
  ProviderOAuthTokenBundleSchema,
  type ProviderOAuthTokenBundle,
} from "@workspace/connectors";
import { z } from "zod";

const shopifyDomainSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/u);
const shopifyClientIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,255}$/u);
const shopifyClientSecretSchema = z
  .string()
  .min(16)
  .max(512)
  .refine((value) => !/[\0\r\n]/u.test(value));
const shopifyScopeSchema = z.string().regex(/^read_[a-z0-9_]{1,94}$/u);
const authorizationCodeSchema = z
  .string()
  .min(8)
  .max(1024)
  .refine((value) => !/[\0\r\n]/u.test(value));
const accessTokenSchema = z
  .string()
  .min(16)
  .max(2048)
  .refine((value) => !/[\0\r\n]/u.test(value));
const adminApiVersionSchema = z.string().regex(/^\d{4}-(?:01|04|07|10)$/u);
const callbackTimestampSchema = z.coerce.number().int().positive();
const tokenResponseSchema = z
  .object({
    access_token: z.string().min(16).max(2048),
    refresh_token: z.string().min(16).max(2048),
    expires_in: z.number().int().min(60).max(86_400),
    refresh_token_expires_in: z
      .number()
      .int()
      .min(3600)
      .max(370 * 24 * 60 * 60),
    scope: z.string().min(1).max(5000),
  })
  .strict();
const uninstallResponseSchema = z
  .object({
    data: z
      .object({
        appUninstall: z
          .object({
            userErrors: z
              .array(
                z
                  .object({
                    field: z.array(z.string().max(255)).max(20).nullable().optional(),
                    message: z.string().min(1).max(2000),
                  })
                  .strict(),
              )
              .max(20),
          })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    errors: z
      .array(
        z
          .object({
            message: z.string().min(1).max(2000),
          })
          .loose(),
      )
      .max(20)
      .optional(),
  })
  .loose();

const tokenEndpointMaximumBytes = 64 * 1024;
const graphqlResponseMaximumBytes = 64 * 1024;
const defaultAuthorizationTimeoutMs = 5000;
const uninstallMutation =
  "mutation ReconAiUninstall { appUninstall { userErrors { field message } } }";

export interface ShopifyAuthorizationCallback {
  readonly shop: string;
  readonly code: string;
  readonly state: string;
  readonly timestamp: number;
}

export interface ShopifyAuthorizationClientOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly requiredScopes: readonly string[];
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export class ShopifyAuthorizationClient {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #redirectUri: string;
  readonly #requiredScopes: readonly string[];
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #now: () => Date;

  public constructor(options: ShopifyAuthorizationClientOptions) {
    this.#clientId = shopifyClientIdSchema.parse(options.clientId);
    this.#clientSecret = shopifyClientSecretSchema.parse(options.clientSecret);
    this.#redirectUri = parseExactRedirectUri(options.redirectUri);
    this.#requiredScopes = parseReadOnlyScopes(options.requiredScopes);
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = z
      .number()
      .int()
      .min(100)
      .max(30_000)
      .parse(options.timeoutMs ?? defaultAuthorizationTimeoutMs);
    this.#now = options.now ?? (() => new Date());
  }

  public authorizationUrl(shopInput: string, stateInput: string): URL {
    const shop = parseShopifyDomain(shopInput);
    const state = ProviderAuthorizationStateSchema.parse(stateInput);
    const url = new URL(`https://${shop}/admin/oauth/authorize`);
    url.searchParams.set("client_id", this.#clientId);
    url.searchParams.set("scope", this.#requiredScopes.join(","));
    url.searchParams.set("redirect_uri", this.#redirectUri);
    url.searchParams.set("state", state);
    return url;
  }

  public validateCallback(
    queryInput: URLSearchParams,
    expectedStateInput: string,
    maximumAgeSeconds = 900,
  ): ShopifyAuthorizationCallback {
    const expectedState = ProviderAuthorizationStateSchema.parse(expectedStateInput);
    const maximumAge = z.number().int().min(60).max(3600).parse(maximumAgeSeconds);
    const query = parseUniqueQuery(queryInput);
    const hmac = z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .parse(query.get("hmac"));
    const providedHmac = Buffer.from(hmac, "hex");
    const message = [...query.entries()]
      .filter(([name]) => name !== "hmac" && name !== "signature")
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([name, value]) => `${name}=${value}`)
      .join("&");
    const expectedHmac = createHmac("sha256", this.#clientSecret).update(message).digest();
    if (
      providedHmac.byteLength !== expectedHmac.byteLength ||
      !timingSafeEqual(providedHmac, expectedHmac)
    ) {
      throw new ConnectorError("authentication", "Shopify authorization callback is invalid");
    }

    const state = ProviderAuthorizationStateSchema.parse(query.get("state"));
    const expectedStateBytes = Buffer.from(expectedState, "ascii");
    const stateBytes = Buffer.from(state, "ascii");
    if (
      stateBytes.byteLength !== expectedStateBytes.byteLength ||
      !timingSafeEqual(stateBytes, expectedStateBytes)
    ) {
      throw new ConnectorError("authentication", "Shopify authorization state is invalid");
    }
    const timestamp = callbackTimestampSchema.parse(query.get("timestamp"));
    const ageSeconds = Math.abs(Math.floor(this.#now().getTime() / 1000) - timestamp);
    if (ageSeconds > maximumAge) {
      throw new ConnectorError("authentication", "Shopify authorization callback expired");
    }
    return {
      shop: parseShopifyDomain(query.get("shop")),
      code: authorizationCodeSchema.parse(query.get("code")),
      state,
      timestamp,
    };
  }

  public async exchangeAuthorizationCode(
    callback: ShopifyAuthorizationCallback,
  ): Promise<ProviderOAuthTokenBundle & { readonly provider: "shopify" }> {
    return this.#requestTokenBundle(callback.shop, {
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
      code: authorizationCodeSchema.parse(callback.code),
      expiring: "1",
    });
  }

  public async refresh(
    bundleInput: ProviderOAuthTokenBundle & { readonly provider: "shopify" },
  ): Promise<ProviderOAuthTokenBundle & { readonly provider: "shopify" }> {
    const bundle = ProviderOAuthTokenBundleSchema.parse(bundleInput);
    if (bundle.provider !== "shopify") {
      throw new ConnectorError("authentication", "Shopify refresh received another provider");
    }
    if (Date.parse(bundle.refreshTokenExpiresAt) <= this.#now().getTime()) {
      throw new ConnectorError("authentication", "Shopify refresh token expired");
    }
    return this.#requestTokenBundle(bundle.externalAccountId, {
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
      grant_type: "refresh_token",
      refresh_token: bundle.refreshToken,
    });
  }

  /**
   * Revokes this app's authority at Shopify. This lifecycle-only mutation does not modify merchant
   * financial or operational records and must complete before ReconAI drops its local credential.
   */
  public async uninstall(
    shopInput: string,
    accessTokenInput: string,
    apiVersionInput: string,
  ): Promise<void> {
    const shop = parseShopifyDomain(shopInput);
    const accessToken = accessTokenSchema.parse(accessTokenInput);
    const apiVersion = adminApiVersionSchema.parse(apiVersionInput);
    let response: Response;
    try {
      response = await this.#fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query: uninstallMutation }),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new ConnectorError("timeout", "Shopify uninstall request timed out");
      }
      throw new ConnectorError("provider_unavailable", "Shopify uninstall request failed");
    }
    if (response.status === 429) {
      throw new ConnectorError("rate_limited", "Shopify uninstall request was rate limited");
    }
    if (response.status >= 500) {
      throw new ConnectorError("provider_unavailable", "Shopify uninstall service is unavailable");
    }
    if (!response.ok) {
      throw new ConnectorError("authentication", "Shopify rejected the uninstall request");
    }
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      throw new ConnectorError("invalid_payload", "Shopify returned a non-JSON uninstall response");
    }

    let result: z.infer<typeof uninstallResponseSchema>;
    try {
      result = uninstallResponseSchema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await readBoundedResponse(response, graphqlResponseMaximumBytes),
          ),
        ),
      );
    } catch {
      throw new ConnectorError("invalid_payload", "Shopify returned an invalid uninstall response");
    }
    if (
      (result.errors?.length ?? 0) > 0 ||
      !result.data?.appUninstall ||
      result.data.appUninstall.userErrors.length > 0
    ) {
      throw new ConnectorError("authorization", "Shopify did not confirm app uninstall");
    }
  }

  async #requestTokenBundle(
    shopInput: string,
    fields: Readonly<Record<string, string>>,
  ): Promise<ProviderOAuthTokenBundle & { readonly provider: "shopify" }> {
    const shop = parseShopifyDomain(shopInput);
    let response: Response;
    try {
      response = await this.#fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: {
          Accept: "application/json",
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
        throw new ConnectorError("timeout", "Shopify token request timed out");
      }
      throw new ConnectorError("provider_unavailable", "Shopify token request failed");
    }
    if (response.status === 429) {
      throw new ConnectorError("rate_limited", "Shopify token request was rate limited");
    }
    if (response.status >= 500) {
      throw new ConnectorError("provider_unavailable", "Shopify token service is unavailable");
    }
    if (!response.ok) {
      throw new ConnectorError("authentication", "Shopify rejected the token request");
    }
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      throw new ConnectorError("invalid_payload", "Shopify returned a non-JSON token response");
    }

    const token = parseTokenResponse(
      await readBoundedResponse(response, tokenEndpointMaximumBytes),
      this.#requiredScopes,
    );
    const issuedAt = this.#now();
    return ProviderOAuthTokenBundleSchema.parse({
      schemaVersion: 1,
      credentialType: "oauth_refreshable",
      provider: "shopify",
      externalAccountId: shop,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessTokenExpiresAt: new Date(issuedAt.getTime() + token.expires_in * 1000).toISOString(),
      refreshTokenExpiresAt: new Date(
        issuedAt.getTime() + token.refresh_token_expires_in * 1000,
      ).toISOString(),
      scopes: parseGrantedScopes(token.scope, this.#requiredScopes),
      issuedAt: issuedAt.toISOString(),
    }) as ProviderOAuthTokenBundle & { readonly provider: "shopify" };
  }
}

export function parseShopifyDomain(value: unknown): string {
  const parsed = shopifyDomainSchema.safeParse(
    typeof value === "string" ? value.trim().toLowerCase() : value,
  );
  if (!parsed.success) {
    throw new ConnectorError("terminal", "Shopify account must be a canonical myshopify domain");
  }
  return parsed.data;
}

function parseReadOnlyScopes(input: readonly string[]): readonly string[] {
  const scopes = z.array(shopifyScopeSchema).min(1).max(50).parse(input);
  if (new Set(scopes).size !== scopes.length) {
    throw new TypeError("Shopify required scopes must be unique");
  }
  return Object.freeze([...scopes].sort((left, right) => left.localeCompare(right, "en")));
}

function parseGrantedScopes(value: string, required: readonly string[]): readonly string[] {
  const scopes = z.array(shopifyScopeSchema).min(1).max(50).parse(value.split(","));
  if (new Set(scopes).size !== scopes.length) {
    throw new ConnectorError("authorization", "Shopify returned duplicate scopes");
  }
  const granted = new Set(scopes);
  if (required.some((scope) => !granted.has(scope))) {
    throw new ConnectorError("authorization", "Shopify did not grant every required read scope");
  }
  return Object.freeze([...scopes].sort((left, right) => left.localeCompare(right, "en")));
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
    throw new TypeError("Shopify redirect URI must be a fixed HTTPS URL without credentials/query");
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
      count > 20 ||
      !/^[a-z][a-z0-9_]{0,63}$/u.test(name) ||
      value.length > 4096 ||
      names.has(name)
    ) {
      throw new ConnectorError("authentication", "Shopify authorization query is invalid");
    }
    names.add(name);
    query.append(name, value);
  }
  return query;
}

function parseTokenResponse(
  body: Uint8Array,
  requiredScopes: readonly string[],
): z.infer<typeof tokenResponseSchema> {
  try {
    const token = tokenResponseSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
    );
    parseGrantedScopes(token.scope, requiredScopes);
    return token;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("invalid_payload", "Shopify returned an invalid token response");
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      throw new ConnectorError("invalid_payload", "Shopify token response exceeds policy");
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
        throw new ConnectorError("invalid_payload", "Shopify token response exceeds policy");
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
