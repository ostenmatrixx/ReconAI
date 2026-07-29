import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const MAXIMUM_RECORDS = 100_000;
const WRITE_OPT_IN = "RECONAI_ALLOW_LOCAL_VERIFICATION_WRITES";
const recordCount = boundedRecordCount(
  process.env["RECONAI_RUN_CREATION_RECORDS"] ?? MAXIMUM_RECORDS.toString(),
);
const adminUrl = validatedDatabaseUrl(
  requiredEnvironment("DATABASE_ADMIN_URL"),
  "DATABASE_ADMIN_URL",
);
const applicationUrl = validatedDatabaseUrl(requiredEnvironment("DATABASE_URL"), "DATABASE_URL");
assertSafeRuntime();

const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const requireFromRoot = createRequire(new URL("../package.json", import.meta.url));
const tsxImportPath = requireFromRoot.resolve("tsx");
const childScriptPath = fileURLToPath(
  new URL("./reconciliation-run-creation-child.mjs", import.meta.url),
);
const postgres = (await import(requireFromApi.resolve("postgres"))).default;
const {
  MembershipIdSchema,
  OrganizationIdSchema,
  UserIdSchema,
  serializeCanonicalRecord,
  tenantContextFromMembership,
} = await import("../packages/domain/src/index.ts");
const { reconciliationRecordIdentity } = await import("../packages/reconciliation/src/index.ts");
const { defaultPolicy, syntheticOrder } = await import("../packages/test-support/src/index.ts");
const {
  PostgresReconciliationRepository,
  RECONCILIATION_RUN_INPUT_INSERT_BATCH_SIZE,
  RepositoryRunCreationUnavailableError,
  encodeReconciliationRunInputCursor,
} = await import("../apps/api/src/repository.ts");

const administrator = postgres(adminUrl.toString(), {
  connect_timeout: 5,
  idle_timeout: 5,
  max: 1,
});
const application = postgres(applicationUrl.toString(), {
  connect_timeout: 5,
  idle_timeout: 5,
  max: 2,
});

const organizationId = OrganizationIdSchema.parse(randomUUID());
const foreignOrganizationId = OrganizationIdSchema.parse(randomUUID());
const userId = UserIdSchema.parse(randomUUID());
const membershipId = MembershipIdSchema.parse(randomUUID());
const foreignMembershipId = MembershipIdSchema.parse(randomUUID());
const connectionId = randomUUID();
const tenant = tenantContextFromMembership({
  id: membershipId,
  organizationId,
  userId,
  role: "analyst",
  status: "active",
});
const foreignTenant = tenantContextFromMembership({
  id: foreignMembershipId,
  organizationId: foreignOrganizationId,
  userId,
  role: "analyst",
  status: "active",
});
const policy = {
  ...defaultPolicy,
  version: "maximum-run-creation-process-loss-verifier-v1",
  evaluatedAt: "2026-07-29T00:00:00.000Z",
};
const contentionPolicy = {
  ...policy,
  version: "maximum-run-creation-contention-verifier-v1",
};
const records = Array.from({ length: recordCount }, (_, index) =>
  syntheticOrder(
    {
      organizationId,
      customerReference: undefined,
    },
    10_000_000 + index,
  ),
);

