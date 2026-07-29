# ADR 0021: Fail-closed API route authorization contract

Status: accepted  
Date: 2026-07-28

## Context

The API checked membership and permission inside each tenant route handler. Those checks were
individually tested, but route registration had no complete machine-readable inventory. A newly
registered route could therefore omit authorization until a reviewer or negative test noticed it.
Provider-signature, identity-only, public-health, and tenant boundaries were also implicit in
different handler implementations.

The existing tenant resolver returned `AuthenticationError` when a valid identity had no membership
in the requested organization. That distinguished a foreign organization from a known organization
where the same identity lacked a permission: the former returned `401` while the latter returned the
required concealed `404`.

## Decision

- `apps/api/src/route-security.ts` is the complete typed inventory of every API route. Each entry
  declares its method, route template, state-changing status, and one of four boundaries:
  `public_health`, `identity`, `provider_signature`, or `tenant`.
- Tenant entries declare a non-empty permission tuple. Provider webhook entries declare the exact
  Shopify or Stripe signature boundary whose service authenticates the untouched raw body.
- Fastify's `onRoute` hook rejects application startup when any newly registered route has no exact
  manifest entry. Automatic `HEAD` handling may reuse the corresponding reviewed `GET` contract.
- A global `preHandler` verifies identity for identity and tenant routes. For a tenant route it
  parses the route organization, resolves active membership server-side, checks every declared
  permission, and constructs the request-local tenant authority before the handler runs.
- The verified identity and tenant context are cached only on the in-memory request object.
  Handler-level authorization calls reuse that exact context and repeat the requested permission
  check as defense in depth; they never accept a body/header tenant ID.
- Missing or invalid bearer authentication remains `401`. Once an identity is valid, a missing or
  foreign membership and an insufficient permission both return the same bounded `404` response.
- Provider-signature routes do not perform user authentication. Their existing services remain
  responsible for exact-body verification before parsing, global-account resolution, or mutation.

## Consequences

Adding or changing an API route now requires an explicit security-contract change. A source
congruence test fails when a registered route and the inventory diverge, while startup fails closed
even if that test is bypassed. Authorization occurs before handler side effects, and repeated
handler calls do not repeat identity-provider or membership-directory work.

The manifest is not a substitute for repository predicates, PostgreSQL RLS, provider signature
verification, CSRF/origin enforcement at the cookie-authenticated BFF, or route-specific
confirmation/audit controls. It records and enforces HTTP admission only.

Clients that previously observed `401` for an authenticated foreign organization now receive the
same `404 RESOURCE_NOT_FOUND` contract used for insufficient permissions. This is an intentional
anti-enumeration correction.

## Alternatives

Documentation-only permission tables were rejected because they cannot block startup or handler
execution. Relying only on handler calls and reviewer discipline was rejected because omission is
the relevant failure mode. Moving all authorization into repositories was rejected because it would
allow unauthorized orchestration and external side effects before database access. Treating provider
webhooks as tenant routes was rejected because their trust is established by provider signatures
before tenant resolution, not by a user-selected organization identifier.

## Migration, rollback, and verification

No database, financial-rule, connector, or stored-data migration is introduced. Rollback removes the
registration/pre-handler enforcement but would also restore the foreign-tenant `401` leak; any
rollback therefore requires an equivalent not-found concealment fix and a complete route review.

Synthetic tenant tests prove missing-authentication `401`, foreign-membership and insufficient-
permission `404`, single identity/membership resolution, handler non-execution, and dual-permission
privacy-export denial. Manifest tests prove exact coverage of all 44 registered routes, unique
contracts, method/state classification, provider verifier classification, generated `HEAD` handling,
and unclassified route rejection. Staging adversarial tenant and timing evidence remains required
before production readiness.
