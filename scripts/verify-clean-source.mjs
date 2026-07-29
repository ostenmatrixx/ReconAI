import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryPrefix = join(tmpdir(), "reconai-clean-source.");
const maximumSourceFileBytes = 5 * 1024 * 1024;
const forbiddenPathParts = new Set([
  ".git",
  ".next",
  ".pnpm-store",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const forbiddenExtensions = [".cer", ".crt", ".key", ".p12", ".pem", ".pfx"];
const commandResults = [];

function parseEvidenceOutputPath() {
  const flagIndex = process.argv.indexOf("--evidence-output");

  if (flagIndex === -1) {
    return undefined;
  }

  const value = process.argv[flagIndex + 1];

  if (!value || value.startsWith("--")) {
    throw new Error("--evidence-output requires a repository-relative artifacts/*.json path");
  }

  const outputPath = resolve(repositoryRoot, value);
  const relativeOutputPath = relative(repositoryRoot, outputPath);

  if (
    relativeOutputPath.startsWith(`..${sep}`) ||
    !/^artifacts\/[a-z0-9][a-z0-9.-]*-verification-\d{4}-\d{2}-\d{2}\.json$/u.test(
      relativeOutputPath,
    )
  ) {
    throw new Error(
      "--evidence-output must be a dated repository-relative artifacts/*-verification-YYYY-MM-DD.json path",
    );
  }

  return { outputPath, relativeOutputPath };
}

function runCommand(command, arguments_, options = {}) {
  const startedAt = Date.now();

  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? repositoryRoot,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        ...(options.environment ?? {}),
      },
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
        command: [command, ...arguments_].join(" "),
        durationMs: Date.now() - startedAt,
        exitCode,
        signal,
      };

      if (exitCode !== 0) {
        rejectCommand(
          new Error(
            `${result.command} failed with exit code ${String(exitCode)}${
              stderr ? `: ${stderr.trim()}` : ""
            }`,
          ),
        );
        return;
      }

      resolveCommand({
        ...result,
        stdout: stdout.trim(),
      });
    });
  });
}

