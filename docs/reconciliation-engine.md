# Deterministic reconciliation engine

## Contract

The engine is a pure, versioned function from a tenant-bound immutable input snapshot plus policy to
matches, exceptions, candidate proposals, counts, and trace evidence. With AI disabled, equal
canonical record versions, policy, rules, and ordering-independent snapshot identity produce
byte-equivalent semantic results.

AI output is never an engine input to deterministic match/exception decisions.

Current implementation versions are engine `0.7.0` and rule set `1.5.0`. Exact order/payment, fee,
refund, and accounting lookups use deterministic indexes rather than pairwise full scans. Canonical
records with malformed identity-bearing fields emit explicit evidence and are excluded from all
automatic identity, duplicate, candidate, fee, refund, and accounting matching for that run.
Refund/accounting comparison creates an exact artifact for either a unique one-refund/one-entry
relationship or one complete conserved positive split bucket under a strong transaction reference;
competing, reused, non-conserving, and overflowing candidates fail closed. Ambiguous payment
candidate evaluation scores the complete amount-window population only when it contains at most 500
records and emits at most five candidates. A larger population produces an explicit high-severity
ambiguity with exact search counts and no partial shortlist.

## Rule pipeline

1. Validate record completeness, identifiers, timestamps, integer amounts, and ISO currencies.
2. Detect duplicate source objects and semantically duplicate canonical records.
3. Exact external-ID match (provider metadata/link identifiers).
4. Deterministic composite-key match (approved normalized order/payment/refund/accounting keys).
5. Validate amount and currency.
6. Validate effective date and customer evidence.
7. Apply captured, bounded organization tolerance and delayed-event grace policy.
8. Generate weighted ambiguous candidates using declared features.
9. Optionally rank/explain ambiguous candidates through the controlled AI interface.
10. Produce human-review proposals; never auto-approve ambiguous or conflicting evidence.

Exact identifiers do not override a currency/amount conflict; they prove relationship while the
conflict becomes an explainable exception.

## Money and aggregation

All arithmetic uses `bigint` minor units. An order may have multiple payments; a payment may cover
multiple records only if the provider evidence and a versioned rule explicitly support it.
Payments/refunds/fees are aggregated with checked currency equality and safe 64-bit database bounds.
Partial refunds compare cumulative eligible refund amounts and per-refund linkage. Taxes, discounts,
fees, reversals, and provider updates are separate facts, not silently netted.

Default tolerance is zero. A configured amount tolerance is expressed in minor units per currency
and cannot cross currencies. Date windows are integer durations interpreted around normalized UTC
instants with an explicit business time zone.

## Malformed identifiers

The provider-neutral `record-identifier-format` rule inspects provenance external object IDs and
every present canonical external/order/customer/provider-order/payment/refund/transaction reference.
It rejects surrounding Unicode whitespace, C0/C1 controls, line/paragraph separators, bidirectional
controls, soft hyphen, zero-width space, word joiner, byte-order mark, Unicode replacement
characters, and unpaired UTF-16 surrogates. Visible Unicode, ordinary interior spaces, ZWNJ/ZWJ, and
provider-specific reference shapes remain valid.

One unsafe field quarantines the whole record from deterministic matching. The record remains in the
immutable input count and content-addressed snapshot and receives a high-severity
`malformed_identifier` exception. Safe counterparts can independently receive their normal
missing-side exceptions. Field evidence escapes unsafe code points and boundary whitespace before
display while preserving source and reference-normalized representations and machine-readable issue
codes. See ADR 0026.

Accounting CSV rows that fail mapping, syntax, type, or supported-value validation never become
canonical records. `invalid_csv_row` and `unsupported_csv_row` therefore remain bounded import
preview/commit outcomes rather than fabricated reconciliation exceptions.

## Refund/accounting cardinality

An eligible accounting entry has entry type `refund`, equal currency, amount within the captured
tolerance, and a normalized external/refund/order reference match. Reference/currency indexes are
sorted by integer minor amount, so binary range lookup avoids a pairwise scan. A unique candidate
used by one Shopify refund creates a `refund-accounting` match with immutable record versions,
money/tolerance evidence, rule version, and reason `REFUND_ACCOUNTING_ENTRY_MATCHED`.

