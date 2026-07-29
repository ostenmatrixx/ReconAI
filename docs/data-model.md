# Canonical data model

This document describes both the implemented Goal 1 schema and planned production tables. The
implemented migration history is authoritative. Planned fields/tables below are not capabilities
until a migration, repository, authorization path, and verification evidence exist.

Implemented now: organizations (including bounded dual-review policy), users, memberships,
single-use organization invitations, connections, imports, immutable source events, versioned
canonical records and field provenance, reconciliation runs with append-only pinned inputs and
complete evaluated policy snapshots, match/exception occurrence history, resolution proposals and
append-only approvals, hash-chained append-only audit events, and retry/dead-letter-aware outbox
events. Per-organization raw-object retention policy, legal hold, bounded deletion jobs, and
append-only deletion tombstones are also implemented. Shopify app-level privacy request evidence,
raw-object deletion jobs, and deletion tombstones are implemented with synthetic/static coverage.
Default-disabled tenant-approved restricted support request/grant ledgers and a fixed aggregate
diagnostic projection are implemented with local PostgreSQL evidence.

Planned or incomplete: per-membership permission overrides, revocable sessions, feature flags,
external accounts, persisted reconciliation policy versions, AI evaluations, export inventory,
retention for canonical/audit/export/telemetry/backup classes, and whole-tenant deletion.

## Design rules

PostgreSQL is authoritative. Every customer-owned row has non-null `organization_id`; customer
indexes begin with it; public IDs are opaque UUIDs; raw source events are immutable; normalized
versions retain field provenance; money uses signed 64-bit integer minor units plus ISO currency;
and audit events are append-only. Database RLS is defense in depth, not a replacement for API
authorization.

## Identity and access

- `organizations`: tenant identity, display name, positive optimistic `profile_version`, business
  time zone, status, AI-disabled flag, dual-approval enablement/amount thresholds/sensitive
  categories, created/updated timestamps. The product profile route currently changes only the
  display name; business time zone remains read-only because it affects financial business-date
  interpretation.
- `users`: global identity linked to standards-based auth subject; active/deactivated status.
- `memberships`: organization/user, default role, active/invited/deactivated status. Unique
  `(organization_id, user_id)`.
- `organization_bootstrap_requests`: append-only, tenant-scoped first-organization idempotency
  evidence binding a user and UUID request key to the canonical input SHA-256, organization, and
  first owner membership. Forced RLS, tenant/composite foreign keys, a unique
  `(user_id, idempotency_key)` constraint, and update/delete rejection apply. The application and
  worker have no direct table access.
- `organization_invitations`: organization, normalized invited email, initial role, status, SHA-256
  token digest, inviter membership, 72-hour expiry, acceptance/revocation actor and timestamps. The
  256-bit raw bearer token is returned once and is never stored. Forced RLS, immutable authority
  fields, one-pending-invitation-per-email, terminal transitions, and fixed `SECURITY DEFINER`
  functions constrain create/revoke/accept behavior.
- Invitation email delivery has no raw-token column or message-body persistence. Append-only audit
  events record only accepted/disabled/failed status, provider kind, bounded provider message ID or
  stable error code, correlation, and template version.
- `membership_permissions`: planned. Current explicit permissions are produced by the versioned
  application role matrix; sensitive operations are checked explicitly. `support:manage` is
  explicitly owner-only and cannot be added to a non-owner override.
- `support_access_requests`: platform-scoped, organization-unbound 256-bit request authority stored
  only as SHA-256 plus a keyed support-identity digest, requested 5–60 minute duration, exact
  15-minute expiry, and pending/claimed state. A claimed request names the exact organization/grant
  through a composite foreign key. It contains no ticket, email, raw OIDC claim, raw token, or
  customer data. Application/worker roles have no direct access.
- `support_access_grants`: tenant-scoped keyed support identity, fixed `diagnostics:view`
  capability, ticket/reason, active owner approver, approval/expiry, and optional owner revocation.
  Forced RLS, tenant-composite membership keys, 5–60 minute duration, and mutation triggers apply.
  Fixed app-only functions create/consume/list/revoke authority and return capped aggregate
  operational diagnostics; the worker has no access. Approval, use, and revocation append to
  `audit_events` with actor type `support` for diagnostic access.
- `sessions`/identity adapter tables: server-managed, revocable, bounded. No browser-readable token
  storage is used for privileged credentials.
