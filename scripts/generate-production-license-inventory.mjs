import { readFile, writeFile } from "node:fs/promises";

import {
  generateProductionLicenseInventory,
  productionLicenseRegistry,
} from "./production-license-policy.mjs";

const maximumRegistryResponseBytes = 1024 * 1024;
const registryTimeoutMilliseconds = 10_000;
const lockfileSource = await readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const inventory = await generateProductionLicenseInventory(lockfileSource, readRegistryMetadata);
const serializedInventory = `${JSON.stringify(inventory, null, 2)}\n`;
if (process.argv.includes("--write")) {
  await writeFile(
    new URL("../config/production-license-inventory.json", import.meta.url),
    serializedInventory,
    { encoding: "utf8", flag: "w", mode: 0o644 },
  );
  process.stdout.write(
    `Updated config/production-license-inventory.json for ` +
      `${String(inventory.productionPackageCount)} production packages.\n`,
  );
} else {
  process.stdout.write(serializedInventory);
}

async function readRegistryMetadata({ name, version }) {
  const path = `${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  let response;
  try {
    response = await fetch(new URL(path, productionLicenseRegistry), {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(registryTimeoutMilliseconds),
    });
  } catch (error) {
    throw new Error(`registry metadata request failed for ${name}@${version}`, {
      cause: error,
    });
  }
  if (!response.ok || !response.body) {
    throw new Error(`registry metadata request failed for ${name}@${version}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(`registry metadata was not JSON for ${name}@${version}`);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > maximumRegistryResponseBytes) {
      await reader.cancel();
      throw new Error(`registry metadata exceeded the size limit for ${name}@${version}`);
    }
    chunks.push(result.value);
  }

  const body = Buffer.concat(chunks, totalBytes).toString("utf8");
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`registry metadata was invalid JSON for ${name}@${version}`);
  }
}
