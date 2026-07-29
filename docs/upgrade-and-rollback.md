# Upgrade and rollback

Before upgrading: read the changelog, confirm supported Node/PostgreSQL/Redis versions, inventory
current app/migration/config versions, test in staging with a sanitized/synthetic representative
snapshot, verify backup/restore, and write exact rollback triggers.

Use immutable image digests and expansion/contraction migrations. Apply backward-compatible schema,
deploy compatible worker/API/web, verify health/queue/connector/replay, then complete deferred
backfill/constraint/contraction only in a later safe window.

Application rollback uses the prior compatible image without reverting durable audit/source data. Do
not apply a destructive down migration. If new writes are incompatible, stop affected work and apply
the pretested forward repair or restore into isolation and execute an approved cutover.

Rollback triggers include tenant isolation or auth failure, financial result change outside the
approved rule version, duplicate artifacts, migration integrity error, unbounded queues/errors,
source write risk, or failed health/smoke criteria. Preserve incident evidence and notify based on
verified impact.

## Latest live verified transition

The current local upgrade exercise creates a populated database through
`0041_paginated_organization_access_directory.sql` with real checksums. It seeds two organizations,
one user, two memberships, an existing connection and member-requested provider run, plus a valid
two-event version-1 audit chain, then invokes the normal migration runner. It applies
`0042_identity_bound_organization_bootstrap.sql` and `0043_reconciliation_occurrence_snapshots.sql`.
The exercise preserves the organization/user/membership snapshot, every legacy audit
ID/predecessor/digest, the prior `reconai_app` tenant/directory queries, and existing provider
authority. The application role then creates a new fixed-owner tenant through the installed
bootstrap function.

The same source state passes all 54 integration tests across 19 API, web, worker, database,
object-storage, and queue files against a fresh data-checksummed PostgreSQL 17.10 cluster,
authenticated Redis 8.2.8, and pinned MinIO. It exercises forced RLS and cross-tenant denial,
organization-bootstrap service concurrency/audit rollback, audit writer topology, OAuth/privacy,
connector credentials, provider sync/webhooks, CSV, retention, outbox, API repositories, worker
reconciliation, distributed rate/session state, and immutable/versioned objects. Evidence is
recorded in `artifacts/organization-bootstrap-postgresql-verification-2026-07-29.json`; the prior
0038-to-0039 and 40-migration run remains in `artifacts/postgresql-verification-2026-07-28.json`.

Application rollback for 0039 stops audit-producing mutations and restores the compatible
topological-head writer or an approved forward repair while leaving the additive column,
constraints, indexes, trigger, and immutable evidence intact. Do not down-migrate or rewrite the
ledger. The prior application image, backup restore, representative-volume lock/scan timing, and
production-style cutover remain unexercised.

## Current OAuth expansion

Migrations 0033–0035 add provider authorization attempts, service-authored refresh generations, and
Stripe app-deauthorization evidence. They are additive, do not backfill or rewrite financial data,
and are designed to remain dormant when both OAuth flags are false. The current empty-schema chain
and six live synthetic OAuth lifecycle tests pass through the application and worker roles,
including callback claim concurrency, refresh serialization, cross-tenant concealment, Stripe
deauthorization replay, and append-only evidence.

Before enabling OAuth, repeat the populated pre-0033 upgrade and role tests at representative
volume, measure the `connector_credentials` constraint replacement, and use authorized provider
sandboxes for installation, refresh, deauthorization, and ambiguous provider-success/local-commit
recovery.

Rollback disables `SHOPIFY_OAUTH_ENABLED` and `STRIPE_OAUTH_ENABLED`, stops new authorization and
provider reads, and leaves the additive schema/evidence intact. A prior image cannot refresh OAuth
bundles or complete provider-aware disconnect. Revoke at the provider or reauthorize after rollback
through an approved path; never restore a superseded credential, fabricate a Stripe deauthorization
event, or delete authorization/audit evidence.

The exercises did not launch the prior application image, restore a backup, measure a
representative-volume migration, or simulate a production cutover, so those remain required staging
evidence.

## Current Shopify privacy expansion

Migrations 0036–0038 add minimized app-level Shopify privacy request evidence, legal-hold-serialized
raw-object deletion jobs/tombstones, and an append-only deadline-escalation ledger with worker-only
bounded candidate/create functions. They are additive and do not rewrite legacy canonical rows,
create historical alerts, or delete objects during migration. The current empty-schema chain and
live synthetic application/worker repository tests pass against PostgreSQL 17.10, including
post-HMAC tenant resolution, cross-tenant denial, exact checksum-bound object deletion,
legal-hold/retry behavior, minimized reads, and deadline signals.

