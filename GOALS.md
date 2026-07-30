# ReconAI goals and evidence

Last updated: 2026-07-30  
Status vocabulary: Not started · Active · At risk · Blocked · Verified complete

## North-star outcome

An authorized finance operator can ingest an immutable, tenant-isolated snapshot from Shopify,
Stripe, and an accounting CSV; run the same versioned rules repeatedly with identical results;
understand and review every exception from source evidence; and prove the decision history—without
ReconAI writing to a source system.

## Product principles

Correctness before automation. Evidence before confidence. Tenant context is mandatory. Source
systems remain read-only. Deterministic rules are authoritative. AI is optional and subordinate.
Human approval is explicit. Raw data is preserved and minimized. Operations are observable and
replayable. Open-source self-hosting must not depend on private infrastructure.

## Proposed service objectives (targets, not achievements)

These remain proposals until measured in staging:

- API monthly availability: 99.9%, excluding announced maintenance.
- Authenticated webhook acknowledgement: p95 under 2 seconds.
- Successful normalized ingestion freshness: p95 under 15 minutes after source availability.
- Reconciliation job completion: p95 under 10 minutes for 100,000 source records.
- Restore point objective: 24 hours; restore time objective: 4 hours.
- Zero cross-tenant access and zero duplicate artifacts for identical replay.

## Current active milestones

**Goal 0 — Foundation**  
Status: **Active**

Goal 1 implementation is active. Goal 0 now has recorded fresh-clone, CI, migration, and local
infrastructure evidence, but remains active until the owner name/license decisions and remaining
release-environment boundaries are resolved.

### Goal 0 acceptance criteria

| Criterion                      | Required objective evidence                             | Status            |
| ------------------------------ | ------------------------------------------------------- | ----------------- |
| Product requirements completed | Reviewed `PRD.md` with assumptions and open questions   | Draft done        |
| Architecture documented        | `docs/architecture.md` and accepted ADRs                | Draft done        |
| Threat model completed         | `docs/threat-model.md` with owners/control verification | Draft done        |
| Repository governance created  | Root governance files and community templates           | Draft done        |
| Local environment reproducible | Fresh-clone transcript using only documented commands   | Verified complete |
| CI and Git hooks active        | CI run URL plus manual hook test transcript             | Verified complete |
| Name review completed          | `docs/name-review.md`; owner decision still required    | Draft done        |

Dependencies: owner license/name confirmation before public release and review/merge of the exact
verified revision into the default branch.

Risks: the literal-clone record verifies one named branch at one exact commit, not `main` or a later
revision; the Podman result is single-workstation evidence; the working name has material
collisions.

Completion date: not complete.  
Evidence index: `docs/goals/goal-0-foundation.md`.

The historical clean-source export performs the frozen install, Secretlint, production audit,
complete verification/build, and Chromium suite without changing publishable files; see
`artifacts/clean-source-export-verification-2026-07-29.json` and ADR 0055. The canonical remote now
also has exact revision-bound evidence: branch `codex/foundation-literal-clone` at commit
`e2a21e5279471797536ffb548405a1ccac04c5f7` passed Git object integrity, frozen install, secret and
dependency gates, all 50 Chromium tests, the full 641-test static gate, production build, and final
clean-tree verification. See `artifacts/literal-remote-clone-verification-2026-07-30.json` and
ADR 0069. The separate Podman Compose quick start passes the digest-pinned dependency network, all
56 migrations, synthetic fixtures, host application startup, real local OIDC/API/BFF/browser smoke,
idempotent `infra:up`, bounded logs, and clean shutdown. See
`artifacts/local-podman-compose-quickstart-verification-2026-07-30.json`, ADR 0062, and
`docs/goals/goal-0-audit-2026-07-30.md`.

## Goal 1 — Deterministic vertical slice

Status: **Active** (local live integration evidence exists; provider sandboxes and staging do not)

Acceptance criteria and required evidence:

- Organization/user/membership lifecycle and explicit permission matrix: API/browser tests.
- Shopify ingestion: signed webhook, duplicate, reorder, pagination, repair, and contract tests.
- Stripe ingestion: raw-body signature, duplicate, reorder, backfill, and contract tests.
- Accounting CSV: preview/import/rollback, invalid row, size/MIME, idempotency, and formula tests.
- Canonical records: migration/constraint tests and provenance/replay tests.
- Deterministic matching: golden and property-based money/determinism/idempotency test reports.
- Exception queue/workspace: browser tests for evidence, filtering, notes, assignment, and states.
- Human review: permission, reason, dual-control, concurrency, and supersession tests.
- Audit history: append-only database enforcement and complete-chain tests.
- Staging deployment: approved deployment record, migration/rollback, health and smoke evidence.

Dependencies: Goal 0 architecture/security baseline; provider sandbox credentials only for optional
live sandbox checks; synthetic fixtures remain sufficient for CI contract tests.  
Risks: provider API drift, timing ambiguity, CSV locale ambiguity, auth integration complexity.  
Completion date: not complete.  
Evidence index: `docs/goals/goal-1-vertical-slice.md`.