try {
  const [administratorIdentity] = await administrator`
    select current_database() as database_name, current_setting('server_version') as server_version
  `;
  const [applicationIdentity] = await application`
    select
      current_database() as database_name,
      current_user as role_name,
      usesuper as is_superuser,
      rolbypassrls as bypasses_rls
    from pg_user
    join pg_roles on pg_roles.rolname = current_user
    where usename = current_user
  `;
  assert.equal(administratorIdentity?.database_name, applicationIdentity?.database_name);
  assertDisposableDatabaseName(administratorIdentity?.database_name);
  assert.equal(applicationIdentity?.role_name, "reconai_app");
  assert.equal(applicationIdentity?.is_superuser, false);
  assert.equal(applicationIdentity?.bypasses_rls, false);

  const seedStartedAt = performance.now();
  await administrator.begin(async (transaction) => {
    await transaction`set local statement_timeout = '300s'`;
    await transaction`
      insert into organizations (id, name) values
        (${organizationId}, 'Maximum run creation verification'),
        (${foreignOrganizationId}, 'Foreign maximum run creation verification')
    `;
    await transaction`
      insert into users (id, issuer, subject, email)
      values (
        ${userId},
        'https://run-creation-verifier.invalid',
        ${`synthetic-${userId}`},
        null
      )
    `;
    await transaction`
      insert into memberships (id, organization_id, user_id, role, status) values
        (${membershipId}, ${organizationId}, ${userId}, 'analyst', 'active'),
        (
          ${foreignMembershipId},
          ${foreignOrganizationId},
          ${userId},
          'analyst',
          'active'
        )
    `;
    await transaction`
      insert into data_source_connections (
        id, organization_id, provider, external_account_id, status, connector_version
      ) values (
        ${connectionId},
        ${organizationId},
        'shopify',
        ${`synthetic-${connectionId}`},
        'healthy',
        'maximum-run-creation-verifier-v1'
      )
    `;

    for (let offset = 0; offset < records.length; offset += 1_000) {
      const batch = records.slice(offset, offset + 1_000);
      const prepared = batch.map((record) => {
        const serialized = serializeCanonicalRecord(record);
        const identity = reconciliationRecordIdentity(record);
        return { record, serialized, identity };
      });
      const sourceValues = prepared.map(({ record, identity }) => ({
        id: record.provenance.sourceEventId,
        organization_id: organizationId,
        connection_id: connectionId,
        source: record.provenance.sourceSystem,
        external_event_id: `verification:${record.provenance.sourceEventId}`,
        external_object_type: record.provenance.externalObjectType,
        external_object_id: record.provenance.externalObjectId,
        source_timestamp: record.provenance.sourceTimestamp,
        received_at: record.provenance.ingestionTimestamp,
        connector_version: record.provenance.connectorVersion,
        payload_object_key: `verification/${organizationId}/events/${record.provenance.sourceEventId}.json`,
        payload_sha256: identity.contentSha256,
        status: "normalized",
      }));
      await transaction`
        insert into source_events ${transaction(
          sourceValues,
          "id",
          "organization_id",
          "connection_id",
          "source",
          "external_event_id",
          "external_object_type",
          "external_object_id",
          "source_timestamp",
          "received_at",
          "connector_version",
          "payload_object_key",
          "payload_sha256",
          "status",
        )}
      `;

      const canonicalValues = prepared.map(({ record, serialized, identity }) => ({
        id: record.id,
        organization_id: organizationId,
        version: record.version,
        kind: record.kind,
        source_event_id: record.provenance.sourceEventId,
        source: record.provenance.sourceSystem,
        external_object_type: record.provenance.externalObjectType,
        external_object_id: record.provenance.externalObjectId,
        source_timestamp: record.provenance.sourceTimestamp,
        ingestion_timestamp: record.provenance.ingestionTimestamp,
        effective_at: record.effectiveAt,
        connector_version: record.provenance.connectorVersion,
        normalizer_version: record.provenance.normalizerVersion,
        amount_minor: record.amount.minor.toString(),
        currency: record.amount.currency,
        order_reference: record.orderReference ?? null,
        customer_reference: record.customerReference ?? null,
        normalized_data: transaction.json(JSON.parse(JSON.stringify(serialized))),
        content_sha256: identity.contentSha256,
        is_incomplete: false,
      }));
      await transaction`
        insert into canonical_records ${transaction(
          canonicalValues,
          "id",
          "organization_id",
          "version",
          "kind",
          "source_event_id",
          "source",
          "external_object_type",
          "external_object_id",
          "source_timestamp",
          "ingestion_timestamp",
          "effective_at",
          "connector_version",
          "normalizer_version",
          "amount_minor",
          "currency",
          "order_reference",
          "customer_reference",
          "normalized_data",
          "content_sha256",
          "is_incomplete",
        )}
      `;
    }
    await transaction`analyze canonical_records`;
  });
  const seedDurationMilliseconds = roundedMilliseconds(performance.now() - seedStartedAt);

  const repository = new PostgresReconciliationRepository(application);
  let injectedFailureCode;
  let rollbackCounts;
  await administrator.unsafe(`
    create function reconai_verification_reject_run_input_batch()
    returns trigger
    language plpgsql
    as $verification$
    begin
      raise exception using
        errcode = '23514',
        message = 'verification-injected reconciliation run input batch rejection';
      return new;
    end
    $verification$
  `);
  await administrator.unsafe(`
    create trigger reconai_verification_reject_run_input_batch
    before insert on reconciliation_run_inputs
    for each row
    when (new.ordinal = 1000)
    execute function reconai_verification_reject_run_input_batch()
  `);
  try {
    await assert.rejects(
      repository.startRun(tenant, policy, {
        correlationId: randomUUID(),
        reason: "Verify atomic rollback after a later run-input batch is rejected",
      }),
      (error) => {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "23514"
        ) {
          return false;
        }
        injectedFailureCode = error.code;
        return true;
      },
    );
    [rollbackCounts] = await administrator`
      select
        (
          select count(*)::integer
          from reconciliation_runs
          where organization_id = ${organizationId}
        ) as run_rows,
        (
          select count(*)::integer
          from reconciliation_run_inputs
          where organization_id = ${organizationId}
        ) as input_rows,
        (
          select count(*)::integer
          from outbox_events
          where organization_id = ${organizationId}
            and event_type = 'reconciliation.run.requested'
        ) as outbox_events,
        (
          select count(*)::integer
          from audit_events
          where organization_id = ${organizationId}
            and action = 'reconciliation.run.requested'
        ) as audit_events
    `;
    assert.equal(rollbackCounts?.run_rows, 0);
    assert.equal(rollbackCounts?.input_rows, 0);
    assert.equal(rollbackCounts?.outbox_events, 0);
    assert.equal(rollbackCounts?.audit_events, 0);
  } finally {
    await administrator.unsafe(`
      drop trigger if exists reconai_verification_reject_run_input_batch
      on reconciliation_run_inputs
    `);
    await administrator.unsafe(`
      drop function if exists reconai_verification_reject_run_input_batch()
    `);
  }

  const transactionTimeoutMilliseconds = 5_000;
  const transactionTimeoutDelaySeconds = 7;
  const timeoutRepository = new PostgresReconciliationRepository(application, {
    runTransactionTimeoutMilliseconds: transactionTimeoutMilliseconds,
    maximumConcurrentRunTransactions: 2,
  });
  let timeoutErrorName;
  let timeoutRollbackCounts;
  let timeoutDurationMilliseconds;
  await installDelayTrigger(administrator, transactionTimeoutDelaySeconds);
  try {
    const timeoutStartedAt = performance.now();
    await assert.rejects(
      timeoutRepository.startRun(tenant, policy, {
        correlationId: randomUUID(),
        reason: "Verify transaction-timeout rollback after a later run-input batch begins",
      }),
      (error) => {
        if (!(error instanceof RepositoryRunCreationUnavailableError)) return false;
        timeoutErrorName = error.name;
        return true;
      },
    );
    timeoutDurationMilliseconds = roundedMilliseconds(performance.now() - timeoutStartedAt);
    timeoutRollbackCounts = await authorityCounts(administrator, organizationId);
    assertZeroAuthority(timeoutRollbackCounts);
  } finally {
    await removeDelayTrigger(administrator);
  }

  const cancellationDelaySeconds = 30;
  const cancellationController = new globalThis.AbortController();
  let cancellationErrorName;
  let cancellationRollbackCounts;
  let cancellationDurationMilliseconds;
  let laterBatchBackendPidBeforeCancellation;
  await installDelayTrigger(administrator, cancellationDelaySeconds);
  try {
    const cancellationStartedAt = performance.now();
    const cancelledRun = repository.startRun(tenant, policy, {
      correlationId: randomUUID(),
      reason: "Verify client-cancellation rollback after a later run-input batch begins",
      signal: cancellationController.signal,
    });
    laterBatchBackendPidBeforeCancellation = await waitForDelayedRunInputBatch(administrator);
    assert.ok(Number.isSafeInteger(laterBatchBackendPidBeforeCancellation));
    cancellationController.abort();
    await assert.rejects(cancelledRun, (error) => {
      if (!(error instanceof RepositoryRunCreationUnavailableError)) return false;
      cancellationErrorName = error.name;
      return true;
    });
    cancellationDurationMilliseconds = roundedMilliseconds(
      performance.now() - cancellationStartedAt,
    );
    cancellationRollbackCounts = await authorityCounts(administrator, organizationId);
    assertZeroAuthority(cancellationRollbackCounts);
  } finally {
    cancellationController.abort();
    await removeDelayTrigger(administrator);
  }

  const poolAdmissionResponseUpperBoundMilliseconds = 6_500;
  const poolAdmissionImmediateResponseUpperBoundMilliseconds = 1_000;
  const poolAdmissionConcurrentTransactions = 2;
  const poolAdmissionBurstAttempts = 32;
  const poolRelease = Promise.withResolvers();
  const poolHolders = [
    holdApplicationPoolConnection(application, poolRelease.promise),
    holdApplicationPoolConnection(application, poolRelease.promise),
  ];
  const poolHolderBackendPids = await Promise.all(poolHolders.map(({ acquired }) => acquired));
  assert.equal(new Set(poolHolderBackendPids).size, 2);
  const poolHolderActivity = await observePoolHolders(administrator, poolHolderBackendPids);
  assert.equal(poolHolderActivity.length, 2);
  assert.ok(poolHolderActivity.every((holder) => holder.state === "idle in transaction"));
  let poolAdmissionAttempts = [];
  let poolAdmissionOutcomes;
  let poolAdmissionBurstOutcomes;
  let poolAdmissionBurstDurationMilliseconds;
  let poolAdmissionPostDeadlineOutcome;
  let poolAdmissionRollbackCounts;
  let poolHolderActivityAfterResponse;
  try {
    const poolAdmissionStartedAt = performance.now();
    poolAdmissionAttempts = Array.from(
      { length: poolAdmissionConcurrentTransactions },
      (_, index) =>
        timeoutRepository.startRun(tenant, policy, {
          correlationId: randomUUID(),
          reason: `Verify expired admitted pool request ${String(index + 1)} cannot create authority`,
        }),
    );
    const timedAdmissionOutcomes = poolAdmissionAttempts.map(async (attempt) => {
      try {
        await attempt;
        return {
          status: "fulfilled",
          durationMilliseconds: roundedMilliseconds(performance.now() - poolAdmissionStartedAt),
        };
      } catch (error) {
        return {
          status: "rejected",
          errorName: error instanceof Error ? error.name : "unknown",
          retrySafe: error instanceof RepositoryRunCreationUnavailableError,
          durationMilliseconds: roundedMilliseconds(performance.now() - poolAdmissionStartedAt),
        };
      }
    });
    const poolAdmissionBurstStartedAt = performance.now();
    poolAdmissionBurstOutcomes = await Promise.all(
      Array.from({ length: poolAdmissionBurstAttempts }, async (_, index) => {
        try {
          await timeoutRepository.startRun(tenant, policy, {
            correlationId: randomUUID(),
            reason: `Verify saturated run-creation burst rejection ${String(index + 1)}`,
          });
          return { status: "fulfilled" };
        } catch (error) {
          return {
            status: "rejected",
            errorName: error instanceof Error ? error.name : "unknown",
            retrySafe: error instanceof RepositoryRunCreationUnavailableError,
          };
        }
      }),
    );
    poolAdmissionBurstDurationMilliseconds = roundedMilliseconds(
      performance.now() - poolAdmissionBurstStartedAt,
    );
    assert.equal(poolAdmissionBurstOutcomes.length, poolAdmissionBurstAttempts);
    assert.ok(
      poolAdmissionBurstOutcomes.every(
        (outcome) => outcome.status === "rejected" && outcome.retrySafe,
      ),
    );
    assert.ok(
      poolAdmissionBurstDurationMilliseconds <=
        poolAdmissionImmediateResponseUpperBoundMilliseconds,
    );
    poolAdmissionOutcomes = await Promise.all(timedAdmissionOutcomes);
    assert.equal(poolAdmissionOutcomes.length, poolAdmissionConcurrentTransactions);
    assert.ok(
      poolAdmissionOutcomes.every(
        (outcome) =>
          outcome.status === "rejected" &&
          outcome.retrySafe &&
          outcome.durationMilliseconds >= transactionTimeoutMilliseconds - 100 &&
          outcome.durationMilliseconds <= poolAdmissionResponseUpperBoundMilliseconds,
      ),
    );
    const postDeadlineStartedAt = performance.now();
    try {
      await timeoutRepository.startRun(tenant, policy, {
        correlationId: randomUUID(),
        reason: "Verify hidden pool work retains admission after public deadline settlement",
      });
      poolAdmissionPostDeadlineOutcome = { status: "fulfilled" };
    } catch (error) {
      poolAdmissionPostDeadlineOutcome = {
        status: "rejected",
        errorName: error instanceof Error ? error.name : "unknown",
        retrySafe: error instanceof RepositoryRunCreationUnavailableError,
        durationMilliseconds: roundedMilliseconds(performance.now() - postDeadlineStartedAt),
      };
    }
    assert.deepEqual(poolAdmissionPostDeadlineOutcome, {
      status: "rejected",
      errorName: "RepositoryRunCreationUnavailableError",
      retrySafe: true,
      durationMilliseconds: poolAdmissionPostDeadlineOutcome.durationMilliseconds,
    });
    assert.ok(
      poolAdmissionPostDeadlineOutcome.durationMilliseconds <=
        poolAdmissionImmediateResponseUpperBoundMilliseconds,
    );
    poolHolderActivityAfterResponse = await observePoolHolders(
      administrator,
      poolHolderBackendPids,
    );
    assert.equal(poolHolderActivityAfterResponse.length, 2);
    assert.ok(
      poolHolderActivityAfterResponse.every((holder) => holder.state === "idle in transaction"),
    );
    poolRelease.resolve();
    await Promise.all(poolHolders.map(({ completion }) => completion));
    await Promise.all([application`select 1 as pool_drain`, application`select 1 as pool_drain`]);
    poolAdmissionRollbackCounts = await authorityCounts(administrator, organizationId);
    assertZeroAuthority(poolAdmissionRollbackCounts);
  } finally {
    poolRelease.resolve();
    await Promise.allSettled(poolHolders.map(({ completion }) => completion));
    await Promise.allSettled(poolAdmissionAttempts);
  }

  const processLossDelaySeconds = 5;
  let processLossBackendPid;
  let processLossExit;
  let processLossAuthorityBeforeRetry;
  let processLossBackendRemoval;
  let processLossCreator;
  await installDelayTrigger(administrator, processLossDelaySeconds);
  try {
    processLossCreator = launchRunCreator();
    assert.ok(processLossCreator);
    processLossBackendPid = await waitForDelayedRunInputBatch(administrator);
    assert.ok(Number.isSafeInteger(processLossBackendPid));
    assert.equal(processLossCreator.child.kill("SIGKILL"), true);
    processLossExit = await processLossCreator.completion;
    assert.equal(processLossExit.code, null);
    assert.equal(processLossExit.signal, "SIGKILL");
    processLossBackendRemoval = await waitForBackendRemoval(administrator, processLossBackendPid);
    assert.equal(processLossBackendRemoval.removed, true);
    processLossAuthorityBeforeRetry = await policyAuthorityState(
      administrator,
      organizationId,
      policy.version,
    );
    assertAtomicAuthorityOutcome(processLossAuthorityBeforeRetry, recordCount);
  } finally {
    processLossCreator?.child.kill("SIGKILL");
    await removeDelayTrigger(administrator);
  }

  const processLossRecoveryExit = await launchRunCreator(policy).completion;
  const processLossRecovery = parseRunCreatorSuccess(processLossRecoveryExit);
  const processLossAuthorityAfterRetry = await policyAuthorityState(
    administrator,
    organizationId,
    policy.version,
  );
  assertCompleteAuthority(processLossAuthorityAfterRetry, recordCount);
  assert.equal(processLossAuthorityAfterRetry?.run_id, processLossRecovery.run.id);
  if (processLossAuthorityBeforeRetry?.run_rows === 1) {
    assert.equal(processLossAuthorityBeforeRetry.run_id, processLossRecovery.run.id);
  }

  const creationStartedAt = performance.now();
  const creators = [launchRunCreator(contentionPolicy), launchRunCreator(contentionPolicy)];
  const contentionObservation = await waitForIndependentCreatorContention(
    administrator,
    creators.map(({ child }) => child.pid),
  );
  assert.equal(contentionObservation.creatorBackends, 2);
  assert.ok(contentionObservation.advisoryWaiters >= 1);
  const creatorExits = await Promise.all(creators.map((creator) => creator.completion));
  const creatorResults = creatorExits.map(parseRunCreatorSuccess);
  assert.equal(creatorResults.length, 2);
  const creationDurationMilliseconds = roundedMilliseconds(performance.now() - creationStartedAt);
  const run = creatorResults[0]?.run;
  const repeat = creatorResults[1];
  assert.ok(run);
  assert.ok(repeat);
  assert.deepEqual(repeat.run, run);
  const residentSetGrowthBytes = Math.max(
    ...creatorResults.map((result) => result.residentSetGrowthBytes),
  );
  assert.equal(run.status, "queued");
  assert.equal(run.inputCount, recordCount);
  assert.equal(run.dispatchCount, 1);
  const repeatDurationMilliseconds = repeat.durationMilliseconds;
  const contentionAuthorityState = await policyAuthorityState(
    administrator,
    organizationId,
    contentionPolicy.version,
  );
  assertCompleteAuthority(contentionAuthorityState, recordCount);

  const [counts] = await administrator`
    select
      reconciliation_runs.input_count,
      reconciliation_runs.status,
      length(reconciliation_runs.input_snapshot_hash)::integer as input_hash_length,
      count(distinct reconciliation_run_inputs.ordinal)::integer as unique_ordinals,
      min(reconciliation_run_inputs.ordinal)::integer as minimum_ordinal,
      max(reconciliation_run_inputs.ordinal)::integer as maximum_ordinal,
      count(reconciliation_run_inputs.*)::integer as persisted_inputs,
      (
        select count(*)::integer
        from outbox_events
        where organization_id = ${organizationId}
          and event_type = 'reconciliation.run.requested'
          and idempotency_key = ${`reconciliation-run:${run.id}:dispatch:1`}
      ) as outbox_events,
      (
        select count(*)::integer
        from audit_events
        where organization_id = ${organizationId}
          and resource_id = ${run.id}
          and action = 'reconciliation.run.requested'
      ) as audit_events
    from reconciliation_runs
    join reconciliation_run_inputs
      on reconciliation_run_inputs.organization_id = reconciliation_runs.organization_id
      and reconciliation_run_inputs.run_id = reconciliation_runs.id
    where reconciliation_runs.organization_id = ${organizationId}
      and reconciliation_runs.id = ${run.id}
    group by
      reconciliation_runs.input_count,
      reconciliation_runs.status,
      reconciliation_runs.input_snapshot_hash
  `;
  assert.equal(counts?.input_count, recordCount);
  assert.equal(counts?.status, "queued");
  assert.equal(counts?.input_hash_length, 64);
  assert.equal(counts?.unique_ordinals, recordCount);
  assert.equal(counts?.minimum_ordinal, 0);
  assert.equal(counts?.maximum_ordinal, recordCount - 1);
  assert.equal(counts?.persisted_inputs, recordCount);
  assert.equal(counts?.outbox_events, 1);
  assert.equal(counts?.audit_events, 1);
  const organizationAuthorityTotals = await authorityCounts(administrator, organizationId);
  assert.equal(organizationAuthorityTotals?.run_rows, 2);
  assert.equal(organizationAuthorityTotals?.input_rows, recordCount * 2);
  assert.equal(organizationAuthorityTotals?.outbox_events, 2);
  assert.equal(organizationAuthorityTotals?.audit_events, 2);

  const firstPage = await repository.listRunInputs(tenant, run.id, { limit: 100 });
  assert.equal(firstPage?.items.length, 100);
  assert.equal(firstPage?.items[0]?.ordinal, 0);
  assert.equal(firstPage?.items.at(-1)?.ordinal, 99);
  assert.ok(firstPage?.nextCursor);
  const lastPage = await repository.listRunInputs(tenant, run.id, {
    limit: 100,
    cursor: encodeReconciliationRunInputCursor(organizationId, run.id, recordCount - 101),
  });
  assert.equal(lastPage?.items.length, 100);
  assert.equal(lastPage?.items[0]?.ordinal, recordCount - 100);
  assert.equal(lastPage?.items.at(-1)?.ordinal, recordCount - 1);
  assert.equal(lastPage?.nextCursor, undefined);

  const foreignRun = await repository.getRun(foreignTenant, run.id);
  const foreignInputs = await repository.listRunInputs(foreignTenant, run.id, {
    limit: 100,
  });
  assert.equal(foreignRun, undefined);
  assert.equal(foreignInputs, undefined);

  process.stdout.write(
    `${JSON.stringify(
      {
        evidenceType: "reconciliation-run-creation-admission-pressure-verification",
        recordedAt: new Date().toISOString(),
        scope:
          "Fresh loopback PostgreSQL synthetic restricted-role run creation at the configured 100,000-record ceiling; no rule execution, production, or staging system was used",
        database: {
          serverVersion: administratorIdentity?.server_version,
          applicationRole: applicationIdentity?.role_name,
          applicationRoleSuperuser: applicationIdentity?.is_superuser,
          applicationRoleBypassesRls: applicationIdentity?.bypasses_rls,
        },
        fixture: {
          schemaValidCanonicalRecords: recordCount,
          contentHashesMatchCanonicalJson: true,
          seedBatchSize: 1_000,
          seedDurationMilliseconds,
          fieldProvenanceRowsInserted: false,
        },
        atomicRollback: {
          injectedFailureCode,
          rejectedOrdinal: 1_000,
          firstBatchStatementExecutedBeforeRejection: true,
          expectedInputInsertStatementsThroughRejectedBatch: 2,
          runRowsAfterRollback: rollbackCounts?.run_rows,
          inputRowsAfterRollback: rollbackCounts?.input_rows,
          outboxEventsAfterRollback: rollbackCounts?.outbox_events,
          auditEventsAfterRollback: rollbackCounts?.audit_events,
          verifierTriggerRemovedBeforeRecovery: true,
          recoveredWithSameDeterministicSnapshot: true,
        },
        transactionTimeoutRollback: {
          configuredTimeoutMilliseconds: transactionTimeoutMilliseconds,
          verifierDelaySeconds: transactionTimeoutDelaySeconds,
          timeoutErrorName,
          durationMilliseconds: timeoutDurationMilliseconds,
          rejectedOrdinal: 1_000,
          firstBatchStatementExecutedBeforeInterruption: true,
          runRowsAfterRollback: timeoutRollbackCounts?.run_rows,
          inputRowsAfterRollback: timeoutRollbackCounts?.input_rows,
          outboxEventsAfterRollback: timeoutRollbackCounts?.outbox_events,
          auditEventsAfterRollback: timeoutRollbackCounts?.audit_events,
          verifierTriggerRemovedBeforeRecovery: true,
        },
        clientCancellationRollback: {
          verifierDelaySeconds: cancellationDelaySeconds,
          cancellationErrorName,
          durationMilliseconds: cancellationDurationMilliseconds,
          rejectedOrdinal: 1_000,
          laterBatchObservedBeforeCancellation: Number.isSafeInteger(
            laterBatchBackendPidBeforeCancellation,
          ),
          delayedBackendPid: laterBatchBackendPidBeforeCancellation,
          firstBatchStatementExecutedBeforeInterruption: true,
          runRowsAfterRollback: cancellationRollbackCounts?.run_rows,
          inputRowsAfterRollback: cancellationRollbackCounts?.input_rows,
          outboxEventsAfterRollback: cancellationRollbackCounts?.outbox_events,
          auditEventsAfterRollback: cancellationRollbackCounts?.audit_events,
          verifierTriggerRemovedBeforeRecovery: true,
        },
        poolAdmissionDeadline: {
          configuredDeadlineMilliseconds: transactionTimeoutMilliseconds,
          responseUpperBoundMilliseconds: poolAdmissionResponseUpperBoundMilliseconds,
          immediateResponseUpperBoundMilliseconds:
            poolAdmissionImmediateResponseUpperBoundMilliseconds,
          poolMaximumConnections: 2,
          maximumConcurrentRunTransactions: poolAdmissionConcurrentTransactions,
          holderActivityBeforeRequest: poolHolderActivity,
          holderActivityAfterResponse: poolHolderActivityAfterResponse,
          admittedOutcomes: poolAdmissionOutcomes,
          admittedRequestsSettledBeforeCapacityRelease: true,
          burstAttempts: poolAdmissionBurstAttempts,
          burstOutcomes: poolAdmissionBurstOutcomes,
          burstDurationMilliseconds: poolAdmissionBurstDurationMilliseconds,
          burstDatabaseOperationsAdmitted: 0,
          postDeadlineAttempt: poolAdmissionPostDeadlineOutcome,
          hiddenOperationsRetainedAdmissionUntilDrain: true,
          capacityReleasedAfterResponse: true,
          expiredDatabaseOperationsDrainedAfterRelease: poolAdmissionConcurrentTransactions,
          runRowsAfterExpiredAdmission: poolAdmissionRollbackCounts?.run_rows,
          inputRowsAfterExpiredAdmission: poolAdmissionRollbackCounts?.input_rows,
          outboxEventsAfterExpiredAdmission: poolAdmissionRollbackCounts?.outbox_events,
          auditEventsAfterExpiredAdmission: poolAdmissionRollbackCounts?.audit_events,
          laterAuthorityCreated: false,
        },
        processLossAtomicity: {
          verifierDelaySeconds: processLossDelaySeconds,
          terminatedSignal: processLossExit?.signal,
          processId: processLossCreator?.child.pid,
          delayedBackendPid: processLossBackendPid,
          laterBatchObservedBeforeTermination: Number.isSafeInteger(processLossBackendPid),
          backendRemovedAfterTermination: processLossBackendRemoval?.removed,
          backendRemovalDurationMilliseconds: processLossBackendRemoval?.durationMilliseconds,
          rejectedOrdinal: 1_000,
          firstBatchStatementExecutedBeforeInterruption: true,
          outcomeBeforeRetry:
            processLossAuthorityBeforeRetry?.run_rows === 0 ? "rolled-back" : "fully-committed",
          authorityBeforeRetry: processLossAuthorityBeforeRetry,
          verifierTriggerRemovedBeforeRecovery: true,
          recoveryProcess: {
            processId: processLossRecovery.processId,
            durationMilliseconds: processLossRecovery.durationMilliseconds,
            runId: processLossRecovery.run.id,
          },
          recoveryReturnedPreviouslyCommittedAuthority:
            processLossAuthorityBeforeRetry?.run_rows === 0
              ? "not-applicable"
              : processLossRecovery.run.id === processLossAuthorityBeforeRetry?.run_id,
          authorityAfterRetry: processLossAuthorityAfterRetry,
          exactlyOnceAfterRetry: true,
        },
        independentProcessContention: {
          policyVersion: contentionPolicy.version,
          liveDatabaseObservation: contentionObservation,
          creatorProcesses: creatorResults.map((result) => ({
            processId: result.processId,
            durationMilliseconds: result.durationMilliseconds,
            residentSetGrowthBytes: result.residentSetGrowthBytes,
          })),
          allExitedSuccessfully: creatorExits.every(
            (result) => result.code === 0 && result.signal === null,
          ),
          sameRunAuthority: true,
          wallDurationMilliseconds: creationDurationMilliseconds,
          authorityState: contentionAuthorityState,
          persistedInputs: counts?.persisted_inputs,
          outboxEvents: counts?.outbox_events,
          auditEvents: counts?.audit_events,
        },
        run: {
          id: run.id,
          status: run.status,
          inputCount: run.inputCount,
          dispatchCount: run.dispatchCount,
          expectedInputInsertStatements: Math.ceil(
            recordCount / RECONCILIATION_RUN_INPUT_INSERT_BATCH_SIZE,
          ),
          inputInsertBatchSize: RECONCILIATION_RUN_INPUT_INSERT_BATCH_SIZE,
          creationDurationMilliseconds,
          residentSetGrowthBytes,
          persistedInputs: counts?.persisted_inputs,
          uniqueOrdinals: counts?.unique_ordinals,
          minimumOrdinal: counts?.minimum_ordinal,
          maximumOrdinal: counts?.maximum_ordinal,
          outboxEvents: counts?.outbox_events,
          auditEvents: counts?.audit_events,
        },
        organizationAuthorityTotals,
        idempotentRepeat: {
          secondIndependentCreatorSameRunAuthority: true,
          durationMilliseconds: repeatDurationMilliseconds,
          runRows: 1,
          outboxEvents: counts?.outbox_events,
          auditEvents: counts?.audit_events,
        },
        paginationBoundary: {
          firstPageOrdinals: [0, 99],
          lastPageOrdinals: [recordCount - 100, recordCount - 1],
          lastPageHasNextCursor: false,
        },
        tenantIsolation: {
          foreignRunResult: "undefined",
          foreignInputResult: "undefined",
        },
        safety: {
          loopbackOnly: true,
          explicitSyntheticWriteOptIn: true,
          moneyOrRuleBehaviorChanged: false,
          workerOrRuleExecutionPerformed: false,
          productionDataUsed: false,
          productionOrStagingAccessed: false,
        },
        limitations: [
          "The synthetic fixture contains valid canonical order JSON and matching content hashes but omits field-provenance rows because this verifier isolates run authority creation.",
          "Timing is a single local workstation observation and is not an API SLO, capacity guarantee, or production projection.",
          "The pool-pressure exercise proves one API process admits at most two heavyweight run transactions, rejects a bounded burst without entering postgres.js, retains leases after public deadline settlement, and drains expired operations without authority. Multi-replica admission remains the product of each replica's cap, so shared request admission and queue monitoring remain necessary.",
          "The client-cancellation exercise drives the repository AbortSignal directly after PostgreSQL reports the verifier-only second-batch delay; it does not emulate a real proxy or socket disconnect.",
          "Abrupt client-process loss has an inherently ambiguous commit outcome: PostgreSQL may roll back after detecting the closed connection or finish the atomic transaction first. The verifier accepts only zero authority or one fully complete authority, then requires an identical retry to converge on exactly one.",
          "Independent-process contention is exercised on one host and one PostgreSQL instance; multi-host partitions, process supervisors, ingress behavior, and protected staging remain open.",
          "The run remains queued; worker execution, result persistence, and browser behavior are covered separately or remain open.",
          "The verifier intentionally leaves its synthetic tenant in the disposable database; destroy the fresh cluster after recording evidence.",
        ],
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await Promise.allSettled([administrator.end({ timeout: 5 }), application.end({ timeout: 5 })]);
}

function boundedRecordCount(raw) {
  if (!/^[1-9][0-9]{0,5}$/u.test(raw)) {
    throw new Error("RECONAI_RUN_CREATION_RECORDS must be a positive integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 101 || value > MAXIMUM_RECORDS) {
    throw new Error(
      `RECONAI_RUN_CREATION_RECORDS must be between 101 and ${MAXIMUM_RECORDS.toString()}`,
    );
  }
  return value;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validatedDatabaseUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute PostgreSQL URL`);
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error(`${name} must use PostgreSQL`);
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error(`${name} must target loopback infrastructure`);
  }
  return url;
}