- `feature_flags`: tenant flag key, value, configuration version, actor, and audit link.

Users are not customer-owned financial rows, but access to user/member data is tenant-bound through
memberships. Invitation acceptance requires an authenticated OIDC subject whose provider-verified,
normalized email exactly matches an unexpired pending invitation. Acceptance atomically creates one
active membership, consumes the token, and appends audit evidence.

Organization discovery uses no client-granted tenant context. A fixed identity-directory function
intersects issuer/subject with active user, membership, and organization state, returns at most 101
rows for a 100-item lookahead page, and orders by normalized name plus UUID. Search escapes SQL
wildcards. An optional organization UUID narrows that same identity-derived relation for selection;
it does not grant access. The prior bounded two-argument function remains temporarily for rolling
application compatibility.

First-organization creation is a separate fixed identity function because no tenant context exists
yet. It serializes by issuer/subject, permits only an active verified-email identity with zero
active memberships, generates one active organization/owner membership with AI disabled, and records
digest-bound retry evidence. The API appends `organization.created` audit evidence in the same
transaction. Exact retries replay; conflicting input or later organization creation does not.

## Connections and ingestion

- `data_source_connections`: provider, organization, status, external account reference, scope/API/
  connector version, distinct webhook-signing and read-API credential references, cursor, freshness
  and error summary. A null read reference means provider sync is disabled.
- `source_events` preserves the authenticated provider transport topic or CSV row topic; provider
  topics are not product-facing object families. Migration 0048 adds an online covering raw-event
  index ordered by tenant, connection, topic, source time, and receipt time.
- `source_event_object_classifications` records the complete immutable fixed-family result for one
  source event as a duplicate-free array under classifier version `source-object-family-v1`.
  Migration 0049 adds the tenant-composite foreign key, forced RLS, append-only enforcement, and
  least-privilege reads/writes. It performs no legacy inference or backfill. Migration 0051 adds
  execute-only bounded repair authority: a dedicated maintenance role can claim one allowlisted
  locked source row, but cannot directly read or write source, classification, or audit tables.
  Verified repair appends the classification and fixed tenant audit atomically. The authorized
  health view joins classification to receipt evidence and returns no source-event/object ID or
  count; a classification gap makes the entire connection family view unavailable rather than
  implying absence. No state infers normalization or completeness.
- `connector_credentials`: tenant/connection/purpose-bound AES-256-GCM envelope, key version,
  envelope digest, creating membership, optional prior credential, and active/superseded/revoked
  lifecycle timestamps. Forced RLS, composite tenant foreign keys, one active row per purpose,
  immutable authority/ciphertext, and delete rejection apply. OAuth refresh generations are
  service-authored only by the fixed `provider-token-refresh-v1` authority and must identify their
  superseded predecessor. API responses expose metadata only.
- `provider_authorization_attempts`: organization/connection/provider, SHA-256 state digest,
  requested account, requesting membership, ten-minute issued expiry with a 15-minute database
  ceiling, and single-claim lifecycle evidence. Authority fields are immutable, one
  pending/exchanging attempt exists per connection, forced RLS applies, and terminal attempts cannot
  be replayed. Raw state and authorization codes are not stored.
- `provider_deauthorization_events`: append-only forced-RLS Stripe App uninstall evidence containing
  tenant/connection, globally unique provider event/account, raw-body digest, live/test mode, and
  occurred/received times. A narrow app-only resolver maps the signed globally unique Stripe account
  before tenant context exists; subsequent credential revocation and audit run inside that resolved
  tenant transaction. The worker cannot read the table or execute the resolver.
- `provider_privacy_requests`: append-only forced-RLS Shopify app-level request evidence containing
  tenant/connection, unique webhook identity, one mandatory topic, canonical shop, bounded
  customer/request/order IDs, raw-body digest, API version, received/due times, and
  `action_required` status. It contains no customer email/phone. A narrow app-only resolver maps the
  HMAC-authenticated canonical shop before tenant context exists; subsequent writes use the resolved
  tenant transaction.
- `provider_privacy_request_deadline_alerts`: append-only forced-RLS threshold evidence containing
  only tenant/request authority, one of `due_7_days`, `due_24_hours`, or `overdue`, the immutable
  deadline snapshot, and observation time. A worker-only fixed candidate function returns at most
  500 internal rows; creation rechecks exact tenant context, request/deadline/stage authority, clock
  proximity, and a unique request/stage key before the same transaction appends a system audit
  event. Application and worker roles cannot insert or mutate the ledger directly.
