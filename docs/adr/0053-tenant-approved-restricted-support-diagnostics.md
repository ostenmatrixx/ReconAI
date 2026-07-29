# ADR 0053: Tenant-approved restricted support diagnostics

- Status: Accepted
- Date: 2026-07-29

## Context

The product brief requires restricted internal support tooling, while the threat model forbids
global tenant browsing and requires MFA, least privilege, ticketed time-bound elevation, dual
control, and immutable audit. The domain permission enum previously contained `support:access`, and
the owner role inherited every enum value automatically. No support route existed, so this was not
an active data-exposure path, but the contract would have made a future support endpoint unsafe by
default.

A support operator is not a customer membership. Giving a support identity an organization role,
accepting a client-supplied organization as authority, or exposing the normal financial-record API
would violate that separation. A support request also cannot name an organization before customer
approval without creating a global existence oracle.

## Decision

1. Tenant roles contain only `support:manage`, and only the explicitly enumerated owner role
   receives it. `support:access` is removed. An explicit permission override cannot add
   `support:manage` to a non-owner context. Support diagnostics use a separate platform identity
   context and capability `diagnostics:view`.
2. Support access is disabled by default. Enabling it requires an exact signed OIDC group claim, an
   exact configured authentication-context (`acr`) value representing the approved MFA assurance,
   and a dedicated canonical 32–64 byte base64url HMAC key. Missing, partial, malformed, disabled,
   or non-matching configuration fails as not found.
3. The API derives a stable HMAC-SHA-256 locator over the complete OIDC issuer and subject. Raw
   issuer/subject values, email, group, authentication context, and HMAC key are not persisted in
   the support ledger or tenant audit.
4. An eligible support identity first creates a 256-bit random, organization-unbound request. The
   database stores only the request-token SHA-256, keyed identity digest, requested 5–60 minute
   duration, and exact 15-minute expiry. The raw request code is returned once over a no-store
   authenticated response.
5. A tenant owner receives the code through the existing support-ticket channel and approves it for
   one exactly confirmed organization with a 3–200 character ticket reference and a 3–2,000
   character reason. The database independently verifies the active owner and active user, consumes
   the unexpired request once, and creates one `diagnostics:view` grant. This support request plus
   tenant-owner approval is the implemented dual control.
6. A grant lasts the requested duration, never less than five or more than 60 minutes. It is bound
   to the organization, support identity digest, capability, approving membership, ticket, reason,
   and server-checked timestamps. A composite foreign key binds a claimed request to the exact
   tenant grant. The owner can list bounded grant metadata and revoke an active or expired unrevoked
   grant; revocation replay is idempotent.
7. The application and worker roles have no direct access to either support table. The application
   can execute only fixed migration-owned request, approval, list, revoke, and diagnostic functions;
   the worker can execute none of them. Forced RLS applies to both tables. Triggers reject request
   changes other than one pending-to-claimed transition, grant changes other than one
   active-to-revoked transition, and all deletes.
8. The support route accepts an organization only together with an active exact grant and the same
   keyed identity digest. There is no tenant directory, browse endpoint, impersonation, normal
   tenant context, source payload, canonical record, amount, customer, external account, connector
   credential, export, approval, retention, or write capability.
9. Diagnostics schema `support-diagnostics-v1` returns only capped aggregate operational facts:
   connection total/non-healthy count and latest successful sync; active/failed provider syncs;
   active/failed-or-partial reconciliations; unresolved exception count/oldest time; and
   unpublished/dead-lettered outbox count/oldest time. A cap flag prevents numeric overflow.
10. Approval, successful diagnostic access, and first revocation append to the tenant's canonical
    hash chain in the same transaction as their database effect. Diagnostic access uses audit actor
    type `support` and the keyed digest; raw request codes and OIDC claims never enter audit.
11. The web runtime may request a bounded canonical `acr_values` set from the OIDC provider. This is
    only a step-up request. The API's exact signed `acr` comparison, exact signed group comparison,
    and active grant checks remain the authorization boundary and fail closed independently.

## Consequences

Support cannot access customer financial evidence through this slice. The fixed aggregates can help
triage connector, reconciliation, exception-backlog, and queue health while preserving the tenant
boundary. Every successful diagnostic response implies a current exact identity/grant check and a
successful audit append; if audit append fails, the response transaction fails.