function assertSafeRuntime() {
  if (process.env["NODE_ENV"] === "production" || process.env["APP_ENV"] === "production") {
    throw new Error("maximum run creation verification is disabled in production");
  }
  if (process.env[WRITE_OPT_IN] !== "1") {
    throw new Error(`${WRITE_OPT_IN}=1 is required because this verifier inserts synthetic rows`);
  }
}

function assertDisposableDatabaseName(value) {
  if (
    typeof value !== "string" ||
    ["postgres", "template0", "template1"].includes(value) ||
    !/(?:test|verify|verification|run_creation)/iu.test(value)
  ) {
    throw new Error(
      "the verifier requires a disposable database whose name includes test, verify, verification, or run_creation",
    );
  }
}

function roundedMilliseconds(value) {
  return Number(value.toFixed(2));
}

async function installDelayTrigger(database, delaySeconds) {
  assert.ok(Number.isSafeInteger(delaySeconds) && delaySeconds >= 1 && delaySeconds <= 60);
  await database.unsafe(`
    create function reconai_verification_delay_run_input_batch()
    returns trigger
    language plpgsql
    as $verification$
    begin
      perform pg_sleep(${delaySeconds.toString()});
      return new;
    end
    $verification$
  `);
  await database.unsafe(`
    create trigger reconai_verification_delay_run_input_batch
    before insert on reconciliation_run_inputs
    for each row
    when (new.ordinal = 1000)
    execute function reconai_verification_delay_run_input_batch()
  `);
}