- Customer-data evidence package bytes are never stored as a second export copy. A tenant repository
  reads an active `customers/data_request`, resolves at most 100 linked Shopify/Stripe
  `source_events` plus sanitized `canonical_records`, verifies each raw object against
  `payload_sha256`, and appends only preparation metadata to `audit_events`. Accounting CSV source
  objects are deliberately outside this resolver because one import object can contain records for
  unrelated customers.
- `provider_privacy_data_packages`: append-only tenant/request/preparing-membership authority for a
  completed package response. It stores the package content SHA-256, byte count, receipt-token
  SHA-256, preparation time, and an exact ten-minute receipt expiry. It contains neither package
  bytes nor a raw receipt token. The application can insert but cannot read or mutate the table; the
  worker has no access.
- `provider_privacy_data_package_receipts`: one append-only tenant/package/receiving-membership/time
  row created only through a fixed tenant-checked function. A unique tenant/package key makes exact
  retries idempotent. The same active membership that prepared the package must present the correct
  token digest before expiry. The application and worker cannot access the table directly.
- `provider_privacy_object_deletion_jobs`: immutable tenant/request/source/object/checksum
  authority, bounded retry state, and a current status. App access can create/read
  database-validated jobs; the worker has no direct table access and uses fixed claim/finalize/fail
  functions.
- `provider_privacy_object_deletion_tombstones`: append-only
  tenant/request/job/source/object/checksum evidence for `deleted` or `already_missing` raw objects.
  The privacy claim/finalize transaction takes the same organization advisory lock as legal-hold
  mutation.
- `PostgresProviderPrivacyOperationsRepository`: read-only tenant-transaction projection over the
  request/job ledgers. It returns bounded deadline rows and aggregate job counts through a
  tenant-bound earliest-deadline keyset cursor plus the highest durable escalation stage/time;
  customer, order, request, event, digest, object-key, checksum, and raw-payload fields are excluded
  from its SQL selection and API contract.
- `external_accounts`: provider object ownership mapping; unique `(provider, external_account_id)`
  prevents ambiguous webhook tenant routing.
- `imports`: organization, object key/checksum/template/mapping version, state, counts, actor,
  preview/commit/rollback timestamps, idempotency key, retention expiry.
- `source_events`: organization, connection/import, source, object type/id, provider event ID,
  source/API/connector versions, event/source/received times, encrypted payload object/checksum,
  processing status. Unique provider receipt identity within a connection.
- `outbox_events`: organization, aggregate, event type/schema, safe payload, correlation, published
  timestamp/attempt, and nullable execution-tracking version. Written in the same transaction as
  durable state. Migration 0040 leaves legacy and old-writer rows untracked; updated writers opt in
  explicitly so a rolling deployment never guesses that an old worker created execution evidence.
- `provider_sync_runs`: immutable organization/connection/provider/mode/window/page-ceiling,
  idempotency/correlation/requester authority plus cursor, monotonic page/item/duplicate/failure
  counts, stable error code, and queued/running/partial/succeeded/failed timestamps. Requester
  authority is an exact database-enforced XOR: a user run names one organization membership and no
  service, while a system run names the fixed `provider-gap-repair-scheduler` service and no
  membership. Windows are positive and at most 30 days; pages are 1–100; total items are at most
  10,000; failures are at most six. Forced RLS and composite foreign keys apply; authority and
  terminal rows cannot change, and deletion is rejected. The same ledger authorizes Stripe event
  pages and versioned Shopify order/refund snapshots; provider-specific cursors remain opaque. A
  fixed worker-only observer uses a partial `(provider, created_at, id)` index to return exactly one
  empty/active row for Shopify and Stripe, with only queued/running status and numeric age. Normal
  application and worker table reads remain tenant-scoped. Stripe version-2 cursors encode either
  the Events or charge-balance-transaction phase; they remain opaque ledger state, not client
  authority. A rolling rollback must not hand a version-2 cursor to an older worker.
