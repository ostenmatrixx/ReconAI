# ADR 0043: Lease-owned unresolved exception-queue age

- Status: Accepted
- Date: 2026-07-29

## Context

ReconAI records proposal-decision and final-approved-resolution ages, but those event samples cannot
show whether unresolved exceptions are accumulating or how old the worst outstanding exception is.
Emitting a value only when an operator loads a tenant queue would bias the signal toward active
tenants, stay silent for unattended backlogs, and create inconsistent multi-replica observations.

Customer-owned exceptions are protected by forced row-level security. An environment-wide backlog
observer therefore needs a narrowly defined cross-tenant authority, must not export tenant or
exception identifiers, and must avoid scanning or hydrating every unresolved row. The existing
durable-queue monitor already elects one worker replica with an environment/queue-scoped Redis
lease, expires process-local snapshots when ownership is lost, and performs fixed-size reads.

The current tenant-first queue index cannot efficiently find the oldest unresolved exception across
an environment. A new partial index is necessary, but building a normal index inside the
transactional migration runner could block exception writes for the full table scan.

## Decision

1. Define unresolved exception states as `open`, `assigned`, `deferred`, `proposed`, and legacy
   `rejected`. Exclude `approved` because it is reviewer-final and `superseded` because it is absent
   from the current authoritative source snapshot until reobserved.
