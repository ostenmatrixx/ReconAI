# Self-hosting

ReconAI is designed to run without maintainer-private infrastructure or paid credentials. The
default stack uses Node.js, PostgreSQL, Redis, an S3-compatible object store, and standards-based
OIDC. Synthetic fixtures exercise the workflow.

## Local quick start

Prerequisites: Node 24.18+, Corepack, pnpm 11.9.0, and either Docker Engine with Compose v2 or
Podman with an external Compose provider such as `podman-compose`.

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm hooks:install
pnpm infra:up
pnpm db:migrate
pnpm fixtures:load
pnpm dev
```

Services bind to loopback by default. The web app is at `http://localhost:3000`, API at
`http://localhost:4000`, local OIDC at its documented loopback port, and object-store console only
for development. `pnpm infra:*` prefers Docker Compose, then fixed Podman executable locations. Use
`RECONAI_COMPOSE_ENGINE=docker` or `podman` only to disambiguate installed engines; it never accepts
an arbitrary executable path. Podman's `podman compose` command delegates to an installed external
Compose provider. Change all development credentials outside local development.

## Required replaceable services

- Authentication: any compatible OIDC provider; local Compose provides a development provider.
- PostgreSQL: supported major versions in `docs/upgrade-and-rollback.md`.
- Queue/cache: Redis-compatible BullMQ backend.
- Object storage: private S3-compatible bucket; the API credential needs narrow `s3:ListBucket` on
  that bucket for read-only readiness plus the documented tenant-object actions.
- Email: no-op development adapter or configured SMTP/provider adapter.
- Observability: OpenTelemetry OTLP or console/no-op development adapter.
- AI: disabled/no-op by default or a documented structured provider.
- Deployment: Compose is reference self-hosting; platform-specific manifests are optional.

## Production baseline

Use a reverse proxy for TLS, slow/malformed request defense, payload limits, and outer rate limits.
The reference policy keeps browser `/api/*` traffic on the Next.js BFF/auth boundary and sends
direct `/v1/*` provider/API traffic to Fastify without rewriting the path. Review it against the
actual network before use; only the proxy addresses/CIDRs that directly connect to Fastify belong in
`API_TRUST_PROXY_CIDRS`. At the public trust boundary, discard caller-supplied forwarding chains:
the reference Nginx policy derives `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Host`, and
`X-Forwarded-Proto` from its connection/request and removes `Forwarded`. If an approved load
balancer precedes Nginx, configure the real-IP module with an exact `set_real_ip_from` allowlist so
`$remote_addr` is derived from that trusted hop; never restore `$proxy_add_x_forwarded_for` as
client authority.

Production startup requires `API_RATE_LIMIT_STORE=redis`, one stable environment-specific
`API_RATE_LIMIT_KEY_SECRET` on every API replica, and the nonempty proxy allowlist. The limiter uses
a separate bounded Redis connection, fails startup or request admission closed when Redis is
unavailable, and stores only environment-scoped HMAC address digests. Keep web/API/worker/data
stores private. Use separate least-privilege runtime/migration/backup database roles; force RLS for
the application role; use managed or tested durable disks; private buckets with
encryption/versioning/lifecycle; Redis authentication/private networking/persistence appropriate to
queue durability; an external secret manager; independent encrypted backups; and central telemetry
with redaction.

Production web startup also requires `SESSION_REVOCATION_STORE=redis`. Register
`{WEB_ORIGIN}/api/auth/backchannel-logout` as the exact Keycloak back-channel URL, enable its
session-ID claim, and keep issuer/client/signing algorithm/session secret/environment namespace
identical across web replicas. The dedicated bounded connection stores HMAC-indexed cutoffs rather
than raw provider identifiers and fails authenticated traffic closed when unavailable. Follow
`docs/session-revocation.md` before adding a second web replica or enabling production traffic.

Raw-object retention is disabled until an organization explicitly sets a duration. Before enabling
it, configure and verify noncurrent-version/delete-marker lifecycle and backup expiry independently;
the application tombstone proves only the checksum-bound current-key operation. See
`docs/privacy-and-retention.md` and `docs/operations-runbook.md`.

Run at least two API/web instances only after session/storage/queue topology is verified. Migrations
are a separate approved job, never an application-start side effect. Do not expose MinIO, Redis,
PostgreSQL, debug, or telemetry collection ports publicly.

## Configuration and secrets

See `docs/environment.md`. Runtime startup validates required variables and rejects placeholder
production values. Never put secrets in `NEXT_PUBLIC_*`, images, Compose files, shell history, logs,
or Git. Rotate OIDC, session, connector, webhook, object, database, and encryption credentials using
the documented key-version strategy.

