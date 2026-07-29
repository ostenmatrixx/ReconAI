# Database migration guide

All schema changes are committed migrations. Application startup never auto-migrates production.

## Create and review

Update the typed schema, generate or author SQL, and inspect every statement. Add non-null tenant
scope, composite tenant foreign keys/indexes, constraints, forced RLS policy, and application-role
grants for each customer table. Never put credentials or real data in migration/backfill SQL.

Prefer expansion/contraction:

1. Add nullable/new structures compatible with current code.
2. Deploy dual-read/write or bounded idempotent backfill with metrics.
3. Verify constraints and tenant correctness.
4. Switch reads.
5. Remove old structures in a later release after the compatibility window.

Document table scans, locks, rewrite/disk impact, transaction limits, timeout, pause/retry, backup
prerequisite, and forward rollback. Destructive down migrations are not the default rollback.

## Validate

Run from an empty database and from the previous supported release, then schema diff/checksum,
constraint/RLS/role tests, application compatibility, backfill idempotency, and representative
timing. CI validates migration ordering and records the chain digest; the migration runner compares
each stored database checksum and refuses to continue when an already-applied file changed.

Production applies through a separate least-privilege migration role with explicit approval. Record
version/checksum/start/duration/result. On failure stop, preserve error/evidence, follow the written
forward-fix/rollback, and never manually patch without a follow-up migration.

## Provider OAuth expansion

Migrations 0033–0035 are an additive compatibility sequence:

1. 0033 adds forced-RLS authorization-attempt evidence and widens the authenticated ciphertext
   ceiling for bounded OAuth token bundles.
2. 0034 permits only the fixed refresh service to author a replacement credential generation and
   adds tenant-bound lock/rotate functions for the worker.
3. 0035 adds append-only Stripe app-deauthorization evidence and the narrow account resolver needed
   before a webhook has tenant context.

Apply the complete sequence before setting either provider OAuth flag. Expected impact is catalog
locks for additive table/function/policy creation plus a constraint replacement on
`connector_credentials`; there is no financial-data rewrite or backfill. On a large credential
table, measure the constraint-validation scan in staging and set reviewed lock/statement timeouts.
Take the normal verified backup first.

Rollback is forward-only: disable `SHOPIFY_OAUTH_ENABLED` and `STRIPE_OAUTH_ENABLED`, stop provider
egress if containment is needed, and leave tables, functions, credential generations, and audit
evidence dormant. Do not drop the tables, delete deauthorization evidence, restore a superseded
credential, or manually change a connection from `action_required` to `disconnected`. Before
production enablement, verify the chain from empty and the previous supported release, run
application/worker least-privilege and negative tenant tests, and exercise both providers in
authorized sandboxes.

## Shopify privacy expansion

Migrations 0036–0038 are additive and must be applied before Shopify OAuth is enabled or the
app-level privacy subscription is routed to ReconAI:

1. 0036 adds append-only forced-RLS Shopify privacy request evidence, the narrow post-HMAC canonical
   shop resolver, request authority validation, app-only grants, and a trigger rejecting customer
   references on new Shopify canonical rows.
2. 0037 adds forced-RLS raw-object deletion jobs/tombstones, database-authorized worker
   claim/finalize/fail functions, immutable authority, bounded retry/dead-letter constraints, and
   advisory-lock serialization between privacy deletion and legal-hold changes.
3. 0038 adds forced-RLS append-only deadline signals, unique request/stage idempotency, exact
   seven-day/24-hour/overdue threshold constraints, and fixed worker-only candidate/create functions
   that require exact tenant context and near-current database time.

The sequence creates tables, indexes, policies, functions, and triggers but does not rewrite
financial rows or raw objects. Existing Shopify canonical customer references are intentionally not
backfilled because changing them would invalidate immutable content/input hashes; inventory and
disposition require a separate reviewed migration. Measure catalog locks and constraint scans in
staging, verify object-store request bounds, and take the normal verified backup first.

