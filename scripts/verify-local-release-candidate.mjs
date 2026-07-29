import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseReviewedTrivyVersion,
  summarizeCycloneDx,
  summarizeTrivyVulnerabilityReport,
} from "./local-release-candidate-policy.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryPrefix = join(tmpdir(), "reconai-local-release-candidate.");
const podmanExecutable = "/opt/podman/bin/podman";
const maximumSourceFileBytes = 5 * 1024 * 1024;
const expectedPlatform = "linux/arm64";
const services = ["api", "worker", "web"];
const imageTags = Object.fromEntries(
  services.map((service) => [
    service,
    `localhost/reconai-${service}-local-candidate-verification:2026-07-30`,
  ]),
);
const buildContextExcludedRoots = new Set([
  ".github",
  ".planning",
  "artifacts",
  "coverage",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const buildContextExcludedParts = new Set([".next", "dist", "node_modules"]);
const forbiddenBakedEnvironmentPattern =
  /(?:^|_)(?:API_KEY|DATABASE_URL|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)(?:_|$)/u;

if (process.env["NODE_ENV"] === "production" || process.env["APP_ENV"] === "production") {
  throw new Error("local candidate verification must not run in a production environment");
}

const trivyExecutable = requiredAbsoluteFileEnvironment("RECONAI_TRIVY_BIN");
const expectedTrivySha256 = requiredSha256Environment("RECONAI_TRIVY_SHA256");
const actualTrivySha256 = await sha256File(trivyExecutable);
if (actualTrivySha256 !== expectedTrivySha256) {
  throw new Error("Trivy binary SHA-256 did not match the externally reviewed release checksum");
}
const trivyVersionResult = await runCommand(trivyExecutable, ["--version"], {
  capture: true,
  environment: boundedTrivyEnvironment(undefined),
});
const trivyVersion = parseReviewedTrivyVersion(trivyVersionResult.stdout);

if (!existsSync(podmanExecutable)) {
  throw new Error(`required rootless Podman executable is absent: ${podmanExecutable}`);
}
for (const tag of Object.values(imageTags)) {
  if ((await runCommand(podmanExecutable, ["image", "exists", tag], { allowFailure: true })).ok) {
    throw new Error(`refusing to replace an existing local candidate tag: ${tag}`);
  }
}

const sourcePaths = await buildContextSourcePaths();
const sourceManifest = sourceManifestForPaths(sourcePaths);
const gitHead = await runCommand("git", ["rev-parse", "--verify", "HEAD"], {
  allowFailure: true,
  capture: true,
});
const temporaryRoot = mkdtempSync(temporaryPrefix);
const trivyCache = join(temporaryRoot, "trivy-cache");
const isolatedRegistryConfig = join(temporaryRoot, "registry");
const podmanAuthFile = join(isolatedRegistryConfig, "auth.json");
const dockerConfigFile = join(isolatedRegistryConfig, "config.json");
mkdirSync(isolatedRegistryConfig, { recursive: true, mode: 0o700 });
writeFileSync(podmanAuthFile, "{}\n", { encoding: "utf8", mode: 0o600 });
writeFileSync(dockerConfigFile, "{}\n", { encoding: "utf8", mode: 0o600 });

const candidates = {};
let toolVersions;
let cleanup;
const startedAt = new Date().toISOString();

try {
  await runCommand(
    trivyExecutable,
    ["image", "--cache-dir", trivyCache, "--download-db-only", "--quiet", "--timeout", "10m"],
    { environment: boundedTrivyEnvironment(isolatedRegistryConfig) },
  );
  toolVersions = await readToolVersions(trivyCache, isolatedRegistryConfig);

  for (const service of services) {
    const tag = imageTags[service];
    const serviceDirectory = join(temporaryRoot, service);
    const archivePath = join(serviceDirectory, "image.oci.tar");
    const ociLayoutPath = join(serviceDirectory, "oci-layout");
    const scanPath = join(serviceDirectory, "vulnerabilities.json");
    const sbomPath = join(serviceDirectory, "image.cdx.json");
    mkdirSync(serviceDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(ociLayoutPath, { recursive: true, mode: 0o700 });
    const buildStarted = Date.now();
    await runCommand(
      podmanExecutable,
      [
        "build",
        "--authfile",
        podmanAuthFile,
        "--file",
        `apps/${service}/Dockerfile`,
        "--format",
        "oci",
        "--platform",
        expectedPlatform,
        "--pull=missing",
        "--tag",
        tag,
        ".",
      ],
      { cwd: repositoryRoot },
    );
    const buildDurationMs = Date.now() - buildStarted;
    const inspection = await inspectCandidate(tag);

    await runCommand(podmanExecutable, [
      "save",
      "--format",
      "oci-archive",
      "--output",
      archivePath,
      tag,
    ]);
    const archiveMembers = await runCommand("tar", ["-tf", archivePath], { capture: true });
    assertOciArchiveMembers(archiveMembers.stdout);
    await runCommand("tar", ["-xf", archivePath, "-C", ociLayoutPath]);

    const scanStarted = Date.now();
    await runCommand(
      trivyExecutable,
      [
        "image",
        "--cache-dir",
        trivyCache,
        "--input",
        ociLayoutPath,
        "--scanners",
        "vuln",
        "--pkg-types",
        "os,library",
        "--ignore-unfixed",
        "--severity",
        "HIGH,CRITICAL",
        "--list-all-pkgs",
        "--format",
        "json",
        "--output",
        scanPath,
        "--timeout",
        "10m",
      ],
      { environment: boundedTrivyEnvironment(isolatedRegistryConfig) },
    );
    const scanDurationMs = Date.now() - scanStarted;
    const vulnerabilitySummary = summarizeTrivyVulnerabilityReport(readJson(scanPath));
    if (vulnerabilitySummary.highCount > 0 || vulnerabilitySummary.criticalCount > 0) {
      throw new Error(
        `${service} candidate has ${vulnerabilitySummary.highCount} High and ` +
          `${vulnerabilitySummary.criticalCount} Critical fixed vulnerability findings`,
      );
    }

    const sbomStarted = Date.now();
    await runCommand(
      trivyExecutable,
      [
        "image",
        "--cache-dir",
        trivyCache,
        "--input",
        ociLayoutPath,
        "--scanners",
        "vuln",
        "--pkg-types",
        "os,library",
        "--ignore-unfixed",
        "--severity",
        "HIGH,CRITICAL",
        "--format",
        "cyclonedx",
        "--output",
        sbomPath,
        "--timeout",
        "10m",
      ],
      { environment: boundedTrivyEnvironment(isolatedRegistryConfig) },
    );
    const sbomDurationMs = Date.now() - sbomStarted;
    const sbomSummary = summarizeCycloneDx(readJson(sbomPath));

    candidates[service] = {
      ...inspection,
      platform: expectedPlatform,
      buildDurationMs,
      archive: {
        format: "OCI image layout archive",
        sizeBytes: lstatSync(archivePath).size,
        sha256: await sha256File(archivePath),
      },
      vulnerabilityGate: {
        ...vulnerabilitySummary,
        ignoredUnfixed: true,
        severities: ["HIGH", "CRITICAL"],
        packageTypes: ["os", "library"],
        scanDurationMs,
        passed: true,
      },
      cyclonedx: {
        ...sbomSummary,
        sizeBytes: lstatSync(sbomPath).size,
        sha256: await sha256File(sbomPath),
        generationDurationMs: sbomDurationMs,
      },
    };
  }
} finally {
  for (const tag of Object.values(imageTags)) {
    await runCommand(podmanExecutable, ["image", "rm", tag], {
      allowFailure: true,
      capture: true,
    });
  }
  safeCleanup(temporaryRoot);
  cleanup = {
    candidateTagsRemaining: (
      await Promise.all(
        Object.values(imageTags).map(async (tag) =>
          (await runCommand(podmanExecutable, ["image", "exists", tag], { allowFailure: true })).ok
            ? 1
            : 0,
        ),
      )
    ).reduce((sum, value) => sum + value, 0),
    temporaryDirectoryRemoved: !existsSync(temporaryRoot),
    intermediateImageCacheRetained: true,
  };
}

if (!toolVersions || Object.keys(candidates).length !== services.length) {
  throw new Error("local release candidate verification did not complete every service");
}
if (cleanup.candidateTagsRemaining !== 0 || !cleanup.temporaryDirectoryRemoved) {
  throw new Error("local release candidate verification cleanup was incomplete");
}

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      startedAt,
      component: "local-native-oci-release-candidate-integrity",
      outcome: "local_native_candidate_passed",
      productionReadinessClaim: false,
      scope: {
        customerDataUsed: false,
        providerSystemsContacted: false,
        publishedOrDeployed: false,
        signedAttestationCreated: false,
        platform: expectedPlatform,
      },
      source: {
        selection: "Git-ignore-clean files included by the checked-in Docker build context",
        fileCount: sourceManifest.fileCount,
        totalBytes: sourceManifest.totalBytes,
        sha256: sourceManifest.sha256,
        gitHeadPresent: gitHead.ok,
        gitCommit: gitHead.ok ? gitHead.stdout : null,
      },
      tools: {
        ...toolVersions,
        trivyBinarySha256: actualTrivySha256,
      },
      candidates,
      cleanup,
      limitations: [
        "This is a native Linux ARM64 rootless-Podman exercise, not the hosted BuildKit linux/amd64 candidate workflow.",
        "The repository has no Git HEAD, so the source is bound by a deterministic build-context manifest rather than a commit identity.",
        "OCI archives and generated SBOMs were hashed and then removed; only the bounded credential-free summary is retained.",
        "No GitHub OIDC identity, Sigstore bundle, embedded BuildKit provenance/SBOM, registry digest, publication, deployment, or admission policy was exercised.",
        "The High/Critical gate ignores unfixed findings to match the checked-in candidate workflow and is only as current as the recorded Trivy databases.",
        "A passing vulnerability scan is not proof that the images are vulnerability-free or production-ready.",
      ],
      credentialsRecorded: false,
    },
    null,
    2,
  )}\n`,
);

async function readToolVersions(trivyCachePath, registryConfigPath) {
  const podmanVersionResult = await runCommand(podmanExecutable, ["version", "--format", "json"], {
    capture: true,
  });
  const podmanVersion = JSON.parse(podmanVersionResult.stdout);
  const trivyDatabaseResult = await runCommand(
    trivyExecutable,
    ["version", "--cache-dir", trivyCachePath, "--format", "json"],
    {
      capture: true,
      environment: boundedTrivyEnvironment(registryConfigPath),
    },
  );
  const trivyDatabase = JSON.parse(trivyDatabaseResult.stdout);

  return {
    podmanClientVersion: requiredString(podmanVersion?.Client?.Version, "Podman client version"),
    podmanServerVersion: requiredString(podmanVersion?.Server?.Version, "Podman server version"),
    trivyVersion,
    vulnerabilityDatabase: summarizeDatabaseMetadata(
      trivyDatabase?.VulnerabilityDB,
      "Trivy vulnerability database",
    ),
    ...(trivyDatabase?.JavaDB
      ? { javaDatabase: summarizeDatabaseMetadata(trivyDatabase.JavaDB, "Trivy Java database") }
      : {}),
  };
}

function summarizeDatabaseMetadata(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} metadata was unavailable`);
  }
  return {
    schemaVersion: requiredPositiveInteger(value.Version, `${label} schema version`),
    updatedAt: requiredInstant(value.UpdatedAt, `${label} updated time`),
    nextUpdate: requiredInstant(value.NextUpdate, `${label} next update`),
    downloadedAt: requiredInstant(value.DownloadedAt, `${label} download time`),
  };
}

