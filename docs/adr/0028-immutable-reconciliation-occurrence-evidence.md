# ADR 0028: Immutable reconciliation occurrence evidence

- Status: Accepted
- Date: 2026-07-29

## Context

`matches` and `exceptions` are stable workflow artifacts. Their occurrence tables identify the runs
that observed them, while later authoritative runs may legitimately update the current exception
status and evidence. Reading the current artifact through an old occurrence therefore cannot prove
the exact rule evidence that the old run observed. Presenting that projection as historical evidence
would overstate the audit record.

The change must remain compatible with older workers during a rolling deployment. It must not
rewrite existing artifacts, infer historical facts that were never stored, alter deterministic rule
behavior, or grant the application role financial mutation authority.

## Decision

Add `match_occurrence_snapshots` and `exception_occurrence_snapshots`, keyed by the existing
tenant/run/artifact occurrence identity. A new worker inserts `artifact-occurrence-v1` snapshots in
the same tenant transaction as the occurrence and verifies exact equality on idempotent replay.
Snapshot disagreement fails closed as `RUN_ARTIFACT_SNAPSHOT_CONFLICT`.

The snapshots preserve the observed rule/type/version, record references, evidence, capture time,
and, for exceptions, observed status, severity, and optional money context. They are forced-RLS,
tenant-bound, append-only, application-read-only, and worker-insert-only. Stable artifacts remain
the workflow identity; snapshots are the immutable observation evidence.

The run-detail API returns at most ten matches and ten exceptions. Rows with a snapshot are labeled
`exact_at_observation`. An occurrence written by an older worker without a snapshot is returned only
as `legacy_current_projection`; the operator interface warns that it is not immutable historical
evidence. Current exception workflow status is shown separately from observed status. The BFF
rejects upstream JSON responses above five MiB.

No automatic backfill is performed. The current artifact may have changed, so reconstructing an
exact old observation would manufacture evidence. Pagination beyond the bounded preview is deferred.

## Consequences

New runs written by new workers have exact, replay-safe evidence that remains independent from later
workflow updates. Foreign-tenant identifiers continue to resolve as not found under server-derived
tenant context and forced RLS. The change does not modify money, currency, approvals, source
systems, AI authority, engine `0.6.0`, or rule set `1.4.0`.

During the rolling window an old worker may still create a valid occurrence without a snapshot. This
is deliberately visible and honestly labeled. Operators cannot retrieve more than the bounded
preview until server-side artifact pagination is implemented.

## Alternatives

Joining occurrences directly to current artifacts was rejected because it can misstate old evidence.
Copying evidence into the existing occurrence tables was rejected because it would require a riskier
rewrite and compatibility change. Backfilling from current artifacts was rejected because the result
cannot be proven historical. Versioning the reconciliation rules was rejected because deterministic
classification behavior did not change.

## Migration, rollout, rollback, and verification

Migration 0043 is additive: it creates two empty tables, indexes, constraints, forced-RLS policies,
append-only triggers, and least-privilege grants. It performs no occurrence-table scan, backfill, or
existing-row rewrite; expected impact is short catalog locking plus new empty relation/index
creation. Verify a current backup and replication health before applying it, record checksum and
duration, and inspect the new tables, policies, triggers, grants, and missing-snapshot counts.

Roll out in this order: migration, new workers, then API and web. Drain old workers and retain the
compatibility window until both missing-snapshot queries remain zero for all runs created after the
new-worker cutover:

```sql
SELECT count(*)
FROM match_occurrences AS occurrence
LEFT JOIN match_occurrence_snapshots AS snapshot
  USING (organization_id, run_id, match_id)
WHERE occurrence.observed_at >= $1
  AND snapshot.match_id IS NULL;

SELECT count(*)
FROM exception_occurrences AS occurrence
LEFT JOIN exception_occurrence_snapshots AS snapshot
  USING (organization_id, run_id, exception_id)
WHERE occurrence.observed_at >= $1
  AND snapshot.exception_id IS NULL;
```

Application and worker images may be rolled back while the additive tables remain. Do not drop or
down-migrate the snapshot tables during rollback. Stop the new worker image and preserve database
evidence if snapshot conflicts occur; recovery is a reviewed forward fix. A later contraction may
remove legacy compatibility only after old workers are drained, the observation window is complete,
and the monitored queries are zero.

Verification covers migration/upgrade integrity, exact replay conflict checks, append-only role
denial, cross-tenant RLS denial, bounded exact/legacy API projection, BFF response limits,
browser/accessibility rendering, and mobile containment. Local evidence is recorded in
`artifacts/reconciliation-operator-evidence-verification-2026-07-29.json`. A separate checked-in
local verifier completed one continuous Chromium-to-worker split execution and read exact snapshots,
including the three-record accounting-split occurrence; evidence is in
`artifacts/reconciliation-continuous-split-journey-verification-2026-07-29.json`. Staging rollout,
representative concurrency/load, pagination, and alert behavior remain required.