Forward rollback disables `SHOPIFY_OAUTH_ENABLED`, sets
`PROVIDER_PRIVACY_DEADLINE_MONITOR_ENABLED=false`, routes the privacy endpoint away from the old
image, and stops the privacy executor while preserving request/job/tombstone/alert evidence. Never
drop or edit the ledgers, bypass a legal hold, or clear `action_required` manually. The current
44-migration integration graph and OAuth/privacy application/worker repository tests pass against
isolated PostgreSQL 17.10. A populated pre-0036 upgrade, representative-volume migration timing,
provider sandbox traffic, and protected staging execution remain required before enablement.

## Audit-chain topology

Migration 0039 labels existing audit digests as version 1 and adds the database constraints required
for one linear chain per tenant. Its preflight rejects malformed/duplicate hashes, branches,
self-links, missing or multiple genesis events, orphans, and unreachable/disconnected events. It
does not rewrite a row or fabricate a repaired chain. New repository writes explicitly use canonical
hash version 2. A same-tenant-lock `BEFORE INSERT` trigger requires every non-replay row to create
the first genesis or extend the current head, including rows in a multi-value insert.

This migration performs repeated full-ledger validation scans and creates non-concurrent unique
indexes inside the migration transaction. On a populated system, quiesce audit-producing API and
worker traffic, verify backup/restore, measure representative-volume scans/index builds, choose
reviewed lock and statement timeouts, and apply in an approved maintenance window. If preflight
fails, preserve the database/error evidence and treat it as an integrity incident; never edit the
ledger or weaken the checks to advance the migration.

The new writer requires 0039. A prior image can read the additive schema, but its business-time head
selection may hit the unique predecessor constraint and fail closed. Forward rollback therefore
stops audit-producing mutations and returns to the new writer or an approved forward repair while
leaving the migration intact. Empty-schema and populated 0038-to-0039 PostgreSQL execution,
application-role concurrency, topology denials, and a synthetic PostgreSQL logical restore with
exact audit/catalog/RLS comparison pass locally. Representative-volume timing, prior-image rollback,
encrypted base-backup/WAL recovery, and staging cutover remain required.

## Organization-directory pagination

Migration 0041 adds one identity-derived `SECURITY DEFINER` page function with fixed search path,
row security, literal bounded search, lower-name/UUID keyset order, optional exact organization
filtering, and a narrow application-role grant. It creates no table/index, rewrites no row, performs
no backfill, and changes no financial rule. Expected impact is a brief catalog lock for function
creation and grants; verify the normal backup and reviewed lock/statement timeouts before applying.

Apply 0041 before the new API. The prior API remains compatible through the retained two-argument
function. Rollback the API/web images together and leave both functions in place. Removing the old
function is a later contraction migration only after deployment inventory excludes every prior API
image. Static/synthetic security, cursor, search, and tenant-negative tests pass. Empty/populated
PostgreSQL migration coverage passes, and a separate fresh isolated Keycloak/PostgreSQL/browser run
now proves 101 active tenant-complete memberships through 50/50/1 pages, final-item selection,
cross-identity denial, and immediate deactivation/reactivation. A bounded 501-membership follow-up
traverses all eleven pages, stops browser accumulation at 500 with refine-search guidance, selects
membership 501 through exact search, and repeats the denial/lifecycle assertions. Representative
timing, substantially larger directories, sustained or multi-host product-API changes, protected
staging, and an actual rolling-image deployment remain required. A separate fresh PostgreSQL
exercise now proves the accepted non-snapshot rename drift, current exact lookup, immediate
deactivation/reactivation, foreign concealment, and tenantless RLS denial; Chromium deduplicates a
renamed ID repeated across pages. A fresh PostgreSQL/Fastify exercise also proves two simultaneous
administrator writes serialize through the actual membership route and restricted repository into
one linear v2 audit chain.

## Organization profile version

Migration 0055 adds `organizations.profile_version integer NOT NULL DEFAULT 1`, a positive
constraint first as `NOT VALID`, and a separate validation step. Existing rows become version 1
without changing tenant identity, names, business time zones, or financial evidence. The constant
default avoids an application backfill on supported PostgreSQL versions. The initial statements
still take brief table locks; constraint validation scans the organization table under a weaker
lock.

Apply 0055 before the profile-aware API/web images. Prior images ignore the additive column. Measure
organization count, validation duration, lock wait, statement timeout, WAL, and replica lag against
restored representative data before a protected rollout.

