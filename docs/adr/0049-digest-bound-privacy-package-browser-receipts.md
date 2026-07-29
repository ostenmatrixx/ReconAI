# ADR 0049: Digest-bound privacy-package browser receipts

- Status: Accepted
- Date: 2026-07-29
- Extends: ADR 0015

## Context

ADR 0015 creates a complete-or-fail Shopify customer-data evidence package, records that it was
prepared, and sends the bytes through the authenticated BFF to the operator's browser. Its audit
event deliberately says `not_delivered`. That design does not distinguish a successful preparation
from a response that was interrupted before the authenticated browser received and verified the
complete bytes.

Persisting package bytes would create another sensitive customer-data copy and require a separately
approved storage, encryption, download, revocation, retention, and deletion lifecycle. A long-lived
or reusable download token would create similar authority. Conversely, marking preparation as
delivery would overstate what ReconAI can prove: a browser response cannot prove that the merchant
reviewed the package, transferred it to the intended customer, fulfilled a legal request, or deleted
independent downloaded copies.

## Decision

1. Keep package preparation synchronous, bounded to 100 source records and five MiB, and
   complete-or-fail. ReconAI does not persist the package bytes.
2. Generate a random 256-bit base64url receipt token only after the complete JSON package has been
   assembled and validated. Return the raw token exactly once in a private/no-store response header.
3. Persist only SHA-256 digests of the package bytes and receipt token, plus the package UUID,
   tenant/request authority, exact byte count, preparing membership, preparation time, and expiry.
   Customer/provider identifiers, package bytes, and the raw token are not stored or audited.
4. Expire unused receipt authority exactly ten minutes after package preparation. Expiry limits only
   the ability to create the browser-receipt evidence; it does not expire or delete a downloaded
   copy.
5. Add one append-only receipt row per tenant/package. The row records a random receipt UUID, the
   receiving membership, and receipt time. A tenant/package unique key and an advisory transaction
   lock serialize concurrent calls.
6. Require the same active membership that prepared the package to acknowledge it, with both
   `retention:manage` and `data:export`. Re-resolve authentication and membership at the API
   boundary and recheck the tenant, request, package, membership, and token digest inside fixed
   database authority.
7. Conceal unknown, foreign-tenant, wrong-request, wrong-package, wrong-membership, and wrong-token
   combinations as not found. An unused authority first presented after expiry returns the bounded
   expiry error.
8. Make an exact successful retry idempotent. It returns the original receipt time even after token
   expiry and does not append a second receipt or audit event.
9. Grant the application role only package-authority insertion and execution of the fixed
   acknowledgement function. Revoke its direct reads and mutations of both tables and direct receipt
   insertion. Grant the worker no table or function authority. Force tenant RLS, use
   tenant-composite foreign keys, and reject updates/deletes with append-only triggers.
10. Add the dual-authorized API route
    `POST /v1/organizations/:organizationId/provider-privacy-requests/:requestId/data-package/:packageId/receipt`
    and increase the exhaustive route-security inventory from 47 to 48.
11. Keep the existing preparation BFF request backward compatible. Add a strict
    `acknowledge_browser_receipt` body variant. Both requests enforce exact origin/session/selected
    organization context, omit browser credentials on the API hop, reject redirects, use bounded
    response reads, and return private/no-store responses.
12. Buffer the full non-empty package in the browser, validate the package/receipt headers, and
    acknowledge receipt before triggering the file download. If acknowledgement fails, do not
    initiate the download.
13. On the first acknowledgement, append `provider_privacy.data_package_received_by_browser` in the
    same database transaction. Bind the event to the package UUID, content digest, byte count,
    membership actor, schema versions, and receipt time while retaining
    `deliveryStatus: not_delivered`.
14. Describe the evidence precisely as authenticated-browser receipt of complete bytes. Do not call
    it merchant delivery, customer delivery, review, legal fulfillment, compliance completion, or
    downloaded-copy expiry.

## Consequences

