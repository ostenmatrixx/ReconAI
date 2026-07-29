# ADR 0056: Immutable resolution proposal revision

- Status: Accepted
- Date: 2026-07-29

## Context

Milestone 1 requires an operator to edit a resolution proposal. Resolution proposals and approvals
are retained financial-review evidence: the database already prevents proposal-evidence mutation and
approval update/delete. The existing workflow therefore allowed a replacement only after rejection
or automatic run supersession. It did not satisfy the promised edit action while a proposal was
pending.

An in-place edit would make a prior approval appear to endorse evidence it never reviewed. Allowing
a different reviewer to replace the proposal would also combine proposal and decision authority.
Revision and approval can arrive concurrently, so application-only prechecks without a common lock
order could deadlock or let an approval cross a version boundary.

## Decision

1. Editing a pending proposal means immutable replacement. Proposal type, reason, evidence,
   proposer, approval policy, ID, version, and creation time are never updated.
2. Only the authenticated original proposer may revise, and only while the tenant-scoped exception
   is `proposed` with exactly one pending proposal.
3. One transaction locks the exception authority row, locks the pending proposal, changes only its
   lifecycle status to `superseded`, computes the next version, inserts a new proposal with a new
   UUID, and appends `resolution.revised`.
4. The replacement recomputes required approvals from the current organization review policy. Old
   approvals remain append-only and keyed to the old proposal ID/version; their count is audit
   context, not authority for the replacement.
5. Approval first resolves the proposal-to-exception relation, locks the exception row, and then
   locks the proposal. Revision uses the same exception-first order. A concurrent approval may be
   recorded against the old version before supersession or rejected after supersession, but it can
   never attach to or count for the new version.
6. The API derives revision eligibility from current membership, permission, tenant context,
   proposal state, and proposer identity. The browser receives only `canRevise`; it does not receive
   proposer identity. The user must confirm that the replacement discards prior approval authority.
7. The existing create-proposal endpoint and BFF action carry revision requests. No client flag can
   request or grant revision authority.

## Consequences

Every review decision remains attributable to the exact evidence it evaluated. A pending proposal
can be corrected without deleting history, and the investigation timeline can show the original, its
decisions, the revision audit, and the replacement.

The prior proposal can have zero or more historical approval rows when superseded. Those rows remain
valid history but do not reduce the replacement's required count. The revision uses current policy;
an administrator policy change may therefore change the required approval count on the new version,
which is deliberate and audit-visible.

## Alternatives considered

- Update the pending row and retain approvals: rejected because approval meaning would change
  retroactively.
- Update the pending row and delete approvals: rejected because approvals are append-only retained
  evidence.
- Permit any reviewer to revise: rejected because it combines another actor's proposal authority
  with review authority and obscures authorship.
- Require rejection before every correction: rejected because it does not implement the required
  edit action and adds an artificial reviewer dependency.
- Copy prior approvals to the replacement: rejected because reviewers did not approve the new
  evidence.

## Security, tenant, financial, AI, and operational effects

All reads and writes remain inside a membership-derived `TenantContext`, explicit organization
predicates, and forced RLS. Cross-tenant or insufficient-permission requests remain uniformly not
found. The decision adds no automatic financial action, money mutation, currency conversion,
source-system write, provider scope, permission selection, or AI authority. The proposal remains a
human-review artifact and approval remains independent.

The common lock order reduces database deadlock risk. It does not establish representative
multi-replica latency or protected-environment behavior; those remain staging evidence.

## Migration, rollback, and verification

No database migration is required. Migration 0015 already admits `superseded`, protects all proposal
evidence fields from update/delete, and makes approvals append-only and version-bound.

Rollback removes the revision UI and server transition while retaining every already-created
proposal, approval, and audit row. It must not rewrite a revised proposal back into its predecessor
or delete historical evidence.

Verification includes same-proposer and other-actor API tests, strict browser response minimization,
a Chromium revision/confirmation journey, and a fresh data-checksummed PostgreSQL 17.10
restricted-role test for approval reset, old-version decision denial, audit content, immutable
history, and a simultaneous approval/revision race. Evidence is recorded in
`artifacts/resolution-proposal-revision-verification-2026-07-29.json`.
