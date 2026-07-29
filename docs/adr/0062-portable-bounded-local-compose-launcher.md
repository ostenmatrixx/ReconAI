# ADR 0062: Select local Compose engines through a bounded portable launcher

- Status: Accepted
- Date: 2026-07-30

## Context

The documented `pnpm infra:*` commands called `docker compose` directly. That made the reference
development stack unusable on a workstation with a healthy rootless Podman machine even though
Podman can run the same Compose model through an external provider.

Podman's `podman compose` command delegates to a provider such as `podman-compose`. In the verified
version, its native `up --wait` also remained blocked on an idempotent second invocation after all
four long-running services were healthy and the MinIO bootstrap container had exited successfully. A
portable launcher therefore needs explicit command selection and a bounded Podman-specific readiness
contract without accepting an arbitrary executable from configuration.

## Decision

1. `pnpm infra:up`, `infra:down`, and `infra:logs` call `scripts/run-compose.mjs` with one fixed
   action instead of interpolating a shell command.
2. The launcher prefers Docker Compose v2, then checks fixed Podman executable locations.
   `RECONAI_COMPOSE_ENGINE` may contain only `docker` or `podman` to disambiguate installed engines;
   it is not a command path.
3. Docker retains its native `compose up -d --wait` behavior.
4. Podman runs `compose up -d`, enumerates the exact `reconai-local` services, and polls their
   inspected state for at most 120 seconds. A service is ready only when its health check is
   healthy, it is running without a health check, or it is an exited one-shot service with exit
   status zero. Unhealthy and nonzero-exit services fail immediately.
5. Podman still requires an installed external Compose provider. ReconAI does not download or
   execute a provider automatically at application runtime.
6. Project name, actions, arguments, labels, timeout, and executable candidates are fixed in source.
   The launcher uses direct process execution without a shell.

## Consequences

The same documented package commands can start the development dependencies under Docker or Podman.
The Podman path avoids an observed unbounded native-wait condition while retaining explicit health
and one-shot completion checks. Fixed engine values and executable candidates avoid turning a
development convenience setting into arbitrary code execution.

Podman compatibility does not make Docker and Podman behavior identical, prove application release
images, or establish a production deployment topology. Operators must install and maintain their
chosen engine and Compose provider.

## Alternatives considered

- Keep Docker-only scripts: rejected because an equivalent installed rootless engine could not run
  the documented quick start.
- Accept an arbitrary Compose command or executable path from an environment variable: rejected
  because it creates an unnecessary command-execution boundary.
- Use Podman's native `up --wait`: rejected after the exact provider remained blocked on an
  idempotent healthy stack with a successful one-shot bootstrap.
- Vendor or download `podman-compose` from the launcher: rejected because local infrastructure
  startup should not execute mutable network-fetched tooling implicitly.

## Security and operational effects

The launcher does not receive tenant data, credentials, or production authority. It preserves the
loopback-only service bindings and exact digest-pinned images in `compose.yaml`. Health inspection
uses only project/service labels and container state. Logs remain an explicit operator command.

A rootless Podman 5.8.2 client with server 5.8.5 and an isolated hash-verified `podman-compose`
1.6.0 provider parsed the Compose file, started healthy PostgreSQL, Redis, MinIO, and Keycloak
services, completed MinIO bootstrap, applied all 56 migrations, loaded synthetic fixtures, and
supported a real OIDC/API/BFF/browser smoke. The exact `pnpm infra:up` command then passed
idempotently, `infra:logs` returned without checked local credential values, and `infra:down` plus
explicit verifier cleanup removed all project containers, volumes, and listeners. Evidence:
`artifacts/local-podman-compose-quickstart-verification-2026-07-30.json`.
