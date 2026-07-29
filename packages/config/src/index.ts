import { Buffer } from "node:buffer";
import { isIP } from "node:net";

import { z } from "zod";

const booleanFromString = z.enum(["true", "false"]).transform((value) => value === "true");
const optionalUrl = z.union([z.url(), z.literal("")]).transform((value) => value || undefined);
const optionalString = z
  .union([z.string().min(1), z.literal("")])
  .transform((value) => value || undefined);
const optionalEmail = z
  .union([z.email().max(320), z.literal("")])
  .transform((value) => value || undefined);
const optionalS3Encryption = z
  .union([z.enum(["AES256", "aws:kms"]), z.literal("")])
  .transform((value) => value || undefined);
const optionalOAuthClientId = z
  .union([z.string().regex(/^[A-Za-z0-9_-]{8,255}$/u), z.literal("")])
  .transform((value) => value || undefined);
const optionalOAuthSecret = z
  .union([
    z
      .string()
      .min(16)
      .max(512)
      .refine((value) => !/[\0\r\n]/u.test(value)),
    z.literal(""),
  ])
  .transform((value) => value || undefined);
const optionalStripeAppId = z
  .union([z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/u), z.literal("")])
  .transform((value) => value || undefined);
const optionalRateLimitKeySecret = z
  .union([
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{43,86}$/u)
      .refine(isCanonicalRateLimitKey, "must encode 32–64 random bytes as canonical base64url"),
    z.literal(""),
  ])
  .transform((value) => value || undefined);
const optionalSupportClaim = z
  .union([
    z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !/[\0\r\n]/u.test(value)),
    z.literal(""),
  ])
  .transform((value) => value || undefined);
const optionalSupportIdentityKey = z
  .union([
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{43,86}$/u)
      .refine(
        isCanonicalPseudonymizationKey,
        "must encode 32–64 random bytes as canonical base64url",
      ),
    z.literal(""),
  ])
  .transform((value) => value || undefined);

const BaseConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/u),
  WEB_ORIGIN: z.url(),
  API_ORIGIN: z.url(),
  API_HOST: z
    .string()
    .regex(/^(?:127\.0\.0\.1|0\.0\.0\.0|::1|::)$/u)
    .default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  API_READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(5000).default(1000),
  API_TRUST_PROXY_CIDRS: z.string().max(1000).default("").transform(parseTrustedProxyCidrs),
  API_RATE_LIMIT_STORE: z.enum(["local", "redis"]).default("local"),
  API_RATE_LIMIT_KEY_SECRET: optionalRateLimitKeySecret.default(""),
  API_RATE_LIMIT_REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(5000).default(1000),
  API_RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(50).max(5000).default(1000),
  RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(120_000)
    .default(30_000),
  RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS: z.coerce.number().int().min(1).max(10).default(2),
  DATABASE_URL: z.string().startsWith("postgresql://"),
  DATABASE_WORKER_URL: z.string().startsWith("postgresql://"),
  REDIS_URL: z.string().startsWith("redis://"),
  DURABLE_QUEUE_MONITOR_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(15_000),
  DURABLE_QUEUE_MONITOR_REDIS_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(5_000)
    .default(1_000),
  DURABLE_QUEUE_MONITOR_REDIS_COMMAND_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(50)
    .max(5_000)
    .default(1_000),
  PROVIDER_CIRCUIT_REDIS_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(5_000)
    .default(1_000),
  PROVIDER_CIRCUIT_REDIS_COMMAND_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(50)
    .max(5_000)
    .default(1_000),
  PROVIDER_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(20).default(3),
  PROVIDER_CIRCUIT_OPEN_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(15 * 60 * 1_000)
    .default(60_000),
  PROVIDER_CIRCUIT_PROBE_LEASE_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanFromString.default(true),
  S3_SERVER_SIDE_ENCRYPTION: optionalS3Encryption,
  S3_KMS_KEY_ID: optionalString,
  OIDC_ISSUER: z.url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  OIDC_ID_TOKEN_SIGNING_ALGORITHM: z.enum(["RS256", "PS256", "ES256"]).default("RS256"),
  SUPPORT_ACCESS_ENABLED: booleanFromString.default(false),
  SUPPORT_OIDC_GROUP: optionalSupportClaim.default(""),
  SUPPORT_OIDC_AUTHENTICATION_CONTEXT: optionalSupportClaim.default(""),
  SUPPORT_IDENTITY_HMAC_KEY: optionalSupportIdentityKey.default(""),
  SESSION_SECRET: z.string().min(32),
  SESSION_COOKIE_SECURE: booleanFromString,
  SESSION_REVOCATION_STORE: z.enum(["local", "redis"]).default("local"),
  SESSION_REVOCATION_REDIS_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(5000)
    .default(1000),
  SESSION_REVOCATION_REDIS_COMMAND_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(50)
    .max(5000)
    .default(1000),
  CONNECTOR_ENCRYPTION_KEYS: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9._-]{0,31}=env:RECONAI_CONNECTOR_ENCRYPTION_KEY_[A-Z0-9_]{1,80}(?:,[a-z0-9][a-z0-9._-]{0,31}=env:RECONAI_CONNECTOR_ENCRYPTION_KEY_[A-Z0-9_]{1,80})*$/u,
    ),
  CONNECTOR_ENCRYPTION_ACTIVE_KEY_VERSION: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/u),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  OTEL_TRACE_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(0.1),
  OTEL_METRIC_EXPORT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  OTEL_EXPORT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  EMAIL_PROVIDER: z.enum(["disabled", "http_webhook"]).default("disabled"),
  EMAIL_WEBHOOK_URL: optionalUrl.default(""),
  EMAIL_DELIVERY_TOKEN: optionalString.default(""),
  EMAIL_FROM: optionalEmail.default(""),
  EMAIL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(5000).default(5000),
  PROVIDER_GAP_REPAIR_ENABLED: booleanFromString.default(false),
  PROVIDER_GAP_REPAIR_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(900_000),
  PROVIDER_GAP_REPAIR_LOOKBACK_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(30 * 24 * 60 * 60 * 1000)
    .default(86_400_000),
  PROVIDER_GAP_REPAIR_OVERLAP_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(60 * 60 * 1000)
    .default(300_000),
  PROVIDER_GAP_REPAIR_MAXIMUM_PAGES: z.coerce.number().int().min(1).max(25).default(5),
  PROVIDER_GAP_REPAIR_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  PROVIDER_PRIVACY_DEADLINE_MONITOR_ENABLED: booleanFromString.default(true),
  PROVIDER_PRIVACY_DEADLINE_MONITOR_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(900_000),
  PROVIDER_PRIVACY_DEADLINE_MONITOR_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100),
  SHOPIFY_OAUTH_ENABLED: booleanFromString.default(false),
  SHOPIFY_CLIENT_ID: optionalOAuthClientId.default(""),
  SHOPIFY_CLIENT_SECRET: optionalOAuthSecret.default(""),
  SHOPIFY_OAUTH_SCOPES: z
    .string()
    .regex(/^read_[a-z0-9_]{1,94}(?:,read_[a-z0-9_]{1,94}){0,49}$/u)
    .default("read_orders"),
  SHOPIFY_API_VERSION: z
    .string()
    .regex(/^\d{4}-(?:01|04|07|10)$/u)
    .default("2026-07"),
  STRIPE_OAUTH_ENABLED: booleanFromString.default(false),
  STRIPE_OAUTH_CLIENT_ID: optionalOAuthClientId.default(""),
  STRIPE_OAUTH_SECRET_KEY: optionalOAuthSecret.default(""),
  STRIPE_APP_ID: optionalStripeAppId.default(""),
  STRIPE_APP_WEBHOOK_SECRET: optionalOAuthSecret.default(""),
  STRIPE_API_VERSION: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(?:\.[a-z]+)?$/u)
    .default("2025-06-30.basil"),
  AI_ENABLED: booleanFromString.default(false),
  AI_PROVIDER: z.string().default("disabled"),
  AI_MODEL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5000),
  AI_MAX_COST_MINOR: z.coerce.number().int().min(0).default(0),
});

