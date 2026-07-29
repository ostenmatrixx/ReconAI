import { createHash } from "node:crypto";

import {
  CanonicalRecordIdSchema,
  SourceEventIdSchema,
  asCurrency,
  money,
  type OrganizationId,
  type PaymentRecord,
  type ProcessingFeeRecord,
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
import Stripe from "stripe";
import { z } from "zod";

export * from "./authorization.js";

export const stripeMetadata: ConnectorMetadata = {
  name: "stripe",
  connectorVersion: "1.1.0",
  normalizerVersion: "1.1.0",
  readOnly: true,
};

const stripeWebhookClient = new Stripe("unused-for-local-webhook-verification");

const stripePaymentIntentSchema = z.object({
  id: z.string().min(1).max(255),
  object: z.literal("payment_intent"),
  amount: z.number().int().nonnegative(),
  amount_received: z.number().int().nonnegative(),
  currency: z.string().length(3),
  status: z.enum([
    "requires_payment_method",
    "requires_confirmation",
    "requires_action",
    "processing",
    "requires_capture",
    "canceled",
    "succeeded",
  ]),
  customer: z
    .union([z.string(), z.object({ id: z.string() })])
    .nullable()
    .optional(),
  metadata: z.record(z.string(), z.string()).default({}),
});

const stripeRefundSchema = z.object({
  id: z.string().min(1).max(255),
  object: z.literal("refund"),
  amount: z.number().int().nonnegative(),
  currency: z.string().length(3),
  created: z.number().int().nonnegative(),
  payment_intent: z
    .union([z.string(), z.object({ id: z.string().min(1).max(255) })])
    .nullable()
    .optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  status: z
    .enum(["pending", "requires_action", "succeeded", "failed", "canceled"])
    .nullable()
    .optional(),
});

const stripePaymentIntentIdSchema = z.string().regex(/^pi_[A-Za-z0-9]{1,252}$/u);
const stripeChargeIdSchema = z.string().regex(/^ch_[A-Za-z0-9]{1,252}$/u);
const stripeBalanceTransactionIdSchema = z.string().regex(/^txn_[A-Za-z0-9]{1,251}$/u);
const stripeSafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const stripeNonnegativeSafeIntegerSchema = stripeSafeIntegerSchema.min(0);
const stripeCurrencySchema = z.string().regex(/^[a-z]{3}$/u);

const stripeExpandedChargeSourceSchema = z.object({
  id: stripeChargeIdSchema,
  object: z.literal("charge"),
  payment_intent: z
    .union([
      stripePaymentIntentIdSchema,
      z.object({
        id: stripePaymentIntentIdSchema,
        object: z.literal("payment_intent").optional(),
      }),
    ])
    .nullable(),
});

const stripeBalanceTransactionSchema = z
  .object({
    id: stripeBalanceTransactionIdSchema,
    object: z.literal("balance_transaction"),
    amount: stripeNonnegativeSafeIntegerSchema,
    available_on: stripeNonnegativeSafeIntegerSchema,
    created: stripeNonnegativeSafeIntegerSchema,
    currency: stripeCurrencySchema,
    fee: stripeNonnegativeSafeIntegerSchema,
    fee_details: z
      .array(
        z.object({
          amount: stripeSafeIntegerSchema,
          application: z.string().min(1).max(255).nullable().optional(),
          currency: stripeCurrencySchema,
          description: z.string().max(500).nullable(),
          type: z
            .enum([
              "application_fee",
              "payment_method_passthrough_fee",
              "stripe_fee",
              "tax",
              "withheld_tax",
            ])
            .or(z.string().min(1).max(100)),
        }),
      )
      .max(100),
    net: stripeSafeIntegerSchema,
    reporting_category: z.string().min(1).max(100),
    source: stripeExpandedChargeSourceSchema,
    status: z.enum(["available", "pending"]),
    type: z.literal("charge"),
  })
  .superRefine((transaction, context) => {
    if (transaction.amount - transaction.fee !== transaction.net) {
      context.addIssue({
        code: "custom",
        message: "Stripe balance transaction does not conserve amount minus fee",
        path: ["net"],
      });
    }
  });

export const StripeBalanceTransactionSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    object: z.literal("reconai.stripe_balance_transaction_snapshot"),
    apiVersion: z.string().min(1).max(50).optional(),
    balanceTransaction: stripeBalanceTransactionSchema,
  })
  .strict();
