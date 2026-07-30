import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DURABLE_JOB_TYPES } from "../packages/connectors/src/index.ts";
import * as databaseSchema from "../packages/database/src/schema.ts";
import { TENANT_OBJECT_KEY_PURPOSES } from "../packages/object-storage/src/index.ts";
import { routeSecurityContracts } from "../apps/api/src/route-security.ts";

const policyDirectory = dirname(fileURLToPath(import.meta.url));
export const defaultTenantSurfaceRepositoryRoot = resolve(policyDirectory, "..");

const ignoredDirectoryNames = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const bffScopes = new Set([
  "identity",
  "identity_session",
  "provider_authenticated_identity",
  "separated_support_and_tenant",
  "tenant",
]);
const objectOperationScopes = new Set([
  "synthetic_tenant_fixture",
  "tenant_key_builder",
  "tenant_record_authority",
]);
const tableScopes = new Set([
  "membership_derived_identity",
  "organization_primary_key",
  "restricted_support_request",
  "tenant_column",
]);
const drizzleTableMarker = Symbol.for("drizzle:IsDrizzleTable");
const drizzleTableName = Symbol.for("drizzle:Name");

export async function collectTenantSurfaceInventory(
  repositoryRoot = defaultTenantSurfaceRepositoryRoot,
) {
  const allPaths = await collectRepositoryFiles(repositoryRoot);
  const applicationSourcePaths = allPaths.filter(
    (path) =>
      (path.startsWith("apps/") || path.startsWith("packages/")) &&
      sourceExtensions.has(extension(path)) &&
      !/\.(?:integration\.|tenant\.|test\.|spec\.)/u.test(path),
  );
  const bffRoutes = allPaths
    .filter((path) => path.startsWith("apps/web/src/app/api/") && path.endsWith("/route.ts"))
    .sort();
  const objectOperations = [];
  const keyBuilderCallSites = [];
  const stateStoreSurfaces = [];

  for (const path of applicationSourcePaths) {
    const source = await readFile(join(repositoryRoot, path), "utf8");
    if (path !== "packages/object-storage/src/index.ts") {
      for (const operation of ["deleteVerified", "getVerified", "putImmutable"]) {
        if (new RegExp(`\\.${operation}\\s*\\(`, "u").test(source)) {
          objectOperations.push({ path, operation });
        }
      }
      if (/\bbuildTenantObjectKey\s*\(/u.test(source)) {
        keyBuilderCallSites.push(path);
      }
    }

    const mechanisms = [];
    if (/from\s+["']ioredis["']|redis\.call\s*\(/u.test(source)) mechanisms.push("redis");
    if (/from\s+["']bullmq["']/u.test(source)) mechanisms.push("bullmq");
    if (/\bnew Map(?:<|\s*\()/u.test(source)) mechanisms.push("memory_map");
    if (mechanisms.length > 0) {
      stateStoreSurfaces.push({ path, mechanisms: mechanisms.sort() });
    }
  }

  const tables = Object.values(databaseSchema)
    .filter(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        value[drizzleTableMarker] === true &&
        typeof value[drizzleTableName] === "string",
    )
    .map((table) => ({
      name: table[drizzleTableName],
      hasOrganizationId: "organizationId" in table,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const apiRoutes = routeSecurityContracts
    .map((contract) => ({
      id: `${contract.method} ${contract.path}`,
      method: contract.method,
      path: contract.path,
      authentication: contract.authentication,
      stateChanging: contract.stateChanging,
      permissions: contract.authentication === "tenant" ? [...contract.permissions] : [],
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const exportedApiContracts = apiRoutes
    .filter(
      (route) => route.path.includes("exception-exports") || route.path.endsWith("/data-package"),
    )
    .map((route) => route.id)
    .sort();
  const exportedBffRoutes = bffRoutes.filter((path) => path.includes("/exports/")).sort();
  const forcedRlsTables = await discoverForcedRlsTables(repositoryRoot, allPaths);

  return {
    tables,
    forcedRlsTables,
    apiRoutes,
    bffRoutes,
    durableJobTypes: [...DURABLE_JOB_TYPES].sort(),
    objectPurposes: [...TENANT_OBJECT_KEY_PURPOSES].sort(),
    keyBuilderCallSites: [...new Set(keyBuilderCallSites)].sort(),
    objectOperations: objectOperations.sort(comparePathAndOperation),
    stateStoreSurfaces: stateStoreSurfaces.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    exportedApiContracts,
    exportedBffRoutes,
    existingPaths: allPaths,
    observabilityIndexSource: await readFile(
      join(repositoryRoot, "packages/observability/src/index.ts"),
      "utf8",
    ),
    alertPolicySource: await readFile(
      join(repositoryRoot, "packages/observability/src/alert-policy.ts"),
      "utf8",
    ),
  };
}

export function validateTenantSurfaceManifest(manifest, inventory) {
  const failures = [];
  if (!isRecord(manifest)) {
    return {
      failures: ["manifest must be a JSON object"],
      summary: emptySummary(),
    };
  }
  if (manifest.schemaVersion !== 1) failures.push("manifest.schemaVersion must equal 1");

  const database = recordAt(manifest, "database", failures);
  const api = recordAt(manifest, "api", failures);
  const bff = recordAt(manifest, "bff", failures);
  const durableJobs = recordAt(manifest, "durableJobs", failures);
  const objectStorage = recordAt(manifest, "objectStorage", failures);
  const stateStores = recordAt(manifest, "stateStores", failures);
  const exportsSection = recordAt(manifest, "exports", failures);
  const observability = recordAt(manifest, "observability", failures);
  const restrictedSupport = recordAt(manifest, "restrictedSupport", failures);
  const existingPaths = new Set(inventory.existingPaths);

  validateEvidence(
    [
      database,
      api,
      bff,
      durableJobs,
      objectStorage,
      stateStores,
      exportsSection,
      observability,
      restrictedSupport,
    ],
    existingPaths,
    failures,
  );
  validateSourcePath(database.schemaSource, "database.schemaSource", existingPaths, failures);
  validateSourcePath(api.registrationSource, "api.registrationSource", existingPaths, failures);
  validateSourcePath(api.contractSource, "api.contractSource", existingPaths, failures);

  const manifestTables = objectArrayAt(database, "tables", failures);
  compareExactSet(
    "database tables",
    manifestTables.map((entry) => stringProperty(entry, "name", "database.tables", failures)),
    inventory.tables.map((table) => table.name),
    failures,
  );
  for (const entry of manifestTables) {
    exactKeys(entry, ["name", "scope"], "database.tables entry", failures);
    const name = stringProperty(entry, "name", "database.tables", failures);
    const scope = stringProperty(entry, "scope", "database.tables", failures);
    if (!tableScopes.has(scope)) failures.push(`database table ${name} has invalid scope ${scope}`);
    const actual = inventory.tables.find((table) => table.name === name);
    if (!actual) continue;
    const expectedScope = expectedTableScope(actual);
    if (scope !== expectedScope) {
      failures.push(`database table ${name} must use scope ${expectedScope}, received ${scope}`);
    }
  }
  compareExactSet(
    "forced-RLS migration tables",
    inventory.tables.map((table) => table.name),
    inventory.forcedRlsTables,
    failures,
  );
  const databaseRequirements = recordAt(database, "requirements", failures);
  if (databaseRequirements.rowLevelSecurity !== "forced") {
    failures.push("database.requirements.rowLevelSecurity must equal forced");
  }
  if (databaseRequirements.tenantContextSetting !== "app.organization_id") {
    failures.push("database.requirements.tenantContextSetting must equal app.organization_id");
  }

  if (api.expectedRouteCount !== inventory.apiRoutes.length) {
    failures.push(
      `api expectedRouteCount is ${String(api.expectedRouteCount)} but discovered ${String(
        inventory.apiRoutes.length,
      )}`,
    );
  }
  compareExactSet(
    "API authentication classes",
    stringArrayAt(api, "authenticationClasses", failures),
    [...new Set(inventory.apiRoutes.map((route) => route.authentication))],
    failures,
  );
  uniqueValues(
    "API route contracts",
    inventory.apiRoutes.map((route) => route.id),
    failures,
  );
  for (const route of inventory.apiRoutes) {
    if (route.stateChanging !== (route.method !== "GET")) {
      failures.push(`${route.id} has an inconsistent stateChanging classification`);
    }
    if (route.authentication === "tenant") {
      if (!route.path.includes("/v1/organizations/:organizationId")) {
        failures.push(`${route.id} is tenant-authenticated without an organization path`);
      }
      if (route.permissions.length === 0) {
        failures.push(`${route.id} is tenant-authenticated without an explicit permission`);
      }
    }
  }

  const manifestBffRoutes = objectArrayAt(bff, "routes", failures);
  compareExactSet(
    "BFF routes",
    manifestBffRoutes.map((entry) => stringProperty(entry, "path", "bff.routes", failures)),
    inventory.bffRoutes,
    failures,
  );
  for (const entry of manifestBffRoutes) {
    exactKeys(entry, ["path", "scope"], "bff.routes entry", failures);
    const path = stringProperty(entry, "path", "bff.routes", failures);
    const scope = stringProperty(entry, "scope", "bff.routes", failures);
    if (!bffScopes.has(scope)) failures.push(`BFF route ${path} has invalid scope ${scope}`);
  }

  const manifestJobTypes = objectArrayAt(durableJobs, "types", failures);
  compareExactSet(
    "durable job types",
    manifestJobTypes.map((entry) => stringProperty(entry, "type", "durableJobs.types", failures)),
    inventory.durableJobTypes,
    failures,
  );
  for (const entry of manifestJobTypes) {
    exactKeys(entry, ["tenantField", "type"], "durableJobs.types entry", failures);
    const type = stringProperty(entry, "type", "durableJobs.types", failures);
    if (entry.tenantField !== "organizationId") {
      failures.push(`durable job ${type} must carry tenantField organizationId`);
    }
  }

  compareExactSet(
    "object-storage purposes",
    stringArrayAt(objectStorage, "purposes", failures),
    inventory.objectPurposes,
    failures,
  );
  compareExactSet(
    "object key-builder call sites",
    stringArrayAt(objectStorage, "keyBuilderCallSites", failures),
    inventory.keyBuilderCallSites,
    failures,
  );
  const manifestObjectOperations = objectArrayAt(objectStorage, "operations", failures);
  compareExactSet(
    "object-storage operations",
    manifestObjectOperations.map(objectOperationIdentity),
    inventory.objectOperations.map(objectOperationIdentity),
    failures,
  );
  for (const entry of manifestObjectOperations) {
    exactKeys(entry, ["operation", "path", "scope"], "objectStorage.operations entry", failures);
    const identity = objectOperationIdentity(entry);
    if (!["deleteVerified", "getVerified", "putImmutable"].includes(entry.operation)) {
      failures.push(`object operation ${identity} uses an invalid operation`);
    }
    if (!objectOperationScopes.has(entry.scope)) {
      failures.push(`object operation ${identity} has invalid scope ${String(entry.scope)}`);
    }
  }

  const manifestStateSurfaces = objectArrayAt(stateStores, "surfaces", failures);
  compareExactSet(
    "state-store surfaces",
    manifestStateSurfaces.map(stateSurfaceIdentity),
    inventory.stateStoreSurfaces.map(stateSurfaceIdentity),
    failures,
  );
  for (const entry of manifestStateSurfaces) {
    exactKeys(entry, ["mechanisms", "path", "scope"], "stateStores.surfaces entry", failures);
    const path = stringProperty(entry, "path", "stateStores.surfaces", failures);
    if (!/^[a-z][a-z0-9_]{2,100}$/u.test(String(entry.scope))) {
      failures.push(`state-store surface ${path} has an invalid scope`);
    }
    const mechanisms = stringArrayAt(entry, "mechanisms", failures);
    for (const mechanism of mechanisms) {
      if (!["bullmq", "memory_map", "redis"].includes(mechanism)) {
        failures.push(`state-store surface ${path} has invalid mechanism ${mechanism}`);
      }
    }
  }

  const exportSurfaces = objectArrayAt(exportsSection, "surfaces", failures);
  uniqueValues(
    "export surface ids",
    exportSurfaces.map((entry) => stringProperty(entry, "id", "exports.surfaces", failures)),
    failures,
  );
  compareExactSet(
    "export API contracts",
    exportSurfaces.map((entry) =>
      stringProperty(entry, "apiContract", "exports.surfaces", failures),
    ),
    inventory.exportedApiContracts,
    failures,
  );
  compareExactSet(
    "export BFF routes",
    exportSurfaces.map((entry) => stringProperty(entry, "bffRoute", "exports.surfaces", failures)),
    inventory.exportedBffRoutes,
    failures,
  );
  for (const entry of exportSurfaces) {
    exactKeys(entry, ["apiContract", "bffRoute", "id"], "exports.surfaces entry", failures);
  }

  if (observability.tenantIdentifierPolicy !== "prohibited") {
    failures.push("observability.tenantIdentifierPolicy must equal prohibited");
  }
  const manifestForbiddenFragments = stringArrayAt(
    observability,
    "forbiddenDimensionFragments",
    failures,
  );
  const sourceForbiddenFragments = extractQuotedArray(
    inventory.alertPolicySource,
    "FORBIDDEN_TENANT_TELEMETRY_DIMENSION_FRAGMENTS",
  );
  compareExactSet(
    "forbidden telemetry dimension fragments",
    manifestForbiddenFragments,
    sourceForbiddenFragments,
    failures,
  );
  if (inventory.observabilityIndexSource.includes("tenantTelemetryKey")) {
    failures.push("observability index must not export tenantTelemetryKey");
  }
  if (restrictedSupport.mode !== "default_disabled_tenant_approved") {
    failures.push("restrictedSupport.mode must equal default_disabled_tenant_approved");
  }

  return {
    failures: [...new Set(failures)].sort(),
    summary: {
      databaseTables: inventory.tables.length,
      forcedRlsTables: inventory.forcedRlsTables.length,
      apiRoutes: inventory.apiRoutes.length,
      bffRoutes: inventory.bffRoutes.length,
      durableJobTypes: inventory.durableJobTypes.length,
      objectKeyBuilderCallSites: inventory.keyBuilderCallSites.length,
      objectOperations: inventory.objectOperations.length,
      stateStoreSurfaces: inventory.stateStoreSurfaces.length,
      exportSurfaces: inventory.exportedApiContracts.length,
      evidenceFiles: evidencePaths([
        database,
        api,
        bff,
        durableJobs,
        objectStorage,
        stateStores,
        exportsSection,
        observability,
        restrictedSupport,
      ]).length,
    },
  };
}

function expectedTableScope(table) {
  if (table.hasOrganizationId) return "tenant_column";
  if (table.name === "organizations") return "organization_primary_key";
  if (table.name === "users") return "membership_derived_identity";
  if (table.name === "support_access_requests") return "restricted_support_request";
  return "unclassified";
}

function validateEvidence(sections, existingPaths, failures) {
  const paths = evidencePaths(sections);
  for (const [index, section] of sections.entries()) {
    const sectionPaths = stringArrayAt(section, "evidence", failures);
    if (sectionPaths.length === 0)
      failures.push(`manifest section ${String(index)} has no evidence`);
    uniqueValues(`manifest section ${String(index)} evidence`, sectionPaths, failures);
  }
  for (const path of paths) {
    if (!existingPaths.has(path)) failures.push(`evidence path does not exist: ${path}`);
  }
}

function evidencePaths(sections) {
  return sections.flatMap((section) =>
    Array.isArray(section.evidence)
      ? section.evidence.filter((value) => typeof value === "string")
      : [],
  );
}

function validateSourcePath(value, path, existingPaths, failures) {
  if (typeof value !== "string" || !existingPaths.has(value)) {
    failures.push(`${path} must reference an existing repository file`);
  }
}

function compareExactSet(label, manifestValues, actualValues, failures) {
  uniqueValues(`${label} manifest`, manifestValues, failures);
  uniqueValues(`${label} discovery`, actualValues, failures);
  const manifestSet = new Set(manifestValues);
  const actualSet = new Set(actualValues);
  for (const value of actualSet) {
    if (!manifestSet.has(value))
      failures.push(`${label} contains unclassified discovery: ${value}`);
  }
  for (const value of manifestSet) {
    if (!actualSet.has(value)) failures.push(`${label} contains stale manifest entry: ${value}`);
  }
}

function uniqueValues(label, values, failures) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) failures.push(`${label} contains duplicate value: ${String(value)}`);
    seen.add(value);
  }
}

function exactKeys(value, expected, path, failures) {
  if (!isRecord(value)) {
    failures.push(`${path} must be an object`);
    return;
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.join("\0") !== sortedExpected.join("\0")) {
    failures.push(`${path} must contain exactly ${sortedExpected.join(", ")}`);
  }
}

function recordAt(value, key, failures) {
  const nested = isRecord(value) ? value[key] : undefined;
  if (!isRecord(nested)) {
    failures.push(`${key} must be an object`);
    return {};
  }
  return nested;
}

function objectArrayAt(value, key, failures) {
  const nested = isRecord(value) ? value[key] : undefined;
  if (!Array.isArray(nested) || nested.some((entry) => !isRecord(entry))) {
    failures.push(`${key} must be an array of objects`);
    return [];
  }
  return nested;
}

function stringArrayAt(value, key, failures) {
  const nested = isRecord(value) ? value[key] : undefined;
  if (!Array.isArray(nested) || nested.some((entry) => typeof entry !== "string")) {
    failures.push(`${key} must be an array of strings`);
    return [];
  }
  return nested;
}

function stringProperty(value, key, path, failures) {
  const nested = isRecord(value) ? value[key] : undefined;
  if (typeof nested !== "string" || nested.length === 0) {
    failures.push(`${path}.${key} must be a non-empty string`);
    return "";
  }
  return nested;
}

function objectOperationIdentity(value) {
  return isRecord(value) ? `${String(value.operation)} ${String(value.path)}` : "invalid";
}

function stateSurfaceIdentity(value) {
  if (!isRecord(value)) return "invalid";
  const mechanisms = Array.isArray(value.mechanisms)
    ? [...value.mechanisms].map(String).sort().join(",")
    : "invalid";
  return `${String(value.path)}|${mechanisms}`;
}

function extractQuotedArray(source, identifier) {
  const match = new RegExp(`export const ${identifier} = \\[([\\s\\S]*?)\\] as const`, "u").exec(
    source,
  );
  if (!match?.[1]) return [];
  return [...match[1].matchAll(/"([^"]+)"/gu)].map((item) => item[1]).filter(Boolean);
}

function comparePathAndOperation(left, right) {
  return left.path.localeCompare(right.path) || left.operation.localeCompare(right.operation);
}

function emptySummary() {
  return {
    databaseTables: 0,
    forcedRlsTables: 0,
    apiRoutes: 0,
    bffRoutes: 0,
    durableJobTypes: 0,
    objectKeyBuilderCallSites: 0,
    objectOperations: 0,
    stateStoreSurfaces: 0,
    exportSurfaces: 0,
    evidenceFiles: 0,
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extension(path) {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index);
}

async function collectRepositoryFiles(repositoryRoot) {
  const paths = [];
  await visit(repositoryRoot, "");
  return paths.sort();

  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) continue;
      const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      const childPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(childPath, childPrefix);
      } else if (entry.isFile()) {
        paths.push(relative(repositoryRoot, childPath).split("\\").join("/"));
      }
    }
  }
}

async function discoverForcedRlsTables(repositoryRoot, allPaths) {
  const enabled = new Set();
  const forced = new Set();
  const migrationPaths = allPaths.filter(
    (path) =>
      path.startsWith("packages/database/migrations/") &&
      /^\d{4}_[a-z0-9_]+\.sql$/u.test(path.slice(path.lastIndexOf("/") + 1)),
  );

  for (const path of migrationPaths) {
    const source = await readFile(join(repositoryRoot, path), "utf8");
    for (const match of source.matchAll(
      /ALTER\s+TABLE\s+(?:public\.)?([a-z][a-z0-9_]*)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/giu,
    )) {
      if (match[1]) enabled.add(match[1]);
    }
    for (const match of source.matchAll(
      /ALTER\s+TABLE\s+(?:public\.)?([a-z][a-z0-9_]*)\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/giu,
    )) {
      if (match[1]) forced.add(match[1]);
    }
    if (
      /format\('ALTER TABLE %I ENABLE ROW LEVEL SECURITY'/u.test(source) &&
      /format\('ALTER TABLE %I FORCE ROW LEVEL SECURITY'/u.test(source)
    ) {
      for (const arrayMatch of source.matchAll(
        /[a-z][a-z0-9_]*\s+text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\];/giu,
      )) {
        for (const tableMatch of (arrayMatch[1] ?? "").matchAll(/'([a-z][a-z0-9_]*)'/gu)) {
          if (tableMatch[1]) {
            enabled.add(tableMatch[1]);
            forced.add(tableMatch[1]);
          }
        }
      }
    }
  }

  return [...enabled].filter((table) => forced.has(table)).sort();
}
