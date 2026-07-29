# ADR 0061: Version organization profile mutations and audit accepted changes

- Status: Accepted
- Date: 2026-07-30

## Context

ReconAI already exposed organization names through the identity-derived organization directory, but
operators could not change a name through a product route. A direct unversioned update would allow
two administrators to overwrite each other silently. Treating a client-supplied organization ID as
authority would also violate the tenant boundary, and changing the business time zone in the same
profile surface could alter business-date interpretation used by financial reconciliation.

Organization names are customer-owned display data. An accepted change therefore needs current
membership-derived permission, tenant-scoped database execution, optimistic concurrency, bounded
input, append-only reasoned audit evidence, and immediate directory visibility.

## Decision

1. Add a positive integer `organizations.profile_version`, initialized to 1 for existing rows.
2. Expose `GET /v1/organizations/:organizationId` and `PATCH /v1/organizations/:organizationId` as
   tenant routes requiring `organization:manage`. The requested ID identifies the resource; current
   authenticated membership still grants authority.
3. Limit the mutation contract to a canonical organization name, an exact expected profile version,
   and a required audit-visible reason. Reject unknown fields, control characters, invalid versions,
   and out-of-bound text before repository mutation.
4. Lock the organization row inside the tenant transaction, compare the exact profile version, and
   return a bounded conflict for stale authority. An accepted name change increments the version and
   updates the timestamp.
5. Append `organization.profile.updated` to the version-2 tenant audit chain in the same
   transaction, recording previous/new profile values, the reason, actor/correlation evidence, and
   `organizationProfileSchemaVersion: 1`.
6. Treat the canonical same-name request as a no-op: return the current profile without incrementing
   the version or appending a misleading change event.
7. Keep `business_time_zone` read-only in this surface. A future time-zone change needs a separate
   financial-impact decision, effective-time policy, replay analysis, migration/compatibility plan,
   and dedicated tests.
8. The BFF uses fixed read/action destinations, strict bounded schemas, credential omission,
   redirect rejection, and field-minimized responses. The browser requires an explicit confirmation,
   submits the observed profile version, reloads after conflict, and updates the selected
   organization label only after validated success.

## Consequences

Concurrent administrators cannot silently replace one another's organization-name decisions. One
write wins the serialized version transition; stale writers must reload current authority. The
identity directory reads the same organization row, so accepted names are visible without a
secondary cache or asynchronous propagation path.

The profile version is intentionally independent from review-policy fields already stored on the
organization row. This prevents unrelated policy updates from causing false profile conflicts, but
future profile fields must explicitly decide whether they share this concurrency domain.

The API inventory grows from 53 to 55 routes, the shared tenant read views from 16 to 17, and the
shared mutation actions from 17 to 18. These additions remain under the same fail-closed inventory
and BFF response controls.

## Alternatives considered

- Last-write-wins update: rejected because it loses administrator intent and produces misleading
  audit history under concurrency.
- Use `updated_at` as the concurrency token: rejected because timestamp precision and unrelated
  organization-row updates make it an ambiguous authority token.
- Put the expected version in an unrestricted `If-Match` string: rejected for this slice because the
  existing JSON action boundary already validates and minimizes mutation authority. A future
  standards-based ETag contract may map to the same integer version without changing semantics.
- Audit after the update in a separate transaction: rejected because the customer-visible state
  could commit without its required append-only evidence.
- Allow business-time-zone changes beside the name: rejected because time-zone changes can alter
  financial business-date interpretation and need a distinct controlled design.

## Security, tenant, financial, AI, and operational effects

Every read and write resolves current membership and `organization:manage`, then executes through a
tenant-scoped transaction with forced RLS. Insufficient permission and foreign-tenant access use the
same not-found response and append no profile audit event. Tenantless application-role reads remain
empty.

The change does not modify money, currency, reconciliation rules, source records, provider systems,
permissions, AI enablement, or business time zones. No reconciliation rule-version change is
required.

## Migration, rollout, rollback, and verification

Migration 0055 adds the constant-default non-null column as a metadata-only expansion on supported
PostgreSQL versions, adds the positive check as `NOT VALID`, then validates it separately. The
initial column/constraint statements require brief table locks; constraint validation scans the
organization table under a weaker lock. Operators must measure row count, scan duration, lock wait,
replica lag, and statement timeout in protected staging before rollout.

Deploy migration 0055 before API/web images. Prior images ignore the additive column; new images
require it. Roll back API/web together and retain the column, constraint, profile versions, and
audit events. Do not down-migrate or decrement versions. A later contraction is unnecessary.

A fresh PostgreSQL 17.10/Fastify exercise applies all 56 migrations and proves simultaneous
administrator writes produce one `200` and one `409`, stale retry denial, versioned recovery,
same-name no-op, exact directory refresh, analyst/foreign-tenant `404`, malformed/expanded `400`,
two-event linear v2 audit evidence, and zero tenantless application-role rows. Three Chromium tests
prove explicit confirmation, switcher refresh, conflict reload, and zero automatically detected
accessibility violations. Evidence:
`artifacts/organization-profile-concurrent-api-verification-2026-07-30.json`.