export type RuntimeConfig = z.infer<typeof BaseConfigSchema>;

const ApiConfigSchema = BaseConfigSchema.pick({
  NODE_ENV: true,
  APP_ENV: true,
  WEB_ORIGIN: true,
  API_HOST: true,
  API_PORT: true,
  API_READINESS_TIMEOUT_MS: true,
  API_TRUST_PROXY_CIDRS: true,
  API_RATE_LIMIT_STORE: true,
  API_RATE_LIMIT_KEY_SECRET: true,
  API_RATE_LIMIT_REDIS_CONNECT_TIMEOUT_MS: true,
  API_RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS: true,
  RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS: true,
  RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS: true,
  DATABASE_URL: true,
  REDIS_URL: true,
  S3_ENDPOINT: true,
  S3_REGION: true,
  S3_BUCKET: true,
  S3_ACCESS_KEY_ID: true,
  S3_SECRET_ACCESS_KEY: true,
  S3_FORCE_PATH_STYLE: true,
  S3_SERVER_SIDE_ENCRYPTION: true,
  S3_KMS_KEY_ID: true,
  OIDC_ISSUER: true,
  OIDC_CLIENT_ID: true,
  SUPPORT_ACCESS_ENABLED: true,
  SUPPORT_OIDC_GROUP: true,
  SUPPORT_OIDC_AUTHENTICATION_CONTEXT: true,
  SUPPORT_IDENTITY_HMAC_KEY: true,
  CONNECTOR_ENCRYPTION_KEYS: true,
  CONNECTOR_ENCRYPTION_ACTIVE_KEY_VERSION: true,
  OTEL_EXPORTER_OTLP_ENDPOINT: true,
  OTEL_TRACE_SAMPLE_RATIO: true,
  OTEL_METRIC_EXPORT_INTERVAL_MS: true,
  OTEL_EXPORT_TIMEOUT_MS: true,
  LOG_LEVEL: true,
  EMAIL_PROVIDER: true,
  EMAIL_WEBHOOK_URL: true,
  EMAIL_DELIVERY_TOKEN: true,
  EMAIL_FROM: true,
  EMAIL_REQUEST_TIMEOUT_MS: true,
  SHOPIFY_OAUTH_ENABLED: true,
  SHOPIFY_CLIENT_ID: true,
  SHOPIFY_CLIENT_SECRET: true,
  SHOPIFY_OAUTH_SCOPES: true,
  SHOPIFY_API_VERSION: true,
  STRIPE_OAUTH_ENABLED: true,
  STRIPE_OAUTH_CLIENT_ID: true,
  STRIPE_OAUTH_SECRET_KEY: true,
  STRIPE_APP_ID: true,
  STRIPE_APP_WEBHOOK_SECRET: true,
  STRIPE_API_VERSION: true,
});

