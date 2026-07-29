# ReconAI product requirements

Status: living specification  
Working name: **ReconAI — unconfirmed; material collision risk**  
Last updated: 2026-07-27

This document is authoritative for product behavior. `GOALS.md` governs execution evidence, while
ADRs govern accepted architectural decisions. Statements are labeled **Fact** only when supplied by
the owner or verified in repository evidence. **Hypothesis** means unvalidated.

## Product vision

**Fact:** ReconAI helps e-commerce finance and operations teams identify and resolve discrepancies
across commerce, payment, shipping, and accounting systems. It replaces spreadsheet reconciliation
with reliable ingestion, deterministic matching, explainable exceptions, controlled optional AI,
human approval, immutable audit history, and operational monitoring.

## Problem statement

**Owner-stated problem:** teams manually reconcile records from systems with different identifiers,
event timing, financial representations, and export formats. Spreadsheets make replay, provenance,
access control, exception ownership, review, and audit evidence fragile.

**Hypotheses to validate:** the target segment experiences this frequently enough to adopt a new
system; Shopify + Stripe + accounting CSV covers a valuable initial workflow; evidence-first review
is more important than broad accounting automation.

## Target customer and personas

**Fact:** initial target is Shopify merchants with approximately 1,000–100,000 monthly orders,
Stripe processing, CSV or QuickBooks Online accounting, and a small finance/operations team using
manual or spreadsheet reconciliation.

Personas:

- Finance operations analyst: runs reconciliation, investigates exceptions, drafts resolutions.
- E-commerce operations analyst: diagnoses source timing, order, refund, and identifier issues.
- Finance manager: sets tolerance policy and approves consequential resolutions.
- Operations manager: monitors connector health and exception throughput.
- Internal auditor: reads evidence and append-only history without mutation rights.
- System administrator: manages identity, membership, connectors, retention, and security settings.

## Jobs to be done

Users need to confirm paid-order/payment and refund consistency; find missing, duplicated, delayed,
malformed, or inconsistent records; understand why each exception exists; review and approve a
proposed resolution; prove who decided what and when; know source freshness; and safely replay a run
without duplicate work.

## Existing workflow

**Owner-stated, not yet observed:** users export data, combine sheets, create formulas or lookups,
manually investigate mismatches, communicate decisions out of band, and rerun work with limited
provenance. No customer-interview, time-on-task, error-rate, or cost evidence has been collected.

## Proposed workflow

1. An owner creates an organization, invites members, and grants explicit permissions.
2. An administrator connects read-only Shopify and Stripe accounts or imports an accounting CSV.
3. Connector health shows backfill, webhook, scheduled-sync, freshness, and error state.
4. An authorized analyst starts or schedules a reconciliation over an immutable input snapshot.
5. Versioned deterministic rules match exact and composite candidates, validate money/currency, and
   create stable exceptions for conflicting or missing evidence.
6. The analyst opens an exception, compares raw and normalized evidence, and drafts a resolution.
7. A permitted reviewer approves, rejects, edits, or defers it; policy can require dual approval.
8. The append-only timeline records every decision and version. No V1 action writes to a source.
9. Optional AI may rank ambiguous candidates or explain evidence, but never decides or approves.

## Functional requirements

### Identity, organizations, and permissions

- Standards-based hosted/self-hosted OIDC and local development identity.
- Secure, revocable sessions; email verification/reset where password auth is configured; MFA
  capability for privileged users; invitation and deactivation workflows.
- A provider-verified identity with no active membership can idempotently create one first
  organization and becomes its owner. Browser input cannot choose organization/user/membership IDs,
  role, permissions, or AI enablement; later-organization creation requires a separate policy.
- Organizations, memberships, and explicit permissions mapped to Owner, Administrator, Analyst,
  Reviewer, and Read-only auditor defaults.
- Permissions include organization/member/connector/retention management, financial record view,
  reconciliation start, exception review, resolution approval, export, audit history, and owner-only
  support-grant management. Platform support diagnostic use is a separate default-disabled OIDC/MFA
  and tenant-grant authority, not a tenant permission.

