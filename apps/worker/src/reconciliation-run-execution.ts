import type { ReconciliationRunJobEnvelope } from "@workspace/connectors";
import { insertTenantAuditEvent } from "@workspace/database";
import {
  CanonicalRecordSchema,
  type CanonicalRecord,
  type OrganizationId,
} from "@workspace/domain";
import {
  identifyReconciliation,
  parseReconciliationPolicySnapshot,
  reconcile,
  reconciliationRecordIdentity,
  ReconciliationError,
  type ReconciliationResult,
} from "@workspace/reconciliation";
import type { JSONValue, Sql, TransactionSql } from "postgres";

export class ReconciliationRunExecutionError extends Error {
  public constructor(
    public readonly code:
      | "RUN_ARTIFACT_SNAPSHOT_CONFLICT"
      | "RUN_AUTHORITY_INVALID"
      | "RUN_INPUT_SNAPSHOT_INVALID"
      | "RUN_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "ReconciliationRunExecutionError";
  }
}

export interface ReconciliationRunExecutionResult {
  readonly runId: string;
  readonly status: "succeeded";
  readonly counts: ReconciliationResult["counts"];
  readonly alreadyCompleted: boolean;
  readonly operationalStateApplied: boolean;
}

export class PostgresReconciliationRunProcessor {
  public constructor(private readonly sql: Sql) {}

