import { describe, expect, it } from "vitest";

import { parseApiRuntimeConfig, parseRuntimeConfig, parseWorkerRuntimeConfig } from "./index.js";

const base = {
  NODE_ENV: "test",
  APP_ENV: "test",
  WEB_ORIGIN: "https://web.example.test",
  API_ORIGIN: "https://api.example.test",
  API_HOST: "0.0.0.0",
  DATABASE_URL: "postgresql://user:password@db.example.test:5432/reconai",
  DATABASE_WORKER_URL: "postgresql://worker:password@db.example.test:5432/reconai",
  REDIS_URL: "redis://cache.example.test:6379",
  S3_ENDPOINT: "https://objects.example.test",
  S3_REGION: "test-region-1",
  S3_BUCKET: "reconai-test-bucket",
  S3_ACCESS_KEY_ID: "synthetic-access-identifier",
  S3_SECRET_ACCESS_KEY: "synthetic-object-credential",
  S3_FORCE_PATH_STYLE: "true",
  S3_SERVER_SIDE_ENCRYPTION: "AES256",
  S3_KMS_KEY_ID: "",
  OIDC_ISSUER: "https://identity.example.test/realms/reconai",
  OIDC_CLIENT_ID: "reconai-test-client",
  OIDC_CLIENT_SECRET: "synthetic-oidc-credential",
  OIDC_ID_TOKEN_SIGNING_ALGORITHM: "RS256",
  SESSION_SECRET: "synthetic-session-material-over-32-characters",
  SESSION_COOKIE_SECURE: "true",
  SESSION_REVOCATION_STORE: "local",
  CONNECTOR_ENCRYPTION_KEYS: "v1=env:RECONAI_CONNECTOR_ENCRYPTION_KEY_V1",
  CONNECTOR_ENCRYPTION_ACTIVE_KEY_VERSION: "v1",
  OTEL_EXPORTER_OTLP_ENDPOINT: "",
  OTEL_TRACE_SAMPLE_RATIO: "1",
  OTEL_METRIC_EXPORT_INTERVAL_MS: "60000",
  OTEL_EXPORT_TIMEOUT_MS: "5000",
  EMAIL_PROVIDER: "disabled",
  EMAIL_WEBHOOK_URL: "",
  EMAIL_DELIVERY_TOKEN: "",
  EMAIL_FROM: "",
  EMAIL_REQUEST_TIMEOUT_MS: "5000",
  AI_ENABLED: "false",
} as const;
const productionBase = {
  ...base,
  NODE_ENV: "production",
  APP_ENV: "production",
  API_TRUST_PROXY_CIDRS: "10.0.0.0/8,fd00::/8",
  API_RATE_LIMIT_STORE: "redis",
  API_RATE_LIMIT_KEY_SECRET: "c3ludGhldGljLXJhdGUtbGltaXQta2V5LW1hdGVyaWFsLTAwMDE",
  SESSION_REVOCATION_STORE: "redis",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://telemetry.example.test",
} as const;

