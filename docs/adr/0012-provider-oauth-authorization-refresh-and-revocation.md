# ADR 0012: provider OAuth authorization, refresh, and revocation

Status: accepted  
Date: 2026-07-28

## Context

ReconAI needs an administrator-controlled way to authorize read-only Shopify and Stripe access
without exposing provider codes, access tokens, or refresh tokens to browser-readable state.
Authorization callbacks can be replayed, refresh tokens can rotate concurrently, and provider
disconnect semantics differ: Shopify exposes an authenticated app-uninstall mutation, while Stripe
Apps requires the user to uninstall the app in Stripe settings and then sends the app a signed
`account.application.deauthorized` event.

Stripe's Connect `/oauth/deauthorize` endpoint is not used because the integration is a Stripe App,
not a Connect platform. Treating ReconAI-side credential deletion as provider revocation would give
an operator false assurance while provider authority remained active.

## Decision

- Provider OAuth is disabled by default and enabled separately for Shopify and Stripe. Production
  configuration uses fixed clients, fixed callback paths beneath the canonical `WEB_ORIGIN`, and
  read-only allowlisted Shopify scopes.
- The browser generates a 256-bit OAuth state. The API stores only its SHA-256 digest in a
  tenant/connection/provider-bound authorization attempt issued for ten minutes and constrained by
  the database to at most 15 minutes. The BFF keeps the raw state in an encrypted HttpOnly
  transaction cookie, validates it with a constant-time digest comparison, and forwards a callback
  only to the attempt and organization already bound to that transaction.
- Callback claiming is atomic. Exactly one claimant may exchange a code; terminal, expired,
  mismatched, denied, or replayed callbacks fail closed. Shopify callback HMAC, timestamp, shop, and
  exact query fields are validated before exchange. Provider origins are fixed, redirects are
  disabled, and request/response time and size are bounded.
- Access and refresh tokens are serialized as a versioned, runtime-validated provider token bundle
  and encrypted with the existing tenant/connection/provider/purpose/key-bound AES-256-GCM envelope.
  The bundle records provider account, exact scopes, issue/expiry time, and provider- specific mode
  or authorization-generation data. Tokens and authorization codes never enter browser-readable
  session data, audit payloads, logs, or errors.
- Near-expiry tokens refresh only after the current sealed credential and connection reference are
  locked in a tenant transaction. The replacement envelope is inserted as a new immutable service-
  authored generation, the predecessor is superseded, and the connection reference changes
  atomically. Provider account, Stripe live/test mode, and Shopify scopes may not drift. A supplied
  replacement refresh token is retained; otherwise the current one is preserved.
- Shopify disconnect calls the fixed Admin GraphQL `appUninstall` mutation with the tenant-bound
  token before local revocation. Local credentials and connection references are cleared only after
  an unambiguous provider success response.
- Stripe disconnect immediately changes the connection to `action_required`, clears the read-token
  reference and recovery cursor, and returns only the fixed Stripe app-settings URL derived from
  server configuration. ReconAI does not claim disconnection at that point.
- Stripe provider confirmation is the exact raw, signed `account.application.deauthorized` event
  received at `/v1/webhooks/stripe/app-deauthorizations`. A narrowly granted, fixed-query
  `SECURITY DEFINER` function maps the globally unique Stripe account before tenant context exists.
  All state mutation then runs in a tenant transaction. The event must match the connection account,
  live/test mode, and current authorization generation; its identity and raw-body digest are stored
  once in an append-only forced-RLS ledger. Exact replay is idempotent. Only then are active
  credentials revoked, connection references/cursors cleared, status set to `disconnected`, and a
  redacted hash-chained system audit event appended.

The implementation follows the current provider contracts documented by
[Shopify `appUninstall`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/appuninstall),
[Stripe Apps OAuth](https://docs.stripe.com/stripe-apps/api-authentication/oauth),
[Stripe app settings and uninstall](https://docs.stripe.com/stripe-apps/app-settings), and
[Stripe Apps events](https://docs.stripe.com/stripe-apps/events).

## Consequences

Authorization, refresh, and provider-confirmed disconnect are replay-safe and tenant-bound, and a
Stripe uninstall cannot revoke a later authorization merely because an old signed event arrives
late. Stripe reads stop as soon as an administrator starts disconnect, even though provider
confirmation is asynchronous.

Refresh performs a provider request before the local transaction commits. If provider rotation
succeeds and the database commit then fails, a newly rotated refresh token can be orphaned. Recovery
requires provider reauthorization; the system must not retry an ambiguous rotation automatically.
Likewise, Shopify uninstall can succeed before local cleanup fails. Provider authority is already
removed, but an unusable encrypted local token may require reasoned operator cleanup. Both cases
need alerts and runbook handling.

Generation ordering depends on synchronized clocks. Hosts must use NTP and operators must
investigate clock drift before overriding a stale-event decision. No source financial or operational
record is written: Shopify's lifecycle-only uninstall mutation is the sole provider mutation.

## Alternatives

Passing raw OAuth state or tokens through browser JSON, storing plaintext tokens, accepting callback
tenant IDs as authority, refreshing without a database lock, and deleting local tokens before
provider confirmation were rejected. Calling Stripe Connect deauthorization was rejected because it
is the wrong product lifecycle. Treating any signed Stripe account event as authority was rejected;
the exact app-deauthorization type, account, mode, authorization generation, and event identity are
required.

## Migration, rollback, and verification

Migrations 0033–0035 are additive. They add authorization-attempt evidence, service-authored OAuth
refresh generations, and Stripe deauthorization evidence plus narrow role grants. They do not
rewrite customer financial data. Deploy the migrations before enabling either OAuth flag.

Application rollback disables both OAuth flags and leaves the additive tables, credential
generations, functions, policies, and evidence intact. Do not run a destructive down migration or
reactivate a retired credential. Disable provider egress and reauthorize through the provider if
containment or refresh recovery is required.

Synthetic verification covers authorization URL/callback validation, callback replay and expiry,
token-envelope tamper and scope/account/mode checks, refresh rotation and concurrency, Shopify
provider-first uninstall, Stripe exact-raw-body signature verification, deauthorization replay and
generation ordering, API/BFF authorization, tenant negatives, role grants, and migration policy
structure. Authorized Shopify/Stripe sandbox execution and a current live PostgreSQL run of
migrations 0033–0035 remain required before production enablement.