The three checked-in application Dockerfiles now build locally on rootless Linux ARM64 after
correcting their Git-free install/deploy lifecycle boundary. The baseline is now committed and
pushed; PR 11 hosted Security and CI pass after correcting configuration, migration-ledger,
workflow-parser, and integration-isolation defects. A fresh isolated run exercises real Keycloak
authorization code plus PKCE through the production web image over one-run TLS, Secure HttpOnly
cookies, Redis revocation, explicit tenant selection, the BFF, the image API, outbox, and the image
worker. The eight immutable inputs produce three matches, one exception, and zero errors; a foreign
organization returns 404 and tenantless RLS reads return zero. Live projections show API with only
its application database role, worker only its worker role, and web no database/object/connector
authority. This changes authenticated image BFF login to a bounded local pass. A separate bounded
native candidate run then rebuilt all three Linux ARM64 images from the reviewed Node 24.18.0
digest, scanned extracted OCI layouts with checksum-verified Trivy 0.72.0, and generated hashed
CycloneDX 1.7 summaries. API, worker, and web each reported zero fixed High and zero fixed Critical
findings. Those scanned IDs exactly match a fresh authenticated runtime rerun. Docker Engine, the
hosted amd64 candidate/attestation path, trusted external TLS/IdP, prior/current rollout, and
protected staging remain open. Evidence:
`artifacts/container-image-runtime-scan-bound-verification-2026-07-30.json` and
`artifacts/local-native-oci-candidate-runtime-bound-verification-2026-07-30.json`; decisions: ADR
0063 through ADR 0066; latest audit: `docs/goals/goal-1-audit-2026-07-30-27.md`.

The local classification rollout boundary now includes bounded checksum-verified legacy repair plus
a disabled-by-default, one-way database writer fence. Activation waits for in-flight source
transactions, requires zero compatible operational gaps, and then rejects classification-unaware
writes atomically while preserving current provider/CSV replay and privacy behavior. This is
synthetic local PostgreSQL evidence; actual prior/current images, representative protected staging,
and production activation remain open.