describe("service-specific runtime configuration boundaries", () => {
  it("parses API configuration without worker, web-session, or administrative authority", () => {
    const environment = omitKeys(base, [
      "API_ORIGIN",
      "DATABASE_WORKER_URL",
      "OIDC_CLIENT_SECRET",
      "SESSION_SECRET",
      "SESSION_COOKIE_SECURE",
    ]);
    const config = parseApiRuntimeConfig({
      ...environment,
      DATABASE_ADMIN_URL: "synthetic-unused-admin-authority",
      DATABASE_MAINTENANCE_URL: "synthetic-unused-maintenance-authority",
      DATABASE_MIGRATION_URL: "synthetic-unused-migration-authority",
      AI_API_KEY: "synthetic-unused-ai-authority",
    });

    expect(config).toMatchObject({
      DATABASE_URL: base.DATABASE_URL,
      OIDC_ISSUER: base.OIDC_ISSUER,
      OIDC_CLIENT_ID: base.OIDC_CLIENT_ID,
    });
    expect(config).not.toHaveProperty("DATABASE_WORKER_URL");
    expect(config).not.toHaveProperty("DATABASE_ADMIN_URL");
    expect(config).not.toHaveProperty("DATABASE_MAINTENANCE_URL");
    expect(config).not.toHaveProperty("DATABASE_MIGRATION_URL");
    expect(config).not.toHaveProperty("OIDC_CLIENT_SECRET");
    expect(config).not.toHaveProperty("SESSION_SECRET");
    expect(config).not.toHaveProperty("AI_API_KEY");
  });

  it("parses worker configuration without API, web-session, email, support, or administrative authority", () => {
    const environment = omitKeys(base, [
      "API_ORIGIN",
      "DATABASE_URL",
      "OIDC_ISSUER",
      "OIDC_CLIENT_ID",
      "OIDC_CLIENT_SECRET",
      "SESSION_SECRET",
      "SESSION_COOKIE_SECURE",
    ]);
    const config = parseWorkerRuntimeConfig({
      ...environment,
      DATABASE_ADMIN_URL: "synthetic-unused-admin-authority",
      DATABASE_MAINTENANCE_URL: "synthetic-unused-maintenance-authority",
      DATABASE_MIGRATION_URL: "synthetic-unused-migration-authority",
      EMAIL_DELIVERY_TOKEN: "synthetic-unused-email-authority",
      SUPPORT_IDENTITY_HMAC_KEY: productionBase.API_RATE_LIMIT_KEY_SECRET,
      AI_API_KEY: "synthetic-unused-ai-authority",
    });

    expect(config).toMatchObject({ DATABASE_WORKER_URL: base.DATABASE_WORKER_URL });
    for (const key of [
      "DATABASE_URL",
      "DATABASE_ADMIN_URL",
      "DATABASE_MAINTENANCE_URL",
      "DATABASE_MIGRATION_URL",
      "API_HOST",
      "OIDC_ISSUER",
      "OIDC_CLIENT_SECRET",
      "SESSION_SECRET",
      "EMAIL_DELIVERY_TOKEN",
      "SUPPORT_IDENTITY_HMAC_KEY",
      "AI_API_KEY",
    ]) {
      expect(config).not.toHaveProperty(key);
    }
  });

  it("requires only the database role owned by each service", () => {
    expect(() => parseApiRuntimeConfig(omitKeys(base, ["DATABASE_URL"]))).toThrow();
    expect(() => parseWorkerRuntimeConfig(omitKeys(base, ["DATABASE_WORKER_URL"]))).toThrow();
  });

  it("preserves production controls within each service boundary", () => {
    expect(parseApiRuntimeConfig(productionBase)).toMatchObject({
      NODE_ENV: "production",
      API_RATE_LIMIT_STORE: "redis",
    });
    expect(parseWorkerRuntimeConfig(productionBase)).toMatchObject({
      NODE_ENV: "production",
      DATABASE_WORKER_URL: base.DATABASE_WORKER_URL,
    });
    expect(() =>
      parseApiRuntimeConfig({
        ...productionBase,
        OIDC_ISSUER: "http://identity.example.test/realms/reconai",
      }),
    ).toThrow("production OIDC issuer must use HTTPS");
    expect(() =>
      parseWorkerRuntimeConfig({
        ...productionBase,
        OTEL_EXPORTER_OTLP_ENDPOINT: "",
      }),
    ).toThrow("requires OTEL_EXPORTER_OTLP_ENDPOINT");
  });
});

