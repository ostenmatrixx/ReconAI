# ADR 0067: Bound representative reconciliation load evidence to deterministic engine execution

- Status: Accepted
- Date: 2026-07-30

## Context

ReconAI proposes a target of completing a 100,000-record reconciliation job within ten minutes at
the 95th percentile. That target cannot be reported as achieved without representative protected
staging measurements across snapshot loading, queueing, worker execution, persistence, and
operator-visible completion.

The existing local benchmark covered 99,999 exact order/payment/fee records in one process. It was
useful regression evidence, but it did not reach the engine ceiling, include expected exception or
refund/accounting work, repeat samples, or prove permutation-invariant output at that volume.
Treating its duration as an end-to-end percentile would overstate the evidence.

## Decision

1. Keep the proposed end-to-end service objective unchanged and explicitly separate it from the
   pure-engine measurement.
2. Define a versioned deterministic 100,000-record synthetic profile:
   - 20,000 exact order/payment/fee groups;
   - 8,000 Shopify/Stripe/accounting refund triples;
   - 4,000 paid orders missing payments;
   - 4,000 unmatched payment/fee pairs; and
   - 4,000 malformed-identifier orders.
3. Construct every amount with integer minor units and one explicit currency. Record independent
   order/payment and Shopify/Stripe/accounting totals and require exact conservation.
4. Run five sequential fresh Node child processes. Use canonical input, complete reversal, two
   rotations, and an exact canonical repeat. Each process receives the same fixed policy and
   performs explicit garbage collection after constructing the dataset but before timing.
5. Measure only the synchronous `reconcile` call. Dataset construction, API admission, PostgreSQL
   input loading, outbox, Redis, worker startup, result persistence, browser rendering, and network
   time are outside the duration.
6. Fail the verifier unless every sample has the declared result counts and rule/taxonomy
   distribution, and all samples have identical engine/rule versions, input and policy hashes, run
   key, and complete result digest.
7. Record source-file SHA-256 digests because this repository has no Git commit identity. Preserve
   the raw sample durations and memory observations in a bounded credential-free artifact.
8. Do not turn the local duration into a release threshold or an achieved SLO. Protected staging
   must establish an adequate sample count, arrival model, source distribution, end-to-end
   percentile, bottleneck analysis, and revised objective.

## Consequences

The post-lint run used engine 0.7.0/rules 1.5.0 and produced 36,000 matches plus 12,000 declared
exceptions from exactly 100,000 inputs in every sample. Canonical, reversed, rotated, and repeated
inputs shared one run key and result digest. Order/payment and three-system refund totals conserved
integer money exactly.

On the recorded local Apple ARM64 host, pure-engine durations ranged from 1,664.48 to 1,948.55 ms.
With only five samples, the nearest-rank p95 is the maximum 1,948.55 ms; this is an observation, not
a statistically reliable service percentile. Maximum observed process RSS was 521,650,176 bytes. The
roughly half-gigabyte process footprint is a capacity-planning signal for container limits and
concurrent workers, not proof of a leak or a production memory requirement.

The earlier single-run artifact remains immutable historical evidence. A second artifact binds the
post-lint verifier source after removing one deprecated no-op schema modifier.

## Alternatives considered

- Extend the happy-path benchmark to 100,000 by adding one inert record: rejected because it would
  retain a narrow distribution and weak correctness signal.
- Report the fastest or median run as the proposed p95: rejected because a local five-sample engine
  run cannot establish the end-to-end objective.
- Include dataset construction inside the duration: rejected for this verifier because construction
  is a test-fixture concern, not a production pipeline stage; staging must measure real snapshot
  loading separately.
- Run all samples in one process: rejected because retained results and JIT/heap history would make
  sample memory and timing less isolated.
- Use randomized fixtures: rejected because an unrecorded seed and distribution would weaken exact
  replay and output comparison.

## Security, tenant, financial, and operational effects

The verifier uses one synthetic organization identifier only in memory. It contacts no database,
queue, object store, provider, collector, or external system. It records no customer data,
credential, raw provider payload, personal identifier, or source-system write.

This change does not alter matching behavior, money arithmetic, rule versions, tenant authorization,
migrations, production configuration, worker concurrency, or deployment authority. It makes load
evidence reproducible and makes the measurement boundary explicit. Operationally, the observed
memory footprint must inform later worker resource/concurrency tests, and the proposed SLO remains
unverified until an authorized protected-staging run measures the whole job path.

Evidence: `artifacts/reconciliation-representative-load-post-lint-verification-2026-07-30.json`.
Historical pre-lint source-bound evidence:
`artifacts/reconciliation-representative-load-verification-2026-07-30.json`.

## Rollback

Removing the verifier would discard a regression signal but would not change production behavior. A
future scenario revision must create a new version and artifact rather than rewriting this profile.
Any engine or rule change must retain its normal version update and tests, then rerun the load
verifier; staging targets may change only from recorded end-to-end evidence and accountable review.
