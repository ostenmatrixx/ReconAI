import { createHash } from "node:crypto";

import {
  ShopifyOrderSnapshotEnvelopeSchema,
  ShopifyOrderWebhookSchema,
  ShopifyRefundWebhookSchema,
  createShopifyReceipt,
  normalizeShopifyOrder,
  normalizeShopifyOrderSnapshotRecords,
  normalizeShopifyRefunds,
  shopifyOrderSnapshotIdentity,
  shopifyOrderSnapshotRefundTransactionIds,
  shopifyMetadata,
  verifyShopifyWebhook,
} from "@workspace/connector-shopify";
import {
  StripeBalanceTransactionSnapshotSchema,
  SupportedStripeEventSchema,
  constructStripeEvent,
  createStripeReceipt,
  normalizeStripeBalanceTransaction,
  normalizeStripePayment,
  normalizeStripeRefund,
  stripeMetadata,
} from "@workspace/connector-stripe";
import {
  ConnectorError,
  ConnectorJobEnvelopeSchema,
  SourceObjectFamilySchema,
  createDurableTraceContext,
  type ConnectorJobEnvelope,
  type ConnectorSecretResolver,
  type DurableTraceContext,
  type SourceObjectFamily,
} from "@workspace/connectors";
import { OrganizationIdSchema, type CanonicalRecord, type OrganizationId } from "@workspace/domain";
import {
  ObjectIntegrityError,
  ObjectNotFoundError,
  buildTenantObjectKey,
  type ImmutableObjectStore,
} from "@workspace/object-storage";
import { z } from "zod";

export const PROVIDER_WEBHOOK_MAXIMUM_BYTES = 1024 * 1024;

const supportedShopifyTopicSchema = z.enum(["orders/create", "orders/updated", "refunds/create"]);

export type ProviderName = "shopify" | "stripe";
export type ProviderWebhookJobEnvelope = Extract<
  ConnectorJobEnvelope,
  { readonly type: "connector.webhook.received" }
>;

export interface ProviderWebhookAuthority {
  readonly organizationId: OrganizationId;
  readonly connectionId: string;
  readonly provider: ProviderName;
  readonly signingSecretReference: string;
  readonly status: "healthy" | "backfilling" | "degraded" | "action_required";
  readonly apiVersion?: string;
}

export interface ProviderWebhookReceipt {
  readonly sourceEventId: string;
  readonly organizationId: OrganizationId;
  readonly connectionId: string;
  readonly provider: ProviderName;
  readonly eventType: string;
  readonly externalEventId: string;
  readonly externalObjectId: string;
  readonly sourceTimestamp: string;
  readonly receivedAt: string;
  readonly objectKey: string;
  readonly payloadSha256: string;
  readonly apiVersion?: string;
  readonly status: "received" | "processed" | "failed" | "privacy_pending";
}

export interface ProviderWebhookRepository {
  loadIngressAuthority(
    organizationId: OrganizationId,
    connectionId: string,
    provider: ProviderName,
  ): Promise<ProviderWebhookAuthority | undefined>;
  loadExistingReceipt(
    organizationId: OrganizationId,
    connectionId: string,
    provider: ProviderName,
    externalEventId: string,
  ): Promise<ProviderWebhookReceipt | undefined>;
  saveReceiptAndOutbox(
    receipt: ProviderWebhookReceipt,
    envelope: ProviderWebhookJobEnvelope,
    objectFamilies: readonly SourceObjectFamily[],
  ): Promise<{
    readonly receipt: ProviderWebhookReceipt;
    readonly envelope: ProviderWebhookJobEnvelope;
    readonly inserted: boolean;
  }>;
  markOutboxPublished(
    organizationId: OrganizationId,
    idempotencyKey: string,
    publishedAt: string,
  ): Promise<void>;
  loadForProcessing(
    envelope: ProviderWebhookJobEnvelope,
  ): Promise<ProviderWebhookReceipt | undefined>;
  completeWebhook(
    envelope: ProviderWebhookJobEnvelope,
    records: readonly CanonicalRecord[],
    completedAt: string,
  ): Promise<"processed" | "already_processed">;
  markWebhookFailed(
    envelope: ProviderWebhookJobEnvelope,
    errorCode: string,
    failedAt: string,
  ): Promise<void>;
}