export type StripeBalanceTransactionSnapshot = z.infer<
  typeof StripeBalanceTransactionSnapshotSchema
>;

const stripePaymentEventSchema = z.object({
  id: z.string().min(1).max(255),
  object: z.literal("event"),
  created: z.number().int().nonnegative(),
  api_version: z.string().min(1).max(50).nullable().optional(),
  type: z.enum([
    "payment_intent.amount_capturable_updated",
    "payment_intent.canceled",
    "payment_intent.payment_failed",
    "payment_intent.processing",
    "payment_intent.succeeded",
  ]),
  data: z.object({ object: stripePaymentIntentSchema }),
});

const stripeRefundEventSchema = z.object({
  id: z.string().min(1).max(255),
  object: z.literal("event"),
  created: z.number().int().nonnegative(),
  api_version: z.string().min(1).max(50).nullable().optional(),
  type: z.enum(["refund.created", "refund.failed", "refund.updated"]),
  data: z.object({ object: stripeRefundSchema }),
});

export const SupportedStripeEventSchema = z.union([
  stripePaymentEventSchema,
  stripeRefundEventSchema,
]);
export type SupportedStripeEvent = z.infer<typeof SupportedStripeEventSchema>;

export const StripeAppDeauthorizationEventSchema = z
  .object({
    id: z.string().regex(/^evt_[A-Za-z0-9]{1,250}$/u),
    object: z.literal("event"),
    account: z.string().regex(/^acct_[A-Za-z0-9]{1,250}$/u),
    created: z.number().int().nonnegative(),
    livemode: z.boolean(),
    type: z.literal("account.application.deauthorized"),
    data: z
      .object({
        object: z.unknown(),
      })
      .loose(),
  })
  .loose();
export type StripeAppDeauthorizationEvent = z.infer<typeof StripeAppDeauthorizationEventSchema>;

const supportedStripeEventTypes = [
  "payment_intent.amount_capturable_updated",
  "payment_intent.canceled",
  "payment_intent.payment_failed",
  "payment_intent.processing",
  "payment_intent.succeeded",
  "refund.created",
  "refund.failed",
  "refund.updated",
] as const;
const stripeEventListSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(SupportedStripeEventSchema).max(100),
    has_more: z.boolean(),
    url: z.string().min(1).max(255),
  })
  .strict();
const stripeBalanceTransactionListSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(stripeBalanceTransactionSchema).max(100),
    has_more: z.boolean(),
    url: z.literal("/v1/balance_transactions"),
  })
  .strict();
const stripeEventCursorSchema = z.string().regex(/^evt_[A-Za-z0-9]{1,250}$/u);
const stripeBalanceCursorSchema = stripeBalanceTransactionIdSchema;
const stripeEventPhaseCursorSchema = z.string().regex(/^stripe-v2:events:evt_[A-Za-z0-9]{1,250}$/u);
const stripeBalancePhaseCursorSchema = z
  .string()
  .regex(/^stripe-v2:balance:(?:start|txn_[A-Za-z0-9]{1,251})$/u);
const stripeBalancePhaseStartCursor = "stripe-v2:balance:start";
const stripeAccountSchema = z.string().regex(/^acct_[A-Za-z0-9]{1,250}$/u);
const providerApiVersionSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}(?:\.[a-z]+)?$/u);
const maximumStripeEventPageBytes = 2 * 1024 * 1024;
const maximumStripeEventWindowMs = 30 * 24 * 60 * 60 * 1000;
const defaultStripeRequestTimeoutMs = 10_000;