Zero candidates emits `refund_missing_accounting_entry`. Multiple candidates or reuse of one entry
across refunds emits `REFUND_ACCOUNTING_IDENTITY_AMBIGUOUS`; the engine never selects the first
record. At most 500 candidates are evaluated for one refund. A larger range emits
`REFUND_ACCOUNTING_CANDIDATE_SET_EXCEEDS_LIMIT` with a conservative count lower bound and no match.
Every lookup key used by an overflowing refund is tainted across that refund’s amount interval so a
different reference cannot make hidden reuse look unique.

Rule set 1.5.0 also permits one bounded split form: 2–50 positive `refund` accounting rows in one
currency and one complete normalized transaction-reference bucket exactly matching the refund
external ID or refund reference. The complete bucket is summed with checked integer money and must
match within the captured currency tolerance. The engine never chooses a subset or auto-sums an
order-reference-only group. Competing one-row evidence, multiple populated strong references,
non-positive rows, an out-of-range total, more than 50 rows, or any cross-refund row reuse fails
closed. See ADRs 0027 and 0029.

## Core V1 rules

- Paid order without linked/summed succeeded Stripe payment.
- Succeeded Stripe payment without a linked Shopify order.
- Linked order/payment amount or currency mismatch.
- Shopify refund without a linked succeeded Stripe refund.
- Stripe/Shopify refund without matching accounting entry after import and grace window.
- Linked refund amount/currency/partial-cumulative mismatch.
- Duplicate order/payment/refund/processing-fee/accounting entry.
- Missing Stripe fee after configured settlement grace.
- Missing/malformed identifier and incomplete source record.
- Invalid/unsupported CSV row as a pre-canonical import validation outcome, not a reconciliation
  artifact.
- Delayed record state when the grace policy has not expired.
- Ambiguous identity when deterministic candidate keys are non-unique/inconsistent.

Each rule has a stable ID, semantic rule version, supported record/schema versions, deterministic
ordering, and test vectors. Any behavioral change updates the rule-set version.

## Evidence

For each comparison record:

- source record IDs/versions and provenance;
- source and normalized values;
- rule ID/version and rule-set version;
- comparison operator and bounded tolerance;
- date/time-zone/grace policy;
- result and machine-readable reason codes;
- deterministic confidence class (not fabricated probability);
- calculation timestamp and engine version.

Human-readable explanations are rendered from reason codes and evidence. Optional AI explanations
are labeled suggestions and cannot hide/replace the deterministic evidence.

Current stored rule evidence is accepted only through the strict bounded `RuleEvidenceSchema`.
Unknown fields, malformed UUID/version/hash identity, inconsistent comparison cardinality, oversized
values, invalid integer tolerance, and mismatched candidate-search counts fail closed. The two
accounting overflow modes retain distinct 500-entry candidate and 50-entry split limits.

The operator read model is a separate `deterministic-evidence-view-v1`, not the stored JSON. It
contains only paired source/normalized comparisons, rule/rule-set/result/reason, record
count/truncation, optional tolerance, bounded search summaries, and evaluation time. Unsupported,
future, legacy, malformed, or inconsistent evidence produces only
`EVIDENCE_UNSUPPORTED_OR_MALFORMED`. Safe kind-specific canonical values and field provenance are
also strict; lineage is all-or-nothing, raw source references are omitted, and exception references
are displayed only when their unique stored set exactly equals tenant-resolved source records. See
ADR 0058 and `artifacts/typed-investigation-evidence-verification-2026-07-29.json`.

## Stable identity and replay

The input snapshot identity hashes sorted `(canonical_record_id, version, content_hash)` tuples plus
source watermarks. A run key includes organization, snapshot, policy, rule-set, and engine version.
A match/exception key includes organization, taxonomy/rule, and sorted participating record versions
(or a stable missing-side key). Cryptographic hashes provide identity, not authorization.

Database unique constraints and upserts insert one run occurrence/artifact. New workers also insert
one immutable `artifact-occurrence-v1` snapshot containing the exact rule/type/version, references,
evidence, observed state, and capture time. Replay verifies equality with an existing snapshot and
fails closed on disagreement. Existing approvals and audit events are referenced, not copied.
Changed source or rules may supersede an exception but history remains.

