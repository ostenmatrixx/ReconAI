# ADR 0009: Shopify GraphQL snapshot recovery

Status: accepted  
Date: 2026-07-27  
Extended by: `0010-scheduled-provider-gap-repair.md`

## Context

Verified Shopify webhooks remain the live ingestion path, but delivery alone cannot prove that every
order/refund change was received. Shopify's Admin GraphQL API uses cursor pagination, calculated
query-cost throttling, quarterly versioning, app-specific order-history visibility, and offline
access tokens. Its recovery representation is therefore an order snapshot rather than a Stripe-like
event list.

The shop domain is stored as the connection's external account ID and becomes part of an outbound
URL. Treating an arbitrary value as a host would create an SSRF boundary. Allowing Shopify to
silently fall forward from an unsupported API version would also make normalization evidence
ambiguous.

## Decision

Extend the provider-neutral durable sync authority from ADR 0008 with a Shopify order/refund
snapshot source.

- Accept only a lowercase canonical single-label `*.myshopify.com` hostname and construct the fixed
  HTTPS Admin GraphQL path from that value and a configured quarterly API version.
- Send the separately resolved read credential only in `X-Shopify-Access-Token`. Reject redirects,
  bound the request to ten seconds, stream at most 2 MiB, and never place credentials in URLs,
  GraphQL variables, persisted run authority, audit, or logs.
- Query orders with an inclusive `updated_at` window, `UPDATED_AT` sort, `first <= 100`, and opaque
  forward cursor. Require the returned `X-Shopify-API-Version` to equal the configured version.
- Minimize the query projection to stable identifiers, timestamps, financial status, shop-currency
  amounts, and refund transaction state/gateway. Do not request customer email, addresses, notes,
  line items, or payment details.
- Capture versioned order state plus refund transactions. Reject nested transaction pagination
  beyond 100 instead of accepting incomplete refund evidence. Bound each serialized snapshot to 1
  MiB and the shared run to 100 pages/10,000 snapshots.
- Classify HTTP and GraphQL authentication, authorization, throttling, provider, timeout, payload,
  version, and cursor errors. Use returned calculated-query-cost state to derive a bounded retry
  delay.
- Derive immutable event identity from legacy order ID, `updatedAt`, and API version. Normalize the
  order and refund transactions through the existing immutable source-event/outbox path. Stable
  legacy numeric identities align webhook and recovery records.

## Consequences

An administrator can request a bounded Shopify recovery window through the same tenant-authorized
API/BFF/UI and immutable run ledger used for Stripe. Recovery remains read-only and replay-safe.
API-version fall-forward, hostname suffix tricks, oversized responses, cursor stalls, unsupported
nested pagination, and credential reuse fail closed.

The adapter cannot retrieve data the installed app is not authorized to see. OAuth installation,
minimum-scope/protected-data approval, current offline-token issue/refresh/rotation/revocation,
distributed query-cost coordination, privacy deletion, and a real development-store contract remain
release blockers. ADR 0010 subsequently adds scheduled repair with a separate fixed service
authority that cannot impersonate a human membership.

Primary provider references:

- <https://shopify.dev/docs/api/admin-graphql/latest/queries/orders>
- <https://shopify.dev/docs/api/usage/pagination-graphql>
- <https://shopify.dev/docs/api/usage/limits>
- <https://shopify.dev/docs/api/usage/versioning>
- <https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens>
