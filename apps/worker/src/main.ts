import { parseWorkerRuntimeConfig } from "@workspace/config";
import { ShopifyAuthorizationClient, ShopifyOrderPageSource } from "@workspace/connector-shopify";
import { StripeAuthorizationClient, StripeEventPageSource } from "@workspace/connector-stripe";
import {
  DurableJobEnvelopeSchema,
  EnvironmentConnectorSecretResolver,
  createConnectorCredentialKeyring,
  durableJobId,
  durableQueueName,
  type DurableJobEnvelope,
} from "@workspace/connectors";
import {
  createDatabase,
  PostgresConnectorCredentialService,
  PostgresCsvImportRepository,
  PostgresExceptionQueueObservabilityRepository,
  PostgresJobExecutionRepository,
  PostgresOutboxRelayRepository,
  PostgresProviderPrivacyDeadlineAlertRepository,
  PostgresProviderPrivacyObjectDeletionRepository,
  PostgresProviderActiveSyncObservabilityRepository,
  PostgresProviderSyncRepository,
  PostgresProviderWebhookRepository,
  PostgresRetentionDeletionRepository,
} from "@workspace/database";
import {
  CsvImportService,
  CsvImportTerminalError,
  ProviderSyncService,
  ProviderSyncTerminalError,
  ProviderWebhookService,
  ProviderWebhookTerminalError,
} from "@workspace/ingestion";
import { S3ImmutableObjectStore } from "@workspace/object-storage";
import {
  activeTraceparent,
  createLogger,
  providerNormalizationOutcomeForTerminalCode,
  providerNormalizationSourceForRequestedBy,
  providerSyncTriggerForRequestedBy,
  recordProviderEventFreshness,
  safeError,
  startObservability,
  startProviderNormalizationObservation,
  startProviderSyncObservation,
  startReconciliationRunObservation,
} from "@workspace/observability";
import { Queue, UnrecoverableError } from "bullmq";
import { Redis } from "ioredis";

import { buildConnectorWorker } from "./worker.js";
import { startOutboxRelay } from "./outbox-relay.js";
import { RedisProviderRequestCircuit } from "./provider-circuit-breaker.js";
import { startProviderGapRepairScheduler } from "./provider-gap-repair-scheduler.js";
import { startProviderPrivacyDeadlineMonitor } from "./provider-privacy-deadline-monitor.js";
import { startProviderPrivacyDeletionExecutor } from "./provider-privacy-deletion.js";
import { startDurableQueueMonitor } from "./queue-observability.js";
import {
  PostgresReconciliationRunProcessor,
  ReconciliationRunExecutionError,
} from "./reconciliation-run-execution.js";
import { startRetentionExecutor } from "./retention-execution.js";