Worker completion is serialized per organization and ordered by immutable run creation time plus
UUID. Only the newest successful snapshot may update the live exception queue. An older snapshot
that completes late remains a successful reproducible historical result and stores occurrences, but
cannot overwrite newer exception state. The database enforces one current operational run marker,
and append-only exception status events preserve first-observed, superseded, and re-observed
transitions.

The API can compute this identity without executing rules, allowing one transaction to pin the
complete input and JSON-safe policy snapshot before publishing work. The worker recomputes the
record hashes and complete identity before execution. A mismatch is a terminal bounded error, not a
best-effort run. Recovery replay increments the dispatch authority but reuses the same run identity,
input rows, and policy snapshot.

Run detail previews the first 100 pinned input identities. Operators can traverse the complete
immutable set through tenant/run-bound ordinal keyset pages of at most 100. Each row preserves
canonical record UUID, version, content SHA-256, and ordinal; the cursor is navigation state only,
and authorization plus forced RLS are reapplied for every page. Local functional and browser
evidence covers 102 inputs; see
`artifacts/reconciliation-input-lineage-pagination-verification-2026-07-29.json`. A separate fresh
PostgreSQL 17.10 exercise covers the maximum 100,000-record boundary with concurrent 100-row and
97-row readers both in-process and in two independent restricted-role processes. All four readers
produce one identical complete-set digest with continuous ordinals; the run also confirms index use,
RLS concealment, and cursor scope rejection. It is a local single-host measurement, not an SLO or
staging-capacity claim; see
`artifacts/reconciliation-input-pagination-maximum-volume-verification-2026-07-29.json`.

The heavy verifier is intentionally excluded from the routine test gate. Run it only against a fresh
migrated loopback database using the restricted `reconai_app` URL and explicit synthetic-write
opt-in:

```sh
RECONAI_ALLOW_LOCAL_VERIFICATION_WRITES=1 \
RECONAI_INPUT_PAGINATION_RECORDS=100000 \
DATABASE_ADMIN_URL=postgresql://... \
DATABASE_URL=postgresql://reconai_app:... \
pnpm verify:reconciliation-input-pagination
```

It requires a disposable database whose name includes `test`, `verify`, `verification`, or
`pagination`, leaves its synthetic tenant in that database, and must never target staging or
production.

Run creation persists the immutable ledger in deterministic 1,000-row batches inside the existing
run/outbox/audit transaction. At six parameters per row, every full statement uses 6,000 parameters
and the 100,000-record ceiling requires 100 input inserts. A separate heavy verifier exercises the
actual repository path:

```sh
RECONAI_ALLOW_LOCAL_VERIFICATION_WRITES=1 \
RECONAI_RUN_CREATION_RECORDS=100000 \
DATABASE_ADMIN_URL=postgresql://... \
DATABASE_URL=postgresql://reconai_app:... \
pnpm verify:reconciliation-run-creation
```

It requires a fresh migrated loopback database whose name includes `test`, `verify`, `verification`,
or `run_creation`. It seeds schema-valid synthetic canonical orders, deliberately omits customer
references and field-provenance rows, leaves one queued run for inspection, and must never target
staging or production. Fresh PostgreSQL 17.10 evidence records one 100,000-input run, one outbox
event, one audit event, exact-repeat idempotency, 100 logged input statements, forced-RLS
foreign-tenant concealment, and clean offline checksums. Its local timing is not an API SLO or
capacity claim. See
`artifacts/reconciliation-run-creation-maximum-volume-verification-2026-07-29.json` and ADR 0032.

A later fresh-database run injects a verifier-only PostgreSQL rejection at ordinal 1,000. Although
the first 1,000-row statement executed, the transaction leaves zero run/input/outbox/audit rows.
After removing the trigger, the same snapshot creates successfully in 100 statements and exact
repetition remains idempotent. Evidence:
`artifacts/reconciliation-run-creation-atomic-rollback-verification-2026-07-29.json`. This proves
cross-batch error rollback. ADR 0033 adds a 5–120 second bounded application authority deadline (30
seconds by default), transaction-local statement backstop, and API request-abort cancellation. A
later fresh maximum-volume run delayed the same second input statement. Deadline expiry after
5,006.20 ms and a distinct explicit client cancellation after PostgreSQL observed the delayed batch
each left zero run/input/outbox/audit rows. PostgreSQL logged two input executes for each attempt as
ordinary user-request cancellations with no fatal session event. The verifier then removed its
objects, created the identical complete snapshot in 100 statements, repeated idempotently, and
passed offline checksums. Evidence:
`artifacts/reconciliation-run-creation-interruption-verification-2026-07-29.json`. The timings are
local observations, not an SLO.

