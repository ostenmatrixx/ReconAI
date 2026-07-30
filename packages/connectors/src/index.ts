import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { OrganizationId, TenantContext } from "@workspace/domain";
import { OrganizationIdSchema } from "@workspace/domain";
import { z } from "zod";

export const CONNECTOR_QUEUE = "connector-v1";

export const ConnectorNameSchema = z.enum(["shopify", "stripe", "accounting_csv"]);
export type ConnectorName = z.infer<typeof ConnectorNameSchema>;

/**
 * Fixed V1 source-object families. Provider event topics are transport/version details and must not
 * be treated as this product-facing classification.
 */
export const SourceObjectFamilySchema = z.enum([
  "order",
  "refund_transaction",
  "payment_intent",
  "refund",
  "balance_transaction",
  "csv_row",
]);
export type SourceObjectFamily = z.infer<typeof SourceObjectFamilySchema>;

export interface ConnectorMetadata {
  readonly name: ConnectorName;
  readonly connectorVersion: string;
  readonly normalizerVersion: string;
  readonly readOnly: true;
}

export type ProviderName = "shopify" | "stripe";
export type ProviderSyncMode = "backfill" | "gap_repair";
export const ConnectorCredentialPurposeSchema = z.enum(["webhook_signing", "api_read"]);
export type ConnectorCredentialPurpose = z.infer<typeof ConnectorCredentialPurposeSchema>;

const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);
const providerTokenSchema = z
  .string()
  .min(16)
  .max(2048)
  .refine((value) => !/[\0\r\n]/u.test(value), "provider token contains a control character");
const providerAuthorizationStateSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/u);
const providerAuthorizationStateDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const providerScopeSchema = z.string().regex(/^[a-z][a-z0-9_:./-]{0,99}$/u);
const shopifyAccountSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/u);
const stripeAccountSchema = z.string().regex(/^acct_[A-Za-z0-9]{1,250}$/u);

export const ProviderAuthorizationStateSchema = providerAuthorizationStateSchema;
export const ProviderAuthorizationStateDigestSchema = providerAuthorizationStateDigestSchema;

const oauthTokenBundleBase = z.object({
  schemaVersion: z.literal(1),
  credentialType: z.literal("oauth_refreshable"),
  accessToken: providerTokenSchema,
  refreshToken: providerTokenSchema,
  accessTokenExpiresAt: z.iso.datetime({ offset: true }),
  refreshTokenExpiresAt: z.iso.datetime({ offset: true }),
  scopes: z.array(providerScopeSchema).min(1).max(50),
  issuedAt: z.iso.datetime({ offset: true }),
});