ReconAI can now distinguish package preparation from one authenticated browser's receipt of the
complete response bytes. The package and receipt rows are immutable tenant evidence, and exact
retries converge without duplicate audit authority. A stolen raw receipt token is bounded by exact
tenant/request/package/preparing-membership checks and a ten-minute unused-authority window; only
its digest remains after the response.

The flow still places sensitive bytes in browser memory and then in an operator-controlled download.
ReconAI cannot revoke, observe, or delete that copy. Browser receipt also does not establish who
ultimately reviewed or received it, whether secure transfer was used, whether the recipient was the
correct customer, whether other merchant systems were included, or whether the request was legally
fulfilled. The underlying privacy request remains `action_required`.

A browser or network failure after acknowledgement but before the browser download event may record
receipt without a saved file. This is acceptable because the audit statement is limited to browser
receipt of complete bytes, which occurs before acknowledgement. The operator can prepare a new
package and authority; each preparation is independently immutable and audited.

## Alternatives considered

- Treat successful package preparation as receipt: rejected because a response can fail after
  preparation and the existing audit correctly says `not_delivered`.
- Store the package and issue a signed download URL: rejected because it creates a sensitive copy
  and retention/revocation lifecycle outside the approved scope.
- Store the raw receipt token for lookup or support: rejected because digest comparison is
  sufficient and raw bearer authority is unnecessary at rest.
- Use a reusable or day-long token: rejected because acknowledgement happens in the same browser
  operation and needs only a narrow retry window.
- Let any administrator acknowledge a package: rejected because it would detach evidence from the
  authenticated membership that received the raw token and package bytes.
- Trigger the download before acknowledgement: rejected because an acknowledgement failure would
  leave an unrecorded browser download.
- Claim merchant/customer delivery after acknowledgement: rejected because the browser boundary
  cannot prove downstream transfer, identity, review, fulfillment, or copy disposal.

## Security, tenant, privacy, and operational effects

Migration 0050 adds two append-only, forced-RLS tenant tables, exact tenant-composite request and
membership relationships, digest/size/expiry checks, and a fixed `SECURITY DEFINER` acknowledgement
function with a fixed search path and row security enabled. The function verifies the active tenant
context, exact package tuple, same active preparing membership, token digest, expiry, and unique
receipt under an advisory lock. Application and worker grants are explicitly narrowed after default
privileges.

The token is a short-lived bearer secret. It must not enter URLs, cookies, logs, telemetry, audit
events, error bodies, source control, or persistent browser storage. API and BFF responses use
private/no-store and fixed safe headers. The browser holds the token only in the local operation and
sends it in a same-origin JSON body over the authenticated BFF. Structured application logs do not
record bodies or headers.

No money, currency, deterministic reconciliation rule, connector permission, source-system write, AI
authority, proposal/approval authority, or privacy-request completion state changes.

## Migration, rollout, rollback, and verification

Migration 0050 is additive but takes short catalog locks while creating two tables, indexes,
policies, triggers, and functions. Apply it before deploying the API/web images that insert package
authority and call the receipt function. Prior images ignore the new tables. New images are not
compatible with a database missing migration 0050.

Rollback disables package preparation at the UI/API or restores the prior compatible API/web image.
Leave package and receipt evidence in place; do not drop, update, delete, or rewrite it. Expired
token digests have no acknowledgement authority, but their immutable preparation evidence remains.
Rollback cannot revoke or delete downloaded copies and cannot turn a browser receipt into proof of
merchant/customer delivery.

Acceptance requires formatting, lint, strict typecheck, unit/API/BFF/route-contract/static-migration
tests, production build, complete Chromium plus accessibility checks, secret scan, production
dependency audit, and migration-chain validation. The checked-in PostgreSQL test must cover
restricted-role insert/function behavior, digest-only persistence, same-membership idempotence,
cross-tenant concealment, one receipt/audit event, and application/worker table denial. When the
required local URLs are absent, that live PostgreSQL behavior remains source-defined and must be
called out rather than claimed.
