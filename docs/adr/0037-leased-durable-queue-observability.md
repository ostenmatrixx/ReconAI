# ADR 0037: Leased durable queue observability

- Status: Accepted
- Date: 2026-07-29

## Context

ReconAI had bounded worker-attempt and outbox-relay metrics but no direct signal for durable queue
growth or dispatch delay. An exact scan for the oldest prioritized job would be unbounded because
BullMQ orders that list by priority, not creation time. Polling from every worker replica would
duplicate gauge writers. A synchronous gauge could also let a former leader re-export its last value
indefinitely after losing ownership.

Queue monitoring must remain read-only, bounded, low-cardinality, tenant-neutral, and independent of
financial work and readiness. Redis unavailability or an OTLP failure cannot authorize queue
mutation or block processing.

## Decision

When worker OTLP is enabled:

1. Create a dedicated Redis connection with bounded connect and command timeouts, one command retry,
   no offline queue, and no role in worker/API readiness or job processing.
2. Compete for an atomic Redis lease derived only from the environment-scoped durable queue name. A
   random per-process token is compared for renew and release, never logged or exported. The TTL is
   three poll intervals, bounded to 5–900 seconds.
3. Only the lease holder reads seven fixed BullMQ aggregate states: `waiting`, `paused`, `active`,
   `delayed`, `prioritized`, `waiting-children`, and `failed`.
4. In the same poll, read at most the next job from each waiting, paused, and prioritized list.
   Export the maximum age since those list-head jobs were created as
   `reconai.queue.ready_head.maximum_age`. This is a truthful constant-size frontier measure, not an
   exact oldest-job scan across the priority-ordered list.
5. Select delta temporality explicitly for the worker metric exporter. Export queue state as an
   observable gauge with only the fixed state attribute. Keep the process-local snapshot valid only
   through the lease TTL. A follower, failed poll, or clean shutdown clears it. Delta collection
   does not merge that previous gauge into later exports, so a former leader stops publishing the
   series; expiry also bounds an isolated process that cannot observe lease loss.
6. Empty queues publish explicit zero values. Invalid counts, timestamps, or an unexpectedly large
   frontier publish no partial or fabricated snapshot.
7. Record only fixed `succeeded` or `failed` poll outcomes. Ordinary follower skips emit nothing.
   Errors use the existing redacted structured-error boundary.

## Consequences

Operators can distinguish queue growth, retained failures, and aging dispatch frontiers from worker
attempt/outbox behavior without exposing tenant or job identity. Every successful poll performs a
constant number of Redis reads and hydrates at most three job envelopes; it inspects only their
timestamps and immediately discards them.

There can be a bounded gap during lease transfer or Redis isolation. Missing queue samples must not
be interpreted as zero. Backend dashboards and alerts must handle gauge silence separately from
explicit zeros. The monitor's dedicated connection adds one Redis client and one BullMQ queue client
per telemetry-enabled worker replica.

The lease coordinates writers but is not a correctness lock. It cannot pause jobs, grant tenant
authority, change retry state, or participate in reconciliation. Poll counters remain ordinary
process metrics and may reset across restarts. All worker counters and histograms are also exported
with standard delta temporality; the API keeps cumulative temporality. The selection is
application-owned rather than inherited from an unvalidated ambient OpenTelemetry setting, and
collectors must honor each OTLP point's temporality.

## Alternatives considered

- Poll from every replica: rejected because duplicate writers make environment-level gauges
  ambiguous and waste Redis work.
- Use a synchronous last-value gauge: rejected because a former leader can indefinitely re-export a
  stale value after lease loss.
- Scan every waiting/prioritized job for the oldest timestamp: rejected because work and envelope
  hydration grow with backlog exactly when the system is degraded.
- Use only BullMQ events or worker attempt rates: rejected because missed/reordered events and a
  fully stalled consumer do not provide an authoritative current aggregate.
- Make queue telemetry part of readiness: rejected because observability loss must not evict a
  worker that can still process financial work.
- Export queue/job/tenant identifiers: rejected as unnecessary high-cardinality customer context.

## Security, tenant, financial, and operational effects

The lease key contains only the fixed queue namespace; the random token remains in Redis and process
memory. Metrics contain seven fixed states, two fixed outcomes, counts, and seconds. They contain no
organization, user, connector, job, correlation, object, provider, credential, amount, currency, or
payload data.

No database schema, tenant query, money behavior, reconciliation rule/version, permission, provider
scope, durable envelope, audit history, source write, or AI behavior changes. Rollback stops the
monitor and leaves queue processing unchanged; the lease expires or is compare-token deleted.

## Verification

Focused tests prove exact fixed reads, explicit zero behavior, corrupt/oversized frontier rejection,
lease-owner/follower behavior, single-flight scheduling, bounded TTL/key derivation, and
compare-token release. The OTLP protobuf test covers all queue instruments and fixed state values.

An integration test uses three clients against authenticated protected-mode Redis 8.2.8 and real
BullMQ waiting, priority, and delayed structures. It proves exact aggregate values, a 120-second
ready-head maximum age, one positive-TTL environment lease, and a follower that performs no queue
read. A real loopback OTLP/HTTP protobuf receiver observes the metrics and rejects tenant, payload,
lease-token, and lease-key sentinels. A forced export after the follower transition contains no
prior queue gauge, proving the worker's delta collection prevents cumulative last-value retention.
Redis is empty and the server port is closed after cleanup.

Evidence is recorded in `artifacts/durable-queue-observability-verification-2026-07-29.json`. This
is local component evidence, not a protected collector/backend, alert-delivery, multi-host
partition, sustained-load, or production result.
