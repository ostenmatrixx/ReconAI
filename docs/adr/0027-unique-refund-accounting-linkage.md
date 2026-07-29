# ADR 0027: Unique refund/accounting linkage

Status: accepted  
Date: 2026-07-29

## Context

Engine 0.5.0/rules 1.3.0 treated refund/accounting reconciliation as a boolean existence check. A
Shopify refund passed when any eligible accounting entry existed, but the engine created no
`refund-accounting` match artifact. The same accounting row could satisfy multiple refunds, and
multiple eligible rows were silently reduced to “present.” Those outcomes violate reproducible
comparison evidence and leave one-to-many behavior implicit.

The V1 duplicate detector also routed every non-order/payment/refund record to
`duplicate_accounting_entry`. Duplicate Stripe processing-fee records were therefore mislabeled as
accounting duplicates.

Accounting order references can be low-cardinality. Enumerating every accounting row for every
refund would permit quadratic work and unbounded artifact construction. A cardinality correction
must preserve the engine’s bounded-work contract.

## Decision

- Engine 0.6.0 and rule set/rule version 1.4.0 add the canonical `duplicate_processing_fee`
  exception. Duplicate classification is exhaustive by canonical record kind; processing fees can no
  longer fall through to `duplicate_accounting_entry`.
- Refund/accounting eligibility requires an accounting `refund` entry, equal currency, an amount
  within the captured per-currency tolerance, and a normalized external/refund/order reference
  match.
- Accounting indexes are scoped by normalized reference and currency and sorted by integer minor
  amount. Binary range searches bound amount-window lookup without pairwise full scans.
- Zero eligible entries emits `refund_missing_accounting_entry`. Exactly one entry that is eligible
  for exactly one Shopify refund creates an exact `refund-accounting` match with both immutable
  record versions, source/normalized money, tolerance, rule version, and reason
  `REFUND_ACCOUNTING_ENTRY_MATCHED`.
- Multiple eligible entries or reuse of one entry across refunds emits high-severity
  `ambiguous_identity` with rule `refund-accounting-identity` and reason
  `REFUND_ACCOUNTING_IDENTITY_AMBIGUOUS`. The engine does not select or reuse an entry.
- At most 500 accounting candidates are evaluated for one refund. A larger indexed amount range
  emits `REFUND_ACCOUNTING_CANDIDATE_SET_EXCEEDS_LIMIT`, records a conservative eligible-count lower
  bound and `complete: false`, and produces no accounting match.
- Every lookup key used by an overflowing refund is tainted across that refund’s
  currency/amount-tolerance interval. An accounting entry in any of those ranges is tainted for that
  run. A seemingly unique use fails closed with `REFUND_ACCOUNTING_CANDIDATE_TAINTED_BY_OVERFLOW` so
  overflow cannot hide reuse.
- Split or aggregated accounting entries are not auto-summed in this rule version. They remain
  explicit ambiguity for human review until a separately versioned one-to-many policy has
  conservation and provider/accounting evidence.

## Consequences

The complete synthetic order/payment/refund/accounting fixture now produces three matches:
`order-payment`, `refund`, and `refund-accounting`. Successful accounting comparison is visible and
replayable instead of implicit. Multiple and shared candidates add operator work but cannot create
an arbitrary financial linkage.

Per-refund lookup is bounded by three indexed reference ranges and 500 evaluated unique candidates.
Overflow interval merging and binary membership checks prevent a candidate from escaping a previous
overflow without retaining an unbounded refund-to-entry relation graph.

The new exception type remains tenant-scoped text and the new evidence remains JSON under existing
RLS. No database schema, permission, source-system write, currency conversion, approval, or AI
authority changes.

## Alternatives

Keeping the boolean existence check was rejected because it records neither the successful
comparison nor cardinality. Selecting the lowest canonical accounting ID was rejected because
deterministic arbitrariness is not correctness. Summing every candidate was rejected because V1 has
no versioned split-entry policy and unconstrained aggregation could hide duplicates. Storing the
complete refund-to-accounting candidate graph was rejected because a low-cardinality reference can
create quadratic memory. Failing the entire run on one overflow was rejected because independent
reference buckets can still reconcile safely.

## Migration, rollback, and verification

Run identity includes engine and rule-set versions. Existing 0.5.0/1.3.0 and earlier results remain
immutable historical evidence and are not rewritten. No database migration is required. Drain
reconciliation dispatch, deploy API and worker together, and prevent older workers from consuming a
0.6.0 identity. Drain again before rollback. Reverting to 0.5.0 restores silent accounting reuse and
misclassified processing-fee duplicates, so a reviewed forward fix is the steady-state response.

Golden tests exercise every canonical V1 exception type, every duplicate kind, normalized unique
accounting linkage, zero/multiple/shared candidates, 500/501 accounting-candidate boundaries,
overflow taint, evidence truncation, and reversed-input replay. Local evaluator and benchmark
artifacts are regression evidence only. PostgreSQL-backed persistence, representative accounting
distributions, operator rendering, alerting, concurrent load, and protected staging rollout/
rollback remain required.
