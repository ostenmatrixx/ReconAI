# ADR 0047: Source-event object-family classification

- Status: Accepted
- Date: 2026-07-29
- Supersedes: ADR 0046 for the source-family storage/query premise and watermark read mechanism

## Context

Post-acceptance review of ADR 0046 found that its central storage premise was wrong. Provider
`source_events.external_object_type` stores immutable transport topics such as `orders/snapshot`,
`orders/updated`, `payment_intent.succeeded`, and `refund.updated`; it does not store the six
product-facing source-object families. The focused ADR 0046 mapper fixtures supplied family labels
directly and therefore did not prove the production ingestion path.

Topic-to-family projection is not always one-to-one. One authenticated Shopify order snapshot can
contain an order and zero or more refund transactions. Treating `orders/snapshot` as only `order`
hides refund observations; treating every snapshot as a refund creates observations that may not
exist. Canonical records are also insufficient source-observation authority because a valid receipt
can fail before canonical persistence.

ADR 0046 and its verification artifact remain immutable historical records. This decision corrects
the implementation forward and explicitly withdraws their claim that the original direct
`external_object_type` aggregation represented normal provider ingestion.

## Decision

1. Define one shared fixed `SourceObjectFamily` vocabulary:
   - Shopify: `order`, `refund_transaction`;
   - Stripe: `payment_intent`, `refund`, `balance_transaction`;
   - accounting CSV: `csv_row`.
2. Keep the provider event topic unchanged in `source_events.external_object_type`. Do not overload
   a transport/version field with a product-facing family.
3. Add tenant-owned `source_event_object_classifications`, keyed by
   `(organization_id, source_event_id)`, with one non-empty, duplicate-free array of at most three
   fixed families, classifier version `source-object-family-v1`, a tenant-composite foreign key,
   forced RLS, and append-only database enforcement.
4. Classify only after provider authentication and exact payload/schema validation:
   - Shopify order create/update maps to `order`;
   - Shopify refund create maps to `refund_transaction`;
   - Shopify order snapshot parses the immutable payload and maps to `order` plus
     `refund_transaction` only when refund transactions exist;
   - supported Stripe payment-intent and refund events map from the validated object discriminator;
   - a committed CSV row maps to `csv_row`.
5. Persist the provider receipt, classification, and durable outbox in one tenant transaction.
   Persist CSV source rows, classifications, canonical rows, and provenance in the existing atomic
   import-completion transaction. A replay must find the same immutable family array or fail.
6. Restrict the database array to the exact V1 shapes: each singleton family or Shopify
   `[order, refund_transaction]`. Validate the same uniqueness, fixed order, and provider
   compatibility in application code. A Shopify receipt cannot claim a Stripe family and vice versa.
7. Read watermarks by joining tenant-scoped classifications to their tenant-scoped source events and
   unnesting the fixed family array. Continue to compute independent maximum source and receipt
   timestamps; no record identifier or count is returned.
8. Separately detect every operational source event on an authorized connection that has no
   classification. Exact Shopify privacy topics are outside this operational family view. If any
   operational event is unclassified, return every expected family for that connection as
   `classification_unavailable`; do not mix known observations with a misleading never-observed
   claim.
9. Keep the stable expected family list. When classification coverage is complete, each family is
   either `never_observed` or `observed`. The browser strictly validates all three states and labels
   the unavailable state explicitly.
10. Migration 0049 creates only the classification schema and security boundary. It deliberately
    does not infer or backfill legacy events: an unprocessed legacy Shopify snapshot cannot be
    classified from its topic, and a migration must not perform an unbounded object-store payload
    scan.
11. Retain migration 0048 as an additive raw source-event connection/topic/time access path. It
    cannot by itself prove a product-facing family and is no longer the family authority.
12. The current Stripe adapter does not ingest balance transactions. Keeping `balance_transaction`
    in the expected list exposes that absence as never observed; it does not claim the missing
    processing-fee source path exists.

## Consequences

