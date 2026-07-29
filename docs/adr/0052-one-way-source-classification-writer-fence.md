# ADR 0052: One-way source-classification writer fence

- Status: Accepted
- Date: 2026-07-29
- Extends: ADR 0051

## Context

Migration 0051 provides a bounded, integrity-checked repair path for source receipts created before
atomic classification existed. Repairing a database to zero gaps is not sufficient while a
classification-unaware API or worker can still commit another operational receipt. A conventional
deployment checklist cannot serialize database commits with the instant an operator declares the
writer fleet clean, and a mixed-image race could silently recreate the fail-closed
`classification_unavailable` state immediately after repair.

The database needs a transition boundary that waits for writers already inside their transactions,
checks the complete cross-tenant classification state, and makes old writers fail atomically from
that point onward. It must not give a long-lived runtime role global tenant access or infer
classification from a transport topic.

## Decision

1. Migration 0052 is additive and leaves the fence disabled. It performs no backfill, source scan,
   classification write, provider request, or financial mutation during migration.
2. Every `source_events` insert takes a shared transaction advisory lock on one fixed versioned key.
   Shared writer locks remain mutually compatible. Activation takes the corresponding exclusive
   transaction lock, so it waits for every source insert that began before the boundary to commit or
   roll back.
3. Activation is available only through `reconai_activate_source_event_classification_writer_fence`
   to the dedicated `reconai_maintenance` role. The command binds approval to the database system
   identifier, validates an operator and 20–500 character reason, requires the exact literal
   `ENABLE-SOURCE-CLASSIFICATION-WRITER-FENCE`, defaults to loopback, and requires
   `sslmode=verify-full` for an explicitly approved non-loopback target.
4. After acquiring the exclusive lock, activation scans every operational Shopify, Stripe, and
   accounting CSV source receipt. Each must have classifier version `source-object-family-v1` and
   the exact provider/topic/family shape accepted by current intake. Exact Shopify privacy topics
   remain exempt. Missing, unsupported, or incompatible evidence aborts activation with no state
   change.
5. The cross-tenant scan executes under forced RLS through a migration-owned security-definer
   function. Its source-row policy requires both `current_user = reconai_migrator` and
   `session_user = reconai_maintenance`. Application and worker roles cannot execute activation;
   maintenance cannot read the source, classification, audit, or activation tables directly.
6. Successful activation appends one global singleton row with a server timestamp and fixed fence
   version. The row contains no tenant, source-event, object, payload, credential, or money data.
   Runtime roles have no table privilege, and a trigger rejects update or delete. Exact repeated
   activation returns the original authority without adding another row.
7. Once active, an initially deferred constraint trigger checks every new operational source receipt
   at transaction commit. The matching classification must already exist in the same transaction
   with the exact V1 family shape. Missing or incompatible classification rejects the entire source,
   classification, outbox, canonical, and audit transaction. Privacy topics may commit without an
   operational classification.
8. Activation is deliberately one-way in this increment. There is no disable function. An active
   database must never run a classification-unaware writer, including as an application rollback.
   Any future disable capability requires a separately reviewed forward migration and evidence; an
   operator must not delete or rewrite the activation row.

## Consequences

The boundary closes the race between a zero-gap check and old-writer commits. A writer already
holding the shared lock finishes first and is included in the activation scan. A writer starting
after activation either commits compatible classification in the same transaction or fails without
leaving partial evidence. Provider and CSV retries retain their existing idempotency behavior.

Every source insert now obtains one transaction-scoped shared advisory lock, even before activation.
This adds a small database operation and creates one global lock domain, although normal writers do
not block one another. Activation intentionally blocks new source inserts while it waits and scans;
the repository applies a ten-second lock timeout and fifteen-second statement timeout. Operators
must measure writer latency, scan time, lock wait, WAL, and replica effects on representative
protected data before production use.

The singleton is environment-wide rather than tenant-scoped because mixed writer images are a
deployment property. Its table intentionally has no RLS: it contains no customer data, has no
runtime table grants, and is exposed only through fixed status/activation functions. This is not a
general global browse capability.

This does not prove that every deployed process is classification-aware, that a prior production
image cannot be restarted by an external supervisor, provider completeness, representative-volume
performance, hosted PostgreSQL behavior, protected-staging readiness, or production safety.

## Alternatives considered

- Rely on a drain checklist followed by a gap count: rejected because a commit between the count and
  declaration recreates the gap.
- Turn enforcement on in the migration: rejected because a rolling deployment may still contain old
  writers and a populated database may contain legitimate repairable gaps.
- Make the trigger immediate: rejected because current writers insert the source before its
  tenant-composite classification in the same transaction.
- Allow per-tenant activation: rejected because writer image compatibility is environment-wide and
  partial activation would complicate rollback and operational reasoning.
- Allow operators to disable the fence: rejected because it would silently reopen the exact evidence
  race the boundary is meant to close.
- Grant maintenance direct cross-tenant table access: rejected because fixed functions and
  invocation-bound RLS policy provide narrower authority.

## Security, tenant, financial, AI, and operational effects

No client-supplied organization grants activation authority. The activation scan is cross-tenant
only because it proves a global deployment invariant; it returns no tenant data. The public command
prints only fixed booleans/version, the approved system identifier, and a SHA-256 digest of the
activation ID. Failure output is a fixed code and does not echo the database URL, operator, reason,
tenant, object, payload, or credential.

The fence never changes money, currency, canonical values, matches, exceptions, approvals,
permissions, source-system state, or reconciliation rule versions. It uses deterministic database
compatibility checks and no AI.

## Migration, rollout, rollback, and verification

Provision `reconai_maintenance`, take and verify the normal recovery point, apply migration 0052,
and deploy classification-aware provider and CSV writers. Keep the fence disabled while old images
exist. Stop admission, drain every old writer, run migration 0051 repair until the independent gap
count is zero, inventory every deployable image and supervisor target, and rehearse the exact
transition on restored representative data. Then run the bounded activation command and
independently verify status plus actual provider, CSV, privacy, replay, and negative old-writer
transactions.

If activation times out or reports a gap, its transaction rolls back and the fence remains disabled.
Keep traffic drained, repair or investigate the exact unsupported path, and retry only after the
preconditions hold. After successful activation, rollback is restricted to classification-aware
images. Do not restore or restart an old writer, remove the trigger, mutate the singleton, or edit
the migration ledger.

Local acceptance includes static migration and CLI-redaction checks; empty and populated 53-file
migration execution; a real PostgreSQL 17.10 in-flight-writer/exclusive-lock handoff; zero-gap
repair; idempotent one-way activation; unclassified and incompatible rollback; actual Shopify and
CSV writers; privacy exemption; replay; tenant isolation; role/table denial; and redacted successful
CLI output. The repository has no prior commit or deployable prior image, so this is a synthetic
old-writer database-effect test, not a real mixed-binary rehearsal. A protected prior/current-image
exercise remains mandatory.