### Ingestion and canonical records

- Shopify read-only installation, backfill, cursor sync, verified/deduplicated webhooks, privacy
  hooks, disconnect, repair sync, rate-limit handling, and freshness.
- Stripe least-privilege authorization, raw-body signature verification, backfill, idempotent
  asynchronous webhooks, API-version tracking, disconnect, repair, and freshness.
- CSV size/MIME/schema limits, versioned template, mapping, preview, row errors, idempotent import,
  rollback, tenant-safe storage/retention, and formula-injection-safe exports.
- Immutable raw source events separated from versioned normalized records with complete provenance.

### Reconciliation and exceptions

- Versioned pipeline: exact ID, deterministic composite key, amount/currency, date/customer,
  tolerance, fuzzy candidates, optional AI ranking, human review.
- Model multiple payments/refunds, partial refunds, fees, taxes, discounts, reversals, delayed
  records, missing/incomplete data, duplicates, updates, and currency conflict.
- Stable replay identity prevents duplicate matches, exceptions, approvals, and audit events.
- Exception queue supports type, status, source, amount, confidence, assignee, age, and search.
  Amount filters use exact currency plus integer minor units without conversion; age is evaluated in
  server UTC; source and assignee filters never grant authority.
- Queue confidence is deterministic review-routing metadata from versioned rule evidence, not a
  probability, measured accuracy result, or AI score. Missing or malformed evidence remains
  unclassified and fails closed under enabled dual control.
- Investigation shows side-by-side source and normalized values, provenance, applied rules,
  tolerance, confidence, conflict, notes, assignment, and complete timeline.
- Investigation evidence crosses the browser boundary only through strict, bounded, versioned
  projections. Unsupported, future, malformed, oversized, inconsistent, or tenant-unresolved
  evidence shows one explicit unavailable state; no raw or partial JSON fallback is displayed.
- Review actions: approve, reject, revise the original proposer's pending proposal by immutable
  replacement, defer, reason, note, assign. A revision never edits evidence in place; prior
  approvals remain historical and do not apply to the new version. Configurable dual approval
  applies to high value, low confidence, or sensitive resolution categories.

### Audit, operations, retention, and support

- Audit events are append-only and include organization, actor, action, resource, timestamp,
  correlation, before/after as appropriate, reason, rule/connector/model/prompt versions, and chain.
- Connector and run health, alerts, structured redacted logs, traces, metrics, and health endpoints.
- Tenant-safe export, deletion, configurable retention, backup/restore, and restricted support
  tools.
- Restricted support tools keep platform support and tenant-owner authority in separate browser
  surfaces. The support console has no tenant directory, keeps its one-time request code only in
  page memory, accepts exact approved identifiers, and renders only the fixed aggregate diagnostic
  schema. The tenant Security surface alone lists, approves, and revokes organization-bound grants
  with explicit confirmation and audit-visible reasons.
- Destructive retention has no unapproved default; per-organization changes are bounded,
  permissioned, reasoned, explicitly confirmed, legal-hold aware, and leave immutable minimal
  completion evidence. Object versions and backups require independently verified lifecycle.
- No source-system financial writes exist in the V1 permission model, connector interfaces, or UI.

## V1 exception taxonomy

Canonical reconciliation exceptions:

- `paid_order_missing_payment`
- `payment_missing_order`
- `order_payment_amount_mismatch`
- `currency_mismatch`
- `shopify_refund_missing_stripe_refund`
- `refund_missing_accounting_entry`
- `refund_amount_mismatch`
- `partial_refund_discrepancy`
- `missing_processing_fee`
- `duplicate_order`, `duplicate_payment`, `duplicate_refund`, `duplicate_processing_fee`,
  `duplicate_accounting_entry`
- `missing_identifier`, `malformed_identifier`
- `delayed_source_record`
- `ambiguous_identity`
- `incomplete_source_record`

Bounded accounting-import validation outcomes:

- `invalid_csv_row`, `unsupported_csv_row`

