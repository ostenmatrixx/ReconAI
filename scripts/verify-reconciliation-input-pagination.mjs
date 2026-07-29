import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const MAXIMUM_RECORDS = 100_000;
const WRITE_OPT_IN = "RECONAI_ALLOW_LOCAL_VERIFICATION_WRITES";
const execFileAsync = promisify(execFile);
const readerVerifierPath = fileURLToPath(
  new URL("./verify-reconciliation-input-pagination-reader.mjs", import.meta.url),
);
const recordCount = boundedRecordCount(
  process.env["RECONAI_INPUT_PAGINATION_RECORDS"] ?? MAXIMUM_RECORDS.toString(),
);
const adminUrl = validatedDatabaseUrl(
  requiredEnvironment("DATABASE_ADMIN_URL"),
  "DATABASE_ADMIN_URL",
);
const applicationUrl = validatedDatabaseUrl(requiredEnvironment("DATABASE_URL"), "DATABASE_URL");
assertSafeRuntime();

const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const postgres = (await import(requireFromApi.resolve("postgres"))).default;
const { MembershipIdSchema, OrganizationIdSchema, UserIdSchema, tenantContextFromMembership } =
  await import("../packages/domain/src/index.ts");
const { PostgresReconciliationRepository, RepositoryCursorError } =
  await import("../apps/api/src/repository.ts");

const administrator = postgres(adminUrl.toString(), {
  connect_timeout: 5,
  idle_timeout: 5,
  max: 1,
});
const application = postgres(applicationUrl.toString(), {
  connect_timeout: 5,
  idle_timeout: 5,
  max: 4,
});

