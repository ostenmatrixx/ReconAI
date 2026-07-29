# ADR 0054: Separated browser boundaries for restricted support

- Status: Accepted
- Date: 2026-07-29
- Extends: ADR 0053

## Context

ADR 0053 establishes a default-disabled, two-party support authority: a separately authenticated
support identity creates an organization-unbound request, and an active tenant owner binds the
one-time code to one organization and one short-lived aggregate-diagnostics grant. The API and
database boundaries are intentionally asymmetric. A conventional tenant dashboard or shared
organization selector on the support side would blur that separation, create tenant-discovery
pressure, and make it easier to forward a client-selected organization as if it were authority.

The browser also handles a raw one-time request code. Persisting that code in browser storage,
navigation, telemetry, or a reusable form would expand a 15-minute transfer credential beyond the
database contract.

## Decision

1. The support-identity interface lives at `/support` in a distinct shell. It contains no tenant
   navigation, organization selector, organization list, search, impersonation, or link into tenant
   records. The operator must enter the exact organization and grant UUIDs received through the
   authenticated ticket.
2. `/api/recon/support` is an organization-blind BFF. It authenticates the encrypted web session,
   forwards only the bearer token, never forwards browser cookies or the selected-organization
   cookie, and permits only:
   - a same-origin, CSRF-checked request for 5–60 minutes; and
   - an exact two-UUID diagnostic lookup. It applies an eight-second upstream timeout, a 64 KiB JSON
     response ceiling, private/no-store response headers, strict input schemas, and no
     caller-selected upstream path.
3. The raw request code exists only in React memory. A new request clears any prior code before the
   call, navigation/reload discards it, and the operator can explicitly copy or clear it. ReconAI
   does not place the code in local storage, session storage, a URL, a cookie, a log, or telemetry.
4. The support UI accepts only the fixed `support-diagnostics-v1` schema and renders its capped
   counts and timestamps. Malformed output fails closed. Unknown organization, foreign identity,
   expired grant, revoked grant, and wrong identifier share one unavailable message.
5. Tenant-owner approval remains inside the selected organization’s Security surface. The normal
   signed, subject-bound organization BFF lists at most 50 grants and exposes only fixed approve and
   revoke actions. The server injects `confirmOrganizationId`; browser `action` and confirmation
   fields are never forwarded as authority.
6. Approval requires a valid 43-character request code, ticket reference, audit-visible reason, and
   explicit selected-organization confirmation. The browser clears the raw code immediately on
   submission. Revocation requires its own reason and confirmation. The API continues to enforce
   active-owner `support:manage`; the UI does not infer permission from display state.
7. This interface adds no diagnostic field, tenant membership, tenant directory, source-system
   scope, financial record access, export, note, review action, or write capability.

## Consequences

Support and tenant operators receive usable controls without merging their authority domains. A
support identity can request approval without knowing a tenant identifier, and cannot discover one
through the console. A tenant owner can see exactly which pseudonymous support reference, ticket,
reason, status, and expiry applies to the selected organization and can revoke it without database
access.

The support route is visible to any authenticated web session, but visibility grants no support
authority: the API still requires the exact configured support group and MFA context. This keeps the
web session layer provider-neutral and makes the upstream policy the single authorization source.
Unauthorized results are deliberately terse.

The one-time code remains visible in the DOM while the operator transfers it. Endpoint protection,
screen sharing, clipboard history, browser extensions, and an authenticated ticket channel remain
operational dependencies outside application control. The UI is local source evidence, not proof of
a deployed support program.

## Alternatives considered

- Put support diagnostics inside the tenant dashboard: rejected because support identity is not a
  tenant membership and must not inherit the tenant directory or selected-context flow.
- Let support search for an organization: rejected because owner approval should supply exact
  authority and there is no legitimate global browse use case.
- Persist a pending request in browser storage: rejected because the raw code is a short-lived
  transfer credential and reload convenience does not justify additional recovery surfaces.
- Embed organization or grant identifiers in the support URL: rejected because URLs enter browser
  history, screenshots, referrers, and support tooling more readily than transient form state.
- Automatically approve after ticket creation: rejected because the active tenant owner is the
  required second party and an external ticket reference is not tenant authorization.

## Security, tenant, financial, AI, and operational effects

Support BFF requests never consume client-selected tenant context. Tenant approval and revocation
use only the signed, subject-bound selected organization and the API re-resolves current membership
and `support:manage`. Cross-tenant and wrong-identity outcomes remain indistinguishable.

No money, currency, canonical value, reconciliation rule, exception decision, financial approval,
connector scope, source-system state, AI flag, model, prompt, or permission assignment changes. The
support console is read-only apart from creating an unbound request; tenant owners only create or
revoke the fixed diagnostic grant.

Operators must transfer the code through an authenticated ticket, close or clear the console after
transfer, avoid shared-screen or clipboard retention, and revoke the grant when work ends. The
existing ADR 0053 enablement, key-drain, audit-review, incident, and periodic-review procedures
remain authoritative.

## Migration, rollout, rollback, and verification

No database migration or configuration value is added. Deploy the web surface only with the ADR 0053
backend disabled, then exercise unauthorized, owner approval, aggregate read, expiry, and revocation
in a protected environment before enablement. Every web replica must use the same API and web
origins and existing encrypted-session configuration.

Application rollback removes the UI and BFF without changing grants or audit rows. Disable support
access and revoke or drain active grants before rolling back a support incident. Never compensate
for a missing UI by granting database access or copying tenant payloads into a ticket.

Local acceptance covers fixed BFF routing, CSRF, authentication, cookie non-forwarding, strict
query/body validation, response ceilings, server-injected tenant confirmation, in-memory code
handling, uniform denial, approve/revoke payloads, aggregate-only rendering, two accessibility
scans, full Chromium regression, strict TypeScript/lint/build checks, and the complete repository
verification command. Real IdP/MFA, ticket-system, notification, clipboard/endpoint controls,
multi-replica, protected-staging, timing, and incident evidence remain open.
