import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const composeCommands = Object.freeze([
  Object.freeze({
    engine: "docker",
    executable: "docker",
    prefixArguments: Object.freeze(["compose"]),
  }),
  Object.freeze({
    engine: "podman",
    executable: "podman",
    prefixArguments: Object.freeze(["compose"]),
  }),
  Object.freeze({
    engine: "podman",
    executable: "/opt/podman/bin/podman",
    prefixArguments: Object.freeze(["compose"]),
  }),
  Object.freeze({
    engine: "podman",
    executable: "/opt/homebrew/bin/podman",
    prefixArguments: Object.freeze(["compose"]),
  }),
  Object.freeze({
    engine: "podman",
    executable: "/usr/local/bin/podman",
    prefixArguments: Object.freeze(["compose"]),
  }),
]);

const actionArguments = Object.freeze({
  up: Object.freeze(["up", "-d"]),
  down: Object.freeze(["down"]),
  logs: Object.freeze(["logs", "--tail=200"]),
});

const composeProjectName = "reconai-local";
const podmanStartupTimeoutMilliseconds = 120_000;
const podmanStartupPollMilliseconds = 1_000;

export function selectComposeCommand({ engine, probe = probeComposeCommand } = {}) {
  if (engine !== undefined && engine !== "docker" && engine !== "podman") {
    throw new Error("RECONAI_COMPOSE_ENGINE must be docker or podman");
  }

  for (const command of composeCommands) {
    if (engine !== undefined && command.engine !== engine) continue;
    if (probe(command)) return command;
  }

  const requested =
    engine === undefined ? "Docker Compose v2 or Podman Compose" : `${engine} Compose`;
  throw new Error(
    `${requested} is unavailable. Install Docker Compose v2, or install Podman plus an external ` +
      "Compose provider such as podman-compose. Set RECONAI_COMPOSE_ENGINE only to disambiguate " +
      "when both engines are installed.",
  );
}

export function probeComposeCommand(command) {
  const result = spawnSync(command.executable, [...command.prefixArguments, "version"], {
    env: process.env,
    stdio: "ignore",
  });
  return result.status === 0;
}

export function evaluatePodmanComposeState(expectedServices, containers) {
  const containersByService = new Map();
  for (const container of containers) {
    const service =
      container.Config?.Labels?.["com.docker.compose.service"] ??
      container.Config?.Labels?.["io.podman.compose.service"];
    if (typeof service === "string") containersByService.set(service, container);
  }

  for (const service of expectedServices) {
    const container = containersByService.get(service);
    if (!container) return { ready: false };

    const status = container.State?.Status;
    const health = container.State?.Health?.Status;
    const exitCode = container.State?.ExitCode;
    if (health === "unhealthy") {
      return { ready: false, error: `service ${service} reported unhealthy` };
    }
    if (status === "exited" && exitCode !== 0) {
      return {
        ready: false,
        error: `service ${service} exited with status ${String(exitCode)}`,
      };
    }

    const ready =
      health === "healthy" ||
      (status === "running" && health === undefined) ||
      (status === "exited" && exitCode === 0);
    if (!ready) return { ready: false };
  }

  return { ready: true };
}

async function run() {
  const action = process.argv[2];
  const argumentsForAction = actionArguments[action];
  if (!argumentsForAction) {
    throw new Error("compose action must be one of: up, down, logs");
  }

  const command = selectComposeCommand({
    engine: process.env["RECONAI_COMPOSE_ENGINE"],
  });
  const composeArguments = [
    ...command.prefixArguments,
    "--project-name",
    composeProjectName,
    ...argumentsForAction,
  ];
  if (action === "up" && command.engine === "docker") composeArguments.push("--wait");
  const result = spawnSync(command.executable, composeArguments, {
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Compose exited after signal ${result.signal}`);
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }
  if (action === "up" && command.engine === "podman") {
    await waitForPodmanCompose(command);
  }
}

async function waitForPodmanCompose(command) {
  const serviceResult = spawnSync(
    command.executable,
    [...command.prefixArguments, "--project-name", composeProjectName, "config", "--services"],
    {
      encoding: "utf8",
      env: process.env,
    },
  );
  if (serviceResult.status !== 0) {
    throw new Error("Podman Compose could not enumerate the configured services");
  }
  const expectedServices = serviceResult.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (expectedServices.length === 0) {
    throw new Error("Podman Compose returned an empty service inventory");
  }

  const deadline = Date.now() + podmanStartupTimeoutMilliseconds;
  while (Date.now() < deadline) {
    const identifierResult = spawnSync(
      command.executable,
      ["ps", "-aq", "--filter", `label=com.docker.compose.project=${composeProjectName}`],
      {
        encoding: "utf8",
        env: process.env,
      },
    );
    if (identifierResult.status !== 0) {
      throw new Error("Podman could not inspect the Compose service inventory");
    }
    const identifiers = identifierResult.stdout
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean);
    if (identifiers.length > 0) {
      const inspectResult = spawnSync(command.executable, ["inspect", ...identifiers], {
        encoding: "utf8",
        env: process.env,
      });
      if (inspectResult.status !== 0) {
        throw new Error("Podman could not inspect the Compose service states");
      }
      const parsed = JSON.parse(inspectResult.stdout);
      if (!Array.isArray(parsed)) throw new Error("Podman returned malformed service state");
      const state = evaluatePodmanComposeState(expectedServices, parsed);
      if (state.error) throw new Error(state.error);
      if (state.ready) return;
    }
    await delay(podmanStartupPollMilliseconds);
  }

  throw new Error("Podman Compose services did not become ready within 120 seconds");
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown Compose launcher error";
    process.stderr.write(`ReconAI infrastructure launcher: ${message}\n`);
    process.exitCode = 1;
  }
}
