import { createHash } from "node:crypto";

import { verifyShopifyWebhook } from "@workspace/connector-shopify";
import { z } from "zod";

import {
  PROVIDER_WEBHOOK_MAXIMUM_BYTES,
  ProviderWebhookAuthenticationError,
  ProviderWebhookValidationError,
} from "./provider-webhooks.js";

export const ShopifyPrivacyTopicSchema = z.enum([
  "customers/data_request",
  "customers/redact",
  "shop/redact",
]);
export type ShopifyPrivacyTopic = z.infer<typeof ShopifyPrivacyTopicSchema>;

const shopifyDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/u);
const shopifyIdentifierSchema = z
  .union([z.string().regex(/^[0-9]{1,40}$/u), z.number().int().nonnegative()])
  .transform(String);
const shopifyWebhookIdSchema = z.string().regex(/^[A-Za-z0-9._:/-]{1,255}$/u);
const shopifyApiVersionSchema = z.string().regex(/^\d{4}-(?:01|04|07|10)$/u);
const signingSecretSchema = z
  .string()
  .min(16)
  .max(512)
  .refine((value) => !/[\0\r\n]/u.test(value));
const maximumOrderIdentifiers = 10_000;

const shopIdentityFields = {
  shop_id: shopifyIdentifierSchema,
  shop_domain: shopifyDomainSchema,
} as const;

const dataRequestPayloadSchema = z
  .object({
    ...shopIdentityFields,
    orders_requested: z.array(shopifyIdentifierSchema).max(maximumOrderIdentifiers),
    customer: z
      .object({
        id: shopifyIdentifierSchema,
      })
      .loose(),
    data_request: z
      .object({
        id: shopifyIdentifierSchema,
      })
      .loose(),
  })
  .loose();

const customerRedactionPayloadSchema = z
  .object({
    ...shopIdentityFields,
    orders_to_redact: z.array(shopifyIdentifierSchema).max(maximumOrderIdentifiers),
    customer: z
      .object({
        id: shopifyIdentifierSchema,
      })
      .loose(),
  })
  .loose();

const shopRedactionPayloadSchema = z.object(shopIdentityFields).strict();

export interface ShopifyPrivacyRequestRecord {
  readonly provider: "shopify";
  readonly externalEventId: string;
  readonly topic: ShopifyPrivacyTopic;
  readonly apiVersion: string;
  readonly shopId: string;
  readonly shopDomain: string;
  readonly customerId?: string;
  readonly externalRequestId?: string;
  readonly orderIds: readonly string[];
  readonly payloadSha256: string;
  readonly receivedAt: string;
  readonly dueAt: string;
  readonly correlationId: string;
}

export interface ShopifyPrivacyRequestRepository {
  recordShopifyPrivacyRequest(
    record: ShopifyPrivacyRequestRecord,
  ): Promise<{ readonly matched: boolean; readonly duplicate: boolean }>;
}

export interface ShopifyPrivacyWebhookResult {
  readonly eventId: string;
  readonly status: "accepted";
  readonly duplicate: boolean;
}

/**
 * Authenticates Shopify's app-level mandatory privacy webhook before resolving any tenant. The
 * persisted record deliberately excludes email and phone fields present in Shopify's payload.
 */
export class ShopifyPrivacyWebhookService {
  readonly #signingSecret: string;
  readonly #configuredApiVersion: string;
  readonly #now: () => Date;

  public constructor(
    private readonly repository: ShopifyPrivacyRequestRepository,
    signingSecretInput: string,
    configuredApiVersionInput: string,
    now: () => Date = () => new Date(),
  ) {
    this.#signingSecret = signingSecretSchema.parse(signingSecretInput);
    this.#configuredApiVersion = shopifyApiVersionSchema.parse(configuredApiVersionInput);
    this.#now = now;
  }

