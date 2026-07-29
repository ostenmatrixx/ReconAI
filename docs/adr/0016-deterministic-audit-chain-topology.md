# ADR 0016: Deterministic audit-chain topology

Status: accepted  
Date: 2026-07-28

## Context

Audit events carry a business `occurred_at` instant and a hash of the preceding event. The original
writer selected the predecessor by `occurred_at desc, id desc`. That is not a chain-order
definition: a late event with an older business instant can be appended without becoming the next
time-ordered candidate, and equal instants fall back to unrelated random UUID order. A later writer
can therefore reuse an already-consumed predecessor and fork the tenant chain.

The database already denies normal update/delete operations, but it did not require one tenant
genesis, one child per predecessor, a tenant-local predecessor, or a unique event digest. The
original hash also serialized a caller-shaped JavaScript object, so object insertion order prevented
portable recomputation. Existing audit rows must not be rewritten to conceal these weaknesses.

## Decision

- Chain topology is independent of business time. The current head is the sole tenant event that is
  not referenced by another event's `previous_event_hash`. `occurred_at` remains available for
  operator display and business chronology.
- The writer holds the existing organization advisory transaction lock, resolves at most two
  topological heads, and fails with `AuditChainIntegrityError` unless an empty tenant chain or
  exactly one head exists.
- Migration 0039 adds tenant-scoped unique indexes for event hashes and non-null predecessor hashes,
  a partial unique index allowing one genesis per tenant, a composite self-foreign key from
  `(organization_id, previous_event_hash)` to `(organization_id, event_hash)`, lowercase SHA-256
  format/self-reference checks, and bounded hash-version values. A `BEFORE INSERT` trigger takes the
  same tenant lock and requires each non-replay row to create the first genesis or extend the actual
  current head, preventing a multi-row statement from constructing a disconnected cycle.
- Before installing those controls, the migration scans all existing audit events. It aborts on a
  malformed or duplicate hash, forked predecessor, self-reference, missing/multiple genesis, orphan,
  unreachable event, or disconnected cycle. It never edits or synthesizes legacy audit evidence.
- Existing rows are labeled hash version 1. New repository-authored events use version 2, whose
  SHA-256 input has explicit fields, normalized UTC time, explicit nulls, a version domain, and
  recursively key-sorted JSON. Arrays retain order. Every authority field, tenant ID, predecessor,
  before/after value, reason, and version context is bound into the digest.
- The self-foreign key and unique predecessor index make a direct concurrent second child fail
  instead of creating a fork. The head-enforcing trigger covers direct and multi-row writers. The
  organization advisory lock serializes normal application and worker writers.
- Version 1 is preserved as historical evidence; no claim is made that arbitrary legacy caller
  object order can be reconstructed. Its topology, tenant binding, and immutability are still
  enforced after migration. Version 2 is canonically recomputable.

## Consequences

Late and equal-time events append deterministically without changing their business timestamps. Once
a valid tenant chain is constrained, insert-only activity cannot create a branch, orphan, second
genesis, cross-tenant link, self-cycle, or disconnected cycle. Corruption is surfaced as a failed
write or failed migration rather than silently hidden.

Migration 0039 scans the complete audit table multiple times and builds non-concurrent unique
indexes inside the migration transaction. It takes catalog/table locks and can block audit traffic.
Representative-volume timing, reviewed lock/statement timeouts, a verified backup, quiesced audit
writers, and an approved maintenance window are required before production use. A preflight failure
is an integrity incident: preserve the database and error evidence, stop audit-producing mutations,
and design a reviewed forward repair. Do not edit rows, disable the append-only trigger, or weaken a
constraint to complete the upgrade.

The migration does not move hash computation into PostgreSQL, add external anchoring, prove backup
integrity, or protect against a fully compromised database owner. Those are separate controls. The
application and worker database roles retain their existing insert authority.

## Alternatives

Ordering the head by event ID, insertion time, or `occurred_at` was rejected because none expresses
the existing predecessor graph. Rewriting legacy rows into a newly computed chain was rejected
because it would destroy append-only evidence and hide any historical fork. A global chain was
rejected because it couples tenants and leaks cross-tenant activity. A deferred self-foreign key was
rejected because insert-only append does not need forward references and immediate validation makes
cycles harder to construct. External transparency anchoring was deferred until its key custody,
availability, privacy, and recovery model is designed.

## Migration, rollback, and verification

Quiesce audit-producing API/worker traffic, verify backup/restore, apply 0039, deploy the compatible
writer, run topology and negative-role checks, then resume traffic. The new writer requires the
`hash_version` column. A prior image can read the additive column but may select a consumed
predecessor for a late event; the new uniqueness constraint will fail closed. Rollback therefore
stops audit-producing mutations and uses a forward code repair or the new writer while leaving 0039
in place. Do not drop constraints or down-migrate the ledger.

Synthetic verification covers canonical JSON/time hashing, field mutation, malformed predecessor
rejection, and migration preflight/control definitions. Environment-gated PostgreSQL tests cover
late and equal business times, two concurrent application writers, one remaining head, direct fork,
orphan, duplicate-genesis, self-link, cross-tenant predecessor, multi-row cycle, and owner-path
update rejection. Current live execution of migration 0039, populated upgrade timing, restore, and
external anchoring remain required.