Local implementation evidence now includes immutable S3-backed CSV/provider receipt paths,
transactional outbox relay and worker handlers, versioned canonical field provenance, replay-safe
reconciliation persistence with exact record-version, policy, and per-run match/exception evidence
snapshots, tenant-authorized run list/detail/start/recovery-replay APIs and UI, configurable
one/two-reviewer approval policy, original-proposer-only immutable pending proposal revision that
supersedes the old version and resets approval authority, guarded membership lifecycle,
authenticated connector health, and append-only exception notes with audited assignment,
defer/reopen controls, a bounded chronological timeline, stable server-side queue pagination/exact
filters across type/status/severity/source/currency-bound integer amount/confidence/tenant-relative
assignee/server-anchored UTC age and database-derived totals, a filter-identical bounded
formula-safe queue CSV export, an idempotent accounting-import rollback that appends immutable
per-version supersessions, and a bounded organization audit view. Administrators can also configure
disabled-by-default, independently bounded raw import/provider retention with a reasoned legal hold;
the serialized worker conditionally deletes only checksum/ETag-bound terminal objects,
retries/dead-letters failures, and appends immutable tombstones while retaining
canonical/provenance/audit evidence. Run completion is serialized per organization, exposes one
current queue authority, and preserves out-of-order older results as historical-only with
append-only exception lifecycle transitions. Administrators can request a read-only Stripe Events or
Shopify order/refund snapshot backfill or gap repair for a positive window of at most 30 days and an
explicit page ceiling. Distinct read credential references, tenant-scoped immutable run/outbox
authority, fixed/validated provider origins, cursor/page/item/byte/timeout bounds, API-version
capture/validation, six-attempt ceilings, and accessible run history have synthetic
adapter/service/API/BFF/browser plus live PostgreSQL evidence. Disabled-by-default periodic repair
now creates due Shopify/Stripe runs through a fixed service identity, exact immutable envelope,
bounded lookback/overlap/page/batch settings, deterministic cadence idempotency, and a shared
per-connection lock; the normal outbox/worker path still performs the provider read. Administrators
can install and rotate locally sealed, AES-256-GCM provider credentials without placing raw secrets
in the browser or JSON API. Versioned keys, tenant/connection/provider/purpose binding, forced-RLS
append-only lifecycle evidence, active-envelope replay idempotency, server-side resolution, redacted
metadata, and exact-confirmation local disconnect have synthetic and live PostgreSQL coverage.
Disabled-by-default Shopify/Stripe OAuth now adds digest-only single-claim state, fixed callbacks
and provider origins, bounded code exchange/refresh, encrypted provider token bundles,
account/scope/mode drift rejection, atomic refresh generations, Shopify provider-first uninstall,
and signed generation-bound Stripe App deauthorization. These additions have synthetic
unit/tenant/API/BFF evidence plus current live PostgreSQL repository coverage through the complete
integration suite. Shopify mandatory privacy topics now use a fixed app-level exact-HMAC endpoint,
post-authentication shop-to-tenant resolution, minimized append-only request evidence, a 30-day
deadline, action-required connection state, and legal-hold-serialized checksum-bound raw-object
deletion jobs with immutable tombstones. Owners/administrators can review bounded deadlines and
aggregate raw-erasure progress through a tenant-authorized, field-minimized Security & retention
view. A default-enabled bounded worker monitor creates idempotent append-only seven-day, 24-hour,
and overdue signals with exact tenant context, same-transaction audit evidence, aggregate-only logs,
and minimized operator rendering. For `customers/data_request`, a dual-authorized and explicitly
confirmed operator action prepares a checksum-verified, complete-or-fail JSON package of linked
Shopify/Stripe raw and normalized evidence. It is bounded to 100 source records and five MiB,
excludes shared CSV/storage authority, and audits only preparation metadata with `not_delivered`
status. Migration 0050 now adds digest-only, ten-minute, same-active-membership browser-receipt
authority; the browser acknowledges complete bytes before download and the idempotent audit still
states `not_delivered`. A fresh data-checksummed PostgreSQL 17.10 database now applies all 51
migrations and exercises the complete database integration suite through separate administrator,
migrator, application, and worker roles. That run verifies the migration 0050 same-membership,
digest-only, idempotent, cross-tenant, audit, append-only, and restricted-grant path. No Shopify
subscription or external alert-delivery run exists. Authorized provider sandboxes, approved
production secret-manager/KMS operations, approved repair cadence/capacity and external alert
evidence, live multi-replica rate/edge enforcement, secure merchant/customer package transfer and
recipient acknowledgement, downloaded-copy expiry, over-limit handling, canonical/legacy
disposition, independent-copy expiry, and whole-tenant deletion remain open. Evidence:
`artifacts/privacy-package-browser-receipt-verification-2026-07-29.json` and
`artifacts/postgresql-51-migration-integration-verification-2026-07-29.json`; decision: ADR 0049.
Organization onboarding now includes digest-only, verified-email-bound, expiring single-use
invitation creation/revocation/acceptance with fixed database authority, a replaceable authenticated
invitation-email relay with manual-link fallback, and synthetic authenticated browser coverage. A
newly verified identity with no active membership can now create one first organization through a
server-identified, fixed-owner, AI-disabled, serialized bootstrap. Digest-bound append-only request
evidence makes uncertain exact retries replay-safe, and the first canonical audit event shares the
creation transaction. Static and synthetic migration/service/API/BFF coverage passes; a local
Chromium run confirms exact idempotency-key reuse after an uncertain response. A fresh
data-checksummed PostgreSQL 17.10 run now proves migration 0042, restricted application-role service
execution, exact replay, concurrent convergence, foreign-identity exclusion, one atomic audit, and
complete rollback on a forced audit failure; a populated 0041-to-0043 upgrade preserves existing
tenant/audit/provider state and installs the owner boundary. A real isolated Keycloak 26.7.0
authorization-code/PKCE browser run now proves first login, two-tab 201/409 convergence, exactly one
AI-disabled owner tenant and first audit event, and browser credential non-disclosure. The same
isolated verifier now signs in a second verified identity, creates that identity's independent first
organization, accepts a relay-delivered auditor invitation to the first organization, and switches
between both through the browser. The identity remains owner in its independent organization while
the invited membership transitions auditor-to-administrator-to-deactivated-to-reviewer; deactivation
removes only the invited tenant and every request re-resolves current permission. Relay rejection/
manual fallback, revocation, replay denial, digest-only token storage, two canonical genesis events,
and the invited tenant's ten-event canonical chain also pass. External IdP federation, third-party
inbox/bounce/complaint delivery, representative abuse/query timing, sustained or multi-host
product-API administrative mutation, substantially larger representative directories, MFA/account
recovery, and prior/new-image rolling deployment remain open. A separate fresh
Keycloak/PostgreSQL/browser exercise now gives one provider-verified reviewer 101 tenant-complete
memberships, traverses exact 50/50/1 pages, accumulates all 101 unique options, selects the last
tenant, denies a foreign identity both ways, and re-resolves deactivation and reactivation
immediately. A bounded 501-membership follow-up traverses ten 50-item pages plus one, caps browser
accumulation at 500, removes further paging, requires refinement, selects membership 501 through
exact search, and repeats the denial/deactivation/reactivation assertions. The synthetic scale rows
prove directory authority only, not product organization-creation or invitation lifecycle. Evidence:
`artifacts/organization-bootstrap-verification-2026-07-29.json` and
`artifacts/organization-bootstrap-postgresql-verification-2026-07-29.json`, plus
`artifacts/oidc-first-owner-bootstrap-verification-2026-07-29.json` and
`artifacts/oidc-multi-organization-membership-verification-2026-07-30.json`, and
`artifacts/oidc-organization-directory-scale-verification-2026-07-30.json`, plus
`artifacts/oidc-organization-directory-ceiling-verification-2026-07-30.json`. A fresh PostgreSQL
between-page mutation exercise now makes the accepted non-snapshot contract executable: rename drift
may omit a row, exact lookup still returns current authorized state, deactivation excludes it
immediately, reactivation restores it, and Chromium deduplicates a renamed ID repeated across pages.
Evidence: `artifacts/organization-directory-concurrent-mutation-verification-2026-07-30.json`. A
separate fresh PostgreSQL/Fastify exercise runs two administrators' conflicting membership changes
simultaneously through the actual product route and restricted repository, preserves a linear
three-event v2 audit chain, makes the serialized terminal state immediately visible through exact
directory lookup, restores reviewer access through the route, and returns 404 without an audit
append for a foreign administrator. Evidence:
`artifacts/membership-lifecycle-concurrent-api-verification-2026-07-30.json`. Multi-organization
access uses a bounded identity-derived literal-search/keyset directory, exact identity-intersected
selection outside the current page, an exact-origin state-changing BFF, and an HttpOnly HMAC-signed,
subject-bound selection cookie; every downstream API call still re-resolves active membership and
permissions. Static and synthetic pagination/cursor/cross-identity evidence now composes with real
local Keycloak/browser runs for two organizations, 101 memberships, and the 500/501 accumulation
boundary, plus deterministic mutable-page authorization/deduplication coverage. Substantially larger
representative directories, sustained or multi-host product-API mutation, representative timing, and
rolling-image evidence remain open. Organization administrators can now read and rename the selected
organization through a strict versioned product route and accessible settings form. Concurrent
expected-version writes serialize to one accepted update and one conflict, accepted changes append
same-transaction v2 audit evidence, same-name requests are no-ops, and the exact directory reflects
the new name immediately. A fresh restricted-role PostgreSQL 17.10/Fastify run plus Chromium
confirmation/conflict/accessibility tests pass; business-time-zone changes remain read-only.
Evidence: `artifacts/organization-profile-concurrent-api-verification-2026-07-30.json`; decision:
ADR 0061. The API now has a typed 55-route security inventory, rejects unclassified route
registration, centrally resolves tenant permission before handler execution, and returns the same
not-found response for authenticated foreign membership and insufficient permission. Synthetic
browser/BFF/API negatives and a fresh live PostgreSQL application-role exercise cover selection,
cross-subject denial, and two memberships for one identity. The administrator rules surface updates
bounded, canonical dual-approval thresholds and sensitive resolution types with explicit
confirmation, reason, and audit. Audit append now follows the tenant predecessor graph rather than
business time, canonical version-2 digests bind explicit sorted fields, and migration 0039 rejects a
malformed/forked legacy graph before installing one-genesis, one-child, and tenant-self-FK
constraints. Synthetic/static checks and a current PostgreSQL 17.10 empty/populated migration plus
application-role concurrency exercise pass. A synthetic custom-format logical backup into a distinct
data-checksummed PostgreSQL 17.10 cluster also produced exact table/catalog/RLS/grant digests,
passed all 34 database-backed tests on the restored copy, completed `pg_amcheck`, and reported zero
bad offline checksums. A separate component drill matched a tenant's three object versions and
current delete marker across distinct versioned MinIO processes, then rebuilt one unpublished outbox
event from a distinct exact logical restore into initially empty authenticated Redis with one stable
waiting job. Migration 0040 now adds a token-digest execution lease, heartbeat, terminal state, and
append-only queue-recovery evidence. A fresh checksummed PostgreSQL/Redis component exercise passed
restricted-role and rolling-writer tests, reconstructed ten jobs spanning all four permitted
classifications, excluded active/succeeded/dead/legacy work, retained ten jobs on duplicate replay,
and rejected a non-empty Redis database plus a mismatched restored-system identifier.
Representative-volume timing, prior-image runtime compatibility, encrypted base-backup/WAL recovery,
an atomic database/object/Redis point, key recovery, staging cutover, and measured RPO/RTO remain
open. Evidence: `artifacts/postgresql-logical-restore-verification-2026-07-28.json` and
`artifacts/object-and-unpublished-queue-restore-verification-2026-07-28.json`, plus
`artifacts/durable-queue-recovery-verification-2026-07-28.json`. Engine 0.7.0/rules 1.5.0 preserve
malformed-identifier quarantine, explicit processing-fee duplicates, bounded one-row accounting, and
payment-candidate completeness while adding a conserved positive 2–50-row `refund-accounting-split`.
The rule uses one exact strong transaction reference, checked integer money, the pinned currency
tolerance, no subset selection, and fail-closed competing identity, sign, overflow, and row-reuse
handling. Current local taxonomy/accounting, 99,999-record, 500/501/10,000-payment-collision,
unsafe/visible-Unicode, and split property evaluations are linked from the Goal 1 evidence file. A
fresh PostgreSQL 17.10 run applied all 44 migrations and proved restricted-worker split persistence,
replay-safe immutable occurrences, mutation denial, and foreign-tenant RLS denial; the general
11-test tenant file also passed on that cluster. Separate fresh-database worker and API tests plus
API/BFF/browser checks prove exact/legacy labeling, a ten-per-type preview, five-MiB BFF ceiling,
append-only/RLS controls, accessibility, and mobile containment. Tenant/run/type-bound keyset
pagination now expands that preview through bounded API/BFF pages while retaining the same evidence
fidelity. Fresh PostgreSQL and Chromium checks traverse 12 match artifacts without duplicates,
reject malformed and cross-scope cursors, and conceal the run and snapshots from a foreign tenant;
evidence is in `artifacts/reconciliation-artifact-pagination-verification-2026-07-29.json`. A
current mocked Chromium fixture renders the exact split rule/reason and three-record cardinality
without detected accessibility or mobile-overflow failures. A checked-in continuous local
Chromium/BFF/API/outbox/Redis/restricted-worker/PostgreSQL journey now executes the eight-record
split fixture, renders the three-record split match, persists four exact immutable snapshots,
completes one durable job attempt, and returns a foreign-tenant `404`. These are regression
measurements, not proof of the proposed p95 SLO, staging accuracy, source-data prevalence,
accounting distributions, concurrency, or operator outcomes.