export const ProviderOAuthTokenBundleSchema = z.discriminatedUnion("provider", [
  oauthTokenBundleBase
    .extend({
      provider: z.literal("shopify"),
      externalAccountId: shopifyAccountSchema,
    })
    .strict(),
  oauthTokenBundleBase
    .extend({
      provider: z.literal("stripe"),
      externalAccountId: stripeAccountSchema,
      livemode: z.boolean(),
      authorizationGrantedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
]);
export type ProviderOAuthTokenBundle = z.infer<typeof ProviderOAuthTokenBundleSchema>;

export interface ProviderAuthorizationState {
  readonly value: string;
  readonly sha256: string;
}

export function createProviderAuthorizationState(): ProviderAuthorizationState {
  const value = providerAuthorizationStateSchema.parse(randomBytes(32).toString("base64url"));
  return Object.freeze({ value, sha256: providerAuthorizationStateSha256(value) });
}

export function providerAuthorizationStateSha256(valueInput: string): string {
  const value = providerAuthorizationStateSchema.parse(valueInput);
  return providerAuthorizationStateDigestSchema.parse(
    createHash("sha256").update(value, "ascii").digest("hex"),
  );
}

export function serializeProviderOAuthTokenBundle(input: ProviderOAuthTokenBundle): string {
  const bundle = validatedProviderOAuthTokenBundle(input);
  const serialized = JSON.stringify(bundle);
  if (Buffer.byteLength(serialized, "utf8") > 4096) {
    throw new ConnectorError("authentication", "provider OAuth token bundle exceeds policy");
  }
  return serialized;
}

export function parseProviderOAuthTokenBundle(input: string): ProviderOAuthTokenBundle {
  if (input.length === 0 || Buffer.byteLength(input, "utf8") > 4096 || /[\0\r\n]/u.test(input)) {
    throw new ConnectorError("authentication", "provider OAuth token bundle is invalid");
  }
  try {
    return validatedProviderOAuthTokenBundle(JSON.parse(input));
  } catch {
    throw new ConnectorError("authentication", "provider OAuth token bundle is invalid");
  }
}

function validatedProviderOAuthTokenBundle(input: unknown): ProviderOAuthTokenBundle {
  const bundle = ProviderOAuthTokenBundleSchema.parse(input);
  const issuedAt = Date.parse(bundle.issuedAt);
  const accessTokenExpiresAt = Date.parse(bundle.accessTokenExpiresAt);
  const refreshTokenExpiresAt = Date.parse(bundle.refreshTokenExpiresAt);
  if (
    accessTokenExpiresAt <= issuedAt ||
    refreshTokenExpiresAt <= accessTokenExpiresAt ||
    (bundle.provider === "stripe" && Date.parse(bundle.authorizationGrantedAt) > issuedAt) ||
    new Set(bundle.scopes).size !== bundle.scopes.length
  ) {
    throw new TypeError("provider OAuth token bundle chronology or scopes are invalid");
  }
  return bundle;
}

export const ConnectorCredentialEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal("A256GCM"),
    keyVersion: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/u),
    organizationId: OrganizationIdSchema,
    connectionId: z.uuid(),
    provider: z.enum(["shopify", "stripe"]),
    purpose: ConnectorCredentialPurposeSchema,
    iv: base64UrlSchema,
    ciphertext: base64UrlSchema,
    tag: base64UrlSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (decodeBase64Url(value.iv)?.byteLength !== 12) {
      context.addIssue({ code: "custom", path: ["iv"], message: "iv must contain 12 bytes" });
    }
    const ciphertextLength = decodeBase64Url(value.ciphertext)?.byteLength;
    if (ciphertextLength === undefined || ciphertextLength < 16 || ciphertextLength > 4096) {
      context.addIssue({
        code: "custom",
        path: ["ciphertext"],
        message: "ciphertext must contain between 16 and 4096 bytes",
      });
    }
    if (decodeBase64Url(value.tag)?.byteLength !== 16) {
      context.addIssue({
        code: "custom",
        path: ["tag"],
        message: "authentication tag must contain 16 bytes",
      });
    }
  });
export type ConnectorCredentialEnvelope = z.infer<typeof ConnectorCredentialEnvelopeSchema>;

export interface ConnectorCredentialKeyring {
  readonly activeVersion: string;
  readonly keys: ReadonlyMap<string, Uint8Array>;
}

export interface ConnectorSecretRequest {
  readonly reference: string;
  readonly organizationId: OrganizationId;
  readonly connectionId: string;
  readonly provider: ProviderName;
  readonly purpose: ConnectorCredentialPurpose;
}

export interface ProviderPageRequest {
  readonly organizationId: OrganizationId;
  readonly connectionId: string;
  readonly provider: ProviderName;
  readonly externalAccountId: string;
  readonly apiCredentialReference: string;
  readonly configuredApiVersion?: string;
  readonly mode: ProviderSyncMode;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface ProviderPageItem {
  readonly eventType: string;
  readonly externalEventId: string;
  readonly externalObjectId: string;
  readonly sourceTimestamp: string;
  readonly apiVersion?: string;
  readonly rawBody: Uint8Array;
}

export interface ProviderPage {
  readonly items: readonly ProviderPageItem[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
  /**
   * Marks a bounded local source-stream transition. Unlike an ordinary provider cursor, a phase
   * transition may legitimately contain zero items after one completed provider request.
   */
  readonly continuationKind?: "source_phase";
}

export interface ProviderPageSource {
  readonly provider: ProviderName;
  fetchPage(request: ProviderPageRequest): Promise<ProviderPage>;
}

export interface WebhookReceipt {
  readonly organizationId: OrganizationId;
  readonly connectionId: string;
  readonly connector: ConnectorName;
  readonly externalEventId: string;
  readonly receivedAt: string;
  readonly rawBodySha256: string;
  readonly status: "received" | "processed" | "failed";
}

export interface WebhookReceiptStore {
  insertIfAbsent(receipt: WebhookReceipt): Promise<"inserted" | "duplicate">;
}

export type EnqueueWebhook = (job: ConnectorJobEnvelope) => Promise<void>;

export const DurableTraceContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    traceparent: z
      .string()
      .regex(
        /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-(?:00|01)$/u,
        "traceparent must be a bounded W3C version-00 context",
      ),
  })
  .strict();
