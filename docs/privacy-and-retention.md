# Privacy and retention

This is an engineering baseline, not legal advice or a claim of regulatory compliance. The owner
must define controller/processor roles, jurisdictions, legal bases, subprocessors, notices,
contracts, legal holds, and production defaults with qualified counsel.

## Purpose and minimization

Collect only fields needed to connect orders, payments, refunds, fees, and accounting entries;
explain evidence; operate connectors; authorize users; and audit decisions. Do not collect PAN, CVC,
passwords, raw authentication credentials, or unrelated customer/address/order content. Provider
payload normalizers explicitly allowlist retained fields. Shopify normalizer `1.1.0` omits customer
email/reference, and a database trigger rejects that field on new Shopify canonical rows. Raw
payload access is restricted.

AI requests and telemetry receive minimized structured data, opaque identifiers where possible, and
no credentials or unnecessary personal/free text. Customer data is not used for model training.

## Classification

- Restricted: credentials/keys, sessions, raw events/imports, exports/backups, personal and detailed
  financial metadata.
- Confidential: canonical records, exceptions, notes, approvals, support tickets, AI evaluations.
- Internal: redacted operational metrics, architecture/configuration without secrets.
- Public: approved source code/docs and reviewed synthetic fixtures.

## Implemented raw-evidence policy

There is no platform or organization default duration. A missing policy row or blank duration means
deletion is disabled. An authorized organization administrator may independently configure raw
import and provider-event objects from 1 to 3,650 whole days. Each change requires a reason, exact
organization confirmation, current `retention:manage` permission, and an append-only audit event
containing the prior and new safe policy values.

An organization-wide legal hold suspends both raw-object classes and requires a 3–2,000 character
reason. Removing the hold clears that reason and is also audited. Policy and legal-hold changes lock
the same organization policy row used by the deletion claimant, so they serialize against an
in-progress deletion.

Only terminal evidence is eligible:

- Raw imports in `succeeded` or `rolled_back` state, measured from completion or rollback.
- Non-CSV provider events in `processed` or `normalized` state, measured from receipt.

The worker conditionally deletes only the exact object key whose stored `content-sha256` metadata
matches the database checksum. It also binds deletion to the current ETag and version ID when
available, gives every storage request a 15-second abort bound, and confirms the key is no longer
readable. Missing objects complete idempotently; checksum/ETag changes fail closed. Failures retry
with exponential backoff capped at one hour and dead-letter after ten attempts.

Successful or already-missing outcomes append an immutable tenant-scoped tombstone containing the
source kind/ID, object key, checksum, policy duration, eligibility time, outcome, and deletion time.
The workflow retains import/source metadata, canonical records, field provenance, reconciliation
history, exception/proposal/approval evidence, audit events, deletion job evidence, and tombstones.
It does not implement whole-tenant erasure.

## Implemented Shopify privacy intake and raw erasure

The fixed app-level endpoint `/v1/webhooks/shopify/privacy` accepts only `customers/data_request`,
`customers/redact`, and `shop/redact`. It verifies the exact raw-body HMAC with the confidential
Shopify app secret before parsing, requires the canonical shop header to match the signed payload,
and accepts only the configured quarterly API version. It never accepts an organization or
connection identifier from the public route.

After verification, a narrow resolver maps the canonical shop domain to one tenant connection. The
service discards email, phone, and unknown customer fields and stores only bounded provider
identifiers, topic/version/event identity, the body digest, received time, and a 30-day due time.
Unknown shops receive the same generic acknowledgement and cannot enumerate tenants. Each resolved
request pauses the connection in `action_required`.

Customer redaction creates raw-object deletion jobs only for Shopify source events tied to the
bounded supplied order IDs; shop redaction covers all raw source objects for the resolved
connection. Data-access requests do not delete automatically. The worker deletes only the exact
object key and checksum, treats absence idempotently, retries with bounded backoff, dead-letters
after ten attempts, and appends an immutable tenant tombstone. The claim, object request, and
finalization share an organization advisory lock with legal-hold changes, so a newly applied hold
cannot race finalization.