A later fresh PostgreSQL 17.10 run launches the child verifier through Node's direct import hook so
the spawned, reported, killed, and database-identified process is the same PID. `SIGKILL` during the
delayed second batch produced an unexpected EOF with an open transaction and zero authority rows;
retry created one complete 100,000-input run. Two more direct creators, using a distinct policy
snapshot, were simultaneously visible in `pg_stat_activity` with one waiting on the organization
advisory lock. Both returned the same run; only one 100-batch ledger, outbox event, and audit event
persisted. The database passed offline checksums. Evidence:
`artifacts/reconciliation-run-creation-process-loss-contention-verification-2026-07-29.json`. Client
loss can still have an ambiguous full-commit result, so the invariant is zero or one complete
authority followed by idempotent retry—not guaranteed rollback. Real ingress/proxy disconnect,
sustained queue pressure, process-supervisor recovery, multi-host partitions, and protected-staging
behavior remain open.

ADR 0034 adds prompt repository settlement while postgres.js pool admission remains non-cancellable.
A later fresh run occupied both connections in a two-connection restricted application pool. The
5,000 ms deadline returned `RepositoryRunCreationUnavailableError` after 5,002.55 ms while both
holders were still idle in their transactions. Capacity was released only after the response; the
expired queued operation drained, and database state remained at zero run/input/outbox/audit rows
before the later recovery phases. Evidence:
`artifacts/reconciliation-run-creation-pool-saturation-verification-2026-07-29.json`. This is a
single local repository measurement, not sustained-load, ingress, or end-to-end API evidence.

ADR 0035 adds a configurable 1–10 fail-fast cap, default two, before constructing a run-creation
database operation. A fresh repeat with both pool connections occupied admitted two requests, which
settled after 5,001.93/5,002.10 ms, and rejected 32 excess attempts in 0.28 ms without database
admission. A post-deadline retry was still rejected in 0.21 ms because both hidden operations
retained their leases. Capacity release drained them with zero authority, and the later fault and
contention phases passed. Evidence:
`artifacts/reconciliation-run-creation-admission-pressure-verification-2026-07-29.json`. This bounds
one process's internal burst; deployment-wide capacity still scales with replicas and has no
sustained-load or end-to-end latency proof.

The API classifies the two retry-safe outcomes internally as `admission_saturated` or `interrupted`
and increments `reconai.reconciliation.run_creation.unavailable`. The classification does not alter
the public `503` and carries no tenant or financial identifier. A loopback collector test verifies
the real OTLP protobuf values; it is not evidence of a deployed dashboard or alert. Evidence:
`artifacts/reconciliation-run-creation-unavailability-observability-verification-2026-07-29.json`.

## Ambiguous candidates

Candidate generation is deterministic and bounded. Features may include approved normalized IDs,
amount/currency equality, time distance, customer/email hash equality, and provider metadata. Each
weight and threshold is versioned. Free text does not become executable instructions. A candidate
score is ranking evidence, not approval confidence.

The engine records eligible/evaluated/emitted counts, the evaluation limit, and whether the search
was complete. At 500 or fewer currency/amount candidates it scores the full population before
selecting five. At 501 or more it evaluates and emits none, returning
`ORDER_PAYMENT_CANDIDATE_SET_EXCEEDS_LIMIT` as an `ambiguous_identity` exception. It never presents
an arbitrary prefix as a complete ranking.

Optional AI receives a minimized structured list with opaque candidate IDs and evidence. Output is
schema-validated ranks/explanation/citations. Timeout, invalid schema, policy disablement, or
provider failure returns the unchanged deterministic candidate list for human review. Candidate
overflow supplies no list for AI ranking.

