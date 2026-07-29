import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const WRITE_OPT_IN = "RECONAI_ALLOW_LOCAL_VERIFICATION_WRITES";
assertSafeRuntime();
const applicationUrl = validatedApplicationUrl(requiredEnvironment("DATABASE_URL"));

const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const postgres = (await import(requireFromApi.resolve("postgres"))).default;
const { MembershipIdSchema, OrganizationIdSchema, UserIdSchema, tenantContextFromMembership } =
  await import("../packages/domain/src/index.ts");
const { defaultPolicy } = await import("../packages/test-support/src/index.ts");
const { PostgresReconciliationRepository } = await import("../apps/api/src/repository.ts");

const organizationId = OrganizationIdSchema.parse(
  requiredEnvironment("RECONAI_VERIFICATION_ORGANIZATION_ID"),
);
const tenant = tenantContextFromMembership({
  id: MembershipIdSchema.parse(requiredEnvironment("RECONAI_VERIFICATION_MEMBERSHIP_ID")),
  organizationId,
  userId: UserIdSchema.parse(requiredEnvironment("RECONAI_VERIFICATION_USER_ID")),
  role: "analyst",
  status: "active",
});
const policy = {
  ...defaultPolicy,
  version: requiredEnvironment("RECONAI_VERIFICATION_POLICY_VERSION"),
  evaluatedAt: requiredEnvironment("RECONAI_VERIFICATION_POLICY_EVALUATED_AT"),
};
const application = postgres(applicationUrl.toString(), {
  connect_timeout: 5,
  connection: {
    application_name: `reconai-run-creator:${process.pid.toString()}`,
  },
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
  const residentSetBefore = process.memoryUsage().rss;
  const startedAt = performance.now();
  const run = await repository.startRun(tenant, policy, {
    correlationId: randomUUID(),
    reason: "Verify independent-process maximum-volume run authority convergence",
  });
  const durationMilliseconds = Number((performance.now() - startedAt).toFixed(2));
  const residentSetGrowthBytes = Math.max(0, process.memoryUsage().rss - residentSetBefore);
  process.stdout.write(
    `${JSON.stringify({
      processId: process.pid,
      durationMilliseconds,
      residentSetGrowthBytes,
      run,
    })}\n`,
  );
} finally {
  await application.end({ timeout: 5 });
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validatedApplicationUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be an absolute PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("DATABASE_URL must target loopback infrastructure");
  }
  if (url.username !== "reconai_app") {
    throw new Error("DATABASE_URL must use the restricted reconai_app role");
  }
  return url;
}

function assertSafeRuntime() {
  if (process.env["NODE_ENV"] === "production" || process.env["APP_ENV"] === "production") {
    throw new Error("run creation child verification is disabled in production");
  }
  if (process.env[WRITE_OPT_IN] !== "1") {
    throw new Error(`${WRITE_OPT_IN}=1 is required for run creation child verification`);
  }
}
