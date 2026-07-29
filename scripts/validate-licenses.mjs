import { readFile } from "node:fs/promises";

import { validateProductionLicenseInventory } from "./production-license-policy.mjs";

const [lockfileSource, inventorySource] = await Promise.all([
  readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8"),
  readFile(new URL("../config/production-license-inventory.json", import.meta.url), "utf8"),
]);

let inventory;
try {
  inventory = JSON.parse(inventorySource);
} catch {
  throw new Error("production license inventory is not valid JSON");
}

const result = validateProductionLicenseInventory(lockfileSource, inventory);
process.stdout.write(
  `Validated ${String(result.packageCount)} production package licenses ` +
    `(${result.licenses.join(", ")}); lockfile sha256=${result.lockfileSha256}\n`,
);