  public async process(
    envelope: ReconciliationRunJobEnvelope,
  ): Promise<ReconciliationRunExecutionResult> {
    try {
      return await withOrganizationTransaction(
        this.sql,
        envelope.organizationId,
        async (transaction) => {
          await transaction`
            select pg_advisory_xact_lock(hashtextextended(${envelope.runId}, 2))
          `;
          await transaction`
            select pg_advisory_xact_lock(hashtextextended(${envelope.organizationId}, 3))
          `;
          const selected = await transaction`
            select
              id, stable_run_key, input_snapshot_hash, policy_snapshot_hash, policy_snapshot,
              policy_version, rule_set_version, engine_version, status, input_count,
              match_count, exception_count, dispatch_count, operational_state_applied, created_at
            from reconciliation_runs
            where organization_id = ${envelope.organizationId}
              and id = ${envelope.runId}::uuid
            limit 1
            for update
          `;
          const row = selected[0] ? databaseRow(selected[0]) : undefined;
          if (!row) {
            throw new ReconciliationRunExecutionError("RUN_NOT_FOUND", "run not found");
          }
          const dispatchCount = databaseInteger(row["dispatch_count"], "dispatch_count");
          if (envelope.executionAttempt < dispatchCount) {
            throw new ReconciliationRunExecutionError(
              "RUN_AUTHORITY_INVALID",
              "stale reconciliation execution authority",
            );
          }
          if (envelope.executionAttempt !== dispatchCount) {
            throw new ReconciliationRunExecutionError(
              "RUN_AUTHORITY_INVALID",
              "reconciliation execution authority is ahead of persisted state",
            );
          }
          if (row["status"] === "succeeded") {
            return {
              runId: envelope.runId,
              status: "succeeded",
              counts: {
                input: databaseInteger(row["input_count"], "input_count"),
                matches: databaseInteger(row["match_count"], "match_count"),
                exceptions: databaseInteger(row["exception_count"], "exception_count"),
                ambiguousCandidates: 0,
              },
              alreadyCompleted: true,
              operationalStateApplied: databaseBoolean(
                row["operational_state_applied"],
                "operational_state_applied",
              ),
            };
          }

          await transaction`
            update reconciliation_runs
            set status = 'running',
                started_at = coalesce(started_at, now()),
                completed_at = null,
                last_error_code = null
            where organization_id = ${envelope.organizationId}
              and id = ${envelope.runId}::uuid
          `;

          const policy = parsePolicy(row["policy_snapshot"]);
          const inputs = await transaction`
            select
              reconciliation_run_inputs.record_id,
              reconciliation_run_inputs.record_version,
              reconciliation_run_inputs.content_sha256 as pinned_content_sha256,
              reconciliation_run_inputs.ordinal,
              canonical_records.content_sha256,
              canonical_records.normalized_data
            from reconciliation_run_inputs
            join canonical_records
              on canonical_records.organization_id = reconciliation_run_inputs.organization_id
              and canonical_records.id = reconciliation_run_inputs.record_id
              and canonical_records.version = reconciliation_run_inputs.record_version
            where reconciliation_run_inputs.organization_id = ${envelope.organizationId}
              and reconciliation_run_inputs.run_id = ${envelope.runId}::uuid
            order by reconciliation_run_inputs.ordinal
          `;
          const expectedInputCount = databaseInteger(row["input_count"], "input_count");
          if (inputs.length !== expectedInputCount) {
            throw new ReconciliationRunExecutionError(
              "RUN_INPUT_SNAPSHOT_INVALID",
              "pinned input count does not match run authority",
            );
          }
          const records = inputs.map((input) => {
            const inputRow = databaseRow(input);
            const pinnedHash = databaseScalar(
              inputRow["pinned_content_sha256"],
              "pinned_content_sha256",
            );
            const canonicalHash = databaseScalar(inputRow["content_sha256"], "content_sha256");
            const record = parseCanonicalRecord(inputRow["normalized_data"]);
            const identity = reconciliationRecordIdentity(record);
            if (
              identity.id !== databaseScalar(inputRow["record_id"], "record_id") ||
              identity.version !== databaseInteger(inputRow["record_version"], "record_version") ||
              identity.contentSha256 !== pinnedHash ||
              canonicalHash !== pinnedHash
            ) {
              throw new ReconciliationRunExecutionError(
                "RUN_INPUT_SNAPSHOT_INVALID",
                "pinned canonical record identity does not match normalized content",
              );
            }
            return record;
          });
          const identity = identifyReconciliation({
            organizationId: envelope.organizationId,
            policy,
            records,
          });
          assertRunIdentity(row, identity);
          const result = reconcile({
            organizationId: envelope.organizationId,
            policy,
            records,
          });
          const operationalStateApplied = await shouldApplyOperationalState(
            transaction,
            envelope.organizationId,
            envelope.runId,
            databaseScalar(row["created_at"], "created_at"),
          );
          if (operationalStateApplied) {
            await transaction`
              update reconciliation_runs
              set operational_state_applied = false
              where organization_id = ${envelope.organizationId}
                and id <> ${envelope.runId}::uuid
                and status = 'succeeded'
                and operational_state_applied = true
            `;
          }
          const supersededCount = await persistResult(
            transaction,
            envelope.organizationId,
            envelope.runId,
            result,
            operationalStateApplied,
          );
          await transaction`
            update reconciliation_runs
            set status = 'succeeded',
                completed_at = now(),
                match_count = ${result.counts.matches},
                exception_count = ${result.counts.exceptions},
                operational_state_applied = ${operationalStateApplied},
                last_error_code = null
            where organization_id = ${envelope.organizationId}
              and id = ${envelope.runId}::uuid
          `;
          await insertTenantAuditEvent(transaction, {
            organizationId: envelope.organizationId,
            actorType: "worker",
            actorId: "reconciliation-worker",
            action: "reconciliation.run.completed",
            resourceType: "reconciliation_run",
            resourceId: envelope.runId,
            correlationId: envelope.correlationId,
            reason: "Durable deterministic reconciliation execution completed",
            newValue: {
              ...result.counts,
              supersededExceptions: supersededCount,
              operationalStateApplied,
              executionAttempt: envelope.executionAttempt,
            },
            versionContext: {
              engineVersion: result.engineVersion,
              ruleSetVersion: result.ruleSetVersion,
              policyVersion: databaseScalar(row["policy_version"], "policy_version"),
              policySnapshotHash: result.policySnapshotHash,
              inputSnapshotHash: result.inputSnapshotHash,
            },
          });
          return {
            runId: envelope.runId,
            status: "succeeded",
            counts: result.counts,
            alreadyCompleted: false,
            operationalStateApplied,
          };
        },
      );
    } catch (error) {
      const errorCode =
        error instanceof ReconciliationRunExecutionError
          ? error.code
          : error instanceof ReconciliationError
            ? "RUN_INPUT_SNAPSHOT_INVALID"
            : "RECONCILIATION_EXECUTION_FAILED";
      await this.markFailed(envelope, errorCode);
      if (error instanceof ReconciliationError) {
        throw new ReconciliationRunExecutionError(
          "RUN_INPUT_SNAPSHOT_INVALID",
          "reconciliation engine rejected the persisted snapshot",
        );
      }
      throw error;
    }
  }

