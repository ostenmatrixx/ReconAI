# ADR 0063: Scope repository-hook bypasses to Git-free release-image lifecycle commands

- Status: Accepted
- Date: 2026-07-30

## Context

The application Dockerfiles use a Git-free build context because `.dockerignore` excludes `.git`.
Their locked workspace install still ran the root `prepare` command, which called
`lefthook install`. The first real ARM64 API image build therefore failed because Git was not
present. After scoping the documented `LEFTHOOK=0` value to `pnpm install`, the build advanced and
exposed the same failure in `pnpm deploy`: its production-only release installation runs `prepare`
again.

Static digest and workflow validation had not executed either package lifecycle path, so it could
not prove that the checked-in Dockerfiles produced runnable images.

## Decision

1. The root `prepare` command calls `scripts/install-hooks.mjs`. It skips hook installation only
   when `LEFTHOOK` is exactly `0`; every other value invokes Lefthook directly and propagates a
   missing executable or nonzero result.
2. Each Dockerfile scopes `LEFTHOOK=0` to its one locked workspace-install command. API and worker
   separately scope the same value to their production `pnpm deploy` command.
3. The bypass is never persisted with `ENV`, parameterized with `ARG`, or inherited by compilation
   or runtime layers. Dependency lifecycle scripts remain enabled; `--ignore-scripts` is forbidden.
4. `pnpm container:check` rejects a missing or altered install boundary, persistent or parameterized
   bypasses, disabled lifecycle scripts, and an unscoped API/worker production deploy.
5. Unit tests cover exact bypass selection and the Dockerfile policy. The ordinary local
   `pnpm prepare` path must still install `pre-commit`, `commit-msg`, and `pre-push`.
6. Image execution remains a separate environment-dependent verifier. It does not enter the default
   static gate because it requires a container engine, dependency network, local ports, synthetic
   credentials, and bounded destructive cleanup.

## Consequences

Git hooks remain active for ordinary clones and contributor installs, while a context that cannot
possibly install repository hooks can build without installing Git into a disposable build stage.
The narrow command boundary is reviewable and mechanically enforced. API and worker production
dependency deployment no longer fails after successful compilation.

The ARM64 slim build observed that optional `msgpackr-extract` native loading and source compilation
were unavailable because the optional prebuild did not load and Python was absent. pnpm retained the
supported JavaScript fallback, and both final images completed the runtime proof. This is not an
amd64 result or a performance claim.

## Alternatives considered

- Install Git in every build stage: rejected because the context intentionally contains no Git
  metadata, hook installation has no release-image function, and the extra executable increases the
  build dependency surface.
- Disable all lifecycle scripts: rejected because dependency install scripts may be required and a
  broad bypass conceals unrelated packaging failures.
- Ignore the failed `prepare` result: rejected because a successful image build must fail closed on
  unexpected lifecycle failures.
- Remove the repository `prepare` hook: rejected because fresh contributor installs must continue
  installing the checked-in hooks.
- Treat the existing static Dockerfile validator as runtime proof: rejected because it did not find
  either failing lifecycle boundary.

## Security, tenant, financial, and operational effects

No tenant, money, matching-rule, provider, permission, or database behavior changes. The runtime
probe uses synthetic fixtures, a minimal RS256/JWKS authority, the restricted application and worker
roles, foreign-tenant denial, tenantless RLS reads, and the existing deterministic rule set.

All three final images declare user `node`; the local verifier observed effective UID 1000 while
dropping all capabilities and enabling no-new-privileges. It completed an eight-input run with three
matches, one exception, immutable occurrence evidence, one published outbox event, one successful
job, and two run audit events. Bounded logs contained no checked synthetic credential value.

The first harness configuration overprovisioned every container from the full local environment.
That result was not accepted as least-privilege evidence. The corrected rerun used and inspected
explicit API, worker, and web projections under the service-specific parsing boundary in ADR 0064;
the reconciliation and isolation assertions remained unchanged.

Podman's default OCI format ignored the Dockerfile health-check metadata, so the verifier called API
liveness and composite readiness directly. A later fresh rerun retained the API/worker development
dependency configuration while exercising the production web image through an isolated digest-pinned
Keycloak container, one-run TLS, Secure cookies, Redis revocation, explicit tenant selection, and
the authenticated BFF. ADR 0065 defines that verification topology.

This local ARM64 proof is not Docker Engine, an amd64 candidate archive, a vulnerability scan,
protected staging, trusted production TLS/ingress, external federation, a prior/current rollout, or
production readiness. Evidence: `artifacts/container-image-runtime-verification-2026-07-30.json`.

## Rollback

Reverting the wrapper requires either installing Git and providing a repository boundary inside
every build stage or replacing `prepare` with another exact Git-free lifecycle policy. Do not
restore a broad `--ignore-scripts` install. Application rollback remains an immutable image
rollback; no migration or data rollback follows from this decision.