Forward rollback restores the prior API/web images and retains the column, constraint, advanced
versions, and append-only profile audit events. Never decrement a version or down-migrate accepted
profile evidence. A fresh PostgreSQL 17.10/Fastify run applies all 56 migrations and verifies
optimistic concurrency, stale/no-op behavior, immediate directory visibility, v2 audit integrity,
lower-privilege/foreign denials, and tenantless RLS. Chromium verifies explicit confirmation,
conflict reload, switcher refresh, and accessibility. Representative lock/scan timing, multi-host
execution, replica failover, protected staging, and rolling images remain required. Evidence:
`artifacts/organization-profile-concurrent-api-verification-2026-07-30.json`; decision: ADR 0061.

## First-organization bootstrap

Migration 0042 adds the empty `organization_bootstrap_requests` table and tenant-first indexes,
forced-RLS/append-only controls, owner-only insert policies used by the migration-owned function,
and one fixed-path, row-security-on `SECURITY DEFINER` bootstrap function. It performs no backfill,
existing-row scan, financial-rule change, or customer-data rewrite. The function validates bounded
identity/input values and a real PostgreSQL IANA time-zone name, serializes per issuer/subject,
requires zero active memberships, creates a fixed owner with AI disabled, and binds exact retries to
the input digest.

Apply 0042 before the new API, then deploy API and web. Prior images do not call the new function
and remain compatible. The new API refuses non-test startup without its bootstrap service and fails
closed if the function is absent. Expected impact is a brief catalog lock for table/index/policy/
function creation; verify the normal backup and reviewed lock/statement timeouts before applying.

Rollback API and web together and leave the table, function, grants, owner membership, and immutable
bootstrap/audit evidence in place. Do not down-migrate or delete first-organization evidence. Static
and synthetic security/idempotency/API/BFF tests pass. Fresh restricted-role PostgreSQL execution,
populated 0041-to-0043 upgrade, and isolated real Keycloak/two-tab 201/409 browser convergence now
pass. Representative timing, external IdP federation, and actual prior/new-image rolling deployment
remain required.

## Unresolved exception-queue observability

Migrations 0044–0045 are additive. Migration 0044 creates the environment-wide
`exceptions_unresolved_oldest_idx` partial `(created_at, id)` index for `open`, `assigned`,
`deferred`, `proposed`, and legacy `rejected` rows. It uses
`CREATE INDEX CONCURRENTLY IF NOT EXISTS` so ordinary exception writes can continue during the scan.
Migration 0045 adds a fixed worker-only `SECURITY DEFINER`, `row_security=on` observation function
that returns only queue state and numeric oldest age; it does not change exception rows or financial
rules.

0044, 0046, and 0048 are the current `-- reconai:non-transactional` migrations. Validation and the
runtime runner restrict that path to exactly one named concurrent/idempotent index statement. The
runner keeps the global advisory lock, executes the command outside a transaction, checks
`pg_index.indisready` and `pg_index.indisvalid`, and records the checksum only after both are true.
A crash after valid index creation but before the ledger insert can rerun safely. A failed
concurrent build can leave an invalid same-named index that `IF NOT EXISTS` would otherwise skip;
catalog validation leaves the migration unapplied. Preserve that evidence and use a reviewed forward
repair to remove only the confirmed invalid index before retrying. Never fabricate or delete a
checksum row.

Apply 0044, then 0045, before deploying the new worker. Prior workers ignore the additive
index/function. Expected impact is one O(N) concurrent table/index scan, index I/O/CPU/temporary and
final disk, replica/WAL load, brief start/finalization locks, and short catalog locks for the
function/policy/grants. Verify a restorable backup, disk headroom, representative scan/replica
impact, and reviewed lock/statement timeouts first.

Forward rollback restores the prior worker and leaves both migrations dormant. Do not drop the index
or function while a new worker may still run. Static migration and synthetic repository/worker/OTLP
tests pass; live empty/populated PostgreSQL migration, restricted-role function execution,
interruption/resumption, representative-volume timing, and rolling-image compatibility remain
required.

## Provider active-sync observability

