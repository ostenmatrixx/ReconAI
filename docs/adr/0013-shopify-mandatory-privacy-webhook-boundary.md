# ADR 0013: Shopify mandatory privacy webhook boundary and raw-object erasure

Status: accepted  
Date: 2026-07-28

## Context

Shopify requires public apps to receive `customers/data_request`, `customers/redact`, and
`shop/redact` at an app-level compliance endpoint. These deliveries are signed with the app secret
and identify the shop in the authenticated payload and headers. A tenant/connection ID in a public
URL is not authorization and cannot be configured per installation for an app-level subscription.

The payload can contain customer email and phone even though ReconAI needs only provider IDs to
inventory or erase its reconciliation data. Redaction must remove implicated raw objects without
silently rewriting immutable canonical inputs, audit events, or reconciliation hashes. A legal hold
can also prohibit deletion.

## Decision

- The fixed endpoint is `/v1/webhooks/shopify/privacy`. It is available only when Shopify OAuth is
  enabled and uses the confidential Shopify app secret, not a tenant connection secret.
- The API reads at most 1 MiB of exact raw bytes, verifies `X-Shopify-Hmac-Sha256` before parsing,
  accepts only the three mandatory topics and the configured quarterly API version, and requires the
  canonical `X-Shopify-Shop-Domain` header to equal the signed payload domain.
- `shop/redact` accepts only its two documented identity fields so a captured customer request
  cannot be reclassified as a shop-wide request by changing an unsigned topic header.
- The service discards email, phone, and unknown customer fields. It persists only bounded shop,
  customer, request, and order identifiers; the raw-body SHA-256; event/topic/API version;
  received/due timestamps; and tenant authority. The due time is exactly 30 days after receipt.
- A narrowly granted `SECURITY DEFINER` resolver maps the globally unique canonical Shopify domain
  to one connection only after HMAC verification. All persistence, connection status, and audit
  writes then run with that organization’s RLS context. Unknown shops receive the same generic
  acknowledgement and cannot be used to enumerate tenants.
- New Shopify normalizer `1.1.0` records no customer email/reference in canonical data. A database
  insert trigger rejects future Shopify canonical rows containing `customerReference`. The additive
  migration does not rewrite legacy immutable rows; their presence remains an explicit privacy
  action.
- Customer redaction enqueues every Shopify raw source object tied to the supplied order IDs. Shop
  redaction enqueues every raw source object for the resolved Shopify connection. Data-access
  requests do not delete data automatically.
- The worker claims only database-authorized jobs. It conditionally deletes the exact object key and
  checksum, treats a missing object idempotently, retries with exponential backoff capped at one
  hour, dead-letters after ten attempts, and appends an immutable tenant-scoped tombstone. An
  advisory lock serializes legal-hold changes with the entire claim/delete/finalize transaction.
- Every request remains `action_required`. Raw-object deletion is not evidence that canonical
  history, exports, caches/search, telemetry, replicas, object versions, or backups were handled,
  nor that a data-access package was delivered to the merchant.
- Operational review uses the existing `retention:manage` permission, limiting the view to owners
  and administrators. A tenant-transaction repository lists at most 100 earliest deadlines per page
  through a tenant-bound keyset cursor and selects only request/connection identity, shop domain,
  topic/API version, status, bounded identifier count, timestamps, and aggregate job states.
  Customer, order, provider-event, request-ID, digest, object-key, checksum, and payload fields are
  excluded. The API repeats the allowlist before returning the response.

This follows Shopify’s current
[privacy-law compliance contract](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)
and
[app-specific webhook configuration model](https://shopify.dev/docs/apps/build/webhooks/subscribe).

## Consequences

Forged or tenant-tampered requests fail before resolution, request payloads do not create another
copy of customer email/phone, and raw deletions are bounded, tenant-scoped, legal-hold aware, and
recoverably evidenced. A privacy request intentionally makes the connector action-required so
periodic repair cannot ingest more data while an operator resolves the request.

Owners and administrators can now see deadlines and raw-erasure failures without gaining access to
the privacy subject or object-store authority. Analysts, reviewers, auditors, and foreign tenants
receive the existing concealment behavior. The surface does not mutate request state or claim
fulfillment.

The workflow is deliberately incomplete for canonical/audit disposition and data-access delivery.
Legacy canonical customer references are not mutated because doing so would invalidate pinned
reconciliation hashes. Owner/legal policy must decide whether to retain, minimize, cryptoshred, or
make affected historical runs non-replayable. Noncurrent object versions and backups require their
own verified lifecycle.

## Alternatives

Continuing to accept privacy topics on a tenant-ID URL was rejected because app-level compliance
subscriptions do not carry trusted tenant authority in that URL. Storing the full compliance payload
was rejected as unnecessary duplication of email/phone. Automatically deleting canonical or audit
rows was rejected because it would corrupt financial evidence and bypass legal policy. Treating
raw-object tombstones as complete compliance was rejected as a false assurance.

## Migration, rollback, and verification

Migrations 0036–0037 are additive: request/job/tombstone tables, forced RLS, narrow resolver and
worker functions, legal-hold serialization, role grants, and a new-insert canonical minimization
trigger. They do not backfill or rewrite customer rows. Apply them before enabling Shopify OAuth or
configuring the compliance subscription.

Rollback disables Shopify OAuth and routes traffic away from the privacy endpoint, stops the new
executor by returning to the prior worker image, and leaves request/job/tombstone evidence dormant.
Do not delete request evidence, bypass a legal hold, edit jobs, or manually clear `action_required`.
Resume with a compatible image and let an interrupted database transaction roll back before bounded
retry.

Synthetic verification covers exact-body HMAC, forged/body/header/topic/API-version negatives,
email/phone minimization, fixed API routing without client tenant IDs, RLS/role/function structure,
checksum-bound object deletion, retry/dead-letter accounting, legal-hold serialization, minimized
repository/API projection, tenant-bound cursor validation, negative tenant/role authorization,
signed-context BFF routing, multi-page operator rendering, and accessibility. Current PostgreSQL
execution of the operator repository, S3 versioned-object behavior, Shopify CLI/subscription
delivery, merchant data-package delivery, canonical disposition, external deadline-alert delivery
and response, and backup expiry remain required. Internal deadline detection is separately defined
by [ADR 0014](0014-shopify-privacy-deadline-escalation.md).