describe("runtime observability configuration", () => {
  it("keeps telemetry disabled outside production when no endpoint is configured", () => {
    expect(parseRuntimeConfig(base)).toMatchObject({
      OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
      OTEL_TRACE_SAMPLE_RATIO: 1,
      OTEL_METRIC_EXPORT_INTERVAL_MS: 60_000,
      OTEL_EXPORT_TIMEOUT_MS: 5_000,
      DURABLE_QUEUE_MONITOR_INTERVAL_MS: 15_000,
      DURABLE_QUEUE_MONITOR_REDIS_CONNECT_TIMEOUT_MS: 1_000,
      DURABLE_QUEUE_MONITOR_REDIS_COMMAND_TIMEOUT_MS: 1_000,
    });
  });

  it("requires a fixed HTTPS collector origin in production", () => {
    expect(() =>
      parseRuntimeConfig({
        ...productionBase,
        OTEL_EXPORTER_OTLP_ENDPOINT: "",
      }),
    ).toThrow("requires OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(() =>
      parseRuntimeConfig({
        ...productionBase,
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://telemetry.example.test",
      }),
    ).toThrow("must use HTTPS");
    for (const endpoint of [
      "https://user:password@telemetry.example.test",
      "https://telemetry.example.test/custom",
      "https://telemetry.example.test?token=unsafe",
      "https://telemetry.example.test#fragment",
    ]) {
      expect(() =>
        parseRuntimeConfig({
          ...productionBase,
          OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        }),
      ).toThrow("must be an origin");
    }
  });

  it("bounds sampling and requires export timeout within the metric interval", () => {
    expect(() =>
      parseRuntimeConfig({
        ...base,
        OTEL_TRACE_SAMPLE_RATIO: "1.01",
      }),
    ).toThrow();
    expect(() =>
      parseRuntimeConfig({
        ...base,
        OTEL_METRIC_EXPORT_INTERVAL_MS: "1000",
        OTEL_EXPORT_TIMEOUT_MS: "1001",
      }),
    ).toThrow("must be at least");
  });

  it("bounds queue telemetry Redis work within its polling interval", () => {
    expect(() =>
      parseRuntimeConfig({
        ...base,
        DURABLE_QUEUE_MONITOR_INTERVAL_MS: "999",
      }),
    ).toThrow();
    expect(() =>
      parseRuntimeConfig({
        ...base,
        DURABLE_QUEUE_MONITOR_REDIS_CONNECT_TIMEOUT_MS: "5001",
      }),
    ).toThrow();
    expect(() =>
      parseRuntimeConfig({
        ...base,
        DURABLE_QUEUE_MONITOR_REDIS_COMMAND_TIMEOUT_MS: "5001",
      }),
    ).toThrow();
    expect(() =>
      parseRuntimeConfig({
        ...base,
        DURABLE_QUEUE_MONITOR_INTERVAL_MS: "1000",
        DURABLE_QUEUE_MONITOR_REDIS_COMMAND_TIMEOUT_MS: "1001",
      }),
    ).toThrow("must be at least");
  });
});

function omitKeys(
  environment: Readonly<Record<string, string>>,
  keys: readonly string[],
): Record<string, string> {
  const excluded = new Set(keys);
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !excluded.has(key)));
}

describe("runtime object storage security", () => {
  it("accepts an encrypted fixed production storage origin", () => {
    expect(parseRuntimeConfig(productionBase)).toMatchObject({
      S3_ENDPOINT: "https://objects.example.test",
      S3_SERVER_SIDE_ENCRYPTION: "AES256",
    });
  });

  it("rejects production plaintext storage and endpoints with paths", () => {
    expect(() =>
      parseRuntimeConfig({
        ...productionBase,
        S3_ENDPOINT: "http://objects.example.test",
      }),
    ).toThrow("HTTPS");
    expect(() =>
      parseRuntimeConfig({ ...base, S3_ENDPOINT: "https://objects.example.test/user-path" }),
    ).toThrow("must be an origin");
  });

  it("requires and scopes a KMS key identifier", () => {
    expect(() =>
      parseRuntimeConfig({
        ...base,
        S3_SERVER_SIDE_ENCRYPTION: "aws:kms",
        S3_KMS_KEY_ID: "",
      }),
    ).toThrow("S3_KMS_KEY_ID is required");
    expect(() =>
      parseRuntimeConfig({
        ...base,
        S3_SERVER_SIDE_ENCRYPTION: "AES256",
        S3_KMS_KEY_ID: "synthetic-kms-key",
      }),
    ).toThrow("only valid");
  });
});

