# ADR 0038: Bounded provider-ingestion observability

- Status: Accepted
- Date: 2026-07-29

## Context

ReconAI verifies Shopify and Stripe webhook authenticity before parsing, persists immutable receipts
and outbox authority, and normalizes supported events in a durable worker. Existing API and worker
metrics did not distinguish provider ingress failures from downstream normalization failures.
Operators therefore lacked a low-cardinality way to tell whether signed traffic was rejected,
accepted or deduplicated, or whether an authorized durable event was processed, unsupported,
invalid, or retryable.

Provider telemetry cannot expose tenant, connection, event, object, request, credential, payload, or
error-message data. It also cannot become an authorization source, change acknowledgement behavior,
delay durable work, or make provider content authoritative.

## Decision

1. Derive webhook telemetry only from the fail-closed API route-security manifest. The four fixed
   surfaces are `shopify_connection`, `shopify_privacy`, `stripe_connection`, and
   `stripe_deauthorization`; their providers are fixed by code. An unknown or dynamic surface emits
   no provider-ingress metric.
2. Start the observation before rejection-capable Fastify plugins and finish it at response
   completion or request abort. Record `reconai.provider.webhook.ingress.requests` with only
   provider, fixed surface, and one response-derived outcome:
   - `202` and other successful non-`200` responses: `accepted`;
   - `200`: `duplicate`;
   - `401`: `authentication_failed`;
   - `400`, `413`, or `415`: `validation_failed`;
   - `409`: `evidence_conflict`;
   - `429`: `rate_limited`;
   - `503`: `dispatch_unavailable`;
   - abort/no status: `aborted`;
   - every other response: `failed`.
3. Deliberately aggregate missing authority, secret resolution, and invalid provider signature as
   `authentication_failed`. Telemetry must not reveal whether an organization, connection, shop,
   account, installation, or secret exists.
4. Begin normalization telemetry in the worker only after the common durable-envelope hash,
   PostgreSQL outbox authority, tenant, job identity, correlation, and requester checks succeed.
   Record `reconai.provider.normalization.runs` and `reconai.provider.normalization.duration` with
   only provider, a fixed source, and a fixed outcome.
5. Derive source only from exact internal requester values: `<provider>-webhook-ingress` becomes
   `webhook`, `<provider>-sync-worker` becomes `sync`, and everything else becomes `invalid`.
6. Preserve the worker's returned `processed` or `already_processed` result. Map the five stable
   terminal codes to `receipt_not_found`, `authority_mismatch`, `object_invalid`, `payload_invalid`,
   or `event_unsupported`. Unknown terminal codes collapse to `failed_terminal`; every non-terminal
   thrown error becomes `failed_retryable`.
7. Defensively collapse unknown provider/source/outcome values to fixed fallback values. Never use
   event type, HTTP path, tenant, connection, receipt, object, job, correlation, requested-by,
   provider error, or payload values as metric attributes.
8. Telemetry remains lossy and non-authoritative. Export failure never changes HTTP status,
   persistence, retry, dead-letter, normalization, reconciliation, approval, or source-system
   behavior. API metrics retain cumulative temporality and worker metrics retain delta temporality.

## Consequences

Operators can separate authentication/validation/dispatch pressure at ingress from authorized worker
normalization outcomes. The maximum intended ingress space is four surfaces by nine outcomes; the
maximum defensive normalization space is three provider values by three sources by nine outcomes.
Both remain below the existing 256-series-per-instrument limit without customer dimensions.

Response-derived ingress outcomes intentionally describe the public boundary rather than internal
exception classes. A `202` proves only durable acceptance, not successful normalization. A `200`
means the immutable receipt was already accepted. Normalization duration begins after durable
authority and does not measure provider delivery latency or end-to-end freshness.

The API observation hooks now precede plugins that can reject a request, so rate limits, body/media
validation, and handler results can be counted. Existing API security contracts, response bodies,
status codes, and provider acknowledgement behavior are unchanged.

## Alternatives considered

- Label raw route paths, event types, tenant IDs, connection IDs, or provider error text: rejected
  because these are unnecessary, high-cardinality, existence-revealing, or customer-controlled.
- Emit only generic API and durable-job metrics: rejected because they cannot isolate provider
  verification from authorized normalization.
- Record a successful webhook only after normalization: rejected because provider acknowledgement
  and durable asynchronous processing are separate correctness boundaries.
- Start normalization timing before outbox authorization: rejected because untrusted queue content
  must not create provider-attributed operational evidence.
- Treat telemetry loss as readiness or job failure: rejected because monitoring cannot authorize or
  interfere with financial work.

## Security, tenant, financial, and operational effects

No organization, user, connection, shop, account, event, object, job, correlation, credential,
amount, currency, raw URL, payload, or error message is exported by these instruments.
Authentication failures remain indistinguishable across missing and invalid authority. Unknown
dynamic values are suppressed or collapsed before export.

No database schema, tenant query, RLS policy, money behavior, reconciliation rule/version,
permission, provider scope, durable envelope, audit history, source write, or AI behavior changes.
Rollback removes the observations and leaves webhook verification, durable receipt persistence,
normalization, retry, and dead-letter behavior unchanged.

## Verification

Focused typechecks cover observability, API, and worker packages. Route-contract tests prove that
only the four provider-signature routes map to the four fixed surfaces. API tenant/security tests
exercise existing webhook response and authorization behavior after the earlier observation hook
placement.

The loopback OTLP/HTTP protobuf test exports every ingress surface/outcome and every normalization
outcome, validates the three instrument names, and injects secret-like dynamic surface, provider,
source, and outcome values. None of those dynamic values appears in captured protobuf bytes.

Evidence is recorded in `artifacts/provider-ingestion-observability-verification-2026-07-29.json`.
This is local component evidence, not a protected provider, collector/backend, dashboard, threshold,
alert-delivery, freshness, sustained-load, staging, or production result.
