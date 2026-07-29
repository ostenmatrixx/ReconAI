# ADR 0042: Bounded exception final-resolution age

- Status: Accepted
- Date: 2026-07-29

## Context

ReconAI already records a bounded age for every committed proposal decision. That signal measures
proposal creation to each decision, so a dual-control proposal produces separate first-stage and
threshold-crossing observations. It cannot measure the full time from initial exception creation to
final reviewer resolution.

The exception lifecycle has several superficially terminal-looking states that are not equivalent. A
rejected proposal returns its exception to `open`. An authoritative reconciliation run can mark an
unobserved exception `superseded`, but a later authoritative run can reobserve that stable key and
reopen it. In contrast, the reviewer path moves an exception to `approved` only when the required
approval threshold is crossed; workflow and proposal mutations reject approved exceptions, and
reconciliation deliberately preserves them.

The tenant-scoped approval transaction already locks the proposal and exception, inserts the
immutable approval, computes the threshold, and updates the exception. It is the narrowest
trustworthy authority for a final reviewer-resolution observation. A global scan of customer-owned
exceptions would add cross-tenant authority, distributed gauge ownership, and completeness risks.

## Decision

1. Define final reviewer resolution as the first committed transition of an exception into
   `approved` after the proposal reaches its required approval threshold.
2. Exclude first-stage dual-control approvals, proposal rejections, and automated `superseded`
   transitions. Rejection is not final, and supersession can be reversed by later authoritative
   source evidence.
3. Read the exception `created_at` from the already tenant-predicated, locked proposal/exception
   join. Return the `updated_at` timestamp from the exact exception status update. Validate both as
   database timestamps and expose them only as internal repository metadata.
4. Keep the public approval response unchanged and explicitly omit exception and proposal timing
   metadata.
5. Emit telemetry only after the tenant-scoped repository transaction returns successfully and only
   when the resulting proposal status is `approved`. Unauthorized, conflicting, rolled-back,
   pending, and rejected attempts emit no final-resolution sample.
6. Record one `reconai.review.exception_final_resolution.samples` counter observation with only a
   fixed timing outcome. Record `reconai.review.exception_final_resolution.age` in seconds only when
   the exception-creation-to-approved-transition age is valid and from zero through 365 days
   inclusive.
7. Classify future, invalid, and over-365-day timestamps as `future_timestamp`, `invalid_timestamp`,
   or `outside_window`; never clamp or record them in the numeric histogram.
8. Add no tenant, organization, user, reviewer, proposal, exception, type, severity, amount,
   currency, reason, status, correlation, or timestamp attributes. The counter has at most four
   series and the histogram one, below the existing 256-series-per-instrument limit.
9. Keep telemetry at-most-once, lossy, and non-authoritative after commit. Export failure or process
   loss must not roll back, retry, duplicate, or otherwise influence financial review.

## Consequences

Operators gain a bounded distribution of elapsed time from an exception's first persisted
observation to its final approved reviewer resolution. Rejected proposal cycles remain part of the
same exception lifetime, which reflects the time required to reach final approval rather than only
the age of the accepted proposal.

This does not measure the live unresolved backlog, supersession latency, reviewer productivity,
resolution accuracy, source-system repair, or operator outcome. Approved is intentionally a
reviewer-final state; automated source-state disappearance remains separately represented as
reobservable supersession.

The post-commit placement prevents failed work from becoming an observed resolution, but a process
failure after commit and before export can omit a sample. Alert thresholds, absence behavior,
dashboard aggregation, collector protection, and delivery still require protected deployment
validation.

## Alternatives considered

- Treat rejection as final: rejected because the implemented transaction reopens the exception and
  permits a new proposal.
- Treat supersession as final: rejected because authoritative reconciliation explicitly permits a
  superseded stable exception to be reobserved and reopened.
- Scan every approved or unresolved exception: rejected because customer-owned rows require
  tenant-scoped access and a distributed observer needs explicit completeness and ownership.
- Measure from proposal creation: rejected because that is already covered by ADR 0040 and omits
  earlier investigation and rejected-proposal cycles.
- Label tenant, reviewer, exception, proposal, type, severity, amount, or status: rejected as
  customer, financial, or high-cardinality context unnecessary for the aggregate signal.
- Persist a telemetry outbox: rejected because monitoring delivery must not compete with review or
  financial authority.

## Security, tenant, financial, and operational effects

The only additional database fields are read from the already-authorized, organization-predicated
locked join and returned by the same organization-predicated status update. RLS and the application
role remain in force. No cross-tenant query, database function, role grant, policy, migration,
public response field, or new endpoint is introduced.

No money behavior, currency handling, reconciliation rule/version, approval threshold, review state
transition, audit history, provider scope, source-system write, durable envelope, retry/dead-letter
rule, readiness decision, or AI behavior changes. Rollback removes the internal exception timestamp
metadata and two metric records while leaving approvals and audit evidence unchanged.

## Verification

Repository integration assertions validate that the committed final approval returns a status
transition timestamp no earlier than the exception creation timestamp when the PostgreSQL suite is
run. An authenticated API tenant test exercises a threshold-crossing response and proves all four
internal proposal/exception timestamps remain absent from the public response.

The loopback OTLP/HTTP protobuf test observes both instrument names, the inclusive 365-day boundary,
all four timing outcomes, and suppression of a secret-like dynamic timestamp string. Focused
typechecks and tests plus the repository's complete verification command provide local regression
evidence.

Evidence is recorded in
`artifacts/exception-final-resolution-age-observability-verification-2026-07-29.json`. This is local
post-commit instrumentation evidence, not a protected collector/backend, threshold, dashboard,
alert-delivery, staging, or production result.