  private async markFailed(
    envelope: ReconciliationRunJobEnvelope,
    errorCode: string,
  ): Promise<void> {
    await withOrganizationTransaction(this.sql, envelope.organizationId, async (transaction) => {
      const updated = await transaction`
        update reconciliation_runs
        set status = 'failed',
            started_at = coalesce(started_at, now()),
            completed_at = now(),
            error_count = least(error_count + 1, 100),
            operational_state_applied = false,
            last_error_code = ${errorCode}
        where organization_id = ${envelope.organizationId}
          and id = ${envelope.runId}::uuid
          and status <> 'succeeded'
          and dispatch_count = ${envelope.executionAttempt}
        returning id, engine_version, rule_set_version, policy_version
      `;
      const row = updated[0] ? databaseRow(updated[0]) : undefined;
      if (!row) return;
      await insertTenantAuditEvent(transaction, {
        organizationId: envelope.organizationId,
        actorType: "worker",
        actorId: "reconciliation-worker",
        action: "reconciliation.run.failed",
        resourceType: "reconciliation_run",
        resourceId: envelope.runId,
        correlationId: envelope.correlationId,
        reason: "Durable reconciliation execution failed with a bounded error code",
        newValue: {
          errorCode,
          executionAttempt: envelope.executionAttempt,
        },
        versionContext: {
          engineVersion: databaseScalar(row["engine_version"], "engine_version"),
          ruleSetVersion: databaseScalar(row["rule_set_version"], "rule_set_version"),
          policyVersion: databaseScalar(row["policy_version"], "policy_version"),
        },
      });
    });
  }
}

