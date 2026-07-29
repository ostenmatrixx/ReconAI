import { parseApiRuntimeConfig } from "@workspace/config";
import { ShopifyAuthorizationClient } from "@workspace/connector-shopify";
import { StripeAuthorizationClient } from "@workspace/connector-stripe";
import {
  EnvironmentConnectorSecretResolver,
  createConnectorCredentialKeyring,
  connectorJobId,
  connectorQueueName,
  type ConnectorJobEnvelope,
} from "@workspace/connectors";
import {
  createDatabase,
  PostgresConnectorCredentialService,
  PostgresCsvImportRepository,
  PostgresProviderAuthorizationService,
  PostgresProviderPrivacyDataPackageRepository,
  PostgresProviderPrivacyOperationsRepository,
  PostgresProviderSyncRepository,
  PostgresProviderWebhookRepository,
  PostgresShopifyPrivacyRequestRepository,
  PostgresStripeAppDeauthorizationRepository,
  PostgresSupportAccessRepository,
} from "@workspace/database";
import { DisabledInvitationEmailProvider, HttpInvitationEmailProvider } from "@workspace/email";
import {
  CsvImportService,
  ProviderPrivacyDataPackageService,
  ProviderWebhookService,
  ShopifyPrivacyWebhookService,
  StripeAppDeauthorizationService,
} from "@workspace/ingestion";
import { S3ImmutableObjectStore } from "@workspace/object-storage";
import { createLogger, safeError, startObservability } from "@workspace/observability";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

import { buildApi } from "./app.js";
import {
  OidcIdentityVerifier,
  PostgresMembershipDirectory,
  PostgresOrganizationBootstrapper,
} from "./auth.js";
import { ProviderAuthorizationCoordinator } from "./provider-authorization.js";
import { ProviderDisconnectCoordinator } from "./provider-disconnect.js";
import { createCompositeReadinessProbe } from "./readiness.js";
import { PostgresReconciliationRepository } from "./repository.js";
import { ConfiguredSupportIdentityAuthorizer } from "./support-identity.js";

