# ADR 0034: Prompt run-creation deadline settlement

- Status: Accepted
- Date: 2026-07-29

## Context

ADR 0033 starts the reconciliation run-authority deadline before database-pool admission and sends
the same abort signal through every admitted query and between every authority-creation stage. That
prevents an expired pool-queued request from later creating authority. postgres.js does not expose
cancellation for a queued pool acquisition, however, so the repository originally awaited the driver
promise until capacity returned before emitting its retry-safe error.

A fresh maximum-volume saturation diagnostic held both connections in a two-connection application
pool. The 5,000 ms authority deadline expired, but the repository stayed pending until the verifier
released capacity after 5,500 ms. No authority was created, so correctness held, but response
settlement was unnecessarily coupled to pool recovery.

The response boundary must be prompt without turning the still-queued operation into unobserved work
that can create partial authority.

## Decision

Keep the existing deadline, combined caller signal, transaction-local statement backstop, direct
query cancellation, and between-stage checks. Add a constrained settlement race:

1. Reject a request whose signal is already aborted before scheduling its tenant transaction.
2. Start the tenant transaction with the same combined abort signal.
3. Observe both the transaction promise and the abort signal. If the signal wins, settle the
   repository call immediately with `RepositoryRunCreationUnavailableError`.
4. Continue observing the non-cancellable transaction promise so a later rejection cannot become an
   unhandled process error.
5. When pool capacity returns, the queued transaction establishes tenant context and checks the
   already-aborted signal before any run-authority query. If interruption races the final commit,
   the existing zero-or-one-complete ambiguous-commit contract and stable-key retry apply.

This is not the unguarded `Promise.race` rejected by ADR 0033: the background transaction is bound
to the same abort signal, direct queries remain cancellable, and every authority stage remains
inside one tenant transaction.

## Consequences

Repository and API orchestration can emit the fixed retry-safe `503` at the configured authority
deadline even when the postgres.js pool is fully occupied. Returning the response does not cancel
the queued driver acquisition. It drains after capacity returns and must remain observed, bounded by
shared request admission, and covered by pool queue/latency monitoring.

The response may still be delayed by event-loop starvation, edge behavior, or network delivery, so
this is not an end-to-end API SLO. Real client loss also remains an ambiguous-commit boundary: a
fully committed immutable authority is valid even if the caller receives a retryable error. Exact
retry returns that authority rather than duplicating it.

No schema, migration, tenant, permission, money, rule, worker, or provider behavior changes.
Rollback removes the settlement helper while retaining the compatible deadline and transaction
controls from ADR 0033.

## Alternatives considered

- Continue waiting for pool recovery: rejected because a configured authority deadline should not
  unnecessarily delay the safe public error.
- Unguarded `Promise.race`: rejected because an operation without the shared abort controls could
  create authority after timeout.
- Terminate or replace postgres.js connections: rejected because pool admission has no supported
  per-request cancellation primitive and forced disconnect can destabilize in-flight work.
- Treat the deadline as an end-to-end SLO: rejected because the repository does not control event
  loop scheduling, ingress, proxy, or network latency.

## Security, tenant, financial, and operational effects

The membership-derived `TenantContext`, explicit tenant predicates, forced RLS, advisory lock,
stable run key, and atomic run/input/outbox/audit transaction remain unchanged. The helper exposes
no SQL, identifier, pool state, or database detail. The queued promise is always observed.

Operators still need shared Redis request admission, bounded pool sizing, pool saturation metrics,
an edge timeout longer than the authority deadline, and protected-staging load evidence. A prompt
error reduces caller resource retention; it does not make an unbounded internal driver queue safe.

## Verification

Unit tests prove signal-first settlement while the underlying operation completes later, successful
operation settlement, and harmless abort after completion. Existing API tests continue to prove the
fixed safe `503`.

An explicit-write-gated fresh PostgreSQL 17.10 verifier applied all 44 migrations, seeded 100,000
valid synthetic canonical records, and occupied both connections in the restricted application's
two-connection pool with independently observed idle transactions. The repository returned
`RepositoryRunCreationUnavailableError` after 5,002.55 ms while both holders remained occupied. Only
then did the verifier release capacity, drain the expired operation, and confirm zero run, input,
outbox, or audit rows. The same database subsequently replayed later-batch process loss, identical
retry recovery, and two-process advisory-lock contention before clean offline checksums.

Evidence is recorded in
`artifacts/reconciliation-run-creation-pool-saturation-verification-2026-07-29.json`. The timing is
one local workstation observation, not a production latency or capacity claim.
