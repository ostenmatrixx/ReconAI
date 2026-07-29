# ADR 0030: Tenant-bound run artifact pagination

- Status: Accepted
- Date: 2026-07-29
- Supersedes: the pagination deferral in ADR 0028

## Context

ADR 0028 deliberately limited run detail to a ten-row preview per artifact type until a bounded,
tenant-safe pagination design existed. A run can contain more than ten immutable match or exception
occurrences, so that preview alone prevents an operator from reviewing the complete evidence ledger.
The traversal must preserve exact-at-observation versus legacy-current-projection labeling, avoid
offset scan drift, conceal foreign resources, and add no new financial or mutation authority.

The occurrence primary keys already order `(organization_id, run_id, artifact_id)`. Artifact IDs are
immutable UUIDs, while `observed_at` remains the separate business-facing observation timestamp.

## Decision

Keep the ten-row run-detail preview. When it is truncated, expose a read-only
`GET /v1/organizations/:organizationId/reconciliation-runs/:runId/artifacts` endpoint for either
`match` or `exception`. Pages use the occurrence artifact ID as a stable keyset. The API accepts
1–100 rows with a default of 25; the same-origin BFF always requests 25 and retains the existing
five-MiB complete-response ceiling.

The versioned canonical base64url cursor contains the organization, run, artifact type, and last
artifact ID. It is navigation state, not a secret, signature, capability, or authorization grant.
The API derives tenant authority from the authenticated active membership, requires
`financial-records:view`, validates every cursor binding, verifies tenant-scoped run existence, and
queries inside a tenant transaction under forced RLS. A cursor from another tenant, run, or artifact
type fails closed. Malformed, non-canonical, oversized, and invalid-UTF-8 cursor values are
rejected.

Every page uses the same snapshot-first mapping as run detail. Rows with immutable snapshots remain
`exact_at_observation`; rolling-window gaps remain `legacy_current_projection`. The UI replaces the
bounded preview with the first full page, deduplicates later pages by immutable ID, validates the
response type/items/cursor, reports progress through an accessible live region, and retains loaded
evidence across a retryable failure.

Identity order is stable, not chronological; `observedAt` remains visible on every row. Because
worker occurrence writes commit with terminal run persistence and replay cannot duplicate an
occurrence, a committed run ledger is immutable. An operator who opens an active run before its
worker transaction commits may see no artifacts and must refresh after completion.

## Consequences

Operators can inspect every committed occurrence without raising the initial detail payload or
performing offset scans. Existing composite primary-key indexes support the query, so there is no
database migration, backfill, money change, rule-version change, connector write, approval change,
or AI authority change. Adding the endpoint increases the typed route inventory from 45 to 46.

The cursor is intentionally forgeable navigation input. Altering it can only skip within the already
authorized run; tenant predicates, permission resolution, run checks, and RLS remain authoritative.
UUID order does not communicate event chronology. Local 12-artifact evidence is not a
representative-volume latency or concurrent-load claim.

## Alternatives considered

- Increase the preview ceiling: rejected because it couples run-detail latency and response size to
  evidence volume.
- Offset pagination: rejected because later pages become increasingly expensive and can drift.
- Sign or encrypt cursors: rejected because the cursor grants no authority and all scope is
  revalidated server-side; signing would add key lifecycle without strengthening authorization.
- Add an `(organization_id, run_id, observed_at, artifact_id)` index: deferred because the existing
  primary key provides stable traversal without a migration; chronological display is not required
  for cursor correctness.

## Security, tenant, financial, and operational effects

Foreign or unauthorized run identifiers retain the uniform authenticated not-found response.
Customer-owned rows stay tenant-scoped in the query, cursor validation, transaction context, and
forced RLS. Page and response ceilings bound work. Evidence content and fidelity are unchanged, and
the endpoint is read-only.

Rollback removes the endpoint, BFF view, and browse controls while retaining the original bounded
preview. No schema rollback or data rewrite is required.

## Verification

Focused API/cursor/BFF tests cover page forwarding, malformed input, permission routing, and
tenant/run/type cursor replay. A fresh PostgreSQL 17.10 cluster applied all 44 migrations and passed
the restricted application-role repository suite: 12 immutable matches traversed in 5/5/2 pages
without duplicates, exact and legacy evidence remained distinct, one exception retained observed and
current status, all four occurrence/snapshot tables had forced RLS, the existing composite primary
keys supported traversal, and a foreign tenant saw no run or snapshot rows. Chromium loaded all 12
rows without duplicating the preview and retained accessibility and mobile containment.

Evidence is recorded in `artifacts/reconciliation-artifact-pagination-verification-2026-07-29.json`.
Representative high-volume latency, concurrent page readers, protected staging, and multi-host
timing remain open.