Before routing the mandatory privacy subscription, repeat a populated pre-0036 upgrade at
representative volume, exercise the real provider subscription and external alert path, and verify
backup/cache/export disposition. Inventory legacy Shopify `customerReference` values separately; the
new insert trigger rejects future values but deliberately does not invalidate historical
reconciliation hashes.

Rollback disables `SHOPIFY_OAUTH_ENABLED`, routes the external privacy endpoint away from an
incompatible image, sets `PROVIDER_PRIVACY_DEADLINE_MONITOR_ENABLED=false`, and stops the privacy
executor while leaving request/job/tombstone/alert evidence dormant. Do not drop or edit the
ledgers, bypass a legal hold, or clear an action-required connection. Raw tombstones and deadline
signals do not prove merchant data delivery, external alert response, canonical/audit disposition,
noncurrent object expiry, or backup handling.

The bounded customer-data evidence package in ADR 0015 does not store package bytes. Migration 0050
adds append-only digest-only preparation and browser-receipt ledgers plus the fixed acknowledgement
function required by ADR 0049. Apply 0050 before deploying the API/web images that emit and consume
the receipt headers; those images fail closed when the function is absent. Prior images ignore the
additive tables. Expected impact is short catalog locking for two empty tables, indexes, policies,
triggers, function, and grants; there is no backfill or financial-row rewrite.

Rollback restores the prior API/web images or disables package preparation and leaves all package
and receipt evidence immutable. Do not drop/edit the tables, reuse a token digest, or manufacture a
receipt. ReconAI still does not persist package bytes. Securely dispose of operator-downloaded
copies under the approved transfer/expiry procedure. A browser receipt proves only that the
authenticated browser received the complete bytes; rollback does not prove merchant/customer
delivery, review, fulfillment, downloaded-copy expiry, or legal sufficiency.

## Current audit-chain expansion

Migration 0039 adds a hash-version label, validates the entire existing per-tenant predecessor
graph, and installs unique event/predecessor/genesis indexes, a tenant-composite self-foreign key,
and hash checks plus same-lock head validation for every insert. It does not rewrite audit evidence.
The compatible repository writer finds the topological head rather than ordering by business time
and authors canonical version-2 hashes.

Before applying 0039, quiesce audit-producing API/worker work, verify a restorable backup, measure
the repeated validation scans and transactional index builds on representative volume, and approve
lock/statement timeouts plus a maintenance window. A preflight error means the legacy graph is
invalid; stop and preserve evidence. Do not mutate the ledger, disable its append-only trigger, or
drop a check to force progress.

Deploy the compatible writer before resuming mutations. A prior image may try to reuse a consumed
predecessor after a late business event; 0039 rejects that insert, so application rollback requires
audit-producing work to remain stopped until a forward code repair or the compatible writer is
restored. Leave the additive migration and immutable rows in place. Local empty and populated
execution plus application-role concurrency and topology denials pass; representative-volume timing,
prior-image rollback, and backup/restore remain required.

## Current durable-queue expansion

Migration 0040 adds nullable outbox execution tracking, forced-RLS job-execution and append-only
recovery ledgers, fixed worker functions, indexes, constraints, and triggers. It does not backfill
or mark legacy outbox rows, and the tracking column intentionally has no default. Old writers
therefore continue to create null/unclassified events after the migration.

Apply 0040 first, upgrade every worker to the token-digest lease implementation, and only then
upgrade API/other explicit version-1 writers. The scheduled-repair repository sets a
transaction-local opt-in that its unchanged database function consumes at insert time. During the
compatibility window, work produced by old writers is processed normally but remains conservatively
unrecoverable if Redis is lost between publication and the first new-worker lease. Do not backfill
or guess those rows.

Do not roll a worker back to a pre-ledger image while version-1 producers remain active: a completed
job would have no ledger and could later look never started. Quiesce producers, stop recovery
commands, preserve/drain Redis, and restore a ledger-compatible worker or disable version-1
production first. Leave the additive schema and append-only evidence in place. Never down-migrate,
clear execution state, or delete recovery events as an application rollback.