export interface StripeEventPageSourceOptions {
  readonly secrets: ConnectorSecretResolver;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class StripeEventPageSource implements ProviderPageSource {
  public readonly provider = "stripe" as const;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  public constructor(private readonly options: StripeEventPageSourceOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? defaultStripeRequestTimeoutMs;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 100 ||
      this.#timeoutMs > 60_000
    ) {
      throw new TypeError("Stripe request timeout must be between 100 and 60000 milliseconds");
    }
  }

  public async fetchPage(request: ProviderPageRequest): Promise<ProviderPage> {
    if (request.provider !== "stripe") {
      throw new ConnectorError("terminal", "Stripe page source received another provider");
    }
    z.uuid().parse(request.connectionId);
    const windowStart = Date.parse(z.iso.datetime({ offset: true }).parse(request.windowStart));
    const windowEnd = Date.parse(z.iso.datetime({ offset: true }).parse(request.windowEnd));
    if (windowEnd <= windowStart || windowEnd - windowStart > maximumStripeEventWindowMs) {
      throw new ConnectorError(
        "terminal",
        "Stripe recovery window must be positive and at most 30 days",
      );
    }
    const limit = z.number().int().min(1).max(100).parse(request.limit);
    const cursor = parseStripeRecoveryCursor(request.cursor);
    const apiVersion = request.configuredApiVersion
      ? providerApiVersionSchema.parse(request.configuredApiVersion)
      : undefined;
    const apiKey = await this.options.secrets.resolve({
      reference: request.apiCredentialReference,
      organizationId: request.organizationId,
      connectionId: request.connectionId,
      provider: "stripe",
      purpose: "api_read",
    });
    if (apiKey.length > 512 || /[\r\n]/u.test(apiKey)) {
      throw new ConnectorError("authentication", "Stripe API credential is invalid");
    }

    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${apiKey}:`, "utf8").toString("base64")}`,
    });
    const account = stripeAccountSchema.safeParse(request.externalAccountId);
    if (account.success) headers.set("Stripe-Account", account.data);
    if (apiVersion) headers.set("Stripe-Version", apiVersion);

    if (cursor.phase === "events") {
      const url = new URL("https://api.stripe.com/v1/events");
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("created[gte]", String(Math.floor(windowStart / 1000)));
      url.searchParams.set("created[lte]", String(Math.floor(windowEnd / 1000)));
      if (cursor.after) url.searchParams.set("starting_after", cursor.after);
      for (const eventType of supportedStripeEventTypes) {
        url.searchParams.append("types[]", eventType);
      }

      const response = await this.#request(url, headers, "event");
      const payload = parseStripeEventPage(
        await readBoundedResponse(response, maximumStripeEventPageBytes),
      );
      const last = payload.data.at(-1);
      if (payload.has_more && !last) {
        throw new ConnectorError("invalid_payload", "Stripe returned an empty nonterminal page");
      }
      const items = payload.data.map((event) => ({
        eventType: event.type,
        externalEventId: event.id,
        externalObjectId: event.data.object.id,
        sourceTimestamp: new Date(event.created * 1000).toISOString(),
        ...(event.api_version ? { apiVersion: event.api_version } : {}),
        rawBody: Buffer.from(JSON.stringify(event), "utf8"),
      }));
      if (payload.has_more && last) {
        return {
          items,
          hasMore: true,
          nextCursor: `stripe-v2:events:${stripeEventCursorSchema.parse(last.id)}`,
        };
      }
      return {
        items,
        hasMore: true,
        nextCursor: stripeBalancePhaseStartCursor,
        continuationKind: "source_phase",
      };
    }

    const url = new URL("https://api.stripe.com/v1/balance_transactions");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("created[gte]", String(Math.floor(windowStart / 1000)));
    url.searchParams.set("created[lte]", String(Math.floor(windowEnd / 1000)));
    url.searchParams.set("type", "charge");
    url.searchParams.append("expand[]", "data.source");
    if (cursor.after) url.searchParams.set("starting_after", cursor.after);

    const response = await this.#request(url, headers, "balance transaction");
    const payload = parseStripeBalanceTransactionPage(
      await readBoundedResponse(response, maximumStripeEventPageBytes),
    );
    const last = payload.data.at(-1);
    if (payload.has_more && !last) {
      throw new ConnectorError("invalid_payload", "Stripe returned an empty nonterminal page");
    }
    return {
      items: payload.data.map((balanceTransaction) => {
        const snapshot = StripeBalanceTransactionSnapshotSchema.parse({
          schemaVersion: 1,
          object: "reconai.stripe_balance_transaction_snapshot",
          ...(apiVersion ? { apiVersion } : {}),
          balanceTransaction,
        });
        return {
          eventType: "balance_transaction.snapshot",
          externalEventId: balanceTransaction.id,
          externalObjectId: balanceTransaction.id,
          sourceTimestamp: new Date(balanceTransaction.created * 1000).toISOString(),
          ...(apiVersion ? { apiVersion } : {}),
          rawBody: Buffer.from(JSON.stringify(snapshot), "utf8"),
        };
      }),
      hasMore: payload.has_more,
      ...(payload.has_more && last
        ? {
            nextCursor: `stripe-v2:balance:${stripeBalanceCursorSchema.parse(last.id)}`,
          }
        : {}),
    };
  }

  async #request(
    url: URL,
    headers: Headers,
    resource: "event" | "balance transaction",
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new ConnectorError("timeout", `Stripe ${resource} page request timed out`);
      }
      throw new ConnectorError("provider_unavailable", `Stripe ${resource} page request failed`);
    }

    if (response.ok) return response;
    if (response.status === 401) {
      throw new ConnectorError("authentication", "Stripe rejected the API credential");
    }
    if (response.status === 403) {
      throw new ConnectorError(
        "authorization",
        `Stripe rejected the requested ${resource} read scope`,
      );
    }
    if (response.status === 429) {
      throw new ConnectorError(
        "rate_limited",
        `Stripe ${resource} page request was rate limited`,
        retryAfterMilliseconds(response.headers.get("retry-after")),
      );
    }
    if (response.status >= 500) {
      throw new ConnectorError(
        "provider_unavailable",
        `Stripe ${resource} page service is unavailable`,
      );
    }
    throw new ConnectorError("terminal", `Stripe rejected the bounded ${resource} page request`);
  }
}

