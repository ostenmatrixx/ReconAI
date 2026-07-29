# ADR 0022: Durable job execution and classified queue recovery

Status: accepted  
Date: 2026-07-28

## Context

PostgreSQL outbox publication and a stable BullMQ job identity make ordinary dispatch idempotent,
but a published timestamp cannot describe what happened after publication. If Redis is lost, a
published event might still have been waiting, might be running, might have failed retryably, or
might already have succeeded. Replaying all published history would risk duplicate financial
artifacts; reconstructing only unpublished rows left legitimate published-but-unprocessed work as an
explicit recovery gap.

The rollout also has an old-worker compatibility boundary. If migration 0040 marked every new row as
tracked by default while a pre-ledger worker was still running, that worker could finish without
creating execution evidence. A later recovery would then misclassify the row as never started.

## Decision

- Add a nullable `outbox_events.execution_tracking_version`. Migration 0040 does not backfill it and
  gives it no database default. Updated writers explicitly use version 1. The scheduled-repair
  writer uses a transaction-local opt-in consumed by an insert trigger. Old writers therefore remain
  conservatively unclassified during a rolling deployment.
- Add one forced-RLS `job_executions` row per tenant/idempotency authority. Queue name, stable job
  ID, outbox event, event/schema/correlation, and maximum attempts are immutable.
- A fixed worker-only begin function rechecks the exact published, non-dead-lettered outbox
  authority and acquires a bounded lease. The worker creates a random token; PostgreSQL stores only
  its SHA-256 digest. Fixed heartbeat, succeed, and fail functions accept only the current token
  digest. Terminal succeeded/dead-lettered rows cannot change.
- The worker rejects noncanonical BullMQ job IDs, acquires the database lease before handler
  dispatch, renews it while the handler runs, and records retryable or terminal failure. Existing
  handlers remain idempotent because execution leases reduce duplicate dispatch but do not promise
  exactly-once external execution.
- Recovery functions classify only due unpublished, tracked never-started, explicit retryable, or
  both lease-expired and operator-stale running work. Active, succeeded, dead-lettered, and legacy
  published/no-ledger rows are excluded.
- Add forced-RLS, append-only `queue_recovery_events` with recovery run, tenant/idempotency,
  classification, stable job ID, bounded operator/reason, and timestamp. This evidence also allows a
  pre-migration unpublished row recovered by the new command to be classified as never started after
  a later Redis loss; unrelated legacy published rows remain excluded.
- The guarded command requires an exact restored PostgreSQL system identifier, explicit stale
  boundary at least 15 minutes old, bounded batch, loopback by default, Redis database 1–15, a
  completely empty Redis keyspace, and explicit confirmation. It validates tenant-bound envelopes,
  uses stable job IDs, rechecks classification while recording evidence, proves duplicate add
  behavior, and emits only aggregate counts/digests.

## Consequences

Redis remains non-authoritative and can be reconstructed without guessing terminal history. Database
availability is now part of worker execution admission and completion. A lost or uncertain lease
causes retry/failure behavior rather than an untracked success; job handlers must remain idempotent.

Recovery is intentionally conservative. Published rows produced or completed by old workers may be
excluded if no ledger/recovery evidence exists. Operators must reconcile that bounded rollout gap
from preserved incident evidence instead of broad replay.

Redis queue insertion and PostgreSQL recovery evidence cannot be one transaction. A failure between
them leaves a non-empty isolated Redis database and stops the command. Operators preserve and
reconcile that state; they do not flush and blindly rerun.

No money representation, matching rule, tolerance, rule version, provider permission, or
source-system write capability changes. Queue recovery only reintroduces previously authorized,
read-only/idempotent work.

## Alternatives

Replaying every published outbox row was rejected because publication is not proof of incomplete
execution. Redis persistence alone was rejected because Redis is not the financial source of truth
and a corrupted/lost queue still needs database-grounded recovery. BullMQ completed/failed history
alone was rejected because that is the state being recovered. Storing raw lease tokens was rejected
because a database read should not grant current execution authority. Backfilling all legacy rows to
tracking version 1 was rejected because their post-publication outcome is unknowable.

## Migration, rollback, and verification

This is an additive expansion. Apply migration 0040 first; old writers continue producing null
tracking rows. Upgrade all workers next, then API and other explicit version-1 producers. Do not
roll workers back to a pre-ledger image while version-1 producers are active. A rollback requires
quiescing producers, preserving/draining Redis, and either retaining the new worker or disabling
version-1 production; the additive tables/column can remain dormant. Dropping the ledger or recovery
events is destructive and is not an application rollback.

Static migration tests verify forced RLS, role denial/grants, immutable authority/terminal state,
append-only evidence, no tracking default, and conservative legacy classification. Live PostgreSQL
tests verify acquisition/busy/heartbeat/success, retryable and terminal behavior, forged-tenant
denial, application-role denial, foreign-tenant concealment, scheduled-writer opt-in, all four
recovery classifications, and exclusion of active/succeeded/dead/legacy rows. A protected Redis
exercise verifies ten waiting jobs, stable duplicate replay, non-empty Redis refusal, and
restored-system-identifier refusal. This is local synthetic component evidence, not staging RPO/RTO
or complete disaster-recovery evidence.
