# ADR 0031: Tenant-bound run input pagination

- Status: Accepted
- Date: 2026-07-29

## Context

A reconciliation run pins as many as 100,000 canonical record versions and binds their sorted
identity into `input_snapshot_hash`. Run detail exposes only the first 100
record/version/content-hash references. The hash proves identity, but an operator cannot inspect
every constituent input when the preview is truncated.

`reconciliation_run_inputs` is immutable, forced-RLS, and already has a unique
`(organization_id, run_id, ordinal)` index. Its ordinal is assigned from the exact deterministic
input ordering used to build the snapshot.

## Decision

Keep the 100-row run-detail preview and add a read-only
`GET /v1/organizations/:organizationId/reconciliation-runs/:runId/inputs` endpoint. It traverses
inputs by strictly increasing ordinal, accepts 1–100 rows with a default of 100, and is exposed
through a same-origin BFF that always requests 100 and retains the five-MiB complete-response
ceiling.

The versioned canonical base64url cursor contains the organization, run, and last ordinal. It is
navigation state, not a secret, signature, capability, or authorization grant. The API derives the
tenant from the authenticated active membership, requires `financial-records:view`, validates every
cursor binding, verifies tenant-scoped run existence, and queries inside a tenant transaction under
forced RLS. Cross-tenant or cross-run reuse fails closed.

Each row contains only the immutable canonical record UUID, positive version, content SHA-256, and
ordinal already stored for replay. The client validates those fields, requires each response page to
be strictly ordinal-increasing with unique record/version identities, rejects overlap with retained
rows, rejects an empty page carrying another cursor, and preserves loaded rows across retryable
failures. Accessible live status and browse/load-more controls report progress.

## Consequences

Operators can inspect the complete committed input lineage without increasing the initial run-detail
payload. Existing indexes support the query, so there is no database migration, backfill, money
change, rule-version change, connector write, approval change, or AI authority change. The typed API
route inventory increases from 46 to 47.

The cursor is intentionally forgeable navigation input. Changing an ordinal can only skip within an
already authorized immutable run; membership resolution, permission checks, tenant predicates, run
existence, and RLS remain authoritative. The dedicated maximum-volume verifier is excluded from the
routine gate because it creates 100,000 source, canonical, and run-input rows; it requires explicit
synthetic-write opt-in and a fresh loopback database.

## Alternatives considered

- Increase or remove the preview bound: rejected because run-detail size and latency would scale
  with the full snapshot.
- Offset pagination: rejected because ordinal keysets map directly to an existing unique index and
  avoid growing offset scans.
- Reuse the artifact cursor: rejected because artifact UUID identity and input ordinal identity have
  different invariants and cross-type binding should remain explicit.
- Sign or encrypt cursors: rejected because the cursor grants no authority and all scope is
  revalidated server-side.

## Security, tenant, financial, and operational effects

Foreign or unauthorized run identifiers retain the uniform authenticated not-found response.
Customer-owned rows remain tenant-scoped in cursor validation, the query, transaction context, and
forced RLS. Page and response ceilings bound work. No raw source payload, customer field, money
mutation, source-system write, or financial decision authority is added.

Rollback removes the endpoint, BFF view, and browse controls while retaining the original 100-row
preview. No schema rollback or data rewrite is required.

## Verification

Focused cursor/API/BFF tests cover round-trip, tenant/run replay, malformed input, fixed page
forwarding, permission routing, and foreign-tenant handler non-execution. A fresh PostgreSQL 17.10
cluster applied all 44 migrations and passed the restricted application-role repository suite: 102
inputs traversed in 40/40/22 pages with unique record/version identities, continuous ordinals 0–101,
valid SHA-256 values, cross-run cursor denial, and zero run/input rows for a foreign tenant. The
database confirmed forced RLS and the existing unique ordinal index. Chromium replaced the 100-row
preview and loaded 100/2 rows without duplication while retaining accessibility and mobile
containment.

Evidence is recorded in
`artifacts/reconciliation-input-lineage-pagination-verification-2026-07-29.json`. A separate fresh
PostgreSQL 17.10 exercise traversed the 100,000-input maximum with concurrent 100-row and 97-row
readers both in-process and in two independent restricted-role processes. All four traversals
reached ordinal 99,999 and produced the same complete identity digest. It also confirmed the ordinal
index, cross-run cursor rejection, forced RLS, zero foreign rows, 44 migrations, and clean offline
data checksums. Its single-host local workstation timings do not establish an SLO or production
capacity. Evidence:
`artifacts/reconciliation-input-pagination-maximum-volume-verification-2026-07-29.json`.
Representative multi-host execution and protected staging remain open.