export interface StripeNormalizerContext {
  readonly organizationId: OrganizationId;
  readonly canonicalRecordId: string;
  readonly version: number;
  readonly sourceEventId: string;
  readonly ingestionTimestamp: string;
}

export function constructStripeEvent(
  rawBody: Uint8Array,
  signature: string,
  endpointSecret: string,
  toleranceSeconds = 300,
): Stripe.Event {
  if (rawBody.byteLength === 0 || endpointSecret.length < 16) {
    throw new ConnectorError("authentication", "invalid Stripe webhook input");
  }
  try {
    return stripeWebhookClient.webhooks.constructEvent(
      Buffer.from(rawBody),
      signature,
      endpointSecret,
      toleranceSeconds,
    );
  } catch {
    throw new ConnectorError("authentication", "Stripe webhook signature verification failed");
  }
}

export function createStripeReceipt(input: {
  readonly organizationId: OrganizationId;
  readonly connectionId: string;
  readonly event: Stripe.Event;
  readonly receivedAt: string;
  readonly rawBody: Uint8Array;
}): WebhookReceipt {
  return {
    organizationId: input.organizationId,
    connectionId: input.connectionId,
    connector: "stripe",
    externalEventId: input.event.id,
    receivedAt: input.receivedAt,
    rawBodySha256: createHash("sha256").update(input.rawBody).digest("hex"),
    status: "received",
  };
}

