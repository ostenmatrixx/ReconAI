# Goal 2 evidence — Production hardening

Status: active

Record cross-layer tenant audit, load measurements, monitoring/alert exercises, encrypted restore
results, runbook/security review, staging operational readiness, and unresolved risk disposition.

## Current evidence

| Requirement              | Current evidence                                                                                                   | Status         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------- |
| Representative load      | Five isolated pure-engine samples at exactly 100,000 mixed records with stable identity/digest and conserved money | Local partial  |
| Cross-layer tenant audit | Exact fail-closed inventory plus passing hosted 43-table catalog, integration, browser, and container checks       | Hosted bounded |
| Monitoring and alerts    | Low-cardinality policy and local telemetry evidence; no backend delivery/acknowledgement exercise                  | Partial        |
| Backup and restoration   | Exact logical PostgreSQL and versioned-object/queue component drills; no coordinated encrypted recovery point      | Partial        |
| Runbook/security review  | Current documents and dated source review exist; external penetration/operational review is absent                 | Partial        |
| Protected staging        | No authorized target, credentials, deployment, or failure exercise                                                 | Missing        |

The representative profile contains exactly 100,000 deterministic synthetic records: 28,000 orders,
24,000 payments, 24,000 processing fees, 16,000 refunds, and 8,000 accounting entries. Every fresh
process produced 36,000 matches, 12,000 expected exceptions, zero ambiguous candidates, one input
identity, and one complete result digest across canonical, reversed, rotated, and repeated input
orders. Integer money conserved across order/payment and Shopify/Stripe/accounting refund totals.

Recorded pure-engine durations were 1,664.48–1,948.55 ms; maximum observed RSS was 521,650,176
bytes. These are single-host local observations. Five samples do not establish a reliable p95, and
the measurement excludes API admission, PostgreSQL loading, outbox/Redis, worker startup,
persistence, browser visibility, network time, sustained arrivals, and concurrent tenants. The
proposed end-to-end 100,000-record objective therefore remains a target.

Evidence: `artifacts/reconciliation-representative-load-post-lint-verification-2026-07-30.json`;
decision: ADR 0067. The first source-bound run remains immutable historical evidence at
`artifacts/reconciliation-representative-load-verification-2026-07-30.json`. Latest immutable audit:
`docs/goals/goal-2-audit-2026-07-30-2.md`. Cross-layer tenant evidence:
`artifacts/cross-layer-tenant-surface-verification-2026-07-30.json`; decision: ADR 0068.

## Required before verification

- Run the complete pipeline in an approved production-like staging topology with a representative
  source distribution, adequate sample count, explicit arrival/concurrency model, bottleneck traces,
  and revised SLO.
- Exercise the translated monitoring rules through delivery, acknowledgement, escalation, recovery,
  and expected no-data/silence behavior.
- Restore one coordinated encrypted database/object/queue recovery set, recover its keys and
  configuration, time the drill, and compare the achieved RPO/RTO to approved objectives.
- Complete the external security review and protected multi-host deployment/failure/rollback
  exercises; the consolidated inventory and 43-table live catalog assertion pass in PR 11 hosted CI.
