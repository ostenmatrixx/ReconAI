import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ignoredDirectories = new Set([
  ".git",
  ".next",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
]);
const files = findPackageManifests(".").sort();
const failures = [];

for (const file of files) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(pkg[field] ?? {})) {
      if (typeof version !== "string") {
        failures.push(`${file}: ${field}.${name} is not a string`);
      } else if (version === "workspace:*") {
        if (!pkg.private) failures.push(`${file}: workspace dependency requires private package`);
      } else if (version.startsWith("workspace:")) {
        failures.push(`${file}: ${field}.${name} must use workspace:*`);
      } else if (version === "catalog:") {
        continue;
      } else if (/^(?:\^|~|>|<|\*|latest|next|https?:|git\+|github:|file:)/u.test(version)) {
        failures.push(`${file}: ${field}.${name} must be an exact registry version`);
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`Dependency policy failed:\n${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Validated exact dependency policy in ${files.length} package manifest(s).\n`);

function findPackageManifests(directory) {
  const manifests = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        manifests.push(...findPackageManifests(join(directory, entry.name)));
      }
    } else if (entry.isFile() && entry.name === "package.json") {
      manifests.push(join(directory, entry.name));
    }
  }
  return manifests;
}
