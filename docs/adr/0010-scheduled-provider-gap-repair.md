# ADR 0010: Scheduled provider gap repair with service authority

Status: accepted  
Date: 2026-07-27  
Extends: `0008-bounded-provider-event-sync.md`, `0009-shopify-graphql-snapshot-recovery.md`

## Context

Verified webhooks and operator-requested recovery do not provide periodic correctness repair.
Running the existing recovery path from a timer also cannot safely invent a membership: background
work must retain tenant context and an initiating actor without impersonating a person. Multiple
worker replicas may scan simultaneously, so scheduling must be bounded and replay-safe before any
provider request is queued.

## Decision

Add an opt-in worker scheduler that creates only `gap_repair` runs through the existing immutable
provider-sync/outbox pipeline.

- Automatic runs use the fixed service identity `provider-gap-repair-scheduler`. A requester
  constraint requires exactly one of a real membership for `user` authority or that allowlisted
  service for `system` authority.
- The worker retains no direct insert permission on `provider_sync_runs`. One worker-only,
  fixed-query `SECURITY DEFINER` function enumerates at most 100 due connections; a second creates
  one validated run/outbox pair after rechecking tenant context, connection state, read credential,
  due time, active-run absence, envelope shape, and all bounds. Both keep row security enabled.
- An organization/connection advisory transaction lock serializes operator and scheduler creation. A
  deterministic cadence-slot key makes repeated and concurrent scans create at most one run.
- Eligible connections are Shopify or Stripe in `healthy`, `degraded`, or `stale` state with a
  distinct read credential and no queued/running sync. `backfilling`, `disconnected`, and
  `action_required` connections are excluded.
- The default configuration is disabled. When enabled, cadence is 1 minute–1 day, lookback is 1
  minute–30 days, overlap is 0–60 minutes and smaller than lookback, automatic runs are capped at
  1–25 pages, and each scan examines at most 100 connections.
- The repair window begins at the later of the bounded lookback or the last successful sync minus
  overlap. Immutable provider receipt identities make the overlap dedupe-safe. The scheduler never
  calls a provider directly; outbox relay, exact durable-job authorization, provider adapters,
  retries, and terminal evidence remain unchanged.
- Creation and completion append actor-distinct audit events. Run history exposes `user` versus
  `system` provenance as “Operator” or “Automatic repair” without exposing credential references.

## Consequences

Webhook delivery is no longer the sole ongoing correctness mechanism for the implemented Stripe
event and Shopify order/refund families. Scheduler replicas can overlap without duplicating
authorities, active manual work is not raced, service activity is distinguishable from human
activity, and every network request retains the existing tenant-bound outbox authority and cost
ceilings.

This does not provide provider OAuth/token lifecycle, distributed provider-rate coordination,
per-object freshness watermarks, alert delivery, a sandbox contract, or staging operational
evidence. Enabling the scheduler in production remains blocked on those controls and an approved
cadence/capacity policy.

Migration `0031_scheduled_provider_gap_repair.sql` is additive. Existing run rows become `user`
requests and keep their membership foreign key. Application rollback disables the scheduler and runs
the previous compatible image while leaving the nullable service columns and dormant functions in
place; no down migration is required.
