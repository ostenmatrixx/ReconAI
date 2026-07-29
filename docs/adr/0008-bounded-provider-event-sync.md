# ADR 0008: Bounded provider event sync

Status: accepted  
Date: 2026-07-27  
Extended by: `0009-shopify-graphql-snapshot-recovery.md`, `0010-scheduled-provider-gap-repair.md`

## Context

Verified webhooks are the normal provider ingestion path, but they are not a complete correctness
boundary. Delivery can be delayed or missed, and an operator needs a safe way to capture a known
historical gap without granting ReconAI source-write capability or starting an unbounded crawl.
Webhook signing secrets are also different authorities from provider read API credentials and must
not be reused.

Stripe retains API event-list results for 30 days. Its list endpoint is cursor-paginated, and each
event records the API version in effect when that event was created. Shopify uses GraphQL cursors
and has different access/history rules, so pretending both providers have one fully implemented
adapter would obscure important limitations.

## Decision

Add a versioned, provider-neutral page contract and implement only the Stripe Events adapter in this
increment.

- A sync request is tenant-authorized with `connectors:manage`, exact organization confirmation, an
  audit-visible reason, a positive window of at most 30 days, and a ceiling of 1–100 pages.
- The browser supplies only a boolean confirmation. The BFF injects the organization ID recovered
  from the signed, subject-bound organization context.
- `api_credential_reference` is distinct from the webhook `credential_reference`. Both accept only
  bounded `env:RECONAI_CONNECTOR_*` references in the local resolver; raw credentials never enter an
  API body, job, database row, URL, audit event, or log.
- One immutable `provider_sync_runs` row and one `connector.sync.requested` outbox authority are
  inserted transactionally. Runs are tenant-RLS protected, authority fields are immutable, terminal
  evidence cannot be changed, and deletion is rejected.
- The worker revalidates the exact tenant-bound outbox envelope, reads the connection authority, and
  requests only `https://api.stripe.com/v1/events`. Redirects are rejected; requests have a
  10-second timeout; responses are streamed with a 2 MiB ceiling; pages contain at most 100 events.
- The adapter filters to the supported payment-intent and refund event allowlist, bounds
  `created[gte]`/`created[lte]`, uses forward `starting_after` cursors, preserves each event's
  `api_version`, and classifies authentication, authorization, rate-limit, timeout, provider, and
  payload failures.
- Every page item enters the same immutable object/source-event/outbox path used by webhooks. Event
  identity remains `(organization, connection, provider event ID)`, so repeats are harmless.
- A run stops `partial` at its page ceiling, succeeds only at a terminal provider page, and becomes
  failed after a terminal error or six recorded transient failures. No cursor is trusted unless it
  matches the locked persisted cursor.

## Consequences

Operators can perform an explicit read-only Stripe backfill or gap repair with bounded cost and
durable evidence. Webhooks remain the live path, while provider listing supplies recovery evidence;
neither is treated as a source write.

This increment did not schedule repairs, install or rotate provider credentials, coordinate a
distributed provider rate budget, retrieve Stripe data older than the Events API history, or
implement Shopify page retrieval. ADRs 0009 and 0010 subsequently add Shopify retrieval and bounded
scheduled repair. A production secret-manager/KMS resolver, distributed rate coordination, and
authorized provider sandbox evidence remain release blockers.

Migration `0030_provider_sync_runs.sql` is additive. Existing connections receive a null read
credential reference, no sync run is created, and no provider request becomes possible merely by
upgrading. Application rollback may leave the dormant column/table/policies in place.