async function removeDelayTrigger(database) {
  await database.unsafe(`
    drop trigger if exists reconai_verification_delay_run_input_batch
    on reconciliation_run_inputs
  `);
  await database.unsafe(`
    drop function if exists reconai_verification_delay_run_input_batch()
  `);
}

async function waitForDelayedRunInputBatch(database) {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    const [row] = await database`
      select pid
      from pg_stat_activity
      where usename = 'reconai_app'
        and wait_event = 'PgSleep'
        and query like '%insert into reconciliation_run_inputs%'
      order by pid
      limit 1
    `;
    if (Number.isSafeInteger(row?.pid)) return row.pid;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }
  return undefined;
}

async function waitForBackendRemoval(database, backendPid) {
  const startedAt = performance.now();
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const [row] = await database`
      select not exists (
        select 1
        from pg_stat_activity
        where pid = ${backendPid}
      ) as removed
    `;
    if (row?.removed === true) {
      return {
        removed: true,
        durationMilliseconds: roundedMilliseconds(performance.now() - startedAt),
      };
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }
  return {
    removed: false,
    durationMilliseconds: roundedMilliseconds(performance.now() - startedAt),
  };
}

function holdApplicationPoolConnection(database, releasePromise) {
  const acquisition = Promise.withResolvers();
  const completion = database.begin(async (transaction) => {
    const [row] = await transaction`select pg_backend_pid() as backend_pid`;
    assert.ok(Number.isSafeInteger(row?.backend_pid));
    acquisition.resolve(row.backend_pid);
    await releasePromise;
  });
  void completion.catch((error) => {
    acquisition.reject(error);
  });
  return {
    acquired: acquisition.promise,
    completion,
  };
}