The separate 100-row pinned-input preview can now be expanded through tenant/run-bound ordinal
keyset pages. Fresh PostgreSQL and Chromium checks traverse 102 immutable input
record/version/content-hash references in 40/40/22 repository and 100/2 browser pages, reject
cross-run cursors, and expose zero run inputs to a foreign tenant. Evidence:
`artifacts/reconciliation-input-lineage-pagination-verification-2026-07-29.json`. The maximum
boundary now has a separate fresh PostgreSQL 17.10 exercise: concurrent 100-row and 97-row
restricted-role readers traversed 100,000 references both in-process and in two independent
processes. All four complete traversals had identical digests and continuous ordinals; the run also
confirmed the expected index, cross-run cursor rejection, and zero foreign rows. Those single-host
local timings are not an SLO; representative multi-host concurrency and staging latency remain
unmeasured. Evidence:
`artifacts/reconciliation-input-pagination-maximum-volume-verification-2026-07-29.json`.

The corresponding maximum-size creation path now writes pinned inputs in bounded 1,000-row
statements without splitting the run/input/outbox/audit transaction. A fresh checksummed PostgreSQL
17.10 database and restricted application role created one 100,000-input queued run with continuous
ordinals, one dispatch, and one audit event; exact repetition produced no duplicate authority, the
database log recorded 100 input inserts, foreign-tenant reads returned no result, and offline
checksums were clean. The direct repository timing is a local measurement, not evidence that the
proposed 100,000-record job-completion SLO is met. Evidence:
`artifacts/reconciliation-run-creation-maximum-volume-verification-2026-07-29.json`.