const config = parseApiRuntimeConfig(process.env);
const observability = startObservability({
  ...(config.OTEL_EXPORTER_OTLP_ENDPOINT ? { endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
  environment: config.APP_ENV,
  production: config.NODE_ENV === "production",
  serviceName: "reconai-api",
  traceSampleRatio: config.OTEL_TRACE_SAMPLE_RATIO,
  metricExportIntervalMs: config.OTEL_METRIC_EXPORT_INTERVAL_MS,
  exportTimeoutMs: config.OTEL_EXPORT_TIMEOUT_MS,
});
const logger = createLogger("reconai-api-main", config.APP_ENV, config.LOG_LEVEL);
const database = createDatabase(config.DATABASE_URL);
const connectorCredentialKeyring = createConnectorCredentialKeyring({
  references: config.CONNECTOR_ENCRYPTION_KEYS,
  activeVersion: config.CONNECTOR_ENCRYPTION_ACTIVE_KEY_VERSION,
  environment: process.env,
  production: config.NODE_ENV === "production",
});
const shopifyAuthorizationClient = config.SHOPIFY_OAUTH_ENABLED
  ? new ShopifyAuthorizationClient({
      clientId: requiredConfigured(config.SHOPIFY_CLIENT_ID, "SHOPIFY_CLIENT_ID"),
      clientSecret: requiredConfigured(config.SHOPIFY_CLIENT_SECRET, "SHOPIFY_CLIENT_SECRET"),
      redirectUri: new URL(
        "/api/recon/provider-authorizations/callback/shopify",
        config.WEB_ORIGIN,
      ).toString(),
      requiredScopes: config.SHOPIFY_OAUTH_SCOPES.split(","),
    })
  : undefined;
const stripeAuthorizationClient = config.STRIPE_OAUTH_ENABLED
  ? new StripeAuthorizationClient({
      clientId: requiredConfigured(config.STRIPE_OAUTH_CLIENT_ID, "STRIPE_OAUTH_CLIENT_ID"),
      secretKey: requiredConfigured(config.STRIPE_OAUTH_SECRET_KEY, "STRIPE_OAUTH_SECRET_KEY"),
      redirectUri: new URL(
        "/api/recon/provider-authorizations/callback/stripe",
        config.WEB_ORIGIN,
      ).toString(),
    })
  : undefined;
const connectorCredentials = new PostgresConnectorCredentialService(
  database.sql,
  connectorCredentialKeyring,
  new EnvironmentConnectorSecretResolver(process.env),
  {
    oauthRefreshers: {
      ...(shopifyAuthorizationClient ? { shopify: shopifyAuthorizationClient } : {}),
      ...(stripeAuthorizationClient ? { stripe: stripeAuthorizationClient } : {}),
    },
  },
);
const providerAuthorizations = new ProviderAuthorizationCoordinator({
  manager: new PostgresProviderAuthorizationService(database.sql, connectorCredentialKeyring),
  ...(shopifyAuthorizationClient
    ? {
        shopify: {
          client: shopifyAuthorizationClient,
          apiVersion: config.SHOPIFY_API_VERSION,
        },
      }
    : {}),
  ...(stripeAuthorizationClient
    ? {
        stripe: {
          client: stripeAuthorizationClient,
          apiVersion: config.STRIPE_API_VERSION,
        },
      }
    : {}),
});
const providerDisconnects = new ProviderDisconnectCoordinator({
  store: connectorCredentials,
  secrets: connectorCredentials,
  ...(shopifyAuthorizationClient
    ? {
        shopify: {
          client: shopifyAuthorizationClient,
          apiVersion: config.SHOPIFY_API_VERSION,
        },
      }
    : {}),
  ...(stripeAuthorizationClient
    ? {
        stripe: {
          appId: requiredConfigured(config.STRIPE_APP_ID, "STRIPE_APP_ID"),
        },
      }
    : {}),
});
const providerDeauthorizations = config.STRIPE_OAUTH_ENABLED
  ? new StripeAppDeauthorizationService(
      new PostgresStripeAppDeauthorizationRepository(database.sql, connectorCredentialKeyring),
      requiredConfigured(config.STRIPE_APP_WEBHOOK_SECRET, "STRIPE_APP_WEBHOOK_SECRET"),
    )
  : undefined;
const shopifyPrivacyWebhooks = config.SHOPIFY_OAUTH_ENABLED
  ? new ShopifyPrivacyWebhookService(
      new PostgresShopifyPrivacyRequestRepository(database.sql),
      requiredConfigured(config.SHOPIFY_CLIENT_SECRET, "SHOPIFY_CLIENT_SECRET"),
      config.SHOPIFY_API_VERSION,
    )
  : undefined;
const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: false,
});
const readinessRedis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 1,
  connectTimeout: config.API_READINESS_TIMEOUT_MS,
  commandTimeout: config.API_READINESS_TIMEOUT_MS,
  enableReadyCheck: true,
  enableOfflineQueue: false,
  lazyConnect: false,
  connectionName: `reconai-${config.APP_ENV}-api-readiness`,
});
readinessRedis.on("error", () => {
  // State transitions are logged by the composite probe without connection or credential details.
});
const rateLimitRedis =
  config.API_RATE_LIMIT_STORE === "redis"
    ? new Redis(config.REDIS_URL, {
        maxRetriesPerRequest: 1,
        connectTimeout: config.API_RATE_LIMIT_REDIS_CONNECT_TIMEOUT_MS,
        commandTimeout: config.API_RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS,
        enableReadyCheck: true,
        enableOfflineQueue: false,
        lazyConnect: true,
        connectionName: `reconai-${config.APP_ENV}-api-rate-limit`,
      })
    : undefined;
