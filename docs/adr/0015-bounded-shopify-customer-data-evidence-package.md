# ADR 0015: Bounded Shopify customer-data evidence package

Status: accepted  
Date: 2026-07-28

## Context

An authenticated Shopify `customers/data_request` supplies a customer ID, a data-request ID, and the
Shopify order IDs requested by the merchant. ReconAI holds immutable provider payloads and
normalized financial records that may be linked to those order IDs. An operator needs a safe way to
review that ReconAI-held evidence without exposing identifiers in the normal privacy queue, copying
storage authority into the browser, silently truncating results, or claiming that a download proves
legal-request fulfillment.

ReconAI cannot prove merchant delivery, data held outside ReconAI, canonical/legacy disposition,
backup expiry, or legal sufficiency. The package therefore has to declare a narrow evidence scope
and fail closed when that scope cannot be returned completely within a bounded synchronous request.

## Decision

- Only an active owner or administrator with both `retention:manage` and `data:export` can prepare a
  package. The API re-resolves membership and tenant context; unauthorized, foreign-tenant,
  non-data-request, and unknown request IDs are concealed as not found.
- The operator must supply an audit-visible reason and explicitly confirm that the result is a
  scoped evidence package, not proof of fulfillment or delivery.
- The repository selects only source events in the same tenant that are:
  - Shopify events on the resolved request connection tied to one of the supplied order IDs; or
  - Shopify/Stripe events with a normalized `order_reference` tied to one of those IDs.
- Accounting CSV source objects are excluded. A CSV object may contain many unrelated rows, so
  exporting an entire shared import based on one matching row would disclose other customers.
- At most 100 source records are admitted. Every raw object is read through its tenant-bound opaque
  key with the recorded SHA-256 and a one-MiB object ceiling. A missing object, digest mismatch,
  malformed UTF-8/JSON object, record overflow, or five-MiB final-package overflow aborts the whole
  response; no partial package or success audit is emitted.
- The JSON document includes the signed request identifiers, raw Shopify/Stripe payloads, and linked
  normalized records. Object keys, digests, internal organization IDs, internal source-event IDs,
  and canonical record IDs are omitted.
- The document declares its schema, preparation time, counts, exact scope, and limitations. It says
  that merchant review, data held outside ReconAI, delivery, audit/operational data, backups, and
  independent-copy handling remain outside the package.
- The API and Next.js BFF buffer and validate the complete response before returning a fixed safe
  filename with private/no-store, sandbox, and `nosniff` headers. Browser cookies are not forwarded
  to the API and upstream filenames are ignored.
- A successful preparation appends `provider_privacy.data_package_prepared` to the tenant audit
  chain. The audit contains the internal request/package IDs, reason, schema/format, counts, byte
  size, source counts, and `deliveryStatus: not_delivered`; it excludes customer/order/request
  provider IDs, raw payloads, object keys, and digests.
- The package is not persisted as a second object. The downloaded copy becomes operator/merchant
  controlled and must follow an approved secure delivery and deletion procedure.

## Consequences

An authorized operator can obtain a complete bounded snapshot of the provider evidence ReconAI can
link to the order IDs in the Shopify request. Cross-tenant access, silent truncation, unverifiable
object reads, shared-CSV disclosure, attacker-controlled filenames, and unaudited success are
rejected. Normal privacy-queue reads remain identifier-minimized.

The package does not complete the underlying request and cannot change its `action_required` status.
Requests exceeding the synchronous limits require a separately designed asynchronous export or
controlled investigation; operators must not split results manually and call them complete.
Delivery, recipient verification, acknowledgement, secure-transfer expiry, legal review,
legacy/canonical disposition, and independent-copy expiry remain open operational controls.

## Alternatives

Returning identifiers and payloads in the normal privacy queue was rejected because it broadens
routine exposure. Persisting every package in object storage was rejected because it creates a new
sensitive copy without an approved expiry and download-token lifecycle. Streaming was rejected
because integrity, total size, schema, and complete-or-fail behavior cannot be verified before bytes
reach the browser. Including accounting CSV objects was rejected because one shared file can contain
unrelated subjects. Calling the result a compliance export was rejected because its bounded
provider-evidence scope does not establish legal fulfillment.

## Migration, rollback, and verification

No schema migration is required. The repository reads existing forced-RLS request, source-event, and
canonical tables and writes through the existing append-only audit path. Rollback returns to the
prior API/web image; no package artifact requires cleanup, and existing audit events remain
immutable evidence that preparation occurred.

Synthetic verification covers dual permission, tenant concealment, exact confirmation/reason,
source/object/total limits, missing and corrupt evidence, no partial audit, response identity and
fixed headers, cookie omission, non-empty browser download, and accessibility. A future PostgreSQL
integration assertion exercises tenant-bound source selection and metadata-only audit when the
required database URLs are available. Authorized Shopify delivery, secure merchant transfer,
acknowledgement, and deletion/expiry evidence remain required.
