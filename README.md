# ReconAI

> Working name only. A basic collision review found multiple existing ReconAI products and an
> occupied `@reconai` npm scope. Do not publish under this name until the owner completes naming and
> legal review. See `docs/name-review.md`.

ReconAI is an open-source, multi-tenant reconciliation system for e-commerce finance and operations
teams. It ingests read-only Shopify and Stripe data plus accounting CSVs, normalizes records with
provenance, applies deterministic versioned matching, and presents explainable exceptions for
controlled human review. It never writes financial changes back to source systems in V1.

This repository contains a locally verified deterministic vertical slice but is **not
production-ready**. The authoritative scope is in `PRD.md`; measured progress and missing evidence
are in `GOALS.md`.

## Safety boundary

- Shopify, Stripe, and accounting access is read-only.
- No binary floating point is used for money.
- Every customer-owned record and job is tenant-scoped.
- AI is optional, disabled by default, and cannot approve or override deterministic rules.
- Human review changes ReconAI’s decision record only; it does not issue payments/refunds or alter
  source records.

## Architecture

The TypeScript pnpm monorepo contains a Next.js web app, a Fastify API, a BullMQ worker,
PostgreSQL/Drizzle storage, Redis-backed jobs, S3-compatible object storage, and dependency-light
domain/reconciliation packages. Provider interfaces are replaceable for self-hosting. See
`docs/architecture.md` and `docs/adr/`.

## Prerequisites

- Node.js 24.18 or compatible active LTS
- Corepack and pnpm 11.9.0 (pinned by `packageManager`)
- Docker with Compose v2, or Podman with an external Compose provider such as `podman-compose`, for
  PostgreSQL, Redis, MinIO, and local OIDC

## Local setup

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

No paid account, production credential, or real customer data is required. Development fixtures are
synthetic. `pnpm infra:*` prefers Docker Compose and falls back to Podman Compose; set
`RECONAI_COMPOSE_ENGINE=docker` or `podman` only when both are installed and an explicit choice is
needed. See `docs/self-hosting.md` and `docs/environment.md`.

## Validation

```sh
pnpm verify
pnpm test:integration
pnpm test:e2e
pnpm verify:live-reconciliation # requires fresh loopback PostgreSQL/Redis/MinIO
pnpm verify:live-oidc-bootstrap # requires fresh loopback PostgreSQL and a local Keycloak realm
pnpm verify:reconciliation-load # five isolated 100,000-record pure-engine samples
pnpm verify:clean-source -- --evidence-output artifacts/<dated-clean-source-evidence>.json
```

