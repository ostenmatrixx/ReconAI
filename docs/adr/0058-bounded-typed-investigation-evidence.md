# ADR 0058: Bounded typed investigation evidence

- Status: Accepted
- Date: 2026-07-29

## Context

Milestone 1 requires an operator investigation to show source and normalized values side by side,
with provenance, the applied deterministic rule, tolerance, confidence, and conflict. Reconciliation
evidence and canonical normalized records are stored as JSON because their shapes vary by record and
rule. Treating those stored values as browser-ready JSON would let malformed, expanded, legacy, or
future fields cross the API/BFF boundary without an intentional review. It could also expose
organization identifiers, raw-object references, source-value references, credentials, or partial
lineage that appears more complete than it is.

Record references are not authorization. A corrupted exception can contain a well-formed UUID that
belongs to another organization. Forced row-level security is essential, but every tenant query must
also repeat an explicit organization predicate and the browser must not receive an unverified
reference merely because it was stored on an otherwise authorized exception.

## Decision

1. `RuleEvidenceSchema` is the strict runtime authority for current deterministic evidence. It
   rejects unknown keys and bounds identifiers, versions, hashes, record counts, comparison arrays,
   comparison fields and values, integer tolerances, timestamps, candidate-search counts, and both
   accounting overflow modes. The reconciliation engine validates the same schema before returning
   newly produced evidence.
2. The API never sends stored `RuleEvidence` directly to the browser. It emits a discriminated
   `deterministic-evidence-view-v1`:
   - `available` contains only rule/rule-set versions, result/reason, evidence count/truncation,
     paired source/normalized comparisons, optional tolerance, bounded candidate-search summaries,
     and evaluation time;
   - `unavailable` contains only the fixed code `EVIDENCE_UNSUPPORTED_OR_MALFORMED`.
3. Unknown, future, legacy, malformed, oversized, or internally inconsistent evidence fails closed
   to the fixed unavailable view. The API and BFF do not infer missing facts, expose partial values,
   or fall back to raw JSON.
4. Exception record references are browser-visible only when they are a bounded, unique UUID set and
   exactly match the tenant-resolved source-record set. Any duplicate, malformed, oversized,
   unresolved, or cross-tenant reference makes the browser projection empty and unavailable.
5. Canonical records use a closed discriminated browser projection for the supported order, payment,
   refund, processing-fee, and accounting-entry shapes. Organization IDs, source-event IDs, raw
   provenance, raw-object keys, and source-value references are omitted.
6. Field provenance is all-or-nothing per canonical record. Every required lineage row must be
   tenant-resolved through an explicit organization predicate under forced RLS and must validate its
   provider, record kind, source version, content hash, normalized metadata, field name, and bounded
   location. Otherwise the record carries no partial lineage and an explicit unavailable status.
7. The web BFF independently validates the strict evidence, reference-status, canonical-record, and
   provenance schemas and reconstructs the output. The operator interface renders semantic fields
   and side-by-side comparison/lineage tables; it never renders evidence with a generic JSON
   serializer.

## Consequences

Operators receive reviewable deterministic evidence without API-only identifiers or an ambiguous raw
JSON fallback. A malformed historical row cannot leak a foreign record UUID or look partially
trusted. Evidence unavailability is visible and can strengthen review policy without changing the
underlying rule result.

Future evidence or canonical-record fields require an intentional stored-schema and browser-view
change with tests. Existing unsupported historical evidence remains unavailable until a separately
reviewed migration or replay produces a supported immutable representation; the read path will not
silently reinterpret it.

## Alternatives considered

- Pass stored evidence through the BFF under a total byte ceiling: rejected because a byte ceiling
  does not define allowed fields, semantics, cardinality relationships, or tenant-safe references.
- Strip only a known list of sensitive keys: rejected because future and nested fields would be
  allowed by default.
- Render the safe subset of a malformed object: rejected because partial evidence can mislead an
  operator about completeness and provenance.
- Display stored record UUIDs even when source rows do not resolve: rejected because identifiers are
  data, not authority, and a corrupted foreign UUID must not cross the tenant boundary.
- Backfill or infer legacy evidence during reads: rejected because it would rewrite or fabricate
  historical meaning without a versioned migration and immutable-input proof.

## Security, tenant, financial, AI, and operational effects

Every investigation read still resolves membership and permission before constructing
`TenantContext`. Canonical and provenance queries repeat `organization_id` predicates inside forced
RLS transactions. Exact reference/source-set equality prevents a stored foreign or unresolved UUID
from reaching the browser. React renders escaped text from closed schemas; no unsafe HTML or dynamic
code is added.

Money remains integer minor units with explicit currency. No tolerance, reconciliation rule,
confidence mapping, rule version, source-system write, provider scope, permission, approval, or
financial behavior changes. AI remains disabled by default and cannot supply or override this
deterministic evidence.

## Migration, rollback, and verification

No database migration or reconciliation rule-version update is required because stored evidence,
money comparison, tolerance, and match/exception decisions do not change. API and web images must
roll forward or back together because the browser view is a closed contract. Rollback restores the
previous read projection only; it must not rewrite evidence, record versions, exceptions, proposals,
approvals, or audit history.

Verification covers schema bounds and cardinality, both accounting overflow limits, unknown-field
rejection, fixed malformed fallback, safe canonical projection, all-or-nothing lineage, strict BFF
minimization, structured Chromium rendering, accessibility, and a fresh data-checksummed PostgreSQL
17.10 restricted-role exercise with all 55 migrations. The PostgreSQL scenario includes a crafted
primary-tenant exception that references a foreign-tenant canonical record and proves the browser
receives neither that reference nor a source record. Evidence is recorded in
`artifacts/typed-investigation-evidence-verification-2026-07-29.json`.
