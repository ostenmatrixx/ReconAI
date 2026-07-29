# ADR 0065: Verify production web-image authentication with an isolated TLS identity topology

- Status: Accepted
- Date: 2026-07-30

## Context

The first application-image runtime proof built and exercised the API, worker, and public web route,
but authenticated reconciliation still used a host-issued token. Reusing the HTTP development
Keycloak service for the production-built web image was not a valid shortcut: Next.js correctly
inlined production CSP and session checks and rejected a non-HTTPS issuer and the repository's
local-only client secret.

Temporarily changing the shared Compose client also created an avoidable rollback dependency. The
browser and containers nevertheless need one exact issuer and callback authority, and the production
BFF requires an HTTPS API origin, Secure cookies, and Redis session revocation.

## Decision

1. The image-runtime verifier creates a one-run self-signed CA, OIDC client secret, session secret,
   and derived Keycloak realm file in an OS temporary directory. None is written to the repository
   or emitted as evidence.
2. It starts a separate digest-pinned Keycloak 26.7.0 container, imports only the derived synthetic
   realm, and serves the exact issuer `https://reconai-image-oidc:8443`. It does not modify the
   normal Compose Keycloak client.
3. Chromium uses bounded host-resolver mappings for the synthetic web and issuer names and ignores
   only the one-run CA error. The authenticated web and API containers receive only the CA
   certificate through an exact read-only file mount; worker and public web receive no verifier
   files. The isolated identity and TLS-relay helpers likewise receive only their individually
   required certificate, private-key, realm, or relay-script files.
4. The production-built web image runs with production mode, HTTPS origins, a non-local one-run
   client secret, Secure and HttpOnly cookies, and Redis-backed session revocation. A
   capability-dropped non-root TLS relay gives its BFF an HTTPS API origin without changing the HTTP
   API image contract. A verifier-owned loopback TLS proxy fronts the web image.
5. The browser must complete authorization code plus PKCE, provider login, the temporary-password
   update, explicit authorized-organization selection, BFF run creation, and BFF run-detail
   retrieval. Production's development default organization is not used.
6. The verifier validates the exact client, callback, S256 challenge, cookie policy, minimized
   browser session, minimized successful BFF response, foreign-tenant 404, tenantless RLS zeros,
   deterministic evidence, outbox/job/audit persistence, live credential projections, and bounded
   credential-free logs.
7. Only the exact synthetic fixture user's issuer is temporarily rebound to the isolated issuer.
   Guarded cleanup restores it, closes the browser and TLS server, removes only labeled verification
   containers and the exact temporary directory, and leaves the Compose client unchanged.
8. Live mount inspection rejects writable mounts, unexpected destinations, and directory-wide
   verifier projection into any application container.

## Consequences

The production web-image authentication and BFF path now has one reproducible local ARM64 exercise
instead of being inferred from host-process login plus a public image route. Fail-closed production
configuration checks remain active and exposed two invalid harness assumptions before the accepted
run.

The BFF deliberately withholds the upstream correlation ID from its successful run response. The
verifier records that minimization and obtains the run's correlation identity from append-only audit
evidence rather than weakening the browser response.

The topology adds an evidence-only TLS relay and synthetic CA. They are not deployable components
and do not alter the supported self-hosting architecture.

## Alternatives considered

- Override the production image with development HTTP behavior: rejected because the compiled proxy
  and session boundary must remain fail closed.
- Rebind the shared Compose Keycloak client: rejected because an isolated imported realm avoids
  shared-state rollback and exact-client drift.
- Trust a host-minted token as web authentication evidence: rejected because it bypasses browser
  authorization, cookies, organization selection, and the BFF.
- Expose the internal HTTP API as the production BFF origin: rejected because production origin
  validation requires HTTPS.
- Return the API correlation ID through the BFF for easier evidence collection: rejected because the
  bounded browser response is intentionally minimized.

## Security, tenant, financial, and operational effects

No application permission, tenant predicate, money calculation, matching rule, migration, provider
scope, or AI behavior changes. The accepted synthetic run used eight immutable inputs and ruleset
1.5.0, producing three matches, one evidence-backed exception, zero errors, three match snapshots,
one exception snapshot, one published outbox event, one successful job, and two audit events.

The real foreign organization remained indistinguishable at `404`, and tenantless restricted-role
reads returned zero rows. Provider tokens stayed inside the encrypted HttpOnly session cookie and
were decoded only in verifier memory for a direct negative tenant assertion.

This result is not a trusted production certificate or ingress, external federation, managed Redis,
Docker Engine, amd64 candidate, vulnerability scan, protected staging, rolling deployment, SLO, or
production-readiness claim. Evidence:
`artifacts/container-image-runtime-verification-2026-07-30.json`.

## Rollback

Removing this verifier does not change application runtime behavior or data. Any replacement must
retain one exact HTTPS issuer/callback authority, production session controls, explicit tenant
selection, credential minimization, guarded fixture restoration, and exact labeled cleanup.