const WorkerConfigSchema = BaseConfigSchema.pick({
  NODE_ENV: true,
  APP_ENV: true,
  WEB_ORIGIN: true,
  DATABASE_WORKER_URL: true,
  REDIS_URL: true,
  DURABLE_QUEUE_MONITOR_INTERVAL_MS: true,
  DURABLE_QUEUE_MONITOR_REDIS_CONNECT_TIMEOUT_MS: true,
  DURABLE_QUEUE_MONITOR_REDIS_COMMAND_TIMEOUT_MS: true,
  PROVIDER_CIRCUIT_REDIS_CONNECT_TIMEOUT_MS: true,
  PROVIDER_CIRCUIT_REDIS_COMMAND_TIMEOUT_MS: true,
  PROVIDER_CIRCUIT_FAILURE_THRESHOLD: true,
  PROVIDER_CIRCUIT_OPEN_MS: true,
  PROVIDER_CIRCUIT_PROBE_LEASE_MS: true,
  S3_ENDPOINT: true,
  S3_REGION: true,
  S3_BUCKET: true,
  S3_ACCESS_KEY_ID: true,
  S3_SECRET_ACCESS_KEY: true,
  S3_FORCE_PATH_STYLE: true,
  S3_SERVER_SIDE_ENCRYPTION: true,
  S3_KMS_KEY_ID: true,
  CONNECTOR_ENCRYPTION_KEYS: true,
  CONNECTOR_ENCRYPTION_ACTIVE_KEY_VERSION: true,
  OTEL_EXPORTER_OTLP_ENDPOINT: true,
  OTEL_TRACE_SAMPLE_RATIO: true,
  OTEL_METRIC_EXPORT_INTERVAL_MS: true,
  OTEL_EXPORT_TIMEOUT_MS: true,
  LOG_LEVEL: true,
  PROVIDER_GAP_REPAIR_ENABLED: true,
  PROVIDER_GAP_REPAIR_INTERVAL_MS: true,
  PROVIDER_GAP_REPAIR_LOOKBACK_MS: true,
  PROVIDER_GAP_REPAIR_OVERLAP_MS: true,
  PROVIDER_GAP_REPAIR_MAXIMUM_PAGES: true,
  PROVIDER_GAP_REPAIR_BATCH_SIZE: true,
  PROVIDER_PRIVACY_DEADLINE_MONITOR_ENABLED: true,
  PROVIDER_PRIVACY_DEADLINE_MONITOR_INTERVAL_MS: true,
  PROVIDER_PRIVACY_DEADLINE_MONITOR_BATCH_SIZE: true,
  SHOPIFY_OAUTH_ENABLED: true,
  SHOPIFY_CLIENT_ID: true,
  SHOPIFY_CLIENT_SECRET: true,
  SHOPIFY_OAUTH_SCOPES: true,
  STRIPE_OAUTH_ENABLED: true,
  STRIPE_OAUTH_CLIENT_ID: true,
  STRIPE_OAUTH_SECRET_KEY: true,
});

export type ApiRuntimeConfig = z.infer<typeof ApiConfigSchema>;
export type WorkerRuntimeConfig = z.infer<typeof WorkerConfigSchema>;

const localOnlyMarkers = [
  "local-app-only",
  "local-minio-only",
  "local-minio-secret-only",
  "local-oidc-secret-only",
  "replace-with-",
  "localhost",
  "127.0.0.1",
];

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export function parseRuntimeConfig(environment: RuntimeEnvironment): RuntimeConfig {
  const config = BaseConfigSchema.parse(environment);
  validateCommonRuntimeConfiguration(config);
  validateApiRuntimeConfiguration(config);
  validateWorkerRuntimeConfiguration(config);
  validateOrigin(config.API_ORIGIN, "API_ORIGIN");

  if (config.NODE_ENV === "production") {
    if (!config.SESSION_COOKIE_SECURE) {
      throw new Error("SESSION_COOKIE_SECURE must be true in production");
    }
    if (config.SESSION_REVOCATION_STORE !== "redis") {
      throw new Error("production session revocation must use Redis");
    }
    if (!config.API_ORIGIN.startsWith("https://")) {
      throw new Error("production origins must use HTTPS");
    }
    if (config.AI_ENABLED && (!config.AI_API_KEY || config.AI_PROVIDER === "disabled")) {
      throw new Error("enabled AI requires an explicit provider and credential");
    }
  }

  return Object.freeze(config);
}

export function parseApiRuntimeConfig(environment: RuntimeEnvironment): ApiRuntimeConfig {
  const config = ApiConfigSchema.parse(environment);
  validateCommonRuntimeConfiguration(config);
  validateApiRuntimeConfiguration(config);
  return Object.freeze(config);
}

export function parseWorkerRuntimeConfig(environment: RuntimeEnvironment): WorkerRuntimeConfig {
  const config = WorkerConfigSchema.parse(environment);
  validateCommonRuntimeConfiguration(config);
  validateWorkerRuntimeConfiguration(config);
  return Object.freeze(config);
}