async function persistResult(
  transaction: TransactionSql,
  organizationId: OrganizationId,
  runId: string,
  result: ReconciliationResult,
  operationalStateApplied: boolean,
): Promise<number> {
  for (const match of result.matches) {
    const matchId = uuidFromHash(match.id);
    const recordReferences = toJsonValue(match.recordIds);
    const evidence = toJsonValue(match.evidence);
    await transaction`
      insert into matches (
        id, organization_id, run_id, stable_key, rule_id, rule_version,
        record_references, evidence
      ) values (
        ${matchId}, ${organizationId}, ${runId}, ${match.id},
        ${match.ruleId}, ${match.ruleVersion}, ${transaction.json(toJsonValue(match.recordIds))},
        ${transaction.json(evidence)}
      )
      on conflict (organization_id, stable_key) do nothing
    `;
    await transaction`
      insert into match_occurrences (organization_id, run_id, match_id)
      values (${organizationId}, ${runId}, ${matchId})
      on conflict (organization_id, run_id, match_id) do nothing
    `;
    await transaction`
      insert into match_occurrence_snapshots (
        organization_id, run_id, match_id, snapshot_version, rule_id, rule_version,
        record_references, evidence
      ) values (
        ${organizationId}, ${runId}, ${matchId}, 'artifact-occurrence-v1',
        ${match.ruleId}, ${match.ruleVersion}, ${transaction.json(recordReferences)},
        ${transaction.json(evidence)}
      )
      on conflict (organization_id, run_id, match_id) do nothing
    `;
    const snapshot = await transaction`
      select 1
      from match_occurrence_snapshots
      where organization_id = ${organizationId}
        and run_id = ${runId}::uuid
        and match_id = ${matchId}::uuid
        and snapshot_version = 'artifact-occurrence-v1'
        and rule_id = ${match.ruleId}
        and rule_version = ${match.ruleVersion}
        and record_references = ${transaction.json(recordReferences)}
        and evidence = ${transaction.json(evidence)}
      limit 1
    `;
    if (snapshot.length !== 1) {
      throw new ReconciliationRunExecutionError(
        "RUN_ARTIFACT_SNAPSHOT_CONFLICT",
        "persisted match occurrence snapshot conflicts with deterministic output",
      );
    }
  }
  for (const exception of result.exceptions) {
    const exceptionId = uuidFromHash(exception.id);
    const recordReferences = toJsonValue(exception.recordIds);
    const evidence = toJsonValue(exception.evidence);
    if (operationalStateApplied) {
      await transaction`
        with previous as materialized (
          select status
          from exceptions
          where organization_id = ${organizationId}
            and stable_key = ${exception.id}
          for update
        ),
        upserted as (
          insert into exceptions (
            id, organization_id, stable_key, first_run_id, latest_run_id, type, status,
            severity, record_references, amount_minor, currency, evidence
          ) values (
            ${exceptionId}, ${organizationId}, ${exception.id}, ${runId}, ${runId},
            ${exception.type}, ${exception.status}, ${exception.severity},
            ${transaction.json(recordReferences)},
            ${exception.amount?.minor.toString() ?? null},
            ${exception.amount?.currency ?? null},
            ${transaction.json(evidence)}
          )
          on conflict (organization_id, stable_key) do update
          set latest_run_id = excluded.latest_run_id,
              status = case
                when exceptions.status = 'superseded' then excluded.status
                else exceptions.status
              end,
              severity = excluded.severity,
              record_references = excluded.record_references,
              amount_minor = excluded.amount_minor,
              currency = excluded.currency,
              evidence = excluded.evidence,
              updated_at = now()
          returning id, status
        )
        insert into exception_status_events (
          organization_id, run_id, exception_id, previous_status, next_status, reason_code
        )
        select
          ${organizationId},
          ${runId},
          upserted.id,
          previous.status,
          upserted.status,
          case
            when previous.status = 'superseded' then 'reobserved_in_authoritative_run'
            else 'first_observed_in_authoritative_run'
          end
        from upserted
        left join previous on true
        where previous.status is null or previous.status = 'superseded'
        on conflict (organization_id, run_id, exception_id) do nothing
      `;
    } else {
      await transaction`
        with inserted as (
          insert into exceptions (
            id, organization_id, stable_key, first_run_id, latest_run_id, type, status,
            severity, record_references, amount_minor, currency, evidence
          ) values (
            ${exceptionId}, ${organizationId}, ${exception.id}, ${runId}, ${runId},
            ${exception.type}, 'superseded', ${exception.severity},
            ${transaction.json(recordReferences)},
            ${exception.amount?.minor.toString() ?? null},
            ${exception.amount?.currency ?? null},
            ${transaction.json(evidence)}
          )
          on conflict (organization_id, stable_key) do nothing
          returning id, status
        )
        insert into exception_status_events (
          organization_id, run_id, exception_id, previous_status, next_status, reason_code
        )
        select
          ${organizationId},
          ${runId},
          inserted.id,
          null,
          inserted.status,
          'historical_run_not_operational'
        from inserted
        on conflict (organization_id, run_id, exception_id) do nothing
      `;
    }
    await transaction`
      insert into exception_occurrences (organization_id, run_id, exception_id)
      values (${organizationId}, ${runId}, ${exceptionId})
      on conflict (organization_id, run_id, exception_id) do nothing
    `;
    await transaction`
      insert into exception_occurrence_snapshots (
        organization_id, run_id, exception_id, snapshot_version, type, observed_status, severity,
        record_references, amount_minor, currency, evidence
      ) values (
        ${organizationId}, ${runId}, ${exceptionId}, 'artifact-occurrence-v1',
        ${exception.type}, ${exception.status}, ${exception.severity},
        ${transaction.json(recordReferences)}, ${exception.amount?.minor.toString() ?? null},
        ${exception.amount?.currency ?? null}, ${transaction.json(evidence)}
      )
      on conflict (organization_id, run_id, exception_id) do nothing
    `;
    const snapshot = await transaction`
      select 1
      from exception_occurrence_snapshots
      where organization_id = ${organizationId}
        and run_id = ${runId}::uuid
        and exception_id = ${exceptionId}::uuid
        and snapshot_version = 'artifact-occurrence-v1'
        and type = ${exception.type}
        and observed_status = ${exception.status}::exception_status
        and severity = ${exception.severity}
        and record_references = ${transaction.json(recordReferences)}
        and amount_minor is not distinct from ${exception.amount?.minor.toString() ?? null}::bigint
        and currency is not distinct from ${exception.amount?.currency ?? null}::char(3)
        and evidence = ${transaction.json(evidence)}
      limit 1
    `;
    if (snapshot.length !== 1) {
      throw new ReconciliationRunExecutionError(
        "RUN_ARTIFACT_SNAPSHOT_CONFLICT",
        "persisted exception occurrence snapshot conflicts with deterministic output",
      );
    }
  }
  if (!operationalStateApplied) return 0;

  const observedExceptionKeys = result.exceptions.map((exception) => exception.id);
  const superseded =
    observedExceptionKeys.length === 0
      ? await transaction`
          with candidates as materialized (
            select id, status
            from exceptions
            where organization_id = ${organizationId}
              and status in ('open', 'assigned', 'deferred', 'proposed', 'rejected')
            for update
          ),
          updated as (
            update exceptions
            set status = 'superseded', latest_run_id = ${runId}, updated_at = now()
            from candidates
            where exceptions.organization_id = ${organizationId}
              and exceptions.id = candidates.id
            returning exceptions.id, candidates.status as previous_status
          ),
          proposal_updates as (
            update resolution_proposals
            set status = 'superseded'
            where organization_id = ${organizationId}
              and status = 'pending'
              and exception_id in (select id from updated)
            returning id
          )
          insert into exception_status_events (
            organization_id, run_id, exception_id, previous_status, next_status, reason_code
          )
          select
            ${organizationId},
            ${runId},
            updated.id,
            updated.previous_status,
            'superseded',
            'not_observed_in_authoritative_run'
          from updated
          on conflict (organization_id, run_id, exception_id) do nothing
          returning exception_id
        `
      : await transaction`
          with candidates as materialized (
            select id, status
            from exceptions
            where organization_id = ${organizationId}
              and status in ('open', 'assigned', 'deferred', 'proposed', 'rejected')
              and stable_key not in ${transaction(observedExceptionKeys)}
            for update
          ),
          updated as (
            update exceptions
            set status = 'superseded', latest_run_id = ${runId}, updated_at = now()
            from candidates
            where exceptions.organization_id = ${organizationId}
              and exceptions.id = candidates.id
            returning exceptions.id, candidates.status as previous_status
          ),
          proposal_updates as (
            update resolution_proposals
            set status = 'superseded'
            where organization_id = ${organizationId}
              and status = 'pending'
              and exception_id in (select id from updated)
            returning id
          )
          insert into exception_status_events (
            organization_id, run_id, exception_id, previous_status, next_status, reason_code
          )
          select
            ${organizationId},
            ${runId},
            updated.id,
            updated.previous_status,
            'superseded',
            'not_observed_in_authoritative_run'
          from updated
          on conflict (organization_id, run_id, exception_id) do nothing
          returning exception_id
        `;
  return superseded.length;
}

