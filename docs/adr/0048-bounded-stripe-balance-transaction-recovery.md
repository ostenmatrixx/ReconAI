# ADR 0048: Bounded Stripe balance-transaction recovery

- Status: Accepted
- Date: 2026-07-29
- Extends: ADR 0008 and ADR 0047

## Context

ReconAI normalizes Stripe processing fees and deterministic reconciliation already detects a missing
fee, but the implemented recovery source listed only Stripe Events. The stable `balance_transaction`
source family therefore exposed a real absence: no normal read path produced the fee evidence
required to close that exception.

Stripe exposes charge fee, net, currency, creation time, and source on balance transactions. The
source can be expanded to a Charge and linked to its PaymentIntent. Stripe documents that balance
transactions can be created asynchronously after the payment, so webhook intake alone is not
complete fee authority. It also documents that users on interchange-plus pricing cannot retrieve fee
information from balance transactions.

Adding a second provider list creates cursor, permission, minimization, partial-run, and rolling
deployment concerns. A single provider page call must remain behind the existing distributed circuit
and bounded durable retry authority. Provider Charge objects can contain customer and billing data
that ReconAI does not need.

References:

- [List balance transactions](https://docs.stripe.com/api/balance_transactions/list?api-version=2024-06-20)
- [Balance transaction object](https://docs.stripe.com/api/balance_transactions/object)
- [Expand balance-transaction sources](https://docs.stripe.com/expand/use-cases)
- [Stripe Apps permissions](https://docs.stripe.com/stripe-apps/reference/permissions)

## Decision

1. Extend the existing Stripe recovery source into two ordered read-only phases for the same
   operator-authorized UTC window:
   - list the supported Stripe Events pages;
   - then list charge balance transactions.
2. Keep one provider HTTP request per `fetchPage` call. Returning from the Events phase to the
   balance phase requires a new loop iteration and therefore a new tenant/connection-scoped
   provider-circuit permit.
3. Add a versioned composite cursor:
   - `stripe-v2:events:<event-id>`;
   - `stripe-v2:balance:start`;
   - `stripe-v2:balance:<balance-transaction-id>`. Legacy `evt_*` cursors remain readable as Events
     cursors.
4. Add an explicit provider-neutral `source_phase` continuation marker. An empty nonterminal page is
   valid only for this marker, because a zero-event window must still advance to balance
   transactions. Ordinary empty nonterminal pages and all terminal continuation state remain
   invalid.
5. Call only `GET /v1/balance_transactions` on the fixed Stripe origin with:
   - `type=charge`;
   - `created[gte]` and `created[lte]` from the validated run window;
   - `expand[]=data.source`;
   - a limit of at most 100;
   - validated `starting_after` pagination. Existing 30-day window, page-count, byte, timeout,
     redirect, cursor-stall, retry, and circuit bounds continue to apply.
6. Require the reviewed Stripe App configuration to grant `balance_transaction_source_read`. Stripe
   documents that this permission also implies broader read permissions. Do not enable it in
   production until the exact app manifest and resulting permissions are owner reviewed and
   exercised in an authorized sandbox.
7. Parse each list page before accepting any item. Require a charge balance transaction with safe
   integer minor-unit `amount`, `fee`, and `net`; a three-letter currency; bounded fee details; and
   an expanded Charge source. Reject the whole page unless `amount - fee = net`.
8. Persist only a versioned ReconAI snapshot containing the selected balance-transaction fields and
   `{id, object, payment_intent}` from the expanded Charge. Runtime parsing strips all unselected
   Charge and transaction properties before serialization. Billing details, email, customer,
   description, credentials, and the full provider response are not retained.
9. Normalize total positive `balance_transaction.fee` as one integer-minor-unit `processing_fee` in
   the balance transaction currency. Do not sum `fee_details` as an independent authority, compare
   different currencies, convert currency, or change the reconciliation rule version.
10. Link the fee to the expanded Charge's PaymentIntent when present. If the Charge has no
    PaymentIntent, retain the Charge ID as the payment reference and add
    `STRIPE_CHARGE_HAS_NO_PAYMENT_INTENT`; deterministic reconciliation must surface the record as
    incomplete rather than infer a link.
11. Classify the immutable snapshot as exactly `balance_transaction` in the same receipt,
    classification, and outbox transaction defined by ADR 0047. Replays use the balance-transaction
    ID as the external event/object identity and cannot duplicate source, canonical, outbox, audit,
    classification, or reconciliation evidence.
12. Bump the Stripe connector and normalizer versions from `1.0.0` to `1.1.0`. No database migration
    and no reconciliation rule-version change are required.
13. Rely on operator-requested backfill and opt-in periodic gap repair for asynchronously available
    balance transactions. A successful bounded run proves only the pages processed for its recorded
    window and cursor; it does not prove provider-wide completeness or settlement finality.
14. Treat interchange-plus fee retrieval as unsupported until a separately reviewed Stripe source
    and permission model exists. Do not report a zero fee or complete fee coverage for those
    accounts.

## Consequences

Successful recovery can now produce evidence-backed Stripe processing fees and an observed
`balance_transaction` source watermark. The existing deterministic missing-fee exception can close
through normal immutable ingestion and replay without granting ReconAI any source-system write
authority.

The Events terminal page now always advances to one balance-list request, including when no Events
exist. This adds bounded read cost and means a run is not successful until both phases terminate. If
permission, expansion, schema, currency, conservation, or identity validation fails, the run fails
or remains partial; already committed receipts remain immutable and do not become a completeness
claim.

Total Stripe fee can include more than one fee component. ReconAI intentionally records Stripe's
total `fee`, while retaining bounded `fee_details` as source evidence. It does not reinterpret,
convert, allocate, or independently calculate provider pricing.

The minimized snapshot reduces customer-data exposure but is a derived immutable representation, not
the full Stripe API response. Its schema version, connector/normalizer versions, API version when
configured, source timestamp, checksum, and provenance preserve replay authority.

## Alternatives considered

- Continue relying on Stripe Events: rejected because the supported event objects do not provide the
  charge balance-transaction fee authority required by reconciliation.
- Retrieve one balance transaction while normalizing each payment event: rejected because creation
  is asynchronous, it multiplies requests, and it couples event replay to an eventually available
  object.
- Persist the expanded Charge or complete list response: rejected because it would retain
  unnecessary billing/customer data and make schema evolution less controlled.
- Treat the Charge ID as equivalent to a PaymentIntent: rejected because it would fabricate a
  deterministic link. The fallback remains explicitly incomplete.
- Treat fee-details arithmetic as the authoritative fee: rejected because Stripe exposes a total
  `fee` and `net`; duplicating provider pricing logic adds avoidable financial ambiguity.
- Fetch every balance-transaction type and filter locally: rejected because V1 reconciliation needs
  charge fees and a server-side literal type bound reduces data and cost.
- Run both list calls inside one page/circuit permit: rejected because one permit/result would hide
  the number and outcome of provider requests.
- Backfill classifications or canonical fees in a migration: rejected because no trustworthy
  balance-transaction payload exists in prior storage and migrations must not call providers.

## Security, tenant, financial, and operational effects

Every request follows a validated tenant-bound sync run, active connection, distinct read
credential, fixed Stripe account/version headers, outbound origin allowlist, and distributed
tenant/connection circuit. The new provider permission is read-only but broader than the prior
Events-only retrieval and requires explicit owner review. No client organization or external account
value grants authority.

The immutable object key, receipt, classification, canonical record, outbox, audit, connection
freshness, and reconciliation inputs remain tenant scoped. The snapshot excludes unnecessary Charge
fields. Structured logs and metrics retain their closed vocabularies and must not contain cursor,
provider object ID, account, credential, payload, amount, currency, or fee.

Money remains integer minor units with explicit currency. The connector verifies safe integers and
`amount - fee = net`, performs no conversion, and uses total provider fee without floating point.
AI, proposal approval, source-system mutation, accounting writes, and deterministic rule authority
do not change.

The new worker accepts both legacy Events cursors and the versioned composite cursor. An old worker
cannot accept `stripe-v2:*` cursors. Before deployment, stop admitting provider sync work, drain or
terminally account for old runs and workers, deploy only version 1.1-aware workers, then resume.
Rollback after a composite cursor is written requires stopping affected work and either redeploying
the 1.1 reader or starting an owner-authorized new run from its immutable window; do not rewrite a
cursor or source receipt. A prior API image can read the additive source/canonical rows because no
schema changes are introduced.

Before production, verify the exact Stripe App permission manifest and implied permissions,
authorized test/live account modes, direct and destination-charge behavior, fee-detail variants,
null PaymentIntent handling, async availability and periodic repair, pagination boundaries, 403 and
rate-limit behavior, restricted-role PostgreSQL persistence/RLS, managed Redis behavior, protected
staging rollout/rollback, dashboards, silence handling, and alert delivery. Interchange-plus
accounts remain outside the supported fee-evidence contract.

## Verification

Focused unit tests cover the Events-to-balance phase transition, zero-item continuation,
fixed-origin query parameters, cursor pagination, one request per page, minimized snapshot,
discarded billing data, response/window/rate bounds, and rejection of nonconserving balance data.

Ingestion tests cover exact balance identity, immutable family classification, duplicate
suppression, processing-fee normalization/provenance, and the incomplete Charge-reference fallback.
Provider-sync tests cover a second circuit permit across the phase transition and rejection of
ordinary empty nonterminal pages.

A source-defined PostgreSQL integration test covers receipt/classification/outbox/canonical
persistence, replay idempotency, connector/normalizer versions, and foreign-tenant concealment. It
is not runtime evidence until executed with the restricted application/worker roles.

Final source, test, browser, dependency, migration-ledger, and environment evidence is recorded in
`artifacts/stripe-balance-transaction-recovery-verification-2026-07-29.json`.
