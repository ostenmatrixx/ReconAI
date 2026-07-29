# ADR 0051: Bounded source-event classification repair

- Status: Accepted
- Date: 2026-07-29
- Extends: ADR 0047

## Context

ADR 0047 deliberately left pre-classifier source receipts unclassified. Inferring families in
migration 0049 would have been unsound for Shopify snapshots and would have required an unbounded
object-store scan inside a schema migration. The fail-closed reader correctly reports
`classification_unavailable`, but a populated upgrade still needs a controlled way to inspect the
exact immutable object, apply the production classifier, append the missing classification, and
prove what happened.

An ad hoc SQL update or topic-only script would bypass object integrity, payload schemas, tenant
audit evidence, concurrency control, fixed provider/family compatibility, and the append-only
classification boundary. Giving an application or worker role global repair access would also expand
long-lived runtime authority.

## Decision

1. Migration 0051 adds only fixed repair authority. It performs no data backfill and fails unless a
   dedicated `reconai_maintenance` cluster role already exists.
2. The maintenance role is non-superuser, non-inheriting, non-RLS-bypassing, and has no direct
   source-event, classification, or audit-table access. It may execute only the fixed repair
   functions.
3. A claim function returns one repairable receipt ordered by immutable object key, receipt time,
   and source-event ID. It uses `FOR UPDATE ... SKIP LOCKED`, so concurrent repair processes cannot
   classify the same claimed source row.
4. The repairable set is closed: accounting CSV receipts; exact supported Shopify order/refund
   topics; and exact supported Stripe PaymentIntent, refund, and balance-transaction topics. Exact
   Shopify privacy topics are outside the operational-gap count. Other operational topics remain
   visible as unsupported gaps and block a complete-coverage claim.
5. The worker reads the server-recorded object key with the server-recorded SHA-256 digest, a
   provider one-MiB or CSV ten-MiB ceiling, and a 15-second read deadline. Missing, oversized,
   corrupt, timed-out, or schema-invalid objects fail the transaction closed.
6. Provider objects use the same exported exact payload classifier as live intake. Shopify snapshots
   are never classified from their topic alone. Accounting CSV source receipts classify only to
   `csv_row`.
7. The source row remains locked across object verification and classification recording. The
   recording function rechecks tenant, source-event, connection, provider, topic, object key, and
   digest, and accepts only exact V1 family shapes.
8. A classification insert and a fixed hash-chained tenant audit action
   `source_event.classification_repaired` commit atomically. The audit records operator, reason,
   repair-run correlation, exact provider/topic/families, classifier version, repair version, and
   time. Security-definer functions constrain the audit action; the maintenance role cannot append
   arbitrary audit rows.
9. Each command processes at most 100 source events. Output contains only aggregate counts, the
   target database system identifier, and a repair-run digest; it does not emit tenant, connection,
   source-event, object-key, payload-digest, operator, reason, credential, or payload values.
10. The command defaults to loopback. A reviewed non-loopback run requires explicit opt-in,
    PostgreSQL `sslmode=verify-full`, HTTPS object storage, exact database-system-identifier
    binding, and the literal destructive-action confirmation. Completion requires zero total gaps,
    not merely zero currently repairable gaps.

## Consequences

Populated deployments have a deterministic, restartable repair path without weakening the
fail-closed reader or embedding an object-store scan in migration execution. Batches can run
concurrently and retry after an integrity or availability failure; exact existing classifications
are immutable and replay-safe.

The repair is intentionally operationally expensive: it holds one source-row lock while performing
one bounded object read, creates one classification and one audit row per repaired receipt, and may
increase object-store reads, WAL, replica lag, and audit-chain contention. Unsupported topics,
missing retained objects, digest failures, or invalid historical payloads require investigation and
remain visible; operators cannot force completion.

This does not prove provider completeness, normalization, reconciliation correctness, mixed-image
rollout safety, representative-volume performance, hosted-database behavior, or protected-staging
readiness.

## Alternatives considered

- Infer from transport topics: rejected because Shopify snapshots can contain an order alone or an
  order plus refund transactions.
- Backfill in migration 0049 or 0051: rejected because schema migration must not perform unbounded
  network/object reads or make payload-dependent financial-evidence decisions.
- Grant repair writes to the application or worker role: rejected because long-lived runtime
  identities do not need global repair authority.
- Give maintenance direct table privileges: rejected because fixed functions can recheck immutable
  evidence, constrain family/audit shapes, and preserve forced RLS.
- Skip unsupported rows when deciding completion: rejected because that would turn unknown evidence
  into a false absence/completeness claim.

## Security, tenant, financial, AI, and operational effects

The command never accepts a client-supplied tenant as authority. Candidate tenant scope comes from
the locked database row; the transaction then sets that exact tenant context before classification
and audit insertion. Maintenance cannot enumerate source rows through direct SQL. Application and
worker roles cannot execute repair functions, and cross-tenant reads remain forced-RLS scoped.

The repair writes no money, currency, canonical record, match, exception, approval, source-system
state, credential, permission, or AI result. It uses deterministic classifiers and cannot override
reconciliation rules. Object credentials must be temporary, read-only, bucket/prefix-scoped
`GetObject` authority; database credentials must be temporary maintenance-role credentials. Neither
belongs in source control, shell history, logs, tickets, or evidence artifacts.

## Migration, rollout, rollback, and verification

Provision the reviewed `reconai_maintenance` role through the platform role lifecycle before
applying migration 0051. Drain or exclude classification-unaware writers, apply 0051, deploy only
classification-aware writers, inventory gaps, rehearse on restored synthetic/staging data, and run
small batches under observed database/object/WAL/replica conditions. Require zero total gaps and
independent read-model verification before claiming classification coverage.

To stop, terminate the command normally; its current transaction rolls back. Keep new writers and
the fail-closed reader in place, retain audit/object evidence, and investigate the fixed error code.
Forward rollback restores prior images only after draining all new writers/readers and leaves the
additive functions, policies, role, classifications, and audit rows dormant. Never delete or rewrite
classification/audit evidence and never manually edit the migration ledger.

Local acceptance includes strict typecheck, unit/static checks, a live two-session PostgreSQL test,
missing/corrupt/timeout/unsupported failures, retry/replay, RLS and direct-table/function denials,
audit-hash verification, previous-release upgrade, the full database suite, production build, secret
scan, dependency audit, and immutable evidence. Hosted, representative-volume, mixed-image,
provider, protected-staging, and owner-approved production execution remain separate gates.
