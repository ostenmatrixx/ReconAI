# ADR 0046: Tenant-authorized source-object watermarks

- Status: Accepted
- Date: 2026-07-29

## Context

Connector health exposed connection-level last successful sync and last verified webhook times, but
the product requirement asks operators to understand freshness by source object family. A recent
connection timestamp can hide that one required family has never been observed. Conversely, a recent
object timestamp is not evidence that provider pagination was complete, normalization succeeded, or
reconciliation is correct.

Provider adapters already constrain external object types to six V1 families in immutable,
tenant-scoped `source_events`: Shopify order/refund transaction, Stripe payment
intent/refund/balance transaction, and accounting CSV row. The existing tenant-authorized
connection-health endpoint is the appropriate operator boundary. Returning dynamic object types,
record IDs, counts, external object IDs, or an environment-wide tenant locator is unnecessary.

The fixed aggregation needs an access path ordered by tenant, connection, object type, source time,
and receipt time. Building that index transactionally could block ingestion writes on a populated
table.

## Decision

1. Extend each tenant-authorized connection-health item with a fixed provider-specific
   `objectWatermarks` list:
   - Shopify: `order`, `refund_transaction`;
   - Stripe: `payment_intent`, `refund`, `balance_transaction`;
   - accounting CSV: `csv_row`.
2. Return every expected family in stable order. A family is either `never_observed` or `observed`
   with the maximum immutable source timestamp and maximum ReconAI receipt timestamp.
3. Treat the two maxima as independent watermarks; they may come from different source-event rows.
   Do not return a record ID or imply that one row owns both values.
4. Do not infer normalization success, complete provider pagination, current provider availability,
   object counts, delivery guarantees, reconciliation correctness, or financial state from a
   watermark.
5. Execute both connection and watermark queries inside the same server-derived tenant transaction
   with explicit organization predicates and forced row-level security. The API continues to require
   `financial-records:view`.
6. Query only the six literal source object types. Reject a result that references a connection
   outside the authorized connection set, contains a provider-incompatible family, repeats a family,
   contains a dynamic family, or has a malformed timestamp.
7. Validate the browser response at runtime with a strict discriminated schema. Accept at most the
   three fixed families for one connection. A malformed response renders connector health
   unavailable rather than showing partial or invented freshness.
8. Render the fixed family, latest source time, latest receipt time, or `Never observed` in the
   existing accessible connector-health table. State explicitly that a recent watermark or healthy
   connection is not a completeness or reconciliation guarantee.
9. Add migration 0048 as one restart-safe `CREATE INDEX CONCURRENTLY IF NOT EXISTS` over
   `(organization_id, connection_id, external_object_type, source_timestamp DESC, received_at DESC)`.
   The existing restricted non-transactional runner keeps the global migration lock, validates
   catalog ready/valid state, and records the checksum only afterward.

## Consequences

An authorized operator can now distinguish a never-observed required family from one with persisted
source evidence without exposing object identity or cross-tenant data. The view remains honest about
what it cannot prove.

The endpoint performs one additional fixed aggregation query. The additive covering index bounds the
access path by tenant and connection, but its build requires an O(N) concurrent scan, disk, I/O,
CPU, WAL, replica capacity, and brief start/finalization locks. Representative-volume query and
build plans remain required before production.

Source-event retention deletes immutable raw objects, not their minimized metadata rows, so the
watermark can outlive a raw payload. CSV rollback also does not erase source history. That behavior
is intentional: this is an observation-history watermark, not a statement that the record remains
eligible for a new reconciliation.

A future or provider-skewed timestamp remains visible as source evidence; the separate bounded
freshness telemetry classifies future timestamps. This endpoint does not silently clamp or convert
the source clock into health authority.

## Alternatives considered

- Keep only connection-level sync/webhook timestamps: rejected because one active family can hide a
  never-observed family.
- Return arbitrary database object types: rejected because dynamic values expand the API/privacy
  surface and make provider-family expectations non-reproducible.
- Return counts and latest object IDs: rejected because freshness needs neither customer object
  identity nor a potentially misleading completeness count.
- Derive watermarks from canonical records: rejected because that would hide accepted source events
  that have not normalized successfully and conflate intake with normalized availability.
- Mark a family complete after one observation: rejected because one record cannot prove a bounded
  backfill, provider pagination, webhook delivery, or gap repair is complete.
- Maintain mutable watermark rows during ingestion: rejected because immutable source evidence
  already supplies reproducible maxima and an additional write path would need replay/concurrency
  authority.
- Build the index in a normal transaction: rejected because a populated-table index build would hold
  a write-blocking lock for the build duration.

## Security, tenant, financial, and operational effects

The client organization ID remains a requested resource only. Membership authorization constructs
the tenant context, both queries include the organization predicate, and forced RLS remains the
database boundary. Foreign-tenant repository execution returns no connections or watermarks. The
strict merge rejects an unexpected connection even if a query or fixture is malformed.

The response contains the already-authorized connection metadata, six fixed family labels, and
timestamps. It adds no customer/order/payment/refund/accounting identifier, amount, currency,
credential, raw payload, source value, record count, or cross-tenant lookup.

No provider call, provider write, canonical record mutation, money operation, reconciliation rule,
review action, audit mutation, retention deletion, or AI behavior changes. The watermark does not
change connection status automatically.

Apply migration 0048 before the new API/web images. Prior images ignore the additive index; new
images remain functionally correct without it but can impose an unacceptable source-event scan, so
deployment must treat the migration as a prerequisite. Roll back API/web together and leave the
index in place. Do not drop it while a new image may still serve requests.

If an interrupted concurrent build leaves the same-named index invalid, the existing runner leaves
0048 unapplied. Preserve error/catalog evidence and use a reviewed forward repair to remove only the
confirmed invalid index before retrying the unchanged migration. Never insert or alter the checksum
ledger manually.

Before production, verify a restorable backup, index disk headroom, representative source-event
distribution, query plan and latency, scan/WAL/replica impact, reviewed lock/statement timeouts,
interruption/resumption, prior/new-image behavior, tenant timing, and accessible browser behavior in
the protected deployment.

## Verification

Unit tests cover stable fixed families, observed/never-observed values, foreign connection
rejection, provider/type incompatibility, duplicate/dynamic rows, and malformed timestamps. API
tests cover the permissioned response. Static migration tests cover the exact restart-safe index
statement.

The checked-in PostgreSQL integration test applies the current migration chain through the
restricted application role, verifies one observed Shopify order and one never-observed Shopify
refund family, then verifies a foreign tenant receives an empty list. It has not been executed in
this increment because no local PostgreSQL runtime or `.env` is available.

Two focused Chromium files render Shopify, Stripe, and CSV watermarks, exercise the existing
provider-sync/credential and CSV rollback paths, and pass accessibility scans. Full local source
verification and exact hashes are recorded in
`artifacts/tenant-source-object-watermarks-verification-2026-07-29.json`.