Atomicity now also has an explicit cross-batch negative. On another fresh PostgreSQL 17.10 database,
a verifier-only trigger rejected ordinal 1,000 in the second batch; the earlier input statement and
the queued run rolled back with zero run, input, outbox, or audit rows. Removing the trigger allowed
the identical deterministic snapshot to recover as one complete authority, and offline checksums
remained clean. A subsequent fresh-database run applied the new 5–120 second bounded authority
deadline and request-abort path to the same delayed second batch. Deadline expiry and an explicit
client signal each left zero authority rows, logged ordinary query cancellation with no fatal
session timeout, and were followed by complete 100,000-input recovery and exact-repeat idempotency.
Another clean run killed the actual independent creator process during that second batch. The
backend logged an unexpected EOF with an open transaction and left zero authority rows; an identical
retry created exactly one complete authority. Two additional direct Node creators were then observed
concurrently in PostgreSQL with one waiting on the organization advisory lock, and both returned one
shared 100,000-input authority with one outbox and one audit row. This closes the bounded
single-host process-loss and independent-process contention exercise, not ambiguous commits after
every possible disconnect. Real ingress/proxy disconnect, sustained queue pressure,
process-supervisor recovery, multi-host contention and partitions, end-to-end API latency, and
protected-staging behavior remain unmeasured. Evidence:
`artifacts/reconciliation-run-creation-atomic-rollback-verification-2026-07-29.json`. Interruption
evidence: `artifacts/reconciliation-run-creation-interruption-verification-2026-07-29.json`.
Process-loss/contention evidence:
`artifacts/reconciliation-run-creation-process-loss-contention-verification-2026-07-29.json`.

The next fresh maximum-volume run occupied both connections in a two-connection restricted
application pool. A signal-guarded response race returned the fixed interruption after 5,002.55 ms
while both holder transactions remained occupied. Releasing capacity let the expired internal
operation drain with zero authority rows, after which the process-loss/recovery/contention controls
still passed. This closes one bounded local pool-saturation response case, not sustained queue
pressure or an end-to-end API SLO. Real ingress/proxy disconnect, process-supervisor recovery,
multi-host partitions, sustained load, protected staging, and external alert evidence remain open.
Evidence: `artifacts/reconciliation-run-creation-pool-saturation-verification-2026-07-29.json`.

A subsequent increment bounds heavyweight authority transactions before constructing the
non-cancellable postgres.js operation, with a configurable default of two per API process. On a
fresh 100,000-record PostgreSQL 17.10 run with both application connections held, exactly two
requests reached their 5,001.93/5,002.10 ms deadlines; 32 more were rejected in 0.28 ms without
database admission. Another attempt after both public responses was rejected in 0.21 ms because the
hidden operations retained their slots. Releasing capacity drained both and left zero authority; the
process-loss, retry, and contention controls still passed. This closes a bounded single-process
burst/backpressure case, not sustained multi-replica load, an API SLO, or protected-staging
capacity. Evidence:
`artifacts/reconciliation-run-creation-admission-pressure-verification-2026-07-29.json`.

The API now records retry-safe run-creation unavailability in one low-cardinality OTLP counter,
using only the fixed reasons `admission_saturated` and `interrupted`. The reason remains internal
and the public `503` body is unchanged. Loopback protobuf capture proves both values are exported
without tenant or financial identifiers; no protected backend, dashboard, alert, or external
delivery has been exercised. Evidence:
`artifacts/reconciliation-run-creation-unavailability-observability-verification-2026-07-29.json`.

Production API request admission now rejects process-local limiting and requires one Redis-backed
budget, a stable environment-specific HMAC key, and explicit direct-proxy CIDRs. Synthetic
two-instance 120/121 coordination, forwarding-spoof rejection, fail-closed store behavior, safe
correlated responses, liveness independence, and static Nginx BFF/API routing checks pass. A local
authenticated Redis 8.2.8 run also passes the two-client shared-budget, HMAC-key, and TTL
assertions. A later isolated run starts two compiled API processes in production mode behind a
header-overwriting loopback proxy. Exactly 120 requests share one pseudonymous Redis key across both
processes and request 121 returns 429. An authenticated persistent Redis `SIGKILL` makes both
processes return the fixed fail-closed 500 while liveness remains 200; restart preserves the
exhausted budget, an unaffected address recovers through both replicas, and a drain-then-restart
rotation creates one new shared HMAC budget while old keys remain only for bounded expiry. The
reference edge now also uses a query-free structured JSON access log; negative static fixtures
reject query-bearing or combined formats, and a fresh exact Nginx 1.30.4 run parsed thirteen entries
without retaining synthetic callback `code`/`state` values. External ingress/CDN/hosting logs,
multi-host scheduling/load, managed Redis failover/partitions, collector policy, and alert evidence
remain open. Evidence: `artifacts/api-rate-limit-replica-recovery-verification-2026-07-29.json`,
`artifacts/redis-security-runtime-verification-2026-07-28.json`, and
`artifacts/edge-access-log-redaction-verification-2026-07-29.json`; decision: ADR 0060; threat:
TM-21 and TM-50.

Authentication evidence now also includes bounded, fail-closed provider access-token refresh and
replacement refresh-token rotation, with a real isolated short-lifetime/zero-reuse Keycloak 26.7.0
exercise showing no provider credential in browser-readable session data. A separate real
authorization-code/PKCE exercise verifies CSRF-safe RP-initiated Keycloak logout, complete local
chunked-cookie cleanup, and a login form on the next sign-in instead of silent SSO reuse.
Provider-initiated OIDC logout now has signed-token validation, replay-safe HMAC-indexed Redis
cutoffs, and fail-closed NextAuth/server-page/BFF enforcement with synthetic coverage. Authenticated
Redis 8.2.8 cross-client revocation/replay plus pseudonymous-key and TTL assertions pass locally. A
fresh exact Keycloak run now passes through two production-built web replicas sharing authenticated
persistent Redis, including targeted same-subject `sid` isolation, replay, Redis loss/fail-closed
behavior, durable recovery, and later login. Protected multi-host/managed-Redis execution,
clock/secret/provider-key rotation, external ingress, alert delivery, and a real identity with
memberships in multiple organizations remain open. Evidence:
`artifacts/oidc-distributed-revocation-recovery-verification-2026-07-29.json`; the distinct
two-identity invitation and membership-role lifecycle remains separately verified in
`artifacts/oidc-first-owner-bootstrap-verification-2026-07-29.json`.

