# ADR 0025: Identity-bound first-organization bootstrap

Status: accepted  
Date: 2026-07-29

## Context

The product journey begins with an owner creating an organization, but the authenticated application
previously assumed that at least one active membership already existed. A newly verified identity
therefore reached an empty organization selector with no safe path to create its first tenant.

This bootstrap is an authorization discontinuity: there is no existing tenant or owner who can grant
access. Trusting browser-supplied organization, user, membership, role, or AI settings would let
client input mint authority. A timed-out create request also cannot safely be repeated unless the
operation has durable, identity-bound idempotency evidence.

## Decision

- Only an authenticated OIDC identity with a provider-verified, normalized email and no active
  membership may bootstrap an organization. The first membership is always `owner`; AI remains
  disabled. Creating later organizations is deliberately outside this bootstrap and requires a
  separate reviewed policy.
- The browser submits only a bounded organization name, a valid IANA business time zone, and a UUID
  idempotency key. The API generates the organization, user, membership, and request identifiers.
- A fixed `SECURITY DEFINER` PostgreSQL function serializes calls per issuer/subject, creates or
  resolves the active identity, rechecks that it has no active membership, and atomically inserts
  the organization, owner membership, and append-only bootstrap request. Its search path is fixed,
  row security remains enabled, public/worker execution is revoked, and only the application role
  receives execute permission.
- `organization_bootstrap_requests` is tenant-scoped, forced-RLS, append-only evidence. A unique
  `(user_id, idempotency_key)` index binds a canonical input SHA-256 digest to the created
  organization and owner membership. An exact retry returns those same identifiers; a changed
  payload under the same key and a second bootstrap after any active membership fail closed.
- The application invokes the function and appends the canonical `organization.created` audit event
  in one database transaction. An audit failure rolls back the organization, membership, and
  idempotency evidence. A replay does not append a duplicate audit event.
- The identity-authenticated API route has strict schemas and a ten-request-per-minute budget. It
  returns one generic conflict for ineligible identity state, identity mismatch, and idempotency
  conflict so callers cannot use the endpoint as an identity-membership oracle.
- The same-origin BFF validates origin/fetch metadata, session/access-token lifetime, bounded JSON,
  and the strict API response. On success it issues the existing HttpOnly, HMAC-signed,
  subject-bound selected-organization context cookie; that cookie remains navigation state rather
  than authorization.
- The UI retains the same idempotency key after a timeout or uncertain upstream failure. It creates
  a new attempt only after a definite validation, verified-email, or eligibility rejection. Every
  downstream tenant request still re-resolves current membership and permissions.

## Consequences

A newly verified operator can establish exactly one initial tenant without a pre-seeded membership,
while browser inputs never select privileged identifiers or role. Concurrent tabs and transport
retries converge on one organization. Bootstrap evidence and the first audit event are atomic.

An IdP email change that conflicts with an existing local identity fails closed and requires an
explicit recovery process. An identity that already has any active membership cannot use this route
to create another organization. That is intentionally restrictive until billing, abuse prevention,
organization limits, and later-organization authorization are designed.

The database function receives identity claims only after API JWT verification; PostgreSQL does not
independently validate an OIDC token. Protecting the application database credential, eliminating
SQL injection, and monitoring this narrow function therefore remain important controls.

## Alternatives

Automatically creating an organization during sign-in was rejected because authentication should not
cause a tenant mutation and retries would be opaque. Allowing any active member to self-create more
organizations was rejected because product entitlement and abuse policy are not defined. Requiring
an administrator to seed every first tenant was rejected because it leaves the founding journey
incomplete. Client-generated authority identifiers or role selection were rejected because they
enlarge the privilege boundary. Process-memory idempotency was rejected because it does not survive
restarts or coordinate replicas.

## Migration, rollback, and verification

Migration 0042 adds one empty table, two indexes, forced-RLS policies, an append-only trigger, and
the narrow bootstrap function/grant. It performs no backfill, existing-row scan, financial-rule
change, or customer-data rewrite. Expected impact is catalog locking for additive DDL. Apply 0042
before the new API, then deploy API and web. Prior images do not use the new structures and remain
compatible.

Rollback API and web together and leave the additive table, function, and append-only evidence in
place. Do not delete bootstrap rows, owner memberships, organizations, or their audit events.
Removing the function or changing later-organization policy requires a forward migration and a new
security review.

Static and synthetic tests cover fixed privileges/RLS/search path, append-only evidence, exact retry
and input conflict, concurrent-identity serialization contract, no-second-membership eligibility,
unknown-time-zone rejection, verified-email admission, transactional audit behavior, rate/startup
registration, strict API/BFF schemas, CSRF/origin denial, bearer-only forwarding, and
selected-context issuance. Live empty-schema, populated 0041-to-0042 upgrade, restricted-role
execution, concurrent-tab behavior, audit rollback, real OIDC/browser onboarding, and rolling-image
deployment remain required evidence.