const config = parseWorkerRuntimeConfig(process.env);
const observability = startObservability({
  ...(config.OTEL_EXPORTER_OTLP_ENDPOINT ? { endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
  environment: config.APP_ENV,
  production: config.NODE_ENV === "production",
  serviceName: "reconai-worker",
  traceSampleRatio: config.OTEL_TRACE_SAMPLE_RATIO,
  metricExportIntervalMs: config.OTEL_METRIC_EXPORT_INTERVAL_MS,
  exportTimeoutMs: config.OTEL_EXPORT_TIMEOUT_MS,
  metricTemporality: "delta",
});
const logger = createLogger("reconai-worker-main", config.APP_ENV, config.LOG_LEVEL);
const database = createDatabase(config.DATABASE_WORKER_URL);
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
const connectorCredentialKeyring = createConnectorCredentialKeyring({
  references: config.CONNECTOR_ENCRYPTION_KEYS,
  activeVersion: config.CONNECTOR_ENCRYPTION_ACTIVE_KEY_VERSION,
  environment: process.env,
  production: config.NODE_ENV === "production",
});
const connectorSecrets = new PostgresConnectorCredentialService(
  database.sql,
  connectorCredentialKeyring,
  new EnvironmentConnectorSecretResolver(process.env),
  {
    oauthRefreshers: {
      ...(config.SHOPIFY_OAUTH_ENABLED
        ? {
            shopify: new ShopifyAuthorizationClient({
              clientId: requiredConfigured(config.SHOPIFY_CLIENT_ID, "SHOPIFY_CLIENT_ID"),
              clientSecret: requiredConfigured(
                config.SHOPIFY_CLIENT_SECRET,
                "SHOPIFY_CLIENT_SECRET",
              ),
              redirectUri: new URL(
                "/api/recon/provider-authorizations/callback/shopify",
                config.WEB_ORIGIN,
              ).toString(),
              requiredScopes: config.SHOPIFY_OAUTH_SCOPES.split(","),
            }),
          }
        : {}),
      ...(config.STRIPE_OAUTH_ENABLED
        ? {
            stripe: new StripeAuthorizationClient({
              clientId: requiredConfigured(config.STRIPE_OAUTH_CLIENT_ID, "STRIPE_OAUTH_CLIENT_ID"),
              secretKey: requiredConfigured(
                config.STRIPE_OAUTH_SECRET_KEY,
                "STRIPE_OAUTH_SECRET_KEY",
              ),
              redirectUri: new URL(
                "/api/recon/provider-authorizations/callback/stripe",
                config.WEB_ORIGIN,
              ).toString(),
            }),
          }
        : {}),
    },
  },
);
const csvImports = new CsvImportService({
  environment: config.APP_ENV,
  repository: new PostgresCsvImportRepository(database.sql),
  objectStore,
});
const providerWebhooks = new ProviderWebhookService({
  environment: config.APP_ENV,
  repository: new PostgresProviderWebhookRepository(database.sql),
  objectStore,
  secrets: connectorSecrets,
});
const providerSyncRepository = new PostgresProviderSyncRepository(database.sql);
const providerCircuitRedis = new Redis(config.REDIS_URL, {
  connectTimeout: config.PROVIDER_CIRCUIT_REDIS_CONNECT_TIMEOUT_MS,
  commandTimeout: config.PROVIDER_CIRCUIT_REDIS_COMMAND_TIMEOUT_MS,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  enableReadyCheck: true,
  lazyConnect: false,
});
providerCircuitRedis.on("error", () => {
  // Circuit command failures fail provider admission closed and surface through bounded job errors.
});
const providerSyncs = new ProviderSyncService({
  repository: providerSyncRepository,
  providerEvents: providerWebhooks,
  sources: [
    new ShopifyOrderPageSource({ secrets: connectorSecrets }),
    new StripeEventPageSource({ secrets: connectorSecrets }),
  ],
  requestCircuit: new RedisProviderRequestCircuit({
    client: providerCircuitRedis,
    environment: config.APP_ENV,
    failureThreshold: config.PROVIDER_CIRCUIT_FAILURE_THRESHOLD,
    openMs: config.PROVIDER_CIRCUIT_OPEN_MS,
    probeLeaseMs: config.PROVIDER_CIRCUIT_PROBE_LEASE_MS,
  }),
});
const reconciliationRuns = new PostgresReconciliationRunProcessor(database.sql);
const jobExecutions = new PostgresJobExecutionRepository(database.sql);
const queueName = durableQueueName(config.APP_ENV);
const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: false,
});
const durableQueue = new Queue<DurableJobEnvelope>(queueName, {
  connection: redis,
  defaultJobOptions: {
    attempts: 6,
    backoff: { type: "custom" },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: false,
  },
});
const queueMonitorRedis = observability.enabled
  ? new Redis(config.REDIS_URL, {
      connectTimeout: config.DURABLE_QUEUE_MONITOR_REDIS_CONNECT_TIMEOUT_MS,
      commandTimeout: config.DURABLE_QUEUE_MONITOR_REDIS_COMMAND_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      enableReadyCheck: true,
      lazyConnect: false,
    })
  : undefined;