if (rateLimitRedis) {
  await rateLimitRedis.connect();
  await rateLimitRedis.ping();
}
const connectorQueue = new Queue<ConnectorJobEnvelope>(connectorQueueName(config.APP_ENV), {
  connection: redis,
  defaultJobOptions: {
    attempts: 6,
    backoff: { type: "custom" },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: false,
  },
});
const objectStore = new S3ImmutableObjectStore({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  bucket: config.S3_BUCKET,
  accessKeyId: config.S3_ACCESS_KEY_ID,
  secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
  ...(config.S3_SERVER_SIDE_ENCRYPTION
    ? { serverSideEncryption: config.S3_SERVER_SIDE_ENCRYPTION }
    : {}),
  ...(config.S3_KMS_KEY_ID ? { kmsKeyId: config.S3_KMS_KEY_ID } : {}),
});
const repository = new PostgresReconciliationRepository(database.sql, {
  runTransactionTimeoutMilliseconds: config.RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS,
  maximumConcurrentRunTransactions: config.RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS,
});
let previousReadinessState: string | undefined;
const readiness = createCompositeReadinessProbe(
  [
    {
      name: "postgresql",
      check: async (signal) => repository.health(signal),
    },
    {
      name: "redis",
      check: async (signal) => {
        if (signal.aborted || readinessRedis.status !== "ready") return false;
        await readinessRedis.ping();
        return !signal.aborted;
      },
    },
    {
      name: "object_storage",
      check: async (signal) => objectStore.health(signal),
    },
  ],
  {
    timeoutMs: config.API_READINESS_TIMEOUT_MS,
    onEvaluation: (evaluation) => {
      const state = JSON.stringify(evaluation);
      if (state === previousReadinessState) return;
      previousReadinessState = state;
      const context = {
        ready: evaluation.ready,
        failedChecks: evaluation.failedChecks,
        timedOut: evaluation.timedOut,
      };
      if (evaluation.ready) {
        logger.info(context, "API readiness state changed");
      } else {
        logger.warn(context, "API readiness state changed");
      }
    },
  },
);
const verifier = new OidcIdentityVerifier(config.OIDC_ISSUER, config.OIDC_CLIENT_ID);
const supportIdentityAuthorizer = new ConfiguredSupportIdentityAuthorizer(
  config.SUPPORT_ACCESS_ENABLED
    ? {
        enabled: true,
        requiredGroup: requiredConfigured(config.SUPPORT_OIDC_GROUP, "SUPPORT_OIDC_GROUP"),
        requiredAuthenticationContext: requiredConfigured(
          config.SUPPORT_OIDC_AUTHENTICATION_CONTEXT,
          "SUPPORT_OIDC_AUTHENTICATION_CONTEXT",
        ),
        identityHmacKey: requiredConfigured(
          config.SUPPORT_IDENTITY_HMAC_KEY,
          "SUPPORT_IDENTITY_HMAC_KEY",
        ),
      }
    : { enabled: false },
);
const invitationEmail =
  config.EMAIL_PROVIDER === "http_webhook"
    ? new HttpInvitationEmailProvider({
        endpoint: config.EMAIL_WEBHOOK_URL,
        authorizationToken: config.EMAIL_DELIVERY_TOKEN,
        from: config.EMAIL_FROM,
        timeoutMs: config.EMAIL_REQUEST_TIMEOUT_MS,
      })
    : new DisabledInvitationEmailProvider();
const publisher = {
  publish: async (envelope: ConnectorJobEnvelope) => {
    await connectorQueue.add(envelope.type, envelope, { jobId: connectorJobId(envelope) });
  },
};
const app = await buildApi({
  identityVerifier: verifier,
  memberships: new PostgresMembershipDirectory(database.sql),
  organizationBootstrap: new PostgresOrganizationBootstrapper(database.sql),
  repository,
  providerPrivacyOperations: new PostgresProviderPrivacyOperationsRepository(database.sql),
  providerPrivacyDataPackages: new ProviderPrivacyDataPackageService({
    repository: new PostgresProviderPrivacyDataPackageRepository(database.sql),
    objectStore,
  }),
  csvImports: new CsvImportService({
    environment: config.APP_ENV,
    repository: new PostgresCsvImportRepository(database.sql),
    objectStore,
    publisher,
  }),
  providerWebhooks: new ProviderWebhookService({
    environment: config.APP_ENV,
    repository: new PostgresProviderWebhookRepository(database.sql),
    objectStore,
    secrets: connectorCredentials,
    publisher,
  }),
  ...(shopifyPrivacyWebhooks ? { shopifyPrivacyWebhooks } : {}),
  ...(providerDeauthorizations ? { providerDeauthorizations } : {}),
  providerSyncs: new PostgresProviderSyncRepository(database.sql),
  connectorCredentials,
  providerDisconnects,
  providerAuthorizations,
  supportIdentityAuthorizer,
  supportAccess: new PostgresSupportAccessRepository(database.sql),
  invitationEmail,
  webOrigin: config.WEB_ORIGIN,
  environment: config.APP_ENV,
  readiness,
  trustedProxies: config.API_TRUST_PROXY_CIDRS,
  rateLimit: rateLimitRedis
    ? {
        store: "redis",
        redis: rateLimitRedis,
        environment: config.APP_ENV,
        keySecret: requiredConfigured(
          config.API_RATE_LIMIT_KEY_SECRET,
          "API_RATE_LIMIT_KEY_SECRET",
        ),
      }
    : { store: "local" },
});

await app.listen({ port: config.API_PORT, host: config.API_HOST });

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdown(signal);
  });
}

async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  let exitCode = 0;
  try {
    try {
      await app.close();
      await connectorQueue.close();
      readinessRedis.disconnect();
      await redis.quit();
      if (rateLimitRedis) await rateLimitRedis.quit();
      objectStore.close();
      await database.close();
    } catch (error) {
      exitCode = 1;
      logger.error({ signal, error: safeError(error) }, "API shutdown cleanup failed");
    }
  } finally {
    try {
      await observability.shutdown();
    } catch (error) {
      exitCode = 1;
      logger.error({ signal, error: safeError(error) }, "API telemetry shutdown failed");
    }
    process.exit(exitCode);
  }
}

function requiredConfigured(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required by the enabled runtime feature`);
  return value;
}
