# ADR 0040: Bounded proposal-review decision age

- Status: Accepted
- Date: 2026-07-29

## Context

ReconAI records versioned resolution proposals and tenant-authorized approve or reject decisions.
The existing review workflow preserved proposal and approval timestamps but exported no
low-cardinality measure of how old a proposal was when a reviewer committed a decision. Operators
therefore lacked a local review-latency distribution.

Calculating the age of every currently unresolved exception would require a separately owned,
tenant-safe backlog observer. A global application query over customer-owned proposal or exception
tables would violate the normal tenant transaction boundary and would introduce cross-replica gauge
ownership concerns. The committed decision path already reads the proposal and writes an immutable
approval inside one tenant-scoped transaction, so it is the narrowest trustworthy observation
boundary.

## Decision

1. Return the exact proposal `created_at` and inserted approval `created_at` from the tenant-scoped
   repository decision operation as internal metadata. Validate both values as database timestamps.
   The API response remains unchanged and explicitly excludes these internal fields.
2. Emit telemetry only after the repository transaction returns successfully. Rejected,
   unauthorized, conflicting, or rolled-back attempts emit no decision sample.
3. Record one `reconai.review.proposal_decision.samples` counter observation for each committed
   reviewer decision. Record `reconai.review.proposal_decision.age` in seconds only when the age is
   valid and between zero and 365 days inclusive.
4. Use only closed attributes:
   - decision: `approve`, `reject`, or defensive `invalid`;
   - resulting proposal status: `pending`, `approved`, `rejected`, or defensive `invalid`;
   - timing outcome on the sample counter: `observed`, `future_timestamp`, `invalid_timestamp`, or
     `outside_window`.
5. Treat only `approve` with `pending` or `approved`, and `reject` with `rejected`, as valid
   decision/status combinations. Collapse every other combination to the fixed `invalid` status.
   Dynamic decision, status, and timestamp strings never become attributes.
6. Count future, invalid, and over-365-day ages by fixed classification, but do not clamp or record
   them in the numeric histogram. Convert valid timestamps to a numeric duration and discard the
   source strings at the telemetry boundary.
7. Preserve dual-control semantics. A first approval that does not meet the threshold is an
   `approve`/`pending` sample; the threshold-crossing approval is an `approve`/`approved` sample. A
   committed rejection is a `reject`/`rejected` sample.
8. Do not add tenant, actor, reviewer, proposal, exception, proposal type, severity, amount,
   currency, reason, correlation, or timestamp attributes.
9. Telemetry is deliberately at-most-once and lossy after database commit. Export failure or process
   loss must not roll back, retry, duplicate, or otherwise influence the financial review decision.
   No telemetry outbox is introduced.

## Consequences

Operators gain a bounded distribution of proposal age at each committed reviewer decision and can
distinguish first-stage, final, and rejected decisions without customer dimensions. The defensive
counter has at most 48 combinations: three decision values, four status values, and four timing
outcomes. The histogram has at most 12 decision/status combinations. Both remain below the existing
256-series-per-instrument limit.

This signal does not measure the current age of unresolved exceptions, the oldest review backlog,
time to final resolution, operator outcome, or reviewer productivity. Dual-control proposals produce
one observation per committed reviewer decision, so the first and final approval ages are
intentionally separate.

The post-commit placement prevents rolled-back work from becoming an observed decision, but a
process failure after commit and before export can omit the sample. This is acceptable for
operational telemetry and must be considered when interpreting distributions.

## Alternatives considered

- Scan all unresolved proposals or exceptions: rejected because customer-owned rows require
  tenant-scoped transactions and a distributed backlog gauge needs explicit ownership and
  completeness semantics.
- Label tenant, reviewer, proposal, exception, type, severity, or amount: rejected as customer,
  financial, or high-cardinality context unnecessary for this aggregate signal.
- Emit before commit: rejected because authorization conflicts and rolled-back writes must not
  appear as completed reviewer decisions.
- Clamp future or over-window ages into the histogram: rejected because that would fabricate a
  misleading numeric distribution.
- Persist a telemetry outbox: rejected because monitoring delivery must not expand or compete with
  financial decision authority.

## Security, tenant, financial, and operational effects

The only new database reads are fields on the already-authorized, tenant-predicated proposal row and
the timestamp returned by the approval insert in the same transaction. No cross-tenant query,
organization predicate exception, RLS policy, permission, or public response field is introduced.
Timestamp strings remain internal and are not exported.

No database migration, money behavior, reconciliation rule/version, review threshold, proposal state
transition, audit history, provider scope, source-system write, durable envelope, retry policy, or
AI behavior changes. Rollback removes the internal timestamp metadata and two metric records while
leaving proposal decisions and audit evidence unchanged.

## Verification

Repository integration assertions validate that committed first and final dual-control approvals
return decision timestamps no earlier than the proposal timestamp when the PostgreSQL suite is run.
API tenant tests prove that the authenticated reviewer decision records timing while the public
response retains its prior schema and excludes internal timestamps.

The loopback OTLP/HTTP protobuf test observes both instrument names, the inclusive 365-day boundary,
all four timing outcomes, fixed decision/status values, and dynamic secret-like value suppression.

Evidence is recorded in
`artifacts/proposal-review-decision-age-observability-verification-2026-07-29.json`. This is local
committed-decision evidence, not exception-queue age, time-to-final-resolution, protected
collector/backend, threshold, alert-delivery, staging, or production evidence.
