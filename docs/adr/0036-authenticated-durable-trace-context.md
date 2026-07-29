# ADR 0036: Authenticated durable trace context

- Status: Accepted
- Date: 2026-07-29

## Context

The API accepts a bounded W3C `traceparent`, re-applies the local sampling policy, and creates an
API server span. Durable reconciliation work then crosses PostgreSQL outbox and Redis queue
boundaries using only an opaque correlation ID, so the worker starts a separate trace. Persisting
the inbound header directly would let a remote caller choose durable sampling state. Trusting a
queue field before checking database authority would also let someone with unintended Redis write
access forge trace relationships even though financial work remains denied.

Trace context must not weaken stable job identity, tenant authority, replay, cardinality, redaction,
or the rule that observability failure never changes financial behavior.

## Decision

Add an optional, versioned `traceContext` to the strict durable envelope:

1. Version 1 contains only a lowercase W3C version-00 `traceparent` with nonzero trace and span IDs
   and a `00` or `01` sampled flag.
2. The API persists only the currently active, locally accepted span context. It never persists raw
   caller `tracestate`, baggage, headers, route values, tenant identifiers, or payload fields.
3. The complete `traceContext` is part of the canonical durable-job hash. Changing it changes the
   queue job ID.
4. The worker validates the queue schema and job ID, loads the exact tenant-bound PostgreSQL outbox
   payload under RLS, and compares the complete canonical identity before using the context.
5. Only after that authority check does the worker create a consumer span using the durable parent
   as a trusted local parent. Invalid, forged, missing-authority, and transient authority-load
   attempts create unparented observations.
6. Envelopes without `traceContext` remain valid and workers start a new root, preserving existing
   queued jobs, recovery snapshots, and self-hosted deployments with telemetry disabled.

The first producer is authorized reconciliation run creation. The common envelope contract permits
other durable producers to adopt the field only when they capture local context and retain the same
outbox-authority ordering.

## Consequences

Configured API and worker runtimes can emit one trace across the authenticated request, immutable
run request, durable worker attempt, and reconciliation execution. The sampled decision is the API's
local decision, not the caller's raw flag. Trace IDs remain absent from metric labels and financial
records.

The outbox payload and queue job ID vary with the first authorized request context. This is safe
because the payload is created only with the new immutable run authority; exact run retries return
that authority rather than constructing another outbox event. BullMQ retries and empty-Redis
recovery reuse the same stored envelope and identity.

Database authority loading occurs before the parented worker span. A transient authority-read
failure is therefore observable only as an unparented retryable attempt. This favors trace integrity
over making an unverified queue context appear continuous.

## Alternatives considered

- Keep correlation IDs only: rejected because operators cannot follow the latency and failure path
  across API, outbox, worker, and reconciliation spans.
- Persist the raw inbound `traceparent`: rejected because remote sampling state has not yet passed
  the API's local sampling decision.
- Persist `tracestate` or baggage: rejected because they are caller-controlled, unnecessary for this
  workflow, and expand data-leak and cardinality risk.
- Trust the Redis envelope before PostgreSQL lookup: rejected because queue possession is not
  tenant-bound financial or telemetry authority.
- Exclude trace context from the job hash: rejected because context tampering could retain a valid
  queue identity.
- Require the field and bump every durable envelope: rejected because existing outbox rows and
  recoverable jobs must remain valid during rolling deployment and self-hosted upgrade.

## Security, tenant, financial, and operational effects

The worker still requires the organization-scoped outbox row, exact event type, idempotency key,
requested actor, correlation ID, complete canonical envelope hash, execution ledger, and tenant
context before processing. The trace context contains no organization, user, connector, customer,
payment, amount, currency, credential, or source payload.

No schema migration, money handling, reconciliation rule, permission, provider scope, source write,
or AI behavior changes. Telemetry remains bounded and lossy: a collector outage may break the trace
but cannot delay, approve, roll back, or alter financial work.

Rollback stops adding `traceContext` and starts new worker roots. The optional schema remains
backward compatible, and already-persisted contexts remain bound to their immutable job identities.

## Verification

Schema tests accept only the fixed version-00 form, reject zero IDs, uppercase, unsupported flags,
unknown fields, and secret-like input, and prove that changing only the context changes the durable
job ID. Worker tests prove exact authority succeeds, a forged context with its own recomputed queue
ID fails against the database authority, and an invalid queue identity does not invoke the authority
loader.

The loopback OTLP protobuf test captures the API's active local context, starts the durable consumer
outside the API execution context, and proves both spans share the same trace ID while using
distinct span IDs. Tenant/API coverage proves a raw inbound header is not copied when no local
observability span exists.

A fresh loopback PostgreSQL 17.10 cluster with data checksums applied all 44 migrations and passed
the four-test restricted-application repository file. The new assertion read the immutable
reconciliation outbox authority and matched the exact versioned trace context persisted with the
run. This is local contract evidence, not a deployed multi-process collector/backend, complete
continuous journey, latency result, or staging alert exercise.

Evidence is recorded in
`artifacts/reconciliation-durable-trace-context-verification-2026-07-29.json`.
