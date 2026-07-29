import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { ReconciliationRunJobEnvelopeSchema } from "@workspace/connectors";
import { PostgresExceptionQueueObservabilityRepository } from "@workspace/database";
import {
  CanonicalRecordIdSchema,
  OrganizationIdSchema,
  SourceEventIdSchema,
  UserIdSchema,
  asCurrency,
  money,
  serializeCanonicalRecord,
  type CanonicalRecord,
} from "@workspace/domain";
import {
  identifyReconciliation,
  reconciliationRecordIdentity,
  serializeReconciliationPolicy,
  type ReconciliationPolicy,
} from "@workspace/reconciliation";
import postgres, { type JSONValue, type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresReconciliationRunProcessor,
  ReconciliationRunExecutionError,
} from "./reconciliation-run-execution.js";

const organizationId = OrganizationIdSchema.parse(randomUUID());
const otherOrganizationId = OrganizationIdSchema.parse(randomUUID());
const userId = UserIdSchema.parse(randomUUID());
const connectionId = randomUUID();
const paymentConnectionId = randomUUID();
const accountingConnectionId = randomUUID();
const accountingImportId = randomUUID();
const sourceEventId = SourceEventIdSchema.parse(randomUUID());
const paymentSourceEventId = SourceEventIdSchema.parse(randomUUID());
const recordId = CanonicalRecordIdSchema.parse(randomUUID());
const paymentRecordId = CanonicalRecordIdSchema.parse(randomUUID());
const runId = randomUUID();
const invalidRunId = randomUUID();
const staleRunId = randomUUID();
const newerRunId = randomUUID();
const ruleRunId = randomUUID();
const policy = {
  version: "worker-integration-v1",
  evaluatedAt: "2026-07-27T12:00:00.000Z",
  amountToleranceMinor: {},
  dateWindowSeconds: 86_400,
  delayedEventGraceSeconds: 3_600,
  businessTimeZone: "UTC",
} as const;
const record: CanonicalRecord = {
  id: recordId,
  organizationId,
  version: 1,
  kind: "order",
  externalId: "worker-integration-order",
  orderReference: "#WORKER-1",
  effectiveAt: "2026-07-26T10:00:00.000Z",
  amount: money(12_500n, asCurrency("USD")),
  financialStatus: "paid",
  provenance: {
    sourceSystem: "shopify",
    externalObjectType: "order",
    externalObjectId: "worker-integration-order",
    sourceTimestamp: "2026-07-26T10:00:00.000Z",
    ingestionTimestamp: "2026-07-26T10:01:00.000Z",
    sourceEventId,
    connectorVersion: "worker-integration-v1",
    normalizerVersion: "worker-integration-v1",
  },
};
const paymentRecord: CanonicalRecord = {
  id: paymentRecordId,
  organizationId,
  version: 1,
  kind: "payment",
  externalId: "worker-integration-payment",
  orderReference: "worker-integration-order",
  providerOrderReference: "worker-integration-order",
  effectiveAt: "2026-07-26T10:00:30.000Z",
  amount: money(12_500n, asCurrency("USD")),
  paymentStatus: "succeeded",
  provenance: {
    sourceSystem: "stripe",
    externalObjectType: "payment_intent",
    externalObjectId: "worker-integration-payment",
    sourceTimestamp: "2026-07-26T10:00:30.000Z",
    ingestionTimestamp: "2026-07-26T10:01:30.000Z",
    sourceEventId: paymentSourceEventId,
    connectorVersion: "worker-integration-v1",
    normalizerVersion: "worker-integration-v1",
  },
};
const persistedRuleRecords = [
  {
    id: CanonicalRecordIdSchema.parse(randomUUID()),
    organizationId,
    version: 1,
    kind: "refund",
    externalId: "worker-shopify-refund",
    orderReference: "worker-refund-order",
    refundReference: "worker-refund-reference",
    effectiveAt: "2026-07-26T11:00:00.000Z",
    amount: money(2_500n, asCurrency("USD")),
    refundStatus: "succeeded",
    provenance: {
      sourceSystem: "shopify",
      externalObjectType: "refund",
      externalObjectId: "worker-shopify-refund",
      sourceTimestamp: "2026-07-26T11:00:00.000Z",
      ingestionTimestamp: "2026-07-26T11:01:00.000Z",
      sourceEventId: SourceEventIdSchema.parse(randomUUID()),
      connectorVersion: "worker-integration-v1",
      normalizerVersion: "worker-integration-v1",
    },
  },
  {
    id: CanonicalRecordIdSchema.parse(randomUUID()),
    organizationId,
    version: 1,
    kind: "refund",
    externalId: "worker-stripe-refund",
    orderReference: "worker-refund-order",
    refundReference: "worker-refund-reference",
    effectiveAt: "2026-07-26T11:00:30.000Z",
    amount: money(2_500n, asCurrency("USD")),
    refundStatus: "succeeded",
    provenance: {
      sourceSystem: "stripe",
      externalObjectType: "refund",
      externalObjectId: "worker-stripe-refund",
      sourceTimestamp: "2026-07-26T11:00:30.000Z",
      ingestionTimestamp: "2026-07-26T11:01:30.000Z",
      sourceEventId: SourceEventIdSchema.parse(randomUUID()),
      connectorVersion: "worker-integration-v1",
      normalizerVersion: "worker-integration-v1",
    },
  },
  {
    id: CanonicalRecordIdSchema.parse(randomUUID()),
    organizationId,
    version: 1,
    kind: "accounting_entry",
    externalId: "worker-accounting-refund",
    transactionReference: "WORKER-SHOPIFY-REFUND",
    orderReference: "worker-accounting-order",
    effectiveAt: "2026-07-26T11:05:00.000Z",
    amount: money(1_000n, asCurrency("USD")),
    entryType: "refund",
    provenance: {
      sourceSystem: "accounting_csv",
      externalObjectType: "csv_row",
      externalObjectId: "worker-accounting-refund",
      sourceTimestamp: "2026-07-26T11:05:00.000Z",
      ingestionTimestamp: "2026-07-26T11:06:00.000Z",
      sourceEventId: SourceEventIdSchema.parse(randomUUID()),
      connectorVersion: "worker-integration-v1",
      normalizerVersion: "worker-integration-v1",
    },
  },
  {
    id: CanonicalRecordIdSchema.parse(randomUUID()),
    organizationId,
    version: 1,
    kind: "accounting_entry",
    externalId: "worker-accounting-refund-split-second",
    transactionReference: "worker-shopify-refund",
    orderReference: "worker-accounting-order",
    effectiveAt: "2026-07-26T11:05:30.000Z",
    amount: money(1_500n, asCurrency("USD")),
    entryType: "refund",
    provenance: {
      sourceSystem: "accounting_csv",
      externalObjectType: "csv_row",
      externalObjectId: "worker-accounting-refund-split-second",
      sourceTimestamp: "2026-07-26T11:05:30.000Z",
      ingestionTimestamp: "2026-07-26T11:06:30.000Z",
      sourceEventId: SourceEventIdSchema.parse(randomUUID()),
      connectorVersion: "worker-integration-v1",
      normalizerVersion: "worker-integration-v1",
    },
  },
  {
    id: CanonicalRecordIdSchema.parse(randomUUID()),
    organizationId,
    version: 1,
    kind: "processing_fee",
    externalId: "worker-duplicate-fee",
    paymentReference: "worker-unrelated-payment",
    effectiveAt: "2026-07-26T11:10:00.000Z",
    amount: money(75n, asCurrency("USD")),
    provenance: {
      sourceSystem: "stripe",
      externalObjectType: "balance_transaction",
      externalObjectId: "worker-duplicate-fee",
      sourceTimestamp: "2026-07-26T11:10:00.000Z",
      ingestionTimestamp: "2026-07-26T11:11:00.000Z",
      sourceEventId: SourceEventIdSchema.parse(randomUUID()),
      connectorVersion: "worker-integration-v1",
      normalizerVersion: "worker-integration-v1",
    },
  },
  {
    id: CanonicalRecordIdSchema.parse(randomUUID()),
    organizationId,
    version: 1,
    kind: "processing_fee",
    externalId: "worker-duplicate-fee",
    paymentReference: "worker-unrelated-payment",
    effectiveAt: "2026-07-26T11:10:30.000Z",
    amount: money(75n, asCurrency("USD")),
    provenance: {
      sourceSystem: "stripe",
      externalObjectType: "balance_transaction",
      externalObjectId: "worker-duplicate-fee",
      sourceTimestamp: "2026-07-26T11:10:30.000Z",
      ingestionTimestamp: "2026-07-26T11:11:30.000Z",
      sourceEventId: SourceEventIdSchema.parse(randomUUID()),
      connectorVersion: "worker-integration-v1",
      normalizerVersion: "worker-integration-v1",
    },
  },
] satisfies readonly CanonicalRecord[];
const stalePolicy = {
  ...policy,
  version: "worker-stale-policy-v1",
  evaluatedAt: "2026-07-27T10:30:00.000Z",
} as const;