Invalid or unsupported rows do not become canonical records and therefore do not create
reconciliation exceptions. They remain visible in import preview/commit results with bounded row
evidence. Taxonomy additions and rule behavior changes are versioned and documented. Fraud is not
inferred or claimed.

## Reconciliation policies

- Money is integer minor units with ISO currency. Binary floating point is forbidden.
- Cross-currency records never match automatically; V1 performs no conversion.
- Default exact-match tolerance is zero. Any non-zero amount/date tolerance is organization policy,
  captured in the run snapshot, bounded by platform limits, and visible in evidence.
- Exact provider identifiers outrank composite identifiers. Conflicting exact evidence creates an
  exception rather than being hidden by a fuzzy score.
- Canonical records with malformed identity-bearing fields are preserved as immutable input evidence
  but excluded from automatic matching and candidate ranking.
- Time comparisons use source timestamp, normalized UTC instant, and configured business time zone.
- A delayed-event grace window may defer rather than close an exception; it never fabricates data.
- Determinism, rule-set version, input snapshot, and stable keys are mandatory for replay.

## Human-review policies

- A proposal is not a resolution until the required authorized reviewer(s) approve it.
- A proposer cannot satisfy both approvals when dual control is enabled.
- Review records are append-only; corrections create superseding records.
- Reasons are required for rejection, edits to deterministic proposals, and sensitive approvals.
- Approval changes no external system in V1. Exports label decisions as ReconAI review outcomes.

## AI boundaries

AI is disabled by default and can be disabled per organization. It may rank ambiguous candidates,
classify an exception, explain evidence, or suggest investigation steps. It cannot alter money,
override a rule, hide evidence, approve, obtain permission, call unrestricted tools, or write to a
source. Inputs are minimized and treated as hostile data. Outputs require strict schema validation,
recorded evidence/version/confidence, timeout, bounded retry/rate/cost, and human fallback. No
production tenant enablement occurs before an evaluation dataset and regression evidence exist.
Providers may not train on customer data.

## Non-functional requirements

- Tenant isolation at API, database/RLS, job, cache, storage, search, log, export, and admin layers.
- Replay-safe idempotency, transactional outbox, durable jobs, bounded backoff, DLQ, safe replay,
  circuit breaking, partial-failure states, backups, and restore tests.
- Replaceable auth, model, storage, queue, email, observability, and deployment interfaces.
- Reproducible self-hosting without paid accounts, private infrastructure, or real customer data.
- Proposed SLOs are targets only until staging evidence exists; see `GOALS.md`.
- Semantic versioning, migrations, upgrade/rollback, SBOM, checksums/signing, and supported
  versions.

## Security and privacy requirements

Least privilege; runtime validation; deny-by-default authorization; tenant RLS; CSRF/origin
protection; rate and payload limits; CSP and secure headers; output encoding; encrypted connector
tokens with rotation; TLS and encrypted storage; session revocation; security audit logging;
retention/export/deletion; secret, dependency, static, container, license, and SBOM scans. Never log
tokens, secrets, credentials, full payment data, or unnecessary personal information. Threats and
controls are maintained in `docs/threat-model.md`.

## Accessibility requirements

Target WCAG 2.2 AA behavior: semantic structure; complete keyboard operation; visible focus;
screen-reader names; accessible dense tables and dialogs; error summaries; adequate contrast;
reduced motion; and status conveyed with text/icon as well as color. Automated checks supplement,
but do not replace, keyboard and screen-reader review.

## Observability requirements

Correlation IDs, structured redacted logs, distributed traces, API and queue metrics, job duration,
webhook result, connector freshness, reconciliation duration/count/rate, and AI latency/cost/failure
metrics. Health endpoints distinguish liveness, readiness, and dependency degradation. Alert
thresholds are exercised in staging before production claims.

## User journeys

### First reconciliation

Owner signs in → creates organization → invites analyst/reviewer → connects providers/imports CSV →
sees freshness/backfill → analyst starts run → system records snapshot and rules → analyst reviews
exceptions → reviewer decides → auditor reads complete evidence.