Static checks and fresh PostgreSQL 17.10 tests cover the no-default expansion, old/new scheduled
writer behavior, RLS/role boundaries, token lease lifecycle, terminal immutability, and conservative
classification. Representative-volume migration/index timing, a real prior-image rolling deployment,
production-like restore/cutover, and cross-store failure operations remain staging requirements.

## Current organization-directory expansion

Migration 0041 adds a bounded identity-derived page function with literal search, lower-name/UUID
keyset order, and an optional exact organization filter. It creates no customer table or index,
rewrites no row, and performs no backfill. The old two-argument function remains, so the expected
upgrade order is migration first, then API and web. The prior API can continue listing its bounded
directory during a rolling window; the new API fails closed if 0041 is absent.

Rollback API and web together and leave both functions/grants intact. Do not drop the page function
or revoke the compatibility function during image rollback. A later contraction may remove the old
function only after deployment inventory proves no prior image remains. Static/synthetic
application-role, cursor, search, exact-filter, API, and BFF tests pass; a populated 0040-to-0041
upgrade test is defined but has not been executed against PostgreSQL in this verification slice. A
fresh isolated Keycloak/PostgreSQL/browser exercise now proves 101 active tenant-complete
memberships through 50/50/1 pages, final-item selection, cross-identity denial, and immediate
deactivation/reactivation. A bounded 501-membership follow-up traverses all eleven pages, stops
browser accumulation at 500 with refine-search guidance, selects membership 501 through exact
search, and repeats the denial/lifecycle assertions. Representative query timing, substantially
larger directories, sustained or multi-host product-API mutation, protected staging, and
prior/new-image rolling execution remain requirements. A separate fresh PostgreSQL exercise now
proves the accepted non-snapshot rename drift, current exact lookup, immediate
deactivation/reactivation, foreign concealment, and tenantless RLS denial; Chromium deduplicates a
renamed ID repeated across pages. A fresh PostgreSQL/Fastify exercise also proves two simultaneous
administrator writes serialize through the actual membership route and restricted repository into
one linear v2 audit chain.

## Current organization profile expansion

Migration 0055 adds `organizations.profile_version integer NOT NULL DEFAULT 1`, a positive check as
`NOT VALID`, and a separate validation step. Existing organization rows become profile version 1
without changing identifiers, names, time zones, tenant keys, audit history, or reconciliation
behavior. On supported PostgreSQL versions the constant-default column expansion is metadata-only;
the initial statements still require brief table locks, and check validation scans the organization
table under a weaker lock.

Measure organization row count, validation scan duration, lock wait, statement timeout, and replica
lag in protected staging before rollout. Apply migration 0055 before the API/web images. Prior
images ignore the additive column. The new API requires it for the tenant-authorized profile GET/
PATCH routes and optimistic expected-version contract.

Rollback API and web together and retain the column, constraint, advanced profile versions, and
`organization.profile.updated` audit events. Never decrement a profile version, delete accepted
audit evidence, or down-migrate the column. A fresh PostgreSQL 17.10/Fastify run applies all 56
migrations and verifies one accepted/one conflicting simultaneous update, stale retry, same-name
no-op, immediate exact-directory visibility, analyst/foreign denials, linear v2 audit, and
tenantless RLS. Three Chromium tests verify confirmation, switcher refresh, conflict reload, and
accessibility. This is single-host local evidence; representative lock/scan timing, replica lag,
prior/new-image rolling execution, failover, and protected staging remain required. Evidence:
`artifacts/organization-profile-concurrent-api-verification-2026-07-30.json`; decision: ADR 0061.

## Current first-organization bootstrap expansion

Migration 0042 adds an empty tenant-scoped append-only bootstrap-request table, tenant-first
indexes, forced RLS, narrow migration-owner policies, and an application-executable fixed-path
identity bootstrap function. It does not rewrite or scan existing customer rows, backfill identity
data, change a financial rule, or enable AI. The expected deployment order is migration, API, then
web. Prior images ignore the additive structures; the new API requires the function and its
configured service.

The function serializes by verified issuer/subject, requires no active membership, creates a
server-identified organization and fixed owner with AI disabled, and records digest-bound
idempotency evidence. The API and first canonical audit event share the same transaction. An exact
retry returns the same IDs; a different payload or later membership fails closed.

