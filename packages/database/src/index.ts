import postgres, { type Sql } from "postgres";

export {
  AuditChainIntegrityError,
  computeAuditEventHashV2,
  insertTenantAuditEvent,
  insertUserAuditEvent,
  type AuditEventHashV2Input,
  type AuditJsonValue,
  type TenantAuditEvent,
} from "./audit.js";
export { PostgresCsvImportRepository } from "./csv-imports.js";
export {
  PostgresExceptionQueueObservabilityRepository,
  type ExceptionQueueObservation,
  type ExceptionQueueObservabilityRepository,
} from "./exception-queue-observability.js";
export {
  PostgresProviderActiveSyncObservabilityRepository,
  type ProviderActiveSyncObservation,
  type ProviderActiveSyncObservabilityRepository,
} from "./provider-active-sync-observability.js";
export {
  ConnectorCredentialConflictError,
  ConnectorCredentialNotFoundError,
  PostgresConnectorCredentialService,
  type ConnectorCredentialServiceOptions,
  type ConnectorDisconnectAuthority,
  type ConnectorCredentialLifecycleManager,
  type ConnectorCredentialMetadata,
  type ConnectorProviderDisconnectStore,
  type ConnectorCredentialRotationResult,
  type ConnectorOAuthRefreshers,
} from "./connector-credentials.js";
export {
  PostgresProviderAuthorizationService,
  ProviderAuthorizationConflictError,
  ProviderAuthorizationExpiredError,
  ProviderAuthorizationNotFoundError,
  type ClaimedProviderAuthorization,
  type ProviderAuthorizationBeginResult,
  type ProviderAuthorizationClaimResult,
  type ProviderAuthorizationCompletionResult,
  type ProviderAuthorizationManager,
  type ProviderAuthorizationProvider,
  type ProviderAuthorizationStatus,
} from "./provider-authorization.js";
export { PostgresProviderWebhookRepository } from "./provider-webhooks.js";
export { PostgresStripeAppDeauthorizationRepository } from "./provider-deauthorization.js";
export { PostgresShopifyPrivacyRequestRepository } from "./provider-privacy.js";
export {
  PostgresProviderPrivacyOperationsRepository,
  ProviderPrivacyOperationsCursorError,
  type ProviderPrivacyOperationsRepository,
  type ProviderPrivacyRequestOperationsItem,
  type ProviderPrivacyRequestOperationsPage,
} from "./provider-privacy-operations.js";
export { PostgresProviderPrivacyDataPackageRepository } from "./provider-privacy-data-package.js";
export {
  classifyProviderPrivacyDeadlineStage,
  PostgresProviderPrivacyDeadlineAlertRepository,
  type ProviderPrivacyDeadlineAlertRepository,
  type ProviderPrivacyDeadlineAlertScanInput,
  type ProviderPrivacyDeadlineAlertScanResult,
  type ProviderPrivacyDeadlineAlertStage,
} from "./provider-privacy-deadline-alerts.js";
export {
  PostgresProviderPrivacyObjectDeletionRepository,
  ProviderPrivacyObjectDeletionError,
  type ProviderPrivacyObjectDeletionCandidate,
  type ProviderPrivacyObjectDeletionOutcome,
  type ProviderPrivacyObjectDeletionProcessResult,
  type ProviderPrivacyObjectDeletionRepository,
} from "./provider-privacy-deletion.js";
export {
  PostgresProviderSyncRepository,
  type ScheduledProviderGapRepairCandidateObservation,
  type ScheduledProviderGapRepairInput,
  type ScheduledProviderGapRepairResult,
} from "./provider-sync.js";
export {
  PostgresOutboxRelayRepository,
  type OutboxRelayRepository,
  type PendingOutboxEvent,
} from "./outbox.js";
export {
  PostgresJobExecutionRepository,
  type AcquiredJobExecution,
  type JobExecutionAuthority,
  type JobExecutionBeginOutcome,
  type JobExecutionBeginResult,
  type JobExecutionFailureStatus,
  type JobExecutionLedger,
  type NonAcquiredJobExecution,
  type QueueRecoveryClassification,
  type QueueRecoveryEvidenceInput,
  type QueueRecoverySummary,
  type RecoverableQueueEvent,
} from "./job-executions.js";
export {
  PostgresRetentionDeletionRepository,
  RetentionDeletionError,
  type RetentionDeletionCandidate,
  type RetentionDeletionOutcome,
  type RetentionDeletionProcessResult,
  type RetentionDeletionRepository,
} from "./retention.js";
export {
  PostgresSourceEventClassificationRepairRepository,
  type SourceEventClassificationRepairCandidate,
  type SourceEventClassificationRepairGapCounts,
  type SourceEventClassificationRepairProcessResult,
  type SourceEventClassificationRepairRepository,
} from "./source-event-classification-repair.js";
export {
  PostgresSourceEventClassificationWriterFenceRepository,
  type SourceEventClassificationWriterFenceActivation,
  type SourceEventClassificationWriterFenceRepository,
  type SourceEventClassificationWriterFenceStatus,
} from "./source-event-classification-writer-fence.js";
export {
  PostgresSupportAccessRepository,
  SupportAccessNotFoundError,
  type SupportAccessGrant,
  type SupportAccessRepository,
  type SupportAccessRequest,
  type SupportAccessRevocation,
  type SupportDiagnostics,
} from "./support-access.js";
export { withTenantTransaction } from "./tenant-transaction.js";

export interface DatabaseHandle {
  readonly sql: Sql;
  close(): Promise<void>;
}

export function createDatabase(url: string, maximumConnections = 10): DatabaseHandle {
  const sql = postgres(url, {
    max: maximumConnections,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: true,
  });
  return {
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

export * as databaseSchema from "./schema.js";