queueMonitorRedis?.on("error", () => {
  // The bounded monitor poll reports a redacted failure; Redis errors never stop queue processing.
});
const queueMonitorInspector = queueMonitorRedis
  ? new Queue<DurableJobEnvelope>(queueName, { connection: queueMonitorRedis })
  : undefined;
queueMonitorInspector?.on("error", () => {
  // The bounded monitor poll reports a redacted failure; BullMQ errors never stop queue processing.
});
const queueMonitor =
  queueMonitorRedis && queueMonitorInspector
    ? startDurableQueueMonitor({
        inspector: queueMonitorInspector,
        leaseStore: queueMonitorRedis,
        queueName,
        environment: config.APP_ENV,
        intervalMs: config.DURABLE_QUEUE_MONITOR_INTERVAL_MS,
        exceptionQueue: new PostgresExceptionQueueObservabilityRepository(database.sql),
        providerActiveSyncs: new PostgresProviderActiveSyncObservabilityRepository(database.sql),
      })
    : undefined;
const outboxRelay = startOutboxRelay({
  repository: new PostgresOutboxRelayRepository(database.sql),
  environment: config.APP_ENV,
  publisher: {
    publish: async (envelope) => {
      await durableQueue.add(envelope.type, envelope, {
        jobId: durableJobId(envelope),
      });
    },
  },
});
const retentionExecutor = startRetentionExecutor({
  repository: new PostgresRetentionDeletionRepository(database.sql),
  objectStore,
  environment: config.APP_ENV,
});
const providerPrivacyDeletionExecutor = startProviderPrivacyDeletionExecutor({
  repository: new PostgresProviderPrivacyObjectDeletionRepository(database.sql),
  objectStore,
  environment: config.APP_ENV,
});
const providerGapRepairScheduler = config.PROVIDER_GAP_REPAIR_ENABLED
  ? startProviderGapRepairScheduler({
      repository: providerSyncRepository,
      environment: config.APP_ENV,
      intervalMs: config.PROVIDER_GAP_REPAIR_INTERVAL_MS,
      lookbackMs: config.PROVIDER_GAP_REPAIR_LOOKBACK_MS,
      overlapMs: config.PROVIDER_GAP_REPAIR_OVERLAP_MS,
      maximumPages: config.PROVIDER_GAP_REPAIR_MAXIMUM_PAGES,
      batchSize: config.PROVIDER_GAP_REPAIR_BATCH_SIZE,
    })
  : undefined;
const providerPrivacyDeadlineMonitor = config.PROVIDER_PRIVACY_DEADLINE_MONITOR_ENABLED
  ? startProviderPrivacyDeadlineMonitor({
      repository: new PostgresProviderPrivacyDeadlineAlertRepository(database.sql),
      environment: config.APP_ENV,
      intervalMs: config.PROVIDER_PRIVACY_DEADLINE_MONITOR_INTERVAL_MS,
      batchSize: config.PROVIDER_PRIVACY_DEADLINE_MONITOR_BATCH_SIZE,
    })
  : undefined;

