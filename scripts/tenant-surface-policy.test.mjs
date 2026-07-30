import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  collectTenantSurfaceInventory,
  defaultTenantSurfaceRepositoryRoot,
  validateTenantSurfaceManifest,
} from "./tenant-surface-policy.mjs";

let manifest;
let inventory;

beforeAll(async () => {
  manifest = JSON.parse(
    await readFile(
      join(defaultTenantSurfaceRepositoryRoot, "config/tenant-surface-manifest.json"),
      "utf8",
    ),
  );
  inventory = await collectTenantSurfaceInventory();
});

describe("tenant-surface manifest policy", () => {
  it("accepts the exact checked-in cross-layer inventory", () => {
    expect(validateTenantSurfaceManifest(manifest, inventory).failures).toEqual([]);
  });

  it("rejects a newly discovered database table until it is classified", () => {
    const changed = clone(inventory);
    changed.tables.push({ name: "future_customer_records", hasOrganizationId: true });
    expect(validateTenantSurfaceManifest(manifest, changed).failures).toContain(
      "database tables contains unclassified discovery: future_customer_records",
    );
  });

  it("rejects tenant-owned tables without an organization column", () => {
    const changed = clone(inventory);
    const table = changed.tables.find((entry) => entry.name === "exceptions");
    table.hasOrganizationId = false;
    expect(validateTenantSurfaceManifest(manifest, changed).failures).toContain(
      "database table exceptions must use scope unclassified, received tenant_column",
    );
  });

  it("rejects a schema table without both enabling and forcing RLS in migrations", () => {
    const changed = clone(inventory);
    changed.forcedRlsTables = changed.forcedRlsTables.filter((name) => name !== "exceptions");
    expect(validateTenantSurfaceManifest(manifest, changed).failures).toContain(
      "forced-RLS migration tables contains stale manifest entry: exceptions",
    );
  });

  it("rejects an unclassified BFF route and durable job type", () => {
    const changed = clone(inventory);
    changed.bffRoutes.push("apps/web/src/app/api/recon/future/route.ts");
    changed.durableJobTypes.push("future.tenant.job");
    const failures = validateTenantSurfaceManifest(manifest, changed).failures;
    expect(failures).toContain(
      "BFF routes contains unclassified discovery: apps/web/src/app/api/recon/future/route.ts",
    );
    expect(failures).toContain(
      "durable job types contains unclassified discovery: future.tenant.job",
    );
  });

  it("rejects unclassified object and state-store operations", () => {
    const changed = clone(inventory);
    changed.objectOperations.push({
      path: "packages/ingestion/src/future-object-reader.ts",
      operation: "getVerified",
    });
    changed.stateStoreSurfaces.push({
      path: "apps/api/src/future-cache.ts",
      mechanisms: ["redis"],
    });
    const failures = validateTenantSurfaceManifest(manifest, changed).failures;
    expect(failures).toContain(
      "object-storage operations contains unclassified discovery: getVerified packages/ingestion/src/future-object-reader.ts",
    );
    expect(failures).toContain(
      "state-store surfaces contains unclassified discovery: apps/api/src/future-cache.ts|redis",
    );
  });

  it("rejects export drift and missing evidence", () => {
    const changedManifest = clone(manifest);
    changedManifest.exports.surfaces.pop();
    changedManifest.api.evidence[0] = "apps/api/src/missing-tenant-evidence.test.ts";
    const failures = validateTenantSurfaceManifest(changedManifest, inventory).failures;
    expect(failures).toContain(
      "export API contracts contains unclassified discovery: POST /v1/organizations/:organizationId/provider-privacy-requests/:requestId/data-package",
    );
    expect(failures).toContain(
      "evidence path does not exist: apps/api/src/missing-tenant-evidence.test.ts",
    );
  });

  it("rejects tenant identifiers in observability and support enablement drift", () => {
    const changedInventory = clone(inventory);
    changedInventory.observabilityIndexSource += "\nexport function tenantTelemetryKey() {}\n";
    const changedManifest = clone(manifest);
    changedManifest.restrictedSupport.mode = "always_enabled";
    const failures = validateTenantSurfaceManifest(changedManifest, changedInventory).failures;
    expect(failures).toContain("observability index must not export tenantTelemetryKey");
    expect(failures).toContain(
      "restrictedSupport.mode must equal default_disabled_tenant_approved",
    );
  });
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
