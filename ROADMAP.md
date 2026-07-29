# ReconAI roadmap

This roadmap expresses sequence, not promised dates. `GOALS.md` contains acceptance criteria and
objective completion evidence.

## Goal 0 — Foundation (active)

Living requirements; governance; architecture, threat model and ADRs; TypeScript monorepo; local
PostgreSQL/Redis/S3/OIDC; migrations; Git hooks; CI/security automation; synthetic fixtures; and a
verified fresh-clone contributor path.

## Goal 1 — Deterministic vertical slice

Identity, organizations and permissions; Shopify/Stripe/CSV ingestion; canonical provenance;
versioned deterministic matching; exception queue/investigation; human/dual approval; append-only
audit; connector health; and an approved staging deployment.

## Goal 2 — Production hardening

Cross-layer tenant audit, scale/load evidence, monitoring and exercised alerts, backup restoration,
incident/operations drills, security review, release readiness, and verified self-hosting.

## Goal 3 — Controlled AI assistance

Synthetic/authorized evaluation dataset, structured ambiguous-candidate ranking and explanations,
prompt-injection/fallback tests, human agreement/cost/latency evidence, tenant feature flag, caps,
and exercised rollback. Deterministic operation remains complete with AI disabled.

## Goal 4 — Expansion

Validated-demand QuickBooks Online read-only and shipping connectors, connector SDK/conformance
suite, then subscription billing and enterprise identity only after the core workflow is proven.

## Explicit sequencing constraints

No production-ready claim before tenant isolation, replay invariants, authenticated/idempotent
webhooks, restoration, alerts, rollback, and fresh-clone self-hosting are verified. No AI production
rollout before deterministic stability and evaluation. No public release under the working name
without owner and legal review.
