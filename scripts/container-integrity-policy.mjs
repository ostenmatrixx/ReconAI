const minimumRedisSecurityPatch = [8, 2, 8];
const minimumNodeActiveLtsPatch = [24, 18, 0];
const exactPnpmCacheMount =
  "--mount=type=cache,id=reconai-pnpm-store,target=/pnpm/store,sharing=locked";
const exactContainerInstallCommand = `RUN ${exactPnpmCacheMount} LEFTHOOK=0 pnpm install --frozen-lockfile`;
const exactRuntimeToolchainRemoval =
  "RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack && " +
  "rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm " +
  "/usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg";
const reviewedTrivyActionCommit = "ed142fd0673e97e23eac54620cfb913e5ce36c25";
const reviewedTrivyVersion = "v0.72.0";

/**
 * The image context intentionally excludes Git metadata, so Lefthook cannot install repository
 * hooks there. Require one narrowly scoped bypass while retaining every dependency lifecycle
 * script and preventing the bypass from leaking into later image layers.
 *
 * @param {string} source
 * @returns {readonly string[]}
 */
export function containerInstallBoundaryErrors(source) {
  const errors = [];
  const runCommands = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^RUN\b/u.test(line));
  const installCommands = runCommands.filter((line) => /\bpnpm\s+install\b/u.test(line));
  const deployCommands = runCommands.filter((line) => /\bpnpm\b.*\sdeploy\b/u.test(line));

  if (installCommands.length !== 1 || installCommands[0] !== exactContainerInstallCommand) {
    errors.push(
      `must contain exactly \`${exactContainerInstallCommand}\` for the Git-free build context`,
    );
  }
  for (const command of deployCommands) {
    if (
      !new RegExp(
        `^RUN ${escapeRegExp(exactPnpmCacheMount)} LEFTHOOK=0 ` +
          "pnpm --filter @workspace/(?:api|worker) deploy --prod --legacy /release$",
        "u",
      ).test(command)
    ) {
      errors.push("must scope LEFTHOOK=0 to each production deploy lifecycle command");
    }
  }
  if (/^(?:ENV|ARG)\s+LEFTHOOK(?:=|\s)/mu.test(source)) {
    errors.push("must not persist or parameterize the Lefthook bypass");
  }
  if (/\b(?:--ignore-scripts|ignore-scripts\s*=)/u.test(source)) {
    errors.push("must not disable dependency lifecycle scripts");
  }

  return errors;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Long-lived image processes must not regress to the compatibility parser that requires and
 * exposes authority owned by peer services.
 *
 * @param {string} source
 * @param {"api" | "worker"} service
 * @returns {readonly string[]}
 */
export function serviceRuntimeParserBoundaryErrors(source, service) {
  const errors = [];
  const parser = service === "api" ? "parseApiRuntimeConfig" : "parseWorkerRuntimeConfig";
  if (!source.includes(`import { ${parser} } from "@workspace/config";`)) {
    errors.push(`must import only ${parser} from @workspace/config`);
  }
  if (!source.includes(`const config = ${parser}(process.env);`)) {
    errors.push(`must parse process.env with ${parser}`);
  }
  if (/\bparseRuntimeConfig\b/u.test(source)) {
    errors.push("must not use the full-stack compatibility runtime parser");
  }
  return errors;
}

export function redisSecurityPatchError(tag) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/u.exec(tag);
  if (!match) return "must use an explicit semantic Redis patch version";

  const version = match.slice(1, 4).map(Number);
  for (const [index, required] of minimumRedisSecurityPatch.entries()) {
    const actual = version[index];
    if (actual === undefined) return "must use an explicit semantic Redis patch version";
    if (actual > required) return undefined;
    if (actual < required) {
      return "must not regress below the reviewed Redis 8.2.8 security patch";
    }
  }
  return undefined;
}

export function nodeActiveLtsSecurityPatchError(tag) {
  const match = /^(\d+)\.(\d+)\.(\d+)-bookworm-slim$/u.exec(tag);
  if (!match) return "must use an explicit Node Active LTS bookworm-slim patch";

  const version = match.slice(1, 4).map(Number);
  if (version[0] !== minimumNodeActiveLtsPatch[0]) {
    return "must remain on the reviewed Node 24 Active LTS line";
  }
  for (const [index, required] of minimumNodeActiveLtsPatch.entries()) {
    const actual = version[index];
    if (actual === undefined) return "must use an explicit Node Active LTS bookworm-slim patch";
    if (actual > required) return undefined;
    if (actual < required) {
      return "must not regress below the reviewed Node 24.18.0 Active LTS security baseline";
    }
  }
  return undefined;
}