export interface ProviderWebhookJobPublisher {
  publish(envelope: ProviderWebhookJobEnvelope): Promise<void>;
}

export interface ProviderWebhookServiceOptions {
  readonly environment: string;
  readonly repository: ProviderWebhookRepository;
  readonly objectStore: ImmutableObjectStore;
  readonly secrets: ConnectorSecretResolver;
  readonly publisher?: ProviderWebhookJobPublisher;
  readonly now?: () => Date;
}

export interface ProviderWebhookResult {
  readonly duplicate: boolean;
  readonly eventId: string;
  readonly status: "queued";
}

export interface ProviderWebhookProcessResult {
  readonly status: "processed" | "already_processed";
  readonly sourceTimestamp: string;
}

export class ProviderWebhookAuthenticationError extends Error {
  public constructor() {
    super("provider webhook authentication failed");
    this.name = "ProviderWebhookAuthenticationError";
  }
}

export class ProviderWebhookValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProviderWebhookValidationError";
  }
}

export class ProviderWebhookDispatchError extends Error {
  public constructor() {
    super("provider webhook is durably queued but dispatch is temporarily unavailable");
    this.name = "ProviderWebhookDispatchError";
  }
}

export class ProviderWebhookConflictError extends Error {
  public constructor() {
    super("provider event identity conflicts with immutable stored evidence");
    this.name = "ProviderWebhookConflictError";
  }
}

export class ProviderWebhookTerminalError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderWebhookTerminalError";
  }
}

export class ProviderWebhookService {
  readonly #now: () => Date;

  public constructor(private readonly options: ProviderWebhookServiceOptions) {
    this.#now = options.now ?? (() => new Date());
  }

  public async receiveShopify(input: {
    readonly organizationId: string;
    readonly connectionId: string;
    readonly rawBody: Uint8Array;
    readonly hmac: string;
    readonly webhookId: string;
    readonly topic: string;
    readonly apiVersion: string;
    readonly correlationId: string;
    readonly traceparent?: string;
  }): Promise<ProviderWebhookResult> {
    const traceContext = createDurableTraceContext(input.traceparent);
    const organizationId = OrganizationIdSchema.parse(input.organizationId);
    const connectionId = z.uuid().parse(input.connectionId);
    const rawBody = parseRawBody(input.rawBody);
    const hmac = z.string().min(1).max(512).parse(input.hmac);
    const webhookId = z
      .string()
      .regex(/^[A-Za-z0-9._:/-]{1,255}$/u)
      .parse(input.webhookId);
    const topic = supportedShopifyTopicSchema.parse(input.topic.trim().toLowerCase());
    const apiVersion = z.string().min(1).max(50).parse(input.apiVersion);
    const authority = await this.requireAuthority(organizationId, connectionId, "shopify");
    const secret = await this.resolveSecret(authority);
    if (!verifyShopifyWebhook(rawBody, hmac, secret)) {
      throw new ProviderWebhookAuthenticationError();
    }
    if (authority.apiVersion && authority.apiVersion !== apiVersion) {
      throw new ProviderWebhookValidationError("Shopify webhook API version is not configured");
    }

    const payload = parseJson(rawBody);
    const identity = shopifyEventIdentity(topic, payload);
    const receivedAt = this.#now().toISOString();
    const receiptIdentity = createShopifyReceipt({
      organizationId,
      connectionId,
      webhookId,
      receivedAt,
      rawBody,
    });
    return this.persistAndDispatch({
      organizationId,
      connectionId,
      provider: "shopify",
      eventType: topic,
      externalEventId: receiptIdentity.externalEventId,
      externalObjectId: identity.externalObjectId,
      sourceTimestamp: identity.sourceTimestamp ?? receivedAt,
      apiVersion,
      receivedAt,
      rawBody,
      correlationId: input.correlationId,
      ...(traceContext ? { traceContext } : {}),
    });
  }

