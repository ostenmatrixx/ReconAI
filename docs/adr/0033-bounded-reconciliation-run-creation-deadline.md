# ADR 0033: Bounded reconciliation run creation deadline

- Status: Accepted
- Date: 2026-07-29

## Context

ADR 0032 reduced a maximum 100,000-input run from 100,000 input statements to 100 while retaining
one tenant transaction for the queued run, every pinned input, the first outbox dispatch, and the
request audit event. The transaction makes a database error atomic, but run creation still had no
explicit operational deadline and did not react to a disconnected API client. A blocked advisory
lock or later input statement could therefore hold resources after the caller no longer needed the
request.

The control must never turn timeout into a partial authority. It must preserve deterministic retry,
return no database detail, remain bounded in configuration, and cover an interruption after at least
one input batch has executed.

PostgreSQL 17 also provides `transaction_timeout`, but expiry is a `FATAL` session termination. A
local exploratory maximum-volume run confirmed database rollback but exposed a postgres.js 3.4.9
write-after-disconnect `TypeError` while the client was flushing a large prepared write. A control
that can crash the API process is not acceptable.

## Decision

Add `RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS`, validated as an integer from 5,000 through 120,000
milliseconds and defaulted to 30,000. The repository validates the same bounds even when constructed
outside the runtime configuration path.

For each `startRun` call:

1. Start an application authority deadline before database-pool admission.
2. Combine it with the caller's optional `AbortSignal`.
3. Once the tenant transaction is admitted, set a transaction-local PostgreSQL `statement_timeout`
   to the same bounded value.
4. Attach cancellation to every direct run-creation query and check the signal between canonical
   parsing, identity calculation, input batches, outbox insertion, and audit insertion.
5. Let any interruption throw out of the existing tenant transaction so the queued run, every input,
   outbox event, and audit event roll back together.

The API binds the repository signal to the request's `aborted` event. Repository cancellation and
PostgreSQL cancellation/timeout SQLSTATEs are reduced to `RepositoryRunCreationUnavailableError`;
the public response is a retryable `503` with the fixed code
`RECONCILIATION_RUN_CREATION_UNAVAILABLE`, fixed safe message, and correlation ID.

The application deadline is the whole run-authority budget, while transaction-local
`statement_timeout` is the blocked-statement backstop. PostgreSQL `transaction_timeout` is
deliberately not set.

## Consequences

An expired request waiting for a pool connection cannot later create authority: after admission, the
already-aborted signal fails the transaction. postgres.js pool acquisition and response completion
are not themselves cancellable, however, so this is not an end-to-end API latency guarantee.
Synchronous canonical parsing and hashing cannot be preempted mid-instruction, but the next
cancellation check or query prevents commit.

Query cancellation preserves the database session rather than relying on a `FATAL` disconnect. Exact
retry remains safe because stable run identity and the existing transaction/uniqueness controls are
unchanged. No schema, money, rule, worker, tenant, permission, or provider behavior changes.

Operators must choose the deadline from protected-staging maximum-volume measurements and keep the
edge timeout longer. The bounded range prevents both an effectively disabled control and an
unreviewed multi-minute authority transaction.

## Alternatives considered

- PostgreSQL 17 `transaction_timeout`: rejected because expiry terminates the session and the
  current driver can fail unsafely while a large prepared write is in flight.
- Per-statement timeout only: rejected because 100 individually bounded input statements would not
  provide one whole-operation authority budget.
- `Promise.race` around an uncancelled transaction: rejected because the background transaction
  could still commit after the caller receives a timeout.
- Independent commits per input batch: rejected because they would create partial financial
  authority.
- No timeout and rely on edge disconnect: rejected because an edge response deadline does not cancel
  database work.

## Security, tenant, financial, and operational effects

The membership-derived `TenantContext`, explicit organization predicates, tenant transaction, forced
RLS, advisory serialization, stable identity, and append-only outbox/audit evidence remain
unchanged. The abort signal grants no authority and carries no tenant data. Public errors expose no
SQLSTATE, query, table, identifier, or database message.

No migration or backfill is required. Rollback deploys the prior compatible API code; existing run
authority is unchanged. Temporarily raising the value within the validated range is an operational
mitigation, not evidence that a larger value is safe.

## Verification

Unit coverage proves default/minimum/maximum repository and runtime-config bounds, rejects
fractional/out-of-range values, verifies API propagation of an `AbortSignal`, and verifies the fixed
`503` response omits PostgreSQL details.

An explicit-write-gated verifier then used a fresh data-checksummed PostgreSQL 17.10 database, all
44 migrations, 100,000 schema-valid synthetic canonical orders, and the restricted non-superuser,
non-`BYPASSRLS` application role. A verifier-only trigger delayed ordinal 1,000 in the second input
statement:

- the 5,000 ms application deadline interrupted it after 5,006.20 ms and left zero run, input,
  outbox, and audit rows;
- a distinct run reached the same delayed second statement, PostgreSQL activity proved that point,
  and an explicit client `AbortSignal` interrupted it after 1,380.03 ms with the same zero-row
  result;
- PostgreSQL logged two input executes for each interrupted attempt, both as ordinary user-request
  cancellations, with no `FATAL` event;
- after verifier objects were removed, the identical deterministic snapshot created one complete
  100,000-input authority in 100 statements and exact repetition created no duplicate authority;
- foreign-tenant reads returned no result, both run tables retained forced RLS, and offline
  checksums found zero bad blocks.

Evidence is recorded in
`artifacts/reconciliation-run-creation-interruption-verification-2026-07-29.json`. The timing is one
local workstation observation, not an API SLO or production projection. Real ingress disconnect,
pool saturation, process termination, multi-host contention, protected staging, alert delivery, and
worker execution remain outside this proof.
