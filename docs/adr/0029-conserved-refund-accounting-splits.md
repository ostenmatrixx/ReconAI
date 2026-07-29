# ADR 0029: Conserved refund/accounting splits

Status: accepted  
Date: 2026-07-29

## Context

Engine 0.6.0/rules 1.4.0 created a refund/accounting match only for one tolerance-valid accounting
row assigned to one Shopify refund. Multiple rows failed closed as identity ambiguity. That
cardinality rule prevented arbitrary reuse, but it also left a common accounting representation
unsupported: one refund represented by multiple ledger/export rows whose complete total equals the
refund.

Automatically selecting a subset of rows would be deterministic only in an ordering sense; it would
not establish financial identity. Order references can be low-cardinality, negative/zero rows can
hide netting, and an unbounded subset-sum search would violate the engine's bounded-work contract. A
split policy must conserve money, use strong source evidence, reject competing representations, and
preserve one-use authority for every accounting row.

## Decision

- Engine 0.7.0 and rule set/rule version 1.5.0 retain the rule 1.4 one-row behavior and add
  `refund-accounting-split`.
- A split is eligible only when 2–50 `refund` accounting rows have the same currency and all belong
  to one normalized accounting `transactionReference` that exactly equals either the Shopify
  refund's external ID or refund reference. Order-reference-only groups are never auto-summed.
- Every row in that exact transaction-reference bucket must have a strictly positive minor-unit
  amount. The engine sums the complete bucket using checked signed-64-bit integer money. It never
  searches for, ranks, or selects a subset.
- The complete sum must equal the refund amount within the immutable run's captured per-currency
  tolerance. A conserved bucket creates one composite match over the refund and every accounting row
  with reason `REFUND_ACCOUNTING_SPLIT_TOTAL_MATCHED`.
- A non-conserving complete bucket creates `refund_amount_mismatch` with the exact total,
  difference, tolerance, source rows, and reason `REFUND_ACCOUNTING_SPLIT_TOTAL_OUTSIDE_TOLERANCE`.
  One strongly linked row outside tolerance is likewise an amount mismatch rather than a fabricated
  missing-entry result.
- A competing tolerance-valid one-row candidate, more than one populated strong reference bucket, a
  non-positive row, or an out-of-range total fails closed as high-severity ambiguity. The engine
  does not prefer the split or the one-row representation.
- More than 50 rows in the strong reference bucket emits `REFUND_ACCOUNTING_SPLIT_SET_EXCEEDS_LIMIT`
  without evaluating or emitting a partial set. Every lookup key in that overflow is tainted for the
  run so a row cannot escape hidden reuse through an order reference.
- Every row in a proposed one-row or split match participates in the existing cross-refund usage
  check. If any row is eligible for another refund, no accounting match is created.

## Consequences

The engine can represent one refund as one accounting row or as one complete conserved positive
split bucket while retaining immutable record versions and replay identity. Valid split output is
evidence-backed and composite, not a probabilistic or AI decision.

The policy is deliberately narrower than general ledger allocation. Mixed transaction-reference
buckets, negative offsets, order-level aggregation, partial subset selection, and more than 50 rows
remain human-review cases. This may create false-positive work for legitimate exports, but it cannot
silently omit, net, duplicate, or reuse rows.

The rule reuses existing match/exception/evidence JSON and bounded text columns under current RLS.
No database schema, permission, connector write authority, currency conversion, approval, or AI
authority changes.

## Alternatives

Keeping all multi-row cases ambiguous was safe but failed to model an explicitly identified local
Milestone 1 gap. Selecting the first or smallest matching subset was rejected because deterministic
arbitrariness is not financial evidence. General subset-sum was rejected because multiple valid
subsets are ambiguous and the search can become combinatorial. Summing order-reference groups was
rejected because an order can contain multiple refunds. Allowing zero or negative rows was rejected
because netting can hide reversals, fees, duplicates, and sign-convention errors that require an
explicit later policy.

## Migration, rollback, and verification

Run identity includes engine and rule-set versions. Existing 0.6.0/1.4.0 and earlier runs and
occurrence snapshots remain immutable historical evidence. No database migration or backfill is
required.

Drain reconciliation dispatch before deploying API and worker together. A worker rejects a run whose
pinned identity does not equal its current engine/rule computation. Drain again before rollback;
rollback restores 0.6.0 behavior, where every split remains ambiguous, and must never rewrite 0.7.0
results.

Golden and property tests cover conserved positive partitions, permutation replay, mismatch,
competing one-row evidence, multiple reference buckets, non-positive rows, 50/51 boundaries,
signed-64-bit overflow, hidden-overflow taint, and cross-refund reuse. The taxonomy evaluator
records one conserved split, exact mismatch difference, independent split ceiling, and replay
equivalence. A fresh loopback PostgreSQL 17.10 cluster applied all 44 migrations and the restricted
worker persisted one immutable three-record split occurrence, replayed without duplication, rejected
snapshot mutation, and returned zero rows under a foreign tenant context. A mocked Chromium
run-detail fixture renders the exact rule/reason, three-record cardinality, and evidence fidelity
without automated accessibility violations. An isolated checked-in continuous verifier also executes
the eight-record fixture through Chromium, the BFF/API, outbox, Redis/BullMQ, restricted worker, and
PostgreSQL; it verifies the split reason and three record references in the browser/API read model
and immutable snapshot while returning a foreign-tenant `404`. Representative accounting
distributions, operator outcomes, concurrency/load, staging rollout, and rollback remain required
evidence.