## Verification strategy

- Golden cases for every V1 exception and explanation code.
- Property tests: no float values; money conservation; input permutation invariance; determinism;
  identical-replay idempotency; cross-currency non-match; aggregation bounds.
- Metamorphic tests: adding unrelated records cannot change an established exact match; source
  reorder cannot change results; AI enable/disable cannot change deterministic artifacts.
- Database integration: uniqueness, run concurrency, exception supersession, approval retention.
- Performance: representative synthetic 1k/10k/100k-order snapshots with memory/duration evidence.

No accuracy, throughput, or SLO target is reported as achieved until the evidence is linked from
`GOALS.md`.

The current mixed-load datum is
`artifacts/reconciliation-representative-load-post-lint-verification-2026-07-30.json`: five fresh
processes each reconcile exactly 100,000 deterministic synthetic records spanning 20,000 exact
order/payment/fee groups, 8,000 refund/accounting triples, and 12,000 expected missing/unmatched/
malformed exceptions. Canonical, reversed, rotated, and repeated inputs produce one run key and
complete result digest; integer order/payment and Shopify/Stripe/accounting refund totals conserve
exactly. Pure-engine durations ranged from 1,664.48 to 1,948.55 ms and maximum observed RSS was
521,650,176 bytes on the recorded local ARM64 host. Five samples are not a statistically reliable
p95, and the timing excludes every API, database, queue, worker-persistence, browser, and network
stage. ADR 0067 defines this boundary. The earlier 99,999-record exact-match artifact remains
historical regression evidence at `artifacts/reconciliation-benchmark-engine-0.7.0-2026-07-29.json`.
Payment boundary, overflow, strongest-candidate, and permutation results for 500, 501, and 10,000
collisions are recorded in
`artifacts/reconciliation-collision-evaluation-engine-0.7.0-2026-07-29.json`. Complete canonical
taxonomy plus one-row and split refund/accounting results are in
`artifacts/reconciliation-taxonomy-accounting-evaluation-engine-0.7.0-2026-07-29.json`; identifier
results are in
`artifacts/reconciliation-malformed-identifier-evaluation-engine-0.7.0-2026-07-29.json`. A focused
fresh PostgreSQL 17.10 run persisted the rule 1.5 refund, conserved two-row refund/accounting split,
and duplicate-fee artifacts through the restricted worker role, replayed without duplicate
occurrences, denied mutation of the immutable occurrence snapshot, and returned zero rows under a
foreign tenant context; see
`artifacts/reconciliation-split-accounting-verification-2026-07-29.json`. Historical 0.6.0/1.4.0
artifacts remain immutable regression evidence. Mocked Chromium also renders the exact split
rule/reason and three-record cardinality without detected accessibility or mobile-overflow failures;
see `artifacts/reconciliation-split-browser-verification-2026-07-29.json`. The tenant-authorized
run-detail path now exposes at most ten match and ten exception observations; snapshot-backed rows
are exact, while a rolling-window occurrence without a snapshot is labeled as a current-artifact
projection and is never backfilled as historical fact. API/BFF/browser and fresh PostgreSQL evidence
for that read model is recorded in
`artifacts/reconciliation-operator-evidence-verification-2026-07-29.json`. A truncated preview can
now be expanded through stable artifact-ID keyset pages. The cursor is bound to tenant, run, type,
and last ID; page-size and JSON ceilings remain enforced; exact and legacy mappings are unchanged.
Fresh PostgreSQL and browser evidence for the 12-artifact traversal and negative cursor/RLS cases is
recorded in `artifacts/reconciliation-artifact-pagination-verification-2026-07-29.json`. One
isolated continuous Chromium/BFF/API/outbox/Redis/restricted-worker execution then rendered three
exact matches, including the conserved two-row accounting split with three record references, and
one exact duplicate-fee exception from the new snapshots; it persisted the same split snapshot and
returned a foreign-tenant `404`. See
`artifacts/reconciliation-continuous-split-journey-verification-2026-07-29.json`. These are
regression results only; representative source/accounting distributions, split-shape frequency,
multiple-run concurrency, operator outcomes, p50/p95 behavior, staging topology, and staging
hardware are still required.