async function candidateSourcePaths() {
  const result = await runCommand(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { capture: true },
  );

  return result.stdout
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function validateCandidatePath(path) {
  if (isAbsolute(path) || path.includes("\\") || path.split("/").includes("..")) {
    throw new Error(`unsafe source path: ${path}`);
  }

  const parts = path.split("/");

  if (parts.some((part) => forbiddenPathParts.has(part))) {
    throw new Error(`generated or repository-control path entered source export: ${path}`);
  }

  if (
    parts.some(
      (part) =>
        part.startsWith(".env") && part !== ".env.example" && part !== ".environment.example",
    )
  ) {
    throw new Error(`runtime environment file entered source export: ${path}`);
  }

  if (forbiddenExtensions.some((extension) => path.toLowerCase().endsWith(extension))) {
    throw new Error(`credential-like file entered source export: ${path}`);
  }
}

async function sourceManifest(root, paths) {
  const hash = createHash("sha256");
  let totalBytes = 0;

  for (const path of paths) {
    validateCandidatePath(path);
    const sourcePath = join(root, path);
    const sourceStat = await lstat(sourcePath);

    if (!sourceStat.isFile()) {
      throw new Error(`source export supports regular files only: ${path}`);
    }

    if (sourceStat.size > maximumSourceFileBytes) {
      throw new Error(
        `${path} is ${sourceStat.size} bytes; source-file maximum is ${maximumSourceFileBytes}`,
      );
    }

    const contents = await readFile(sourcePath);
    totalBytes += contents.length;
    hash.update(path);
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }

  return {
    fileCount: paths.length,
    totalBytes,
    sha256: hash.digest("hex"),
  };
}

async function changedCandidatePaths(destinationRoot, paths) {
  const changedPaths = [];

  for (const path of paths) {
    const original = await readFile(join(repositoryRoot, path));
    const candidate = await readFile(join(destinationRoot, path));

    if (!original.equals(candidate)) {
      changedPaths.push(path);
    }
  }

  return changedPaths;
}

async function copyCandidateSource(destinationRoot, paths) {
  for (const path of paths) {
    const sourcePath = join(repositoryRoot, path);
    const destinationPath = join(destinationRoot, path);
    const sourceStat = await stat(sourcePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
    await chmod(destinationPath, sourceStat.mode);
  }
}

async function safeCleanup(path) {
  if (!path.startsWith(temporaryPrefix)) {
    throw new Error(`refusing to remove unexpected temporary path: ${path}`);
  }

  await rm(path, { recursive: true, force: true });
}

const evidenceOutput = parseEvidenceOutputPath();
const sourceBoundaryPreflight = await runCommand("node", ["scripts/validate-source-boundary.mjs"], {
  cwd: repositoryRoot,
});
commandResults.push(sourceBoundaryPreflight);
const candidatePaths = await candidateSourcePaths();

if (candidatePaths.length === 0) {
  throw new Error("Git reported no publishable candidate source files");
}

if (
  evidenceOutput &&
  candidatePaths.some((path) => resolve(repositoryRoot, path) === evidenceOutput.outputPath)
) {
  throw new Error(
    `${evidenceOutput.relativeOutputPath} already exists; evidence is append-only, so choose a new dated path`,
  );
}

const beforeManifest = await sourceManifest(repositoryRoot, candidatePaths);
const temporaryRoot = await mkdtemp(temporaryPrefix);
const startedAt = new Date().toISOString();

try {
  await copyCandidateSource(temporaryRoot, candidatePaths);
  await runCommand("git", ["init", "--quiet"], { cwd: temporaryRoot });
  await copyFile(join(temporaryRoot, ".env.example"), join(temporaryRoot, ".env"));

  const pnpmVersion = await runCommand("corepack", ["pnpm", "--version"], {
    capture: true,
    cwd: temporaryRoot,
  });
  const gitVersion = await runCommand("git", ["--version"], {
    capture: true,
    cwd: temporaryRoot,
  });

  for (const [command, arguments_, environment] of [
    ["corepack", ["pnpm", "install", "--frozen-lockfile"], {}],
    ["corepack", ["pnpm", "secret:scan"], {}],
    ["corepack", ["pnpm", "audit", "--prod", "--audit-level", "high"], {}],
    ["corepack", ["pnpm", "test:e2e"], { CI: "true" }],
    [
      "corepack",
      ["pnpm", "verify"],
      {
        CI: "true",
        ...(evidenceOutput
          ? { RECONAI_PENDING_EVIDENCE_PATH: evidenceOutput.relativeOutputPath }
          : {}),
      },
    ],
  ]) {
    commandResults.push(
      await runCommand(command, arguments_, {
        cwd: temporaryRoot,
        environment,
      }),
    );

    const commandManifest = await sourceManifest(temporaryRoot, candidatePaths);

    if (JSON.stringify(commandManifest) !== JSON.stringify(beforeManifest)) {
      const changedPaths = await changedCandidatePaths(temporaryRoot, candidatePaths);
      const isExpectedNextDevelopmentTypePath =
        arguments_.includes("test:e2e") &&
        changedPaths.length === 1 &&
        changedPaths[0] === "apps/web/next-env.d.ts";

      if (!isExpectedNextDevelopmentTypePath) {
        throw new Error(
          `${command} ${arguments_.join(" ")} modified publishable source: ${changedPaths.join(", ")}`,
        );
      }
    }
  }

  const afterCandidatePaths = await runCommand(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      capture: true,
      cwd: temporaryRoot,
    },
  );
  const normalizedAfterPaths = afterCandidatePaths.stdout
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

  if (JSON.stringify(normalizedAfterPaths) !== JSON.stringify(candidatePaths)) {
    throw new Error("install or verification created an unexpected publishable source file");
  }

  const evidence = {
    artifactVersion: 1,
    evidenceType: "clean-source-export-verification",
    startedAt,
    completedAt: new Date().toISOString(),
    sourceBoundary: {
      selection: "git ls-files --cached --others --exclude-standard",
      ...beforeManifest,
      runtimeEnvironmentCopiedFrom: ".env.example",
      generatedEvidenceExcludedFromSnapshot: evidenceOutput?.relativeOutputPath ?? null,
    },
    environment: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      pnpmVersion: pnpmVersion.stdout,
      gitVersion: gitVersion.stdout,
    },
    checks: commandResults,
    outcomes: {
      frozenInstallPassed: true,
      secretScanPassed: true,
      highSeverityProductionAuditPassed: true,
      staticVerificationAndProductionBuildPassed: true,
      chromiumBrowserSuitePassed: true,
      publishableSourceUnchanged: true,
      unexpectedPublishableFilesCreated: false,
      temporarySourceRemoved: true,
      nextDevelopmentTypePathRestoredByProductionBuild: true,
    },
    limitations: [
      "This is an export of the current Git-ignore-clean candidate source because the repository has no initial commit; it is not evidence of a remote clone.",
      "A temporary Git repository was initialized only so the documented prepare hook had the same repository boundary available after a clone.",
      "The synthetic .env was copied from .env.example; no customer, production, or provider system was contacted.",
      "Docker and Compose were unavailable, so container startup, migration, fixtures, live service smoke, and network boundaries were not exercised.",
      "The generated evidence file is necessarily outside the hashed source snapshot that produced it.",
      "Next.js rewrites apps/web/next-env.d.ts for development; only that exact interim browser-test change is allowed, and the final production build must restore the original manifest.",
      "One local workstation run is not CI, staging, production-readiness, reliability, capacity, or compliance evidence.",
    ],
  };

  await safeCleanup(temporaryRoot);

  if (evidenceOutput) {
    await writeFile(evidenceOutput.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  }

  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  await safeCleanup(temporaryRoot);
  throw error;
}
