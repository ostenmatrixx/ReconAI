import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Hook installation is inapplicable in the Git-free container build context. Only the documented
 * exact bypass value disables it; ordinary installs still fail if Lefthook cannot install hooks.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @returns {boolean}
 */
export function shouldSkipRepositoryHookInstall(environment) {
  return environment["LEFTHOOK"] === "0";
}

/**
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @returns {number}
 */
export function installRepositoryHooks(environment) {
  if (shouldSkipRepositoryHookInstall(environment)) {
    process.stdout.write("Repository hook installation skipped by exact LEFTHOOK=0 boundary.\n");
    return 0;
  }

  const result = spawnSync("lefthook", ["install"], {
    env: environment,
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write("Repository hook installation could not start Lefthook.\n");
    return 1;
  }
  return result.status ?? 1;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = installRepositoryHooks(process.env);
}