  public async receiveStripe(input: {
    readonly organizationId: string;
    readonly connectionId: string;
    readonly rawBody: Uint8Array;
    readonly signature: string;
    readonly correlationId: string;
    readonly traceparent?: string;
  }): Promise<ProviderWebhookResult> {
    const traceContext = createDurableTraceContext(input.traceparent);
    const organizationId = OrganizationIdSchema.parse(input.organizationId);
    const connectionId = z.uuid().parse(input.connectionId);
    const rawBody = parseRawBody(input.rawBody);
    const signature = z.string().min(1).max(2048).parse(input.signature);
    const authority = await this.requireAuthority(organizationId, connectionId, "stripe");
    const secret = await this.resolveSecret(authority);
    let authenticatedEvent;
    try {
      authenticatedEvent = constructStripeEvent(rawBody, signature, secret);
    } catch {
      throw new ProviderWebhookAuthenticationError();
    }
    const event = SupportedStripeEventSchema.safeParse(authenticatedEvent);
    if (!event.success) {
      throw new ProviderWebhookValidationError("Stripe event type or payload is unsupported");
    }
    if (authority.apiVersion && event.data.api_version !== authority.apiVersion) {
      throw new ProviderWebhookValidationError("Stripe webhook API version is not configured");
    }
    const receivedAt = this.#now().toISOString();
    const receiptIdentity = createStripeReceipt({
      organizationId,
      connectionId,
      event: authenticatedEvent,
      receivedAt,
      rawBody,
    });
    return this.persistAndDispatch({
      organizationId,
      connectionId,
      provider: "stripe",
      eventType: event.data.type,
      externalEventId: receiptIdentity.externalEventId,
      externalObjectId: event.data.data.object.id,
      sourceTimestamp: new Date(event.data.created * 1000).toISOString(),
      ...(event.data.api_version ? { apiVersion: event.data.api_version } : {}),
      receivedAt,
      rawBody,
      correlationId: input.correlationId,
      ...(traceContext ? { traceContext } : {}),
    });
  }

  public async receiveSyncItem(input: {
    readonly organizationId: string;
    readonly connectionId: string;
    readonly provider: ProviderName;
    readonly eventType: string;
    readonly externalEventId: string;
    readonly externalObjectId: string;
    readonly sourceTimestamp: string;
    readonly apiVersion?: string;
    readonly rawBody: Uint8Array;
    readonly correlationId: string;
    readonly traceparent?: string;
  }): Promise<ProviderWebhookResult> {
    const traceContext = createDurableTraceContext(input.traceparent);
    const organizationId = OrganizationIdSchema.parse(input.organizationId);
    const connectionId = z.uuid().parse(input.connectionId);
    const provider = z.enum(["shopify", "stripe"]).parse(input.provider);
    const eventType = z
      .string()
      .regex(/^[a-z0-9._/-]{1,100}$/u)
      .parse(input.eventType);
    const externalEventId = z
      .string()
      .regex(/^[A-Za-z0-9._:/-]{1,255}$/u)
      .parse(input.externalEventId);
    const externalObjectId = z.string().min(1).max(255).parse(input.externalObjectId);
    const sourceTimestamp = z.iso.datetime({ offset: true }).parse(input.sourceTimestamp);
    const apiVersion = input.apiVersion
      ? z.string().min(1).max(50).parse(input.apiVersion)
      : undefined;
    const rawBody = parseRawBody(input.rawBody);
    assertSyncItemIdentity({
      provider,
      eventType,
      externalEventId,
      externalObjectId,
      sourceTimestamp,
      ...(apiVersion ? { apiVersion } : {}),
      rawBody,
    });
    const existing = await this.options.repository.loadExistingReceipt(
      organizationId,
      connectionId,
      provider,
      externalEventId,
    );
    if (existing) {
      assertExistingEventIdentity(existing, {
        organizationId,
        connectionId,
        provider,
        eventType,
        externalEventId,
        externalObjectId,
        sourceTimestamp,
        ...(apiVersion ? { apiVersion } : {}),
        payloadSha256: sha256(rawBody),
      });
      return { duplicate: true, eventId: externalEventId, status: "queued" };
    }
    try {
      return await this.persistAndDispatch({
        organizationId,
        connectionId,
        provider,
        eventType,
        externalEventId,
        externalObjectId,
        sourceTimestamp,
        ...(apiVersion ? { apiVersion } : {}),
        receivedAt: this.#now().toISOString(),
        rawBody,
        correlationId: input.correlationId,
        ingress: "sync",
        requireImmediateDispatch: false,
        ...(traceContext ? { traceContext } : {}),
      });
    } catch (error) {
      if (error instanceof ProviderWebhookConflictError) {
        const raced = await this.options.repository.loadExistingReceipt(
          organizationId,
          connectionId,
          provider,
          externalEventId,
        );
        if (raced) {
          assertExistingEventIdentity(raced, {
            organizationId,
            connectionId,
            provider,
            eventType,
            externalEventId,
            externalObjectId,
            sourceTimestamp,
            ...(apiVersion ? { apiVersion } : {}),
            payloadSha256: sha256(rawBody),
          });
          return { duplicate: true, eventId: externalEventId, status: "queued" };
        }
      }
      throw error;
    }
  }

