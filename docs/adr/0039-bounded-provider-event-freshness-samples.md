# ADR 0039: Bounded provider-event freshness samples

- Status: Accepted
- Date: 2026-07-29

## Context

ADR 0038 distinguishes provider webhook ingress and post-authority normalization outcomes, but it
does not measure how old a provider event is when normalization completes. A global scan of
connection timestamps would require a new cross-tenant operational authority and distributed gauge
ownership. Adding tenant or connection identifiers to a metric would expose customer dimensions and
create unbounded series.

Every current Shopify and Stripe receipt already stores a normalized ISO source timestamp as part of
immutable, tenant-bound evidence. The worker sees that receipt only after its durable envelope has
exactly matched PostgreSQL outbox and receipt authority. Provider timestamps are still untrusted
data and must not become attributes or unbounded metric values.

## Decision

1. Add a minimized processing result that returns only `processed`/`already_processed` and the
   receipt's normalized source timestamp. Preserve the existing status-only method for compatible
   callers.
2. Record a freshness sample only after `completeWebhook` returns `processed`. Do not record one for
   `already_processed`, including races and durable replays, so one immutable event cannot skew the
   metric repeatedly.
3. Emit `reconai.provider.event.freshness.samples` with only provider, fixed ingress source
   (`webhook`, `sync`, or defensive `invalid`), and one fixed outcome:
   - `observed`: source-to-normalization lag is from zero through 30 days inclusive;
   - `future_timestamp`: source time is later than observation time;
   - `outside_window`: lag is greater than 30 days;
   - `invalid_timestamp`: either timestamp fails the bounded ISO-instant parser.
4. Emit `reconai.provider.event.source_lag`, in seconds, only for `observed` samples. Future,
   invalid, and over-window values never enter the histogram. The 30-day ceiling matches the maximum
   bounded provider-recovery window and prevents authenticated provider data from poisoning metric
   ranges.
5. Convert timestamps to numeric lag and discard their source strings. Never export the timestamp,
   event type, tenant, connection, receipt, object, job, correlation, requested-by, credential,
   payload, provider error, money, or customer data as an attribute.
6. Derive provider and source through the same closed runtime mappings as normalization telemetry.
   Unknown dynamic values collapse to `invalid`.
7. Do not scan connection or event tables, add a cross-tenant repository method, persist telemetry
   delivery state, or make telemetry part of retry/idempotency authority. The sample is deliberately
   at-most-once and lossy: a process or exporter failure after database completion can omit it.

## Consequences

Operators can measure the distribution of newly normalized event lag and detect future/invalid or
unexpectedly old source times without customer labels. Webhook and bounded recovery-sync events can
be compared using the fixed source dimension. A sample proves only that one event completed
normalization; it does not prove a connection is current, that no provider events are missing, or
that a provider with no recent business activity is stale.

The maximum defensive counter space is three provider values by three source values by four outcomes
(36 series). The histogram has at most nine defensive provider/source series. Both remain below the
existing 256-series-per-instrument limit.

The receipt timestamp is normalized evidence, not an instruction. Supported adapters normally derive
it from authenticated provider content; an ingress adapter may fall back to receipt time when the
provider event has no usable source time. Dashboards must therefore describe this as receipt
source-to-normalization lag, not universal provider clock accuracy.

## Alternatives considered

- Scan every connection for `last_successful_sync_at`: rejected because it introduces cross-tenant
  operational reads, distributed gauge ownership, and a lifecycle broader than this local signal.
- Label tenant, connection, event type, or event ID: rejected as high-cardinality customer context.
- Record every replay: rejected because queue duplication and retries would distort the
  distribution.
- Clamp future or very old timestamps into the histogram: rejected because it creates misleading
  numeric evidence.
- Persist a telemetry outbox to guarantee samples: rejected because observability delivery must not
  expand or compete with financial correctness authority.

## Security, tenant, financial, and operational effects

Only fixed provider/source/outcome values and a bounded numeric lag enter telemetry. Source
timestamp strings and all tenant/customer identifiers remain inside the authenticated processing
boundary. No cross-tenant query, organization predicate exception, RLS change, or customer metric
dimension is introduced.

No database schema, money behavior, reconciliation rule/version, permission, provider scope, durable
envelope, audit history, source write, retry/dead-letter policy, or AI behavior changes. Rollback
removes the processing metadata method and two metric records while leaving receipt authority,
normalization, persistence, and replay behavior unchanged.

## Verification

Provider-ingestion tests prove that the new processing result returns the exact receipt source
timestamp and that the compatible status-only replay remains `already_processed`. Focused
observability tests prove the inclusive 30-day boundary and all four fixed classifications.

The loopback OTLP/HTTP protobuf test observes both instrument names and all fixed outcomes. It
injects secret-like dynamic provider, source, and timestamp values; none appears in serialized
protobuf.

Evidence is recorded in
`artifacts/provider-event-freshness-observability-verification-2026-07-29.json`. This is local
processed-event evidence, not silent-connector age, provider completeness, current watermark,
protected collector/backend, threshold, alert-delivery, staging, or production evidence.
