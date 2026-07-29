# ADR 0020: OIDC back-channel logout and distributed local-session revocation

Status: accepted  
Date: 2026-07-28

## Context

ReconAI uses encrypted, eight-hour NextAuth JWT cookies and keeps provider access, refresh, and ID
tokens server-side inside that cookie. Provider token refresh bounded the exposure of a revoked
Keycloak session, but an administrator- or provider-initiated logout did not immediately invalidate
an already issued local cookie. A process-local denylist would not coordinate horizontally scaled
web instances, while raw OIDC subjects, session IDs, or logout-token IDs in Redis would retain
unnecessary identity data.

The OIDC Back-Channel Logout specification requires signature, algorithm, issuer, audience, issued-
at, event, and session-locator validation; prohibits `nonce`; and defines repeated logout of an
already-ended session as success. The endpoint is an IdP-to-RP POST, so browser CSRF credentials
must not be used as its authenticity mechanism.

## Decision

- Accept `application/x-www-form-urlencoded` POST requests at `/api/auth/backchannel-logout`. Bound
  the body and parameter count before cryptographic work and ignore bounded unknown fields as the
  standard requires.
- Verify a compact signed logout JWT with `jose`, the fixed configured issuer/client audience, one
  explicitly configured asymmetric ID-token algorithm, a five-minute maximum age, one-minute clock
  tolerance, and the fixed Keycloak issuer-derived JWKS endpoint. JWKS fetches are bounded, timed,
  no-store, credential-free, and cannot redirect.
- Require `iat`, `jti`, the back-channel event object, and `sid` or `sub`; reject `nonce`. Accept an
  omitted recommended `typ`, but reject any explicit type other than `logout+jwt`.
- Capture `iss`, `sub`, session start, and the already NextAuth-validated ID token's matching `sid`
  in the encrypted local JWT. Provider tokens and these server-only identifiers never enter the
  browser-readable session response.
- When `sid` is present in a logout token, revoke only that provider session. Use the subject cutoff
  only when `sid` is absent, as required for an all-sessions logout.
- Store only environment-namespaced HMAC-SHA-256 indexes of `sid`, `sub`, and `jti`, derived with a
  domain-separated session-secret key. Values contain only an issued-at cutoff or replay marker.
  Apply the revocation and replay marker in one Redis script.
- Check the revocation index in both the NextAuth JWT callback and every server page/BFF route that
  decodes the session cookie. Missing identity metadata, a matching cutoff, or store unavailability
  fails authentication closed and removes provider credentials from the next encoded token.
- Permit an in-process store only in development/tests. Production runtime configuration requires
  Redis with a dedicated lazy connection, bounded connect/command deadlines, one request retry, and
  no offline queue.

## Consequences

Keycloak administrator, account-console, and other provider-initiated session logout can now
invalidate ReconAI's local session before its eight-hour cookie expiry. Every web replica must share
the same environment namespace, Redis authority, and session secret.

Redis availability becomes part of authenticated web request admission by design. Process liveness
must remain independent at the hosting layer; authenticated pages and BFF calls return as
unauthenticated when the index cannot be checked. A valid back-channel request returns the
specification's success status for both first delivery and replay. Invalid tokens and failed logout
actions return the specification's generic 400 without echoing tokens or identity data.

The implementation accepts signed compact logout JWTs, which matches the configured Keycloak client.
Encrypted logout tokens are not negotiated or supported. A future encrypted-ID-token configuration
requires an ADR and corresponding JWE key custody, algorithm pinning, decryption, and tests before
it is enabled.

Rotating `SESSION_SECRET` invalidates existing encrypted cookies and changes the pseudonymous index
key. Rotation therefore requires a coordinated drain/restart; mixed old/new replicas are not an
acceptable rolling state. Back-channel clock validation also requires synchronized web and IdP
clocks.

## Alternatives

Waiting for access-token expiry was rejected because it is not immediate local-session invalidation.
Provider token introspection on every request was rejected because Keycloak access-token validity is
not equivalent to local cookie revocation and would add a synchronous external dependency. A raw
identifier denylist was rejected for data minimization. A process-local store was rejected for
production because replica count would create inconsistent authorization. Database-backed sessions
remain a viable future migration, but are not required to close this bounded lifecycle gap.

## Rollback and verification

No database, tenant-authority, or financial-rule migration is introduced. A rollback must retain
equivalent provider-initiated local-session invalidation or constrain the service and session
lifetime under an explicitly reviewed incident plan; silently returning to an eight-hour
provider-blind cookie is not an acceptable production steady state.

Synthetic tests cover signature/audience/age/type/event/nonce/locator validation, fixed bounded JWKS
fetches, replay, `sid` versus `sub` scope, later re-login, missing metadata, and fail-closed store
behavior. An authenticated loopback Redis 8.2.8 exercise passed cross-client revocation, replay,
unaffected-session, pseudonymous-key, positive-TTL, and clean-teardown assertions. Production
verification still requires an authorized Keycloak client registration, at least two actual web
replicas sharing Redis, administrator/account-console logout, old-cookie rejection, new-login
recovery, Redis failure/recovery, clock skew, key rotation, and alert evidence.