  public async processWebhook(
    envelopeInput: ProviderWebhookJobEnvelope,
  ): Promise<"processed" | "already_processed"> {
    return (await this.processWebhookWithMetadata(envelopeInput)).status;
  }

  public async processWebhookWithMetadata(
    envelopeInput: ProviderWebhookJobEnvelope,
  ): Promise<ProviderWebhookProcessResult> {
    const envelope = parseProviderWebhookEnvelope(envelopeInput);
    const receipt = await this.options.repository.loadForProcessing(envelope);
    if (!receipt) {
      throw new ProviderWebhookTerminalError(
        "WEBHOOK_NOT_FOUND",
        "provider webhook receipt was not found",
      );
    }
    assertEnvelopeAuthority(receipt, envelope);
    if (receipt.status === "processed" || receipt.status === "privacy_pending") {
      return {
        status: "already_processed",
        sourceTimestamp: receipt.sourceTimestamp,
      };
    }
    try {
      const rawBody = await this.options.objectStore.getVerified({
        key: receipt.objectKey,
        expectedChecksumSha256: receipt.payloadSha256,
        maximumBytes: PROVIDER_WEBHOOK_MAXIMUM_BYTES,
      });
      const payload = parseJson(rawBody);
      const records = normalizeProviderEvent(receipt, payload);
      const status = await this.options.repository.completeWebhook(
        envelope,
        records,
        this.#now().toISOString(),
      );
      return {
        status,
        sourceTimestamp: receipt.sourceTimestamp,
      };
    } catch (error) {
      const terminal =
        error instanceof ProviderWebhookTerminalError
          ? error
          : error instanceof ObjectIntegrityError || error instanceof ObjectNotFoundError
            ? new ProviderWebhookTerminalError(
                "WEBHOOK_OBJECT_INVALID",
                "provider webhook object failed integrity verification",
              )
            : error instanceof ConnectorError || error instanceof z.ZodError
              ? new ProviderWebhookTerminalError(
                  "WEBHOOK_PAYLOAD_INVALID",
                  "provider webhook payload failed normalization",
                )
              : undefined;
      if (!terminal) throw error;
      await this.options.repository.markWebhookFailed(
        envelope,
        terminal.code,
        this.#now().toISOString(),
      );
      throw terminal;
    }
  }

  private async requireAuthority(
    organizationId: OrganizationId,
    connectionId: string,
    provider: ProviderName,
  ): Promise<ProviderWebhookAuthority> {
    const authority = await this.options.repository.loadIngressAuthority(
      organizationId,
      connectionId,
      provider,
    );
    if (!authority) throw new ProviderWebhookAuthenticationError();
    return authority;
  }