const organizationId = OrganizationIdSchema.parse(randomUUID());
const foreignOrganizationId = OrganizationIdSchema.parse(randomUUID());
const userId = UserIdSchema.parse(randomUUID());
const membershipId = MembershipIdSchema.parse(randomUUID());
const foreignMembershipId = MembershipIdSchema.parse(randomUUID());
const connectionId = randomUUID();
const runId = randomUUID();
const otherRunId = randomUUID();
const fixtureSeed = randomUUID();
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
  assert.equal(
    administratorIdentity?.database_name,
    applicationIdentity?.database_name,
    "administrator and application URLs must target the same database",
  );
  assertDisposableDatabaseName(administratorIdentity?.database_name);
  assert.equal(
    applicationIdentity?.role_name,
    "reconai_app",
    "DATABASE_URL must use the restricted reconai_app role",
  );
  assert.equal(applicationIdentity?.is_superuser, false, "reconai_app must not be a superuser");
  assert.equal(applicationIdentity?.bypasses_rls, false, "reconai_app must not bypass RLS");

  const seedStartedAt = performance.now();
  await administrator.begin(async (transaction) => {
    await transaction`set local statement_timeout = '180s'`;
    await transaction`
      create temporary table reconciliation_input_pagination_fixture (
        ordinal integer primary key,
        source_event_id uuid not null,
        record_id uuid not null,
        content_sha256 char(64) not null
      ) on commit drop
    `;
    await transaction`
      insert into reconciliation_input_pagination_fixture (
        ordinal, source_event_id, record_id, content_sha256
      )
      select
        candidate.ordinal,
        gen_random_uuid(),
        gen_random_uuid(),
        encode(
          sha256(convert_to(${fixtureSeed} || ':content:' || candidate.ordinal::text, 'UTF8')),
          'hex'
        )
      from generate_series(0, ${recordCount - 1}) as candidate(ordinal)
    `;
    await transaction`
      insert into organizations (id, name) values
        (${organizationId}, 'Input pagination maximum-volume verification'),
        (${foreignOrganizationId}, 'Foreign input pagination verification')
    `;
    await transaction`
      insert into users (id, issuer, subject, email)
      values (
        ${userId},
        'https://input-pagination-verifier.invalid',
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
        'input-pagination-verifier-v1'
      )
    `;
    await transaction`
      insert into source_events (
        id, organization_id, connection_id, source, external_event_id,
        external_object_type, external_object_id, source_timestamp, received_at,
        connector_version, payload_object_key, payload_sha256, status
      )
      select
        candidate.source_event_id,
        ${organizationId},
        ${connectionId},
        'shopify',
        ${fixtureSeed} || ':event:' || candidate.ordinal::text,
        'order',
        ${fixtureSeed} || ':order:' || candidate.ordinal::text,
        '2026-07-29T00:00:00.000Z'::timestamptz,
        '2026-07-29T00:00:01.000Z'::timestamptz,
        'input-pagination-verifier-v1',
        'verification/' || ${organizationId} || '/events/' ||
          candidate.source_event_id::text || '.json',
        candidate.content_sha256,
        'normalized'
      from reconciliation_input_pagination_fixture as candidate
    `;
    await transaction`
      insert into canonical_records (
        id, organization_id, version, kind, source_event_id, source, external_object_type,
        external_object_id, source_timestamp, ingestion_timestamp, effective_at,
        connector_version, normalizer_version, amount_minor, currency, order_reference,
        customer_reference, normalized_data, content_sha256, is_incomplete
      )
      select
        candidate.record_id,
        ${organizationId},
        1,
        'order',
        candidate.source_event_id,
        'shopify',
        'order',
        ${fixtureSeed} || ':order:' || candidate.ordinal::text,
        '2026-07-29T00:00:00.000Z'::timestamptz,
        '2026-07-29T00:00:01.000Z'::timestamptz,
        '2026-07-29T00:00:00.000Z'::timestamptz,
        'input-pagination-verifier-v1',
        'input-pagination-verifier-v1',
        candidate.ordinal::bigint + 1,
        'USD',
        '#VERIFY-' || candidate.ordinal::text,
        null,
        jsonb_build_object(
          'fixture', 'input-pagination-verifier-v1',
          'ordinal', candidate.ordinal
        ),
        candidate.content_sha256,
        false
      from reconciliation_input_pagination_fixture as candidate
    `;
    await transaction`
      insert into reconciliation_runs (
        id, organization_id, stable_run_key, input_snapshot_hash, policy_snapshot_hash,
        policy_snapshot, policy_version, rule_set_version, engine_version, initiated_by,
        status, input_count, match_count, exception_count, error_count, dispatch_count,
        operational_state_applied, started_at, completed_at, created_at
      ) values
      (
        ${runId},
        ${organizationId},
        ${sha256(`input-pagination-run:${fixtureSeed}`)},
        ${sha256(`input-pagination-snapshot:${fixtureSeed}`)},
        ${sha256(`input-pagination-policy:${fixtureSeed}`)},
        '{"version":"input-pagination-verifier-v1"}'::jsonb,
        'input-pagination-verifier-v1',
        '1.5.0',
        '0.7.0',
        ${userId},
        'succeeded',
        ${recordCount},
        0,
        0,
        0,
        1,
        false,
        '2026-07-29T00:00:01.000Z'::timestamptz,
        '2026-07-29T00:00:02.000Z'::timestamptz,
        '2026-07-29T00:00:00.000Z'::timestamptz
      ),
      (
        ${otherRunId},
        ${organizationId},
        ${sha256(`input-pagination-other-run:${fixtureSeed}`)},
        ${sha256(`input-pagination-other-snapshot:${fixtureSeed}`)},
        ${sha256(`input-pagination-other-policy:${fixtureSeed}`)},
        '{"version":"input-pagination-verifier-v1"}'::jsonb,
        'input-pagination-verifier-v1',
        '1.5.0',
        '0.7.0',
        ${userId},
        'succeeded',
        0,
        0,
        0,
        0,
        1,
        false,
        '2026-07-29T00:00:01.000Z'::timestamptz,
        '2026-07-29T00:00:02.000Z'::timestamptz,
        '2026-07-29T00:00:00.000Z'::timestamptz
      )
    `;
    await transaction`
      insert into reconciliation_run_inputs (
        organization_id, run_id, record_id, record_version, content_sha256, ordinal
      )
      select
        ${organizationId},
        ${runId},
        candidate.record_id,
        1,
        candidate.content_sha256,
        candidate.ordinal
      from reconciliation_input_pagination_fixture as candidate
    `;
    await transaction`analyze reconciliation_run_inputs`;
  });
  const seedDurationMilliseconds = roundedMilliseconds(performance.now() - seedStartedAt);

  const [databaseCounts] = await administrator`
    select
      reconciliation_runs.input_count,
      count(reconciliation_run_inputs.*)::integer as persisted_input_count,
      min(reconciliation_run_inputs.ordinal)::integer as minimum_ordinal,
      max(reconciliation_run_inputs.ordinal)::integer as maximum_ordinal,
      count(distinct reconciliation_run_inputs.ordinal)::integer as unique_ordinals
    from reconciliation_runs
    join reconciliation_run_inputs
      on reconciliation_run_inputs.organization_id = reconciliation_runs.organization_id
      and reconciliation_run_inputs.run_id = reconciliation_runs.id
    where reconciliation_runs.organization_id = ${organizationId}
      and reconciliation_runs.id = ${runId}
    group by reconciliation_runs.input_count
  `;
  assert.equal(databaseCounts?.input_count, recordCount);
  assert.equal(databaseCounts?.persisted_input_count, recordCount);
  assert.equal(databaseCounts?.minimum_ordinal, 0);
  assert.equal(databaseCounts?.maximum_ordinal, recordCount - 1);
  assert.equal(databaseCounts?.unique_ordinals, recordCount);

  const repository = new PostgresReconciliationRepository(application);
  const initialPage = await repository.listRunInputs(tenant, runId, { limit: 100 });
  assert.ok(initialPage?.nextCursor, "the maximum-volume fixture must produce another page");

  const residentSetBefore = process.memoryUsage().rss;
  const [maximumPageReader, unevenPageReader] = await Promise.all([
    traverseInputs(repository, tenant, runId, recordCount, 100),
    traverseInputs(repository, tenant, runId, recordCount, 97),
  ]);
  const residentSetGrowthBytes = Math.max(0, process.memoryUsage().rss - residentSetBefore);
  assert.equal(maximumPageReader.identitySha256, unevenPageReader.identitySha256);
  const [maximumPageProcessReader, unevenPageProcessReader] = await Promise.all([
    traverseInputsInChildProcess(100),
    traverseInputsInChildProcess(97),
  ]);
  assert.notEqual(maximumPageProcessReader.processId, unevenPageProcessReader.processId);
  assert.equal(maximumPageProcessReader.records, recordCount);
  assert.equal(unevenPageProcessReader.records, recordCount);
  assert.equal(maximumPageProcessReader.identitySha256, maximumPageReader.identitySha256);
  assert.equal(unevenPageProcessReader.identitySha256, maximumPageReader.identitySha256);

  const foreignResult = await repository.listRunInputs(foreignTenant, runId, { limit: 100 });
  assert.equal(foreignResult, undefined);

  let crossRunCursorRejected = false;
  try {
    await repository.listRunInputs(tenant, otherRunId, {
      limit: 100,
      cursor: initialPage.nextCursor,
    });
  } catch (error) {
    assert.ok(error instanceof RepositoryCursorError);
    crossRunCursorRejected = true;
  }
  assert.equal(crossRunCursorRejected, true);

  const [foreignVisibleRows] = await application.begin(async (transaction) => {
    await transaction`
      select set_config('app.organization_id', ${foreignOrganizationId}, true)
    `;
    return transaction`
      select count(*)::integer as count
      from reconciliation_run_inputs
      where organization_id = ${organizationId}
        and run_id = ${runId}
    `;
  });
  assert.equal(foreignVisibleRows?.count, 0);

  const rlsRows = await administrator`
    select relname, relrowsecurity, relforcerowsecurity
    from pg_class
    where relname in ('reconciliation_runs', 'reconciliation_run_inputs')
    order by relname
  `;
  assert.deepEqual(
    rlsRows.map((row) => ({
      table: row.relname,
      enabled: row.relrowsecurity,
      forced: row.relforcerowsecurity,
    })),
    [
      { table: "reconciliation_run_inputs", enabled: true, forced: true },
      { table: "reconciliation_runs", enabled: true, forced: true },
    ],
  );

  const queryPlanRows = await administrator`
    explain (analyze, buffers, format text)
    select record_id, record_version, content_sha256, ordinal
    from reconciliation_run_inputs
    where organization_id = ${organizationId}
      and run_id = ${runId}
      and ordinal > ${Math.floor(recordCount / 2)}
    order by ordinal
    limit 101
  `;
  const queryPlan = queryPlanRows
    .map((row) => Object.values(row)[0])
    .filter((value) => typeof value === "string")
    .join("\n");
  assert.match(queryPlan, /reconciliation_run_inputs_org_run_ordinal_uidx/u);

  process.stdout.write(
    `${JSON.stringify(
      {
        evidenceType: "reconciliation-input-pagination-maximum-volume-verification",
        recordedAt: new Date().toISOString(),
        scope:
          "Fresh loopback PostgreSQL synthetic maximum-volume and concurrent-reader evidence; no production or staging system was used",
        database: {
          serverVersion: administratorIdentity?.server_version,
          applicationRole: applicationIdentity?.role_name,
          applicationRoleSuperuser: applicationIdentity?.is_superuser,
          applicationRoleBypassesRls: applicationIdentity?.bypasses_rls,
          forcedRowLevelSecurity: rlsRows.map((row) => row.relname),
          supportingIndexUsed: "reconciliation_run_inputs_org_run_ordinal_uidx",
        },
        fixture: {
          records: recordCount,
          minimumOrdinal: databaseCounts?.minimum_ordinal,
          maximumOrdinal: databaseCounts?.maximum_ordinal,
          uniqueOrdinals: databaseCounts?.unique_ordinals,
          seedDurationMilliseconds,
          optimizedStructuralCanonicalRows: true,
        },
        concurrentReaders: [maximumPageReader, unevenPageReader],
        concurrentReadersIdentical: true,
        concurrentProcessReaders: [maximumPageProcessReader, unevenPageProcessReader],
        concurrentProcessReadersDistinct: true,
        allReaderDigestsIdentical: true,
        residentSetGrowthBytes,
        tenantIsolation: {
          foreignRepositoryResult: "undefined",
          foreignVisibleRows: foreignVisibleRows?.count,
          crossRunCursorRejected,
        },
        safety: {
          loopbackOnly: true,
          explicitSyntheticWriteOptIn: true,
          moneyOrRuleBehaviorChanged: false,
          productionDataUsed: false,
          productionOrStagingAccessed: false,
        },
        limitations: [
          "The fixture uses optimized structural canonical rows because this verifier measures the already-pinned input-reference read path, not normalization or reconciliation.",
          "Timing is a single local workstation observation and is not an SLO, capacity guarantee, or production projection.",
          "All readers use one PostgreSQL host; multi-host, network-partition, active-run, TLS, ingress, and operator behavior are not exercised.",
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

async function traverseInputsInChildProcess(limit) {
  const childEnvironment = {
    DATABASE_URL: applicationUrl.toString(),
    ...(process.env["NODE_ENV"] ? { NODE_ENV: process.env["NODE_ENV"] } : {}),
    ...(process.env["APP_ENV"] ? { APP_ENV: process.env["APP_ENV"] } : {}),
    RECONAI_INPUT_PAGINATION_READER_ORGANIZATION_ID: organizationId,
    RECONAI_INPUT_PAGINATION_READER_RUN_ID: runId,
    RECONAI_INPUT_PAGINATION_READER_USER_ID: userId,
    RECONAI_INPUT_PAGINATION_READER_MEMBERSHIP_ID: membershipId,
    RECONAI_INPUT_PAGINATION_READER_EXPECTED_COUNT: recordCount.toString(),
    RECONAI_INPUT_PAGINATION_READER_PAGE_SIZE: limit.toString(),
  };

  const result = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--conditions=development", readerVerifierPath],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: childEnvironment,
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
    },
  );
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assertReaderProcessResult(parsed, limit);
  return parsed;
}

function assertReaderProcessResult(value, expectedPageSize) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.equal(typeof value.processId, "number");
  assert.equal(value.pageSize, expectedPageSize);
  assert.equal(typeof value.pages, "number");
  assert.equal(typeof value.records, "number");
  assert.equal(value.firstOrdinal, 0);
  assert.equal(value.lastOrdinal, recordCount - 1);
  assert.match(value.identitySha256, /^[a-f0-9]{64}$/u);
  assert.equal(typeof value.durationMilliseconds, "number");
  assert.equal(typeof value.residentSetGrowthBytes, "number");
}

async function traverseInputs(repository, activeTenant, activeRunId, expectedCount, limit) {
  const startedAt = performance.now();
  const identityHash = createHash("sha256");
  let cursor;
  let expectedOrdinal = 0;
  let pages = 0;
  let firstOrdinal;
  let lastOrdinal;

  do {
    const page = await repository.listRunInputs(activeTenant, activeRunId, {
      limit,
      ...(cursor ? { cursor } : {}),
    });
    assert.ok(page, "the run must remain visible to its tenant");
    assert.ok(page.items.length > 0, "a non-final cursor must not produce an empty page");
    pages += 1;

    for (const item of page.items) {
      assert.equal(item.ordinal, expectedOrdinal);
      assert.match(
        item.id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      assert.equal(item.version, 1);
      assert.match(item.contentSha256, /^[a-f0-9]{64}$/u);
      firstOrdinal ??= item.ordinal;
      lastOrdinal = item.ordinal;
      identityHash.update(
        `${item.ordinal.toString()}:${item.id}:${item.version.toString()}:${item.contentSha256}\n`,
      );
      expectedOrdinal += 1;
    }

    if (page.nextCursor) {
      assert.equal(page.items.length, limit);
    } else {
      assert.equal(expectedOrdinal, expectedCount);
    }
    cursor = page.nextCursor;
  } while (cursor);

  return {
    pageSize: limit,
    pages,
    records: expectedOrdinal,
    firstOrdinal,
    lastOrdinal,
    identitySha256: identityHash.digest("hex"),
    durationMilliseconds: roundedMilliseconds(performance.now() - startedAt),
  };
}

function boundedRecordCount(raw) {
  if (!/^[1-9][0-9]{0,5}$/u.test(raw)) {
    throw new Error("RECONAI_INPUT_PAGINATION_RECORDS must be a positive integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 101 || value > MAXIMUM_RECORDS) {
    throw new Error(
      `RECONAI_INPUT_PAGINATION_RECORDS must be between 101 and ${MAXIMUM_RECORDS.toString()}`,
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
    throw new Error("input pagination verification is disabled in production");
  }
  if (process.env[WRITE_OPT_IN] !== "1") {
    throw new Error(`${WRITE_OPT_IN}=1 is required because this verifier inserts synthetic rows`);
  }
}

function assertDisposableDatabaseName(value) {
  if (
    typeof value !== "string" ||
    ["postgres", "template0", "template1"].includes(value) ||
    !/(?:test|verify|verification|pagination)/iu.test(value)
  ) {
    throw new Error(
      "the verifier requires a disposable database whose name includes test, verify, verification, or pagination",
    );
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function roundedMilliseconds(value) {
  return Number(value.toFixed(2));
}