export type DurableTraceContext = z.infer<typeof DurableTraceContextSchema>;

export function createDurableTraceContext(
  traceparent: string | undefined,
): DurableTraceContext | undefined {
  if (traceparent === undefined) return undefined;
  return DurableTraceContextSchema.parse({ schemaVersion: 1, traceparent });
}

const durableJobEnvelopeBase = z.object({
  schemaVersion: z.literal(1),
  organizationId: OrganizationIdSchema,
  correlationId: z.uuid(),
  idempotencyKey: z.string().min(1).max(500),
  requestedBy: z.string().min(1).max(255),
  createdAt: z.iso.datetime({ offset: true }),
  traceContext: DurableTraceContextSchema.optional(),
});

const connectorJobEnvelopeBase = durableJobEnvelopeBase.extend({
  connectionId: z.uuid(),
});

export const DURABLE_JOB_TYPES = [
  "connector.webhook.received",
  "csv.import.commit",
  "connector.sync.requested",
  "reconciliation.run.requested",
] as const;

const webhookJobEnvelope = connectorJobEnvelopeBase
  .extend({
    type: z.literal(DURABLE_JOB_TYPES[0]),
    provider: z.enum(["shopify", "stripe"]),
    eventType: z.string().regex(/^[a-z0-9._/-]{1,100}$/u),
    externalEventId: z.string().regex(/^[A-Za-z0-9._:/-]{1,255}$/u),
  })
  .strict();

const csvImportJobEnvelope = connectorJobEnvelopeBase
  .extend({
    type: z.literal(DURABLE_JOB_TYPES[1]),
    importId: z.uuid(),
  })
  .strict();

const providerSyncJobEnvelope = connectorJobEnvelopeBase
  .extend({
    type: z.literal(DURABLE_JOB_TYPES[2]),
    provider: z.enum(["shopify", "stripe"]),
    syncRunId: z.uuid(),
    executionAttempt: z.number().int().min(1).max(6),
  })
  .strict();

export const ConnectorJobEnvelopeSchema = z.discriminatedUnion("type", [
  webhookJobEnvelope,
  csvImportJobEnvelope,
  providerSyncJobEnvelope,
]);

export const ReconciliationRunJobEnvelopeSchema = durableJobEnvelopeBase
  .extend({
    type: z.literal(DURABLE_JOB_TYPES[3]),
    runId: z.uuid(),
    executionAttempt: z.number().int().min(1).max(100),
  })
  .strict();

export const DurableJobEnvelopeSchema = z.discriminatedUnion("type", [
  webhookJobEnvelope,
  csvImportJobEnvelope,
  providerSyncJobEnvelope,
  ReconciliationRunJobEnvelopeSchema,
]);

export const CsvImportJobEnvelopeSchema = csvImportJobEnvelope;
export const ProviderSyncJobEnvelopeSchema = providerSyncJobEnvelope;

export type ConnectorJobEnvelope = z.infer<typeof ConnectorJobEnvelopeSchema>;
export type CsvImportJobEnvelope = z.infer<typeof CsvImportJobEnvelopeSchema>;
export type ProviderSyncJobEnvelope = z.infer<typeof ProviderSyncJobEnvelopeSchema>;
export type ReconciliationRunJobEnvelope = z.infer<typeof ReconciliationRunJobEnvelopeSchema>;
export type DurableJobEnvelope = z.infer<typeof DurableJobEnvelopeSchema>;

export const OutboxPayloadSchema = z
  .object({
    envelope: ConnectorJobEnvelopeSchema,
  })
  .strict();

export function connectorJobId(envelope: ConnectorJobEnvelope): string {
  return durableJobId(ConnectorJobEnvelopeSchema.parse(envelope));
}