async function observePoolHolders(database, backendPids) {
  assert.equal(backendPids.length, 2);
  const rows = await database`
    select pid, state, wait_event_type, wait_event
    from pg_stat_activity
    where pid in (${backendPids[0]}, ${backendPids[1]})
    order by pid
  `;
  return rows.map((row) => ({
    backendPid: row.pid,
    state: row.state,
    waitEventType: row.wait_event_type,
    waitEvent: row.wait_event,
  }));
}

async function waitForIndependentCreatorContention(database, processIds) {
  assert.equal(processIds.length, 2);
  assert.ok(processIds.every((processId) => Number.isSafeInteger(processId)));
  const expectedApplicationNames = new Set(
    processIds.map((processId) => `reconai-run-creator:${processId.toString()}`),
  );
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    const rows = await database`
      select
        pid,
        application_name,
        state,
        wait_event_type,
        wait_event
      from pg_stat_activity
      where datname = current_database()
        and application_name like 'reconai-run-creator:%'
      order by pid
    `;
    const creators = rows.filter((row) => expectedApplicationNames.has(row.application_name));
    const advisoryWaiters = creators.filter(
      (row) => row.wait_event_type === "Lock" && row.wait_event === "advisory",
    );
    if (creators.length === 2 && advisoryWaiters.length >= 1) {
      return {
        creatorBackends: creators.length,
        advisoryWaiters: advisoryWaiters.length,
        backendPids: creators.map((row) => row.pid),
        processIds,
        waiterStates: advisoryWaiters.map((row) => row.state),
        waiterEvents: advisoryWaiters.map((row) => ({
          type: row.wait_event_type,
          name: row.wait_event,
        })),
      };
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }
  throw new Error("two independent run creators were not observed contending on the advisory lock");
}