async function shouldApplyOperationalState(
  transaction: TransactionSql,
  organizationId: OrganizationId,
  runId: string,
  createdAt: string,
): Promise<boolean> {
  const rows = await transaction`
    select not exists (
      select 1
      from reconciliation_runs
      where organization_id = ${organizationId}
        and status = 'succeeded'
        and (
          created_at > ${createdAt}::timestamptz
          or (created_at = ${createdAt}::timestamptz and id > ${runId}::uuid)
        )
    ) as should_apply
  `;
  return databaseBoolean(databaseRow(rows[0])["should_apply"], "should_apply");
}

function assertRunIdentity(
  row: Readonly<Record<string, unknown>>,
  identity: ReturnType<typeof identifyReconciliation>,
): void {
  const expected = {
    runKey: databaseScalar(row["stable_run_key"], "stable_run_key"),
    inputSnapshotHash: databaseScalar(row["input_snapshot_hash"], "input_snapshot_hash"),
    policySnapshotHash: databaseScalar(row["policy_snapshot_hash"], "policy_snapshot_hash"),
    ruleSetVersion: databaseScalar(row["rule_set_version"], "rule_set_version"),
    engineVersion: databaseScalar(row["engine_version"], "engine_version"),
  };
  if (
    identity.runKey !== expected.runKey ||
    identity.inputSnapshotHash !== expected.inputSnapshotHash ||
    identity.policySnapshotHash !== expected.policySnapshotHash ||
    identity.ruleSetVersion !== expected.ruleSetVersion ||
    identity.engineVersion !== expected.engineVersion
  ) {
    throw new ReconciliationRunExecutionError(
      "RUN_AUTHORITY_INVALID",
      "computed reconciliation identity does not match persisted authority",
    );
  }
}

function parsePolicy(value: unknown) {
  try {
    return parseReconciliationPolicySnapshot(value);
  } catch {
    throw new ReconciliationRunExecutionError(
      "RUN_AUTHORITY_INVALID",
      "persisted policy snapshot is invalid",
    );
  }
}

function parseCanonicalRecord(value: unknown): CanonicalRecord {
  try {
    return CanonicalRecordSchema.parse(value) as CanonicalRecord;
  } catch {
    throw new ReconciliationRunExecutionError(
      "RUN_INPUT_SNAPSHOT_INVALID",
      "persisted canonical record is invalid",
    );
  }
}

async function withOrganizationTransaction<T>(
  sql: Sql,
  organizationId: OrganizationId,
  operation: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
    return operation(transaction);
  }) as Promise<T>;
}

function uuidFromHash(hash: string): string {
  const value = hash.padEnd(32, "0").slice(0, 32);
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    `4${value.slice(13, 16)}`,
    `8${value.slice(17, 20)}`,
    value.slice(20, 32),
  ].join("-");
}

function databaseRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("database returned an invalid reconciliation row");
  }
  return value as Record<string, unknown>;
}

function databaseScalar(value: unknown, field: string): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  throw new Error(`database returned a non-scalar ${field}`);
}

function databaseInteger(value: unknown, field: string): number {
  const parsed = Number(databaseScalar(value, field));
  if (!Number.isSafeInteger(parsed)) throw new Error(`database returned an invalid ${field}`);
  return parsed;
}

function databaseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`database returned an invalid ${field}`);
  return value;
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      return item;
    }),
  ) as JSONValue;
}
