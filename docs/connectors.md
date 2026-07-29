# Connector architecture

## Current implementation boundary

Goal 1 currently implements authenticated Shopify/Stripe webhook ingress, duplicate receipts,
out-of-order canonical version selection, immutable checksummed S3-compatible payload storage,
transactional outbox relay, idempotent worker normalization, fixed app-level Shopify privacy intake,
connection freshness timestamps, a bounded two-phase Stripe Events/charge-balance-transaction page
adapter and operator-requested backfill/gap repair, a bounded Shopify Admin GraphQL order/refund
snapshot adapter using the same durable run authority, accounting CSV upload/preview/commit, and
administrator rollback-by-supersession. Stripe and Shopify recovery have
cursor/window/page/byte/time bounds, immutable run/outbox authority, version capture, and synthetic
adapter/service/API/browser plus live-PostgreSQL evidence. An opt-in periodic scheduler creates
bounded, tenant-bound repair runs for due read-authorized connections using a distinct service actor
and the same outbox pipeline. Provider OAuth installation, bounded refresh rotation, Shopify
provider-first uninstall, and Stripe signed app-deauthorization handling are implemented and
disabled by default. Per-organization, disabled-by-default raw import/provider object retention is
implemented with legal hold, checksum/ETag-bound conditional deletion, bounded retry/dead-letter
state, and immutable tombstones. CSV rollback and retention have passing live PostgreSQL evidence,
while the Redis durable-queue and S3-compatible immutable-object contracts also pass live.
Authorized provider sandbox execution, a distributed provider rate control, and
whole-tenant/canonical privacy completion remain unverified. The OAuth and Shopify privacy
migrations/repositories now pass the current live PostgreSQL integration graph; mandatory provider
subscription, external alert delivery, and end-to-end merchant privacy fulfillment remain
unverified.

OAuth and operator-installed credentials use tenant/connection/provider/purpose-bound AES-256-GCM
envelopes with a versioned keyring, forced-RLS append-only lifecycle records, replay-safe atomic
rotation, server-only resolution, redacted metadata, and exact-confirmation disconnect. Raw OAuth
state lives only in an encrypted HttpOnly BFF transaction cookie; the API stores its digest in a
single-claim tenant authorization attempt issued for ten minutes and capped at 15. Legacy
allowlisted environment references remain supported.

## Shared contract

Every connector implements versioned metadata, least-privilege read capabilities, authorization/
disconnect, bounded backfill and cursor sync, webhook/poll ingestion where available, normalization,
health/freshness, error classification, and provider privacy deletion. Provider adapters expose no
V1 financial mutation method.

`ConnectorContext` contains a server-authorized tenant, connection, correlation, clock, object
store, outbox, rate limiter, and redacted telemetry. A connector may not accept client tenant
authority or construct an unscoped object/cache key.

Raw events are authenticated before parsing where relevant, deduplicated by connection plus provider
event identity, stored immutably, and acknowledged quickly after transactional receipt. Workers
process at least once and idempotently. Scheduled gap repair supplements webhooks through a
disabled-by-default, bounded service-authorized scheduler.

The scheduler admits only Shopify/Stripe connections in healthy, degraded, or stale state with a
separate read credential, excludes active/backfilling/disconnected/action-required work, and creates
only `gap_repair` runs. Cadence, lookback, overlap, pages, and scan batch are validated;
cadence-slot idempotency plus a per-connection advisory lock prevents duplicate or concurrent run
authority. It never calls a provider directly.

## Shopify read-only

- OAuth authorization uses a 256-bit state digest, exact fixed callback, Shopify HMAC/timestamp/shop
  verification, minimum configured read scopes, bounded code exchange, encrypted expiring offline
  access/refresh tokens, shop-domain canonicalization, and replay-safe callback claiming.
- The implemented operator-requested recovery adapter accepts only one canonical `*.myshopify.com`
  label, constructs an HTTPS Admin GraphQL endpoint from a pinned quarterly API version, rejects
  redirects, and fails closed unless `X-Shopify-API-Version` matches the configured version.
- It queries orders by `updated_at` with `UPDATED_AT` sort and forward cursors for a positive window
  of at most 30 days. A page contains at most 100 orders, each refund snapshot contains at most 100
  transactions, a run contains at most 100 pages/10,000 order snapshots, the response ceiling is 2
  MiB, the item ceiling is 1 MiB, and the request timeout is ten seconds.
- The recovery projection omits customer email, addresses, notes, line items, and payment details;
  it captures only stable order/refund identifiers, timestamps, financial state, shop-currency
  amounts, and refund transaction status/gateway required by deterministic reconciliation.
- GraphQL/HTTP authentication, authorization, throttle, provider, timeout, version, cursor, and
  payload failures have stable classifications. Throttle retry delay uses returned query-cost state;
  nested refund transaction pagination is rejected rather than silently truncating.
- Each versioned order snapshot enters the immutable provider receipt/object/outbox path. Stable
  legacy order and refund-transaction identities align snapshot records with webhook records, while
  `updatedAt` and the API version make changed snapshots new immutable provider events.