API and worker runtimes now initialize a provider-neutral OTLP/HTTP protobuf pipeline when
configured. Production refuses an absent or non-HTTPS collector origin. Explicit API server and
durable-job consumer spans, trace-correlated redacted logs, and closed-vocabulary request/job
result-duration metrics plus aggregate reconciliation and outbox dispatch/dead-letter signals have
local loopback export evidence with bounded resource attributes, sampling, cardinality, buffers,
intervals, and timeouts. W3C API parent context is accepted but re-sampled locally so a remote
caller cannot force collection. All four current shared durable-envelope types now persist only
locally accepted context: reconciliation requests, signature-verified provider webhooks,
tenant-authorized CSV commits, and user-requested provider syncs. Provider-sync consumers also
parent child webhook jobs to their active authorized span. The worker creates every parented
consumer only after exact tenant-bound outbox authorization; legacy envelopes and scheduled sync
requests remain context-free roots. Local schema/worker/OTLP tests plus fresh restricted-role
PostgreSQL runs verify the contract. A protected collector/backend, authentication/egress,
retention/access, representative multi-process journey, remaining queue/business signals,
dashboards, failure/recovery, termination, and alert exercises remain open. Evidence:
`artifacts/observability-runtime-verification-2026-07-28.json` and
`artifacts/reconciliation-durable-trace-context-verification-2026-07-29.json`, plus
`artifacts/durable-producer-trace-context-verification-2026-07-29.json`.

The worker now reuses one environment/queue Redis lease to publish expiring, attribute-free
unresolved-exception presence and oldest-age gauges from a fixed, worker-only, one-row database
authority. Followers do not query PostgreSQL; failed, future, malformed, expired, and shutdown
states clear the snapshot instead of publishing a healthy zero. The additive global partial index is
built concurrently, and the migration ledger is written only after PostgreSQL reports the index
ready and valid. Local static/repository/worker/OTLP evidence passes; live 0044/0045 PostgreSQL
execution, protected thresholds, dashboards, silence behavior, and alert delivery remain open.
Evidence: `artifacts/unresolved-exception-queue-age-observability-verification-2026-07-29.json`;
decision: ADR 0043.

The same lease owner now publishes one atomic, expiring Shopify/Stripe snapshot for the oldest
queued or running provider sync. A fixed worker-only function hydrates at most one indexed row per
provider and returns only empty/active, queued/running status, and database-computed age from
immutable run creation. Followers do not query PostgreSQL; incomplete, future, malformed, failed,
expired, and shutdown observations clear both providers without a partial or healthy-zero view. The
0046 concurrent index is recorded only after ready/valid catalog checks, and 0047 grants the
function only to the worker. Local static/repository/worker/OTLP evidence passes; live PostgreSQL
execution, protected thresholds, dashboards, silence handling, and alerts remain open. Evidence:
`artifacts/provider-active-sync-age-observability-verification-2026-07-29.json`; decision: ADR 0044.

A backend-neutral policy now records 13 proposed lease-owned queue, unresolved-exception, and
active-provider-sync failure, silence, and age rules. One shared contract binds exact OpenTelemetry
names, instrument kinds, dimensions, and complete fixed values to instrument creation and policy
validation. Static checks reject production enablement, dynamic or high-cardinality dimensions,
unsupported values, reducer/schema drift, short silence windows, non-monotonic escalation, and
missing runbook anchors. Threshold no-data is normal because active-sync age is legitimately absent
with no active sync; dedicated monitor-counter absence and evaluation errors alert. This selects
reviewable operating defaults; it does not install a backend rule or prove an SLO. The
collector/backend translation, protected warning/critical/failure/silence injection, notification
receipt/acknowledgement/escalation, cardinality/load, maintenance silences, rollback, and owner
approval remain open. Evidence:
`artifacts/production-disabled-operational-alert-policy-verification-2026-07-29.json`; decision:
ADR 0050.

Every Shopify/Stripe recovery page now requires a distributed Redis circuit scoped to environment,
provider, tenant, and connection. Atomic token-bound transitions coordinate replicas, admit one
half-open probe, ignore stale results, count only rate-limit/timeout/unavailable failures, and fail
closed before a provider request when the circuit store is unavailable. Rate limits force-open and
durable retry honors bounded provider retry-after guidance. Fixed provider-sync outcome/duration and
circuit decision/transition metrics add no tenant or financial identifiers. Unit and authenticated
local Redis 8.8.0 two-client evidence passes; managed Redis TLS/ACL/failover, multi-host partitions,
mixed workers, provider traffic/limits, thresholds, dashboards, silence handling, and alerts remain
open. Evidence: `artifacts/provider-request-circuit-verification-2026-07-29.json`; decision:
ADR 0045.

The tenant-authorized connector view now lists every fixed Shopify, Stripe, and accounting CSV
source family as never observed or with independent latest source/receipt timestamps. Both queries
use the server-derived tenant transaction and explicit organization predicates; strict mapping
rejects foreign connections, incompatible/dynamic types, duplicates, and malformed times. The
browser validates the response and states that freshness does not prove completeness. Migration 0048
adds the restart-safe concurrent tenant/connection index. Unit/API/static and six focused Chromium
tests pass; live PostgreSQL index/RLS execution and the populated previous-release upgrade now pass.
Representative timing, provider completeness, bounded legacy repair, and protected staging remain
open. Evidence: `artifacts/tenant-source-object-watermarks-verification-2026-07-29.json` and
`artifacts/postgresql-51-migration-integration-verification-2026-07-29.json`; decision: ADR 0046.

