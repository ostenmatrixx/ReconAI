# ADR 0017: Fail-closed ambiguous candidate overflow

Status: accepted  
Date: 2026-07-28

## Context

Engine 0.3.0 limited ambiguous order/payment work by taking the first 500 payments in the
currency/amount range, ordered by amount and canonical record ID, and only then assigning candidate
scores. In a set of 501 or more otherwise eligible payments, a later record with matching customer
and time evidence could be omitted while five weaker records were presented. The result was
deterministic but incomplete, and neither the exception evidence nor the candidate list disclosed
that the score ordering was computed from a truncated population.

Candidate scores are non-authoritative investigation evidence. A bounded engine must not make an
incomplete shortlist look complete, and it must not permit optional AI to rank a silently truncated
set as if it represented all eligible records.

## Decision

- Engine 0.4.0 and rule set/rule version 1.2.0 calculate the exact size of the indexed
  currency/amount range before scoring candidates.
- When the range contains at most 500 payments, the engine scores every eligible payment and emits
  at most five. Evidence records the eligible, evaluated, emitted, and limit counts with
  `complete: true`.
- When the range contains more than 500 payments, the engine scores none and emits no shortlist. It
  creates a high-severity `ambiguous_identity` exception with rule
  `order-payment-candidate-overflow`, reason `ORDER_PAYMENT_CANDIDATE_SET_EXCEEDS_LIMIT`, exact
  bounded counts, and `complete: false`.
- The overflow decision is independent of input order. It does not auto-match, approve, or select a
  payment, and optional AI receives no deterministic shortlist to embellish.
- Exact linked payments remain authoritative and are processed before ambiguous candidate search;
  this decision changes only the no-exact-link candidate path.

## Consequences

At or below the boundary, the emitted top five are calculated from the complete eligible population.
Above the boundary, the operator receives explicit evidence that the deterministic engine declined
to rank the population. This removes the silent recall/ordering defect while retaining bounded work.

The conservative overflow path provides less immediate investigation convenience. Resolving large
collision sets requires narrower organization policy/data quality, operator filtering, or a future
reviewed multi-dimensional index that can prove a complete top-k result without unbounded per-order
work. No accuracy or production-capacity claim follows from the synthetic evaluation.

The exact eligible count is derived by two binary searches over a tenant-run-local, currency-scoped
index. Candidate evidence is persisted with the existing reconciliation JSON evidence; no database
migration or source-system write is introduced.

## Alternatives

Keeping the first 500 rows and adding a truncation flag was rejected because the displayed ranking
would still be computed from an arbitrary slice. Sampling or reserving quotas for customer/time
features was rejected because it improves typical recall without making completeness provable.
Scoring every eligible payment was rejected because a collision-heavy snapshot could restore
quadratic order/payment work. A two-dimensional range/top-k index remains a possible future design,
but requires representative distribution, memory, and operator-value evidence.

## Migration, rollback, and verification

The engine and rule-set versions are part of the immutable run identity, so existing 0.3.0/1.1.0
runs remain historical evidence and are not rewritten. Deploy API and worker versions together, stop
or drain reconciliation dispatch first, and ensure no queued 0.4.0 identity can be consumed by an
older worker. Rollback must likewise drain new-version work; reverting to 0.3.0 reintroduces the
silent partial-ranking defect and is not an acceptable steady-state repair.

Synthetic tests cover the 500/501 boundary, strongest-candidate retention in the complete case,
exact overflow evidence, zero partial candidates, and reversed-input replay equivalence. The
versioned evaluator additionally records a 10,000-collision case. Current evidence is
`artifacts/reconciliation-collision-evaluation-2026-07-28.json`; staging persistence, operator
rendering, representative collision distributions, concurrent load, and alert exercises remain
required.