The request code is a one-time linking capability, not standalone authentication. It is useful only
after a separately authenticated, configured support identity creates it and a tenant owner approves
it. Possession of an organization ID, grant ID, request digest, identity digest, ticket reference,
or owner role alone does not authorize diagnostics.

The ticket reference is a bounded operator assertion; no ticket-system API validates it in this
increment. The 12-hex identity reference shown to an owner is a display correlation only, never an
authorization value. Expired unclaimed request rows contain only pseudonymous/digest metadata, but
their purge/retention policy still needs owner/privacy approval. The dedicated HMAC key has no
overlap rotation: because requests expire within 15 minutes and grants within 60, rotation requires
disabling new requests, revoking or draining grants, waiting through the maximum lifetime, rotating
all API replicas together, and then reenabling.

## Alternatives considered

- Add a `support` tenant role or temporary membership: rejected because a platform operator is not a
  customer member and normal tenant permissions expose much more data.
- Let an owner inherit `support:access`: rejected because tenant grant administration and platform
  diagnostic use are different authorities.
- Let support request an organization directly: rejected because it creates an existence oracle
  before tenant approval.
- Use a bearer support token without OIDC/MFA: rejected because token possession would become
  standalone privileged authentication.
- Expose normal tenant read routes after grant: rejected because fixed aggregate diagnostics are
  materially narrower and easier to audit.
- Add a global support tenant list: rejected because no operational need justifies global browse.
- Validate ticket references against one vendor: deferred to preserve self-hosting and avoid
  claiming an integration or ticket outcome that is not configured.

## Security, tenant, financial, AI, and operational effects

All authenticated missing, foreign, expired, revoked, replayed, wrong-identity, non-owner, and
disabled outcomes are the same `404 RESOURCE_NOT_FOUND`. The function authority rechecks the tenant
setting, exact organization, identity digest, grant, capability, status, and expiry. Direct
application/worker table access and worker function execution are denied.

No source-system request or write occurs. No money, currency, canonical value, matching rule,
exception decision, approval, retention action, permission assignment, or AI behavior changes.

## Migration, rollout, rollback, and verification

Migrations 0053–0054 are additive and perform no tenant scan or backfill. Apply them while support
remains disabled. Configure the exact IdP group and MFA assurance mapping, inject a dedicated HMAC
key, rehearse request/approval/access/revocation with two identities, and review the tenant audit
before enabling an approved environment. Verify that every API replica uses the same settings and
that no old image exposes a different support contract.

Application rollback can leave the additive schema unused while `SUPPORT_ACCESS_ENABLED=false`. For
a support-code rollback, disable new requests and revoke current grants first. Do not delete
grant/request/audit rows or relax the functions/RLS. A key or IdP-claim incident requires immediate
disablement, tenant-owner revocation where available, session/IdP response, and an access review.

Local acceptance includes config and identity-policy tests; exhaustive route classification; owner,
analyst, exact-confirmation, and disabled API tests; a real PostgreSQL 17.10 application/worker-role
run; one-time request consumption; 15-minute request and 5–60 minute grant constraints; composite
tenant/grant integrity; cross-tenant/wrong-identity/expired/revoked denial; fixed aggregate output;
direct table/function/mutation denial; idempotent revocation; and hash-chained approval/access/
revocation audit.

A separate isolated loopback exercise configures Keycloak 26.7.0's native LoA 2 browser flow,
requests `acr_values=2`, completes password plus TOTP, denies a wrong TOTP before any application
session exists, and admits only the exact `/reconai-support` group with signed `acr=2`. It then
composes request, owner approval, fixed diagnostics, outsider denial, revocation, tenantless RLS,
and the v2 audit chain against a fresh PostgreSQL 17.10 database. Evidence:
`artifacts/oidc-restricted-support-mfa-verification-2026-07-30.json`.

This local exercise does not prove protected/deployed IdP policy governance, recovery or
administrator-bypass resistance, ticket ownership or status, protected-staging response timing,
multi-replica key/claim consistency, support-user offboarding, notification delivery, periodic
access review, incident response, or production readiness.