`pnpm verify` runs formatting, lint, type checking, unit/tenant/reconciliation checks, migration,
schema, edge, immutable-container/candidate, bounded-evidence, dependency, and offline production-
license policy validation, plus builds. The clean-source command additionally uses a new temporary
repository and must write only a new dated evidence path. CI definitions add browser/accessibility,
secret, CodeQL, dependency, container-build, and SBOM checks. Current local evidence covers the
complete 54-test integration graph across 19 files against data-checksummed PostgreSQL 17.10,
authenticated Redis 8.2.8, and the pinned MinIO release, including all 44 migrations,
restricted-role organization bootstrap, and a populated 0041-to-0043 upgrade. Earlier evidence
covers the then-current 40 migrations and 34 tests in 11 database-backed files, plus a populated
0038-to-0039 upgrade and a same-database provider-suite rerun. Checksum-verified Keycloak 26.7.0
host-process exercises also completed real browser login, a two-tab first-owner 201/409 race from an
empty identity, a distinct verified identity's invitation acceptance and audited role/deactivation
lifecycle, isolated invitation-relay acceptance/rejection, tenant-authorized data loading, and one
BFF/API/outbox/worker reconciliation run. Remote container inputs are digest-pinned; the manual
candidate workflow can create scanned, checksummed, SBOM-linked, signed local OCI archives without
publishing. A rootless Podman Compose quick start now passes the digest-pinned dependency network,
all 56 migrations, synthetic fixtures, host application startup, and a real local
OIDC/API/BFF/browser smoke; see
`artifacts/local-podman-compose-quickstart-verification-2026-07-30.json`. Hosted CI and one
non-publishing main-branch candidate result now exist; no protected staging or deployment result
exists. A separate rootless ARM64 proof builds all three checked-in application images after
correcting their Git-free package lifecycle boundary, then composes the image web through isolated
TLS and real Keycloak authorization code plus PKCE, explicit tenant selection, the authenticated
BFF, API/outbox, and worker for one deterministic eight-input run; see
`artifacts/container-image-runtime-scan-bound-verification-2026-07-30.json`, ADR 0063, ADR 0064, and
ADR 0065. The fresh rerun also proves Secure HttpOnly cookies, Redis revocation configuration, a
minimized browser session/BFF response, foreign-tenant 404, tenantless RLS zeros, and explicit
live-container credential projections: API has only its application database role, worker only its
worker role, and web no database/object/connector authority. A separate bounded native candidate
verifier then rebuilt the three Linux ARM64 images from the reviewed Node 24.18.0 digest, removed
build-only package-manager tooling from their runtime stages, scanned extracted OCI layouts with
checksum-verified Trivy 0.72.0, and generated hashed CycloneDX 1.7 summaries. Each candidate passed
with zero fixed High and zero fixed Critical findings, and its image identities exactly match the
authenticated runtime proof; see
`artifacts/local-native-oci-candidate-runtime-bound-verification-2026-07-30.json` and ADR 0066. The
hosted main-branch workflow separately built Linux AMD64 OCI archives, passed its fixed
High/Critical Trivy gate, generated CycloneDX summaries, embedded SPDX and SLSA records, and created
independently verified GitHub SLSA and CycloneDX attestations bound to the exact commit and
GitHub-hosted runner; see `artifacts/hosted-release-candidate-verification-2026-07-30.json`. These
proofs are not Docker Engine runtime compatibility, trusted external TLS/identity, a prior/current
rollout, registry publication or deployment admission, or protected staging. The database evidence
is recorded in `artifacts/postgresql-verification-2026-07-28.json` and
`artifacts/organization-bootstrap-postgresql-verification-2026-07-29.json`; the real local
first-login/first-owner browser result is in
`artifacts/oidc-first-owner-bootstrap-verification-2026-07-29.json`. The latter is isolated local
evidence, not external identity federation, third-party inbox delivery, or staging proof.