### Delayed refund

Shopify refund arrives before Stripe refund → grace-window exception is open/deferred → verified
Stripe event later normalizes → replay supersedes the exception without deleting history → timeline
shows both observations and final deterministic result.

### Duplicate replay

Worker retries an already-completed run → stable run/input/rule identity is detected → existing
matches/exceptions are returned → no approval or audit event is duplicated.

### Cross-tenant denial

A member changes a route organization ID or resource UUID → API resolves membership and rejects or
returns not found → database RLS independently prevents access → no count, export, log, or timing
detail reveals the other tenant.

## Success metrics

No achieved product metrics exist yet. Initial measurements:

- Percentage of provider records ingested without terminal error, by connector/version.
- Time from source availability to normalized availability (freshness).
- Deterministic replay equality and duplicate-artifact rate (target: exact equality and zero).
- Exception precision by reviewed taxonomy, reported with sample size.
- Median and tail investigation/decision time, without claiming causation or savings.
- Reviewer agreement with deterministic and optional AI suggestions.
- Cross-tenant security suite results and restore-drill results.
- Availability/error/latency measurements against proposed SLOs in `GOALS.md`.

## V1 scope

Shopify read-only, Stripe read-only, accounting CSV, canonical model, deterministic engine,
exception queue/workspace, human approval, append-only audit, optional controlled AI, organizations,
permissions, connector health, observability, secure deployment design, backups/restoration, and
open-source self-hosting.

## Explicit non-goals

Automated bookkeeping; tax calculation; unapproved currency conversion; forecasting; fraud claims;
payments/refunds; source/accounting write-back; journal creation; autonomous agents; chatbot;
unsupported certifications; QuickBooks write access; first-milestone shipping providers; and
subscription billing before the core workflow is validated.

## Launch criteria

All Definition-of-Done checks in `AGENTS.md`; verified tenant isolation and financial invariants;
authenticated/idempotent webhooks; successful backup restore; exercised alerts; fresh-clone
self-host proof; rollback; AI safe-disable; no source write path; complete history/fixture secret
review; license owner confirmation; private vulnerability reporting and repository security
settings; known limitations and threat model published. The working name must be resolved.

## Risks

- **High:** working-name collisions with existing ReconAI products and package namespace.
- **High:** tenant context omission or privileged database role bypassing RLS.
- **High:** plausible but financially incorrect matching caused by identifier/timing edge cases.
- **High:** stolen connector tokens, forged/replayed webhooks, or overscoped provider access.
- **Medium:** CSV ambiguity and locale-dependent amounts/dates.
- **Medium:** queue retry storms, provider rate limits, partial backfills, and stale health signals.
- **Medium:** AI prompt injection, data leakage, unsupported inference, cost, and regression.
- **Medium:** open-source maintenance and upgrade compatibility burden.

## Assumptions and hypotheses

- Owner-selected working scope and personas are facts for planning, not validated market evidence.
- Hypothesis: Shopify + Stripe + CSV is the highest-value vertical slice.
- Hypothesis: configurable dual approval is sufficient for initial segregation-of-duties needs.
- Assumption: PostgreSQL, Redis-backed jobs, and S3-compatible storage are acceptable self-hosting
  dependencies.
- Assumption: English UI and ISO currencies are acceptable for V1; locale policy is open.

## Open questions

- Product name and package scope after owner/legal review.
- First design partners and observed reconciliation samples using safely handled data.
- Default delayed-event windows and bounded tolerance policy by source/business time zone.
- Identity provider and email defaults for managed hosting.
- Data residency, default retention, deletion verification, and support-access policy.
- High-value and sensitive resolution thresholds.
- Staging provider/accounts, deployment platform, SLO budget, and incident ownership.
- CSV template variants and QuickBooks export formats in actual use.

## Future roadmap

After deterministic hardening: controlled AI evaluation/rollout; QuickBooks Online read-only;
shipping connectors; connector SDK; enterprise identity; and subscription billing. No expansion
supersedes tenant isolation, financial correctness, evidence, or read-only V1 boundaries.
