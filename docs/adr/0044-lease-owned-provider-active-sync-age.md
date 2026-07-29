# ADR 0044: Lease-owned provider active-sync age

- Status: Accepted
- Date: 2026-07-29

## Context

ReconAI records source-to-normalization lag for newly processed provider events and the
last-successful-sync age of bounded due gap-repair candidates. Neither signal shows a provider sync
that has already been created but remains queued or running. The gap-repair scan deliberately
excludes those connections, so a stuck active sync can also suppress new repair scheduling without
appearing in its candidate telemetry.

Emitting timing only from a tenant API request would miss unattended work and bias the result toward
active operators. Scanning every active run or exporting one series per tenant/connection/run would
create unbounded work and customer-identifying cardinality. The existing operational monitor already
elects one worker replica with an environment/queue-scoped Redis lease and expires process-local
snapshots when ownership is lost.

`provider_sync_runs` is tenant-owned and protected by forced row-level security. A bounded
environment-wide observer therefore requires a fixed cross-tenant authority. Its existing
tenant-first index cannot efficiently find the oldest active run for each provider.

## Decision

1. Define an active provider sync as a `provider_sync_runs` row with status `queued` or `running`.
   Terminal `partial`, `succeeded`, and `failed` rows are excluded.
2. Measure age from immutable `created_at`, not `started_at` or mutable `updated_at`. This covers
   the total time awaiting or receiving service and does not reset on page progress or retry.
3. Observe Shopify and Stripe separately because provider is a fixed two-value operational
   dimension. Return exactly one row for each provider:
   - `empty`, with no status or age; or
   - `active`, with fixed status `queued` or `running` and a numeric database-computed age.
4. Add a partial `(provider, created_at, id)` index over exactly `queued` and `running`. Build it
   online with `CREATE INDEX CONCURRENTLY IF NOT EXISTS`.
5. Use the existing non-transactional migration path, which is restricted statically and at runtime
   to one named concurrent/idempotent index statement. Require PostgreSQL to report the index both
   ready and valid before recording migration 0046.
6. Add a separate transactional migration with a fixed `SECURITY DEFINER`, `row_security=on`,
   fixed-search-path function. It performs two provider-keyed lateral index lookups and hydrates at
   most one active row per provider.
7. Return no organization, connection, run, requester, correlation, window, cursor, error, count,
   timestamp, object, account/shop, credential, money, or currency field. Revoke execution from
   `PUBLIC` and the application role; grant it only to the worker role.
8. Reuse the durable-queue monitor lease. Followers do not call the function. The lease owner
   refreshes one atomic two-provider process snapshot with the lease TTL.
9. Export:
   - `reconai.provider.sync.active.monitor.polls`, with only `empty`, `observed`,
     `future_timestamp`, `invalid_age`, or `failed`;
   - `reconai.provider.sync.active.has_active`, a provider-only gauge with `0` or `1`; and
   - `reconai.provider.sync.active.oldest_age`, a gauge emitted only for active providers with fixed
     provider and `queued`/`running` status.
10. A malformed, incomplete, duplicate, reversed, future, non-finite, failed, expired, follower, or
    shutdown observation clears the whole provider snapshot. Do not publish a partial provider view
    or fabricate healthy zeros.
11. Keep telemetry non-authoritative. It cannot change sync state, retry/dead-letter behavior,
    provider calls, queue ownership, readiness, connection health, reconciliation, financial data,
    review decisions, or AI behavior.

## Consequences

Operators can distinguish an old queued sync from an old running sync for Shopify or Stripe without
learning which tenant or connection owns it. Successful empty observations publish presence zero for
both providers; the age gauge is absent when a provider has no active sync. Failure removes both
provider series, so a stale leader cannot indefinitely report health after lease loss.

The function returns exactly two rows and hydrates at most two indexed active rows. It does not
count active syncs, prove provider delivery or per-object completeness, report page progress, show
last successful recovery, identify the affected tenant, or establish a threshold/SLO.
Tenant-authorized connection and sync-run views remain the investigation boundary.