The operator view is now tied to evidence normal ingestion actually writes. A multi-family Shopify
snapshot is represented without duplicating or mutating its immutable receipt, and raw receipt
freshness remains separate from canonical availability.

One small append-only row is added per operational source event. Provider and CSV commits gain one
write and the read model gains a classification join plus a conservative unclassified-event check.
Representative source-event distribution, query plans, latency, storage growth, and write contention
remain required before production.

An old writer running after migration 0049 can still create a source event without a classification.
The new reader exposes this as `classification_unavailable`; it never silently treats the event as
absent. Because no staging or production deployment exists, the first protected deployment must
apply 0049 before admitting traffic and must start only classification-aware API and worker images.
Future upgrades with existing data require a separate bounded, checksum-verified classification
repair before a complete-watermark claim.

The table does not repair pre-0049 development data automatically. Synthetic environments may be
reset and re-ingested. Operators must not insert a classification manually from a Shopify snapshot
topic alone.

## Alternatives considered

- Continue aggregating `source_events.external_object_type`: rejected because provider rows contain
  event topics, not family labels.
- Rename provider topics to fixed families on receipt: rejected because it destroys versioned
  transport evidence and cannot represent a multi-family snapshot.
- Derive families only from canonical records: rejected because failed or pending normalization
  would be hidden from source-observation evidence.
- Infer every Shopify snapshot as order plus refund: rejected because a snapshot can contain no
  refund transaction.
- Store one classification row per family: rejected because the completeness of a multi-family
  classification would be ambiguous during partial writes. One immutable array records the complete
  classifier result atomically.
- Backfill all legacy receipts in migration 0049: rejected because topic-only snapshot inference is
  unsound and an unbounded payload scan/write transaction is operationally unsafe.
- Hide a classification gap and retain known family timestamps: rejected because an unknown event
  can change any family watermark.

## Security, tenant, financial, and operational effects

The classification table has a non-null tenant key, a tenant-composite source-event foreign key,
forced RLS, explicit organization predicates, append-only triggers, and only `SELECT`/`INSERT` for
the application and worker roles. It stores fixed labels, classifier version, source-event
reference, and database time—no customer object ID, amount, currency, credential, raw payload,
external account, or cross-tenant locator.

The connection endpoint still requires `financial-records:view`, resolves membership-derived tenant
authority, and executes connection, classified watermark, and gap queries in one tenant transaction.
Strict mapping rejects foreign-result connection IDs, provider-incompatible/dynamic or duplicate
families, malformed timestamps, non-positive/duplicate gap rows, and incomplete browser shapes.

No provider write, money mutation, reconciliation rule, review decision, audit history, retention
deletion, or AI behavior changes. Classification is not normalization success, pagination
completeness, provider availability, reconciliation correctness, or financial authority.

Apply 0049 before the new API/worker images and admit no old writers afterward. A code rollback may
leave the additive table in place. Do not drop it while a new writer or reader can run. Before a
future production upgrade with data, inventory unclassified events, design a bounded
object-integrity-checked repair, rehearse interruption/retry, verify backup and disk/WAL headroom,
and require zero gaps before claiming complete classification coverage.

## Verification

Shared ingestion tests cover authenticated Shopify order, multi-family Shopify snapshot, and Stripe
payment classification. API unit tests cover fixed observed/never states, provider/dynamic/
duplicate/timestamp rejection, a connection-wide unavailable state, and foreign gap rejection.
Static migration tests cover the tenant FK, fixed allowlist, no automatic backfill, forced RLS,
append-only trigger, and least-privilege grants.

Checked-in PostgreSQL integration paths now assert provider and CSV classification persistence,
foreign-tenant concealment, and mutation denial, but they have not been executed in this increment
because no local PostgreSQL runtime or `.env` is available. Focused Chromium renders the unavailable
state without inventing never-observed freshness. Full source and browser results are recorded in
`artifacts/source-object-classification-correction-verification-2026-07-29.json`.