describe("runtime invitation email configuration", () => {
  it("keeps delivery explicitly disabled without relay credentials by default", () => {
    expect(parseRuntimeConfig(base)).toMatchObject({
      EMAIL_PROVIDER: "disabled",
      EMAIL_WEBHOOK_URL: "",
      EMAIL_DELIVERY_TOKEN: "",
      EMAIL_FROM: "",
    });
  });

  it("requires a complete authenticated relay configuration", () => {
    expect(() =>
      parseRuntimeConfig({
        ...base,
        EMAIL_PROVIDER: "http_webhook",
        EMAIL_WEBHOOK_URL: "https://email.example.test/v1/messages",
      }),
    ).toThrow("requires EMAIL_WEBHOOK_URL");
    expect(() =>
      parseRuntimeConfig({
        ...base,
        EMAIL_PROVIDER: "disabled",
        EMAIL_DELIVERY_TOKEN: "configured-but-unused-token",
      }),
    ).toThrow("only valid");
  });

  it("requires HTTPS for a production email relay", () => {
    const emailConfig = {
      ...base,
      EMAIL_PROVIDER: "http_webhook",
      EMAIL_WEBHOOK_URL: "http://email.example.test/v1/messages",
      EMAIL_DELIVERY_TOKEN: "synthetic-email-relay-token",
      EMAIL_FROM: "access@example.test",
    } as const;
    expect(() =>
      parseRuntimeConfig({
        ...productionBase,
        EMAIL_PROVIDER: emailConfig.EMAIL_PROVIDER,
        EMAIL_WEBHOOK_URL: emailConfig.EMAIL_WEBHOOK_URL,
        EMAIL_DELIVERY_TOKEN: emailConfig.EMAIL_DELIVERY_TOKEN,
        EMAIL_FROM: emailConfig.EMAIL_FROM,
      }),
    ).toThrow("must use HTTPS");
    expect(
      parseRuntimeConfig({
        ...productionBase,
        EMAIL_PROVIDER: emailConfig.EMAIL_PROVIDER,
        EMAIL_DELIVERY_TOKEN: emailConfig.EMAIL_DELIVERY_TOKEN,
        EMAIL_FROM: emailConfig.EMAIL_FROM,
        EMAIL_WEBHOOK_URL: "https://email.example.test/v1/messages",
      }),
    ).toMatchObject({
      EMAIL_PROVIDER: "http_webhook",
      EMAIL_FROM: "access@example.test",
    });
  });
});