- `job_executions`: one forced-RLS row per organization/outbox authority with immutable
  queue/job/idempotency/schema/correlation and maximum-attempt fields; current
  running/retryable/succeeded/dead-lettered state; attempt, heartbeat, lease, completion, and stable
  error evidence. A random execution token exists only in worker memory; PostgreSQL stores its
  SHA-256 digest. Worker-only fixed functions begin, renew, succeed, or fail a lease, while terminal
  rows are immutable.
- `queue_recovery_events`: append-only organization/recovery-run/outbox classification, stable job
  identity, bounded operator, reason, and recovery time. It records unpublished, never-started,
  retryable, or stale-running reconstruction. An event also provides durable evidence that a
  pre-migration unpublished row was intentionally recovered, so a later Redis loss can classify it
  without treating unrelated legacy published rows as safe.
- `canonical_record_supersessions`: append-only organization/record/version markers tying an
  accounting canonical version to its source import, authorized actor, correlation, reason, and
  supersession time. New run snapshots exclude marked versions; existing pinned runs remain
  reproducible.

OAuth credential plaintext is a validated versioned token bundle containing provider account,
scopes, issue/expiry times, refresh token when supplied, and Shopify or Stripe generation metadata.
The serialized bundle exists only inside an encrypted envelope with key ID and is never stored in
raw event JSON. Object paths contain environment, organization, purpose, and opaque ID.

## Canonical records and provenance

`canonical_records` is a versioned common envelope:

- organization, record ID, record version, kind, status;
- source event ID, source system, external object type/ID, external parent/account IDs;
- source timestamp, ingestion timestamp, effective business timestamp;
- connector and normalizer versions;
- amount minor units/currency where applicable;
- customer/order/payment/refund/accounting identifiers after normalization;
- normalized data JSON limited by a versioned schema;
- content hash, validity/incompleteness flags, superseded version, created timestamp.

Kinds: `order`, `payment`, `refund`, `processing_fee`, and `accounting_entry`. Provider-specific
facts live in a validated `normalized_data` shape but common reconciliation fields are typed
columns. Every normalized field has provenance in `canonical_field_provenance`: record/version,
field path, source value reference or safe scalar, normalized value, transformation rule/version,
source object/event/timestamp, and warnings. Raw payloads remain separately encrypted.

Updates create a new record version; they never overwrite an old source interpretation. A replay may
create a new normalizer version referring to the same source event.

## Money

`Money = { minor: bigint, currency: ISO4217 }`. Database columns are `bigint` and `char(3)` with
uppercase checks. Provider decimal strings are parsed using currency exponent policy; invalid
precision is an error, never rounded implicitly. When an approved policy requires rounding, store
input, method, exponent, output, policy version, and reason. V1 performs no currency conversion.

## Reconciliation

- `reconciliation_policies`: organization, version, rule-set version, business time zone, bounded
  date/amount/grace/dual-approval settings, actor, active time.
- `reconciliation_runs`: organization, stable run key, input/policy snapshot hashes, complete policy
  JSON, policy/rule/engine versions, initiating actor, status/timing, input/match/exception/error
  counts, bounded dispatch count, current operational-authority marker, and bounded last-error code.
  Unique stable run identity; triggers make identity/policy/input count immutable and succeeded
  state terminal. A partial unique index permits only one current operational authority per
  organization.
- `reconciliation_run_inputs`: organization/run, exact canonical record ID/version/content hash,
  stable ordinal, and creation time. Composite foreign keys prevent cross-tenant/run-record links;
  forced RLS and a trigger make rows append-only.
- `matches`: organization, run, stable key, rule ID/version, left/right record versions, source and
  normalized comparison evidence, tolerance/result/confidence, created timestamp.
- `exceptions`: organization, stable key, first/latest run, taxonomy/rule version, status/severity,
  record references, amount/currency, evidence, confidence, assignee, defer time, timestamps.
  Identical replays link the existing exception; a changed input/rule may supersede it. The
  operational queue uses tenant-prefixed severity-rank/creation/UUID and exact-type indexes for
  stable keyset pagination.
- `match_occurrences` / `exception_occurrences`: run-specific links to stable workflow artifacts.
- `match_occurrence_snapshots` / `exception_occurrence_snapshots`: exact `artifact-occurrence-v1`
  rule/type/version, record-reference, evidence, observed-state, and capture context for a run
  occurrence. These additive tables are forced-RLS and append-only; the application reads them and
  the worker may only insert. Occurrences created by a rolling-window older worker may lack a
  snapshot and are exposed only as labeled current-artifact projections, never as reconstructed
  historical facts.
