# ADR 0035: Bounded run-creation admission

- Status: Accepted
- Date: 2026-07-29

## Context

ADR 0033 bounds one reconciliation run-authority transaction, and ADR 0034 returns its retry-safe
error promptly even when postgres.js is still waiting for pool capacity. The driver does not expose
cancellation for pool acquisition. A burst can therefore create many already-expired operations
inside one API process unless admission is bounded before the driver promise is constructed.

Releasing capacity when the public repository promise settles is also unsafe. A deadline may settle
that promise while the signal-guarded database operation remains queued. Reusing its capacity token
would admit more hidden operations and reconstruct the same unbounded queue.

## Decision

Add a fail-fast, process-local admission gate specifically for reconciliation run-authority
transactions:

1. `RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS` is an integer from 1 through 10 and defaults to
   2 per API process.
2. Acquire one slot before constructing the postgres.js tenant-transaction promise.
3. If no slot is available, return the same fixed
   `RepositoryRunCreationUnavailableError`/`RECONCILIATION_RUN_CREATION_UNAVAILABLE` response
   without invoking the database operation.
4. Retain the slot until the underlying database promise settles, even when the public caller has
   already received a deadline or disconnect response.
5. Release each slot exactly once after success or failure. Synchronous operation-construction
   failure also releases it.

The gate bounds heavyweight database operations, not authenticated request volume. The existing
shared Redis request limiter remains the cross-replica outer admission control. The deployment-wide
maximum for this path is the configured per-process cap multiplied by live API replicas, so replica
count and PostgreSQL capacity must be planned together.

## Consequences

One process can no longer enqueue an unbounded number of run-authority transactions inside
postgres.js. Excess attempts fail immediately with a retry-safe response. Normal API reads retain
database-pool headroom under the default cap.

The gate is intentionally not a fairness scheduler and maintains no waiting queue. Callers retry
with bounded backoff; the stable run key converges exact retries if an earlier ambiguous request
committed. Process-local admission alone does not coordinate replicas, guarantee throughput, or
replace pool, rejection, latency, and database-capacity telemetry.

No schema, migration, tenant, permission, money, rule, worker, or provider behavior changes.
Rollback removes the gate and configuration while retaining ADR 0033/0034 correctness controls.

## Alternatives considered

- Let postgres.js queue every request: rejected because pool acquisition is non-cancellable and the
  queue has no product-level capacity contract.
- Release on public deadline settlement: rejected because the hidden queued operation still consumes
  future database capacity.
- Add a process-local waiting queue: rejected because it adds latency and memory without providing
  cross-replica fairness; fail-fast retry is simpler and bounded.
- Use a distributed Redis semaphore as financial authority: rejected because Redis must not become
  authoritative for database atomicity and lease-expiry recovery would introduce a second
  correctness protocol. Redis remains outer request admission only.
- Set the cap equal to every database connection: rejected as a default because heavyweight writes
  must leave headroom for authorization, readiness, and read paths.

## Security, tenant, financial, and operational effects

Membership-derived `TenantContext`, forced RLS, explicit tenant predicates, the organization
advisory lock, stable run identity, and the atomic run/input/outbox/audit transaction remain
unchanged. Admission state contains only a process-local count and exposes no tenant, financial,
request, SQL, or pool detail.

Operators must select the cap with protected load evidence, keep the total across replicas within
PostgreSQL capacity, retain the shared Redis request limiter, and alert on rejection rate, pool
wait, transaction latency, and replica count. A rejection is availability backpressure, never
financial approval or a source-system write.

## Verification

Unit tests validate the 1–10 configuration range, fail-fast non-invocation, exactly-once release,
and retention of a slot after public interruption until the hidden operation settles.

An explicit-write-gated fresh PostgreSQL 17.10 verifier applied all 44 migrations, seeded 100,000
valid synthetic canonical records, and occupied both connections in a two-connection restricted
application pool. Exactly two run transactions were admitted and returned the retry-safe error after
5,001.93 and 5,002.10 ms. While they remained hidden in the driver, 32 additional requests were all
rejected in 0.28 ms without database admission. A further attempt after both public deadlines was
rejected in 0.21 ms, proving the hidden operations retained both slots. Only then did the verifier
release pool capacity; both expired operations drained and left zero run, input, outbox, or audit
rows. Process-loss recovery and two-process advisory-lock contention regressions also passed, and
offline checksums reported zero bad blocks.

Evidence is recorded in
`artifacts/reconciliation-run-creation-admission-pressure-verification-2026-07-29.json`. These are
single-host local observations, not an API SLO, sustained-load result, or multi-replica capacity
claim.
