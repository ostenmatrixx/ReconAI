import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  generateProductionLicenseInventory,
  packageIdentityFromSnapshotKey,
  productionPackageGraph,
  validateProductionLicenseInventory,
} from "./production-license-policy.mjs";

const alphaIntegrity = integrity("alpha");
const betaIntegrity = integrity("beta");
const optionalIntegrity = integrity("optional");
const developmentIntegrity = integrity("development");
const fixtureLockfile = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      alpha:
        specifier: 1.0.0
        version: 1.0.0
      workspace-package:
        specifier: workspace:*
        version: link:packages/workspace-package
    devDependencies:
      development:
        specifier: 4.0.0
        version: 4.0.0
packages:
  alpha@1.0.0:
    resolution: {integrity: ${alphaIntegrity}}
  beta@2.0.0:
    resolution: {integrity: ${betaIntegrity}}
  optional@3.0.0:
    resolution: {integrity: ${optionalIntegrity}}
  development@4.0.0:
    resolution: {integrity: ${developmentIntegrity}}
snapshots:
  alpha@1.0.0:
    dependencies:
      beta: 2.0.0
    optionalDependencies:
      optional: 3.0.0
  beta@2.0.0: {}
  optional@3.0.0: {}
  development@4.0.0: {}
`;

describe("production license policy", () => {
  it("separates pnpm peer context from the registry package identity", () => {
    expect(packageIdentityFromSnapshotKey("@scope/package@1.2.3(peer@4.5.6)")).toEqual({
      name: "@scope/package",
      packageKey: "@scope/package@1.2.3",
      version: "1.2.3",
    });
  });

  it("derives the full production graph while excluding development and workspace links", () => {
    expect(productionPackageGraph(fixtureLockfile).packageKeys).toEqual([
      "alpha@1.0.0",
      "beta@2.0.0",
      "optional@3.0.0",
    ]);
    expect(() =>
      productionPackageGraph(
        fixtureLockfile.replace(
          "        version: 1.0.0",
          "        version: https://packages.example.invalid/alpha-1.0.0.tgz",
        ),
      ),
    ).toThrow("not an exact registry snapshot");
    expect(() =>
      productionPackageGraph(
        fixtureLockfile.replace(`resolution: {integrity: ${alphaIntegrity}}`, "resolution: {}"),
      ),
    ).toThrow("has no supported sha512 integrity");
  });

  it("generates and validates a sorted lockfile-bound inventory", async () => {
    const metadata = new Map([
      ["alpha@1.0.0", packageMetadata("alpha", "1.0.0", "MIT", alphaIntegrity)],
      [
        "beta@2.0.0",
        packageMetadata("beta", "2.0.0", "Apache-2.0 AND LGPL-3.0-or-later", betaIntegrity),
      ],
      [
        "optional@3.0.0",
        packageMetadata(
          "optional",
          "3.0.0",
          "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
          optionalIntegrity,
        ),
      ],
    ]);
    const inventory = await generateProductionLicenseInventory(
      fixtureLockfile,
      async ({ name, version }) => metadata.get(`${name}@${version}`),
      "2026-07-28T00:00:00.000Z",
    );

    expect(Object.keys(inventory.packages)).toEqual([
      "alpha@1.0.0",
      "beta@2.0.0",
      "optional@3.0.0",
    ]);
    expect(validateProductionLicenseInventory(fixtureLockfile, inventory)).toMatchObject({
      packageCount: 3,
      licenses: [
        "Apache-2.0 AND LGPL-3.0-or-later",
        "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
        "MIT",
      ],
    });
  });

  it("rejects registry metadata that does not match lockfile integrity", async () => {
    await expect(
      generateProductionLicenseInventory(
        fixtureLockfile,
        async ({ name, version }) => packageMetadata(name, version, "MIT", integrity("attacker")),
        "2026-07-28T00:00:00.000Z",
      ),
    ).rejects.toThrow("identity, integrity, or license policy");
  });

  it("rejects denied licenses and incomplete inventories", async () => {
    const inventory = await validInventory();
    inventory.packages["alpha@1.0.0"] = "GPL-3.0-only";
    expect(() => validateProductionLicenseInventory(fixtureLockfile, inventory)).toThrow(
      "unapproved or invalid production licenses",
    );

    const incomplete = await validInventory();
    delete incomplete.packages["optional@3.0.0"];
    expect(() => validateProductionLicenseInventory(fixtureLockfile, incomplete)).toThrow(
      "incomplete, stale, or not sorted",
    );
  });

  it("rejects an inventory after any lockfile change", async () => {
    const inventory = await validInventory();
    expect(() => validateProductionLicenseInventory(`${fixtureLockfile}\n`, inventory)).toThrow(
      "does not match the current lockfile",
    );
  });
});

async function validInventory() {
  const licenses = {
    alpha: "MIT",
    beta: "Apache-2.0 AND LGPL-3.0-or-later",
    optional: "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
  };
  const integrities = {
    alpha: alphaIntegrity,
    beta: betaIntegrity,
    optional: optionalIntegrity,
  };
  return generateProductionLicenseInventory(
    fixtureLockfile,
    async ({ name, version }) => packageMetadata(name, version, licenses[name], integrities[name]),
    "2026-07-28T00:00:00.000Z",
  );
}

function packageMetadata(name, version, license, packageIntegrity) {
  return { name, version, license, dist: { integrity: packageIntegrity } };
}

function integrity(value) {
  return `sha512-${createHash("sha512").update(value).digest("base64")}`;
}
