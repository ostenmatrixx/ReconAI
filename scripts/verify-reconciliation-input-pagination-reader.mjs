import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const applicationUrl = validatedDatabaseUrl(requiredEnvironment("DATABASE_URL"), "DATABASE_URL");
const organizationIdValue = requiredUuid("RECONAI_INPUT_PAGINATION_READER_ORGANIZATION_ID");
const runId = requiredUuid("RECONAI_INPUT_PAGINATION_READER_RUN_ID");
const userIdValue = requiredUuid("RECONAI_INPUT_PAGINATION_READER_USER_ID");
const membershipIdValue = requiredUuid("RECONAI_INPUT_PAGINATION_READER_MEMBERSHIP_ID");
const expectedCount = boundedInteger(
  "RECONAI_INPUT_PAGINATION_READER_EXPECTED_COUNT",
  101,
  100_000,
);
const pageSize = boundedInteger("RECONAI_INPUT_PAGINATION_READER_PAGE_SIZE", 1, 100);
assertNonProductionRuntime();

const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const postgres = (await import(requireFromApi.resolve("postgres"))).default;
const { MembershipIdSchema, OrganizationIdSchema, UserIdSchema, tenantContextFromMembership } =
  await import("../packages/domain/src/index.ts");
const { PostgresReconciliationRepository } = await import("../apps/api/src/repository.ts");

const tenant = tenantContextFromMembership({
  id: MembershipIdSchema.parse(membershipIdValue),
  organizationId: OrganizationIdSchema.parse(organizationIdValue),
  userId: UserIdSchema.parse(userIdValue),
  role: "analyst",
  status: "active",
});
const application = postgres(applicationUrl.toString(), {
  connect_timeout: 5,
  idle_timeout: 5,
  max: 1,
});

try {
  const [identity] = await application`
    select
      current_user as role_name,
      usesuper as is_superuser,
      rolbypassrls as bypasses_rls
    from pg_user
    join pg_roles on pg_roles.rolname = current_user
    where usename = current_user
  `;
  assert.equal(identity?.role_name, "reconai_app");
  assert.equal(identity?.is_superuser, false);
  assert.equal(identity?.bypasses_rls, false);

  const repository = new PostgresReconciliationRepository(application);
  const result = await traverseInputs(repository, tenant, runId, expectedCount, pageSize);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await application.end({ timeout: 5 });
}

async function traverseInputs(repository, activeTenant, activeRunId, total, limit) {
  const startedAt = performance.now();
  const residentSetBefore = process.memoryUsage().rss;
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
      assert.equal(expectedOrdinal, total);
    }
    cursor = page.nextCursor;
  } while (cursor);

  return {
    processId: process.pid,
    pageSize: limit,
    pages,
    records: expectedOrdinal,
    firstOrdinal,
    lastOrdinal,
    identitySha256: identityHash.digest("hex"),
    durationMilliseconds: roundedMilliseconds(performance.now() - startedAt),
    residentSetGrowthBytes: Math.max(0, process.memoryUsage().rss - residentSetBefore),
  };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredUuid(name) {
  const value = requiredEnvironment(name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error(`${name} must be an RFC UUID`);
  }
  return value;
}

function boundedInteger(name, minimum, maximum) {
  const raw = requiredEnvironment(name);
  if (!/^[1-9][0-9]{0,5}$/u.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum.toString()} and ${maximum.toString()}`);
  }
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

function assertNonProductionRuntime() {
  if (process.env["NODE_ENV"] === "production" || process.env["APP_ENV"] === "production") {
    throw new Error("input pagination reader verification is disabled in production");
  }
}

function roundedMilliseconds(value) {
  return Number(value.toFixed(2));
}