let administrator: Sql | undefined;
let worker: Sql | undefined;

describe("live durable reconciliation execution", { concurrent: false }, () => {
  beforeAll(async () => {
    const admin = postgres(requiredEnvironment("DATABASE_ADMIN_URL"), { max: 1 });
    administrator = admin;
    await ensureLocalTestRoles(admin);
    execFileSync("pnpm", ["--filter", "@workspace/database", "db:migrate"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_MIGRATION_URL: requiredEnvironment("DATABASE_MIGRATION_URL"),
      },
      stdio: "pipe",
    });
    await seed(admin);
    worker = postgres(requiredEnvironment("DATABASE_WORKER_URL"), { max: 1 });
  });

  afterAll(async () => {
    await worker?.end({ timeout: 5 });
    await administrator?.end({ timeout: 5 });
  });

  it("executes one pinned snapshot idempotently and rejects mismatched input authority", async () => {
    const workerSql = requiredConnection(worker, "worker");
    const processor = new PostgresReconciliationRunProcessor(workerSql);
    const envelope = runEnvelope(runId, 1);

    await expect(processor.process(envelope)).resolves.toMatchObject({
      runId,
      status: "succeeded",
      alreadyCompleted: false,
      counts: { input: 1 },
      operationalStateApplied: true,
    });
    await expect(processor.process(envelope)).resolves.toMatchObject({
      runId,
      status: "succeeded",
      alreadyCompleted: true,
    });

    const persisted = await workerSql.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
      return transaction`
        select
          (select status from reconciliation_runs where id = ${runId}) as status,
          (select count(*)::integer from exceptions where latest_run_id = ${runId})
            as exceptions,
          (select count(*)::integer from exception_occurrences where run_id = ${runId})
            as occurrences,
          (select count(*)::integer from audit_events
            where resource_id = ${runId} and action = 'reconciliation.run.completed')
            as completed_events,
          (select operational_state_applied from reconciliation_runs where id = ${runId})
            as operational_state_applied,
          (select count(*)::integer from exception_status_events where run_id = ${runId})
            as status_events
      `;
    });
    expect(persisted[0]).toMatchObject({
      status: "succeeded",
      exceptions: 1,
      occurrences: 1,
      completed_events: 1,
      operational_state_applied: true,
      status_events: 1,
    });
    const queueObservation = await new PostgresExceptionQueueObservabilityRepository(
      workerSql,
    ).observeExceptionQueue();
    expect(queueObservation).toMatchObject({ queueState: "nonempty" });
    if (queueObservation.queueState !== "nonempty") {
      throw new Error("expected the reconciliation exception to be unresolved");
    }
    expect(queueObservation.oldestAgeSeconds).toBeGreaterThanOrEqual(0);
    await expect(workerSql`select id from exceptions limit 1`).resolves.toHaveLength(0);

    await expect(processor.process(runEnvelope(invalidRunId, 1))).rejects.toBeInstanceOf(
      ReconciliationRunExecutionError,
    );
    const invalid = await workerSql.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
      return transaction`
        select status, error_count, last_error_code
        from reconciliation_runs
        where id = ${invalidRunId}
      `;
    });
    expect(invalid[0]).toMatchObject({
      status: "failed",
      error_count: 1,
      last_error_code: "RUN_INPUT_SNAPSHOT_INVALID",
    });

    const hidden = await workerSql.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${otherOrganizationId}, true)`;
      return transaction`select id from reconciliation_runs`;
    });
    expect(hidden).toHaveLength(0);
  });

  it("keeps a newer successful snapshot authoritative when an older run finishes late", async () => {
    const workerSql = requiredConnection(worker, "worker");
    const admin = requiredConnection(administrator, "administrator");
    const processor = new PostgresReconciliationRunProcessor(workerSql);
    const exceptionRows = await admin`
      select id
      from exceptions
      where organization_id = ${organizationId}
      limit 1
    `;
    const exceptionId = String(exceptionRows[0]?.["id"]);
    const proposalId = randomUUID();
    await admin`
      insert into resolution_proposals (
        id, organization_id, exception_id, version, proposed_by, proposal_type,
        reason, evidence, status, required_approvals
      ) values (
        ${proposalId}, ${organizationId}, ${exceptionId}, 1, ${userId},
        'investigate_source_record', 'Pending proposal must follow exception authority',
        '{}'::jsonb, 'pending', 1
      )
    `;
    await admin`
      update exceptions
      set status = 'proposed'
      where organization_id = ${organizationId} and id = ${exceptionId}
    `;

    await expect(processor.process(runEnvelope(newerRunId, 1))).resolves.toMatchObject({
      status: "succeeded",
      counts: { input: 2, matches: 1, exceptions: 1 },
      operationalStateApplied: true,
    });
    await expect(processor.process(runEnvelope(staleRunId, 1))).resolves.toMatchObject({
      status: "succeeded",
      counts: { input: 1, exceptions: 1 },
      operationalStateApplied: false,
    });

    const persisted = await workerSql.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
      return transaction`
        select
          (select operational_state_applied from reconciliation_runs where id = ${newerRunId})
            as newer_applied,
          (select operational_state_applied from reconciliation_runs where id = ${staleRunId})
            as stale_applied,
          (select operational_state_applied from reconciliation_runs where id = ${runId})
            as original_applied,
          (select status from exceptions where id = ${exceptionId}) as exception_status,
          (select latest_run_id from exceptions where id = ${exceptionId}) as latest_run_id,
          (select status from resolution_proposals where id = ${proposalId}) as proposal_status,
          (select count(*)::integer from exception_occurrences where run_id = ${staleRunId})
            as stale_occurrences,
          (select count(*)::integer from exception_status_events
            where exception_id = ${exceptionId}) as lifecycle_events,
          (select reason_code from exception_status_events
            where exception_id = ${exceptionId} and run_id = ${newerRunId})
            as supersession_reason
      `;
    });
    expect(persisted[0]).toMatchObject({
      newer_applied: true,
      stale_applied: false,
      original_applied: false,
      exception_status: "superseded",
      latest_run_id: newerRunId,
      proposal_status: "superseded",
      stale_occurrences: 1,
      lifecycle_events: 2,
      supersession_reason: "not_observed_in_authoritative_run",
    });
  });

  it("persists rule 1.5 split-accounting evidence and fee duplicates idempotently under RLS", async () => {
    const workerSql = requiredConnection(worker, "worker");
    const processor = new PostgresReconciliationRunProcessor(workerSql);
    const envelope = runEnvelope(ruleRunId, 1);

    await expect(processor.process(envelope)).resolves.toMatchObject({
      runId: ruleRunId,
      status: "succeeded",
      alreadyCompleted: false,
      counts: { input: 6, matches: 2, exceptions: 1 },
      operationalStateApplied: true,
    });
    await expect(processor.process(envelope)).resolves.toMatchObject({
      runId: ruleRunId,
      status: "succeeded",
      alreadyCompleted: true,
    });

    const persisted = await workerSql.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
      const runs = await transaction`
        select status, engine_version, rule_set_version, match_count, exception_count
        from reconciliation_runs
        where id = ${ruleRunId}
      `;
      const matches = await transaction`
        select
          snapshot_version,
          rule_id,
          rule_version,
          evidence ->> 'reasonCode' as reason_code,
          jsonb_array_length(record_references) as record_count
        from match_occurrence_snapshots
        where run_id = ${ruleRunId}
        order by rule_id
      `;
      const exceptions = await transaction`
        select
          snapshot_version,
          type,
          observed_status,
          severity,
          evidence ->> 'ruleVersion' as rule_version,
          evidence ->> 'reasonCode' as reason_code,
          jsonb_array_length(record_references) as record_count
        from exception_occurrence_snapshots
        where run_id = ${ruleRunId}
      `;
      const occurrences = await transaction`
        select
          (select count(*)::integer from match_occurrences where run_id = ${ruleRunId})
            as matches,
          (select count(*)::integer from exception_occurrences where run_id = ${ruleRunId})
            as exceptions,
          (select count(*)::integer from match_occurrence_snapshots where run_id = ${ruleRunId})
            as match_snapshots,
          (select count(*)::integer from exception_occurrence_snapshots
            where run_id = ${ruleRunId}) as exception_snapshots
      `;
      return { runs, matches, exceptions, occurrences };
    });
    expect(persisted.runs[0]).toMatchObject({
      status: "succeeded",
      engine_version: "0.7.0",
      rule_set_version: "1.5.0",
      match_count: 2,
      exception_count: 1,
    });
    expect(persisted.matches).toEqual([
      {
        snapshot_version: "artifact-occurrence-v1",
        rule_id: "refund",
        rule_version: "1.5.0",
        reason_code: "SHOPIFY_STRIPE_REFUND_MATCHED",
        record_count: 2,
      },
      {
        snapshot_version: "artifact-occurrence-v1",
        rule_id: "refund-accounting-split",
        rule_version: "1.5.0",
        reason_code: "REFUND_ACCOUNTING_SPLIT_TOTAL_MATCHED",
        record_count: 3,
      },
    ]);
    expect(persisted.exceptions).toEqual([
      {
        snapshot_version: "artifact-occurrence-v1",
        type: "duplicate_processing_fee",
        observed_status: "open",
        severity: "high",
        rule_version: "1.5.0",
        reason_code: "DUPLICATE_SOURCE_EXTERNAL_IDENTIFIER",
        record_count: 2,
      },
    ]);
    expect(persisted.occurrences[0]).toMatchObject({
      matches: 2,
      exceptions: 1,
      match_snapshots: 2,
      exception_snapshots: 1,
    });

    const hidden = await workerSql.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${otherOrganizationId}, true)`;
      return transaction`
        select
          (select count(*)::integer from reconciliation_runs where id = ${ruleRunId}) as runs,
          (select count(*)::integer from matches where run_id = ${ruleRunId}) as matches,
          (select count(*)::integer from exceptions where latest_run_id = ${ruleRunId})
            as exceptions,
          (select count(*)::integer from match_occurrences where run_id = ${ruleRunId})
            as match_occurrences,
          (select count(*)::integer from exception_occurrences where run_id = ${ruleRunId})
            as exception_occurrences,
          (select count(*)::integer from match_occurrence_snapshots where run_id = ${ruleRunId})
            as match_snapshots,
          (select count(*)::integer from exception_occurrence_snapshots
            where run_id = ${ruleRunId}) as exception_snapshots
      `;
    });
    expect(hidden[0]).toMatchObject({
      runs: 0,
      matches: 0,
      exceptions: 0,
      match_occurrences: 0,
      exception_occurrences: 0,
      match_snapshots: 0,
      exception_snapshots: 0,
    });

    await expect(
      workerSql.begin(async (transaction) => {
        await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
        await transaction`
          update match_occurrence_snapshots
          set rule_version = '9.9.9'
          where run_id = ${ruleRunId}
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

async function seed(sql: Sql): Promise<void> {
  const identity = identifyReconciliation({ organizationId, policy, records: [record] });
  const staleIdentity = identifyReconciliation({
    organizationId,
    policy: stalePolicy,
    records: [record],
  });
  const newerIdentity = identifyReconciliation({
    organizationId,
    policy,
    records: [record, paymentRecord],
  });
  const recordIdentity = reconciliationRecordIdentity(record);
  const paymentIdentity = reconciliationRecordIdentity(paymentRecord);
  const normalized = JSON.parse(JSON.stringify(serializeCanonicalRecord(record))) as JSONValue;
  const normalizedPayment = JSON.parse(
    JSON.stringify(serializeCanonicalRecord(paymentRecord)),
  ) as JSONValue;
  await sql`
    insert into organizations (id, name) values
      (${organizationId}, 'Worker Execution Integration Tenant'),
      (${otherOrganizationId}, 'Worker Execution Other Tenant')
  `;
  await sql`
    insert into users (id, issuer, subject)
    values (${userId}, 'https://issuer.example.test', ${`worker-${userId}`})
  `;
  await sql`
    insert into data_source_connections (
      id, organization_id, provider, external_account_id, status, connector_version
    ) values
    (
      ${connectionId}, ${organizationId}, 'shopify', ${`worker-${connectionId}`},
      'healthy', 'worker-integration-v1'
    ),
    (
      ${paymentConnectionId}, ${organizationId}, 'stripe',
      ${`worker-${paymentConnectionId}`}, 'healthy', 'worker-integration-v1'
    ),
    (
      ${accountingConnectionId}, ${organizationId}, 'accounting_csv',
      ${`worker-${accountingConnectionId}`}, 'healthy', 'worker-integration-v1'
    )
  `;
  await sql`
    insert into imports (
      id, organization_id, connection_id, source, object_key, payload_sha256, byte_count,
      content_type, original_filename, template_version, mapping_version, mapping, status,
      idempotency_key, row_count, valid_row_count, invalid_row_count, preview_rows,
      preview_errors, errors_truncated, uploaded_by, uploaded_at, committed_at, completed_at
    ) values (
      ${accountingImportId}, ${organizationId}, ${accountingConnectionId}, 'accounting_csv',
      ${`integration/${organizationId}/${accountingImportId}.csv`}, ${"a".repeat(64)}, 128,
      'text/csv', 'worker-rule-accounting.csv', 'worker-integration-v1',
      'worker-integration-v1', '{}'::jsonb, 'succeeded', ${"d".repeat(64)}, 1, 1, 0,
      '[]'::jsonb, '[]'::jsonb, false, ${userId}, '2026-07-26T11:04:00.000Z',
      '2026-07-26T11:04:30.000Z', '2026-07-26T11:06:00.000Z'
    )
  `;
  await sql`
    insert into source_events (
      id, organization_id, connection_id, source, external_event_id, external_object_type,
      external_object_id, source_timestamp, received_at, connector_version,
      payload_object_key, payload_sha256, status
    ) values
    (
      ${sourceEventId}, ${organizationId}, ${connectionId}, 'shopify',
      'worker-integration-event', 'order', 'worker-integration-order',
      ${record.provenance.sourceTimestamp}, ${record.provenance.ingestionTimestamp},
      'worker-integration-v1', ${`integration/${organizationId}/${sourceEventId}.json`},
      ${recordIdentity.contentSha256}, 'normalized'
    ),
    (
      ${paymentSourceEventId}, ${organizationId}, ${paymentConnectionId}, 'stripe',
      'worker-integration-payment-event', 'payment_intent', 'worker-integration-payment',
      ${paymentRecord.provenance.sourceTimestamp}, ${paymentRecord.provenance.ingestionTimestamp},
      'worker-integration-v1',
      ${`integration/${organizationId}/${paymentSourceEventId}.json`},
      ${paymentIdentity.contentSha256}, 'normalized'
    )
  `;
  await sql`
    insert into canonical_records (
      id, organization_id, version, kind, source_event_id, source, external_object_type,
      external_object_id, source_timestamp, ingestion_timestamp, effective_at,
      connector_version, normalizer_version, amount_minor, currency, order_reference,
      normalized_data, content_sha256, is_incomplete
    ) values (
      ${record.id}, ${organizationId}, ${record.version}, ${record.kind}, ${sourceEventId},
      'shopify', 'order', 'worker-integration-order', ${record.provenance.sourceTimestamp},
      ${record.provenance.ingestionTimestamp}, ${record.effectiveAt},
      ${record.provenance.connectorVersion}, ${record.provenance.normalizerVersion},
      ${record.amount.minor.toString()}, ${record.amount.currency}, ${record.orderReference ?? null},
      ${sql.json(normalized)}, ${recordIdentity.contentSha256}, false
    )
  `;
  for (const ruleRecord of persistedRuleRecords) {
    const identity = reconciliationRecordIdentity(ruleRecord);
    const normalized = JSON.parse(
      JSON.stringify(serializeCanonicalRecord(ruleRecord)),
    ) as JSONValue;
    const recordConnectionId =
      ruleRecord.provenance.sourceSystem === "shopify"
        ? connectionId
        : ruleRecord.provenance.sourceSystem === "stripe"
          ? paymentConnectionId
          : accountingConnectionId;
    await sql`
      insert into source_events (
        id, organization_id, connection_id, import_id, source, external_event_id,
        external_object_type, external_object_id, source_timestamp, received_at, connector_version,
        payload_object_key, payload_sha256, status
      ) values (
        ${ruleRecord.provenance.sourceEventId}, ${organizationId}, ${recordConnectionId},
        ${ruleRecord.provenance.sourceSystem === "accounting_csv" ? accountingImportId : null},
        ${ruleRecord.provenance.sourceSystem},
        ${`worker-rule-event:${ruleRecord.provenance.sourceEventId}`},
        ${ruleRecord.provenance.externalObjectType}, ${ruleRecord.provenance.externalObjectId},
        ${ruleRecord.provenance.sourceTimestamp}, ${ruleRecord.provenance.ingestionTimestamp},
        ${ruleRecord.provenance.connectorVersion},
        ${`integration/${organizationId}/${ruleRecord.provenance.sourceEventId}.json`},
        ${identity.contentSha256}, 'normalized'
      )
    `;
    await sql`
      insert into canonical_records (
        id, organization_id, version, kind, source_event_id, source, external_object_type,
        external_object_id, source_timestamp, ingestion_timestamp, effective_at,
        connector_version, normalizer_version, amount_minor, currency, order_reference,
        normalized_data, content_sha256, is_incomplete
      ) values (
        ${ruleRecord.id}, ${organizationId}, ${ruleRecord.version}, ${ruleRecord.kind},
        ${ruleRecord.provenance.sourceEventId}, ${ruleRecord.provenance.sourceSystem},
        ${ruleRecord.provenance.externalObjectType}, ${ruleRecord.provenance.externalObjectId},
        ${ruleRecord.provenance.sourceTimestamp}, ${ruleRecord.provenance.ingestionTimestamp},
        ${ruleRecord.effectiveAt}, ${ruleRecord.provenance.connectorVersion},
        ${ruleRecord.provenance.normalizerVersion}, ${ruleRecord.amount.minor.toString()},
        ${ruleRecord.amount.currency}, ${ruleRecord.orderReference ?? null},
        ${sql.json(normalized)}, ${identity.contentSha256}, false
      )
    `;
  }
  await sql`
    insert into canonical_records (
      id, organization_id, version, kind, source_event_id, source, external_object_type,
      external_object_id, source_timestamp, ingestion_timestamp, effective_at,
      connector_version, normalizer_version, amount_minor, currency, order_reference,
      normalized_data, content_sha256, is_incomplete
    ) values (
      ${paymentRecord.id}, ${organizationId}, ${paymentRecord.version}, ${paymentRecord.kind},
      ${paymentSourceEventId}, 'stripe', 'payment_intent', 'worker-integration-payment',
      ${paymentRecord.provenance.sourceTimestamp}, ${paymentRecord.provenance.ingestionTimestamp},
      ${paymentRecord.effectiveAt}, ${paymentRecord.provenance.connectorVersion},
      ${paymentRecord.provenance.normalizerVersion}, ${paymentRecord.amount.minor.toString()},
      ${paymentRecord.amount.currency}, ${paymentRecord.orderReference ?? null},
      ${sql.json(normalizedPayment)}, ${paymentIdentity.contentSha256}, false
    )
  `;
  for (const [id, pinnedHash] of [
    [runId, recordIdentity.contentSha256],
    [invalidRunId, "b".repeat(64)],
  ] as const) {
    await sql`
      insert into reconciliation_runs (
        id, organization_id, stable_run_key, input_snapshot_hash, policy_snapshot_hash,
        policy_snapshot, policy_version, rule_set_version, engine_version, initiated_by,
        status, input_count, dispatch_count, created_at
      ) values (
        ${id}, ${organizationId},
        ${id === runId ? identity.runKey : "c".repeat(64)}, ${identity.inputSnapshotHash},
        ${identity.policySnapshotHash},
        ${sql.json(serializeReconciliationPolicy(policy) as unknown as JSONValue)},
        ${policy.version}, ${identity.ruleSetVersion}, ${identity.engineVersion}, ${userId},
        'queued', 1, 1,
        ${id === runId ? "2026-07-27T10:00:00.000Z" : "2026-07-27T10:15:00.000Z"}
      )
    `;
    await sql`
      insert into reconciliation_run_inputs (
        organization_id, run_id, record_id, record_version, content_sha256, ordinal
      ) values (${organizationId}, ${id}, ${record.id}, ${record.version}, ${pinnedHash}, 0)
    `;
  }
  await insertSyntheticRun(sql, {
    id: staleRunId,
    identity: staleIdentity,
    policy: stalePolicy,
    records: [record],
    createdAt: "2026-07-27T10:30:00.000Z",
  });
  await insertSyntheticRun(sql, {
    id: newerRunId,
    identity: newerIdentity,
    policy,
    records: [record, paymentRecord],
    createdAt: "2026-07-27T11:00:00.000Z",
  });
  const ruleIdentity = identifyReconciliation({
    organizationId,
    policy,
    records: persistedRuleRecords,
  });
  await insertSyntheticRun(sql, {
    id: ruleRunId,
    identity: ruleIdentity,
    policy,
    records: persistedRuleRecords,
    createdAt: "2026-07-27T12:00:00.000Z",
  });
}

async function insertSyntheticRun(
  sql: Sql,
  input: {
    readonly id: string;
    readonly identity: ReturnType<typeof identifyReconciliation>;
    readonly policy: ReconciliationPolicy;
    readonly records: readonly CanonicalRecord[];
    readonly createdAt: string;
  },
): Promise<void> {
  await sql`
    insert into reconciliation_runs (
      id, organization_id, stable_run_key, input_snapshot_hash, policy_snapshot_hash,
      policy_snapshot, policy_version, rule_set_version, engine_version, initiated_by,
      status, input_count, dispatch_count, created_at
    ) values (
      ${input.id}, ${organizationId}, ${input.identity.runKey}, ${input.identity.inputSnapshotHash},
      ${input.identity.policySnapshotHash},
      ${sql.json(serializeReconciliationPolicy(input.policy) as unknown as JSONValue)},
      ${input.policy.version}, ${input.identity.ruleSetVersion}, ${input.identity.engineVersion},
      ${userId}, 'queued', ${input.records.length}, 1, ${input.createdAt}
    )
  `;
  for (const [ordinal, inputRecord] of input.records.entries()) {
    const identity = reconciliationRecordIdentity(inputRecord);
    await sql`
      insert into reconciliation_run_inputs (
        organization_id, run_id, record_id, record_version, content_sha256, ordinal
      ) values (
        ${organizationId}, ${input.id}, ${identity.id}, ${identity.version},
        ${identity.contentSha256}, ${ordinal}
      )
    `;
  }
}

function runEnvelope(id: string, executionAttempt: number) {
  return ReconciliationRunJobEnvelopeSchema.parse({
    schemaVersion: 1,
    type: "reconciliation.run.requested",
    organizationId,
    runId: id,
    executionAttempt,
    correlationId: randomUUID(),
    idempotencyKey: `reconciliation-run:${id}:dispatch:${executionAttempt.toString()}`,
    requestedBy: userId,
    createdAt: "2026-07-27T12:00:00.000Z",
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the PostgreSQL integration suite`);
  return value;
}

function requiredConnection(value: Sql | undefined, name: string): Sql {
  if (!value) throw new Error(`${name} database connection was not initialized`);
  return value;
}

async function ensureLocalTestRoles(sql: Sql): Promise<void> {
  const existing = await sql`
    select rolname from pg_roles
    where rolname in ('reconai_migrator', 'reconai_app', 'reconai_worker')
  `;
  const names = new Set(existing.map((row) => String(row["rolname"])));
  if (!names.has("reconai_migrator")) {
    await sql.unsafe(
      "create role reconai_migrator login password 'local-migrator-only' nosuperuser nocreatedb nocreaterole noinherit",
    );
  }
  if (!names.has("reconai_app")) {
    await sql.unsafe(
      "create role reconai_app login password 'local-app-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
    );
  }
  if (!names.has("reconai_worker")) {
    await sql.unsafe(
      "create role reconai_worker login password 'local-worker-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
    );
  }
  await sql.unsafe(
    "grant connect on database reconai to reconai_migrator, reconai_app, reconai_worker",
  );
  await sql.unsafe("grant create, usage on schema public to reconai_migrator");
  await sql.unsafe("grant usage on schema public to reconai_app, reconai_worker");
}