async function authorityCounts(database, organizationId) {
  const [counts] = await database`
    select
      (
        select count(*)::integer
        from reconciliation_runs
        where organization_id = ${organizationId}
      ) as run_rows,
      (
        select count(*)::integer
        from reconciliation_run_inputs
        where organization_id = ${organizationId}
      ) as input_rows,
      (
        select count(*)::integer
        from outbox_events
        where organization_id = ${organizationId}
          and event_type = 'reconciliation.run.requested'
      ) as outbox_events,
      (
        select count(*)::integer
        from audit_events
        where organization_id = ${organizationId}
          and action = 'reconciliation.run.requested'
      ) as audit_events
  `;
  return counts;
}

async function policyAuthorityState(database, organizationId, policyVersion) {
  const [state] = await database`
    with selected_runs as (
      select id, status, input_count
      from reconciliation_runs
      where organization_id = ${organizationId}
        and policy_version = ${policyVersion}
    )
    select
      (select count(*)::integer from selected_runs) as run_rows,
      (
        select count(*)::integer
        from selected_runs
        where status = 'queued'
      ) as queued_run_rows,
      (
        select coalesce(sum(input_count), 0)::integer
        from selected_runs
      ) as declared_input_rows,
      (select min(id::text) from selected_runs) as run_id,
      (
        select count(*)::integer
        from reconciliation_run_inputs
        join selected_runs
          on selected_runs.id = reconciliation_run_inputs.run_id
        where reconciliation_run_inputs.organization_id = ${organizationId}
      ) as input_rows,
      (
        select count(distinct reconciliation_run_inputs.ordinal)::integer
        from reconciliation_run_inputs
        join selected_runs
          on selected_runs.id = reconciliation_run_inputs.run_id
        where reconciliation_run_inputs.organization_id = ${organizationId}
      ) as unique_ordinals,
      (
        select min(reconciliation_run_inputs.ordinal)::integer
        from reconciliation_run_inputs
        join selected_runs
          on selected_runs.id = reconciliation_run_inputs.run_id
        where reconciliation_run_inputs.organization_id = ${organizationId}
      ) as minimum_ordinal,
      (
        select max(reconciliation_run_inputs.ordinal)::integer
        from reconciliation_run_inputs
        join selected_runs
          on selected_runs.id = reconciliation_run_inputs.run_id
        where reconciliation_run_inputs.organization_id = ${organizationId}
      ) as maximum_ordinal,
      (
        select count(*)::integer
        from outbox_events
        join selected_runs
          on outbox_events.idempotency_key =
            'reconciliation-run:' || selected_runs.id::text || ':dispatch:1'
        where outbox_events.organization_id = ${organizationId}
          and outbox_events.event_type = 'reconciliation.run.requested'
      ) as outbox_events,
      (
        select count(*)::integer
        from audit_events
        join selected_runs
          on selected_runs.id::text = audit_events.resource_id
        where audit_events.organization_id = ${organizationId}
          and audit_events.action = 'reconciliation.run.requested'
      ) as audit_events
  `;
  return state;
}