  private async resolveSecret(authority: ProviderWebhookAuthority): Promise<string> {
    try {
      return await this.options.secrets.resolve({
        reference: authority.signingSecretReference,
        organizationId: authority.organizationId,
        connectionId: authority.connectionId,
        provider: authority.provider,
        purpose: "webhook_signing",
      });
    } catch {
      throw new ProviderWebhookAuthenticationError();
    }
  }

  private async persistAndDispatch(input: {
    readonly organizationId: OrganizationId;
    readonly connectionId: string;
    readonly provider: ProviderName;
    readonly eventType: string;
    readonly externalEventId: string;
    readonly externalObjectId: string;
    readonly sourceTimestamp: string;
    readonly apiVersion?: string;
    readonly receivedAt: string;
    readonly rawBody: Uint8Array;
    readonly correlationId: string;
    readonly traceContext?: DurableTraceContext;
    readonly ingress?: "webhook" | "sync";
    readonly requireImmediateDispatch?: boolean;
  }): Promise<ProviderWebhookResult> {
    const correlationId = z.uuid().parse(input.correlationId);
    const objectFamilies = classifyProviderSourceObjectFamilies(
      input.provider,
      input.eventType,
      input.rawBody,
    );
    const payloadSha256 = sha256(input.rawBody);
    const sourceEventId = stableUuid(
      [
        "provider-event",
        input.organizationId,
        input.connectionId,
        input.provider,
        input.externalEventId,
      ].join("\0"),
    );
    const objectKey = buildTenantObjectKey(
      this.options.environment,
      input.organizationId,
      "provider-events",
      sourceEventId,
      "payload.json",
    );
    try {
      await this.options.objectStore.putImmutable({
        key: objectKey,
        body: input.rawBody,
        contentType: "application/json",
        checksumSha256: payloadSha256,
        metadata: {
          "organization-id": input.organizationId,
          "source-event-id": sourceEventId,
          provider: input.provider,
        },
      });
    } catch (error) {
      if (error instanceof ObjectIntegrityError) throw new ProviderWebhookConflictError();
      throw error;
    }
    const ingress = input.ingress ?? "webhook";
    const idempotencyKey = [
      input.provider,
      ingress,
      input.connectionId,
      input.externalEventId,
      "v1",
    ].join(":");
    const envelope = parseProviderWebhookEnvelope({
      schemaVersion: 1,
      type: "connector.webhook.received",
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      provider: input.provider,
      eventType: input.eventType,
      externalEventId: input.externalEventId,
      correlationId,
      idempotencyKey,
      requestedBy:
        ingress === "webhook"
          ? `${input.provider}-webhook-ingress`
          : `${input.provider}-sync-worker`,
      createdAt: input.receivedAt,
      ...(input.traceContext ? { traceContext: input.traceContext } : {}),
    });
    const receipt: ProviderWebhookReceipt = {
      sourceEventId,
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      provider: input.provider,
      eventType: input.eventType,
      externalEventId: input.externalEventId,
      externalObjectId: input.externalObjectId,
      sourceTimestamp: input.sourceTimestamp,
      receivedAt: input.receivedAt,
      objectKey,
      payloadSha256,
      ...(input.apiVersion ? { apiVersion: input.apiVersion } : {}),
      status: "received",
    };
    const saved = await this.options.repository.saveReceiptAndOutbox(
      receipt,
      envelope,
      objectFamilies,
    );
    assertSameReceiptIdentity(saved.receipt, receipt);
    try {
      if (this.options.publisher) {
        await this.options.publisher.publish(saved.envelope);
        await this.options.repository.markOutboxPublished(
          input.organizationId,
          saved.envelope.idempotencyKey,
          input.receivedAt,
        );
      } else if (input.requireImmediateDispatch ?? ingress === "webhook") {
        throw new ProviderWebhookDispatchError();
      }
    } catch {
      throw new ProviderWebhookDispatchError();
    }
    return {
      duplicate: !saved.inserted,
      eventId: input.externalEventId,
      status: "queued",
    };
  }
}

