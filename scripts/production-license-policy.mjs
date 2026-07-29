import { createHash } from "node:crypto";

import YAML from "yaml";

export const productionLicenseRegistry = "https://registry.npmjs.org/";
export const approvedProductionLicenses = new Set([
  "0BSD",
  "Apache-2.0 AND LGPL-3.0-or-later",
  "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "LGPL-3.0-or-later",
  "MIT",
  "MPL-2.0",
  "OFL-1.1",
  "Python-2.0",
  "Unlicense",
]);

const maximumLockfileBytes = 10 * 1024 * 1024;
const maximumProductionPackages = 10_000;
const maximumGraphEdges = 50_000;
const integrityPattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function productionPackageGraph(lockfileSource) {
  if (
    typeof lockfileSource !== "string" ||
    Buffer.byteLength(lockfileSource, "utf8") > maximumLockfileBytes
  ) {
    throw new Error("pnpm lockfile is missing or exceeds the policy size limit");
  }

  let lockfile;
  try {
    lockfile = YAML.parse(lockfileSource, { maxAliasCount: 0 });
  } catch {
    throw new Error("pnpm lockfile is not valid bounded YAML");
  }
  if (
    !isRecord(lockfile) ||
    lockfile.lockfileVersion !== "9.0" ||
    !isRecord(lockfile.importers) ||
    !isRecord(lockfile.packages) ||
    !isRecord(lockfile.snapshots)
  ) {
    throw new Error("pnpm lockfile does not match the supported version-9 structure");
  }

  const queue = [];
  for (const [importerName, importer] of Object.entries(lockfile.importers)) {
    if (!isRecord(importer)) {
      throw new Error(`pnpm importer ${importerName} is invalid`);
    }
    enqueueDependencies(queue, importerName, importer.dependencies, true);
    enqueueDependencies(queue, importerName, importer.optionalDependencies, true);
  }

  const productionKeys = new Set();
  let edgeCount = queue.length;
  while (queue.length > 0) {
    const key = queue.pop();
    if (productionKeys.has(key)) continue;
    productionKeys.add(key);
    if (productionKeys.size > maximumProductionPackages) {
      throw new Error("production dependency graph exceeds the package limit");
    }

    const packageEntry = lockfile.packages[packageIdentityFromSnapshotKey(key).packageKey];
    const snapshot = lockfile.snapshots[key];
    if (!isRecord(packageEntry) || !isRecord(snapshot)) {
      throw new Error(`production package ${key} is missing from the lockfile graph`);
    }
    const integrity = packageEntry.resolution?.integrity;
    if (typeof integrity !== "string" || !integrityPattern.test(integrity)) {
      throw new Error(`production package ${key} has no supported sha512 integrity`);
    }

    edgeCount += enqueueDependencies(queue, key, snapshot.dependencies, false);
    edgeCount += enqueueDependencies(queue, key, snapshot.optionalDependencies, false);
    if (edgeCount > maximumGraphEdges) {
      throw new Error("production dependency graph exceeds the edge limit");
    }
  }

  const packageKeys = [...productionKeys].sort((left, right) => left.localeCompare(right, "en"));
  return {
    lockfile,
    lockfileSha256: sha256(lockfileSource),
    packageKeys,
  };
}

export async function generateProductionLicenseInventory(
  lockfileSource,
  readPackageMetadata,
  generatedAt = new Date().toISOString(),
) {
  if (typeof readPackageMetadata !== "function") {
    throw new Error("package metadata reader is required");
  }
  if (!timestampPattern.test(generatedAt) || !Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("license inventory timestamp must be canonical UTC");
  }

  const graph = productionPackageGraph(lockfileSource);
  const entries = await boundedMap(graph.packageKeys, 8, async (key) => {
    const identity = packageIdentityFromSnapshotKey(key);
    const metadata = await readPackageMetadata(identity);
    validateRegistryMetadata(graph.lockfile, key, identity, metadata);
    return [key, metadata.license];
  });

  return {
    schemaVersion: 1,
    generatedAt,
    registry: productionLicenseRegistry,
    lockfileSha256: graph.lockfileSha256,
    productionPackageCount: graph.packageKeys.length,
    packages: Object.fromEntries(entries),
  };
}