describe("runtime API perimeter configuration", () => {
  it("defaults non-production to a bounded local limiter without trusted proxies", () => {
    expect(parseRuntimeConfig(base)).toMatchObject({
      API_READINESS_TIMEOUT_MS: 1000,
      RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS: 2,
      RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS: 30_000,
      API_TRUST_PROXY_CIDRS: [],
      API_RATE_LIMIT_STORE: "local",
      API_RATE_LIMIT_REDIS_CONNECT_TIMEOUT_MS: 1000,
      API_RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS: 1000,
    });
  });

  it("requires a dedicated pseudonymization key only for Redis enforcement", () => {
    expect(() =>
      parseRuntimeConfig({
        ...base,
        API_RATE_LIMIT_STORE: "redis",
      }),
    ).toThrow("requires API_RATE_LIMIT_KEY_SECRET");
    expect(() =>
      parseRuntimeConfig({
        ...base,
        API_RATE_LIMIT_KEY_SECRET: productionBase.API_RATE_LIMIT_KEY_SECRET,
      }),
    ).toThrow("only valid");
    expect(() =>
      parseRuntimeConfig({
        ...base,
        API_RATE_LIMIT_STORE: "redis",
        API_RATE_LIMIT_KEY_SECRET: "synthetic_rate_limit_key_material_0123456789ABCDE",
      }),
    ).toThrow("canonical base64url");
    expect(
      parseRuntimeConfig({
        ...base,
        API_RATE_LIMIT_STORE: "redis",
        API_RATE_LIMIT_KEY_SECRET: productionBase.API_RATE_LIMIT_KEY_SECRET,
      }),
    ).toMatchObject({ API_RATE_LIMIT_STORE: "redis" });
  });

  it("requires distributed limiting and explicit proxy trust in production", () => {
    expect(parseRuntimeConfig(productionBase)).toMatchObject({
      API_TRUST_PROXY_CIDRS: ["10.0.0.0/8", "fd00::/8"],
      API_RATE_LIMIT_STORE: "redis",
    });
    expect(() =>
      parseRuntimeConfig({
        ...productionBase,
        API_TRUST_PROXY_CIDRS: "",
      }),
    ).toThrow("trusted reverse-proxy CIDR");
    expect(() =>
      parseRuntimeConfig({
        ...productionBase,
        API_RATE_LIMIT_STORE: "local",
        API_RATE_LIMIT_KEY_SECRET: "",
      }),
    ).toThrow("must use Redis");
  });

  it("rejects ambiguous, duplicate, and globally trusted proxy ranges", () => {
    for (const value of ["10.0.0.0/8, 192.168.0.0/16", "10.0.0.0/8,10.0.0.0/8", "0.0.0.0/0"]) {
      expect(() =>
        parseRuntimeConfig({
          ...base,
          API_TRUST_PROXY_CIDRS: value,
        }),
      ).toThrow();
    }
  });

  it("bounds dedicated Redis connection and command timeouts", () => {
    expect(() =>
      parseRuntimeConfig({
        ...base,
        API_RATE_LIMIT_REDIS_CONNECT_TIMEOUT_MS: "99",
      }),
    ).toThrow();
    expect(() =>
      parseRuntimeConfig({
        ...base,
        API_RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS: "5001",
      }),
    ).toThrow();
    for (const value of ["99", "5001"]) {
      expect(() =>
        parseRuntimeConfig({
          ...base,
          API_READINESS_TIMEOUT_MS: value,
        }),
      ).toThrow();
    }
  });

  it("bounds the reconciliation run authority transaction deadline", () => {
    expect(
      parseRuntimeConfig({
        ...base,
        RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS: "5000",
      }),
    ).toMatchObject({ RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS: 5_000 });
    expect(
      parseRuntimeConfig({
        ...base,
        RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS: "120000",
      }),
    ).toMatchObject({ RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS: 120_000 });
    for (const value of ["4999", "120001", "30000.5"]) {
      expect(() =>
        parseRuntimeConfig({
          ...base,
          RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS: value,
        }),
      ).toThrow();
    }
  });

  it("bounds heavyweight run-authority transactions admitted by one API process", () => {
    expect(
      parseRuntimeConfig({
        ...base,
        RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS: "1",
      }),
    ).toMatchObject({ RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS: 1 });
    expect(
      parseRuntimeConfig({
        ...base,
        RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS: "10",
      }),
    ).toMatchObject({ RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS: 10 });
    for (const value of ["0", "11", "2.5"]) {
      expect(() =>
        parseRuntimeConfig({
          ...base,
          RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS: value,
        }),
      ).toThrow();
    }
  });
});