Rollback API and web together and preserve the additive function, organization, owner membership,
bootstrap request, and audit evidence. Never down-migrate, delete the evidence, or demote the sole
owner as rollback. Static/synthetic migration, transaction, API, BFF, CSRF, and idempotency tests
pass. Fresh restricted-role execution, forced-audit rollback, populated 0041-to-0043 upgrade, and
isolated real Keycloak/two-tab 201/409 browser convergence now pass. External IdP federation,
prior/new-image rolling behavior, and representative timing remain staging requirements.

## Current unresolved exception-queue observability expansion

Migration 0044 builds an additive partial `(created_at, id)` index over unresolved exception states
with `CREATE INDEX CONCURRENTLY IF NOT EXISTS`; migration 0045 adds an identifier-free,
worker-executable observation function. No row is rewritten or backfilled, no financial or review
state changes, and prior workers ignore both structures. Apply 0044 and 0045 before deploying the
new worker.

The runner executes marked concurrent-index migrations outside its normal per-file transaction but
retains the global advisory lock. It records 0044 only after `pg_index` reports the same-named index
ready and valid. A process exit after valid creation and before ledger insertion is safely
rerunnable. A failed build can leave an invalid index; in that case the unchanged runner leaves the
migration unapplied. Preserve the error/catalog evidence and perform a reviewed forward repair of
the confirmed invalid index before retrying—never insert the migration checksum manually.

Rollback to the prior worker and leave the additive index/function/grants in place. Do not drop them
until deployment inventory proves no new observer remains. Static and synthetic migration,
repository, worker, and OTLP tests pass. Empty/populated live PostgreSQL execution,
interruption/resumption, restricted-role calls, representative index timing/disk/replica impact, and
an actual prior/new-worker rolling window remain unverified.

## Current provider active-sync observability expansion

Migration 0046 builds an additive partial `(provider, created_at, id)` index over queued/running
provider syncs with `CREATE INDEX CONCURRENTLY IF NOT EXISTS`; migration 0047 adds a fixed
worker-only two-provider observation function. No row is rewritten or backfilled, no provider call
or sync state changes, and prior workers ignore both structures. Apply 0046 and 0047 before
deploying the new worker.

The non-transactional runner keeps its global advisory lock and records 0046 only after PostgreSQL
reports `provider_sync_runs_active_oldest_idx` ready and valid. A valid-index/absent-ledger crash is
rerunnable. An invalid same-named index leaves the migration unapplied and requires preserved
evidence plus reviewed forward repair before retry; never insert the checksum manually.

Rollback to the prior worker and leave the additive index/function/grants in place. Do not drop them
until deployment inventory proves no new observer remains. Static and synthetic migration,
repository, worker, and OTLP tests pass. Empty/populated live PostgreSQL execution,
interruption/resumption, application/worker role calls, representative index timing/disk/replica
impact, and an actual prior/new-worker rolling window remain unverified.

## Current tenant source-object classification correction

Migration 0048 adds one concurrent covering index over tenant/connection/raw transport topic/source
and receipt timestamps. It rewrites no row, adds no provider call, changes no financial or
reconciliation state, and is ignored by prior images. It is a raw-event access path, not
product-family authority.

The non-transactional runner keeps its global advisory lock and records 0048 only after PostgreSQL
reports `source_events_org_connection_object_watermark_idx` ready and valid. A valid-index/
absent-ledger crash is rerunnable. An invalid same-named index leaves the migration unapplied and
requires preserved evidence plus a reviewed forward repair before retry; never insert the checksum
manually.

Migration 0049 transactionally adds the tenant-owned, forced-RLS, append-only
`source_event_object_classifications` table. New provider and CSV writers persist one complete
versioned family array atomically with their source receipt; the reader joins those rows and exposes
any operational receipt without one as connection-wide `classification_unavailable`. Migration 0049
deliberately performs no legacy backfill because a Shopify snapshot topic cannot prove whether the
immutable payload contains refunds.

Apply 0048 then 0049 before the new API/worker/web images, and drain or exclude all old writers
before admitting traffic. Migration 0051 adds the dedicated-role, one-row-at-a-time repair authority
defined by ADR 0051; it still performs no backfill. Provision `reconai_maintenance` before 0051,
deploy only classification-aware writers, inventory both total and repairable gaps, and run the
reviewed integrity-verified command in batches of at most 100. Require zero total gaps before
claiming complete classification coverage. Never infer or insert a classification from a snapshot
topic alone.