The current local deterministic suite and 56-file source migration chain pass repository
verification; the latest live database baseline remains the 44-migration chain described above. A
five-process representative profile now reconciles exactly 100,000 mixed canonical records with
engine `0.7.0` / rules `1.5.0`. Every canonical/reversed/rotated/repeated sample returned the same
run key and result digest with 36,000 matches, 12,000 expected exceptions, zero ambiguous
candidates, and conserved integer money. Local pure-engine durations ranged from 1,664.48 to
1,948.55 ms with maximum observed RSS of 521,650,176 bytes. This excludes API, database, queue,
worker persistence, browser, network, and staging, and does not establish an SLO. Separate
evaluators cover all 19 canonical exception types, unique/multiple/reused/500/501 one-row
refund-accounting linkage, conserved positive splits, split mismatch and 50/51 overflow, complete
payment ranking at 500, payment overflow at 501 and 10,000, seven unsafe identifier categories, and
visible-Unicode acceptance. Current dated results are in
`artifacts/reconciliation-representative-load-post-lint-verification-2026-07-30.json`,
`artifacts/reconciliation-benchmark-engine-0.7.0-2026-07-29.json`,
`artifacts/reconciliation-collision-evaluation-engine-0.7.0-2026-07-29.json`,
`artifacts/reconciliation-malformed-identifier-evaluation-engine-0.7.0-2026-07-29.json`, and
`artifacts/reconciliation-taxonomy-accounting-evaluation-engine-0.7.0-2026-07-29.json`. A fresh
PostgreSQL 17.10 cluster applied all 44 migrations and passed the focused restricted-worker
split-persistence/RLS file plus the general 11-test tenant file; its exact scope is in
`artifacts/reconciliation-split-accounting-verification-2026-07-29.json`. Historical 0.6.0/1.4.0
results remain available as immutable regression evidence. Mocked Chromium split rendering,
accessibility, and mobile-containment evidence is in
`artifacts/reconciliation-split-browser-verification-2026-07-29.json`. Migration 0043 now adds
immutable per-run artifact snapshots. Fresh PostgreSQL upgrade, worker, and API repository tests
plus browser tests verify exact/legacy evidence labeling, bounded operator previews, cross-tenant
denial, append-only role enforcement, BFF response limits, accessibility, and mobile containment;
see `artifacts/reconciliation-operator-evidence-verification-2026-07-29.json`. The preview can now
be expanded through tenant/run/type-bound keyset pages without an offset scan or schema change.
Fresh PostgreSQL 17.10 and Chromium evidence covers 12 match occurrences in 5/5/2 repository pages,
fixed 25-row BFF requests, exact/legacy fidelity, malformed and cross-scope cursor rejection, RLS
concealment, and duplicate-free browser loading; see
`artifacts/reconciliation-artifact-pagination-verification-2026-07-29.json`. One separate checked-in
continuous verifier now traverses Chromium, the encrypted session and BFF, RS256 API authorization,
transactional outbox, Redis/BullMQ, the restricted worker, and PostgreSQL to render three exact
matches—including the conserved two-row accounting split—and one exact duplicate-fee exception from
immutable snapshots; see
`artifacts/reconciliation-continuous-split-journey-verification-2026-07-29.json`. The earlier
one-row continuous result remains immutable historical regression evidence. These are not production
SLO, accuracy, source-prevalence, operator-outcome, or capacity claims.

The exception queue now supports the complete bounded PRD filter set: exact ID/type, status,
severity, tenant-scoped canonical source, exact-currency signed integer minor-unit range,
deterministic rule-evidence confidence, tenant-relative assignment, and server-anchored UTC age.
Cursor v2 binds every normalized filter and one database clock across pages; the formula-safe CSV v2
export uses the same predicates and records its filter snapshot in the tenant audit chain. Low or
unclassified evidence requires two independent reviewers when dual control is enabled. Fresh
PostgreSQL 17.10, API/BFF, Chromium, and accessibility scope is recorded in
`artifacts/exception-queue-filtering-verification-2026-07-29.json`; it is local synthetic evidence,
not a capacity, accuracy, SLO, provider, or staging result.

Investigation evidence now crosses the API/BFF/browser boundary through a strict typed view.
Operators see paired source and normalized comparisons, rule/tolerance/result/search summaries, safe
canonical values, and complete validated field lineage. Unsupported, future, malformed, oversized,
inconsistent, or tenant-unresolved evidence produces one fixed unavailable state rather than raw or
partial JSON. Stored exception references are displayed only when they exactly match tenant-resolved
source records; explicit organization predicates and forced RLS conceal crafted foreign-tenant
references. Local verification is recorded in
`artifacts/typed-investigation-evidence-verification-2026-07-29.json`; decision: ADR 0058; threat:
TM-48. This is not provider, capacity, accuracy, staging, or production-readiness evidence.

Pinned run-input lineage now follows the same bounded read model: run detail keeps a 100-row
preview, while a tenant/run-bound ordinal cursor traverses the complete immutable
record/version/content-hash set in fixed 100-row BFF pages. Fresh PostgreSQL 17.10 and Chromium
checks cover 102 inputs, 40/40/22 repository traversal, 100/2 browser loading, continuous ordinals,
cursor replay denial, and forced RLS concealment; see
`artifacts/reconciliation-input-lineage-pagination-verification-2026-07-29.json`. A separate fresh
PostgreSQL 17.10 verifier traversed the configured 100,000-input ceiling concurrently in 1,000
100-row and 1,031 97-row pages both in-process and in two independent reader processes. All four
readers produced the same digest while preserving ordinal continuity; the run also confirmed the
expected index, cross-run cursor rejection, and zero foreign rows. Its local timings are
measurements, not an SLO; see
`artifacts/reconciliation-input-pagination-maximum-volume-verification-2026-07-29.json`.