2. Add a partial `(created_at, id)` index over exactly those unresolved states. Build it with
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS` so ordinary exception writes can continue during the
   table/index scan.
3. Add one explicit `-- reconai:non-transactional` migration-runner path. Restrict it statically and
   at runtime to exactly one named `CREATE INDEX CONCURRENTLY IF NOT EXISTS` statement. All other
   migrations remain transactional.
4. After the index command, require PostgreSQL to report exactly one same-named `public` index with
   both `indisready` and `indisvalid` true before recording the migration checksum. If the process
   exits after the valid index exists but before the ledger insert, the same checksum reruns the
   idempotent command, validates the index, and then records the ledger. A failed concurrent build
   can leave an invalid same-named index; the runner detects that state and leaves the migration
   unapplied instead of treating `IF NOT EXISTS` as success. The global migration advisory lock
   remains held throughout.
5. Add a separate transactional migration containing a fixed `SECURITY DEFINER`, `row_security=on`,
   fixed-search-path function. It returns exactly one of:
   - `empty` with no age; or
   - `nonempty` with a numeric database-computed age in seconds.
6. Return no organization, exception, stable key, status, severity, type, timestamp, record
   reference, evidence, assignee, money, or currency field. Revoke execution from `PUBLIC` and the
   application role; grant it only to the worker role.
7. Reuse the durable-queue monitor lease. A follower does not call the database function and clears
   any process-local exception snapshot. The leader refreshes the exception snapshot with the same
   bounded lease TTL. Shutdown, ownership loss, Redis/queue inspection failure, database failure,
   malformed results, and expiration clear the snapshot.
8. Export three instruments:
   - `reconai.review.exception_queue.monitor.polls`, a counter with only `empty`, `observed`,
     `future_timestamp`, `invalid_age`, or `failed`;
   - `reconai.review.exception_queue.has_unresolved`, an attribute-free observable gauge with `0` or
     `1`;
   - `reconai.review.exception_queue.oldest_age`, an attribute-free observable gauge in seconds,
     with `0` only for a successfully observed empty queue.
9. Never clamp a future, malformed, non-finite, or inconsistent age into the gauges. Those outcomes
   clear the snapshot and remain visible only through the fixed poll classification.
10. Keep telemetry non-authoritative. It cannot change exception state, review decisions,
    reconciliation, financial values, retries, readiness, or queue ownership.

## Consequences

Operators gain a current, environment-wide oldest-unresolved age that does not depend on an operator
opening a tenant page. The attribute-free gauges each have one series; the monitor counter has at
most five. Tenant and financial context never reaches telemetry.

The query hydrates at most one indexed row and returns only fixed state plus numeric age. PostgreSQL
still performs an initial O(N) concurrent index scan. That build consumes I/O, CPU, temporary disk,
and final index disk, and briefly acquires locks during its start/finalization phases. Conflicting
DDL can wait. It must be timed with representative data and reviewed lock/statement timeouts in
staging before production.

The migration ledger and concurrent index cannot be one atomic transaction. Idempotent
`IF NOT EXISTS`, the migration advisory lock, post-command catalog validation, and
checksum-before-skip behavior make the valid-index crash window resumable without changing an
applied migration. A failed or invalid concurrent build is deliberately not self-healed: it requires
operator inspection and a reviewed forward repair to remove the invalid index before retrying. Never
delete a valid checksum row or manually pretend the migration completed.

The gauge is environment-wide and deliberately has no tenant dimension. An alert indicates that an
authorized operator must investigate through tenant-scoped product/support views; telemetry alone
cannot identify the affected tenant. It does not report unresolved count, severity mix, reviewer
productivity, or resolution accuracy.

## Alternatives considered

- Emit on exception-list API requests: rejected because unattended tenants and silent backlogs would
  have no observation, while busy tenants would be overrepresented.
- Export one series per organization: rejected because tenant identity is customer context and
  produces unbounded cardinality.
- Return the oldest exception or organization identifier to the worker: rejected because neither is
  needed to calculate the aggregate gauge.
- Count or scan every unresolved exception: rejected because age requires only the first row from an
  ordered partial index; a full count would add work without satisfying the immediate signal.
- Build the index transactionally: rejected because a populated exception table would block writes
  for the index build.
- Add a second independent lease: rejected because the existing environment/queue lease already
  provides one owner and an expiring lifecycle for operational snapshots.

## Security, tenant, financial, migration, and operational effects

The migration-owned function is the only new cross-tenant read boundary. Its return shape is
identifier-free and its fixed query cannot be influenced by a client. Normal worker and application
table reads remain subject to tenant RLS; the application role cannot execute the function. The
function owner receives a narrowly named select policy required for the fixed query.

No table row, money value, reconciliation rule/version, review transition, approval threshold, audit
event, provider scope, source-system record, object, durable envelope, retry/dead-letter rule,
readiness decision, or AI behavior changes. Older worker images ignore the additive index/function.
Forward rollback restores the prior worker and leaves both migrations dormant; do not drop an index
while a new observer may still be running.

Before production, verify a restorable backup, available index disk, representative scan duration,
replica impact, lock and statement timeouts, migration interruption/resumption, prior/new-image
compatibility, and protected collector behavior.

## Verification

Static migration tests require the non-transactional marker, concurrent/idempotent named index,
fixed partial predicate, restricted runner/validator path, catalog ready/valid checks before the
ledger insert, worker-only function grant, row-security-on fixed search path, one-row limit, and
absence of customer/financial return fields.

Repository unit tests accept only consistent `empty` or numeric `nonempty` results and reject
dynamic, non-finite, inconsistent, zero-row, and multi-row results. Worker tests prove only the
Redis lease owner calls the repository, followers are read-free, repository failure propagates, and
scheduled execution remains single-flight.

The loopback OTLP/HTTP protobuf test observes all three instruments, all five fixed outcomes, an
expiring nonempty snapshot, and secret-like dynamic state suppression. Restricted-role PostgreSQL
assertions are defined to prove that reconciliation creates a visible aggregate while direct
unscoped worker reads remain empty and the application role cannot execute the function; those
assertions require the integration environment.

Evidence is recorded in
`artifacts/unresolved-exception-queue-age-observability-verification-2026-07-29.json`. This is local
source/unit/OTLP evidence unless the artifact explicitly records a live PostgreSQL result. It is not
a protected collector, threshold, dashboard, alert-delivery, representative index-build, staging, or
production result.