Migration 0052 is the separate opt-in transition boundary. It remains disabled after migration. Once
old writers are drained and zero compatible gaps are independently verified, activation waits for
every in-flight source transaction under the exclusive half of a shared/exclusive advisory lock,
rescans the database, and appends one immutable singleton. From that commit onward, a deferred
trigger rolls back any operational source receipt without its exact V1 classification.

Before activation, API/web/worker may roll back together while leaving additive structures dormant.
After activation, only classification-aware images are compatible; there is no disable command.
Never restore an old writer, update/delete the activation row, disable the triggers, or remove the
index/table/functions while new evidence exists. Stop repair execution and retain all maintenance
authority, classifications, audit evidence, and the 0052 singleton.

Static migration, classification, strict mapping, API, and focused accessible Chromium tests pass.
Live PostgreSQL 17.10 covers the 53-migration chain, populated previous-release upgrade,
restricted-role RLS/foreign-tenant behavior, concurrent repair, integrity rollback/retry, replay,
unsupported gaps, the in-flight old-writer race, current provider/CSV compatibility, privacy
exemption, and one-way activation. Representative query/write/build/repair/activation timing and
actual prior/new-image rolling execution remain unverified.

## Current Stripe balance-transaction recovery expansion

Stripe connector/normalizer 1.1.0 adds a second bounded recovery phase after Events. It lists only
charge balance transactions, persists a versioned minimized snapshot, and uses the existing
receipt/classification/outbox/canonical schema. There is no database migration and no reconciliation
rule-version change.

The new worker reads legacy `evt_*` cursors plus `stripe-v2:*` Events/balance cursors. An older
worker cannot read a version-2 cursor. Stop scheduler and user-requested provider-sync admission,
drain or terminally account for existing Stripe runs and all prior workers, deploy only 1.1-aware
workers, then resume. Verify one empty-Events transition, one multi-page balance run, duplicate
replay, tenant concealment, permission denial, and connection/source-family state before completing
rollout.

If rollback is required after a version-2 cursor has been written, stop affected work and retain the
immutable run. Redeploy the 1.1 reader to finish it or create a new owner-authorized bounded run
from the recorded window after the incident is understood. Never rewrite the cursor, receipt,
classification, canonical fee, or audit evidence to make an older worker accept it. Disable the
Stripe read path or revoke the reviewed permission if necessary; prior images can retain additive
1.1 source/canonical rows.

Production rollout still requires owner review of `balance_transaction_source_read` and its implied
permissions, an authorized Stripe sandbox/live-mode contract, async gap-repair behavior,
interchange-plus exclusion, protected staging mixed-image rehearsal, and alert response.

## Current reconciliation-rule expansion

Engine 0.7.0 and rule set/rule version 1.5.0 preserve the 1.4 bounded payment-candidate,
malformed-identifier, duplicate-fee, and one-row refund/accounting behavior while adding
`refund-accounting-split`. A split is eligible only for one complete 2–50-row positive accounting
bucket under one exact normalized transaction reference matching the refund external ID or refund
reference. The checked integer total must match within the pinned currency tolerance. The engine
never chooses a subset, nets non-positive rows, or aggregates by order reference; competing
representations, multiple strong references, non-conservation, overflow, and row reuse fail closed.

This changes deterministic artifacts, match counts, and run identities but requires no database
migration: matches, immutable occurrence snapshots, and evidence use existing tenant-scoped
structures. Existing 0.6.0/1.4.0 and earlier runs remain immutable historical evidence. Rejected
invalid/unsupported CSV rows remain pre-canonical outcomes.

Stop or drain reconciliation dispatch before deploying the API and worker together. A worker
recomputes and verifies the engine/rule identity pinned by the API; mixing versions fails the run
rather than silently executing different rules. Before rollback, drain new-version work again.
Rolling back to 0.6.0 restores the prior fail-closed multi-row ambiguity and must not rewrite 0.7.0
occurrences. Prefer a reviewed forward repair after an issue is understood. Local synthetic and
fresh restricted-role PostgreSQL evidence covers conserved splits, 50/51 limits, money overflow,
hidden-reuse taint, replay, immutable snapshots, and foreign-tenant denial; a mocked Chromium
fixture covers accessible split rendering. A separate isolated continuous
Chromium/BFF/API/outbox/Redis/restricted-worker/PostgreSQL run executes the same two-row split and
verifies its three-record evidence at browser, API, and immutable-snapshot boundaries.
Representative accounting distributions, concurrent load, operator workflow, alerts, mixed-image
execution, and protected staging rollback remain required.