type CommonRuntimeConfig = Pick<
  RuntimeConfig,
  | "NODE_ENV"
  | "APP_ENV"
  | "WEB_ORIGIN"
  | "S3_ENDPOINT"
  | "S3_SERVER_SIDE_ENCRYPTION"
  | "S3_KMS_KEY_ID"
  | "CONNECTOR_ENCRYPTION_KEYS"
  | "CONNECTOR_ENCRYPTION_ACTIVE_KEY_VERSION"
  | "OTEL_EXPORTER_OTLP_ENDPOINT"
  | "OTEL_METRIC_EXPORT_INTERVAL_MS"
  | "OTEL_EXPORT_TIMEOUT_MS"
>;

function validateCommonRuntimeConfiguration(config: CommonRuntimeConfig): void {
  validateOrigin(config.WEB_ORIGIN, "WEB_ORIGIN");
  validateStorageEndpoint(config.S3_ENDPOINT);
  if (config.S3_SERVER_SIDE_ENCRYPTION === "aws:kms" && !config.S3_KMS_KEY_ID) {
    throw new Error("S3_KMS_KEY_ID is required when S3 server-side encryption uses aws:kms");
  }
  if (config.S3_KMS_KEY_ID && config.S3_SERVER_SIDE_ENCRYPTION !== "aws:kms") {
    throw new Error("S3_KMS_KEY_ID is only valid with aws:kms server-side encryption");
  }
  const connectorKeyVersions = config.CONNECTOR_ENCRYPTION_KEYS.split(",").map(
    (entry) => entry.split("=", 1)[0],
  );
  if (new Set(connectorKeyVersions).size !== connectorKeyVersions.length) {
    throw new Error("CONNECTOR_ENCRYPTION_KEYS contains duplicate key versions");
  }
  if (!connectorKeyVersions.includes(config.CONNECTOR_ENCRYPTION_ACTIVE_KEY_VERSION)) {
    throw new Error("CONNECTOR_ENCRYPTION_ACTIVE_KEY_VERSION must identify a configured key");
  }
  if (config.OTEL_EXPORTER_OTLP_ENDPOINT) {
    validateOtlpEndpoint(config.OTEL_EXPORTER_OTLP_ENDPOINT);
  }
  if (config.OTEL_METRIC_EXPORT_INTERVAL_MS < config.OTEL_EXPORT_TIMEOUT_MS) {
    throw new Error("OTEL_METRIC_EXPORT_INTERVAL_MS must be at least OTEL_EXPORT_TIMEOUT_MS");
  }
  if (config.NODE_ENV === "production") {
    const serialized = JSON.stringify(config);
    const marker = localOnlyMarkers.find((value) => serialized.includes(value));
    if (marker) throw new Error(`production configuration contains a local-only marker: ${marker}`);
    if (!config.WEB_ORIGIN.startsWith("https://")) {
      throw new Error("production origins must use HTTPS");
    }
    if (!config.S3_ENDPOINT.startsWith("https://")) {
      throw new Error("production object storage endpoints must use HTTPS");
    }
    if (!config.S3_SERVER_SIDE_ENCRYPTION) {
      throw new Error("production object storage must declare server-side encryption");
    }
    if (!config.OTEL_EXPORTER_OTLP_ENDPOINT) {
      throw new Error("production observability requires OTEL_EXPORTER_OTLP_ENDPOINT");
    }
    if (!config.OTEL_EXPORTER_OTLP_ENDPOINT.startsWith("https://")) {
      throw new Error("production OTLP endpoints must use HTTPS");
    }
  }
}