export function validateProductionLicenseInventory(lockfileSource, inventory) {
  const graph = productionPackageGraph(lockfileSource);
  if (
    !isRecord(inventory) ||
    inventory.schemaVersion !== 1 ||
    inventory.registry !== productionLicenseRegistry ||
    inventory.lockfileSha256 !== graph.lockfileSha256 ||
    inventory.productionPackageCount !== graph.packageKeys.length ||
    typeof inventory.generatedAt !== "string" ||
    !timestampPattern.test(inventory.generatedAt) ||
    !Number.isFinite(Date.parse(inventory.generatedAt)) ||
    !isRecord(inventory.packages)
  ) {
    throw new Error("production license inventory metadata does not match the current lockfile");
  }

  const inventoryKeys = Object.keys(inventory.packages);
  if (
    inventoryKeys.length !== graph.packageKeys.length ||
    inventoryKeys.some((key, index) => key !== graph.packageKeys[index])
  ) {
    throw new Error("production license inventory is incomplete, stale, or not sorted");
  }

  const foundLicenses = new Set();
  const denied = [];
  for (const key of graph.packageKeys) {
    const license = inventory.packages[key];
    if (
      typeof license !== "string" ||
      license.length === 0 ||
      license.length > 128 ||
      !approvedProductionLicenses.has(license)
    ) {
      denied.push(`${key}: ${String(license)}`);
    } else {
      foundLicenses.add(license);
    }
  }
  if (denied.length > 0) {
    throw new Error(`unapproved or invalid production licenses:\n${denied.join("\n")}`);
  }

  return {
    packageCount: graph.packageKeys.length,
    lockfileSha256: graph.lockfileSha256,
    licenses: [...foundLicenses].sort((left, right) => left.localeCompare(right, "en")),
  };
}

export function packageIdentityFromSnapshotKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 1_024) {
    throw new Error("production package key is invalid");
  }
  const separator = key.startsWith("@") ? key.indexOf("@", 1) : key.indexOf("@");
  if (separator <= 0) throw new Error(`production package key ${key} is unsupported`);
  const name = key.slice(0, separator);
  const versionWithPeers = key.slice(separator + 1);
  const peerSeparator = versionWithPeers.indexOf("(");
  const version =
    peerSeparator === -1 ? versionWithPeers : versionWithPeers.slice(0, peerSeparator);
  if (
    !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu.test(name) ||
    !/^[0-9][0-9A-Za-z.+-]*$/u.test(version)
  ) {
    throw new Error(`production package key ${key} is unsupported`);
  }
  return { name, version, packageKey: `${name}@${version}` };
}

function enqueueDependencies(queue, owner, dependencies, importer) {
  if (dependencies === undefined) return 0;
  if (!isRecord(dependencies)) throw new Error(`${owner} dependencies are invalid`);
  let count = 0;
  for (const [name, descriptor] of Object.entries(dependencies)) {
    const reference = importer
      ? isRecord(descriptor)
        ? descriptor.version
        : undefined
      : descriptor;
    if (typeof reference !== "string" || reference.length === 0 || reference.length > 1_024) {
      throw new Error(`${owner} dependency ${name} has an invalid reference`);
    }
    if (importer && reference.startsWith("link:")) continue;
    if (
      reference.startsWith("link:") ||
      reference.startsWith("workspace:") ||
      reference.startsWith("file:") ||
      reference.startsWith("git") ||
      reference.startsWith("http:") ||
      reference.startsWith("https:")
    ) {
      throw new Error(`${owner} dependency ${name} is not an exact registry snapshot`);
    }
    queue.push(`${name}@${reference}`);
    count += 1;
  }
  return count;
}

function validateRegistryMetadata(lockfile, key, identity, metadata) {
  if (
    !isRecord(metadata) ||
    metadata.name !== identity.name ||
    metadata.version !== identity.version ||
    typeof metadata.license !== "string" ||
    metadata.license.length === 0 ||
    metadata.license.length > 128 ||
    !approvedProductionLicenses.has(metadata.license) ||
    !isRecord(metadata.dist) ||
    typeof metadata.dist.integrity !== "string" ||
    metadata.dist.integrity !== lockfile.packages[identity.packageKey].resolution.integrity
  ) {
    throw new Error(`registry metadata for ${key} failed identity, integrity, or license policy`);
  }
}

async function boundedMap(values, concurrency, operation) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