The initial partial-index build performs an O(N) concurrent scan and consumes I/O, CPU, temporary
and final disk, WAL, and replica capacity. Start/finalization locks are brief but can wait behind
conflicting DDL. The build requires representative staging timing, disk and replica review,
restorable backup, and approved lock/statement timeouts before production.

The index command and migration ledger cannot be atomic. The global advisory lock plus catalog
ready/valid checks make a crash after valid creation and before ledger insertion rerunnable. A
failed build can leave an invalid same-named index; the runner leaves 0046 unapplied. Operators must
preserve the error/catalog evidence and use a reviewed forward repair to remove only the confirmed
invalid index before retrying.

## Alternatives considered

- Emit from sync-run API requests: rejected because unattended work would remain invisible and
  tenant activity would bias observations.
- Emit only from worker start/page/finish transitions: rejected because a queued run that never
  starts and a process lost between transitions need a current gauge rather than an at-most-once
  event sample.
- Reuse scheduled gap-repair candidates: rejected because that query intentionally excludes
  connections with queued or running syncs.
- Export a series per tenant, connection, or run: rejected because those values are customer context
  and unbounded cardinality.
- Return the oldest run identifier to the worker: rejected because it is unnecessary for aggregate
  telemetry.
- Count every active run: rejected because detecting age and state requires only the first indexed
  row per fixed provider.
- Use `started_at`: rejected because queued delay would disappear and retry/page activity could be
  misread as total time to service.
- Add a separate lease: rejected because the existing operational lease already provides one owner
  and an expiring lifecycle.

## Security, tenant, financial, migration, and operational effects

The migration-owned function is the only new cross-tenant read boundary. It has no parameters, uses
fixed providers/states/order/limit, and returns only bounded operational classification plus numeric
age. Normal worker and application table reads remain tenant-RLS scoped; the application role cannot
execute the function.

No customer row, connector credential, provider scope/request, source record, object key,
reconciliation artifact, money value, rule/version, review state, audit event, durable envelope,
retry/dead-letter policy, retention behavior, readiness decision, or AI flag changes. Prior workers
ignore the additive index/function. Apply migrations 0046 and 0047 before the new worker. Forward
rollback restores the prior worker and leaves both migrations dormant; never drop them while a new
observer may still run.

Before production, verify empty and populated upgrades, interrupted/resumed index creation,
restricted application/worker behavior, representative active/terminal distributions, query/index
plans, disk/WAL/replica impact, mixed-image operation, protected collector behavior, thresholds,
silence rules, alert delivery, and tenant-authorized investigation.

## Verification

Static migration tests require the non-transactional marker, named concurrent/idempotent partial
index, exact active predicate, fixed two-provider function, row-security-on fixed search path,
per-provider ordered limit-one lookup, worker-only grant, and absence of customer/financial return
fields.

Repository tests accept only ordered Shopify/Stripe empty-or-active results and reject missing,
duplicate, reversed, inconsistent, dynamic, non-finite, zero-row, and multi-row results. Worker
tests prove only the Redis lease owner reads the function, followers are read-free, database failure
propagates, stale state clears, and scheduled execution remains single-flight.

The loopback OTLP/HTTP protobuf test observes all three instruments, all five fixed outcomes, both
provider/status values, and secret-like dynamic-value suppression. PostgreSQL integration assertions
are defined to prove queued-to-running-to-empty transitions, nonnegative age, direct unscoped worker
table denial, and application-role function denial; they require the integration environment.

Evidence is recorded in
`artifacts/provider-active-sync-age-observability-verification-2026-07-29.json`. This is local
source/unit/OTLP evidence unless that artifact explicitly records a live PostgreSQL result. It is
not a protected collector, dashboard, threshold, alert-delivery, representative-volume index build,
staging, provider-sandbox, or production result.