- HMAC verification over exact raw request bytes using constant-time comparison before JSON parse.
- Unique webhook receipt, out-of-order source timestamps, fast response, durable queue, bounded
  retries/DLQ, and versioned payload/normalizer.
- The fixed app-level `/v1/webhooks/shopify/privacy` endpoint verifies the app-secret HMAC before
  parsing and accepts only the three mandatory privacy topics, configured API version, and a
  canonical shop header equal to the signed payload. A narrow post-authentication shop resolver
  supplies tenant authority; no client organization/connection ID is accepted.
- Privacy persistence discards customer email/phone and unknown fields, bounds provider IDs, records
  a 30-day due time, and makes the connection action-required. Customer/shop redaction creates
  checksum-bound raw-object erasure jobs with legal-hold serialization, retry/dead-letter state, and
  immutable tombstones. An owner/administrator-only Security & retention view shows minimized
  deadline, durable seven-day/24-hour/overdue escalation, and aggregate job-state metadata without
  customer/order/event/digest/object-key fields. A bounded worker monitor creates each escalation
  once inside exact tenant context and emits aggregate logs only.
- A dual-authorized, reasoned `customers/data_request` action assembles at most 100 linked
  Shopify/Stripe raw records plus sanitized normalized projections into a checksum-verified JSON
  package of at most five MiB. It excludes shared accounting CSV objects and internal object/digest
  authority and fails without partial output. A random 256-bit, digest-only-at-rest receipt token
  expires after ten minutes; the same active membership must acknowledge the complete browser bytes
  before download. One append-only receipt and audit event are idempotent and retain
  `not_delivered`. External alert delivery, secure merchant/customer transfer and recipient
  acknowledgement, downloaded-copy expiry, over-limit export, legacy/canonical disposition,
  noncurrent versions, caches/search/exports, replicas, and backups remain incomplete.
- Periodic orders/transactions/refunds gap scan and freshness by source object family.

Near-expiry OAuth credentials refresh under a tenant database lock; account and scope drift are
rejected, replacement refresh tokens rotate into a new encrypted generation, and ambiguous
provider-success/local-commit failures are not automatically retried. Disconnect invokes Shopify's
lifecycle-only `appUninstall` mutation over the fixed Admin GraphQL origin before revoking local
credentials. If provider success is followed by local cleanup failure, provider authority is already
removed but the unusable local encrypted token needs reasoned operator cleanup.

Exact scopes, protected customer-data access, the provider's default historical-order visibility,
and API versions still require an owner-reviewed provider configuration and contract test against a
Shopify development store before production enablement.

## Stripe read-only

- Stripe Apps OAuth uses a 256-bit state digest, exact fixed callback, bounded code exchange and
  refresh, encrypted access/refresh tokens, server-recorded live/test mode and authorization
  generation, and permissions constrained by the reviewed app manifest.
- The implemented recovery adapter first lists the fixed Stripe Events endpoint and then lists
  charge balance transactions on the fixed balance-transactions endpoint. Both phases support
  `starting_after`, share the recorded positive window, allow at most 100 items per page and 100
  total pages per run, and reject windows over 30 days, redirects, oversized responses, or cursor
  stalls.
- The balance phase requests `type=charge` and expands only `data.source`. ReconAI persists a
  versioned minimized transaction plus Charge ID/PaymentIntent reference, strips unrelated
  customer/billing fields, validates safe integer minor units and `amount - fee = net`, and
  normalizes total Stripe fee without currency conversion.
- Stripe App permission `balance_transaction_source_read` and its implied read permissions require
  explicit owner review before enablement. A Charge without a PaymentIntent is retained as
  incomplete rather than guessed. Interchange-plus fee retrieval is outside the supported V1
  contract.
- Every recovered event is deduplicated and staged through the immutable provider receipt/outbox
  path. Runs stop partial at their operator-selected page ceiling and fail terminally after six
  recorded transient attempts.
- `Stripe-Signature` verification using the exact raw body, endpoint secret, signed timestamp,
  constant-time library implementation, and bounded tolerance.
- Unique `(connection, event_id)`, fast acknowledgement after receipt, durable async processing,
  out-of-order-aware object versioning, retries/rate handling/DLQ, and freshness.
- Never ingest/store PAN, CVC, magnetic data, authentication credentials, or unnecessary billing
  details. Use payment/refund/balance-transaction fields required for reconciliation only.

The connection webhook signing secret reference, app-level deauthorization signing secret, and read
API credential are three distinct authorities. The resolver accepts tenant-bound sealed references
and injected `env:RECONAI_CONNECTOR_*` references.