Every privacy request remains `action_required`: a raw-object tombstone is not proof that an access
package was delivered or that canonical/provenance history, exports, caches/search, telemetry,
replicas, noncurrent object versions, or backups were handled. Legacy canonical Shopify customer
references are not rewritten because that would invalidate immutable reconciliation hashes; their
disposition requires an owner/legal policy and a separately verified workflow.

An owner/administrator-only operator view lists request deadlines under the server-resolved tenant
context. Its database repository uses stable earliest-deadline keyset pagination with a tenant-bound
opaque cursor, then selects only request identity, connection, shop domain, topic/API version,
status, object-identifier count, timestamps, the highest durable deadline-escalation stage/time, and
aggregate deletion status counts. The API repeats that allowlist before returning data.
Customer/order/request/event identifiers, body digests, object keys, checksums, and payloads are not
part of the response contract. This is an operational queue, not a compliance-completion ledger;
every row remains action-required.

The worker deadline monitor is enabled by default and scans at a startup-validated cadence of one
minute to one day, with 1–500 candidates per pass. Its fixed cross-tenant function exposes only
internal organization/request IDs, due time, and a database-derived threshold. Each write re-enters
the exact tenant context and atomically creates at most one append-only `due_7_days`,
`due_24_hours`, or `overdue` signal plus a hash-chained system audit event. Warning/error logs
contain aggregate counts only. This supplies durable internal escalation evidence; it does not prove
that an external pager, email, ticket, or human response occurred.

For `customers/data_request`, an owner or administrator with both privacy-management and export
permission can prepare a JSON evidence package after entering a reason and confirming its limited
purpose. The repository resolves only tenant-bound Shopify events on the request connection and
Shopify/Stripe normalized records linked to the supplied order IDs. Accounting CSV objects are
excluded because a shared import could contain unrelated customers. Each object is checksum verified
with a one-MiB ceiling; the package is capped at 100 source records and five MiB. Missing, corrupt,
malformed, or overflowing evidence aborts the entire response without a partial download or success
audit.

The package includes the request identifiers, linked raw provider payloads, and minimized normalized
records while omitting object keys, digests, and internal tenant/source/canonical IDs. It declares
its exact scope and limitations. Successful preparation appends counts, byte size, reason, schema,
and `not_delivered` status to the audit chain, without subject/order/provider-request identifiers or
payload data. The package is not stored by ReconAI as a second object. Preparation does not transmit
it, satisfy legal review, clear `action_required`, prove merchant receipt, or cover data outside the
declared linked-provider-evidence scope.

Preparation also creates a random 256-bit receipt token whose SHA-256 digest, package-content
digest, exact byte count, preparing membership, and ten-minute expiry are stored in an append-only
tenant ledger. The raw token crosses only private/no-store response headers. After the browser has
buffered the complete non-empty package, it must acknowledge the exact tenant/request/package/token
through the same-origin BFF before the download starts. The same active membership and both
permissions are required. One append-only receipt and one audit event are created; an exact retry is
idempotent, while unused authority expires. This proves only authenticated-browser receipt of the
complete bytes. It does not prove merchant/customer delivery, review, legal fulfillment, or expiry
of the downloaded copy.

## Remaining retention classes

Owner/customer/legal approval is still required for canonical financial/provenance records;
reconciliation, exception, proposal, approval, and audit evidence; exports/previews; application and
security telemetry; backups; and tombstones. No duration should be inferred from the implemented
raw-object range.

Production expiry must cover caches, search, exports, replicas, and backup schedules. S3-compatible
versioned buckets require separately configured lifecycle expiry for noncurrent versions and delete
markers; backups require separate, tested expiry. A successful application tombstone is not evidence
that those independent copies have expired.

## Data subject/tenant workflows

