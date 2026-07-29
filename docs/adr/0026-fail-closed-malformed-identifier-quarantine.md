# ADR 0026: Fail-closed malformed-identifier quarantine

Status: accepted  
Date: 2026-07-29

## Context

The V1 taxonomy promises a `malformed_identifier` exception, but engine 0.4.0/rules 1.2.0 emitted
only `missing_identifier`. Its reference normalizer trimmed surrounding whitespace and lowercased
values before lookup. A canonical value such as `" order-123 "` could therefore match `"order-123"`
even though the unexpected whitespace was evidence of an upstream normalizer or source-data defect.
Invisible, bidirectional, control, replacement, and malformed UTF-16 code points were also accepted
into matching indexes without an explicit exception.

Provider reference formats differ and arbitrary accounting references can contain visible Unicode
and interior spaces. ReconAI must not invent provider-prefix rules or reject legitimate
international text. At the same time, visually deceptive or structurally unsafe values must not
silently participate in financial matching.

Invalid or unsupported CSV rows are a different boundary. They fail bounded import preview or commit
validation before a canonical record exists, so they cannot carry canonical reconciliation evidence
or safely enter the exception queue as if normalization had succeeded.

## Decision

- Engine 0.5.0 and rule set/rule version 1.3.0 inspect every present identity-bearing canonical
  field: provenance external object ID; external, order, and customer references; and the applicable
  provider-order, payment, refund, or accounting transaction references.
- An identifier is malformed when it has surrounding Unicode whitespace, C0/C1 controls, Unicode
  line/paragraph separators, bidirectional controls, selected invisible formatting characters (soft
  hyphen, zero-width space, word joiner, or byte-order mark), the Unicode replacement character, or
  an unpaired UTF-16 surrogate.
- Visible Unicode, ordinary interior spaces, and joiners used in legitimate scripts or emoji are not
  malformed. The rule does not enforce Shopify, Stripe, or accounting prefix patterns.
- A record with any malformed identifier emits one high-severity `malformed_identifier` exception
  using rule `record-identifier-format` and reason `IDENTIFIER_CONTAINS_UNSAFE_FORMAT`.
- The entire affected canonical record is excluded from duplicate grouping, exact matching,
  composite candidate ranking, fee linkage, refund linkage, and accounting linkage for that run. Its
  immutable snapshot remains in the input and evidence. A safe counterpart may independently emit
  its normal missing-side exception.
- Evidence identifies each affected field, ordered issue codes, the reference-normalized value, and
  a reversible display-safe representation in which unsafe code points and boundary whitespace are
  escaped. It does not substitute unrelated money values.
- `invalid_csv_row` and `unsupported_csv_row` remain bounded ingestion-validation outcomes shown in
  import preview/commit results. They are not `ReconciliationException` values because rejected rows
  never become canonical records.

## Consequences

Malformed identities can no longer create automatic matches or ambiguous candidates. This is
conservative: a record with one unsafe non-primary reference is quarantined even if another
identifier appears usable. Operators may see both the quarantined record and a missing-side
exception for its safe counterpart. That additional work is preferable to an evidence-backed match
whose identity inputs are not trustworthy.

The exception type is already stored as tenant-scoped text and evidence as JSON, so no database
migration is required. Existing RLS, tenant predicates, immutable input snapshots, and artifact
identity continue to apply. The change performs no currency conversion, source-system write,
approval, or AI action.

Evidence includes bounded canonical identifiers that may be customer data. It stays inside the
existing tenant-authorized exception surface, escapes control/display-confusion characters, and does
not add raw provider payloads, credentials, or production fixtures.

## Alternatives

Silently trimming and matching was rejected because it hides a normalizer defect and can merge
visually distinct identifiers. Rejecting the entire reconciliation run was rejected because one bad
record should not prevent deterministic evaluation of independent safe records. Excluding only the
affected field was rejected because a malformed secondary identifier can still undermine candidate
scoring or provenance confidence. Provider-prefix allowlists were rejected because they are not
provider-neutral and would incorrectly classify legitimate accounting references. Normalizing away
invisible or bidirectional characters was rejected because destructive cleanup would fabricate
identity.

## Migration, rollback, and verification

The engine and rule-set versions are part of immutable run identity, so 0.4.0/1.2.0 runs remain
historical evidence and are never rewritten. Drain reconciliation dispatch, deploy API and worker
together, and verify no 0.5.0 identity can be consumed by an older worker. Rollback likewise
requires draining new-version work. Reverting to 0.4.0 restores unsafe trimmed matching and is not
an acceptable steady-state repair; prefer a reviewed forward fix.

Unit and property tests cover every forbidden category, visible-Unicode false positives,
display-safe field evidence, whole-record quarantine, safe-counterpart behavior, version identity,
and reversed-input replay equivalence. Local benchmark and collision evaluation remain regression
evidence only. The bounded local summary is
`artifacts/reconciliation-malformed-identifier-verification-2026-07-29.json`. Persisted staging
execution, representative malformed-source distributions, operator investigation, alerting, and
rollout/rollback exercises remain required.