Stripe Apps cannot be uninstalled programmatically. An administrator disconnect therefore clears
ReconAI's read reference/cursor, marks the connection `action_required`, and returns only the fixed
Stripe app-settings URL. The user uninstalls the app there. ReconAI finalizes disconnection only
after exact-raw-body verification of a signed `account.application.deauthorized` event whose
account, live/test mode, and occurrence time match the current authorization generation. The event
and payload digest are append-only and exact replay is idempotent. Unknown, wrong-mode, or stale-
generation events receive a generic acknowledgement and cannot revoke another tenant or a later
authorization.

A replay against a row that was already locally `disconnected` reports provider confirmation as
`not_recorded`; it does not infer provider state from a legacy/local status value.

Production enablement still requires an approved secret-manager/KMS operating model, app permission
review, an authorized Stripe sandbox contract run, reachable webhook routing, synchronized clocks,
and alerts for refresh/disconnect failure states.

Every Shopify/Stripe recovery page uses a required Redis-backed circuit scoped to environment,
provider, tenant, and connection. The worker acquires a random-token permit before the read request;
three consecutive rate-limit, timeout, or provider-unavailable results open the circuit by default,
rate limits open it immediately, and only one replica receives the half-open probe. Authentication,
authorization, terminal request, invalid payload, and local validation failures release a probe
without classifying the provider as unavailable. Redis admission failure suppresses the provider
request and retries the durable job. Worker delay is the larger of bounded exponential backoff and
validated provider retry-after guidance, capped at 15 minutes. The circuit cannot create work,
change a window/cursor, mark success, or write to the provider. See ADR 0045.

## Accounting CSV

- No archives in V1. Enforce byte/row/column/field limits before expensive processing; allowlisted
  CSV MIME/extension plus content sniffing; UTF-8 policy; streaming parser; explicit delimiter/
  decimal/date/currency mapping; versioned template.
- Upload to a private tenant quarantine key with checksum. Preview validates schema and reports
  bounded row-level errors without committing canonical records.
- Commit is idempotent by organization + checksum + template/mapping version. It creates immutable
  raw row events and canonical accounting entries transactionally. Rollback supersedes imported
  canonical versions and records audit; it does not erase audit evidence.
- Export prefixes fields beginning `=`, `+`, `-`, `@`, tab, or carriage return, quotes correctly,
  uses a fixed safe filename/content disposition, and never exports fields without permission.
- Unsupported/ambiguous locale, precision, currency, or identifiers remain row exceptions; no
  guessed financial value is accepted.

## Health model

Connection health is intended to combine authorization state, backfill status/watermark, last
verified webhook, last successful scheduled sync, provider lag/freshness by object type,
rate-limit/circuit state, retry/DLQ counts, connector/API/normalizer versions, and a redacted latest
error code. States are healthy, backfilling, degraded, stale, disconnected, and action required;
labels include text/icon. The current operator surface does not yet expose ephemeral circuit state:
fixed aggregate circuit decisions/transitions and provider-sync outcomes are available to telemetry,
while tenant-specific investigation remains through authorized connection and sync-run views. The
tenant-authorized connection view exposes a stable fixed-family list backed by an immutable
classification written with the source receipt: Shopify order/refund transaction, Stripe payment
intent/refund/balance transaction, and accounting CSV row. With complete classification coverage,
each family has latest persisted source/receipt timestamps or `never_observed`. Any unclassified
operational receipt makes every family on that connection `classification_unavailable`; the view
does not mix partial evidence with an absence claim. These are immutable-intake watermarks, not
normalized-record, pagination-completeness, provider-availability, or reconciliation claims. A
successfully persisted Stripe balance snapshot can now make `balance_transaction` observed, but that
timestamp still does not prove the two-phase run completed, async provider data is final, or every
fee is available.

Migration 0051 and ADR 0051 provide the only supported legacy-gap repair. A dedicated maintenance
role claims one allowlisted receipt at a time, verifies the immutable object key and SHA-256 under
fixed size/deadline limits, applies the exact live classifier, rechecks all receipt identity, and
atomically appends classification plus tenant audit. Unsupported operational topics remain visible
and block a complete-coverage claim. This repair does not change connector scopes, contact a
provider, normalize money, or establish provider/source completeness.

Migration 0052 and ADR 0052 add a disabled-by-default, one-way database writer fence. Activation
waits for in-flight source transactions and requires zero missing, unsupported, or incompatible
operational classifications. After activation, provider and CSV receipt writers must append their
exact V1 classification in the same transaction or the entire transaction rolls back; exact Shopify
privacy topics remain exempt. The fence is a deployment-integrity boundary, not a connector
freshness or completeness signal, and an active database cannot safely run a pre-classifier image.

## Connector test kit

Each official connector must pass contract suites for authorization boundaries, pagination/cursors,
rate limits, timeouts, retry classification, signature/authentication, duplicates, reordering,
updates, malformed/oversized payloads, provenance, normalization versions, gap repair, disconnect,
privacy deletion, telemetry redaction, and cross-tenant isolation. Fixtures are synthetic or
provider-sandbox recordings reviewed for credentials and personal/financial data. Current
balance-transaction coverage is synthetic/source-defined; an authorized Stripe sandbox contract run
remains required.