function assertZeroAuthority(counts) {
  assert.equal(counts?.run_rows, 0);
  assert.equal(counts?.input_rows, 0);
  assert.equal(counts?.outbox_events, 0);
  assert.equal(counts?.audit_events, 0);
}

function assertAtomicAuthorityOutcome(state, expectedInputCount) {
  assert.ok(state?.run_rows === 0 || state?.run_rows === 1);
  if (state.run_rows === 0) {
    assert.equal(state.queued_run_rows, 0);
    assert.equal(state.declared_input_rows, 0);
    assert.equal(state.run_id, null);
    assert.equal(state.input_rows, 0);
    assert.equal(state.unique_ordinals, 0);
    assert.equal(state.minimum_ordinal, null);
    assert.equal(state.maximum_ordinal, null);
    assert.equal(state.outbox_events, 0);
    assert.equal(state.audit_events, 0);
    return;
  }
  assertCompleteAuthority(state, expectedInputCount);
}

function assertCompleteAuthority(state, expectedInputCount) {
  assert.equal(state?.run_rows, 1);
  assert.equal(state?.queued_run_rows, 1);
  assert.equal(state?.declared_input_rows, expectedInputCount);
  assert.ok(typeof state?.run_id === "string");
  assert.equal(state?.input_rows, expectedInputCount);
  assert.equal(state?.unique_ordinals, expectedInputCount);
  assert.equal(state?.minimum_ordinal, 0);
  assert.equal(state?.maximum_ordinal, expectedInputCount - 1);
  assert.equal(state?.outbox_events, 1);
  assert.equal(state?.audit_events, 1);
}

