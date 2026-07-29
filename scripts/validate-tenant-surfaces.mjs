import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  collectTenantSurfaceInventory,
  defaultTenantSurfaceRepositoryRoot,
  validateTenantSurfaceManifest,
} from "./tenant-surface-policy.mjs";

const manifestPath = join(
  defaultTenantSurfaceRepositoryRoot,
  "config/tenant-surface-manifest.json",
);
const manifestSource = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestSource);
const inventory = await collectTenantSurfaceInventory();
const result = validateTenantSurfaceManifest(manifest, inventory);

if (result.failures.length > 0) {
  process.stderr.write(
    `Tenant-surface validation failed:\n${result.failures
      .map((failure) => `- ${failure}`)
      .join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  const digest = createHash("sha256").update(manifestSource).digest("hex");
  process.stdout.write(
    `Tenant-surface validation passed: ${JSON.stringify(result.summary)}; manifestSha256=${digest}\n`,
  );
}
