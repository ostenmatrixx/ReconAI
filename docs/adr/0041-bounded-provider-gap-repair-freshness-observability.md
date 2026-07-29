# ADR 0041: Bounded provider gap-repair freshness observability

- Status: Accepted
- Date: 2026-07-29

## Context

ReconAI's opt-in provider gap-repair scheduler already calls a migration-owned, worker-only function
that returns at most 100 due Shopify or Stripe connections, ordered by the effective freshness
reference. It then re-enters an organization-scoped transaction for each candidate and creates an
immutable sync-run/outbox authority only after repeating the tenant, connection, credential,
due-time, active-run, and envelope checks.

Existing telemetry recorded processed-event source lag but could not show whether the scheduled
correctness repair found overdue connections, whether a connection had ever completed a successful
sync, whether candidate creation lost a race, or whether the scan itself failed. Adding a separate
application scan for monitoring would duplicate privileged cross-tenant access and create new
completeness, ownership, and load risks. Exporting tenant, connection, timestamp, or
provider-account values would violate telemetry minimization.

## Decision

1. Reuse the existing `reconai_due_provider_gap_repairs` result as the only candidate-observation
   source. This change adds no query, database function, policy, role grant, or migration.
2. For each of the existing maximum 100 returned candidates, the database repository returns only:
   - fixed provider: `shopify` or `stripe`;
   - fixed freshness reference: `last_successful_sync` or `never_succeeded`;
   - fixed disposition after the tenant-scoped creation attempt: `scheduled` or `skipped`;
   - numeric age in seconds only when `last_successful_sync_at` exists.
3. Compute the age from the validated scheduler `now` and database timestamp inside the repository.
   Do not return organization ID, connection ID, account/shop, credential reference, source
   timestamp, cadence slot, run ID, or any other candidate field for telemetry.
4. Record `reconai.provider.gap_repair.scans` once per attempted scan with `succeeded`, `failed`, or
   defensive `invalid`. Successful empty scans remain a heartbeat. A failed scan is recorded before
   the original error is rethrown to the existing bounded scheduler error path.
5. Record `reconai.provider.gap_repair.candidates` once per returned candidate with only provider,
   freshness reference, disposition, and one age classification:
   - `observed`: finite age from zero through 365 days inclusive;
   - `future_timestamp`: negative age;
   - `outside_window`: age greater than 365 days;
   - `never_succeeded`: no successful sync timestamp exists;
   - `invalid_age`: inconsistent or non-finite input.
6. Record `reconai.provider.gap_repair.last_successful_sync_age` in seconds only for `observed`
   candidates. Future, invalid, never-succeeded, and over-window candidates never enter the
   histogram.
7. Defensively collapse unknown provider, reference, disposition, and scan values to fixed `invalid`
   values. Instrument at most the first 100 observations even if an alternate repository violates
   the internal result contract.
8. Keep structured scheduler logs to the existing aggregate `examined`, `scheduled`, and `skipped`
   counts. Candidate observations are not logged.
9. Retain worker delta temporality and the existing 256-series-per-instrument limit. Telemetry is
   lossy and non-authoritative; it never changes scheduling, tenant authority, provider requests,
   retry, dead-letter, readiness, reconciliation, or financial review.

## Consequences

Operators can distinguish a successful empty scheduler heartbeat from scan failure, see due
connections that have never completed a sync, and observe a bounded age distribution for due
connections with prior successful syncs. `scheduled` versus `skipped` distinguishes durable creation
from a recheck/race without exposing which tenant or connection was involved.

The defensive candidate counter has at most 135 series: three provider values, three reference
values, three dispositions, and five age outcomes. The histogram has at most nine provider/
disposition series. The scan counter has three series. All remain within the existing limit.

This is a bounded stream of due-candidate observations, not a complete gauge of every connection.
The scan returns at most 100 oldest due candidates, excludes connections with queued/running work,
and runs only when the gap-repair scheduler is enabled. Once a candidate is scheduled it ordinarily
disappears from the next due scan while active. A `never_succeeded` observation intentionally does
not expose connection creation age because the existing fixed function does not return it.

The signal does not prove provider completeness, a current per-object watermark, active-sync
progress, webhook delivery, or recovery success. Those require separate state and protected
deployment exercises.

## Alternatives considered

- Add a telemetry-only global connection scan: rejected because it would duplicate privileged
  cross-tenant access and require independent pagination, ownership, and completeness semantics.
- Return raw timestamps or candidate identifiers to the scheduler: rejected because only numeric age
  and fixed classifications are needed.
- Export organization, connection, shop/account, run, or credential dimensions: rejected as
  customer, secret-adjacent, or high-cardinality context.
- Export the bounded result count as total due backlog: rejected because the 100-row ceiling means
  the count is not a global total under saturation.
- Clamp negative or over-window ages into the histogram: rejected because that would fabricate a
  misleading numeric distribution.

## Security, tenant, financial, and operational effects

The existing worker-only `SECURITY DEFINER` candidate function and its organization-scoped creation
recheck are unchanged. The repository reduces candidate data to fixed values and a number before it
reaches telemetry. No customer identifier, raw timestamp, credential, payload, provider error,
amount, or currency becomes an attribute.

No migration, database permission, RLS policy, provider scope, provider request, source write, money
behavior, reconciliation rule/version, proposal state, audit history, durable envelope,
retry/dead-letter rule, readiness decision, or AI behavior changes. Rollback removes only the
candidate metadata from the repository result and the three metric records.

## Verification

Worker scheduler tests prove the bounded repository input and fixed, identifier-free candidate
result contract. PostgreSQL integration assertions cover two never-succeeded connections and one
prior successful sync with an exact numeric age when that suite is run.

The loopback OTLP/HTTP protobuf test observes all three instrument names, successful/failed/invalid
scan outcomes, the inclusive 365-day boundary, all five candidate age classifications, fixed
provider/reference/disposition values, and suppression of secret-like dynamic values.

Evidence is recorded in
`artifacts/provider-gap-repair-freshness-observability-verification-2026-07-29.json`. This is local
bounded due-candidate evidence, not a complete connection inventory, per-object provider watermark,
active-sync health, protected collector/backend, threshold, alert-delivery, staging, or production
result.
