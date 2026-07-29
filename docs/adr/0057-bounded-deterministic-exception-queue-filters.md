# ADR 0057: Bounded deterministic exception queue filters

- Status: Accepted
- Date: 2026-07-29

## Context

Milestone 1 promises exception-queue filtering by type/search, status, source, amount, confidence,
assignee, and age. The implemented queue previously supported only exact ID/type search, status,
severity, and a filter-bound keyset cursor. Adding the missing dimensions can introduce financial
and security defects if money is compared without currency, confidence is presented as an
unsupported probability, a browser membership ID is treated as authority, a moving clock changes
page membership, source joins omit tenant scope, or export semantics drift from the visible queue.

Exceptions retain exact canonical record references and versioned rule evidence. They do not retain
a separate probabilistic confidence score or denormalized source column. Any read-time
classification therefore has to remain deterministic, bounded, explicit about unavailable evidence,
and subordinate to the stored rule result.

## Decision

1. The queue and CSV export accept the same closed filter contract:
   - exact source: `shopify`, `stripe`, `accounting_csv`, or `unclassified`;
   - exact ISO 4217 currency plus optional signed integer minimum/maximum minor units;
   - deterministic confidence: `high`, `low`, or `unclassified`;
   - tenant-relative assignment: `me`, `assigned`, or `unassigned`;
   - UTC age bucket: under 24 hours, 1–7 days, 7–30 days, or over 30 days;
   - the existing exact exception ID/type, status, and severity filters.
2. An amount bound is invalid without currency. Bounds are canonical integer strings, the minimum
   cannot exceed the maximum, records without an amount do not match a bound, currencies must match
   exactly, and V1 performs no conversion.
3. Confidence is review-routing metadata, not a probability, accuracy result, or AI score. Stored
   rule evidence with `result=fail` is `high`; `ambiguous` or `defer` is `low`; missing, malformed,
   legacy, or any other result is `unclassified`. The original rule evidence remains authoritative.
4. When organization dual control is enabled, both `low` and `unclassified` confidence require two
   independent reviewers. Unclassified evidence fails closed rather than receiving weaker review
   authority.
5. Sources are resolved only from canonical records referenced by the tenant-scoped exception. Every
   join repeats the organization predicate. A maximum of 500 references is expanded; a malformed,
   oversized, empty, or unresolved reference set produces no named sources and matches only
   `unclassified`. Source names are deduplicated and returned without source record IDs.
6. Assignee filters never accept a client membership ID. `me` is evaluated against the
   membership-derived `TenantContext`; `assigned` means any non-null tenant-valid assignee; and
   `unassigned` means no assignee. The queue returns only that state, not another member's identity.
7. Age uses `created_at` and one PostgreSQL transaction timestamp. Bucket boundaries are disjoint:
   exactly 24 hours enters 1–7 days, exactly 7 days enters 7–30 days, and exactly 30 days enters
   over 30 days. Cursor version 2 carries the server `asOf` instant, stable severity/creation/ID
   position, and a SHA-256 binding over every normalized filter so later pages use the same clock
   and contract. A cursor is navigation, never tenant or permission authority.
8. The export uses the same predicates and clock semantics, retains the 10,000-row and 5 MiB
   ceilings, protects every CSV cell from spreadsheet formulas, adds sources/confidence/assignee in
   schema version `exception-queue-csv-v2`, and appends the normalized filters plus `filterAsOf` to
   the tenant audit chain.
9. The web BFF validates and forwards only the closed contract, strictly minimizes the successful
   queue response, and keeps exact-origin and explicit `data:export` controls on CSV preparation.

## Consequences

Operators can compose every promised queue dimension without cross-currency comparison or an
unsupported confidence claim. A visible page and its export share one contract, while a cursor page
does not drift as the server clock advances. Low or unknown evidence cannot silently receive
single-review authority when dual control is enabled.

Source resolution remains read-time work. The 500-reference ceiling, 100-row page ceiling,
10,000-row export ceiling, explicit tenant predicates, and existing canonical-record access path
bound the operation. Representative-volume query plans and protected-runtime latency are still
required before any capacity or SLO claim.

## Alternatives considered

- Store a numeric confidence score: rejected because deterministic V1 rules do not produce a
  calibrated probability and AI is not authoritative.
- Treat missing confidence as high: rejected because legacy or malformed evidence would receive
  weaker review.
- Accept arbitrary assignee membership IDs from the browser: rejected because the queue does not
  need that identity disclosure and membership IDs never grant authority.
- Compare major-unit decimals in the browser: rejected because parsing and rounding policy would be
  implicit. The contract uses exact integer minor units.
- Evaluate age against `now()` on every page: rejected because rows can cross a boundary during
  traversal.
- Persist denormalized exception source arrays immediately: deferred because it requires a
  migration, backfill, and writer compatibility plan; bounded exact canonical joins already provide
  correct V1 semantics.

## Security, tenant, financial, AI, and operational effects

Every API call still resolves permission and tenant context before repository access. Queue/source
queries include an explicit organization predicate and run inside forced-RLS transactions;
foreign-tenant identifiers return the same empty/not-found behavior. Source joins compare opaque
record IDs only inside that tenant. Assignee `me` comes from server membership, not input.

Money remains signed integer minor units plus exact currency and is never converted. Confidence does
not change a reconciliation result or rule version; it only strengthens review routing. No AI
provider, source write, autonomous approval, permission selection, or financial action is added.

## Migration, rollback, and verification

No database migration or reconciliation rule-version change is required. The queue derives fields
from existing exception evidence, record references, canonical records, assignment, and timestamps.
The CSV contract and opaque cursor intentionally advance to version 2; API and web images must roll
forward or back together. Old cursors fail closed as invalid and operators reload the first page.
Already-downloaded v1 CSV files remain valid historical artifacts.

Rollback removes the new filters/columns and low-confidence review input while retaining all
exceptions, proposals, approvals, exports, and audit events. It must not rewrite review history or
reinterpret a v2 export as v1.

Verification includes malformed/inverted money input, complete cursor filter binding, deterministic
confidence policy, formula-safe CSV v2, API/BFF minimization and authorization, Chromium
filter/export/accessibility workflows, and a fresh data-checksummed PostgreSQL 17.10 restricted-role
test for combined filters, source mismatch, foreign-tenant concealment, source-version evidence,
export audit context, and review controls. Evidence is recorded in
`artifacts/exception-queue-filtering-verification-2026-07-29.json`.