function normalizeProviderEvent(
  receipt: ProviderWebhookReceipt,
  payload: unknown,
): readonly CanonicalRecord[] {
  if (receipt.provider === "shopify") {
    if (receipt.eventType === "orders/snapshot") {
      const value = ShopifyOrderSnapshotEnvelopeSchema.parse(payload);
      const refundTransactionIds = shopifyOrderSnapshotRefundTransactionIds(value);
      return normalizeShopifyOrderSnapshotRecords(value, {
        order: {
          organizationId: receipt.organizationId,
          canonicalRecordId: stableCanonicalId(
            receipt.organizationId,
            receipt.provider,
            "order",
            value.order.legacyResourceId,
          ),
          version: 1,
          sourceEventId: receipt.sourceEventId,
          ingestionTimestamp: receipt.receivedAt,
        },
        refunds: refundTransactionIds.map((externalId) => ({
          organizationId: receipt.organizationId,
          canonicalRecordId: stableCanonicalId(
            receipt.organizationId,
            receipt.provider,
            "refund",
            externalId,
          ),
          version: 1,
          sourceEventId: receipt.sourceEventId,
          ingestionTimestamp: receipt.receivedAt,
        })),
      });
    }
    if (receipt.eventType === "orders/create" || receipt.eventType === "orders/updated") {
      const value = ShopifyOrderWebhookSchema.parse(payload);
      return [
        normalizeShopifyOrder(value, {
          organizationId: receipt.organizationId,
          canonicalRecordId: stableCanonicalId(
            receipt.organizationId,
            receipt.provider,
            "order",
            value.id,
          ),
          version: 1,
          sourceEventId: receipt.sourceEventId,
          ingestionTimestamp: receipt.receivedAt,
        }),
      ];
    }
    if (receipt.eventType === "refunds/create") {
      const value = ShopifyRefundWebhookSchema.parse(payload);
      const successful = value.transactions.filter(
        (transaction) => transaction.status === "success",
      );
      return normalizeShopifyRefunds(
        value,
        successful.map((transaction) => ({
          organizationId: receipt.organizationId,
          canonicalRecordId: stableCanonicalId(
            receipt.organizationId,
            receipt.provider,
            "refund",
            transaction.id,
          ),
          version: 1,
          sourceEventId: receipt.sourceEventId,
          ingestionTimestamp: receipt.receivedAt,
        })),
      );
    }
    if (supportedShopifyTopicSchema.safeParse(receipt.eventType).success) return [];
    throw new ProviderWebhookTerminalError(
      "WEBHOOK_EVENT_UNSUPPORTED",
      "Shopify event type is unsupported",
    );
  }

  if (receipt.eventType === "balance_transaction.snapshot") {
    const snapshot = StripeBalanceTransactionSnapshotSchema.parse(payload);
    return [
      normalizeStripeBalanceTransaction(snapshot, {
        organizationId: receipt.organizationId,
        canonicalRecordId: stableCanonicalId(
          receipt.organizationId,
          receipt.provider,
          "processing_fee",
          snapshot.balanceTransaction.id,
        ),
        version: 1,
        sourceEventId: receipt.sourceEventId,
        ingestionTimestamp: receipt.receivedAt,
      }),
    ];
  }
  const event = SupportedStripeEventSchema.parse(payload);
  if (event.data.object.object === "payment_intent") {
    return [
      normalizeStripePayment(event, {
        organizationId: receipt.organizationId,
        canonicalRecordId: stableCanonicalId(
          receipt.organizationId,
          receipt.provider,
          "payment",
          event.data.object.id,
        ),
        version: 1,
        sourceEventId: receipt.sourceEventId,
        ingestionTimestamp: receipt.receivedAt,
      }),
    ];
  }
  return [
    normalizeStripeRefund(event, {
      organizationId: receipt.organizationId,
      canonicalRecordId: stableCanonicalId(
        receipt.organizationId,
        receipt.provider,
        "refund",
        event.data.object.id,
      ),
      version: 1,
      sourceEventId: receipt.sourceEventId,
      ingestionTimestamp: receipt.receivedAt,
    }),
  ];
}