const worker = buildConnectorWorker({
  redis,
  environment: config.APP_ENV,
  executionLedger: jobExecutions,
  loadDurableJobAuthority: async (data) => {
    const envelope = DurableJobEnvelopeSchema.parse(data);
    const found = await database.sql.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${envelope.organizationId}, true)`;
      return transaction`
        select id, event_type, payload
        from outbox_events
        where organization_id = ${envelope.organizationId}
          and idempotency_key = ${envelope.idempotencyKey}
        limit 1
      `;
    });
    const row = found[0];
    if (!row) {
      throw new UnrecoverableError("durable job has no tenant-bound outbox authority");
    }
    const authorizedResult = DurableJobEnvelopeSchema.safeParse(row["payload"]);
    if (!authorizedResult.success) {
      throw new UnrecoverableError("durable outbox authority has an invalid schema");
    }
    const authorized = authorizedResult.data;
    if (
      row["event_type"] !== envelope.type ||
      durableJobId(authorized) !== durableJobId(envelope) ||
      authorized.correlationId !== envelope.correlationId ||
      authorized.requestedBy !== envelope.requestedBy
    ) {
      throw new UnrecoverableError("durable job does not match its tenant-bound outbox authority");
    }
    return authorized;
  },
  processDurableJob: async (data) => {
    const envelope = DurableJobEnvelopeSchema.parse(data);
    logger.info(
      {
        type: envelope.type,
        correlationId: envelope.correlationId,
      },
      "durable handler boundary reached",
    );
    if (envelope.type === "reconciliation.run.requested") {
      const observation = startReconciliationRunObservation();
      return observation.run(async () => {
        try {
          const result = await reconciliationRuns.process(envelope);
          if (result.alreadyCompleted) observation.finish("already_completed");
          else observation.finish("succeeded", result.counts);
        } catch (error) {
          observation.finish(
            error instanceof ReconciliationRunExecutionError
              ? "failed_terminal"
              : "failed_retryable",
          );
          if (error instanceof ReconciliationRunExecutionError) {
            throw new UnrecoverableError(`${error.code}: ${error.message}`);
          }
          throw error;
        }
      });
    }
    if (envelope.type === "csv.import.commit") {
      try {
        await csvImports.processImport(envelope);
        return;
      } catch (error) {
        if (error instanceof CsvImportTerminalError) {
          throw new UnrecoverableError(`${error.code}: ${error.message}`);
        }
        throw error;
      }
    }
    if (envelope.type === "connector.sync.requested") {
      const observation = startProviderSyncObservation({
        provider: envelope.provider,
        trigger: providerSyncTriggerForRequestedBy(envelope.requestedBy),
      });
      try {
        const durableTraceparent = activeTraceparent();
        const result = await providerSyncs.process(envelope, {
          ...(durableTraceparent ? { traceparent: durableTraceparent } : {}),
        });
        observation.finish(result.status);
        return;
      } catch (error) {
        if (error instanceof ProviderSyncTerminalError) {
          observation.finish("failed_terminal");
          throw new UnrecoverableError(`${error.code}: ${error.message}`);
        }
        observation.finish("failed_retryable");
        throw error;
      }
    }
    const normalizationSource = providerNormalizationSourceForRequestedBy(
      envelope.provider,
      envelope.requestedBy,
    );
    const normalizationObservation = startProviderNormalizationObservation({
      provider: envelope.provider,
      source: normalizationSource,
    });
    try {
      const result = await providerWebhooks.processWebhookWithMetadata(envelope);
      normalizationObservation.finish(result.status);
      if (result.status === "processed") {
        recordProviderEventFreshness({
          provider: envelope.provider,
          source: normalizationSource,
          sourceTimestamp: result.sourceTimestamp,
        });
      }
    } catch (error) {
      if (error instanceof ProviderWebhookTerminalError) {
        normalizationObservation.finish(providerNormalizationOutcomeForTerminalCode(error.code));
        throw new UnrecoverableError(`${error.code}: ${error.message}`);
      }
      normalizationObservation.finish("failed_retryable");
      throw error;
    }
  },
});

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
      await queueMonitor?.close();
      await queueMonitorInspector?.close();
      await queueMonitorRedis?.quit();
      await outboxRelay.close();
      await providerGapRepairScheduler?.close();
      await providerPrivacyDeadlineMonitor?.close();
      await providerPrivacyDeletionExecutor.close();
      await retentionExecutor.close();
      await worker.close();
      await durableQueue.close();
      await providerCircuitRedis.quit();
      await redis.quit();
      objectStore.close();
      await database.close();
    } catch (error) {
      exitCode = 1;
      logger.error({ signal, error: safeError(error) }, "worker shutdown cleanup failed");
    }
  } finally {
    try {
      await observability.shutdown();
    } catch (error) {
      exitCode = 1;
      logger.error({ signal, error: safeError(error) }, "worker telemetry shutdown failed");
    }
    process.exit(exitCode);
  }
}

function requiredConfigured(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required when its provider OAuth flow is enabled`);
  return value;
}
