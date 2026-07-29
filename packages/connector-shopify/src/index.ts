import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  CanonicalRecordIdSchema,
  SourceEventIdSchema,
  asCurrency,
  parseMoneyDecimal,
  type CanonicalRecord,
  type OrderRecord,
  type OrganizationId,
  type RefundRecord,
} from "@workspace/domain";
import type {
  ConnectorMetadata,
  ConnectorSecretResolver,
  ProviderPage,
  ProviderPageRequest,
  ProviderPageSource,
  WebhookReceipt,
} from "@workspace/connectors";
import { ConnectorError } from "@workspace/connectors";
import { z } from "zod";

export * from "./authorization.js";

export const shopifyMetadata: ConnectorMetadata = {
  name: "shopify",
  connectorVersion: "1.0.0",
  normalizerVersion: "1.1.0",
  readOnly: true,
};

const shopifyMoneySchema = z.object({
  amount: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u),
  currency_code: z.string().length(3),
});

const shopifyGraphqlMoneySchema = z
  .object({
    amount: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u),
    currencyCode: z.string().length(3),
  })
  .strict();
const shopifyGraphqlIdSchema = z.string().regex(/^gid:\/\/shopify\/[A-Za-z]+\/[0-9]+$/u);
const shopifyLegacyIdSchema = z
  .union([z.string().regex(/^[0-9]{1,40}$/u), z.number().int().nonnegative()])
  .transform(String);
const shopifyApiVersionSchema = z.string().regex(/^\d{4}-(?:01|04|07|10)$/u);
const shopifyDomainSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/u);
const shopifyCursorSchema = z.string().min(1).max(1024);
const maximumShopifyPageBytes = 2 * 1024 * 1024;
const maximumShopifyItemBytes = 1024 * 1024;
const maximumShopifyWindowMs = 30 * 24 * 60 * 60 * 1000;
const defaultShopifyRequestTimeoutMs = 10_000;

export const ShopifyOrderWebhookSchema = z.object({
  id: z.union([z.string(), z.number().int().nonnegative()]).transform(String),
  name: z.string().min(1).max(255),
  email: z.email().optional().nullable(),
  processed_at: z.iso.datetime({ offset: true }),
  financial_status: z.enum(["paid", "partially_refunded", "refunded", "pending", "voided"]),
  current_total_price_set: z.object({ shop_money: shopifyMoneySchema }),
});

export const ShopifyRefundWebhookSchema = z.object({
  id: z.union([z.string(), z.number().int().nonnegative()]).transform(String),
  order_id: z.union([z.string(), z.number().int().nonnegative()]).transform(String),
  created_at: z.iso.datetime({ offset: true }),
  transactions: z
    .array(
      z.object({
        id: z.union([z.string(), z.number().int().nonnegative()]).transform(String),
        amount: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u),
        currency: z.string().length(3),
        status: z.enum(["success", "pending", "failure", "error"]),
        gateway: z.string().max(100).optional(),
      }),
    )
    .min(1)
    .max(100),
});