async function inspectCandidate(tag) {
  const result = await runCommand(podmanExecutable, ["image", "inspect", "--format", "json", tag], {
    capture: true,
  });
  const [inspection] = JSON.parse(result.stdout);
  if (!inspection || typeof inspection !== "object") {
    throw new Error(`Podman returned no image inspection for ${tag}`);
  }
  const user = requiredString(inspection.Config?.User, `${tag} declared user`);
  const architecture = requiredString(inspection.Architecture, `${tag} architecture`);
  const operatingSystem = requiredString(inspection.Os, `${tag} operating system`);
  if (user !== "node" || architecture !== "arm64" || operatingSystem !== "linux") {
    throw new Error(`${tag} violated the expected non-root linux/arm64 image boundary`);
  }
  const bakedEnvironmentNames = (inspection.Config?.Env ?? []).map(
    (entry) => requiredString(entry, `${tag} environment entry`).split("=", 1)[0],
  );
  const forbiddenBakedEnvironmentNames = bakedEnvironmentNames.filter((name) =>
    forbiddenBakedEnvironmentPattern.test(name),
  );
  if (forbiddenBakedEnvironmentNames.length > 0) {
    throw new Error(`${tag} baked credential-like environment names into the image`);
  }

  return {
    imageId: requiredString(inspection.Id, `${tag} image ID`).replace(/^sha256:/u, ""),
    sizeBytes: requiredPositiveInteger(inspection.Size, `${tag} image size`),
    architecture,
    operatingSystem,
    declaredUser: user,
    forbiddenBakedEnvironmentNames,
  };
}