export function durableJobId(envelope: DurableJobEnvelope): string {
  return createHash("sha256")
    .update(stableEnvelope(DurableJobEnvelopeSchema.parse(envelope)))
    .digest("hex");
}

export function connectorQueueName(environment: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/u.test(environment)) {
    throw new TypeError("queue environment is invalid");
  }
  return `reconai-${environment}-${CONNECTOR_QUEUE}`;
}

export const durableQueueName = connectorQueueName;

function stableEnvelope(envelope: DurableJobEnvelope): string {
  return JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    type: envelope.type,
    organizationId: envelope.organizationId,
    ...(envelope.type === "connector.webhook.received"
      ? {
          connectionId: envelope.connectionId,
          provider: envelope.provider,
          eventType: envelope.eventType,
          externalEventId: envelope.externalEventId,
        }
      : envelope.type === "csv.import.commit"
        ? { connectionId: envelope.connectionId, importId: envelope.importId }
        : envelope.type === "connector.sync.requested"
          ? {
              connectionId: envelope.connectionId,
              provider: envelope.provider,
              syncRunId: envelope.syncRunId,
              executionAttempt: envelope.executionAttempt,
            }
          : { runId: envelope.runId, executionAttempt: envelope.executionAttempt }),
    correlationId: envelope.correlationId,
    idempotencyKey: envelope.idempotencyKey,
    requestedBy: envelope.requestedBy,
    createdAt: envelope.createdAt,
    ...(envelope.traceContext ? { traceContext: envelope.traceContext } : {}),
  });
}

export interface AuthorizedConnectorContext {
  readonly tenant: TenantContext;
  readonly connectionId: string;
  readonly correlationId: string;
}

export interface ConnectorHealth {
  readonly state:
    "healthy" | "backfilling" | "degraded" | "stale" | "disconnected" | "action_required";
  readonly lastSuccessfulSyncAt?: string;
  readonly lastVerifiedWebhookAt?: string;
  readonly cursor?: string;
  readonly retryCount: number;
  readonly deadLetterCount: number;
  readonly errorCode?: string;
}

export interface ConnectorSecretResolver {
  resolve(request: ConnectorSecretRequest): Promise<string>;
}

export class EnvironmentConnectorSecretResolver implements ConnectorSecretResolver {
  public constructor(private readonly environment: Readonly<Record<string, string | undefined>>) {}

  public async resolve(request: ConnectorSecretRequest): Promise<string> {
    const match = /^env:(RECONAI_CONNECTOR_[A-Z0-9_]{1,100})$/u.exec(request.reference);
    if (!match?.[1]) throw new ConnectorError("authentication", "unsupported secret reference");
    const value = this.environment[match[1]];
    if (!value || value.length < 16 || value.length > 16_384) {
      throw new ConnectorError("authentication", "connector secret is unavailable");
    }
    return value;
  }
}

export function createConnectorCredentialKeyring(input: {
  readonly references: string;
  readonly activeVersion: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly production: boolean;
}): ConnectorCredentialKeyring {
  const activeVersion = z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,31}$/u)
    .parse(input.activeVersion);
  const keys = new Map<string, Uint8Array>();
  for (const entry of input.references.split(",")) {
    const match =
      /^([a-z0-9][a-z0-9._-]{0,31})=env:(RECONAI_CONNECTOR_ENCRYPTION_KEY_[A-Z0-9_]{1,80})$/u.exec(
        entry.trim(),
      );
    if (!match?.[1] || !match[2] || keys.has(match[1])) {
      throw new TypeError("CONNECTOR_ENCRYPTION_KEYS contains an invalid or duplicate entry");
    }
    const encoded = input.environment[match[2]];
    const key = encoded ? decodeBase64Url(encoded) : undefined;
    if (key?.byteLength !== 32) {
      throw new TypeError(`connector encryption key ${match[1]} must contain 32 base64url bytes`);
    }
    if (input.production && key.every((value) => value === 0)) {
      throw new TypeError("production connector encryption keys cannot use the local placeholder");
    }
    keys.set(match[1], key);
  }
  if (!keys.has(activeVersion)) {
    throw new TypeError("CONNECTOR_ENCRYPTION_ACTIVE_KEY_VERSION is not configured");
  }
  return Object.freeze({ activeVersion, keys });
}