function launchRunCreator(runPolicy = policy) {
  const child = spawnProcess(
    process.execPath,
    ["--conditions=development", "--import", tsxImportPath, childScriptPath],
    {
      env: {
        APP_ENV: "test",
        DATABASE_URL: applicationUrl.toString(),
        NODE_ENV: "test",
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        RECONAI_ALLOW_LOCAL_VERIFICATION_WRITES: "1",
        RECONAI_VERIFICATION_MEMBERSHIP_ID: membershipId,
        RECONAI_VERIFICATION_ORGANIZATION_ID: organizationId,
        RECONAI_VERIFICATION_POLICY_EVALUATED_AT: runPolicy.evaluatedAt,
        RECONAI_VERIFICATION_POLICY_VERSION: runPolicy.version,
        RECONAI_VERIFICATION_USER_ID: userId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
  return { child, completion };
}

function parseRunCreatorSuccess(exit) {
  assert.equal(exit.code, 0, exit.stderr);
  assert.equal(exit.signal, null);
  assert.equal(exit.stderr, "");
  const result = JSON.parse(exit.stdout);
  assert.ok(isObject(result));
  assert.ok(Number.isSafeInteger(result.processId));
  assert.ok(typeof result.durationMilliseconds === "number");
  assert.ok(Number.isSafeInteger(result.residentSetGrowthBytes));
  assert.ok(isObject(result.run));
  assert.ok(typeof result.run.id === "string");
  assert.equal(result.run.status, "queued");
  return result;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
