# ADR 0059: Pin the OIDC URL-parser compatibility patch

- Status: Accepted
- Date: 2026-07-29

## Context

ReconAI's locked stable authentication path uses `next-auth@4.24.15`, whose transitive
`openid-client@5.7.1` dependency calls Node's deprecated `url.parse()` in discovery, callback,
end-session, WebFinger, and Passport issuer handling. A real isolated Keycloak authorization flow
emitted `DEP0169`. Node documents the legacy parser as non-standardized and potentially
security-relevant when URLs are interpreted ambiguously.

Replacing the authentication framework is not a dependency-only update. The current boundary
includes authorization code plus PKCE/state, an encrypted bounded JWT session, server-only provider
access/refresh/ID tokens, bounded refresh rotation, distributed fail-closed revocation, RP-initiated
logout, Back-Channel Logout, and independent API token verification. As reviewed on 2026-07-29,
Auth.js v5 is beta, and the stable Better Auth generic OAuth/OIDC contract does not support the
custom generic-provider refresh hook needed to reproduce this lifecycle directly. A framework swap
without equivalent behavior and regression evidence would weaken a proven boundary to remove a
low-severity parser finding.

## Decision

1. Keep the exact stable `next-auth@4.24.15` integration and bind `openid-client@5.7.1` to one
   reviewed pnpm patch in `pnpm-workspace.yaml`, the lockfile, and
   `patches/openid-client@5.7.1.patch`.
2. Replace every `url.parse()` call in the installed package with the WHATWG `URL` API:
   - issuer discovery canonicalizes the well-known path through an absolute URL;
   - relative callback URLs use a fixed non-routable base only to parse URL structure, while the
     existing query-string parser and allowlisted callback parameters remain unchanged;
   - end-session URLs use an absolute `URL` while retaining the existing default precedence and
     repeated-query serialization;
   - WebFinger extracts and validates HTTP(S) or `acct:` hosts without the legacy parser;
   - the optional Passport strategy derives its issuer hostname through `URL`.
3. Require `OIDC_ISSUER` to be an already canonical HTTP(S) URL, apart from one optional trailing
   slash. Credentials, query data, fragments, backslash spellings, dot-segment spellings, and
   doubled trailing slashes fail closed.
4. `pnpm oidc:check` validates the exact patched-dependency mapping and lockfile SHA-256, scans
   every installed `openid-client` JavaScript file for `url.parse()`, and executes loopback
   discovery, relative callback parsing, repeated end-session parameters, the optional Passport
   path, and the Keycloak PKCE/state provider contract. The check must also pass with
   `NODE_OPTIONS=--throw-deprecation`.
5. Treat the patch as a compatibility bridge, not an upstream fork to extend. Every NextAuth,
   `openid-client`, Node, or replacement-authentication update must re-run the complete
   authorization, refresh, logout, revocation, issuer-negative, browser, and protected-runtime
   acceptance surface. Remove the patch when a stable upstream path preserves that contract.

## Consequences

The installed OIDC dependency no longer invokes Node's deprecated parser, and ambiguous configured
issuer spellings fail before authentication starts. Existing session cookies, provider credentials,
refresh behavior, logout/revocation authority, API verification, and tenant authorization do not
change.

ReconAI now owns a small exact transitive patch. The patch hash deliberately changes the lockfile
identity, so upstream updates cannot silently bypass it; conversely, dependency updates will require
an intentional patch rebase or removal. This local source/runtime result is not new live Keycloak,
multi-replica, staging, or production evidence.

## Alternatives considered

- Adopt Auth.js v5 beta: rejected for the production boundary because it is not a stable release.
- Migrate immediately to Better Auth: deferred because reproducing the current generic Keycloak
  token-refresh, revocation, logout, encrypted-session, and BFF contract requires a broader design
  and evidence change than the parser fix.
- Ignore `DEP0169` because the issuer is trusted configuration: rejected because fixed configuration
  reduces exploitability but does not remove the inconsistent parser from discovery and logout code.
- Reimplement OIDC locally: rejected because authentication and protocol validation must continue to
  use established libraries.

## Security, tenant, financial, AI, and operational effects

The change reduces URL-interpretation ambiguity and adds a fail-closed canonical configuration
boundary. It does not grant a client control over issuer, discovery, redirect, or logout
destinations. PKCE/state, exact issuer/audience/algorithm checks, secure cookies, CSRF/origin
validation, and distributed revocation remain mandatory.

No tenant identifier, membership, permission, database query, money, currency, reconciliation rule,
approval, connector scope, source-system write, AI feature, or autonomous financial authority
changes.

## Migration, rollback, and verification

There is no database or reconciliation-rule migration. A frozen install applies the patch from the
checked-in artifact. API and web deployment can use the normal application rollback because session
data and route contracts are unchanged, but removing the patch alone knowingly reopens
`SUPPLY-AUTH-URL-001` and is not an acceptable production rollback. A stable upstream replacement
must be a separately reviewed decision.

Verification includes the lock-bound runtime validator, `--throw-deprecation`, 31 focused
authorization/issuer/refresh/logout/revocation tests, the complete repository test/build gate, and
the existing browser suites. The prior real Keycloak results predate this patch and remain
historical evidence only. Current results are recorded in
`artifacts/oidc-url-parser-patch-verification-2026-07-29.json`.