function validateApiRuntimeConfiguration(config: ApiRuntimeConfig): void {
  if (config.EMAIL_PROVIDER === "http_webhook") {
    if (!config.EMAIL_WEBHOOK_URL || !config.EMAIL_DELIVERY_TOKEN || !config.EMAIL_FROM) {
      throw new Error(
        "http_webhook email delivery requires EMAIL_WEBHOOK_URL, EMAIL_DELIVERY_TOKEN, and EMAIL_FROM",
      );
    }
    if (config.EMAIL_DELIVERY_TOKEN.length < 16) {
      throw new Error("EMAIL_DELIVERY_TOKEN must contain at least 16 characters");
    }
    validateEmailEndpoint(config.EMAIL_WEBHOOK_URL);
  } else if (config.EMAIL_WEBHOOK_URL || config.EMAIL_DELIVERY_TOKEN || config.EMAIL_FROM) {
    throw new Error("email relay settings are only valid when EMAIL_PROVIDER=http_webhook");
  }
  if (config.API_RATE_LIMIT_STORE === "redis" && !config.API_RATE_LIMIT_KEY_SECRET) {
    throw new Error("Redis API rate limiting requires API_RATE_LIMIT_KEY_SECRET");
  }
  if (config.API_RATE_LIMIT_STORE === "local" && config.API_RATE_LIMIT_KEY_SECRET) {
    throw new Error("API_RATE_LIMIT_KEY_SECRET is only valid when API_RATE_LIMIT_STORE=redis");
  }
  validateSupportAccessConfiguration(config);
  validateApiProviderAuthorizationConfiguration(config);
  if (config.NODE_ENV === "production") {
    if (config.API_TRUST_PROXY_CIDRS.length === 0) {
      throw new Error("production API requires at least one trusted reverse-proxy CIDR");
    }
    if (config.API_RATE_LIMIT_STORE !== "redis") {
      throw new Error("production API rate limiting must use Redis");
    }
    if (!config.OIDC_ISSUER.startsWith("https://")) {
      throw new Error("production OIDC issuer must use HTTPS");
    }
    if (
      config.EMAIL_PROVIDER === "http_webhook" &&
      !config.EMAIL_WEBHOOK_URL.startsWith("https://")
    ) {
      throw new Error("production email relay endpoints must use HTTPS");
    }
  }
}

function validateWorkerRuntimeConfiguration(config: WorkerRuntimeConfig): void {
  if (config.PROVIDER_GAP_REPAIR_OVERLAP_MS >= config.PROVIDER_GAP_REPAIR_LOOKBACK_MS) {
    throw new Error("provider gap repair overlap must be smaller than its lookback");
  }
  if (
    config.DURABLE_QUEUE_MONITOR_INTERVAL_MS < config.DURABLE_QUEUE_MONITOR_REDIS_COMMAND_TIMEOUT_MS
  ) {
    throw new Error(
      "DURABLE_QUEUE_MONITOR_INTERVAL_MS must be at least DURABLE_QUEUE_MONITOR_REDIS_COMMAND_TIMEOUT_MS",
    );
  }
  if (config.PROVIDER_CIRCUIT_PROBE_LEASE_MS > config.PROVIDER_CIRCUIT_OPEN_MS) {
    throw new Error("PROVIDER_CIRCUIT_PROBE_LEASE_MS must not exceed PROVIDER_CIRCUIT_OPEN_MS");
  }
  if (config.PROVIDER_CIRCUIT_PROBE_LEASE_MS < config.PROVIDER_CIRCUIT_REDIS_COMMAND_TIMEOUT_MS) {
    throw new Error(
      "PROVIDER_CIRCUIT_PROBE_LEASE_MS must be at least PROVIDER_CIRCUIT_REDIS_COMMAND_TIMEOUT_MS",
    );
  }
  validateWorkerProviderAuthorizationConfiguration(config);
}