Provider webhook signing and provider reads use distinct connection references. Stripe/Shopify
recovery remains disabled while `api_credential_reference` is null. Configure the versioned
encryption-key references. For externally managed or manual credentials, pipe a restricted provider
credential to the local sealing CLI:

```sh
printf '%s' "$PROVIDER_SECRET" | pnpm connector:credential:seal \
  --organization-id "$ORGANIZATION_ID" \
  --connection-id "$CONNECTION_ID" \
  --provider stripe \
  --purpose api_read
```

Paste only the resulting ciphertext envelope into the administrator connector surface. Prefer a
hidden/non-history-producing secret-manager pipe over an interactive shell variable in real
operations. The API validates and stores the envelope, atomically supersedes an active version, and
returns metadata only. Shopify also requires a canonical `*.myshopify.com` external account ID and a
pinned quarterly API version. Exact-confirmation disconnect revokes ReconAI's active records and
clears its references. When disabled-by-default OAuth is configured, Shopify first confirms
`appUninstall`; Stripe first stops reads and then waits for its signed app-deauthorization event
after the administrator uninstalls from the fixed Stripe settings page. Follow `docs/environment.md`
and `docs/operations-runbook.md`; never expose raw credentials to the browser.

## Upgrade and support

Back up first, read `CHANGELOG.md`, run migration validation, use expansion/contraction deploys,
smoke test health and core reconciliation, and keep the previous compatible images ready. See
`docs/upgrade-and-rollback.md`, `docs/deployment.md`, and `docs/backup-restore.md`.

## Current verification status

The current workstation does not have Docker, but a rootless Podman 5.8.2 client/server path with an
isolated hash-verified `podman-compose` 1.6.0 provider now executes the documented dependency-stack
quick start. The exact digest-pinned Compose network reached healthy PostgreSQL, Redis, MinIO, and
Keycloak; MinIO bootstrap exited zero; all 56 migrations and synthetic fixtures loaded; host-run
web/API/worker processes passed readiness plus a real local OIDC/API/BFF/browser smoke; and the
portable `pnpm infra:*` commands passed idempotent startup, bounded logs, and clean shutdown.
Evidence: `artifacts/local-podman-compose-quickstart-verification-2026-07-30.json`; decision:
ADR 0062.

The same rootless engine also builds the checked-in API, worker, and web Dockerfiles on Linux ARM64
after the Git-free install/deploy lifecycle correction in ADR 0063. All three final containers run
as UID 1000 with capabilities dropped and no-new-privileges. The image API/worker complete one
synthetic eight-input deterministic run through the private dependency network. A fresh isolated
rerun also starts digest-pinned Keycloak over one-run TLS and completes production web-image
authorization code plus PKCE, Secure HttpOnly session and tenant-context cookies, Redis revocation,
explicit tenant selection, BFF run creation/detail, foreign-tenant denial, and tenantless RLS
checks. Evidence: `artifacts/container-image-runtime-scan-bound-verification-2026-07-30.json`. The
rerun inspected explicit service credential projections: API had only its application database role,
worker only its worker role, and web no database/object/connector authority; ADR 0064 defines the
projection and ADR 0065 the authentication verifier. This is not Docker Engine, the hosted
workflow's amd64 OCI candidate, a signed attestation, trusted external TLS/identity, protected
staging, or deployment evidence.

A separate bounded verifier rebuilt native Linux ARM64 candidates from the reviewed Node 24.18.0
digest, removed npm/Corepack from the final runtime stages, exported and validated OCI archives,
scanned extracted layouts with checksum-verified Trivy 0.72.0, and generated hashed CycloneDX 1.7
summaries. API, worker, and web each passed with zero fixed High and zero fixed Critical findings;
the scanned IDs exactly match the authenticated runtime proof. See
`artifacts/local-native-oci-candidate-runtime-bound-verification-2026-07-30.json` and ADR 0066. This
local result has no registry, signing, publication, deployment, provider-system, or
production-secret authority and does not replace the hosted amd64 candidate workflow.

