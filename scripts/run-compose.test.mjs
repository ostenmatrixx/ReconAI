import { describe, expect, it } from "vitest";

import { evaluatePodmanComposeState, selectComposeCommand } from "./run-compose.mjs";

describe("Compose command selection", () => {
  it("prefers Docker Compose when both engines are usable", () => {
    const selected = selectComposeCommand({
      probe: () => true,
    });

    expect(selected).toMatchObject({
      engine: "docker",
      executable: "docker",
      prefixArguments: ["compose"],
    });
  });

  it("falls back to a fixed Podman installation path", () => {
    const selected = selectComposeCommand({
      probe: (candidate) => candidate.executable === "/opt/podman/bin/podman",
    });

    expect(selected).toMatchObject({
      engine: "podman",
      executable: "/opt/podman/bin/podman",
      prefixArguments: ["compose"],
    });
  });

  it("honors an exact engine selection without accepting a command path", () => {
    const selected = selectComposeCommand({
      engine: "podman",
      probe: (candidate) => candidate.executable === "podman",
    });

    expect(selected.engine).toBe("podman");
    expect(() =>
      selectComposeCommand({
        engine: "/tmp/untrusted-compose",
        probe: () => true,
      }),
    ).toThrow(/must be docker or podman/u);
  });

  it("fails with bounded installation guidance when no provider is usable", () => {
    expect(() =>
      selectComposeCommand({
        probe: () => false,
      }),
    ).toThrow(/external Compose provider/u);
  });
});

describe("Podman Compose readiness", () => {
  const running = (service, health) => ({
    Config: { Labels: { "com.docker.compose.service": service } },
    State: {
      Status: "running",
      ...(health ? { Health: { Status: health } } : {}),
      ExitCode: 0,
    },
  });
  const exited = (service, exitCode) => ({
    Config: { Labels: { "com.docker.compose.service": service } },
    State: { Status: "exited", ExitCode: exitCode },
  });

  it("accepts healthy services and successful one-shot setup", () => {
    expect(
      evaluatePodmanComposeState(
        ["postgres", "redis", "minio-bootstrap"],
        [running("postgres", "healthy"), running("redis", "healthy"), exited("minio-bootstrap", 0)],
      ),
    ).toEqual({ ready: true });
  });

  it("waits for missing or starting services", () => {
    expect(
      evaluatePodmanComposeState(["postgres", "redis"], [running("postgres", "starting")]),
    ).toEqual({ ready: false });
  });

  it("fails closed on unhealthy or failed one-shot services", () => {
    expect(evaluatePodmanComposeState(["postgres"], [running("postgres", "unhealthy")])).toEqual({
      ready: false,
      error: "service postgres reported unhealthy",
    });
    expect(evaluatePodmanComposeState(["minio-bootstrap"], [exited("minio-bootstrap", 1)])).toEqual(
      {
        ready: false,
        error: "service minio-bootstrap exited with status 1",
      },
    );
  });
});
