# ADR 0032: Bounded reconciliation run input persistence

- Status: Accepted
- Date: 2026-07-29

## Context

A reconciliation run may pin 100,000 immutable canonical record versions. Run creation previously
issued one `INSERT` for every `reconciliation_run_inputs` row. The transaction preserved
correctness, but maximum-size creation required 100,000 database executions before it could append
the outbox and audit authorities. That round-trip amplification is avoidable operational risk and
had no direct maximum-volume creation evidence.

The run, all pinned inputs, the first dispatch outbox event, and the request audit event must remain
one atomic tenant-scoped authority. Ordinals must retain the deterministic global input order, and
an exact repeated request must not duplicate any row or event.

## Decision

Build run-input insert values in deterministic batches of at most 1,000 rows. Every row has six
bound parameters—organization, run, record, record version, content hash, and ordinal—so a full
batch uses 6,000 parameters, below PostgreSQL's 65,535 parameter ceiling. The batch generator
assigns each row its original global ordinal rather than a batch-local ordinal.

Execute every batch inside the existing tenant transaction after the queued run insert and before
the outbox and audit inserts. Existing organization serialization, stable run identity, tenant
predicates, foreign keys, forced RLS, uniqueness constraints, and exact-repeat behavior remain
authoritative. A failure in any batch, outbox write, or audit write rolls back the complete run
authority.

The configured maximum remains 100,000 records. This change does not alter canonical selection,
input sorting, content hashing, policy capture, money, reconciliation rules, rule versions, worker
execution, or source-system access.

## Consequences

A maximum-size run now needs 100 input insert statements instead of 100,000 while retaining one
atomic transaction. The fixed 1,000-row ceiling bounds statement construction and makes the
parameter budget explicit and unit-testable. The API process still holds the complete canonical
snapshot and derived identities while creating a run, so this is not evidence of constant-memory
streaming or an API service-level objective.

No migration or backfill is required. Existing rows, indexes, append-only evidence, and rolling
deployment compatibility are unchanged.

## Alternatives considered

- Keep one insert per row: rejected because maximum-volume round trips scale linearly to 100,000
  executions without adding correctness.
- Insert all rows in one statement: rejected because 600,000 parameters exceed PostgreSQL's protocol
  limit and create an unnecessarily large statement.
- Commit each batch independently: rejected because a partial input ledger without matching run,
  dispatch, and audit authority would violate replay and evidence invariants.
- Use `COPY`: deferred because the current client transaction and typed row construction already
  provide bounded statements; adopting a separate bulk protocol adds operational and test surface
  without being necessary for the configured ceiling.

## Security, tenant, financial, and operational effects

All rows retain a non-null server-derived organization ID and are inserted by the restricted
application role under the existing tenant transaction and forced RLS policies. Exact foreign tenant
lookups remain concealed. No customer reference is needed by the verifier, and no raw payload,
credential, money mutation, approval, AI authority, or provider write is introduced.

Rollback restores the prior per-row insertion loop in application code. There is no schema or data
rollback.

## Verification

Focused unit tests prove `1,000/1,000/1` batching for 2,001 identities, fewer than 65,535 parameters
per statement, exact identity retention, global ordinal continuity, and no empty statement. The
existing fresh-PostgreSQL repository integration suite passed through the real batched SQL path.

A separate explicit-write-gated verifier used a fresh data-checksummed PostgreSQL 17.10 database,
all 44 migrations, 100,000 schema-valid synthetic canonical orders with content-matching SHA-256
identities, and the restricted non-superuser/non-`BYPASSRLS` `reconai_app` role. The actual
repository created one queued run with 100,000 unique continuous inputs, one outbox event, and one
audit event; an exact repeat returned the same authority without duplication. The PostgreSQL
statement log independently recorded exactly 100 run-input inserts. Foreign-tenant run and input
reads returned no result, both run tables had forced RLS, and offline checksums reported zero bad
blocks.

Evidence is recorded in
`artifacts/reconciliation-run-creation-maximum-volume-verification-2026-07-29.json`. The measured
2,694.99 ms repository call and memory observation are one local workstation sample, not an API SLO,
capacity guarantee, multi-host result, or production projection. The verifier did not execute the
worker or rules and omitted field-provenance rows to isolate run-authority creation.

A later fresh PostgreSQL 17.10 exercise added an explicit cross-batch negative. A verifier-only
trigger rejected ordinal 1,000 in the second input statement after the first statement executed.
SQLSTATE `23514` returned and database counts proved that the run, both input statements, outbox,
and audit had all rolled back. The trigger and function were then removed, the identical
deterministic 100,000-record snapshot created successfully in 100 input statements, exact repetition
created no duplicate authority, and offline checksums reported zero bad blocks. Evidence:
`artifacts/reconciliation-run-creation-atomic-rollback-verification-2026-07-29.json`. This does not
prove process loss, multi-host, or protected-staging behavior. Timeout and client-cancellation
controls and evidence are added by ADR 0033 without changing this batching decision.
