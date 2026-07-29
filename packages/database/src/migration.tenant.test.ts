import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("tenant security migration", () => {
  const securitySql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0002_tenant_security.sql"),
    "utf8",
  );
  const relationSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0001_tenant_relation_integrity.sql"),
    "utf8",
  );
  const importSecuritySql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0004_import_security.sql"),
    "utf8",
  );
  const immutableIngestionSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0005_immutable_ingestion_records.sql"),
    "utf8",
  );
  const reconciliationHistorySql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0007_reconciliation_history_security.sql"),
    "utf8",
  );
  const providerWebhookSecuritySql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0009_provider_webhook_security.sql"),
    "utf8",
  );
  const outboxRelaySecuritySql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0011_outbox_relay_security.sql"),
    "utf8",
  );
  const canonicalProvenanceSecuritySql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0013_canonical_provenance_security.sql"),
    "utf8",
  );
  const reviewPolicySecuritySql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0015_review_policy_security.sql"),
    "utf8",
  );
  const accessHealthConstraintsSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0016_access_health_constraints.sql"),
    "utf8",
  );
  const exceptionNotesSecuritySql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0018_exception_notes_security.sql"),
    "utf8",
  );
  const reconciliationExecutionSecuritySql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0020_reconciliation_execution_security.sql"),
    "utf8",
  );
  const organizationInvitationSecuritySql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0022_organization_invitation_security.sql"),
    "utf8",
  );
  const exceptionQueuePaginationSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0023_exception_queue_pagination.sql"),
    "utf8",
  );
  const reconciliationRunAuthoritySchemaSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0024_third_black_crow.sql"),
    "utf8",
  );
  const reconciliationRunAuthoritySecuritySql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0025_reconciliation_run_authority_security.sql"),
    "utf8",
  );
  const importRollbackSecuritySql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0026_bumpy_beyonder.sql"),
    "utf8",
  );
  const invitationAcceptanceQualificationSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0027_invitation_acceptance_qualification.sql"),
    "utf8",
  );
  const organizationAccessDirectorySql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0028_organization_access_directory.sql"),
    "utf8",
  );
  const paginatedOrganizationAccessDirectorySql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0041_paginated_organization_access_directory.sql"),
    "utf8",
  );
  const organizationBootstrapSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0042_identity_bound_organization_bootstrap.sql"),
    "utf8",
  );
  const reconciliationOccurrenceSnapshotsSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0043_reconciliation_occurrence_snapshots.sql"),
    "utf8",
  );
  const exceptionQueueObservabilityIndexSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0044_exception_queue_observability_index.sql"),
    "utf8",
  );
  const exceptionQueueObservabilityAuthoritySql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0045_exception_queue_observability_authority.sql"),
    "utf8",
  );
  const providerActiveSyncObservabilityIndexSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0046_provider_active_sync_observability_index.sql"),
    "utf8",
  );
  const providerActiveSyncObservabilityAuthoritySql = readFileSync(
    resolve(
      import.meta.dirname,
      "../migrations/0047_provider_active_sync_observability_authority.sql",
    ),
    "utf8",
  );
  const sourceEventObjectWatermarkIndexSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0048_source_event_object_watermark_index.sql"),
    "utf8",
  );
  const sourceEventObjectClassificationsSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0049_source_event_object_classifications.sql"),
    "utf8",
  );
  const providerPrivacyDataPackageReceiptsSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0050_provider_privacy_data_package_receipts.sql"),
    "utf8",
  );
  const sourceEventClassificationRepairAuthoritySql = readFileSync(
    resolve(
      import.meta.dirname,
      "../migrations/0051_source_event_classification_repair_authority.sql",
    ),
    "utf8",
  );
  const sourceEventClassificationWriterFenceSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0052_source_event_classification_writer_fence.sql"),
    "utf8",
  );
  const restrictedSupportAccessSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0053_restricted_support_access.sql"),
    "utf8",
  );
  const supportAccessRequestGrantIntegritySql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0054_support_access_request_grant_integrity.sql"),
    "utf8",
  );
  const organizationProfileVersionSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0055_organization_profile_version.sql"),
    "utf8",
  );
  const migrationRunnerSource = readFileSync(resolve(import.meta.dirname, "./migrate.ts"), "utf8");
  const migrationValidatorSource = readFileSync(
    resolve(import.meta.dirname, "../../../scripts/validate-migrations.mjs"),
    "utf8",
  );
  const retentionDeletionWorkflowSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0029_retention_deletion_workflow.sql"),
    "utf8",
  );
  const providerSyncRunsSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0030_provider_sync_runs.sql"),
    "utf8",
  );
  const scheduledProviderGapRepairSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0031_scheduled_provider_gap_repair.sql"),
    "utf8",
  );
  const connectorCredentialLifecycleSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0032_connector_credential_lifecycle.sql"),
    "utf8",
  );
  const providerAuthorizationLifecycleSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0033_provider_authorization_lifecycle.sql"),
    "utf8",
  );
  const oauthCredentialRefreshSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0034_oauth_credential_refresh.sql"),
    "utf8",
  );
  const providerConfirmedDisconnectSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0035_provider_confirmed_disconnect.sql"),
    "utf8",
  );
  const providerPrivacyRequestsSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0036_provider_privacy_requests.sql"),
    "utf8",
  );
  const providerPrivacyObjectDeletionSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0037_provider_privacy_object_deletion.sql"),
    "utf8",
  );
  const providerPrivacyDeadlineAlertsSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0038_provider_privacy_deadline_alerts.sql"),
    "utf8",
  );
  const auditChainTopologySql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0039_audit_chain_topology.sql"),
    "utf8",
  );
  const durableJobExecutionLedgerSql = readFileSync(
    resolve(import.meta.dirname, "../migrations/0040_durable_job_execution_ledger.sql"),
    "utf8",
  );

  it("forces RLS and binds policies to app.organization_id", () => {
    expect(securitySql).toMatch(/FORCE ROW LEVEL SECURITY/u);
    expect(securitySql).toMatch(/current_setting\(''app\.organization_id''/u);
    expect(securitySql).toMatch(/WITH CHECK/u);
    expect(securitySql).toMatch(/ALTER TABLE users FORCE ROW LEVEL SECURITY/u);
    expect(securitySql).toMatch(/users_membership_tenant_select_policy/u);
    expect(securitySql).toMatch(/memberships\.organization_id/u);
  });

  it("prevents normal audit update and delete operations", () => {
    expect(securitySql).toMatch(/audit_events_reject_update_delete/u);
    expect(securitySql).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON audit_events/u);
  });

  it("rejects invalid legacy audit topology before enforcing a linear tenant chain", () => {
    expect(auditChainTopologySql).toMatch(/duplicate tenant event hash/u);
    expect(auditChainTopologySql).toMatch(/forked tenant predecessor/u);
    expect(auditChainTopologySql).toMatch(/exactly one genesis event/u);
    expect(auditChainTopologySql).toMatch(/orphaned predecessor hash/u);
    expect(auditChainTopologySql).toMatch(/unreachable event or disconnected cycle/u);
    expect(auditChainTopologySql).toMatch(
      /CREATE UNIQUE INDEX "audit_events_org_previous_hash_uidx"/u,
    );
    expect(auditChainTopologySql).toMatch(
      /CREATE UNIQUE INDEX "audit_events_org_genesis_uidx".*WHERE "audit_events"\."previous_event_hash" is null/u,
    );
    expect(auditChainTopologySql).toMatch(/audit_events_previous_hash_fk/u);
    expect(auditChainTopologySql).toMatch(/audit_events_hash_version_check/u);
    expect(auditChainTopologySql).toMatch(/audit_events_validate_linear_append/u);
    expect(auditChainTopologySql).toMatch(/pg_advisory_xact_lock/u);
    expect(auditChainTopologySql).toMatch(/predecessor is not the tenant chain head/u);
    expect(auditChainTopologySql).toMatch(
      /REVOKE ALL ON FUNCTION public\.audit_events_validate_linear_append\(\) FROM PUBLIC/u,
    );
  });

  it("uses organization-scoped foreign keys for tenant-owned relationships", () => {
    expect(relationSql).toMatch(
      /FOREIGN KEY \("organization_id","source_event_id"\).*"source_events"\("organization_id","id"\)/u,
    );
    expect(relationSql).toMatch(
      /FOREIGN KEY \("organization_id","proposal_id","proposal_version"\)/u,
    );
  });

  it("forces import RLS and binds accounting events to an immutable import receipt", () => {
    expect(importSecuritySql).toMatch(/ALTER TABLE imports FORCE ROW LEVEL SECURITY/u);
    expect(importSecuritySql).toMatch(/CREATE POLICY imports_tenant_policy/u);
    expect(importSecuritySql).toMatch(/source_events_accounting_import_check/u);
    expect(importSecuritySql).toMatch(/source = 'accounting_csv' AND import_id IS NOT NULL/u);
    expect(importSecuritySql).toMatch(/byte_count > 0 AND byte_count <= 10485760/u);
  });

  it("prevents the application role from rewriting immutable ingestion evidence", () => {
    expect(immutableIngestionSql).toMatch(/source_events_protect_immutable_fields/u);
    expect(immutableIngestionSql).toMatch(/imports_protect_immutable_fields/u);
    expect(immutableIngestionSql).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON canonical_records/u);
    expect(immutableIngestionSql).toMatch(/source event evidence is immutable/u);
  });

  it("tenant-isolates and makes reconciliation occurrences append-only", () => {
    expect(reconciliationHistorySql).toMatch(
      /ALTER TABLE match_occurrences FORCE ROW LEVEL SECURITY/u,
    );
    expect(reconciliationHistorySql).toMatch(/exception_occurrences_tenant_policy/u);
    expect(reconciliationHistorySql).toMatch(/match_occurrences_reject_update_delete/u);
    expect(reconciliationHistorySql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON match_occurrences, exception_occurrences/u,
    );
    expect(reconciliationHistorySql).toMatch(/policy_snapshot_hash ~ '\^\[a-f0-9\]\{64\}\$'/u);
  });

  it("adds rolling-compatible immutable evidence snapshots to reconciliation occurrences", () => {
    expect(reconciliationOccurrenceSnapshotsSql).toMatch(
      /CREATE TABLE public\.match_occurrence_snapshots/u,
    );
    expect(reconciliationOccurrenceSnapshotsSql).toMatch(
      /CREATE TABLE public\.exception_occurrence_snapshots/u,
    );
    expect(reconciliationOccurrenceSnapshotsSql).toMatch(
      /FOREIGN KEY \(organization_id, run_id, match_id\)[\s\S]*REFERENCES public\.match_occurrences/u,
    );
    expect(reconciliationOccurrenceSnapshotsSql).toMatch(
      /FOREIGN KEY \(organization_id, run_id, exception_id\)[\s\S]*REFERENCES public\.exception_occurrences/u,
    );
    expect(reconciliationOccurrenceSnapshotsSql).toMatch(
      /ALTER TABLE public\.match_occurrence_snapshots FORCE ROW LEVEL SECURITY/u,
    );
    expect(reconciliationOccurrenceSnapshotsSql).toMatch(
      /exception_occurrence_snapshots_tenant_policy/u,
    );
    expect(reconciliationOccurrenceSnapshotsSql).toMatch(
      /match_occurrence_snapshots_reject_update_delete/u,
    );
    expect(reconciliationOccurrenceSnapshotsSql).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE[\s\S]*FROM reconai_app/u,
    );
    expect(reconciliationOccurrenceSnapshotsSql).toMatch(
      /GRANT SELECT, INSERT[\s\S]*TO reconai_worker/u,
    );
    expect(reconciliationOccurrenceSnapshotsSql).toMatch(
      /snapshot_version = 'artifact-occurrence-v1'/u,
    );
    expect(reconciliationOccurrenceSnapshotsSql).not.toMatch(
      /ALTER TABLE public\.(?:match|exception)_occurrences\s+ADD/u,
    );
  });

  it("constrains provider secret references and webhook object evidence", () => {
    expect(providerWebhookSecuritySql).toMatch(/connections_credential_reference_check/u);
    expect(providerWebhookSecuritySql).toMatch(/\^env:RECONAI_CONNECTOR_\[A-Z0-9_\]\{1,100\}\$/u);
    expect(providerWebhookSecuritySql).toMatch(/connections_single_credential_storage_check/u);
    expect(providerWebhookSecuritySql).toMatch(/source_events_payload_hash_check/u);
    expect(providerWebhookSecuritySql).toMatch(/source_events_object_key_check/u);
    expect(providerWebhookSecuritySql).toMatch(/privacy_pending/u);
  });

  it("authenticates Shopify privacy requests before narrow tenant resolution", () => {
    expect(providerPrivacyRequestsSql).toMatch(
      /ALTER TABLE provider_privacy_requests FORCE ROW LEVEL SECURITY/u,
    );
    expect(providerPrivacyRequestsSql).toMatch(
      /CREATE POLICY provider_privacy_requests_tenant_policy/u,
    );
    expect(providerPrivacyRequestsSql).toMatch(/reconai_resolve_shopify_privacy_request/u);
    expect(providerPrivacyRequestsSql).toMatch(/SECURITY DEFINER/u);
    expect(providerPrivacyRequestsSql).toMatch(/SET row_security = on/u);
    expect(providerPrivacyRequestsSql).toMatch(/provider_privacy_requests_reject_update_delete/u);
    expect(providerPrivacyRequestsSql).toMatch(/due_at = received_at \+ interval '30 days'/u);
    expect(providerPrivacyRequestsSql).toMatch(
      /Shopify customer references are not permitted in canonical records/u,
    );
    expect(providerPrivacyRequestsSql).toMatch(
      /REVOKE ALL ON provider_privacy_requests FROM reconai_worker/u,
    );
  });

  it("gates checksum-bound Shopify privacy object deletion behind legal holds", () => {
    expect(providerPrivacyObjectDeletionSql).toMatch(
      /provider_privacy_object_deletion_jobs_validate_insert/u,
    );
    expect(providerPrivacyObjectDeletionSql).toMatch(
      /requests\.external_object_ids \? events\.external_object_id/u,
    );
    expect(providerPrivacyObjectDeletionSql).toMatch(
      /ALTER TABLE provider_privacy_object_deletion_jobs FORCE ROW LEVEL SECURITY/u,
    );
    expect(providerPrivacyObjectDeletionSql).toMatch(
      /provider_privacy_object_deletion_tombstones_reject_update_delete/u,
    );
    expect(providerPrivacyObjectDeletionSql).toMatch(/serialize_privacy_deletion_with_legal_hold/u);
    expect(providerPrivacyObjectDeletionSql).toMatch(/pg_advisory_xact_lock/u);
    expect(providerPrivacyObjectDeletionSql).toMatch(
      /coalesce\(policies\.legal_hold_enabled, false\) = false/u,
    );
    expect(providerPrivacyObjectDeletionSql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.reconai_claim_provider_privacy_object_deletion/u,
    );
    expect(
      providerPrivacyObjectDeletionSql.match(
        /WHERE jobs\.organization_id = p_organization_id\s+AND jobs\.id = p_job_id/gu,
      ),
    ).toHaveLength(2);
    expect(providerPrivacyObjectDeletionSql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON\s+provider_privacy_object_deletion_jobs/su,
    );
  });

  it("creates append-only tenant deadline signals through worker-only bounded functions", () => {
    expect(providerPrivacyDeadlineAlertsSql).toMatch(
      /ALTER TABLE provider_privacy_request_deadline_alerts FORCE ROW LEVEL SECURITY/u,
    );
    expect(providerPrivacyDeadlineAlertsSql).toMatch(
      /provider_privacy_request_deadline_alerts_tenant_select_policy/u,
    );
    expect(providerPrivacyDeadlineAlertsSql).toMatch(
      /provider_privacy_request_deadline_alerts_reject_update_delete/u,
    );
    expect(providerPrivacyDeadlineAlertsSql).toMatch(
      /stage IN \('due_7_days', 'due_24_hours', 'overdue'\)/u,
    );
    expect(providerPrivacyDeadlineAlertsSql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.reconai_due_provider_privacy_deadline_alerts/u,
    );
    expect(providerPrivacyDeadlineAlertsSql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.reconai_create_provider_privacy_deadline_alert/u,
    );
    expect(providerPrivacyDeadlineAlertsSql).toMatch(/SECURITY DEFINER/u);
    expect(providerPrivacyDeadlineAlertsSql).toMatch(/SET row_security = on/u);
    expect(providerPrivacyDeadlineAlertsSql).toMatch(
      /v_active_organization_id <> p_organization_id/u,
    );
    expect(providerPrivacyDeadlineAlertsSql).toMatch(
      /ON CONFLICT \(organization_id, request_id, stage\) DO NOTHING/u,
    );
    expect(providerPrivacyDeadlineAlertsSql).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE\s+ON provider_privacy_request_deadline_alerts\s+FROM reconai_app/su,
    );
    expect(providerPrivacyDeadlineAlertsSql).toMatch(
      /REVOKE ALL ON provider_privacy_request_deadline_alerts FROM reconai_worker/u,
    );
    expect(providerPrivacyDeadlineAlertsSql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.reconai_due_provider_privacy_deadline_alerts/u,
    );
  });

  it("records digest-only, expiring, single-use privacy-package browser receipts", () => {
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /CREATE TABLE public\.provider_privacy_data_packages/u,
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /CREATE TABLE public\.provider_privacy_data_package_receipts/u,
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /FOREIGN KEY \(organization_id, request_id\)[\s\S]*REFERENCES public\.provider_privacy_requests \(organization_id, id\)/u,
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /FOREIGN KEY \(organization_id, prepared_by_membership_id\)[\s\S]*REFERENCES public\.memberships \(organization_id, id\)/u,
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /receipt_expires_at = prepared_at \+ interval '10 minutes'/u,
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /receipt_token_sha256 ~ '\^\[a-f0-9\]\{64\}\$'/u,
    );
    expect(providerPrivacyDataPackageReceiptsSql).not.toMatch(
      /\breceipt_token\s+(?:text|varchar|char)/u,
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /ALTER TABLE public\.provider_privacy_data_packages FORCE ROW LEVEL SECURITY/u,
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /ALTER TABLE public\.provider_privacy_data_package_receipts FORCE ROW LEVEL SECURITY/u,
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /provider_privacy_data_packages_reject_update_delete/u,
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /provider_privacy_data_package_receipts_reject_update_delete/u,
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.reconai_acknowledge_provider_privacy_data_package/u,
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(/SECURITY DEFINER/u);
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(/SET search_path = pg_catalog, public/u);
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(/SET row_security = on/u);
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /v_active_organization_id <> p_organization_id/u,
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /packages\.prepared_by_membership_id = p_membership_id/u,
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /packages\.receipt_token_sha256 = p_receipt_token_sha256/u,
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(/memberships\.status = 'active'/u);
    expect(providerPrivacyDataPackageReceiptsSql.indexOf("IF FOUND THEN")).toBeLessThan(
      providerPrivacyDataPackageReceiptsSql.indexOf(
        "p_received_at >= v_package.receipt_expires_at",
      ),
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /CREATE UNIQUE INDEX provider_privacy_data_package_receipts_package_uidx/u,
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /GRANT INSERT ON public\.provider_privacy_data_packages TO reconai_app/u,
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /REVOKE SELECT, UPDATE, DELETE, TRUNCATE ON\s+public\.provider_privacy_data_packages\s+FROM reconai_app/su,
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /REVOKE ALL ON public\.provider_privacy_data_package_receipts FROM reconai_app/u,
    );
    expect(providerPrivacyDataPackageReceiptsSql).toMatch(
      /REVOKE ALL ON public\.provider_privacy_data_packages FROM reconai_worker/u,
    );
  });

  it("separates read API credentials and makes bounded provider sync authority tenant-scoped", () => {
    expect(providerSyncRunsSql).toMatch(/ADD COLUMN api_credential_reference text/u);
    expect(providerSyncRunsSql).toMatch(/\^env:RECONAI_CONNECTOR_\[A-Z0-9_\]\{1,100\}\$/u);
    expect(providerSyncRunsSql).toMatch(/ALTER TABLE provider_sync_runs FORCE ROW LEVEL SECURITY/u);
    expect(providerSyncRunsSql).toMatch(/provider_sync_runs_tenant_policy/u);
    expect(providerSyncRunsSql).toMatch(/window_end - window_start <= interval '30 days'/u);
    expect(providerSyncRunsSql).toMatch(/maximum_pages BETWEEN 1 AND 100/u);
    expect(providerSyncRunsSql).toMatch(/failed_attempts BETWEEN 0 AND 6/u);
    expect(providerSyncRunsSql).toMatch(/provider sync authority is immutable/u);
    expect(providerSyncRunsSql).toMatch(/provider sync runs are append-only/u);
  });

  it("uses a constrained service identity and worker-only scheduled repair functions", () => {
    expect(scheduledProviderGapRepairSql).toMatch(
      /requested_by_service = 'provider-gap-repair-scheduler'/u,
    );
    expect(scheduledProviderGapRepairSql).toMatch(
      /requester_type = 'system'.*requested_by_membership_id IS NULL/su,
    );
    expect(scheduledProviderGapRepairSql).toMatch(
      /CREATE OR REPLACE FUNCTION reconai_due_provider_gap_repairs/u,
    );
    expect(scheduledProviderGapRepairSql).toMatch(
      /CREATE OR REPLACE FUNCTION reconai_create_scheduled_provider_gap_repair/u,
    );
    expect(scheduledProviderGapRepairSql).toMatch(/SECURITY DEFINER/u);
    expect(scheduledProviderGapRepairSql).toMatch(/SET row_security = on/u);
    expect(scheduledProviderGapRepairSql).toMatch(
      /REVOKE ALL ON FUNCTION reconai_due_provider_gap_repairs.*FROM reconai_app/su,
    );
    expect(scheduledProviderGapRepairSql).toMatch(
      /GRANT EXECUTE ON FUNCTION reconai_due_provider_gap_repairs.*TO reconai_worker/su,
    );
    expect(scheduledProviderGapRepairSql).toMatch(
      /REVOKE INSERT, DELETE, TRUNCATE ON provider_sync_runs FROM reconai_worker/u,
    );
    expect(scheduledProviderGapRepairSql).toMatch(
      /p_created_at - p_due_before NOT BETWEEN interval '1 minute' AND interval '1 day'/u,
    );
    expect(scheduledProviderGapRepairSql).toMatch(/p_maximum_pages NOT BETWEEN 1 AND 25/u);
  });

  it("tenant-isolates encrypted connector credentials and enforces append-only retirement", () => {
    expect(connectorCredentialLifecycleSql).toMatch(
      /ALTER TABLE connector_credentials FORCE ROW LEVEL SECURITY/u,
    );
    expect(connectorCredentialLifecycleSql).toMatch(
      /CREATE POLICY connector_credentials_tenant_policy/u,
    );
    expect(connectorCredentialLifecycleSql).toMatch(
      /organization_id = nullif\(current_setting\('app\.organization_id'/u,
    );
    expect(connectorCredentialLifecycleSql).toMatch(/connector_credentials_active_purpose_uidx/u);
    expect(connectorCredentialLifecycleSql).toMatch(
      /connector credential authority and ciphertext are immutable/u,
    );
    expect(connectorCredentialLifecycleSql).toMatch(
      /connector credential evidence is append-only/u,
    );
    expect(connectorCredentialLifecycleSql).toMatch(
      /connector credential provider does not match its connection/u,
    );
    expect(connectorCredentialLifecycleSql).toMatch(
      /retired connector credential remains referenced by its connection/u,
    );
    expect(connectorCredentialLifecycleSql).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON connector_credentials FROM reconai_worker/u,
    );
    expect(connectorCredentialLifecycleSql).toMatch(/\^\(env:RECONAI_CONNECTOR_.*\|sealed:/su);
  });

  it("stores only hashed provider state and enforces one append-only callback lifecycle", () => {
    expect(providerAuthorizationLifecycleSql).toMatch(
      /ALTER TABLE provider_authorization_attempts FORCE ROW LEVEL SECURITY/u,
    );
    expect(providerAuthorizationLifecycleSql).toMatch(
      /provider_authorization_attempts_state_check/u,
    );
    expect(providerAuthorizationLifecycleSql).toMatch(
      /provider_authorization_attempts_active_connection_uidx/u,
    );
    expect(providerAuthorizationLifecycleSql).toMatch(
      /status IN \('pending', 'exchanging', 'succeeded', 'denied', 'failed', 'expired'\)/u,
    );
    expect(providerAuthorizationLifecycleSql).toMatch(
      /provider authorization authority is immutable/u,
    );
    expect(providerAuthorizationLifecycleSql).toMatch(
      /provider authorization evidence is append-only/u,
    );
    expect(providerAuthorizationLifecycleSql).toMatch(
      /REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE\s+ON provider_authorization_attempts FROM reconai_worker/su,
    );
  });

  it("serializes OAuth refresh and exposes only fixed worker rotation functions", () => {
    expect(oauthCredentialRefreshSql).toMatch(/created_by_service = 'provider-token-refresh-v1'/u);
    expect(oauthCredentialRefreshSql).toMatch(
      /CREATE OR REPLACE FUNCTION reconai_lock_oauth_credential/u,
    );
    expect(oauthCredentialRefreshSql).toMatch(
      /CREATE OR REPLACE FUNCTION reconai_rotate_oauth_credential/u,
    );
    expect(oauthCredentialRefreshSql).toMatch(/FOR UPDATE OF connections, credentials/u);
    expect(oauthCredentialRefreshSql).toMatch(/SECURITY DEFINER/u);
    expect(oauthCredentialRefreshSql).toMatch(/SET search_path = pg_catalog, public/u);
    expect(oauthCredentialRefreshSql).toMatch(/SET row_security = on/u);
    expect(oauthCredentialRefreshSql).toMatch(/v_active_organization_id <> p_organization_id/u);
    expect(oauthCredentialRefreshSql).toMatch(
      /REVOKE ALL ON FUNCTION reconai_rotate_oauth_credential[\s\S]*FROM PUBLIC/u,
    );
    expect(oauthCredentialRefreshSql).toMatch(
      /GRANT EXECUTE ON FUNCTION reconai_rotate_oauth_credential[\s\S]*TO reconai_worker/u,
    );
    expect(oauthCredentialRefreshSql).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE\s+ON connector_credentials FROM reconai_worker/su,
    );
  });

  it("tenant-isolates provider deauthorization evidence and narrowly resolves signed Stripe events", () => {
    expect(providerConfirmedDisconnectSql).toMatch(
      /ALTER TABLE provider_deauthorization_events FORCE ROW LEVEL SECURITY/u,
    );
    expect(providerConfirmedDisconnectSql).toMatch(
      /provider_deauthorization_events_tenant_policy/u,
    );
    expect(providerConfirmedDisconnectSql).toMatch(
      /provider deauthorization events are append-only/u,
    );
    expect(providerConfirmedDisconnectSql).toMatch(
      /connections\.external_account_id = NEW\.external_account_id/u,
    );
    expect(providerConfirmedDisconnectSql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.reconai_resolve_stripe_deauthorization/u,
    );
    expect(providerConfirmedDisconnectSql).toMatch(/SECURITY DEFINER/u);
    expect(providerConfirmedDisconnectSql).toMatch(/SET search_path = pg_catalog, public/u);
    expect(providerConfirmedDisconnectSql).toMatch(/SET row_security = on/u);
    expect(providerConfirmedDisconnectSql).toMatch(
      /connections\.provider = 'stripe'[\s\S]*connections\.external_account_id = p_external_account_id/u,
    );
    expect(providerConfirmedDisconnectSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.reconai_resolve_stripe_deauthorization\(text\) FROM PUBLIC/u,
    );
    expect(providerConfirmedDisconnectSql).toMatch(
      /REVOKE ALL ON provider_deauthorization_events FROM reconai_worker/u,
    );
  });

  it("exposes cross-tenant outbox recovery only to the worker role under forced RLS", () => {
    expect(outboxRelaySecuritySql).toMatch(/SECURITY DEFINER/u);
    expect(outboxRelaySecuritySql).toMatch(/SET search_path = pg_catalog, public/u);
    expect(outboxRelaySecuritySql).toMatch(/SET row_security = off/u);
    expect(outboxRelaySecuritySql).toMatch(
      /REVOKE ALL ON FUNCTION reconai_pending_outbox\(integer\) FROM reconai_app/u,
    );
    expect(outboxRelaySecuritySql).toMatch(
      /GRANT EXECUTE ON FUNCTION reconai_pending_outbox\(integer\) TO reconai_worker/u,
    );
    expect(outboxRelaySecuritySql).toMatch(/dead_lettered_at/u);
    expect(reconciliationExecutionSecuritySql).toMatch(/outbox_events_relay_owner_policy/u);
    expect(reconciliationExecutionSecuritySql).toMatch(
      /ALTER FUNCTION reconai_pending_outbox\(integer\) SET row_security = on/u,
    );
  });

  it("classifies queue recovery from a tenant ledger without guessing legacy published work", () => {
    expect(durableJobExecutionLedgerSql).toMatch(
      /ALTER TABLE job_executions FORCE ROW LEVEL SECURITY/u,
    );
    expect(durableJobExecutionLedgerSql).toMatch(
      /ALTER TABLE queue_recovery_events FORCE ROW LEVEL SECURITY/u,
    );
    expect(durableJobExecutionLedgerSql).toMatch(/job execution authority is immutable/u);
    expect(durableJobExecutionLedgerSql).toMatch(/terminal job execution is immutable/u);
    expect(durableJobExecutionLedgerSql).toMatch(/queue recovery events are append-only/u);
    expect(durableJobExecutionLedgerSql).toMatch(/reconai_begin_job_execution/u);
    expect(durableJobExecutionLedgerSql).toMatch(/reconai_recoverable_queue_events/u);
    expect(durableJobExecutionLedgerSql).toMatch(
      /current_setting\('app\.execution_tracking_version', true\) = '1'/u,
    );
    expect(durableJobExecutionLedgerSql).not.toMatch(/execution_tracking_version" SET DEFAULT/u);
    expect(durableJobExecutionLedgerSql).toMatch(
      /execution\.id IS NULL[\s\S]*event\.execution_tracking_version = 1/u,
    );
    expect(durableJobExecutionLedgerSql).toMatch(
      /event\.execution_tracking_version IS NULL[\s\S]*execution\.id IS NULL/u,
    );
    expect(durableJobExecutionLedgerSql).toMatch(
      /requested_stale_before > statement_timestamp\(\) - interval '15 minutes'/u,
    );
    expect(durableJobExecutionLedgerSql).toMatch(
      /REVOKE ALL ON job_executions, queue_recovery_events FROM reconai_app/u,
    );
    expect(durableJobExecutionLedgerSql).toMatch(
      /GRANT EXECUTE ON FUNCTION reconai_record_queue_recovery\([\s\S]*TO reconai_worker/u,
    );
  });

  it("tenant-isolates and prevents mutation of canonical field provenance", () => {
    expect(canonicalProvenanceSecuritySql).toMatch(
      /ALTER TABLE canonical_field_provenance FORCE ROW LEVEL SECURITY/u,
    );
    expect(canonicalProvenanceSecuritySql).toMatch(/canonical_field_provenance_tenant_policy/u);
    expect(canonicalProvenanceSecuritySql).toMatch(
      /canonical_field_provenance_reject_update_delete/u,
    );
    expect(canonicalProvenanceSecuritySql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON canonical_field_provenance/u,
    );
  });

  it("constrains review policy and preserves proposal and approval evidence", () => {
    expect(reviewPolicySecuritySql).toMatch(/organizations_dual_approval_thresholds_check/u);
    expect(reviewPolicySecuritySql).toMatch(/resolution_proposals_required_approvals_check/u);
    expect(reviewPolicySecuritySql).toMatch(/resolution_proposals_protect_evidence/u);
    expect(reviewPolicySecuritySql).toMatch(/approvals_reject_update_delete/u);
    expect(reviewPolicySecuritySql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON approvals FROM reconai_app/u,
    );
  });

  it("constrains membership roles and connector health states", () => {
    expect(accessHealthConstraintsSql).toMatch(/memberships_role_check/u);
    expect(accessHealthConstraintsSql).toMatch(/'owner', 'administrator'/u);
    expect(accessHealthConstraintsSql).toMatch(/connections_status_check/u);
    expect(accessHealthConstraintsSql).toMatch(/'action_required'/u);
  });

  it("tenant-isolates and prevents mutation of internal exception notes", () => {
    expect(exceptionNotesSecuritySql).toMatch(
      /ALTER TABLE exception_notes FORCE ROW LEVEL SECURITY/u,
    );
    expect(exceptionNotesSecuritySql).toMatch(/exception_notes_tenant_policy/u);
    expect(exceptionNotesSecuritySql).toMatch(/exception_notes_reject_update_delete/u);
    expect(exceptionNotesSecuritySql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON exception_notes FROM reconai_app/u,
    );
  });

  it("pins run authority and confines recovery mutation to a fixed tenant-checked function", () => {
    expect(reconciliationExecutionSecuritySql).toMatch(
      /ALTER TABLE reconciliation_run_inputs FORCE ROW LEVEL SECURITY/u,
    );
    expect(reconciliationExecutionSecuritySql).toMatch(
      /reconciliation_run_inputs_reject_update_delete/u,
    );
    expect(reconciliationExecutionSecuritySql).toMatch(
      /reconciliation run authority is immutable/u,
    );
    expect(reconciliationExecutionSecuritySql).toMatch(/reconai_requeue_reconciliation_run/u);
    expect(reconciliationExecutionSecuritySql).toMatch(
      /active_organization_id <> requested_organization_id/u,
    );
    expect(reconciliationExecutionSecuritySql).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON reconciliation_runs FROM reconai_worker/u,
    );
    expect(reconciliationExecutionSecuritySql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON reconciliation_runs FROM reconai_app/u,
    );
  });

  it("binds single-use invitations to verified identity under fixed database authority", () => {
    expect(organizationInvitationSecuritySql).toMatch(
      /ALTER TABLE organization_invitations FORCE ROW LEVEL SECURITY/u,
    );
    expect(organizationInvitationSecuritySql).toMatch(
      /organization_invitations_pending_email_uidx/u,
    );
    expect(organizationInvitationSecuritySql).toMatch(
      /organization invitation authority is immutable/u,
    );
    expect(organizationInvitationSecuritySql).toMatch(/reconai_accept_organization_invitation/u);
    expect(organizationInvitationSecuritySql).toMatch(
      /invitations\.token_sha256 = p_token_sha256/u,
    );
    expect(organizationInvitationSecuritySql).toMatch(/invitations\.email = p_email/u);
    expect(organizationInvitationSecuritySql).toMatch(
      /status = 'accepted'.*accepted_by_user_id IS NOT NULL/su,
    );
    expect(organizationInvitationSecuritySql).toMatch(
      /REVOKE ALL ON organization_invitations FROM reconai_worker/u,
    );
    const applicationSelectGrant =
      /GRANT SELECT \([\s\S]*?\) ON organization_invitations TO reconai_app/u.exec(
        organizationInvitationSecuritySql,
      )?.[0];
    expect(applicationSelectGrant).toBeDefined();
    expect(applicationSelectGrant).not.toMatch(/token_sha256/u);
    expect(organizationInvitationSecuritySql).toMatch(
      /p_role = 'owner' AND v_actor_role <> 'owner'/u,
    );
    expect(organizationInvitationSecuritySql).toMatch(
      /REVOKE ALL ON FUNCTION reconai_accept_organization_invitation\([\s\S]*FROM PUBLIC/u,
    );
    expect(invitationAcceptanceQualificationSql).toMatch(
      /memberships\.organization_id = v_invitation\.organization_id/u,
    );
    expect(invitationAcceptanceQualificationSql).toMatch(/memberships\.user_id = v_user\.id/u);
  });

  it("indexes the stable exception queue order and exact type lookup", () => {
    expect(exceptionQueuePaginationSql).toMatch(
      /CASE "severity" WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END/u,
    );
    expect(exceptionQueuePaginationSql).toMatch(/"created_at",\s*"id"/u);
    expect(exceptionQueuePaginationSql).toMatch(
      /"exceptions_org_type_idx"[\s\S]*"organization_id", "type"/u,
    );
  });

  it("builds the oldest-unresolved observer index online through a restart-safe migration path", () => {
    expect(exceptionQueueObservabilityIndexSql).toMatch(/^-- reconai:non-transactional\n/u);
    expect(exceptionQueueObservabilityIndexSql).toMatch(
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS "exceptions_unresolved_oldest_idx"/u,
    );
    expect(exceptionQueueObservabilityIndexSql).toMatch(
      /"created_at", "id"[\s\S]*WHERE "status" IN \('open', 'assigned', 'deferred', 'proposed', 'rejected'\)/u,
    );
    expect(migrationRunnerSource).toMatch(/contents\.startsWith\(nonTransactionalDirective\)/u);
    expect(migrationRunnerSource).toMatch(
      /await sql\.unsafe\(contents\);[\s\S]*insert into reconai_schema_migrations/u,
    );
    expect(migrationRunnerSource).toMatch(/index_metadata\.indisvalid/u);
    expect(migrationRunnerSource).toMatch(/index_metadata\.indisready/u);
    expect(migrationRunnerSource).toMatch(
      /concurrent index is not ready and valid; migration remains unapplied/u,
    );
    expect(migrationValidatorSource).toMatch(
      /non-transactional migrations are restricted to one named restart-safe concurrent index/u,
    );
    expect(migrationValidatorSource).toMatch(
      /non-transactional migration must contain exactly one SQL statement/u,
    );
  });

  it("gives only the worker an identifier-free oldest-unresolved observation function", () => {
    expect(exceptionQueueObservabilityAuthoritySql).toMatch(
      /CREATE POLICY exceptions_observability_migrator_policy/u,
    );
    expect(exceptionQueueObservabilityAuthoritySql).toMatch(
      /CREATE OR REPLACE FUNCTION reconai_observe_exception_queue\(\)/u,
    );
    expect(exceptionQueueObservabilityAuthoritySql).toMatch(/SECURITY DEFINER/u);
    expect(exceptionQueueObservabilityAuthoritySql).toMatch(
      /SET search_path = pg_catalog, public/u,
    );
    expect(exceptionQueueObservabilityAuthoritySql).toMatch(/SET row_security = on/u);
    expect(exceptionQueueObservabilityAuthoritySql).toMatch(
      /ORDER BY exceptions\.created_at, exceptions\.id[\s\S]*LIMIT 1/u,
    );
    expect(exceptionQueueObservabilityAuthoritySql).toMatch(
      /REVOKE ALL ON FUNCTION reconai_observe_exception_queue\(\) FROM PUBLIC/u,
    );
    expect(exceptionQueueObservabilityAuthoritySql).toMatch(
      /REVOKE ALL ON FUNCTION reconai_observe_exception_queue\(\) FROM reconai_app/u,
    );
    expect(exceptionQueueObservabilityAuthoritySql).toMatch(
      /GRANT EXECUTE ON FUNCTION reconai_observe_exception_queue\(\) TO reconai_worker/u,
    );
    expect(exceptionQueueObservabilityAuthoritySql).not.toMatch(
      /organization_id|exception_id|stable_key|amount_minor|currency/u,
    );
  });

  it("builds the provider active-sync lookup online over exact active states", () => {
    expect(providerActiveSyncObservabilityIndexSql).toMatch(/^-- reconai:non-transactional\n/u);
    expect(providerActiveSyncObservabilityIndexSql).toMatch(
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS "provider_sync_runs_active_oldest_idx"/u,
    );
    expect(providerActiveSyncObservabilityIndexSql).toMatch(
      /"provider", "created_at", "id"[\s\S]*WHERE "status" IN \('queued', 'running'\)/u,
    );
  });

  it("builds the tenant connection object-watermark lookup online", () => {
    expect(sourceEventObjectWatermarkIndexSql).toMatch(/^-- reconai:non-transactional\n/u);
    expect(sourceEventObjectWatermarkIndexSql).toMatch(
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS "source_events_org_connection_object_watermark_idx"/u,
    );
    expect(sourceEventObjectWatermarkIndexSql).toMatch(
      /"organization_id", "connection_id", "external_object_type", "source_timestamp" DESC, "received_at" DESC/u,
    );
  });

  it("classifies source-event families separately from provider topics and fails legacy gaps closed", () => {
    expect(sourceEventObjectClassificationsSql).toMatch(
      /CREATE TABLE public\.source_event_object_classifications/u,
    );
    expect(sourceEventObjectClassificationsSql).toMatch(
      /PRIMARY KEY \(organization_id, source_event_id\)/u,
    );
    expect(sourceEventObjectClassificationsSql).toMatch(
      /FOREIGN KEY \(organization_id, source_event_id\)[\s\S]*REFERENCES public\.source_events \(organization_id, id\)/u,
    );
    for (const exactFamilies of [
      "ARRAY['order']::text[]",
      "ARRAY['refund_transaction']::text[]",
      "ARRAY['order', 'refund_transaction']::text[]",
      "ARRAY['payment_intent']::text[]",
      "ARRAY['refund']::text[]",
      "ARRAY['balance_transaction']::text[]",
      "ARRAY['csv_row']::text[]",
    ]) {
      expect(sourceEventObjectClassificationsSql).toContain(`object_families = ${exactFamilies}`);
    }
    expect(sourceEventObjectClassificationsSql).not.toMatch(
      /INSERT INTO public\.source_event_object_classifications/u,
    );
    expect(sourceEventObjectClassificationsSql).toMatch(
      /read model reports classification_unavailable/u,
    );
    expect(sourceEventObjectClassificationsSql).toMatch(
      /ALTER TABLE public\.source_event_object_classifications FORCE ROW LEVEL SECURITY/u,
    );
    expect(sourceEventObjectClassificationsSql).toMatch(
      /source_event_object_classifications_tenant_policy/u,
    );
    expect(sourceEventObjectClassificationsSql).toMatch(
      /source_event_object_classifications_reject_update_delete/u,
    );
    expect(sourceEventObjectClassificationsSql).toMatch(
      /GRANT SELECT, INSERT ON public\.source_event_object_classifications TO reconai_app/u,
    );
    expect(sourceEventObjectClassificationsSql).toMatch(
      /GRANT SELECT, INSERT ON public\.source_event_object_classifications TO reconai_worker/u,
    );
  });

  it("restricts bounded source-classification repair to a dedicated maintenance role", () => {
    expect(sourceEventClassificationRepairAuthoritySql).toMatch(
      /reconai_maintenance role is required before migration 0051/u,
    );
    expect(sourceEventClassificationRepairAuthoritySql).toMatch(
      /CREATE POLICY source_events_classification_repair_owner_policy[\s\S]*FOR UPDATE[\s\S]*TO reconai_migrator[\s\S]*current_user = 'reconai_migrator'/u,
    );
    expect(sourceEventClassificationRepairAuthoritySql).toMatch(
      /CREATE POLICY source_event_object_classifications_repair_owner_policy[\s\S]*FOR SELECT[\s\S]*TO reconai_migrator[\s\S]*current_user = 'reconai_migrator'/u,
    );
    expect(sourceEventClassificationRepairAuthoritySql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.reconai_claim_source_event_classification_repair_candidate\(\)/u,
    );
    expect(sourceEventClassificationRepairAuthoritySql).toMatch(
      /ORDER BY[\s\S]*source_events\.payload_object_key[\s\S]*LIMIT 1[\s\S]*FOR UPDATE OF source_events SKIP LOCKED/u,
    );
    expect(sourceEventClassificationRepairAuthoritySql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.reconai_source_event_classification_repair_gap_counts\(\)/u,
    );
    expect(sourceEventClassificationRepairAuthoritySql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.reconai_prepare_source_event_classification_repair_audit/u,
    );
    expect(sourceEventClassificationRepairAuthoritySql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.reconai_record_source_event_classification_repair/u,
    );
    expect(sourceEventClassificationRepairAuthoritySql).toMatch(
      /payload_object_key = p_payload_object_key[\s\S]*payload_sha256::text = p_payload_sha256/u,
    );
    expect(sourceEventClassificationRepairAuthoritySql).toMatch(
      /p_event_type = 'orders\/snapshot'[\s\S]*ARRAY\['order', 'refund_transaction'\]::text\[\]/u,
    );
    expect(sourceEventClassificationRepairAuthoritySql).toMatch(/'source-object-family-v1'/u);
    expect(sourceEventClassificationRepairAuthoritySql).toMatch(
      /REVOKE ALL ON[\s\S]*public\.source_events,[\s\S]*public\.source_event_object_classifications,[\s\S]*public\.audit_events[\s\S]*FROM reconai_maintenance/u,
    );
    expect(sourceEventClassificationRepairAuthoritySql).toMatch(
      /INSERT INTO public\.audit_events[\s\S]*'source_event\.classification_repaired'[\s\S]*'source-object-family-repair-v1'/u,
    );
    expect(sourceEventClassificationRepairAuthoritySql).toMatch(
      /FROM reconai_app, reconai_worker/u,
    );
    expect(sourceEventClassificationRepairAuthoritySql).toMatch(/TO reconai_maintenance/u);
  });

  it("installs a one-way maintenance-activated source-classification writer fence", () => {
    expect(sourceEventClassificationWriterFenceSql).toMatch(
      /reconai_maintenance role is required before migration 0052/u,
    );
    expect(sourceEventClassificationWriterFenceSql).toMatch(
      /CREATE TABLE public\.source_event_classification_writer_fence_activations/u,
    );
    expect(sourceEventClassificationWriterFenceSql).toMatch(
      /CHECK \(singleton\)[\s\S]*UNIQUE \(singleton\)/u,
    );
    expect(sourceEventClassificationWriterFenceSql).toMatch(
      /source_event_classification_writer_fence_reject_update_delete[\s\S]*BEFORE UPDATE OR DELETE/u,
    );
    expect(sourceEventClassificationWriterFenceSql).toMatch(
      /source_events_classification_writer_fence_shared_lock[\s\S]*BEFORE INSERT ON public\.source_events/u,
    );
    expect(sourceEventClassificationWriterFenceSql).toMatch(
      /pg_advisory_xact_lock_shared\([\s\S]*reconai:source-event-classification-writer-fence:v1/u,
    );
    expect(sourceEventClassificationWriterFenceSql).toMatch(
      /source_events_require_classification_when_fenced[\s\S]*DEFERRABLE INITIALLY DEFERRED/u,
    );
    expect(sourceEventClassificationWriterFenceSql).toMatch(
      /source_events_classification_writer_fence_activation_owner_policy[\s\S]*FOR SELECT[\s\S]*TO reconai_migrator[\s\S]*session_user = 'reconai_maintenance'/u,
    );
    expect(sourceEventClassificationWriterFenceSql).toMatch(
      /reconai_activate_source_event_classification_writer_fence[\s\S]*ENABLE-SOURCE-CLASSIFICATION-WRITER-FENCE/u,
    );
    expect(sourceEventClassificationWriterFenceSql).toMatch(
      /session_user <> 'reconai_maintenance'[\s\S]*ERRCODE = '42501'/u,
    );
    expect(sourceEventClassificationWriterFenceSql).toMatch(
      /pg_advisory_xact_lock\([\s\S]*reconai:source-event-classification-writer-fence:v1/u,
    );
    expect(sourceEventClassificationWriterFenceSql).toMatch(
      /events\.external_object_type NOT IN \([\s\S]*'customers\/data_request'[\s\S]*'customers\/redact'[\s\S]*'shop\/redact'/u,
    );
    expect(sourceEventClassificationWriterFenceSql).toMatch(
      /events\.external_object_type = 'orders\/snapshot'[\s\S]*ARRAY\['order', 'refund_transaction'\]::text\[\]/u,
    );
    expect(sourceEventClassificationWriterFenceSql).toMatch(
      /source event classification writer fence activation requires zero compatible gaps/u,
    );
    expect(sourceEventClassificationWriterFenceSql).toMatch(
      /REVOKE ALL ON public\.source_event_classification_writer_fence_activations[\s\S]*FROM reconai_app, reconai_worker, reconai_maintenance/u,
    );
    expect(sourceEventClassificationWriterFenceSql).toMatch(
      /reconai_activate_source_event_classification_writer_fence\(uuid, text, text, text\)[\s\S]*TO reconai_maintenance/u,
    );
    expect(sourceEventClassificationWriterFenceSql).not.toMatch(
      /disable_source_event_classification_writer_fence|DELETE FROM public\.source_event_classification_writer_fence_activations/u,
    );
  });

  it("keeps restricted support diagnostics tenant-approved, expiring, and function-only", () => {
    expect(restrictedSupportAccessSql).toMatch(/CREATE TABLE public\.support_access_requests/u);
    expect(restrictedSupportAccessSql).toMatch(/CREATE TABLE public\.support_access_grants/u);
    expect(restrictedSupportAccessSql).toMatch(
      /support_access_requests_expiry_check[\s\S]*created_at \+ interval '15 minutes'/u,
    );
    expect(restrictedSupportAccessSql).toMatch(
      /support_access_grants_duration_check[\s\S]*interval '5 minutes'[\s\S]*interval '60 minutes'/u,
    );
    expect(restrictedSupportAccessSql).toMatch(
      /memberships\.role = 'owner'[\s\S]*memberships\.status = 'active'[\s\S]*users\.status = 'active'/u,
    );
    expect(restrictedSupportAccessSql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.reconai_support_diagnostics/u,
    );
    expect(restrictedSupportAccessSql).toMatch(
      /grants\.support_identity_digest = p_support_identity_digest[\s\S]*grants\.status = 'active'[\s\S]*grants\.expires_at > statement_timestamp/u,
    );
    expect(restrictedSupportAccessSql).toMatch(
      /REVOKE ALL ON public\.support_access_requests FROM reconai_app/u,
    );
    expect(restrictedSupportAccessSql).toMatch(
      /REVOKE ALL ON public\.support_access_grants FROM reconai_app/u,
    );
    expect(restrictedSupportAccessSql).toMatch(
      /reconai_support_diagnostics\([\s\S]*TO reconai_app/u,
    );
    expect(restrictedSupportAccessSql).toMatch(
      /REVOKE ALL ON public\.support_access_requests FROM reconai_worker/u,
    );
    expect(restrictedSupportAccessSql).not.toMatch(
      /external_account_id|amount_minor|normalized_data|payload/u,
    );
    expect(supportAccessRequestGrantIntegritySql).toMatch(
      /FOREIGN KEY \(claimed_organization_id, claimed_grant_id\)[\s\S]*REFERENCES public\.support_access_grants \(organization_id, id\)/u,
    );
  });

  it("adds a positive organization profile version for optimistic mutation authority", () => {
    expect(organizationProfileVersionSql).toMatch(
      /ADD COLUMN profile_version integer NOT NULL DEFAULT 1/u,
    );
    expect(organizationProfileVersionSql).toMatch(
      /organizations_profile_version_check\s+CHECK \(profile_version > 0\)/u,
    );
    expect(organizationProfileVersionSql).toMatch(/CHECK \(profile_version > 0\)\s+NOT VALID/u);
    expect(organizationProfileVersionSql).toMatch(
      /VALIDATE CONSTRAINT organizations_profile_version_check/u,
    );
  });

  it("gives only the worker a fixed two-provider active-sync observation function", () => {
    expect(providerActiveSyncObservabilityAuthoritySql).toMatch(
      /CREATE OR REPLACE FUNCTION reconai_observe_provider_active_syncs\(\)/u,
    );
    expect(providerActiveSyncObservabilityAuthoritySql).toMatch(/SECURITY DEFINER/u);
    expect(providerActiveSyncObservabilityAuthoritySql).toMatch(
      /SET search_path = pg_catalog, public/u,
    );
    expect(providerActiveSyncObservabilityAuthoritySql).toMatch(/SET row_security = on/u);
    expect(providerActiveSyncObservabilityAuthoritySql).toMatch(
      /\('shopify'::public\.source_system\),[\s\S]*\('stripe'::public\.source_system\)/u,
    );
    expect(providerActiveSyncObservabilityAuthoritySql).toMatch(
      /runs\.status IN \('queued', 'running'\)[\s\S]*ORDER BY runs\.created_at, runs\.id[\s\S]*LIMIT 1/u,
    );
    expect(providerActiveSyncObservabilityAuthoritySql).toMatch(
      /REVOKE ALL ON FUNCTION reconai_observe_provider_active_syncs\(\) FROM PUBLIC/u,
    );
    expect(providerActiveSyncObservabilityAuthoritySql).toMatch(
      /REVOKE ALL ON FUNCTION reconai_observe_provider_active_syncs\(\) FROM reconai_app/u,
    );
    expect(providerActiveSyncObservabilityAuthoritySql).toMatch(
      /GRANT EXECUTE ON FUNCTION reconai_observe_provider_active_syncs\(\) TO reconai_worker/u,
    );
    expect(providerActiveSyncObservabilityAuthoritySql).not.toMatch(
      /organization_id|connection_id|run_id|correlation_id|cursor|last_error_code|item_count|amount_minor|currency/u,
    );
  });

  it("records immutable exception lifecycle transitions and guards run authority", () => {
    expect(reconciliationRunAuthoritySchemaSql).toMatch(/CREATE TABLE "exception_status_events"/u);
    expect(reconciliationRunAuthoritySchemaSql).toMatch(/"operational_state_applied" boolean/u);
    expect(reconciliationRunAuthoritySecuritySql).toMatch(
      /ALTER TABLE exception_status_events FORCE ROW LEVEL SECURITY/u,
    );
    expect(reconciliationRunAuthoritySecuritySql).toMatch(
      /exception_status_events_reject_update_delete/u,
    );
    expect(reconciliationRunAuthoritySecuritySql).toMatch(/ORDER BY created_at DESC, id DESC/u);
    expect(reconciliationRunAuthoritySecuritySql).toMatch(
      /reconciliation_runs_one_operational_authority_uidx/u,
    );
    expect(reconciliationRunAuthoritySecuritySql).toMatch(
      /operational_state_applied = false OR status = 'succeeded'/u,
    );
    expect(reconciliationRunAuthoritySecuritySql).toMatch(
      /OLD\.operational_state_applied = false[\s\S]*NEW\.operational_state_applied = true/u,
    );
    expect(reconciliationRunAuthoritySecuritySql).toMatch(/operational_state_applied = false/u);
    expect(reconciliationRunAuthoritySecuritySql).toMatch(
      /GRANT SELECT, INSERT ON exception_status_events TO reconai_worker/u,
    );
  });

  it("tenant-isolates import rollback evidence and makes supersession append-only", () => {
    expect(importRollbackSecuritySql).toMatch(
      /ALTER TABLE canonical_record_supersessions FORCE ROW LEVEL SECURITY/u,
    );
    expect(importRollbackSecuritySql).toMatch(/canonical_record_supersessions_tenant_policy/u);
    expect(importRollbackSecuritySql).toMatch(
      /canonical_record_supersessions_reject_update_delete/u,
    );
    expect(importRollbackSecuritySql).toMatch(/a rolled-back import is terminal/u);
    expect(importRollbackSecuritySql).toMatch(
      /a rolled-back import cannot create new canonical versions/u,
    );
    expect(importRollbackSecuritySql).toMatch(/FOR SHARE OF imports/u);
    expect(importRollbackSecuritySql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON canonical_record_supersessions FROM reconai_app/u,
    );
    expect(importRollbackSecuritySql).toMatch(/imports_rollback_state_check/u);
  });

  it("exposes only a bounded identity-derived organization directory to the app role", () => {
    expect(organizationAccessDirectorySql).toMatch(/SECURITY DEFINER/u);
    expect(organizationAccessDirectorySql).toMatch(/SET search_path = pg_catalog, public/u);
    expect(organizationAccessDirectorySql).toMatch(/SET row_security = on/u);
    expect(organizationAccessDirectorySql).toMatch(/users\.issuer = p_issuer/u);
    expect(organizationAccessDirectorySql).toMatch(/users\.subject = p_subject/u);
    expect(organizationAccessDirectorySql).toMatch(/memberships\.status = 'active'/u);
    expect(organizationAccessDirectorySql).toMatch(/organizations\.status = 'active'/u);
    expect(organizationAccessDirectorySql).toMatch(/LIMIT 101/u);
    expect(organizationAccessDirectorySql).toMatch(
      /REVOKE ALL ON FUNCTION public\.reconai_list_active_organizations\(text, text\) FROM PUBLIC/u,
    );
    expect(organizationAccessDirectorySql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.reconai_list_active_organizations\(text, text\)[\s\S]*TO reconai_app/u,
    );
  });

  it("adds literal-search keyset pagination without removing rolling-image compatibility", () => {
    expect(paginatedOrganizationAccessDirectorySql).toMatch(/SECURITY DEFINER/u);
    expect(paginatedOrganizationAccessDirectorySql).toMatch(
      /SET search_path = pg_catalog, public/u,
    );
    expect(paginatedOrganizationAccessDirectorySql).toMatch(/SET row_security = on/u);
    expect(paginatedOrganizationAccessDirectorySql).toMatch(/users\.issuer = p_issuer/u);
    expect(paginatedOrganizationAccessDirectorySql).toMatch(/users\.subject = p_subject/u);
    expect(paginatedOrganizationAccessDirectorySql).toMatch(
      /organizations\.id = p_organization_id/u,
    );
    expect(paginatedOrganizationAccessDirectorySql).toMatch(/p_limit BETWEEN 1 AND 101/u);
    expect(paginatedOrganizationAccessDirectorySql).toMatch(
      /replace\([\s\S]*replace\([\s\S]*replace\(p_search/u,
    );
    expect(paginatedOrganizationAccessDirectorySql).toMatch(/ESCAPE E'\\\\'/u);
    expect(paginatedOrganizationAccessDirectorySql).toMatch(
      /lower\(organizations\.name\) COLLATE "C" > p_after_name COLLATE "C"/u,
    );
    expect(paginatedOrganizationAccessDirectorySql).toMatch(
      /REVOKE ALL ON FUNCTION public\.reconai_list_active_organization_page\(/u,
    );
    expect(paginatedOrganizationAccessDirectorySql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.reconai_list_active_organization_page\([\s\S]*TO reconai_app/u,
    );
    expect(paginatedOrganizationAccessDirectorySql).not.toMatch(
      /DROP FUNCTION public\.reconai_list_active_organizations/u,
    );
  });

  it("confines idempotent first-organization bootstrap to a verified identity function", () => {
    expect(organizationBootstrapSql).toMatch(
      /ALTER TABLE public\.organization_bootstrap_requests FORCE ROW LEVEL SECURITY/u,
    );
    expect(organizationBootstrapSql).toMatch(
      /organization_bootstrap_requests_reject_update_delete/u,
    );
    expect(organizationBootstrapSql).toMatch(/SECURITY DEFINER/u);
    expect(organizationBootstrapSql).toMatch(/SET search_path = pg_catalog, public/u);
    expect(organizationBootstrapSql).toMatch(/SET row_security = on/u);
    expect(organizationBootstrapSql).toMatch(/pg_advisory_xact_lock/u);
    expect(organizationBootstrapSql).toMatch(/users\.issuer = p_issuer/u);
    expect(organizationBootstrapSql).toMatch(/users\.subject = p_subject/u);
    expect(organizationBootstrapSql).toMatch(/pg_catalog\.pg_timezone_names/u);
    expect(organizationBootstrapSql).toMatch(/p_email ~ '\[\[:space:\]\[:cntrl:\]\]'/u);
    expect(organizationBootstrapSql).toMatch(
      /memberships\.user_id = v_user\.id[\s\S]*memberships\.status = 'active'/u,
    );
    expect(organizationBootstrapSql).toMatch(/'owner'/u);
    expect(organizationBootstrapSql).toMatch(
      /UNIQUE INDEX organization_bootstrap_requests_identity_idempotency_uidx/u,
    );
    expect(organizationBootstrapSql).toMatch(
      /REVOKE ALL ON TABLE public\.organization_bootstrap_requests FROM reconai_app/u,
    );
    expect(organizationBootstrapSql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.reconai_bootstrap_first_organization\([\s\S]*TO reconai_app/u,
    );
    expect(organizationBootstrapSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.reconai_bootstrap_first_organization\([\s\S]*FROM reconai_worker/u,
    );
  });

  it("keeps retention disabled by default and confines cross-tenant deletion authority", () => {
    expect(retentionDeletionWorkflowSql).toMatch(
      /raw_import_retention_days integer[\s\S]*provider_event_retention_days integer/u,
    );
    expect(retentionDeletionWorkflowSql).toMatch(
      /CHECK \(raw_import_retention_days IS NULL OR raw_import_retention_days BETWEEN 1 AND 3650\)/u,
    );
    expect(retentionDeletionWorkflowSql).toMatch(
      /ALTER TABLE organization_retention_policies FORCE ROW LEVEL SECURITY/u,
    );
    expect(retentionDeletionWorkflowSql).toMatch(
      /ALTER TABLE retention_deletion_tombstones FORCE ROW LEVEL SECURITY/u,
    );
    expect(retentionDeletionWorkflowSql).toMatch(
      /retention_deletion_tombstones_reject_update_delete/u,
    );
    expect(retentionDeletionWorkflowSql).toMatch(
      /events\.source <> 'accounting_csv'[\s\S]*events\.status IN \('processed', 'normalized'\)/u,
    );
    expect(retentionDeletionWorkflowSql).toMatch(
      /imports\.status IN \('succeeded', 'rolled_back'\)/u,
    );
    expect(retentionDeletionWorkflowSql).toMatch(/policies\.legal_hold_enabled = false/u);
    expect(retentionDeletionWorkflowSql).toMatch(/FOR UPDATE SKIP LOCKED/u);
    expect(retentionDeletionWorkflowSql).toMatch(/SET search_path = pg_catalog, public/u);
    expect(retentionDeletionWorkflowSql).toMatch(/SET row_security = on/u);
    expect(retentionDeletionWorkflowSql).toMatch(
      /REVOKE ALL ON[\s\S]*organization_retention_policies,[\s\S]*retention_deletion_jobs,[\s\S]*retention_deletion_tombstones[\s\S]*FROM reconai_worker/u,
    );
    expect(retentionDeletionWorkflowSql).toMatch(
      /GRANT EXECUTE ON FUNCTION reconai_claim_retention_candidate\(uuid\) TO reconai_worker/u,
    );
    expect(retentionDeletionWorkflowSql).toMatch(
      /REVOKE ALL ON FUNCTION reconai_claim_retention_candidate\(uuid\) FROM reconai_app/u,
    );
  });
});