function parseTrustedProxyCidrs(value: string): readonly string[] {
  if (value.length === 0) return Object.freeze([]);
  const entries = value.split(",");
  if (entries.length > 16) throw new Error("API_TRUST_PROXY_CIDRS accepts at most 16 entries");
  const parsed = entries.map((entry) => {
    if (entry.trim() !== entry || entry.length === 0) {
      throw new Error("API_TRUST_PROXY_CIDRS entries must not contain whitespace");
    }
    const parts = entry.split("/");
    if (parts.length > 2) throw new Error("API_TRUST_PROXY_CIDRS contains an invalid CIDR");
    const address = parts[0];
    if (!address) throw new Error("API_TRUST_PROXY_CIDRS contains an invalid address");
    const version = isIP(address);
    if (version === 0) throw new Error("API_TRUST_PROXY_CIDRS contains an invalid address");
    const prefix = parts[1];
    if (prefix !== undefined) {
      if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(prefix)) {
        throw new Error("API_TRUST_PROXY_CIDRS contains an invalid prefix");
      }
      const bits = Number(prefix);
      if (bits > (version === 4 ? 32 : 128)) {
        throw new Error("API_TRUST_PROXY_CIDRS contains an invalid prefix");
      }
      if (bits === 0) {
        throw new Error("API_TRUST_PROXY_CIDRS cannot trust the entire address space");
      }
    }
    return entry;
  });
  if (new Set(parsed).size !== parsed.length) {
    throw new Error("API_TRUST_PROXY_CIDRS contains duplicate entries");
  }
  return Object.freeze(parsed);
}

function isCanonicalRateLimitKey(value: string): boolean {
  return isCanonicalPseudonymizationKey(value);
}

function isCanonicalPseudonymizationKey(value: string): boolean {
  const decoded = Buffer.from(value, "base64url");
  return (
    decoded.byteLength >= 32 && decoded.byteLength <= 64 && decoded.toString("base64url") === value
  );
}

function validateSupportAccessConfiguration(
  config: Pick<
    ApiRuntimeConfig,
    | "SUPPORT_ACCESS_ENABLED"
    | "SUPPORT_OIDC_GROUP"
    | "SUPPORT_OIDC_AUTHENTICATION_CONTEXT"
    | "SUPPORT_IDENTITY_HMAC_KEY"
  >,
): void {
  const configured = Boolean(
    config.SUPPORT_OIDC_GROUP ||
    config.SUPPORT_OIDC_AUTHENTICATION_CONTEXT ||
    config.SUPPORT_IDENTITY_HMAC_KEY,
  );
  if (
    config.SUPPORT_ACCESS_ENABLED &&
    (!config.SUPPORT_OIDC_GROUP ||
      !config.SUPPORT_OIDC_AUTHENTICATION_CONTEXT ||
      !config.SUPPORT_IDENTITY_HMAC_KEY)
  ) {
    throw new Error(
      "support access requires SUPPORT_OIDC_GROUP, SUPPORT_OIDC_AUTHENTICATION_CONTEXT, and SUPPORT_IDENTITY_HMAC_KEY",
    );
  }
  if (!config.SUPPORT_ACCESS_ENABLED && configured) {
    throw new Error("support access settings are only valid when SUPPORT_ACCESS_ENABLED=true");
  }
}