export function normalizeStripePayment(
  eventInput: unknown,
  context: StripeNormalizerContext,
): PaymentRecord {
  const event = stripePaymentEventSchema.parse(eventInput);
  const intent = event.data.object;
  const amount = intent.amount_received > 0 ? intent.amount_received : intent.amount;
  assertSafeMinorUnits(amount);
  const status: PaymentRecord["paymentStatus"] =
    intent.status === "succeeded"
      ? "succeeded"
      : intent.status === "canceled"
        ? "reversed"
        : "pending";
  const orderReference = boundedMetadata(intent.metadata["shopify_order_id"]);

  return {
    id: CanonicalRecordIdSchema.parse(context.canonicalRecordId),
    organizationId: context.organizationId,
    version: context.version,
    kind: "payment",
    externalId: intent.id,
    ...(orderReference ? { orderReference, providerOrderReference: orderReference } : {}),
    ...(typeof intent.customer === "string" ? { customerReference: intent.customer } : {}),
    effectiveAt: new Date(event.created * 1000).toISOString(),
    amount: money(BigInt(amount), asCurrency(intent.currency.toUpperCase())),
    paymentStatus: status,
    provenance: {
      sourceSystem: "stripe",
      externalObjectType: "payment_intent",
      externalObjectId: intent.id,
      sourceTimestamp: new Date(event.created * 1000).toISOString(),
      ingestionTimestamp: context.ingestionTimestamp,
      sourceEventId: SourceEventIdSchema.parse(context.sourceEventId),
      connectorVersion: stripeMetadata.connectorVersion,
      normalizerVersion: stripeMetadata.normalizerVersion,
    },
  };
}

export function normalizeStripeRefund(
  eventInput: unknown,
  context: StripeNormalizerContext,
): RefundRecord {
  const event = stripeRefundEventSchema.parse(eventInput);
  const refund = event.data.object;
  assertSafeMinorUnits(refund.amount);
  const paymentReference =
    typeof refund.payment_intent === "string" ? refund.payment_intent : refund.payment_intent?.id;
  const orderReference = boundedMetadata(refund.metadata?.["shopify_order_id"]);

  return {
    id: CanonicalRecordIdSchema.parse(context.canonicalRecordId),
    organizationId: context.organizationId,
    version: context.version,
    kind: "refund",
    externalId: refund.id,
    refundReference: boundedMetadata(refund.metadata?.["shopify_refund_id"]) ?? refund.id,
    ...(paymentReference ? { paymentReference } : {}),
    ...(orderReference ? { orderReference } : {}),
    effectiveAt: new Date(refund.created * 1000).toISOString(),
    amount: money(BigInt(refund.amount), asCurrency(refund.currency.toUpperCase())),
    refundStatus:
      refund.status === "succeeded"
        ? "succeeded"
        : refund.status === "failed"
          ? "failed"
          : "pending",
    provenance: {
      sourceSystem: "stripe",
      externalObjectType: "refund",
      externalObjectId: refund.id,
      sourceTimestamp: new Date(refund.created * 1000).toISOString(),
      ingestionTimestamp: context.ingestionTimestamp,
      sourceEventId: SourceEventIdSchema.parse(context.sourceEventId),
      connectorVersion: stripeMetadata.connectorVersion,
      normalizerVersion: stripeMetadata.normalizerVersion,
    },
  };
}