const shopifyGraphqlTransactionSchema = z
  .object({
    id: shopifyGraphqlIdSchema,
    amountSet: z.object({ shopMoney: shopifyGraphqlMoneySchema }).strict(),
    status: z.enum(["AWAITING_RESPONSE", "ERROR", "FAILURE", "PENDING", "SUCCESS", "UNKNOWN"]),
    gateway: z.string().max(100).nullable().optional(),
    processedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();

const shopifyGraphqlRefundSchema = z
  .object({
    id: shopifyGraphqlIdSchema,
    legacyResourceId: shopifyLegacyIdSchema,
    createdAt: z.iso.datetime({ offset: true }).nullable().optional(),
    processedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    transactions: z
      .object({
        nodes: z.array(shopifyGraphqlTransactionSchema).max(100),
        pageInfo: z.object({ hasNextPage: z.boolean() }).strict(),
      })
      .strict(),
  })
  .strict();

export const ShopifyOrderSnapshotSchema = z
  .object({
    id: shopifyGraphqlIdSchema,
    legacyResourceId: shopifyLegacyIdSchema,
    name: z.string().min(1).max(255),
    processedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    displayFinancialStatus: z
      .enum([
        "AUTHORIZED",
        "EXPIRED",
        "PAID",
        "PARTIALLY_PAID",
        "PARTIALLY_REFUNDED",
        "PENDING",
        "REFUNDED",
        "VOIDED",
      ])
      .nullable(),
    currentTotalPriceSet: z.object({ shopMoney: shopifyGraphqlMoneySchema }).strict(),
    refunds: z.array(shopifyGraphqlRefundSchema).max(100),
  })
  .strict();

export const ShopifyOrderSnapshotEnvelopeSchema = z
  .object({
    apiVersion: shopifyApiVersionSchema,
    order: ShopifyOrderSnapshotSchema,
  })
  .strict();

export type ShopifyOrderSnapshotEnvelope = z.infer<typeof ShopifyOrderSnapshotEnvelopeSchema>;

const shopifyGraphqlResponseSchema = z
  .object({
    data: z
      .object({
        orders: z
          .object({
            edges: z
              .array(
                z
                  .object({
                    cursor: shopifyCursorSchema,
                    node: ShopifyOrderSnapshotSchema,
                  })
                  .strict(),
              )
              .max(100),
            pageInfo: z
              .object({
                hasNextPage: z.boolean(),
                endCursor: shopifyCursorSchema.nullable(),
              })
              .strict(),
          })
          .strict(),
      })
      .strict()
      .nullable()
      .optional(),
    errors: z
      .array(
        z.looseObject({
          message: z.string().max(2000),
          extensions: z.looseObject({ code: z.string().min(1).max(100).optional() }).optional(),
        }),
      )
      .max(20)
      .optional(),
    extensions: z
      .object({
        cost: z
          .object({
            requestedQueryCost: z.number().nonnegative(),
            actualQueryCost: z.number().nonnegative().nullable(),
            throttleStatus: z
              .object({
                maximumAvailable: z.number().nonnegative(),
                currentlyAvailable: z.number().nonnegative(),
                restoreRate: z.number().positive(),
              })
              .strict(),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();

const shopifyOrdersQuery = `#graphql
  query ReconaiOrderSnapshots($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      edges {
        cursor
        node {
          id
          legacyResourceId
          name
          processedAt
          updatedAt
          displayFinancialStatus
          currentTotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          refunds {
            id
            legacyResourceId
            createdAt
            processedAt
            updatedAt
            transactions(first: 100) {
              nodes {
                id
                amountSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                status
                gateway
                processedAt
              }
              pageInfo {
                hasNextPage
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export interface ShopifyOrderPageSourceOptions {
  readonly secrets: ConnectorSecretResolver;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class ShopifyOrderPageSource implements ProviderPageSource {
  public readonly provider = "shopify" as const;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  public constructor(private readonly options: ShopifyOrderPageSourceOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? defaultShopifyRequestTimeoutMs;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 100 ||
      this.#timeoutMs > 60_000
    ) {
      throw new TypeError("Shopify request timeout must be between 100 and 60000 milliseconds");
    }
  }

  public async fetchPage(request: ProviderPageRequest): Promise<ProviderPage> {
    if (request.provider !== "shopify") {
      throw new ConnectorError("terminal", "Shopify page source received another provider");
    }
    z.uuid().parse(request.connectionId);
    const shop = parseShopifyDomain(request.externalAccountId);
    const apiVersion = parseShopifyApiVersion(request.configuredApiVersion);
    const windowStart = Date.parse(z.iso.datetime({ offset: true }).parse(request.windowStart));
    const windowEnd = Date.parse(z.iso.datetime({ offset: true }).parse(request.windowEnd));
    if (windowEnd <= windowStart || windowEnd - windowStart > maximumShopifyWindowMs) {
      throw new ConnectorError(
        "terminal",
        "Shopify order window must be positive and at most 30 days",
      );
    }
    const limit = z.number().int().min(1).max(100).parse(request.limit);
    const cursor = request.cursor ? shopifyCursorSchema.parse(request.cursor) : undefined;
    const accessToken = await this.options.secrets.resolve({
      reference: request.apiCredentialReference,
      organizationId: request.organizationId,
      connectionId: request.connectionId,
      provider: "shopify",
      purpose: "api_read",
    });
    if (accessToken.length > 512 || /[\r\n]/u.test(accessToken)) {
      throw new ConnectorError("authentication", "Shopify access token is invalid");
    }

    const url = new URL(`https://${shop}/admin/api/${apiVersion}/graphql.json`);
    const query = [
      `updated_at:>='${new Date(windowStart).toISOString()}'`,
      `updated_at:<='${new Date(windowEnd).toISOString()}'`,
    ].join(" ");
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: shopifyOrdersQuery,
          variables: {
            first: limit,
            after: cursor ?? null,
            query,
          },
        }),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new ConnectorError("timeout", "Shopify order page request timed out");
      }
      throw new ConnectorError("provider_unavailable", "Shopify order page request failed");
    }

    if (!response.ok) throw classifyShopifyHttpError(response);
    const responseApiVersion = response.headers.get("x-shopify-api-version");
    if (responseApiVersion !== apiVersion) {
      throw new ConnectorError(
        "invalid_payload",
        "Shopify fulfilled the request with an unexpected API version",
      );
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      throw new ConnectorError("invalid_payload", "Shopify returned a non-JSON response");
    }

    const payload = parseShopifyGraphqlResponse(
      await readBoundedShopifyResponse(response, maximumShopifyPageBytes),
    );
    if (payload.errors && payload.errors.length > 0) {
      throw classifyShopifyGraphqlErrors(payload);
    }
    const orders = payload.data?.orders;
    if (!orders) {
      throw new ConnectorError("invalid_payload", "Shopify order page data is missing");
    }
    const last = orders.edges.at(-1);
    if (orders.pageInfo.hasNextPage) {
      if (!last || !orders.pageInfo.endCursor || orders.pageInfo.endCursor !== last.cursor) {
        throw new ConnectorError("invalid_payload", "Shopify order cursor did not advance");
      }
    } else if (orders.pageInfo.endCursor && !last) {
      throw new ConnectorError("invalid_payload", "Shopify returned a cursor for an empty page");
    }
    for (const edge of orders.edges) {
      if (edge.node.refunds.some((refund) => refund.transactions.pageInfo.hasNextPage)) {
        throw new ConnectorError(
          "invalid_payload",
          "Shopify refund transactions exceed the bounded item contract",
        );
      }
    }

    return {
      items: orders.edges.map((edge) => {
        const envelope = ShopifyOrderSnapshotEnvelopeSchema.parse({
          apiVersion,
          order: edge.node,
        });
        const rawBody = Buffer.from(JSON.stringify(envelope), "utf8");
        if (rawBody.byteLength > maximumShopifyItemBytes) {
          throw new ConnectorError("invalid_payload", "Shopify order snapshot is too large");
        }
        const identity = shopifyOrderSnapshotIdentity(envelope);
        return {
          eventType: "orders/snapshot",
          externalEventId: identity.externalEventId,
          externalObjectId: identity.externalObjectId,
          sourceTimestamp: identity.sourceTimestamp,
          apiVersion,
          rawBody,
        };
      }),
      hasMore: orders.pageInfo.hasNextPage,
      ...(orders.pageInfo.hasNextPage && orders.pageInfo.endCursor
        ? { nextCursor: orders.pageInfo.endCursor }
        : {}),
    };
  }
}

export interface ShopifyNormalizerContext {
  readonly organizationId: OrganizationId;
  readonly canonicalRecordId: string;
  readonly version: number;
  readonly sourceEventId: string;
  readonly ingestionTimestamp: string;
}

export function verifyShopifyWebhook(
  rawBody: Uint8Array,
  providedHmacBase64: string,
  secret: string,
): boolean {
  if (rawBody.byteLength === 0 || secret.length < 16) return false;
  let provided: Buffer;
  try {
    provided = Buffer.from(providedHmacBase64, "base64");
  } catch {
    return false;
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function createShopifyReceipt(input: {
  readonly organizationId: OrganizationId;
  readonly connectionId: string;
  readonly webhookId: string;
  readonly receivedAt: string;
  readonly rawBody: Uint8Array;
}): WebhookReceipt {
  if (input.webhookId.trim().length === 0) {
    throw new ConnectorError("invalid_payload", "Shopify webhook ID is required");
  }
  return {
    organizationId: input.organizationId,
    connectionId: input.connectionId,
    connector: "shopify",
    externalEventId: input.webhookId,
    receivedAt: input.receivedAt,
    rawBodySha256: createHash("sha256").update(input.rawBody).digest("hex"),
    status: "received",
  };
}

export function normalizeShopifyOrder(
  payload: unknown,
  context: ShopifyNormalizerContext,
): OrderRecord {
  const value = ShopifyOrderWebhookSchema.parse(payload);
  const sourceEventId = SourceEventIdSchema.parse(context.sourceEventId);
  const id = CanonicalRecordIdSchema.parse(context.canonicalRecordId);
  const shopMoney = value.current_total_price_set.shop_money;
  return {
    id,
    organizationId: context.organizationId,
    version: context.version,
    kind: "order",
    externalId: value.id,
    orderReference: value.name,
    effectiveAt: value.processed_at,
    amount: parseMoneyDecimal(shopMoney.amount, asCurrency(shopMoney.currency_code.toUpperCase())),
    financialStatus: value.financial_status,
    provenance: {
      sourceSystem: "shopify",
      externalObjectType: "order",
      externalObjectId: value.id,
      sourceTimestamp: value.processed_at,
      ingestionTimestamp: context.ingestionTimestamp,
      sourceEventId,
      connectorVersion: shopifyMetadata.connectorVersion,
      normalizerVersion: shopifyMetadata.normalizerVersion,
    },
  };
}

export function normalizeShopifyRefunds(
  payload: unknown,
  contexts: readonly ShopifyNormalizerContext[],
): readonly RefundRecord[] {
  const value = ShopifyRefundWebhookSchema.parse(payload);
  const successful = value.transactions.filter((transaction) => transaction.status === "success");
  if (contexts.length !== successful.length) {
    throw new ConnectorError(
      "invalid_payload",
      "one normalizer context is required per successful refund transaction",
    );
  }
  return successful.map((transaction, index) => {
    const context = contexts[index];
    if (!context) throw new ConnectorError("invalid_payload", "missing refund normalizer context");
    return {
      id: CanonicalRecordIdSchema.parse(context.canonicalRecordId),
      organizationId: context.organizationId,
      version: context.version,
      kind: "refund",
      externalId: transaction.id,
      orderReference: value.order_id,
      refundReference: value.id,
      effectiveAt: value.created_at,
      amount: parseMoneyDecimal(transaction.amount, asCurrency(transaction.currency.toUpperCase())),
      refundStatus: "succeeded",
      provenance: {
        sourceSystem: "shopify",
        externalObjectType: "refund_transaction",
        externalObjectId: transaction.id,
        sourceTimestamp: value.created_at,
        ingestionTimestamp: context.ingestionTimestamp,
        sourceEventId: SourceEventIdSchema.parse(context.sourceEventId),
        connectorVersion: shopifyMetadata.connectorVersion,
        normalizerVersion: shopifyMetadata.normalizerVersion,
      },
    };
  });
}

export function shopifyOrderSnapshotIdentity(input: unknown): {
  readonly externalEventId: string;
  readonly externalObjectId: string;
  readonly sourceTimestamp: string;
  readonly apiVersion: string;
} {
  const envelope = ShopifyOrderSnapshotEnvelopeSchema.parse(input);
  return {
    externalEventId: [
      "shopify",
      "order",
      envelope.order.legacyResourceId,
      envelope.order.updatedAt,
      envelope.apiVersion,
    ].join("/"),
    externalObjectId: envelope.order.legacyResourceId,
    sourceTimestamp: envelope.order.updatedAt,
    apiVersion: envelope.apiVersion,
  };
}

export function shopifyOrderSnapshotRefundTransactionIds(input: unknown): readonly string[] {
  const envelope = ShopifyOrderSnapshotEnvelopeSchema.parse(input);
  return envelope.order.refunds.flatMap((refund) =>
    refund.transactions.nodes.map((transaction) =>
      shopifyGraphqlNumericId(transaction.id, "OrderTransaction"),
    ),
  );
}

export function normalizeShopifyOrderSnapshot(
  payload: unknown,
  context: ShopifyNormalizerContext,
): OrderRecord {
  const value = ShopifyOrderSnapshotEnvelopeSchema.parse(payload).order;
  const status = shopifySnapshotFinancialStatus(value.displayFinancialStatus);
  return {
    id: CanonicalRecordIdSchema.parse(context.canonicalRecordId),
    organizationId: context.organizationId,
    version: context.version,
    kind: "order",
    externalId: value.legacyResourceId,
    orderReference: value.name,
    effectiveAt: value.processedAt,
    amount: parseMoneyDecimal(
      value.currentTotalPriceSet.shopMoney.amount,
      asCurrency(value.currentTotalPriceSet.shopMoney.currencyCode.toUpperCase()),
    ),
    financialStatus: status,
    ...(["AUTHORIZED", "EXPIRED", "PARTIALLY_PAID"].includes(value.displayFinancialStatus ?? "")
      ? { incompleteReasons: [`shopify_financial_status:${String(value.displayFinancialStatus)}`] }
      : {}),
    provenance: {
      sourceSystem: "shopify",
      externalObjectType: "order",
      externalObjectId: value.legacyResourceId,
      sourceTimestamp: value.updatedAt,
      ingestionTimestamp: context.ingestionTimestamp,
      sourceEventId: SourceEventIdSchema.parse(context.sourceEventId),
      connectorVersion: shopifyMetadata.connectorVersion,
      normalizerVersion: shopifyMetadata.normalizerVersion,
    },
  };
}

export function normalizeShopifySnapshotRefunds(
  payload: unknown,
  contexts: readonly ShopifyNormalizerContext[],
): readonly RefundRecord[] {
  const value = ShopifyOrderSnapshotEnvelopeSchema.parse(payload).order;
  const transactions = value.refunds.flatMap((refund) =>
    refund.transactions.nodes.map((transaction) => ({ refund, transaction })),
  );
  if (contexts.length !== transactions.length) {
    throw new ConnectorError(
      "invalid_payload",
      "one normalizer context is required per Shopify snapshot refund transaction",
    );
  }
  return transactions.map(({ refund, transaction }, index) => {
    const context = contexts[index];
    if (!context) throw new ConnectorError("invalid_payload", "missing refund normalizer context");
    const externalId = shopifyGraphqlNumericId(transaction.id, "OrderTransaction");
    return {
      id: CanonicalRecordIdSchema.parse(context.canonicalRecordId),
      organizationId: context.organizationId,
      version: context.version,
      kind: "refund",
      externalId,
      orderReference: value.legacyResourceId,
      refundReference: refund.legacyResourceId,
      effectiveAt: transaction.processedAt ?? refund.processedAt,
      amount: parseMoneyDecimal(
        transaction.amountSet.shopMoney.amount,
        asCurrency(transaction.amountSet.shopMoney.currencyCode.toUpperCase()),
      ),
      refundStatus: shopifySnapshotRefundStatus(transaction.status),
      ...(transaction.status === "AWAITING_RESPONSE" || transaction.status === "UNKNOWN"
        ? { incompleteReasons: [`shopify_refund_status:${transaction.status}`] }
        : {}),
      provenance: {
        sourceSystem: "shopify",
        externalObjectType: "refund_transaction",
        externalObjectId: externalId,
        sourceTimestamp: refund.updatedAt,
        ingestionTimestamp: context.ingestionTimestamp,
        sourceEventId: SourceEventIdSchema.parse(context.sourceEventId),
        connectorVersion: shopifyMetadata.connectorVersion,
        normalizerVersion: shopifyMetadata.normalizerVersion,
      },
    };
  });
}

export function normalizeShopifyOrderSnapshotRecords(
  payload: unknown,
  contexts: {
    readonly order: ShopifyNormalizerContext;
    readonly refunds: readonly ShopifyNormalizerContext[];
  },
): readonly CanonicalRecord[] {
  return [
    normalizeShopifyOrderSnapshot(payload, contexts.order),
    ...normalizeShopifySnapshotRefunds(payload, contexts.refunds),
  ];
}

function parseShopifyDomain(value: string): string {
  const parsed = shopifyDomainSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConnectorError("terminal", "Shopify account must be a canonical myshopify domain");
  }
  return parsed.data;
}

function parseShopifyApiVersion(value: string | undefined): string {
  const parsed = shopifyApiVersionSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConnectorError("terminal", "Shopify sync requires a pinned stable API version");
  }
  return parsed.data;
}

function classifyShopifyHttpError(response: Response): ConnectorError {
  if (response.status === 401) {
    return new ConnectorError("authentication", "Shopify rejected the access token");
  }
  if (response.status === 402 || response.status === 403) {
    return new ConnectorError("authorization", "Shopify rejected the requested order scope");
  }
  if (response.status === 429) {
    return new ConnectorError(
      "rate_limited",
      "Shopify order page request was rate limited",
      retryAfterMilliseconds(response.headers.get("retry-after")),
    );
  }
  if (response.status === 423 || response.status >= 500) {
    return new ConnectorError("provider_unavailable", "Shopify order page service is unavailable");
  }
  return new ConnectorError("terminal", "Shopify rejected the bounded order page request");
}

function classifyShopifyGraphqlErrors(
  payload: z.infer<typeof shopifyGraphqlResponseSchema>,
): ConnectorError {
  const codes = new Set(payload.errors?.map((error) => error.extensions?.code).filter(Boolean));
  if (codes.has("THROTTLED")) {
    const throttle = payload.extensions?.cost.throttleStatus;
    const retryAfterMs = throttle
      ? Math.min(
          60_000,
          Math.max(
            1_000,
            Math.ceil(
              ((payload.extensions?.cost.requestedQueryCost ?? 1) - throttle.currentlyAvailable) /
                throttle.restoreRate,
            ) * 1000,
          ),
        )
      : undefined;
    return new ConnectorError("rate_limited", "Shopify GraphQL query was throttled", retryAfterMs);
  }
  if (codes.has("ACCESS_DENIED")) {
    return new ConnectorError("authorization", "Shopify rejected the requested order scope");
  }
  if (codes.has("SHOP_INACTIVE") || codes.has("INTERNAL_SERVER_ERROR")) {
    return new ConnectorError("provider_unavailable", "Shopify order page service is unavailable");
  }
  return new ConnectorError("invalid_payload", "Shopify rejected the order snapshot query");
}

async function readBoundedShopifyResponse(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      throw new ConnectorError("invalid_payload", "Shopify response exceeds the byte limit");
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
        throw new ConnectorError("invalid_payload", "Shopify response exceeds the byte limit");
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

function parseShopifyGraphqlResponse(
  body: Uint8Array,
): z.infer<typeof shopifyGraphqlResponseSchema> {
  try {
    return shopifyGraphqlResponseSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
    );
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("invalid_payload", "Shopify returned an invalid GraphQL response");
  }
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) return undefined;
  return Math.ceil(seconds * 1000);
}

function shopifySnapshotFinancialStatus(
  value: z.infer<typeof ShopifyOrderSnapshotSchema>["displayFinancialStatus"],
): OrderRecord["financialStatus"] {
  if (value === "PAID") return "paid";
  if (value === "PARTIALLY_REFUNDED") return "partially_refunded";
  if (value === "REFUNDED") return "refunded";
  if (value === "VOIDED") return "voided";
  return "pending";
}

function shopifySnapshotRefundStatus(
  value: z.infer<typeof shopifyGraphqlTransactionSchema>["status"],
): RefundRecord["refundStatus"] {
  if (value === "SUCCESS") return "succeeded";
  if (value === "FAILURE" || value === "ERROR") return "failed";
  return "pending";
}

function shopifyGraphqlNumericId(value: string, objectType: string): string {
  const match = new RegExp(`^gid://shopify/${objectType}/([0-9]+)$`, "u").exec(value);
  if (!match?.[1]) throw new ConnectorError("invalid_payload", "Shopify GraphQL ID is invalid");
  return match[1];
}