Authorized export is tenant-scoped, bounded, encrypted in transit, and audited. Shopify now
assembles a bounded linked-provider-evidence package and records authenticated-browser receipt, but
secure merchant/customer delivery, recipient identity verification, downstream acknowledgement, and
downloaded-copy expiry are not implemented. A future whole-tenant deletion must disable
connectors/sessions, quarantine jobs, inventory data, process provider privacy hooks, remove
approved source/canonical/object/cache/search/export copies, apply backup expiry, and record a
minimal non-sensitive completion receipt. Identity and audit fields may be tombstoned/minimized
according to the approved legal/audit policy rather than silently changed. The implemented
raw-object workers are bounded components of that future workflow, not its completion.

## Security and access

Encryption in transit and at rest; envelope-encrypted connector secrets with key versions; private
tenant object keys; tenant RLS; least permission; MFA capability for privileged users; time-bound,
ticketed, audited support access; quarterly access review; redacted logs/errors; and separate
environment credentials.

Restricted support diagnostics are now disabled by default. When enabled, an exact OIDC group and
exact MFA authentication context identify a separate platform support principal; a dedicated HMAC
key converts issuer/subject to a durable digest before persistence. A support principal can create
only a 15-minute unbound request. An active tenant owner must approve that one-time code for one
organization and one fixed `diagnostics:view` capability lasting 5–60 minutes. The result exposes
only capped aggregate counts and timestamps for connection, provider-sync, reconciliation,
exception, and outbox health. It excludes raw payloads, credentials, account/customer identifiers,
money, normalized records, exports, notes, tenant browsing, impersonation, and writes.

Support request and grant evidence is append-only except for the single pending-to-claimed and
active-to-revoked transitions. Approval, diagnostic use, and revocation enter the tenant audit
chain. Expired unclaimed request rows currently remain retained because no approved deletion policy
exists; their stored support identity and token values are digests, but that does not remove the
need for an owner/legal retention decision. The ticket reference is an owner-supplied assertion, not
validated ticket-system evidence. Quarterly review, offboarding, customer notification, real IdP/MFA
enforcement, multi-replica key rotation, and protected-staging timing remain release gates.

## Providers and locality

Maintain a subprocessor/provider inventory with purpose, data categories, region, retention,
training terms, security contacts, and deletion/export capability. OIDC, storage, queue, email,
telemetry, and AI are replaceable for self-hosting and residency choices.

## Verification

Current local evidence covers default-disabled behavior, authorization and confirmation negatives,
legal hold, terminal eligibility, retry/dead-letter state, worker least privilege, forced RLS,
append-only tombstones, checksum/ETag-bound deletion, idempotent missing objects, browser behavior,
and accessibility. Synthetic Shopify privacy evidence additionally covers exact-body app HMAC, fixed
routing without client tenant IDs, topic/domain/API-version negatives, minimized persistence, tenant
resolution, database-authorized raw-object jobs, legal-hold serialization, and bounded worker
outcomes. Local synthetic evidence also covers digest-only receipt authority, the ten-minute bound,
same-membership/tenant/permission checks, idempotent acknowledgement, no-download-on-acknowledgement
failure, and the precise non-fulfillment audit statement. Release evidence must additionally cover
Shopify app subscription delivery, secure merchant/customer transfer and recipient acknowledgement,
downloaded-copy expiry, packages beyond the synchronous limits, canonical disposition, noncurrent
object versions, cache/search/export deletion, backup expiry sampling, telemetry/log snapshots, and
support access in a protected environment. Local restricted-support evidence now covers
default-disabled configuration, exact group/MFA claim authorization, keyed identity minimization,
tenant-owner approval, bounded expiry, revocation, fixed aggregate diagnostics, worker/direct-table
denial, cross-tenant concealment, append-only state, and hash-chained audit. It does not cover a
real IdP, ticket integration, notification, periodic review, offboarding, multi-replica rotation, or
protected-staging behavior. Results must be evidence, not assertions.