function validateApiProviderAuthorizationConfiguration(
  config: Pick<
    ApiRuntimeConfig,
    | "SHOPIFY_OAUTH_ENABLED"
    | "SHOPIFY_CLIENT_ID"
    | "SHOPIFY_CLIENT_SECRET"
    | "SHOPIFY_OAUTH_SCOPES"
    | "STRIPE_OAUTH_ENABLED"
    | "STRIPE_OAUTH_CLIENT_ID"
    | "STRIPE_OAUTH_SECRET_KEY"
    | "STRIPE_APP_ID"
    | "STRIPE_APP_WEBHOOK_SECRET"
  >,
): void {
  if (config.SHOPIFY_OAUTH_ENABLED) {
    if (!config.SHOPIFY_CLIENT_ID || !config.SHOPIFY_CLIENT_SECRET) {
      throw new Error("Shopify OAuth requires SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET");
    }
  } else if (config.SHOPIFY_CLIENT_ID || config.SHOPIFY_CLIENT_SECRET) {
    throw new Error("Shopify OAuth credentials are only valid when SHOPIFY_OAUTH_ENABLED=true");
  }
  const shopifyScopes = config.SHOPIFY_OAUTH_SCOPES.split(",");
  if (new Set(shopifyScopes).size !== shopifyScopes.length) {
    throw new Error("SHOPIFY_OAUTH_SCOPES contains duplicate scopes");
  }

  if (config.STRIPE_OAUTH_ENABLED) {
    if (
      !config.STRIPE_OAUTH_CLIENT_ID ||
      !config.STRIPE_OAUTH_SECRET_KEY ||
      !config.STRIPE_APP_ID ||
      !config.STRIPE_APP_WEBHOOK_SECRET
    ) {
      throw new Error(
        "Stripe OAuth requires STRIPE_OAUTH_CLIENT_ID, STRIPE_OAUTH_SECRET_KEY, STRIPE_APP_ID, and STRIPE_APP_WEBHOOK_SECRET",
      );
    }
  } else if (
    config.STRIPE_OAUTH_CLIENT_ID ||
    config.STRIPE_OAUTH_SECRET_KEY ||
    config.STRIPE_APP_ID ||
    config.STRIPE_APP_WEBHOOK_SECRET
  ) {
    throw new Error("Stripe OAuth credentials are only valid when STRIPE_OAUTH_ENABLED=true");
  }
}

function validateWorkerProviderAuthorizationConfiguration(
  config: Pick<
    WorkerRuntimeConfig,
    | "SHOPIFY_OAUTH_ENABLED"
    | "SHOPIFY_CLIENT_ID"
    | "SHOPIFY_CLIENT_SECRET"
    | "SHOPIFY_OAUTH_SCOPES"
    | "STRIPE_OAUTH_ENABLED"
    | "STRIPE_OAUTH_CLIENT_ID"
    | "STRIPE_OAUTH_SECRET_KEY"
  >,
): void {
  if (config.SHOPIFY_OAUTH_ENABLED) {
    if (!config.SHOPIFY_CLIENT_ID || !config.SHOPIFY_CLIENT_SECRET) {
      throw new Error("Shopify OAuth requires SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET");
    }
  } else if (config.SHOPIFY_CLIENT_ID || config.SHOPIFY_CLIENT_SECRET) {
    throw new Error("Shopify OAuth credentials are only valid when SHOPIFY_OAUTH_ENABLED=true");
  }
  const shopifyScopes = config.SHOPIFY_OAUTH_SCOPES.split(",");
  if (new Set(shopifyScopes).size !== shopifyScopes.length) {
    throw new Error("SHOPIFY_OAUTH_SCOPES contains duplicate scopes");
  }

  if (config.STRIPE_OAUTH_ENABLED) {
    if (!config.STRIPE_OAUTH_CLIENT_ID || !config.STRIPE_OAUTH_SECRET_KEY) {
      throw new Error(
        "Stripe OAuth requires STRIPE_OAUTH_CLIENT_ID and STRIPE_OAUTH_SECRET_KEY in the worker",
      );
    }
  } else if (config.STRIPE_OAUTH_CLIENT_ID || config.STRIPE_OAUTH_SECRET_KEY) {
    throw new Error("Stripe OAuth credentials are only valid when STRIPE_OAUTH_ENABLED=true");
  }
}

function validateEmailEndpoint(value: string): void {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("EMAIL_WEBHOOK_URL cannot contain credentials, a query, or a fragment");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("EMAIL_WEBHOOK_URL must use HTTP or HTTPS");
  }
}

function validateOtlpEndpoint(value: string): void {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(
      "OTEL_EXPORTER_OTLP_ENDPOINT must be an origin without credentials, path, query, or fragment",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT must use HTTP or HTTPS");
  }
}

function validateStorageEndpoint(value: string): void {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("S3_ENDPOINT must be an origin without credentials, path, query, or fragment");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("S3_ENDPOINT must use HTTP or HTTPS");
  }
}

function validateOrigin(value: string, name: string): void {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(`${name} must be an origin without credentials, path, query, or fragment`);
  }
}
