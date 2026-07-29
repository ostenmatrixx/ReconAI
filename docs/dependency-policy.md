# Dependency and toolchain policy

Last reviewed: 2026-07-29

Dependencies are accepted only when they remove more security, correctness, or maintenance risk than
they add. Runtime packages require an owner, a narrow use, active maintenance, a compatible license,
and a credible security process. Small domain logic remains local; protocol and cryptographic work
uses established libraries.

## Version selection

- All direct dependencies and the package manager are exact-pinned; installs use the committed
  lockfile with `--frozen-lockfile`.
- Node 24 types deliberately match the Node 24 runtime rather than the newer Node 26 type surface.
- TypeScript 6.0.3 is deliberate while `typescript-eslint` needs the JavaScript compiler API.
  TypeScript 7.0 is the current native compiler but does not expose that API; reconsider the native
  compiler when the lint/editor toolchain supports it without a compatibility alias.
- Next.js 16 is the active LTS line and is pinned to a patched exact release. React/Next security
  patches bypass the package-age delay.
- The web application uses `jose` for standards-based OIDC logout-token verification and reuses the
  repository's existing `ioredis` major for bounded, distributed session-revocation state. Neither
  protocol verification nor cryptographic primitives are implemented ad hoc.
- `next-auth@4.24.15` remains exact-pinned while a stable replacement is evaluated against the full
  Keycloak refresh, encrypted-session, RP/back-channel logout, distributed-revocation, and BFF
  contract. Auth.js v5 is still beta, and the reviewed stable Better Auth generic OIDC path does not
  expose an equivalent custom generic-provider refresh contract. The official
  [migration guide](https://better-auth.com/docs/guides/next-auth-migration-guide) does not require
  an urgent migration for a working Auth.js deployment, while the
  [generic OAuth guide](https://better-auth.com/docs/plugins/generic-oauth) documents the current
  refresh limitation.
- The transitive `openid-client@5.7.1` is bound to `patches/openid-client@5.7.1.patch`. That narrow
  compatibility patch replaces Node's deprecated legacy URL parser with WHATWG `URL` without
  changing authentication/session authority. `pnpm oidc:check` validates the mapping, lockfile patch
  hash, installed source, PKCE/state contract, and URL behavior. A fresh isolated Keycloak 26.7.0
  lifecycle additionally passes the exact patched path under fatal Node deprecation handling,
  including token rotation, RP logout, signed single-process Back-Channel Logout, and old-cookie
  denial. The patch must be rebased or removed intentionally on any relevant update; it is not a
  general-purpose fork.
- Other direct packages were compared with the registry on the review date. `pnpm outdated -r`
  reports only the deliberate Node-types and TypeScript major differences above.
- `minimumReleaseAge: 1440` adds a 24-hour observation window for ordinary newly published packages.
  Only explicitly listed packages may run install scripts.

The two deprecated `@esbuild-kit/*` packages are development-only transitives of Drizzle Kit. They
are not imported or shipped by an application and remain tracked until Drizzle removes them.

## Automated controls

- The dependency policy rejects ranges, tags, undeclared workspace versions, and unexpected
  manifests.
- Weekly update automation covers npm, GitHub Actions, Compose, and every application Dockerfile.
- CI actions use immutable commit SHAs. The Dockerfile frontend and every remote Dockerfile,
  Compose, and workflow container input retain a reviewed tag plus immutable manifest-list digest;
  the approved container-repository list is explicit. `pnpm container:check` prevents repository,
  pin, and candidate-permission regressions. Production dependency audit, secret scan, license
  allowlist, CodeQL, container builds, and CycloneDX SBOM generation are separate gates.
- `config/production-license-inventory.json` is the reviewed, sorted inventory for every external
  package reachable from any workspace production or optional dependency, including platform-
  specific packages not installed on the current host. It is bound to the complete lockfile by
  SHA-256 and records exact peer-qualified package identities.
- `pnpm license:check` validates that inventory offline and fails closed on lockfile drift, missing
  packages, changed ordering, malformed identities, missing SHA-512 package integrity, or licenses
  outside the explicit exact-expression allowlist. The check is part of both `pnpm verify` and the
  supply-chain CI job and does not depend on pnpm's mutable local package-store index.
- After an authorized dependency change, `pnpm license:inventory` makes bounded, no-redirect,
  credential-free reads of exact package metadata from the fixed npm registry. It cross-checks
  registry name, version, and integrity against the lockfile before emitting a candidate inventory.
  A maintainer must review every new license expression and commit the result; generation is not an
  approval step. The CycloneDX SBOM remains a separate component/provenance artifact and is not used
  as a license source because the current pnpm output omits package license fields.
- Targeted transitive overrides are exact, documented by the lockfile, and retained only while the
  vulnerable ancestor range exists.
- Targeted patches are similarly exact and lockfile-hash-bound. They require an ADR, runtime
  regression coverage, an upstream-removal criterion, and quarterly review while retained.
- A manual main-branch workflow can build, scan, checksum, SBOM, and GitHub-attest local
  non-publishing OCI candidates without registry or deployment authority. Public releases
  additionally require owner authorization, an approved registry, image-level attestations for the
  published digest, admission verification, and recorded hosted evidence; those publication and
  deployment controls are not implemented or authorized.

## Review and removal

Every update runs the full deterministic, tenant, browser, migration, build, license, secret, and
audit suite. Major updates receive an ADR or changelog rationale when they alter compatibility or
security behavior. Remove unused packages immediately; review direct production dependencies at
least quarterly and after each advisory.
