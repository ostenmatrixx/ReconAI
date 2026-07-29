# ADR 0007: Checksum-bound raw-evidence retention deletion

Status: Accepted — 2026-07-27

## Context

Raw import and provider payloads are restricted data, but deleting them too early can make an
in-flight ingestion or reconciliation result irreproducible. A policy change or legal hold can also
race a background worker, and an object key alone is insufficient deletion authority because the
object may have changed or a versioned bucket may expose an older version.

Production defaults cannot be selected without an approved legal/customer policy. The application
must therefore fail safe when no organization-specific duration exists while still providing a
bounded, auditable way to exercise retention.

## Decision

Raw import and provider-event object retention is disabled by default. An authorized organization
administrator may set either duration to 1–3,650 whole days, or leave it blank to disable that
class. Every update requires an audit-visible reason and exact organization confirmation. Enabling a
legal hold requires a reason and suspends both classes.

Only terminal sources are eligible: succeeded or rolled-back imports use their completion or
rollback timestamp, and processed or normalized provider events use receipt time. Canonical records,
field provenance, source/import metadata, reconciliation evidence, audit events, job evidence, and
deletion tombstones are retained by this workflow.

A migration-owner `SECURITY DEFINER` boundary exposes three fixed-query functions to the worker:
claim, finalize, and fail. The worker has no direct access to retention tables. Claiming locks the
organization policy row and keeps the database transaction open through one bounded object-store
operation, so policy and legal-hold changes serialize with deletion. Finalization rechecks the
current policy, legal hold, source state, checksum, object key, duration, and eligibility.

The object store reads current metadata, requires the stored SHA-256 and ETag, issues a conditional
delete against that ETag and version ID when available, and confirms the key is no longer readable.
Each request has a 15-second abort bound. A missing object is an idempotent terminal outcome; a
checksum/ETag mismatch fails closed. Failures use exponential retry capped at one hour, at most ten
attempts, and then dead-letter. Successful and already-missing outcomes append an immutable
tombstone.

## Consequences

No raw object is removed until an organization explicitly opts in, and a new legal hold cannot
silently race a claimed deletion. Holding a database transaction across one object request is an
intentional correctness tradeoff; batches are bounded and policy rows are selected with
`SKIP LOCKED` to avoid cross-organization head-of-line blocking. Operators must alert on
dead-lettered jobs.

Deleting the current version in a versioned S3-compatible bucket does not prove that noncurrent
versions or backups have expired. Production storage lifecycle rules and backup expiry must be
configured, sampled, and evidenced separately. This workflow is not whole-tenant erasure and does
not choose legal defaults.

Alternatives rejected: a global default (unapproved destructive behavior), database-only expiry
markers (does not remove the payload), key-only deletion (wrong-object risk), an application role
with broad cross-tenant table access (excess privilege), and asynchronous policy rechecks without a
serialized lock (time-of-check/time-of-use race).

## Migration and rollback

Migration `0029_retention_deletion_workflow.sql` is additive and creates no policy rows, so upgrade
leaves deletion disabled. Application rollback stops the retention runner and leaves the new schema
dormant. Setting both durations to null or enabling a documented legal hold stops new claims.
Completed object deletion is irreversible; rollback is forward repair plus separately tested backup
restoration, never a destructive down migration.