describe("runtime support access configuration", () => {
  const supportConfiguration = {
    SUPPORT_ACCESS_ENABLED: "true",
    SUPPORT_OIDC_GROUP: "/reconai/support",
    SUPPORT_OIDC_AUTHENTICATION_CONTEXT: "urn:reconai:loa:mfa",
    SUPPORT_IDENTITY_HMAC_KEY: "c3ludGhldGljLXN1cHBvcnQtaWRlbnRpdHkta2V5LTAwMDE",
  } as const;

  it("keeps support access disabled with no dormant identity authority", () => {
    expect(parseRuntimeConfig(base)).toMatchObject({
      SUPPORT_ACCESS_ENABLED: false,
      SUPPORT_OIDC_GROUP: "",
      SUPPORT_OIDC_AUTHENTICATION_CONTEXT: "",
      SUPPORT_IDENTITY_HMAC_KEY: "",
    });
    expect(() =>
      parseRuntimeConfig({
        ...base,
        SUPPORT_OIDC_GROUP: supportConfiguration.SUPPORT_OIDC_GROUP,
      }),
    ).toThrow("only valid");
  });

  it("requires an exact OIDC group, MFA context, and dedicated keyed identity index", () => {
    expect(parseRuntimeConfig({ ...base, ...supportConfiguration })).toMatchObject({
      SUPPORT_ACCESS_ENABLED: true,
      SUPPORT_OIDC_GROUP: "/reconai/support",
      SUPPORT_OIDC_AUTHENTICATION_CONTEXT: "urn:reconai:loa:mfa",
    });
    for (const missing of [
      "SUPPORT_OIDC_GROUP",
      "SUPPORT_OIDC_AUTHENTICATION_CONTEXT",
      "SUPPORT_IDENTITY_HMAC_KEY",
    ] as const) {
      expect(() =>
        parseRuntimeConfig({
          ...base,
          ...supportConfiguration,
          [missing]: "",
        }),
      ).toThrow("support access requires");
    }
    expect(() =>
      parseRuntimeConfig({
        ...base,
        ...supportConfiguration,
        SUPPORT_IDENTITY_HMAC_KEY: "too-short",
      }),
    ).toThrow();
  });
});

describe("runtime session revocation configuration", () => {
  it("requires the distributed revocation index in production", () => {
    expect(() =>
      parseRuntimeConfig({
        ...productionBase,
        SESSION_REVOCATION_STORE: "local",
      }),
    ).toThrow("production session revocation must use Redis");
  });

  it("bounds Redis connection and command deadlines", () => {
    expect(
      parseRuntimeConfig({
        ...base,
        SESSION_REVOCATION_STORE: "redis",
        SESSION_REVOCATION_REDIS_CONNECT_TIMEOUT_MS: "750",
        SESSION_REVOCATION_REDIS_COMMAND_TIMEOUT_MS: "500",
      }),
    ).toMatchObject({
      SESSION_REVOCATION_STORE: "redis",
      SESSION_REVOCATION_REDIS_CONNECT_TIMEOUT_MS: 750,
      SESSION_REVOCATION_REDIS_COMMAND_TIMEOUT_MS: 500,
    });
    expect(() =>
      parseRuntimeConfig({
        ...base,
        SESSION_REVOCATION_REDIS_COMMAND_TIMEOUT_MS: "5001",
      }),
    ).toThrow();
  });
});

describe("runtime provider gap repair configuration", () => {
  it("is disabled by default with bounded recovery limits", () => {
    expect(parseRuntimeConfig(base)).toMatchObject({
      PROVIDER_GAP_REPAIR_ENABLED: false,
      PROVIDER_GAP_REPAIR_INTERVAL_MS: 900_000,
      PROVIDER_GAP_REPAIR_LOOKBACK_MS: 86_400_000,
      PROVIDER_GAP_REPAIR_OVERLAP_MS: 300_000,
      PROVIDER_GAP_REPAIR_MAXIMUM_PAGES: 5,
      PROVIDER_GAP_REPAIR_BATCH_SIZE: 25,
    });
  });

  it("rejects unbounded pages, cadence, and overlap", () => {
    expect(() =>
      parseRuntimeConfig({ ...base, PROVIDER_GAP_REPAIR_MAXIMUM_PAGES: "26" }),
    ).toThrow();
    expect(() =>
      parseRuntimeConfig({ ...base, PROVIDER_GAP_REPAIR_INTERVAL_MS: "59999" }),
    ).toThrow();
    expect(() =>
      parseRuntimeConfig({
        ...base,
        PROVIDER_GAP_REPAIR_LOOKBACK_MS: "300000",
        PROVIDER_GAP_REPAIR_OVERLAP_MS: "300000",
      }),
    ).toThrow("overlap must be smaller");
  });
});