Post-acceptance review found that the ADR 0046 direct-topic premise did not represent normal
provider ingestion: `source_events.external_object_type` preserves transport topics, and a Shopify
snapshot can classify to more than one family. The accepted ADR and artifact remain immutable
historical records, but that premise is withdrawn. ADR 0047 corrects the path forward with an
atomic, versioned, tenant-scoped source-event classification, a connection-wide
`classification_unavailable` state for any legacy/old-writer gap, and migration 0049 with no unsound
automatic backfill. That corrective increment intentionally left Stripe balance-transaction
ingestion open. Focused classification/API/static and seven Chromium tests pass; live PostgreSQL
execution now verifies the forced-RLS classification table, restricted grants, atomic provider
persistence, replay, and tenant isolation. ADR/migration 0051 now add a dedicated execute-only
maintenance role and bounded exact-classifier repair. Local two-session PostgreSQL 17.10 evidence on
the 53-migration chain verifies concurrent locked claims, immutable-object digest/size/deadline
checks, atomic hash-chained audit, direct-table/function denial, integrity rollback/retry, replay,
and unsupported gaps that block completion. ADR/migration 0052 add a disabled-by-default one-way
boundary that serializes activation with in-flight writers and rejects classification-unaware
commits thereafter. Local PostgreSQL verifies the synthetic old-writer race, current Shopify/CSV
paths, privacy exemption, replay, role denial, and tenant isolation. The repository has no prior
deployable image; actual mixed-writer rollout, representative timing/storage, hosted PostgreSQL, and
protected staging remain open. Evidence:
`artifacts/source-object-classification-correction-verification-2026-07-29.json` and
`artifacts/source-event-classification-repair-verification-2026-07-29.json`, extended by
`artifacts/source-event-classification-writer-fence-verification-2026-07-29.json`; decisions: ADRs
0047, 0051, and 0052.

Stripe connector/normalizer 1.1.0 now adds bounded two-phase Events and charge balance-transaction
recovery. Each list page uses a separate tenant/connection circuit permit; the balance snapshot
strips unrelated Charge/customer fields, validates integer minor-unit conservation, classifies
atomically, and normalizes total fee without currency conversion. Missing PaymentIntent evidence
remains explicit and incomplete. Focused connector/sync/ingestion tests pass, and the fresh
PostgreSQL application-role run verifies minimized balance-transaction fee persistence,
classification, replay safety, and foreign-tenant denial. Owner permission review, an authorized
Stripe sandbox contract, async repair convergence, mixed-worker rollout, interchange-plus exclusion,
protected staging, and alerts remain open. Evidence:
`artifacts/stripe-balance-transaction-recovery-verification-2026-07-29.json` and
`artifacts/postgresql-51-migration-integration-verification-2026-07-29.json`; decision: ADR 0048.

Restricted support diagnostics are now default-disabled and separate platform support identity from
tenant membership. Exact configured OIDC group and MFA authentication-context claims authorize only
creation of a 15-minute organization-unbound request. One active tenant owner must exchange its
one-time digest-only code for a 5–60 minute, fixed read-only aggregate-diagnostics grant. Forced-RLS
request/grant ledgers, execute-only functions, exact tenant/grant/keyed-identity checks, revocation,
capped output, worker/direct-table denial, uniform not-found behavior, and hash-chained audit pass
unit/API/tenant/static tests plus the fresh 55-migration PostgreSQL 17.10 run. A separate
organization-blind support console now retains its one-time code only in page memory, accepts exact
approved identifiers, renders only the fixed aggregate schema, and returns one denial state. The
tenant Security surface uses signed organization context for owner-only list, explicit approval, and
revocation. Fixed-route/cookie/response-bound BFF tests and 50 Chromium tests, including 14
accessibility scans, pass. The complete database suite passes 39 tests across 11 files, including
the populated 0041-to-0054 upgrade. The current repository suite passes 641
unit/property/tenant/reconciliation tests in 92 files. A fresh isolated Keycloak 26.7.0/PostgreSQL
17.10/API/web/Chromium run now binds the native LoA 2 browser flow, requests `acr_values=2`, proves
password-plus-TOTP and wrong-code denial before an application session, requires exact
`/reconai-support` group and signed `acr=2`, denies a valid-MFA outsider without durable state, and
composes the complete request/owner-approval/fixed-diagnostics/revocation/RLS/v2 audit journey.
Deployed/protected IdP policy and MFA-bypass resistance, ticket-system validation, customer
notification, clipboard/endpoint controls, multi-replica key rotation, offboarding, periodic access
review, timing, incident, and protected-staging evidence remain open. Evidence:
`artifacts/restricted-support-access-verification-2026-07-29.json`,
`artifacts/restricted-support-browser-tools-verification-2026-07-29.json`, and
`artifacts/oidc-restricted-support-mfa-verification-2026-07-30.json`; decisions: ADRs 0053 and 0054.

The exception queue now closes the remaining PRD filter contract locally. Exact canonical source
resolution is tenant-scoped and capped at 500 record references; amount bounds require one ISO
currency and signed integer minor units; confidence is deterministically derived from rule evidence;
assignment is limited to current-member/assigned/unassigned states; and disjoint UTC age buckets
share one database transaction instant across cursor-v2 pages. Low and unclassified confidence
require two reviewers when dual control is enabled. The same filters drive the permissioned,
formula-safe CSV v2 export and its audit snapshot. API/BFF malformed input, tenant-negative,
Chromium/accessibility, and fresh PostgreSQL 17.10 checks pass locally. Representative-volume query
plans, multi-replica behavior, protected staging, and owner/provider evidence remain open. Evidence:
`artifacts/exception-queue-filtering-verification-2026-07-29.json`; decision: ADR 0057; threat:
TM-47.