Migrations 0046–0047 are additive. Migration 0046 builds `provider_sync_runs_active_oldest_idx`, a
partial `(provider, created_at, id)` index over exactly `queued` and `running` provider syncs, using
`CREATE INDEX CONCURRENTLY IF NOT EXISTS`. Migration 0047 adds a fixed worker-only
`SECURITY DEFINER`, `row_security=on` function that performs one ordered limit-one lookup for
Shopify and one for Stripe. It returns only provider, empty/active, queued/running status, and
numeric age from immutable run creation.

The same restricted non-transactional runner path and ready/valid catalog checks described above
apply to 0046. If an interrupted build leaves `provider_sync_runs_active_oldest_idx` invalid, 0046
remains unapplied; preserve evidence and use a reviewed forward repair of only that confirmed
invalid index before retrying.

Apply 0046 and 0047 before deploying the new worker. Prior workers ignore both structures. Expected
impact is an O(N) concurrent scan of `provider_sync_runs`, final/temporary index disk, I/O/CPU,
WAL/replica load, brief start/finalization locks, and short catalog locks for function/grants.
Verify a restorable backup, disk headroom, representative active/terminal distribution, query plan,
scan/replica timing, and approved lock/statement timeouts.

Forward rollback restores the prior worker and leaves the additive index/function/grants dormant. Do
not drop them while a new observer may still run. Static migration and synthetic
repository/worker/OTLP tests pass; empty/populated live PostgreSQL migration, interrupted/resumed
build, restricted-role transitions, representative timing, and mixed-image execution remain
required.

## Tenant source-object classification and watermarks

Migration 0048 is additive. It builds `source_events_org_connection_object_watermark_idx` over
tenant, connection, transport topic, descending source timestamp, and descending receipt timestamp
using `CREATE INDEX CONCURRENTLY IF NOT EXISTS`. It rewrites no source row, changes no provider or
financial behavior, and adds no function or grant. The index remains useful for raw-event
connection/topic/time access, but the topic is not product-family authority.

The restricted non-transactional runner and ready/valid catalog checks described above apply. If an
interrupted build leaves the same-named index invalid, 0048 remains unapplied. Preserve the
error/catalog evidence and use a reviewed forward repair of only that confirmed invalid index before
retrying; never fabricate the checksum ledger.

Migration 0049 is a transactional additive migration. It creates the tenant-owned
`source_event_object_classifications` table with a tenant-composite source-event foreign key,
fixed-family allowlist, one atomic non-empty array, classifier version `source-object-family-v1`,
forced RLS, append-only enforcement, and application/worker `SELECT`/`INSERT` only. It does not
infer or backfill existing source events. Topic-only inference is unsound for Shopify snapshots, and
an unbounded migration-time object-store scan is not acceptable.

Apply 0048 and then 0049 before classification-aware API, worker, or CSV-writer images. Admit no old
writer after 0049: any operational event without a classification forces the authorized connection
view to `classification_unavailable`. Because no protected deployment exists yet, the first
deployment must start clean with only classification-aware writers. Migration 0051 now provides the
separately reviewed bounded repair for a populated upgrade; zero total gaps remains mandatory before
a complete-classification claim. Migration 0048 has one O(N) concurrent scan and associated index
disk, I/O/CPU, WAL/replica load, and brief start/finalization locks. Migration 0049 creates an empty
table and security objects; normal provider/CSV intake then adds one small append-only row per
source event. Verify backup, disk headroom, representative source-event distribution, write growth,
query plan/latency, scan/replica impact, and reviewed timeouts.

Forward rollback restores prior API/web/worker images and leaves the additive index and table
dormant. Do not drop either while a classification-aware writer or reader may remain. Static
migration, classification, strict mapping, API, and browser tests pass; live PostgreSQL 17.10
execution covers the full chain, populated previous-release upgrade, restricted roles, tenant/RLS,
and the bounded repair. Representative timing, hosted PostgreSQL, mixed-image behavior, and
protected staging remain required.

### Migration 0051 repair authority

Migration 0051 is transactional and additive. It requires the dedicated `reconai_maintenance`
cluster role to exist before migration execution, creates no classification rows, and performs no
object read. It adds migrator-owner RLS policies needed only by fixed security-definer functions,
then grants the maintenance role execute-only repair authority. The role has no direct
`source_events`, `source_event_object_classifications`, or `audit_events` privileges; application
and worker roles cannot execute the repair functions.