Maximum-size run creation now persists pinned inputs in 1,000-row statements inside the unchanged
atomic run/input/outbox/audit transaction. A fresh data-checksummed PostgreSQL 17.10 verifier used
the restricted application role to create one 100,000-input queued run, then returned the same
authority on an exact repeat. Database state showed one run, one dispatch, one audit event,
continuous ordinals 0–99,999, forced-RLS foreign-tenant concealment, and the statement log showed
exactly 100 input inserts rather than 100,000 per-row executions. The 2,694.99 ms direct repository
measurement is local evidence, not an API SLO or production capacity claim; see
`artifacts/reconciliation-run-creation-maximum-volume-verification-2026-07-29.json`.

A second clean-database exercise injected a PostgreSQL rejection at ordinal 1,000 in the second
input statement. The first batch statement had executed, but the enclosing transaction left zero
run, input, outbox, or audit rows. After the verifier-only trigger was removed, the same
deterministic snapshot created one complete 100,000-input authority in 100 statements. PostgreSQL
logged two execute blocks before the injected error and 100 after it; offline checksums remained
clean. See `artifacts/reconciliation-run-creation-atomic-rollback-verification-2026-07-29.json`.

Run-authority creation now has a validated 5–120 second application deadline (30 seconds by
default), transaction-local PostgreSQL statement backstop, request-abort cancellation, and a fixed
retry-safe `503`. A third clean PostgreSQL 17.10 exercise delayed ordinal 1,000 after the first
input batch, then separately interrupted that statement through deadline expiry and an explicit
client signal. Both attempts left zero run/input/outbox/audit rows; PostgreSQL recorded ordinary
query cancellation rather than a fatal session timeout. Removing verifier objects allowed the same
100,000-input snapshot to create and repeat idempotently, and offline checksums remained clean. See
`artifacts/reconciliation-run-creation-interruption-verification-2026-07-29.json` and ADR 0033.

A fourth fresh PostgreSQL 17.10 exercise sent `SIGKILL` to the actual independent creator process
while its second input batch was in the verifier delay. PostgreSQL logged an unexpected EOF with an
open transaction, removed the backend after 5,030.21 ms, and retained zero authority rows; an
identical retry then created one complete 100,000-input authority. A distinct policy snapshot
started two direct Node creator processes concurrently. `pg_stat_activity` observed both backends
and one advisory-lock waiter; both callers returned the same run while database state retained one
run, 100,000 inputs, one outbox event, and one audit event. Offline checksums found zero bad blocks.
This is single-host atomicity and idempotency evidence, not proof that every lost client rolls back:
a server may fully commit before detecting loss, so retry must tolerate either zero or one complete
authority. See
`artifacts/reconciliation-run-creation-process-loss-contention-verification-2026-07-29.json`.

Pool admission now has a prompt response boundary as well as an authority boundary. A fresh
maximum-volume verifier occupied both connections in a two-connection restricted application pool.
The repository returned its safe interruption after 5,002.55 ms while both holders remained
occupied, then capacity was released and the expired queued operation drained without creating any
run, input, outbox, or audit row. See
`artifacts/reconciliation-run-creation-pool-saturation-verification-2026-07-29.json` and ADR 0034.

ADR 0035 now bounds heavyweight run transactions before postgres.js admission, defaulting to two per
API process. A later fresh 100,000-record run admitted two requests into a fully occupied pool,
rejected a 32-request burst in 0.28 ms without database admission, returned both admitted requests
at 5,001.93/5,002.10 ms, and still rejected another attempt in 0.21 ms while their hidden operations
retained both slots. Releasing capacity drained both operations with zero authority rows. The
per-process cap does not replace shared Redis request admission, bounded replica count, or
pool/rejection monitoring, and these local timings are not an end-to-end API SLO. See
`artifacts/reconciliation-run-creation-admission-pressure-verification-2026-07-29.json`.

