import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

import {
  assertSafeTemporaryClonePath,
  expectedNextDevelopmentTypeContents,
  parseLiteralCloneArguments,
  temporaryClonePrefix,
} from "./literal-clone-policy.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseLiteralCloneArguments(process.argv.slice(2), repositoryRoot);
const temporaryPrefix = join(tmpdir(), temporaryClonePrefix);
const commandResults = [];
let activeChild;
let activeForceKillTimeout;

function terminateActiveChild(signal = "SIGTERM") {
  if (!activeChild?.pid) return;

  try {
    if (process.platform === "win32") {
      activeChild.kill(signal);
    } else {
      process.kill(-activeChild.pid, signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function terminateActiveChildWithEscalation(signal = "SIGTERM") {
  if (!activeChild?.pid) return;

  terminateActiveChild(signal);
  clearTimeout(activeForceKillTimeout);
  activeForceKillTimeout = setTimeout(() => {
    terminateActiveChild("SIGKILL");
  }, 5_000);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    terminateActiveChildWithEscalation(signal);
  });
}

function runCommand(command, arguments_, runOptions = {}) {
  const startedAt = Date.now();

  return new Promise((resolveCommand, rejectCommand) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, arguments_, {
      cwd: runOptions.cwd,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        CI: "true",
        GIT_TERMINAL_PROMPT: "0",
        NEXT_TELEMETRY_DISABLED: "1",
        ...(runOptions.environment ?? {}),
      },
      stdio: runOptions.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    activeChild = child;

    if (runOptions.capture) {
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    const timeout = setTimeout(
      () => {
        timedOut = true;
        terminateActiveChildWithEscalation();
      },
      runOptions.timeoutMs ?? 20 * 60_000,
    );

    child.on("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(activeForceKillTimeout);
      activeChild = undefined;
      rejectCommand(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      clearTimeout(activeForceKillTimeout);
      activeChild = undefined;
      const result = {
        command: runOptions.evidenceCommand ?? [command, ...arguments_].join(" "),
        durationMs: Date.now() - startedAt,
        exitCode,
        signal,
      };

      if (timedOut || exitCode !== 0) {
        const capturedFailure = stderr.trim() || stdout.trim();
        rejectCommand(
          new Error(
            `${result.command} ${timedOut ? "timed out" : `failed with exit code ${String(exitCode)}`}${
              capturedFailure ? `: ${capturedFailure.slice(-2_000)}` : ""
            }`,
          ),
        );
        return;
      }

      resolveCommand({ result, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function runRecorded(command, arguments_, runOptions = {}) {
  const execution = await runCommand(command, arguments_, runOptions);
  commandResults.push(execution.result);
  return execution;
}

async function capturedGit(cloneRoot, arguments_) {
  return (
    await runCommand("git", arguments_, {
      cwd: cloneRoot,
      capture: true,
      timeoutMs: 60_000,
    })
  ).stdout;
}

async function assertCleanRepository(cloneRoot, phase) {
  const status = await capturedGit(cloneRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);

  if (status.length > 0) {
    throw new Error(`${phase} left the literal clone dirty: ${status}`);
  }
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function safeCleanup(path) {
  assertSafeTemporaryClonePath(path, tmpdir());
  await rm(path, { recursive: true, force: true });
}

if (options.evidenceOutput) {
  try {
    await readFile(options.evidenceOutput.outputPath);
    throw new Error(
      `${options.evidenceOutput.relativeOutputPath} already exists; literal-clone evidence is append-only`,
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const temporaryRoot = await mkdtemp(temporaryPrefix);
const cloneRoot = join(temporaryRoot, "repository");
const startedAt = new Date().toISOString();

try {
  await runRecorded(
    "git",
    [
      "-c",
      "credential.helper=",
      "clone",
      "--branch",
      options.ref,
      "--single-branch",
      "--no-tags",
      "--",
      options.repository,
      cloneRoot,
    ],
    {
      cwd: temporaryRoot,
      timeoutMs: 5 * 60_000,
      evidenceCommand:
        "git -c credential.helper= clone --branch <validated-ref> --single-branch --no-tags -- <canonical-public-remote> <temporary-directory>",
    },
  );

  const origin = await capturedGit(cloneRoot, ["remote", "get-url", "origin"]);
  const commit = await capturedGit(cloneRoot, ["rev-parse", "HEAD"]);
  const tree = await capturedGit(cloneRoot, ["rev-parse", "HEAD^{tree}"]);
  const trackedFiles = (await capturedGit(cloneRoot, ["ls-files", "--cached", "-z"]))
    .split("\0")
    .filter(Boolean);

  if (origin !== options.repository) {
    throw new Error(`literal clone origin mismatch: ${origin}`);
  }

  if (commit !== options.expectedCommit) {
    throw new Error(
      `literal clone commit mismatch: expected ${options.expectedCommit}, received ${commit}`,
    );
  }

  await assertCleanRepository(cloneRoot, "initial clone");
  await runRecorded("git", ["fsck", "--full"], {
    cwd: cloneRoot,
    timeoutMs: 5 * 60_000,
  });

  const nextEnvironmentPath = join(cloneRoot, "apps/web/next-env.d.ts");
  const originalNextEnvironment = await readFile(nextEnvironmentPath, "utf8");
  const expectedDevelopmentNextEnvironment =
    expectedNextDevelopmentTypeContents(originalNextEnvironment);

  await copyFile(join(cloneRoot, ".env.example"), join(cloneRoot, ".env"));

  const gitVersion = await runCommand("git", ["--version"], {
    cwd: cloneRoot,
    capture: true,
    timeoutMs: 60_000,
  });
  const pnpmVersion = await runCommand("corepack", ["pnpm", "--version"], {
    cwd: cloneRoot,
    capture: true,
    timeoutMs: 60_000,
  });

  await runRecorded("corepack", ["pnpm", "install", "--frozen-lockfile"], {
    cwd: cloneRoot,
    timeoutMs: 10 * 60_000,
  });
  await assertCleanRepository(cloneRoot, "frozen install");

  await runRecorded(
    "corepack",
    ["pnpm", "--filter", "@workspace/web", "exec", "playwright", "install", "chromium"],
    {
      cwd: cloneRoot,
      timeoutMs: 10 * 60_000,
    },
  );
  await assertCleanRepository(cloneRoot, "Chromium installation");

  await runRecorded("corepack", ["pnpm", "secret:scan"], {
    cwd: cloneRoot,
    timeoutMs: 10 * 60_000,
  });
  await assertCleanRepository(cloneRoot, "secret scan");

  await runRecorded("corepack", ["pnpm", "audit", "--prod", "--audit-level", "high"], {
    cwd: cloneRoot,
    timeoutMs: 10 * 60_000,
  });
  await assertCleanRepository(cloneRoot, "production dependency audit");

  await runRecorded("corepack", ["pnpm", "test:e2e"], {
    cwd: cloneRoot,
    timeoutMs: 15 * 60_000,
  });

  const interimNextEnvironment = await readFile(nextEnvironmentPath, "utf8");
  const interimChangedFiles = await capturedGit(cloneRoot, ["diff", "--name-only"]);
  const interimStagedFiles = await capturedGit(cloneRoot, ["diff", "--cached", "--name-only"]);
  const interimUntrackedFiles = await capturedGit(cloneRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);

  if (
    interimNextEnvironment !== expectedDevelopmentNextEnvironment ||
    interimChangedFiles !== "apps/web/next-env.d.ts" ||
    interimStagedFiles.length > 0 ||
    interimUntrackedFiles.length > 0
  ) {
    throw new Error(
      "Chromium verification changed source beyond the reviewed Next.js development type-path rewrite",
    );
  }

  await runRecorded("corepack", ["pnpm", "verify"], {
    cwd: cloneRoot,
    timeoutMs: 20 * 60_000,
    environment: options.evidenceOutput
      ? { RECONAI_PENDING_EVIDENCE_PATH: options.evidenceOutput.relativeOutputPath }
      : {},
  });

  if ((await readFile(nextEnvironmentPath, "utf8")) !== originalNextEnvironment) {
    throw new Error("production build did not restore the exact tracked Next.js type manifest");
  }

  await assertCleanRepository(cloneRoot, "complete verification");

  const evidence = {
    artifactVersion: 1,
    evidenceType: "literal-remote-clone-verification",
    startedAt,
    completedAt: new Date().toISOString(),
    source: {
      repository: options.repository,
      ref: options.ref,
      expectedCommit: options.expectedCommit,
      observedCommit: commit,
      tree,
      trackedFileCount: trackedFiles.length,
      pnpmLockSha256: await sha256(join(cloneRoot, "pnpm-lock.yaml")),
      runtimeEnvironmentCopiedFrom: ".env.example",
      generatedEvidenceExcludedFromCommit: options.evidenceOutput?.relativeOutputPath ?? null,
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
      canonicalOriginMatched: true,
      exactCommitMatched: true,
      gitObjectIntegrityPassed: true,
      frozenInstallPassed: true,
      chromiumInstallationPassed: true,
      secretScanPassed: true,
      highSeverityProductionAuditPassed: true,
      chromiumBrowserSuitePassed: true,
      staticVerificationAndProductionBuildPassed: true,
      trackedAndUnignoredSourceUnchanged: true,
      temporaryCloneRemoved: true,
      nextDevelopmentTypePathRestoredByProductionBuild: true,
    },
    limitations: [
      "This record verifies one named branch at one exact pushed commit of the canonical public HTTPS remote; it does not assert the state of another branch or a later force update.",
      "The generated evidence file is necessarily not part of the exact commit that it verifies.",
      "The synthetic .env was copied from .env.example; no customer, production, provider, or protected-staging system was contacted.",
      "GitHub, the package registry, and the Playwright browser service were contacted for the public clone, locked install, dependency audit, and Chromium installation.",
      "Container startup, migrations, fixtures, live services, Docker Engine, deployment, and rollback were not exercised by this verifier.",
      "One workstation run is not reliability, capacity, production-readiness, compliance, or protected-environment evidence.",
    ],
  };

  await safeCleanup(temporaryRoot);

  if (options.evidenceOutput) {
    await writeFile(options.evidenceOutput.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  }

  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  terminateActiveChildWithEscalation();
  await safeCleanup(temporaryRoot);
  throw error;
}