describe("runtime provider circuit configuration", () => {
  it("enables a bounded distributed circuit without a bypass mode", () => {
    expect(parseRuntimeConfig(base)).toMatchObject({
      PROVIDER_CIRCUIT_REDIS_CONNECT_TIMEOUT_MS: 1_000,
      PROVIDER_CIRCUIT_REDIS_COMMAND_TIMEOUT_MS: 1_000,
      PROVIDER_CIRCUIT_FAILURE_THRESHOLD: 3,
      PROVIDER_CIRCUIT_OPEN_MS: 60_000,
      PROVIDER_CIRCUIT_PROBE_LEASE_MS: 15_000,
    });
  });

  it("rejects unbounded thresholds, cooldowns, probes, and Redis work", () => {
    expect(() =>
      parseRuntimeConfig({ ...base, PROVIDER_CIRCUIT_FAILURE_THRESHOLD: "21" }),
    ).toThrow();
    expect(() => parseRuntimeConfig({ ...base, PROVIDER_CIRCUIT_OPEN_MS: "900001" })).toThrow();
    expect(() =>
      parseRuntimeConfig({
        ...base,
        PROVIDER_CIRCUIT_OPEN_MS: "10000",
        PROVIDER_CIRCUIT_PROBE_LEASE_MS: "10001",
      }),
    ).toThrow("must not exceed");
    expect(() =>
      parseRuntimeConfig({
        ...base,
        PROVIDER_CIRCUIT_REDIS_COMMAND_TIMEOUT_MS: "1001",
        PROVIDER_CIRCUIT_PROBE_LEASE_MS: "1000",
      }),
    ).toThrow("must be at least");
    expect(() =>
      parseRuntimeConfig({ ...base, PROVIDER_CIRCUIT_REDIS_CONNECT_TIMEOUT_MS: "5001" }),
    ).toThrow();
  });
});

describe("runtime provider privacy deadline monitor configuration", () => {
  it("is enabled by default with bounded scan limits", () => {
    expect(parseRuntimeConfig(base)).toMatchObject({
      PROVIDER_PRIVACY_DEADLINE_MONITOR_ENABLED: true,
      PROVIDER_PRIVACY_DEADLINE_MONITOR_INTERVAL_MS: 900_000,
      PROVIDER_PRIVACY_DEADLINE_MONITOR_BATCH_SIZE: 100,
    });
  });

  it("rejects unsafe deadline scan cadence and batch bounds", () => {
    expect(() =>
      parseRuntimeConfig({
        ...base,
        PROVIDER_PRIVACY_DEADLINE_MONITOR_INTERVAL_MS: "59999",
      }),
    ).toThrow();
    expect(() =>
      parseRuntimeConfig({
        ...base,
        PROVIDER_PRIVACY_DEADLINE_MONITOR_BATCH_SIZE: "501",
      }),
    ).toThrow();
  });
});