Investigation and run-artifact evidence now use a strict bounded browser view rather than generic
JSON. Current rule evidence is validated at engine output and at rest; paired source/normalized
comparisons, rule/tolerance/result/search summaries, safe kind-specific canonical values, and
all-or-nothing field lineage are the only admitted fields. Unknown, future, malformed, oversized, or
inconsistent evidence receives a fixed unavailable state. Exception record UUIDs reach the browser
only when the unique stored set exactly equals tenant-resolved source records; a crafted
foreign-tenant reference is concealed under both explicit organization predicates and forced RLS.
Local unit/tenant/reconciliation, Chromium, accessibility, and fresh PostgreSQL 17.10 scope is
recorded in `artifacts/typed-investigation-evidence-verification-2026-07-29.json`; decision: ADR
0058; threat: TM-48. Historical evidence disposition, representative load, protected staging,
provider authority, and owner decisions remain open.

The deprecated OIDC URL-parser finding is now closed locally without changing session authority. The
exact NextAuth transitive `openid-client@5.7.1` is bound to a reviewed patch replacing every
`url.parse()` call with WHATWG `URL`; configured issuers must be canonical, and the security gate
validates the lock hash, installed source, Keycloak PKCE/state, discovery, callback, logout, and
Passport behavior under `--throw-deprecation`. Focused issuer/refresh/logout/revocation and full
repository/browser checks pass locally. The patch is a maintenance bridge rather than a new upstream
release. A fresh isolated Keycloak 26.7.0 exercise now passes the patched authorization-code/S256
PKCE path, zero-reuse refresh rotation, credential nondisclosure, RP logout, signed Back-Channel
Logout into one actual Next.js process, old-cookie denial, and repeat-login behavior under fatal
deprecation handling. A separate fresh loopback exercise now runs two production-built Next.js
processes with the shared authenticated Redis 8.2.8 authority: two distinct same-subject sessions
work through both replicas; a signed Keycloak `sid` logout revokes only the target; replay is
idempotent across replicas; Redis `SIGKILL` makes authenticated admission and logout fail closed
while anonymous liveness remains available; and persistent restart restores the cutoff, unaffected
session, and later login. Protected multi-host scheduling, managed Redis/TLS ingress, clock and
secret/signing-key rotation, alert delivery, and a stable upstream replacement preserving the
complete auth contract remain open. Evidence:
`artifacts/oidc-url-parser-patch-verification-2026-07-29.json` and
`artifacts/post-patch-oidc-lifecycle-verification-2026-07-29.json`, plus
`artifacts/oidc-distributed-revocation-recovery-verification-2026-07-29.json`; decision: ADR 0059;
threats: TM-09 and TM-49.

## Goal 2 — Production hardening

Status: **Active** (one bounded local pure-engine load profile passes; end-to-end staging does not)

Required evidence:

- Tenant-isolation verification across database, API, worker, cache, object storage, exports,
  observability, and support tooling, including adversarial negative tests.
- Reproducible load report at the target dataset with bottlenecks and revised SLOs.
- Monitoring dashboards and exercised alert scenarios.
- Encrypted backup plus timed restoration and integrity verification.
- Reviewed operations, incident, deployment, rollback, retention, and support runbooks.
- Dependency/container/static/secret/security review with no unresolved critical issue.
- Approved staging deployment and disaster/failure exercises.

Dependencies: representative staging environment and Goal 1.  
Completion date: not complete.  
Evidence index: `docs/goals/goal-2-hardening.md`.

The first versioned representative load profile now exercises exactly 100,000 deterministic
synthetic records across exact order/payment/fee matches, Shopify/Stripe/accounting refunds, missing
payments, unmatched payments, and malformed identifiers. Five fresh processes using canonical,
reversed, rotated, and repeated input orders produced the same run key and complete result digest:
36,000 matches, 12,000 declared exceptions, zero ambiguous candidates, and exact integer-money
conservation. Recorded pure-engine durations were 1,664.48–1,948.55 ms with a 521,650,176-byte
maximum observed RSS on one local ARM64 host. This is not the proposed p95 job SLO: it excludes API,
database, queue, worker persistence, browser, network, sustained-arrival, multi-tenant, and
protected-staging behavior. Evidence:
`artifacts/reconciliation-representative-load-post-lint-verification-2026-07-30.json`; decision: ADR
0067; latest audit: `docs/goals/goal-2-audit-2026-07-30.md`.

## Goal 3 — Controlled AI assistance

Status: **Not started**

Required evidence:

- Versioned ambiguous-candidate evaluation dataset containing synthetic or authorized redacted data.
- Structured explanation/ranking schema and injection/fallback tests.
- Offline baseline/regression results with sample counts and error analysis.
- Human-agreement, cost, and latency measurements—not targets reported as results.
- Organization feature flag, rate/cost caps, audit evidence, safe-disable, and rollback exercise.

Dependencies: stable deterministic baseline and privacy/provider decisions.  
Completion date: not complete.  
Evidence index: `docs/goals/goal-3-controlled-ai.md`.

## Goal 4 — Connector expansion

Status: **Not started**

Required evidence:

- QuickBooks Online read-only connector contract/backfill/webhook-or-polling/privacy tests.
- Shipping-provider connector chosen from validated customer need and passing the connector suite.
- Published connector SDK guide, compatibility contract, example, and conformance test kit.

Dependencies: validated demand and hardened connector framework.  
Completion date: not complete.  
Evidence index: `docs/goals/goal-4-expansion.md`.

## Completion policy

Code, documents, or a local passing unit test alone never completes a goal. Change a milestone to
**Verified complete** only after every criterion has linked, reviewable evidence; security and
migration checks pass; runbooks and rollback are current; known limitations are stated; and no
critical issue remains. Record the date and immutable evidence links at that time.
