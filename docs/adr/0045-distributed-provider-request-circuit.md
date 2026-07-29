# ADR 0045: Distributed provider request circuit

- Status: Accepted
- Date: 2026-07-29

## Context

The founding reliability requirements call for circuit breakers and graceful provider degradation.
The architecture previously claimed that provider circuit breakers stop amplification, but bounded
Shopify and Stripe recovery pages went directly from a durable worker to the provider. BullMQ
bounded attempts and repository failure counters limited one job, but independent workers or later
runs could still repeat calls during a provider outage or rate-limit interval.

A process-local breaker would not coordinate worker replicas. One provider-wide breaker would let
one tenant's credential, scope, or account behavior suppress unrelated tenants. Storing raw
organization, connection, account, credential, or provider response values in Redis keys or
telemetry would create an unnecessary customer-data surface.

Provider page requests are read-only, cursor bounded, and already authorized by an exact
tenant-bound outbox envelope plus an active `provider_sync_runs` row. Redis is already a required
durable-worker dependency. Provider errors expose a fixed failure kind and may include bounded
`retryAfterMs` guidance.

## Decision

1. Require every `ProviderSyncService` to receive a `ProviderRequestCircuit`; there is no no-op or
   disabled production path.
2. Scope each circuit to environment, fixed provider, organization, and connection. The Redis key
   contains environment and provider plus a SHA-256 digest over the organization/connection
   authority. It contains no raw tenant, connection, account, run, cursor, credential, payload, or
   error value.
3. Use one dedicated bounded Redis connection per worker process with offline queuing disabled, one
   retry, and explicit connect/command timeouts. Admission-store failure fails closed before a
   provider request.
4. Use Lua scripts for atomic multi-replica state transitions. State contains only consecutive
   failure count, open time/duration, a random current permit token, and half-open probe expiry.
   State expires after a bounded inactive period.
5. Default to three consecutive transient failures, a 60-second open interval, and one 15-second
   half-open probe lease. Runtime validation bounds the threshold to 1–20, open interval to 1–900
   seconds, probe lease to 1–60 seconds, and requires the probe lease not to exceed the open
   interval.
6. Count only `rate_limited`, `timeout`, and `provider_unavailable` errors toward the circuit. Rate
   limiting opens immediately and honors a validated provider retry-after interval up to 15 minutes.
   Authentication, authorization, terminal request, invalid payload, and local validation failures
   release a probe but do not classify the provider as unavailable.
7. A successful validated provider page closes and deletes the circuit state. After the open
   interval, exactly one worker receives a half-open permit; concurrent replicas receive a bounded
   `probe_busy` denial. A transient probe failure reopens from the current time.
8. Bind every circuit mutation to a random 192-bit permit token. A late result whose token is no
   longer current is ignored, so it cannot close or reopen newer state.
9. Treat an open circuit as a retryable provider-unavailable result. The durable worker backoff uses
   the larger of deterministic bounded exponential delay and a validated `retryAfterMs`, capped at
   15 minutes. Arbitrary, non-integer, negative, or non-finite error properties are ignored.
10. Emit only fixed provider plus closed-vocabulary circuit decisions/transitions. Also emit
    provider-sync attempt result/duration with fixed provider and `scheduled` or `user_requested`
    trigger. No tenant, connection, run, account, requester, cursor, credential, error code,
    payload, timestamp, money, or currency becomes a metric attribute.
11. Keep the circuit non-authoritative. It cannot create provider work, change sync windows or
    cursors, mark a run successful, mutate source systems, approve financial actions, change
    reconciliation, or bypass tenant/outbox/job authority.

## Consequences

Provider outages and rate limits suppress repeated page requests across worker replicas for the same
tenant connection, while another tenant connection remains independent. One probe tests recovery
after cooldown. Successful pages clear stale failure state; state expires automatically if a
connection is never retried.

Circuit denial still consumes a bounded durable-job attempt and records a retryable sync failure.
Retry-after-aware backoff prevents rapid exhaustion during the remaining open interval. The
underlying job/run retry ceilings remain the terminal safety bound.

Redis unavailability denies provider admission. This favors source-system protection and bounded
behavior over attempting an uncoordinated provider call. The queue, outbox, immutable run, and
tenant-authorized operator state remain available for later retry/recovery evidence.

The breaker is connection scoped, not a global provider-capacity or account-family budget. Separate
connections for the same external account do not share a circuit. It does not prove provider
availability, freshness, completeness, or recovery; it only bounds calls after observed transient
failures.

## Alternatives considered

- Rely only on BullMQ retries: rejected because attempts limit one job but do not coordinate later
  work or worker replicas during an outage.
- Process-local state: rejected because replica count would multiply provider calls and half-open
  probes.
- One global Shopify/Stripe circuit: rejected because one tenant or provider region could suppress
  every other tenant.
- Key by raw organization/connection/account: rejected because the operational store does not need
  readable customer identifiers.
- Put circuit state in PostgreSQL: rejected for this request path because it would add database
  writes around every external page request and couple provider protection to tenant financial
  storage. Redis already supplies atomic ephemeral coordination.
- Count authentication or payload failures as provider outage: rejected because those are terminal
  connection/request problems, not evidence that retrying other authorized work would amplify an
  unavailable provider.
- Silently bypass the circuit on Redis failure: rejected because a dependency outage would remove
  the exact protection when concurrent retries are most likely.
- Sleep inside a worker until cooldown expires: rejected because it consumes worker concurrency and
  job leases; delayed BullMQ retry is the bounded scheduling mechanism.

## Security, tenant, financial, and operational effects

Circuit admission follows exact durable outbox and sync-run authority. The key digest is derived
only after that authority is loaded and includes tenant plus connection context. Redis data contains
no credential or provider payload. Metrics use only fixed provider, trigger, outcome, decision, and
transition vocabularies. Dynamic values collapse to `invalid` and are covered by OTLP byte scans.

The circuit wraps only Shopify/Stripe read page calls. It adds no write provider scope and does not
change webhooks, OAuth installation/refresh/disconnect, privacy handling, CSV imports, canonical
records, money, deterministic rules, review, audit, retention, or AI behavior.

No database migration is required. Deployment adds bounded worker configuration and a dedicated
Redis client. Prior workers remain compatible but do not participate in the circuit, so a rolling
window does not provide full amplification protection. Drain provider-sync work or verify no prior
workers remain before relying on the circuit. Forward rollback restores the prior worker and leaves
ephemeral namespaced Redis hashes to expire; deleting them early is unnecessary.

Before production, exercise the exact managed Redis version/topology, authentication/TLS, ACL
restriction, failover, latency, command timeout, partitions, worker replacement, mixed-image window,
provider rate limits/outages, thresholds, dashboard aggregation, silence behavior, and alert
delivery. Select thresholds from provider contract and protected-staging evidence.

## Verification

Unit tests prove circuit-required provider execution, transient-only failure classification,
immediate rate-limit opening input, open-circuit and Redis-failure read suppression, responsive
terminal-error probe release, retry-after bounds, strict configuration, pseudonymous key shape, Lua
result validation, and dynamic metric suppression.

A loopback authenticated Redis test uses two independent clients to prove three-failure opening,
cross-client denial, tenant/connection isolation, exactly one half-open probe, probe-busy denial,
reopening, successful closure, immediate rate-limit opening, bounded retry-after, positive state
TTL, and absence of raw authority identifiers from keys. This remains single-host local evidence,
not managed Redis, multi-host partitions, provider traffic, staging, or production proof.

Evidence is recorded in `artifacts/provider-request-circuit-verification-2026-07-29.json`.