export function sealConnectorCredential(
  input: Omit<
    ConnectorCredentialEnvelope,
    "schemaVersion" | "algorithm" | "keyVersion" | "iv" | "ciphertext" | "tag"
  > & { readonly secret: string },
  keyring: ConnectorCredentialKeyring,
): ConnectorCredentialEnvelope {
  const context = connectorCredentialContextSchema.parse({
    organizationId: input.organizationId,
    connectionId: input.connectionId,
    provider: input.provider,
    purpose: input.purpose,
  });
  const secret = parseConnectorSecret(input.secret);
  const key = requireConnectorCredentialKey(keyring, keyring.activeVersion);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(
    Buffer.from(connectorCredentialAad({ ...context, keyVersion: keyring.activeVersion })),
  );
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ConnectorCredentialEnvelopeSchema.parse({
    schemaVersion: 1,
    algorithm: "A256GCM",
    keyVersion: keyring.activeVersion,
    ...context,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  });
}

export function openConnectorCredential(
  envelopeInput: ConnectorCredentialEnvelope,
  keyring: ConnectorCredentialKeyring,
): string {
  const envelope = ConnectorCredentialEnvelopeSchema.parse(envelopeInput);
  const key = requireConnectorCredentialKey(keyring, envelope.keyVersion);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(Buffer.from(connectorCredentialAad(envelope)));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return parseConnectorSecret(plaintext);
  } catch {
    throw new ConnectorError("authentication", "connector credential could not be opened");
  }
}

export function connectorCredentialEnvelopeSha256(
  envelopeInput: ConnectorCredentialEnvelope,
): string {
  const envelope = ConnectorCredentialEnvelopeSchema.parse(envelopeInput);
  return createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
}

const connectorCredentialContextSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    connectionId: z.uuid(),
    provider: z.enum(["shopify", "stripe"]),
    purpose: ConnectorCredentialPurposeSchema,
  })
  .strict();

function connectorCredentialAad(
  input: z.infer<typeof connectorCredentialContextSchema> & { readonly keyVersion: string },
): string {
  return [
    "reconai-connector-credential-v1",
    input.organizationId,
    input.connectionId,
    input.provider,
    input.purpose,
    input.keyVersion,
  ].join("\0");
}

function parseConnectorSecret(value: string): string {
  if (
    value.length < 16 ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new ConnectorError("authentication", "connector secret does not satisfy policy");
  }
  return value;
}

function requireConnectorCredentialKey(
  keyring: ConnectorCredentialKeyring,
  version: string,
): Uint8Array {
  const key = keyring.keys.get(version);
  if (key?.byteLength !== 32) {
    throw new ConnectorError("authentication", "connector credential key is unavailable");
  }
  return key;
}

function decodeBase64Url(value: string): Buffer | undefined {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export type ConnectorFailureKind =
  | "authentication"
  | "authorization"
  | "rate_limited"
  | "timeout"
  | "invalid_payload"
  | "provider_unavailable"
  | "terminal";

export class ConnectorError extends Error {
  public constructor(
    public readonly kind: ConnectorFailureKind,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export function retryDelayMs(attempt: number, baseMs = 500, maximumMs = 60_000): number {
  if (!Number.isInteger(attempt) || attempt < 1)
    throw new Error("attempt must be a positive integer");
  const exponential = Math.min(maximumMs, baseMs * 2 ** Math.min(attempt - 1, 10));
  // Deterministic jitter by attempt makes tests reproducible while avoiding identical retry cadence.
  const jitter = (attempt * 7919) % Math.max(1, Math.floor(exponential / 4));
  return Math.min(maximumMs, exponential - Math.floor(exponential / 8) + jitter);
}

export class InMemoryWebhookReceiptStore implements WebhookReceiptStore {
  readonly #keys = new Set<string>();

  public async insertIfAbsent(receipt: WebhookReceipt): Promise<"inserted" | "duplicate"> {
    const key = [
      receipt.organizationId,
      receipt.connectionId,
      receipt.connector,
      receipt.externalEventId,
    ].join("\0");
    if (this.#keys.has(key)) return "duplicate";
    this.#keys.add(key);
    return "inserted";
  }
}