  public async receive(input: {
    readonly rawBody: Uint8Array;
    readonly hmac: string;
    readonly webhookId: string;
    readonly topic: string;
    readonly apiVersion: string;
    readonly shopDomain: string;
    readonly correlationId: string;
  }): Promise<ShopifyPrivacyWebhookResult> {
    const rawBody = parseRawBody(input.rawBody);
    const hmac = z.string().min(1).max(512).parse(input.hmac);
    if (!verifyShopifyWebhook(rawBody, hmac, this.#signingSecret)) {
      throw new ProviderWebhookAuthenticationError();
    }

    const externalEventId = shopifyWebhookIdSchema.parse(input.webhookId);
    const topic = ShopifyPrivacyTopicSchema.parse(input.topic.trim().toLowerCase());
    const apiVersion = shopifyApiVersionSchema.parse(input.apiVersion);
    const headerShopDomain = shopifyDomainSchema.parse(input.shopDomain);
    const correlationId = z.uuid().parse(input.correlationId);
    if (apiVersion !== this.#configuredApiVersion) {
      throw new ProviderWebhookValidationError(
        "Shopify privacy webhook API version is not configured",
      );
    }

    const payload = parseJson(rawBody);
    const identity = parsePrivacyIdentity(topic, payload);
    if (identity.shopDomain !== headerShopDomain) {
      throw new ProviderWebhookValidationError(
        "Shopify privacy webhook shop identity is inconsistent",
      );
    }
    const receivedAt = this.#now().toISOString();
    const dueAt = new Date(Date.parse(receivedAt) + 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = await this.repository.recordShopifyPrivacyRequest({
      provider: "shopify",
      externalEventId,
      topic,
      apiVersion,
      shopId: identity.shopId,
      shopDomain: identity.shopDomain,
      ...(identity.customerId ? { customerId: identity.customerId } : {}),
      ...(identity.externalRequestId ? { externalRequestId: identity.externalRequestId } : {}),
      orderIds: identity.orderIds,
      payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
      receivedAt,
      dueAt,
      correlationId,
    });
    return {
      eventId: externalEventId,
      status: "accepted",
      duplicate: result.duplicate,
    };
  }
}

function parsePrivacyIdentity(
  topic: ShopifyPrivacyTopic,
  payload: unknown,
): {
  readonly shopId: string;
  readonly shopDomain: string;
  readonly customerId?: string;
  readonly externalRequestId?: string;
  readonly orderIds: readonly string[];
} {
  if (topic === "customers/data_request") {
    const value = dataRequestPayloadSchema.parse(payload);
    return {
      shopId: value.shop_id,
      shopDomain: value.shop_domain,
      customerId: value.customer.id,
      externalRequestId: value.data_request.id,
      orderIds: uniqueIdentifiers(value.orders_requested),
    };
  }
  if (topic === "customers/redact") {
    const value = customerRedactionPayloadSchema.parse(payload);
    return {
      shopId: value.shop_id,
      shopDomain: value.shop_domain,
      customerId: value.customer.id,
      orderIds: uniqueIdentifiers(value.orders_to_redact),
    };
  }
  const value = shopRedactionPayloadSchema.parse(payload);
  return {
    shopId: value.shop_id,
    shopDomain: value.shop_domain,
    orderIds: [],
  };
}

function uniqueIdentifiers(values: readonly string[]): readonly string[] {
  const unique = [...new Set(values)];
  if (unique.length !== values.length) {
    throw new ProviderWebhookValidationError(
      "Shopify privacy webhook contains duplicate order identifiers",
    );
  }
  return unique;
}

function parseRawBody(value: Uint8Array): Uint8Array {
  if (value.byteLength < 1 || value.byteLength > PROVIDER_WEBHOOK_MAXIMUM_BYTES) {
    throw new ProviderWebhookValidationError(
      "Shopify privacy webhook body is outside the byte limit",
    );
  }
  return value;
}

function parseJson(rawBody: Uint8Array): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderWebhookValidationError(
      "Shopify privacy webhook body is not valid UTF-8 JSON",
    );
  }
}