function shopifyEventIdentity(
  topic: z.infer<typeof supportedShopifyTopicSchema>,
  payload: unknown,
): { readonly externalObjectId: string; readonly sourceTimestamp?: string } {
  if (topic === "orders/create" || topic === "orders/updated") {
    const order = ShopifyOrderWebhookSchema.parse(payload);
    return { externalObjectId: order.id, sourceTimestamp: order.processed_at };
  }
  const refund = ShopifyRefundWebhookSchema.parse(payload);
  return { externalObjectId: refund.id, sourceTimestamp: refund.created_at };
}

function parseRawBody(value: Uint8Array): Uint8Array {
  if (value.byteLength < 1 || value.byteLength > PROVIDER_WEBHOOK_MAXIMUM_BYTES) {
    throw new ProviderWebhookValidationError("provider webhook body is outside the byte limit");
  }
  return value;
}

function parseJson(rawBody: Uint8Array): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderWebhookValidationError("provider webhook body is not valid UTF-8 JSON");
  }
}

/**
 * Replays the exact V1 provider classifier over integrity-verified immutable receipt bytes.
 *
 * This is also the sole classifier used by the bounded legacy-repair command. Callers must verify
 * the object key and stored SHA-256 before invoking it; a transport topic alone is not authority.
 */
export function classifyProviderSourceObjectFamilies(
  provider: ProviderName,
  eventType: string,
  rawBody: Uint8Array,
): readonly SourceObjectFamily[] {
  if (provider === "shopify") {
    if (eventType === "orders/create" || eventType === "orders/updated") {
      ShopifyOrderWebhookSchema.parse(parseJson(rawBody));
      return ["order"];
    }
    if (eventType === "refunds/create") {
      ShopifyRefundWebhookSchema.parse(parseJson(rawBody));
      return ["refund_transaction"];
    }
    if (eventType === "orders/snapshot") {
      const snapshot = ShopifyOrderSnapshotEnvelopeSchema.parse(parseJson(rawBody));
      return shopifyOrderSnapshotRefundTransactionIds(snapshot).length > 0
        ? ["order", "refund_transaction"]
        : ["order"];
    }
    throw new ProviderWebhookValidationError("Shopify source-object family is unsupported");
  }

  if (eventType === "balance_transaction.snapshot") {
    StripeBalanceTransactionSnapshotSchema.parse(parseJson(rawBody));
    return ["balance_transaction"];
  }
  const event = SupportedStripeEventSchema.parse(parseJson(rawBody));
  if (event.type !== eventType) {
    throw new ProviderWebhookValidationError(
      "Stripe event type does not match source-object classification",
    );
  }
  return [
    SourceObjectFamilySchema.parse(
      event.data.object.object === "payment_intent" ? "payment_intent" : "refund",
    ),
  ];
}

function parseProviderWebhookEnvelope(value: unknown): ProviderWebhookJobEnvelope {
  const envelope = ConnectorJobEnvelopeSchema.parse(value);
  if (envelope.type !== "connector.webhook.received") {
    throw new ProviderWebhookValidationError("expected a provider webhook job");
  }
  return envelope;
}

function assertEnvelopeAuthority(
  receipt: ProviderWebhookReceipt,
  envelope: ProviderWebhookJobEnvelope,
): void {
  const expectedIngress =
    envelope.requestedBy === `${receipt.provider}-webhook-ingress`
      ? "webhook"
      : envelope.requestedBy === `${receipt.provider}-sync-worker`
        ? "sync"
        : undefined;
  if (
    !expectedIngress ||
    receipt.organizationId !== envelope.organizationId ||
    receipt.connectionId !== envelope.connectionId ||
    receipt.provider !== envelope.provider ||
    receipt.eventType !== envelope.eventType ||
    receipt.externalEventId !== envelope.externalEventId ||
    `${receipt.provider}:${expectedIngress}:${receipt.connectionId}:${receipt.externalEventId}:v1` !==
      envelope.idempotencyKey
  ) {
    throw new ProviderWebhookTerminalError(
      "WEBHOOK_AUTHORITY_MISMATCH",
      "provider webhook job does not match its durable receipt",
    );
  }
}