The repository baseline is committed and pushed, but a literal fresh-clone proof has not yet been
recorded. A separate bounded verifier exported the exact Git-ignore-clean candidate source to a
temporary repository, copied only the documented synthetic `.env.example`, completed the frozen
install, Secretlint, high-severity production audit, full static verification/production build, and
Chromium suite, and proved no publishable source changed or appeared. See
`artifacts/clean-source-export-verification-2026-07-29.json` and ADR 0055. None of the local results
is a remote clone, Docker-engine compatibility proof, protected-staging exercise, or deployment. PR
11 ordinary hosted CI and Security checks pass, including live PostgreSQL, browser/accessibility,
and non-publishing container build/scan jobs. All current remote Dockerfile, Compose, and CI
container inputs are immutable-digest pinned and the pin/non-publishing workflow policy passes
locally. Native ARM64 OCI build/scan/CycloneDX evidence now exists through the bounded local
verifier, but the manual candidate workflow has not run on a hosted runner, so its amd64 BuildKit
provenance, embedded SBOM, checksums, signed attestations, and GitHub identity verification remain
unavailable evidence; see `docs/container-integrity.md`. The distributed limiter has synthetic
two-instance, proxy-spoof, failure, boundary, and liveness coverage, and the reference Nginx policy
passes its static validator. An authenticated loopback Redis 8.2.8 exercise passed the two-client
120/121 shared-budget, pseudonymous-key, and positive-TTL assertions. A later isolated exercise runs
two compiled API processes with production configuration against authenticated persistent Redis
8.2.8. It proves exact 120/121 sharing, forwarding overwrite, fail-closed Redis `SIGKILL`,
independent liveness, durable restart, and coordinated drain/restart key rotation. See
`artifacts/api-rate-limit-replica-recovery-verification-2026-07-29.json`. A local Nginx 1.30.4
exercise parsed the canonical policy, distributed traffic across two Fastify upstreams, discarded
100 forged forwarding identities into one observed-peer budget, returned 59 edge 429s without
sending them upstream, and rejected a 12 MiB plus one-byte body before upstream. It also verified
the BFF/API routing split and version-hidden security headers. A fresh exact-source run additionally
verified the explicit query-free JSON access log: thirteen parsed entries omitted synthetic callback
`code`/`state` values. These single-host loopback exercises are recorded in
`artifacts/live-edge-verification-2026-07-29.json` and
`artifacts/edge-access-log-redaction-verification-2026-07-29.json`; staging, TLS, external load
balancer/CDN/hosting logs, collector access/retention, multi-host scheduling, representative
capacity, and alert behavior are not claimed. Composite API readiness has synthetic
false/throw/timeout/cache/recovery coverage, and a real API process with PostgreSQL, Redis, and
object storage absent returned live 200 and opaque ready 503. A checksum-pinned single-host exercise
also ran two API replicas against live PostgreSQL 17.10, Redis 8.2.8, and MinIO. Independent
transport loss for every dependency made both replicas return opaque ready 503 while live remained
200; both replicas recovered after each path returned, and fixed internal transitions exposed no raw
errors, endpoints, or credentials. See `artifacts/api-readiness-verification-2026-07-28.json`.
Dependency process crashes, cross-host partitions, actual scheduler/load-balancer polling, and
readiness alert delivery remain unverified.

The PostgreSQL logical-restore component has a local synthetic proof against two distinct,
data-checksummed PostgreSQL 17.10 clusters. The checked-in read-only comparator matched all
table/catalog/RLS/grant digests, and the restored copy passed the complete 34-test database-backed
suite plus `pg_amcheck` and offline checksums. A second component drill matched a complete
tenant-scoped history across two versioned MinIO processes and rebuilt one unpublished outbox event
from a logically restored PostgreSQL copy into an initially empty authenticated Redis 8.2.8 database
with one stable waiting job. A later fresh-cluster exercise applied migration 0040, verified the
restricted execution ledger, and reconstructed ten stable waiting jobs spanning unpublished,
tracked-never-started, retryable, and stale-running classifications while excluding active,
succeeded, dead-lettered, and unclassified legacy work. This does not prove the production
base-backup/WAL, atomic database/object recovery point, configuration/key,
encryption/immutable-copy, object-lock/lifecycle/replication, prior-image, cutover, or RPO/RTO
design. See `docs/backup-restore.md`.

The OIDC back-channel receiver and distributed session index have synthetic signature, claims,
replay, session-scope, fixed-JWKS, BFF, and failure coverage. A single-host isolated exercise also
passed one signed Keycloak delivery through two production-built Next.js processes sharing
authenticated persistent Redis 8.2.8, cross-replica targeted revocation and replay, fail-closed
authenticated admission during abrupt Redis loss, independent anonymous liveness, durable restart,
and later-login recovery. See
`artifacts/oidc-distributed-revocation-recovery-verification-2026-07-29.json`. This does not prove
protected multi-host scheduling, managed Redis failover or transport policy, external HTTPS
back-channel ingress, clock boundaries, coordinated secret/key rotation, or alert delivery.