async function buildContextSourcePaths() {
  const result = await runCommand(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { capture: true },
  );
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .filter(isIncludedInDockerBuildContext)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function isIncludedInDockerBuildContext(path) {
  if (isAbsolute(path) || path.includes("\\") || path.split("/").includes("..")) {
    throw new Error(`unsafe source path: ${path}`);
  }
  const parts = path.split("/");
  if (buildContextExcludedRoots.has(parts[0])) return false;
  if (parts.some((part) => buildContextExcludedParts.has(part))) return false;
  if (basename(path).endsWith(".log")) return false;
  if (
    basename(path).startsWith(".env") &&
    basename(path) !== ".env.example" &&
    basename(path) !== ".environment.example"
  ) {
    return false;
  }
  return true;
}

function sourceManifestForPaths(paths) {
  if (paths.length === 0) {
    throw new Error("Docker build context source selection returned no files");
  }
  const hash = createHash("sha256");
  let totalBytes = 0;
  for (const path of paths) {
    const absolutePath = join(repositoryRoot, path);
    const file = lstatSync(absolutePath);
    if (!file.isFile()) {
      throw new Error(`Docker build context source must be a regular file: ${path}`);
    }
    if (file.size > maximumSourceFileBytes) {
      throw new Error(`${path} exceeds the bounded source file size`);
    }
    const contents = readFileSync(absolutePath);
    totalBytes += contents.length;
    hash.update(path);
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  return { fileCount: paths.length, totalBytes, sha256: hash.digest("hex") };
}

function assertOciArchiveMembers(output) {
  const memberList = output.split(/\r?\n/u).filter(Boolean);
  for (const member of memberList) {
    if (isAbsolute(member) || member.split("/").includes("..")) {
      throw new Error("candidate OCI archive contained an unsafe member path");
    }
  }
  const members = new Set(memberList);
  if (
    !members.has("oci-layout") ||
    !members.has("index.json") ||
    ![...members].some((member) => /^blobs\/sha256\/[0-9a-f]{64}$/u.test(member))
  ) {
    throw new Error("candidate archive was not a complete OCI image layout");
  }
}

function boundedTrivyEnvironment(registryConfigPath) {
  return boundedEnvironment({
    ...(registryConfigPath ? { DOCKER_CONFIG: registryConfigPath } : {}),
  });
}

function boundedEnvironment(additions = {}) {
  const environment = { ...additions };
  for (const name of [
    "CONTAINER_CONNECTION",
    "CONTAINER_HOST",
    "LANG",
    "LC_ALL",
    "PATH",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
  ]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function requiredAbsoluteFileEnvironment(name) {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path to the externally verified scanner binary`);
  }
  const file = lstatSync(value);
  if (!file.isFile()) {
    throw new Error(`${name} must identify a regular file`);
  }
  return value;
}

function requiredSha256Environment(name) {
  const value = process.env[name];
  if (!value || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${name} must be one lowercase SHA-256 digest`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requiredInstant(value, label) {
  const instant = requiredString(value, label);
  if (!Number.isFinite(Date.parse(instant))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return instant;
}

function safeCleanup(path) {
  const pathRelativeToPrefix = relative(dirname(temporaryPrefix), path);
  if (
    !path.startsWith(temporaryPrefix) ||
    pathRelativeToPrefix.includes(sep) ||
    basename(path).length <= basename(temporaryPrefix).length
  ) {
    throw new Error(`refusing to remove unexpected temporary path: ${path}`);
  }
  rmSync(path, { recursive: true, force: true });
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", resolveHash);
  });
  return hash.digest("hex");
}

function runCommand(command, arguments_, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.environment ?? boundedEnvironment(),
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }
    child.on("error", rejectCommand);
    child.on("close", (exitCode, signal) => {
      const result = {
        ok: exitCode === 0,
        exitCode,
        signal,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
      if (result.ok || options.allowFailure) {
        resolveCommand(result);
      } else {
        rejectCommand(
          new Error(
            `${command} ${arguments_.join(" ")} failed with ${String(exitCode)}${
              result.stderr ? `: ${result.stderr}` : ""
            }`,
          ),
        );
      }
    });
  });
}