function assertSameReceiptIdentity(
  left: ProviderWebhookReceipt,
  right: ProviderWebhookReceipt,
): void {
  const fields: readonly (keyof ProviderWebhookReceipt)[] = [
    "sourceEventId",
    "organizationId",
    "connectionId",
    "provider",
    "eventType",
    "externalEventId",
    "externalObjectId",
    "sourceTimestamp",
    "objectKey",
    "payloadSha256",
    "apiVersion",
  ];
  if (fields.some((field) => left[field] !== right[field])) {
    throw new ProviderWebhookConflictError();
  }
}

function assertExistingEventIdentity(
  existing: ProviderWebhookReceipt,
  expected: {
    readonly organizationId: OrganizationId;
    readonly connectionId: string;
    readonly provider: ProviderName;
    readonly eventType: string;
    readonly externalEventId: string;
    readonly externalObjectId: string;
    readonly sourceTimestamp: string;
    readonly apiVersion?: string;
    readonly payloadSha256: string;
  },
): void {
  const fields = [
    "organizationId",
    "connectionId",
    "provider",
    "eventType",
    "externalEventId",
    "externalObjectId",
    "sourceTimestamp",
    "apiVersion",
    "payloadSha256",
  ] as const;
  if (fields.some((field) => existing[field] !== expected[field])) {
    throw new ProviderWebhookConflictError();
  }
}

function assertSyncItemIdentity(input: {
  readonly provider: ProviderName;
  readonly eventType: string;
  readonly externalEventId: string;
  readonly externalObjectId: string;
  readonly sourceTimestamp: string;
  readonly apiVersion?: string;
  readonly rawBody: Uint8Array;
}): void {
  const payload = parseJson(input.rawBody);
  if (input.provider === "stripe") {
    if (input.eventType === "balance_transaction.snapshot") {
      const snapshot = StripeBalanceTransactionSnapshotSchema.parse(payload);
      if (
        snapshot.balanceTransaction.id !== input.externalEventId ||
        snapshot.balanceTransaction.id !== input.externalObjectId ||
        new Date(snapshot.balanceTransaction.created * 1000).toISOString() !==
          input.sourceTimestamp ||
        snapshot.apiVersion !== input.apiVersion
      ) {
        throw new ProviderWebhookValidationError(
          "Stripe balance transaction identity does not match its source snapshot",
        );
      }
      return;
    }
    const event = SupportedStripeEventSchema.parse(payload);
    if (
      event.id !== input.externalEventId ||
      event.type !== input.eventType ||
      event.data.object.id !== input.externalObjectId ||
      new Date(event.created * 1000).toISOString() !== input.sourceTimestamp ||
      (event.api_version ?? undefined) !== input.apiVersion
    ) {
      throw new ProviderWebhookValidationError(
        "Stripe sync item identity does not match its raw event",
      );
    }
    return;
  }
  if (input.eventType !== "orders/snapshot") {
    throw new ProviderWebhookValidationError("Shopify sync item type is unsupported");
  }
  const identity = shopifyOrderSnapshotIdentity(payload);
  if (
    identity.externalEventId !== input.externalEventId ||
    identity.externalObjectId !== input.externalObjectId ||
    identity.sourceTimestamp !== input.sourceTimestamp ||
    identity.apiVersion !== input.apiVersion
  ) {
    throw new ProviderWebhookValidationError(
      "Shopify sync item identity does not match its raw snapshot",
    );
  }
}

function stableCanonicalId(
  organizationId: OrganizationId,
  provider: ProviderName,
  kind: string,
  externalObjectId: string,
): string {
  return stableUuid(
    ["canonical-record", organizationId, provider, kind, externalObjectId].join("\0"),
  );
}

function stableUuid(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function providerMetadata(provider: ProviderName) {
  return provider === "shopify" ? shopifyMetadata : stripeMetadata;
}