/**
 * @param {string} source
 * @returns {readonly string[]}
 */
export function containerRuntimeToolchainBoundaryErrors(source) {
  const removalCommands = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        /^RUN\b/u.test(line) &&
        /\/usr\/local\/lib\/node_modules\/(?:npm|corepack)|\/usr\/local\/bin\/npm/u.test(line),
    );
  return removalCommands.length === 1 && removalCommands[0] === exactRuntimeToolchainRemoval
    ? []
    : ["must remove the exact build-only package-manager toolchain from the runtime stage"];
}

/**
 * The March 2026 Trivy ecosystem compromise included mutable action tags and specific scanner
 * releases. Keep the security-sensitive candidate workflow on the reviewed post-remediation action
 * commit and make the scanner binary version explicit instead of inheriting an action default.
 *
 * @param {string} source
 * @returns {readonly string[]}
 */
export function releaseCandidateScannerBoundaryErrors(source) {
  const errors = [];
  const actionReferences = [
    ...source.matchAll(/\buses:\s*aquasecurity\/trivy-action@([0-9a-f]{40})\b/gu),
  ].map((match) => match[1]);
  const scannerVersions = [...source.matchAll(/^\s+version:\s*(\S+)\s*$/gmu)].map(
    (match) => match[1],
  );

  if (
    actionReferences.length !== 2 ||
    actionReferences.some((commit) => commit !== reviewedTrivyActionCommit)
  ) {
    errors.push(
      `must use exactly two Trivy action steps pinned to reviewed commit ${reviewedTrivyActionCommit}`,
    );
  }
  if (scannerVersions.length !== 1 || scannerVersions[0] !== reviewedTrivyVersion) {
    errors.push(`must install exactly reviewed Trivy scanner ${reviewedTrivyVersion}`);
  }
  if (/\bversion:\s*(?:latest|v?0\.69\.[456])\b/iu.test(source)) {
    errors.push("must not use a mutable or incident-affected Trivy scanner version");
  }

  return errors;
}

/**
 * The ordinary pull-request container job has the same scanner authority as the candidate job.
 * Keep its action, scanner binary, and Node test runtime on the reviewed baselines too.
 *
 * @param {string} source
 * @returns {readonly string[]}
 */
export function continuousIntegrationSecurityBoundaryErrors(source) {
  const errors = [];
  const steps = workflowStepBlocks(source);
  const scannerSteps = steps.filter((step) => step.includes("uses: aquasecurity/trivy-action@"));
  const scannerReferences = scannerSteps
    .map((step) => /\buses:\s*aquasecurity\/trivy-action@([0-9a-f]{40})\b/u.exec(step)?.[1])
    .filter((commit) => commit !== undefined);

  if (
    scannerSteps.length !== 1 ||
    scannerReferences.length !== 1 ||
    scannerReferences[0] !== reviewedTrivyActionCommit
  ) {
    errors.push(
      `must use exactly one CI Trivy action step pinned to reviewed commit ${reviewedTrivyActionCommit}`,
    );
  }
  if (
    scannerSteps.length !== 1 ||
    !new RegExp(`^\\s+version:\\s*${escapeRegExp(reviewedTrivyVersion)}\\s*$`, "mu").test(
      scannerSteps[0] ?? "",
    )
  ) {
    errors.push(`must run the CI container scan with reviewed Trivy ${reviewedTrivyVersion}`);
  }
  if (scannerSteps.some((step) => /\bversion:\s*(?:latest|v?0\.69\.[456])\b/iu.test(step))) {
    errors.push("must not use a mutable or incident-affected CI Trivy scanner version");
  }

  const setupNodeSteps = steps.filter((step) => step.includes("uses: actions/setup-node@"));
  if (setupNodeSteps.length !== 2) {
    errors.push("must retain exactly two CI setup-node steps");
  }
  for (const step of setupNodeSteps) {
    const version = /^\s+node-version:\s*(\S+)\s*$/mu.exec(step)?.[1];
    const error =
      version === undefined
        ? "must use an explicit CI Node Active LTS patch"
        : nodeActiveLtsSecurityPatchError(`${version}-bookworm-slim`);
    if (error !== undefined) errors.push(`CI setup-node ${error}`);
  }
  if (!/^\s+DATABASE_MAINTENANCE_URL:\s*postgresql:\/\//mu.test(source)) {
    errors.push("must provide the dedicated maintenance-role URL to live integration tests");
  }

  return errors;
}

function workflowStepBlocks(source) {
  const blocks = [];
  let current = [];
  for (const line of source.split(/\r?\n/u)) {
    if (/^\s+- name:/u.test(line) && current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
    if (current.length > 0 || /^\s+- name:/u.test(line)) current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks;
}