describe("runtime connector encryption key references", () => {
  it("requires the active version to identify one unique configured reference", () => {
    expect(parseRuntimeConfig(base)).toMatchObject({
      CONNECTOR_ENCRYPTION_KEYS: "v1=env:RECONAI_CONNECTOR_ENCRYPTION_KEY_V1",
      CONNECTOR_ENCRYPTION_ACTIVE_KEY_VERSION: "v1",
    });
    expect(() =>
      parseRuntimeConfig({
        ...base,
        CONNECTOR_ENCRYPTION_ACTIVE_KEY_VERSION: "v2",
      }),
    ).toThrow(/must identify a configured key/u);
    expect(() =>
      parseRuntimeConfig({
        ...base,
        CONNECTOR_ENCRYPTION_KEYS:
          "v1=env:RECONAI_CONNECTOR_ENCRYPTION_KEY_V1,v1=env:RECONAI_CONNECTOR_ENCRYPTION_KEY_OLD",
      }),
    ).toThrow(/duplicate key versions/u);
  });

  it("rejects literal key material and unrestricted environment references", () => {
    expect(() =>
      parseRuntimeConfig({
        ...base,
        CONNECTOR_ENCRYPTION_KEYS: "v1=literal-key-material",
      }),
    ).toThrow();
    expect(() =>
      parseRuntimeConfig({
        ...base,
        CONNECTOR_ENCRYPTION_KEYS: "v1=env:SESSION_SECRET",
      }),
    ).toThrow();
  });
});

describe("runtime provider authorization configuration", () => {
  it("keeps both external authorization surfaces disabled by default", () => {
    expect(parseRuntimeConfig(base)).toMatchObject({
      SHOPIFY_OAUTH_ENABLED: false,
      SHOPIFY_CLIENT_ID: "",
      SHOPIFY_CLIENT_SECRET: "",
      SHOPIFY_OAUTH_SCOPES: "read_orders",
      SHOPIFY_API_VERSION: "2026-07",
      STRIPE_OAUTH_ENABLED: false,
      STRIPE_OAUTH_CLIENT_ID: "",
      STRIPE_OAUTH_SECRET_KEY: "",
      STRIPE_APP_ID: "",
      STRIPE_APP_WEBHOOK_SECRET: "",
      STRIPE_API_VERSION: "2025-06-30.basil",
    });
  });

  it("requires complete provider credentials only for an explicitly enabled flow", () => {
    expect(() =>
      parseRuntimeConfig({
        ...base,
        SHOPIFY_OAUTH_ENABLED: "true",
        SHOPIFY_CLIENT_ID: "shopify-client-id",
      }),
    ).toThrow("Shopify OAuth requires");
    expect(() =>
      parseRuntimeConfig({
        ...base,
        STRIPE_OAUTH_CLIENT_ID: "stripe-client-id",
        STRIPE_OAUTH_SECRET_KEY: "synthetic-stripe-secret",
      }),
    ).toThrow("only valid");
    expect(
      parseRuntimeConfig({
        ...base,
        SHOPIFY_OAUTH_ENABLED: "true",
        SHOPIFY_CLIENT_ID: "shopify-client-id",
        SHOPIFY_CLIENT_SECRET: "synthetic-shopify-secret",
        SHOPIFY_OAUTH_SCOPES: "read_orders,read_refunds",
        STRIPE_OAUTH_ENABLED: "true",
        STRIPE_OAUTH_CLIENT_ID: "stripe-client-id",
        STRIPE_OAUTH_SECRET_KEY: "synthetic-stripe-secret",
        STRIPE_APP_ID: "com.reconai.production",
        STRIPE_APP_WEBHOOK_SECRET: "whsec_synthetic-stripe-app-secret",
      }),
    ).toMatchObject({
      SHOPIFY_OAUTH_ENABLED: true,
      STRIPE_OAUTH_ENABLED: true,
    });
  });

  it("rejects write scopes and duplicate Shopify scopes", () => {
    expect(() =>
      parseRuntimeConfig({
        ...base,
        SHOPIFY_OAUTH_SCOPES: "write_orders",
      }),
    ).toThrow();
    expect(() =>
      parseRuntimeConfig({
        ...base,
        SHOPIFY_OAUTH_SCOPES: "read_orders,read_orders",
      }),
    ).toThrow("duplicate scopes");
  });
});