- `exception_status_events`: append-only run-linked first-observed, automatically superseded, and
  authoritative re-observed transitions. Forced RLS and role grants make these worker-insert-only
  and application-read-only.
- `exception_notes`: organization, exception, author membership, bounded internal note body, and
  timestamp. Notes are tenant-isolated and append-only; corrections require a new note.
- `resolution_proposals`: organization, exception, immutable proposal ID/version, proposal
  type/body/evidence, proposer, required approvals, status, confidence, optional model/prompt,
  timestamp. A proposer revision changes only the prior version's lifecycle status to `superseded`
  and inserts a new ID/version; proposal evidence is never edited in place.
- `approvals`: organization, proposal/version, actor, decision/reason, ordinal, timestamp. Unique
  per required independent reviewer. Approval rows remain bound to the exact historical
  proposal/version and never count toward a replacement version.

Foreign keys include organization where practical, preventing a record from referring across tenants
even if application code is wrong.

## Audit and evaluation

- `audit_events`: organization, opaque event ID, actor type/ID, action, resource type/ID, business
  occurrence time, correlation, reason, before/after safe JSON, rule/connector/model/prompt
  versions, approval-chain reference, previous-event hash, event hash, and hash version. One tenant
  genesis, unique tenant event/predecessor hashes, and a tenant-composite self-foreign key enforce a
  linear predecessor graph independently of business time; a same-lock insert trigger requires every
  non-replay row to extend the current head and closes multi-row cycle construction. Existing
  version-1 rows remain unchanged; repository-authored version-2 rows use canonical field-complete
  hashing. Application role has insert/select only; trigger rejects update/delete.
- `ai_evaluations`: organization or global synthetic dataset scope, dataset/case/model/prompt/schema
  versions, minimized input hash, structured output, expected label, measurements, reviewer result.

Audit history is not a substitute for source payload provenance. Privacy deletion may tombstone or
minimize actor/personal fields under documented policy, but normal application flows never mutate
audit content.

## Tenant row-level security

Application transactions set a local `app.organization_id` only after authorization. Every customer
table enables and forces RLS with:

```sql
USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
```

The application role is not the owner, superuser, or `BYPASSRLS`. Pool transactions always set and
automatically clear local context. Migration and maintenance roles are separate and audited.
`reconai_maintenance` is non-inheriting/non-bypass and receives only fixed function execution for
the bounded classification repair; it has no direct customer-table authority.

## Retention and deletion

- `organization_retention_policies`: organization, independently nullable raw-import and
  provider-event durations, legal-hold flag/reason, updater membership, and timestamps. No row or a
  null duration disables that class; database bounds are 1–3,650 days. Forced RLS and tenant
  membership foreign keys protect policy changes.
- `retention_deletion_jobs`: immutable tenant/source/object/checksum authority plus captured
  duration and eligibility time, status, bounded attempts, next retry, stable error code, and
  completion time. One job identity exists per organization/source kind/source ID. Application
  access is read-only; the worker has no direct table access.
- `retention_deletion_tombstones`: append-only organization/job/source/object/checksum evidence,
  duration, eligibility, terminal `deleted` or `already_missing` outcome, and deletion time. Unique
  tenant/source and tenant/object constraints prevent duplicate receipts.
- Fixed-query migration-owner functions claim, finalize, or fail one candidate for the worker. Claim
  locks the policy row through conditional object deletion; finalization rechecks legal hold,
  current duration, terminal source state, object key/checksum, and due time. Retry is exponential,
  capped at one hour, with ten attempts before dead-letter.

This workflow removes only terminal raw import/provider objects. It intentionally retains source and
import metadata, canonical/provenance records, reconciliation/review/audit evidence, job evidence,
and tombstones. Retention for exports, caches, telemetry, replicas, object noncurrent versions, and
backups remains an operator/legal decision. Whole-organization deletion still requires the broader
inventory and provider workflow described in `docs/privacy-and-retention.md`.

The separate Shopify privacy worker may remove an implicated raw provider object before normal
retention eligibility, but only for an authenticated persisted redaction request and only while no
organization legal hold is active. Its tombstone does not complete canonical/audit disposition,
merchant data-access delivery, noncurrent object-version expiry, or backup handling.