The claim function locks at most one allowlisted candidate with `SKIP LOCKED`. The worker verifies
the stored key/digest under provider/CSV size ceilings and a 15-second object-read deadline, applies
the exact production classifier, and calls a function that rechecks all immutable receipt identity,
enforces exact V1 provider/family compatibility, and atomically appends classification plus fixed
hash-chained audit evidence. Batches are limited to 100. Unsupported operational topics remain in
the total gap count and block completion.

For an existing cluster, provision the reviewed role definition from
`infra/postgres/init/001_roles.sql` through the approved platform role lifecycle before applying
0051; do not improvise a superuser or RLS-bypass repair identity. Apply 0051 only after backup/PITR
and disk/WAL/replica checks, old-writer drain, exact target binding, and a restored-data rehearsal.
The complete command and stop criteria are in the classification-repair runbook. Forward rollback
stops the command and leaves the functions, policies, role, append-only classifications, and audits
dormant. Never delete evidence or edit the migration ledger.

### Migration 0052 writer fence

Migration 0052 is transactional and additive. It creates one empty global activation table, a shared
advisory-lock trigger on source inserts, a deferred exact-classification constraint trigger, and
maintenance-only activation/status functions. It performs no backfill or activation. Normal writers
share the lock and do not block one another; the only exclusive lock is the explicit activation
transaction.

Apply 0052 while the fence is disabled, then deploy and inventory only classification-aware provider
and CSV writers. Drain old images, finish migration 0051 repair to zero total gaps, and rehearse
with the real prior/current images on restored representative data. Activation waits for in-flight
writers, rescans all operational rows under fixed cross-tenant authority, and appends one immutable
singleton only if every classification is compatible. Exact Shopify privacy topics are exempt.

Measure catalog-lock duration, added shared-lock latency, exclusive-lock wait, cross-tenant scan
time, WAL, replica lag, and current-writer error behavior with reviewed timeouts. Local synthetic
PostgreSQL evidence is not representative timing or a real prior-image rehearsal.

Forward rollback before activation may restore prior images while leaving 0052 dormant. After
activation, only a classification-aware image is compatible: the deferred trigger will roll back
old-writer transactions. There is no disable function or down migration. Keep the activation row,
triggers, classifications, and audit evidence intact; a future disable requires a separately
reviewed forward migration and recovery analysis.

## Privacy-package browser receipts

Migration 0050 is transactional and additive. It creates empty `provider_privacy_data_packages` and
`provider_privacy_data_package_receipts` tables with non-null tenant scope, tenant-composite
request/membership/package foreign keys, digest/byte/exact-ten-minute expiry checks, forced RLS,
append-only triggers, and one tenant-checked `SECURITY DEFINER` acknowledgement function. It
performs no backfill, package-byte persistence, financial-row scan, source-system call, or
reconciliation-rule change.

The application role can insert package authority and execute the fixed function but cannot read or
mutate either ledger or insert a receipt directly. The worker has no table/function authority.
Default privileges are explicitly revoked. Exact package acknowledgements serialize on a tenant/
package advisory lock, create one receipt, and return the original receipt on replay; unused
authority expires after ten minutes.

Apply 0050 before the receipt-aware API/web images. Prior images ignore the additive ledgers. New
images cannot safely prepare a package when 0050 is absent. Expected impact is brief catalog locks
and small empty-index creation; future storage is one small preparation row per generated package
and at most one receipt row. Verify a restorable backup, reviewed lock/statement timeouts,
restricted-role grants, forced RLS, cross-tenant/same-membership denial, exact retry, and audit
atomicity.

Forward rollback restores prior API/web images or disables the preparation control and leaves both
append-only ledgers dormant. Do not drop, update, delete, or rewrite receipt evidence. Expired token
digests grant no acknowledgement authority, but their preparation evidence remains. Source-defined
restricted-role PostgreSQL coverage is checked in; live migration/function/RLS/grant execution,
populated prior-release compatibility, representative timing, and mixed-image rehearsal remain
required when the database URLs are unavailable.