Run-creation unavailability now increments one low-cardinality OTLP counter with only
`admission_saturated` or `interrupted`; the public retry-safe `503` remains opaque. Loopback
protobuf capture and API tests verify the two internal reasons without tenant, customer, payment, or
other high-cardinality attributes. See
`artifacts/reconciliation-run-creation-unavailability-observability-verification-2026-07-29.json`.

Configured API-originated reconciliation requests, signature-verified provider webhooks,
tenant-authorized CSV commits, and user-requested provider syncs now carry the API's locally sampled
W3C parent through immutable outbox authority. Provider-sync consumers also parent their child
webhook jobs to the active authorized worker span. The versioned field contains no `tracestate` or
baggage, participates in the canonical job hash, and is honored only after the worker exactly
matches the tenant-bound PostgreSQL payload. Legacy envelopes and scheduled sync requests remain
valid roots. See ADR 0036,
`artifacts/reconciliation-durable-trace-context-verification-2026-07-29.json`, and
`artifacts/durable-producer-trace-context-verification-2026-07-29.json`.

API process liveness is independent from PostgreSQL, Redis, object storage, OIDC, email, and
telemetry. Its opaque readiness response concurrently requires PostgreSQL, the Redis queue/admission
authority, and the private object bucket behind one bounded cached probe. Local outage behavior and
synthetic timeout/recovery evidence are recorded in
`artifacts/api-readiness-verification-2026-07-28.json`; external recovery is not yet verified.

Provider OAuth is disabled by default. The implemented Shopify/Stripe authorization, refresh, and
provider-confirmed disconnect lifecycle has synthetic coverage only; see `docs/connectors.md`,
`docs/environment.md`, and ADR 0012 before configuring an authorized development store/account.

OIDC provider-initiated logout has a bounded signed Back-Channel Logout endpoint and a
production-required shared Redis revocation index. Every server-rendered/BFF session path fails
closed when its `sid`/subject is revoked or the index cannot be checked. The implementation has
synthetic cryptographic coverage plus a local authenticated Redis 8.2.8 two-client lifecycle proof;
an authorized live Keycloak/actual-multi-replica exercise remains required. See
`docs/session-revocation.md` and ADR 0020.

## Documentation

- Product: `PRD.md`, `ROADMAP.md`, `GOALS.md`
- Design: `docs/architecture.md`, `docs/data-model.md`, `docs/reconciliation-engine.md`
- Security: `docs/threat-model.md`, `docs/security-review.md`, `SECURITY.md`,
  `docs/privacy-and-retention.md`, `docs/container-integrity.md`, `docs/session-revocation.md`
- Operators: `docs/deployment.md`, `docs/operations-runbook.md`, `docs/incident-response.md`,
  `docs/backup-restore.md`, `docs/observability.md`
- Contributors: `CONTRIBUTING.md`, `AGENTS.md`, `docs/connector-development.md`,
  `docs/dependency-policy.md`
- Verification evidence: `artifacts/README.md`; validate links, bounds, JSON, and redaction with
  `pnpm evidence:check`

## Open-source status

The intended default license is Apache License 2.0. Publication, remote pushes, public repository
creation, and production deployment require explicit owner authorization. Before publication the
owner must confirm the license and name, scan full Git history, review fixtures/docs, configure
private vulnerability reporting and repository security features, and verify a fresh clone. The
current no-commit repository has a narrower Git-ignore-clean source-export proof in
`artifacts/clean-source-export-verification-2026-07-29.json`; it does not replace the initial-commit
clone. The separate Podman Compose smoke does not replace a revision-bound fresh clone, hosted CI,
or Docker-engine compatibility evidence. The hosted AMD64 candidate evidence supplements the ARM64
application-image proof; neither replaces registry publication, runtime deployment, or protected
staging gates.

## Reporting security issues

Do not open a public issue. Follow `SECURITY.md`. Until a private reporting address is configured,
contact the repository owner through an existing private channel.