export function normalizeStripeFee(
  balanceTransactionInput: unknown,
  paymentReferenceInput: unknown,
  context: StripeNormalizerContext,
  incompleteReasons?: readonly string[],
): ProcessingFeeRecord {
  const balanceTransaction = stripeBalanceTransactionSchema.parse(balanceTransactionInput);
  const paymentReference = z.string().min(1).max(255).parse(paymentReferenceInput);
  assertSafeMinorUnits(balanceTransaction.fee);
  return {
    id: CanonicalRecordIdSchema.parse(context.canonicalRecordId),
    organizationId: context.organizationId,
    version: context.version,
    kind: "processing_fee",
    externalId: balanceTransaction.id,
    paymentReference,
    effectiveAt: new Date(balanceTransaction.created * 1000).toISOString(),
    amount: money(
      BigInt(balanceTransaction.fee),
      asCurrency(balanceTransaction.currency.toUpperCase()),
    ),
    ...(incompleteReasons && incompleteReasons.length > 0 ? { incompleteReasons } : {}),
    provenance: {
      sourceSystem: "stripe",
      externalObjectType: "balance_transaction",
      externalObjectId: balanceTransaction.id,
      sourceTimestamp: new Date(balanceTransaction.created * 1000).toISOString(),
      ingestionTimestamp: context.ingestionTimestamp,
      sourceEventId: SourceEventIdSchema.parse(context.sourceEventId),
      connectorVersion: stripeMetadata.connectorVersion,
      normalizerVersion: stripeMetadata.normalizerVersion,
    },
  };
}

export function normalizeStripeBalanceTransaction(
  snapshotInput: unknown,
  context: StripeNormalizerContext,
): ProcessingFeeRecord {
  const snapshot = StripeBalanceTransactionSnapshotSchema.parse(snapshotInput);
  const source = snapshot.balanceTransaction.source;
  const paymentReference =
    typeof source.payment_intent === "string"
      ? source.payment_intent
      : (source.payment_intent?.id ?? source.id);
  return normalizeStripeFee(
    snapshot.balanceTransaction,
    paymentReference,
    context,
    source.payment_intent ? undefined : ["STRIPE_CHARGE_HAS_NO_PAYMENT_INTENT"],
  );
}

function assertSafeMinorUnits(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConnectorError(
      "invalid_payload",
      "Stripe amount must be a safe non-negative integer",
    );
  }
}

function boundedMetadata(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 255 ? normalized : undefined;
}

function parseStripeEventPage(value: string) {
  try {
    return stripeEventListSchema.parse(JSON.parse(value) as unknown);
  } catch {
    throw new ConnectorError("invalid_payload", "Stripe returned an invalid event page");
  }
}

function parseStripeBalanceTransactionPage(value: string) {
  try {
    return stripeBalanceTransactionListSchema.parse(JSON.parse(value) as unknown);
  } catch {
    throw new ConnectorError(
      "invalid_payload",
      "Stripe returned an invalid balance transaction page",
    );
  }
}

function parseStripeRecoveryCursor(
  value: string | undefined,
):
  | { readonly phase: "events"; readonly after?: string }
  | { readonly phase: "balance"; readonly after?: string } {
  if (value === undefined) return { phase: "events" };
  const legacyEvent = stripeEventCursorSchema.safeParse(value);
  if (legacyEvent.success) return { phase: "events", after: legacyEvent.data };
  const eventPhase = stripeEventPhaseCursorSchema.safeParse(value);
  if (eventPhase.success) {
    return {
      phase: "events",
      after: stripeEventCursorSchema.parse(eventPhase.data.slice("stripe-v2:events:".length)),
    };
  }
  const balancePhase = stripeBalancePhaseCursorSchema.safeParse(value);
  if (balancePhase.success) {
    const after = balancePhase.data.slice("stripe-v2:balance:".length);
    return after === "start"
      ? { phase: "balance" }
      : { phase: "balance", after: stripeBalanceCursorSchema.parse(after) };
  }
  throw new ConnectorError("terminal", "Stripe recovery cursor is invalid");
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      throw new ConnectorError("invalid_payload", "Stripe event page exceeds the response limit");
    }
  }
  if (!response.body) {
    throw new ConnectorError("invalid_payload", "Stripe event page has no response body");
  }
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
        throw new ConnectorError("invalid_payload", "Stripe event page exceeds the response limit");
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
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new ConnectorError("invalid_payload", "Stripe event page is not valid UTF-8");
  }
}

function retryAfterMilliseconds(value: string | null): number {
  if (!value || !/^\d{1,5}$/u.test(value)) return 1000;
  return Math.min(60_000, Math.max(1000, Number(value) * 1000));
}
