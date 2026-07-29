# Changelog

All notable changes will be documented here. The format follows Keep a Changelog and releases use
Semantic Versioning.

## [Unreleased]

### Added

- Repository governance, product requirements, measurable goals, architecture/security/operations
  documentation, and pre-release naming review.
- Production-oriented TypeScript monorepo foundation and deterministic vertical-slice work.
- OIDC/JWT BFF and API boundaries, tenant-safe schema/RLS migrations, deterministic reconciliation,
  Shopify/Stripe/CSV connector contracts, proposal/approval audit flow, accessible operator UI, and
  pinned quality/security automation.
- Evidence-backed security review, dependency policy, SBOM generation, and explicit known
  limitations.
- Immutable S3-backed accounting CSV and provider webhook receipts; raw Shopify/Stripe signature
  verification; transactional outbox relay; tenant-authorized BullMQ processing; bounded retry/DLQ;
  and versioned canonical field provenance.
- Reconciliation engine `0.7.0` / rule set `1.5.0` with conservative refund/accounting splits: one
  complete 2–50-row positive strong-reference bucket, checked integer conservation within the
  captured currency tolerance, no subset selection or order-only aggregation, and fail-closed
  competing identity, sign, overflow, and row-reuse behavior.
- Fresh PostgreSQL 17.10 restricted-worker proof that the rule 1.5 three-record split occurrence
  persists under forced tenant RLS, replays without duplication, rejects mutation, and remains
  invisible to a foreign tenant; current synthetic taxonomy, collision, identifier, property, and
  99,999-record regression evidence is preserved under the 0.7.0/1.5.0 version.
- Current mocked Chromium run-detail coverage for the exact rule 1.5 split reason and three-record
  cardinality, including the complete 33-test browser suite, automated accessibility scan, and
  mobile containment.
- Continuous eight-record Chromium → encrypted session/BFF → RS256 API → transactional outbox →
  Redis/BullMQ → restricted worker → PostgreSQL execution of the conserved two-row accounting split,
  including exact three-record browser/API/persistence evidence and a foreign-tenant `404`.
- Reconciliation engine `0.6.0` / rule set `1.4.0` with content-addressed snapshots, run occurrence
  history, indexed exact matching, complete bounded ambiguous ranking, fail-closed collision
  overflow, provider-neutral malformed-identifier quarantine, explicit processing-fee duplicates,
  unique evidence-backed refund/accounting matches, fail-closed candidate reuse/overflow,
  replay/supersession tests, and dated taxonomy/99,999-record/collision regression measurements.
- Fresh PostgreSQL 17.10 restricted-worker proof that rule 1.4 refund/accounting and
  duplicate-processing-fee artifacts retain exact versioned evidence, remain occurrence-idempotent
  on replay, and are hidden from a foreign tenant by row-level security.
- Additive migration 0043 with forced-RLS, append-only per-run match/exception snapshots; replay
  conflict detection; honest legacy-current projections; bounded tenant-authorized API/BFF reads;
  and accessible desktop/mobile operator evidence verified against fresh PostgreSQL and Chromium.
- Tenant/run/type-bound keyset pagination over immutable match and exception occurrences, with an
  API ceiling of 100, a fixed 25-row BFF page, canonical cursor validation, exact/legacy evidence
  fidelity, foreign-tenant concealment, and accessible browse/load-more operator controls.
- Tenant/run-bound ordinal keyset pagination over immutable pinned input versions, with a 100-row
  API/BFF ceiling, strict UUID/version/hash/ordinal client validation, cross-page overlap rejection,
  foreign-tenant concealment, and accessible complete-lineage controls.
- An explicit-write-gated, loopback-only maximum-volume verifier for the pinned-input read path,
  covering concurrent restricted-role traversals of 100,000 references both in-process and across
  two independent reader processes, index use, continuous ordinals, identical reader digests,
  foreign-tenant RLS concealment, and cross-run cursor denial.
- Bounded 1,000-row reconciliation run-input persistence inside the existing atomic run/outbox/audit
  transaction, replacing 100,000 per-row database executions with 100 statements at the configured
  ceiling while preserving global ordinals, stable repeat authority, forced RLS, and exact evidence.
  A loopback-only maximum-volume verifier records fresh PostgreSQL 17.10 creation and checksum
  evidence without executing rules or claiming an API SLO.
- Cross-batch atomic-rollback evidence for maximum-volume run creation: a verifier-only PostgreSQL
  trigger rejects ordinal 1,000 in the second input statement, the earlier batch and every
  run/input/outbox/audit row roll back to zero, and removing the trigger permits the same
  deterministic 100,000-input snapshot to recover without duplicate authority.
- Bounded reconciliation run-authority creation with a validated 5–120 second deadline,
  transaction-local statement backstop, API request-abort cancellation, and a fixed safe `503`.
  Fresh maximum-volume PostgreSQL evidence interrupts the delayed second input batch independently
  by deadline and client signal, proves zero partial authority, then recovers the identical
  snapshot.
- Direct-process maximum-volume fault and contention verification: the explicit-write-gated loopback
  harness kills the actual creator process during its second input batch, accepts only an atomic
  zero-or-complete outcome, retries to exactly one complete authority, and separately requires
  PostgreSQL to observe two independent creators with one advisory-lock waiter before both converge
  on the same 100,000-input run.
- Prompt run-creation deadline settlement under database-pool saturation. The repository returns the
  fixed retry-safe interruption when its signal expires while continuing to observe the
  non-cancellable, signal-guarded pool operation; a fresh 100,000-input verifier holds every
  application connection through the response, releases capacity afterward, and proves the expired
  operation drains with zero authority.
- Bounded per-process run-creation admission before postgres.js. The configurable 1–10 cap defaults
  to two, rejects excess work without invoking the database operation, and retains each lease until
  hidden pool work settles after any earlier caller deadline. A fresh maximum-volume verifier
  admitted two blocked requests, rejected a 32-request burst, rejected again after both public
  deadlines, drained the two hidden operations, and retained zero authority.
- Low-cardinality run-creation unavailability telemetry. The API now counts only
  `admission_saturated` and `interrupted` reasons, keeps the public retry-safe `503` opaque, and has
  loopback OTLP protobuf coverage that rejects tenant and financial identifiers.
- Required distributed provider-request circuits scoped to environment/provider/tenant/connection,
  with pseudonymous Redis keys, atomic token-bound open/half-open/close transitions, transient-only
  classification, one recovery probe, fail-closed admission-store errors, bounded retry-after-aware
  durable delay, and fixed identifier-free provider-sync/circuit telemetry.
- Corrected tenant-authorized connector-health watermarks to use an immutable, versioned
  source-event family classification written atomically by provider and CSV intake instead of
  treating transport topics as product-facing families. Unclassified operational receipts now fail
  the entire connection family view closed as `classification_unavailable`; migration 0049 adds
  tenant-scoped forced-RLS append-only storage without unsound legacy backfill.
- Stable fixed Shopify, Stripe, and accounting CSV watermark families with strict
  cross-connection/type/gap rejection, runtime-validated accessible browser output, a raw-event
  tenant/connection index, and no normalization or completeness claim.
- Stripe connector/normalizer 1.1.0 bounded two-phase Events and charge-balance-transaction
  recovery, with a separate circuit permit per request, legacy-compatible versioned cursors,
  minimized expanded-Charge snapshots, safe integer fee/net conservation, atomic
  `balance_transaction` classification, replay-safe processing-fee normalization, and explicit
  incomplete evidence when a Charge has no PaymentIntent.
- Authenticated durable reconciliation trace propagation. The API stores only its locally accepted
  version-1 W3C parent in immutable outbox authority, the complete context participates in the job
  hash, and the worker honors it only after exact tenant-bound authority matching.
- Authenticated trace propagation for every current shared durable-envelope type. Signature-verified
  provider webhooks, tenant-authorized CSV commits and user-requested provider syncs now persist the
  same locally accepted context; provider-sync consumers parent their child webhook jobs to the
  active authorized worker span. Existing envelopes and scheduled sync requests remain compatible
  roots.
- Reusable isolated live verifier for the continuous Chromium → encrypted session/BFF → RS256 API →
  transactional outbox → Redis/BullMQ → restricted worker → immutable PostgreSQL evidence path,
  including three exact matches, one exact duplicate-fee exception, audit/delivery assertions, a
  conserved two-row accounting split, and a foreign-tenant `404`; the development fixture now
  respects the Shopify customer-reference privacy constraint without weakening it.
- Organization-serialized run completion authority that prevents late older snapshots from rolling
  the live queue backward, with one current run marker, historical-only results, automatic pending
  proposal supersession, and append-only exception lifecycle events.
- Configurable organization review policy, versioned resolution proposals, distinct dual reviewers,
  append-only approval evidence, and management/read APIs.
- Tenant-authorized connector freshness/retry/DLQ views and guarded membership role/status lifecycle
  with reasoned audit, self-mutation prevention, and last-owner protection.
- Tenant-authorized append-only exception notes, audited self-assignment/defer/reopen workflow, and
  a bounded chronological investigation timeline with accessible operator controls.
- Tenant-authorized organization audit history plus stable keyset exception pagination, exact
  status/severity/ID/type filters, database-derived queue totals, supporting indexes, and
  authenticated browser coverage for notes, assignment, dual-control approval, and accessibility.
- Permission-gated exact-filter exception queue CSV export with 10,000-row and 5 MiB ceilings,
  formula-safe RFC 4180 cells, a fixed safe filename, complete-payload BFF verification, audit
  metadata, and browser coverage for non-empty downloads and zero-byte prevention.
- Tenant-scoped organization invitations with digest-only 256-bit tokens, verified-email and expiry
  binding, fixed least-privilege database authority, single-use acceptance/revocation, audit events,
  one-time link controls, and authenticated accessibility/browser coverage.
- Identity-derived organization directory pages with literal bounded search, stable lower-name/UUID
  keyset cursors, exact current-membership selection verification, rolling-image database-function
  compatibility, and bounded searchable operator controls.
- Verified-email, first-membership-only organization bootstrap with server-generated authority
  identifiers, fixed owner/AI-disabled state, serialized digest-bound idempotency, append-only
  tenant evidence, same-transaction first audit event, exact-origin BFF handling, and retry-safe
  onboarding UI.
- Fresh PostgreSQL restricted-role proof for the actual organization-bootstrap service transaction:
  exact replay, two-call concurrency convergence, foreign-identity exclusion, forced-audit rollback,
  and populated 0041-to-0043 upgrade compatibility; the complete current PostgreSQL/Redis/MinIO
  integration graph passes 54 tests across 19 files.
- Real local Keycloak 26.7.0 authorization-code/PKCE first-login onboarding from zero memberships,
  including the temporary-password required action, two same-session browser tabs racing different
  first organizations with 201/409 convergence, exactly one AI-disabled tenant/owner/bootstrap
  request/canonical audit event, HttpOnly session/context cookies, and no browser-readable provider
  credentials.
- Extended the isolated Keycloak verifier through a second verified identity, authenticated local
  invitation-relay acceptance and rejection, invitation acceptance with automatic tenant selection,
  auditor denial, administrator promotion, immediate deactivation denial, least-privilege reviewer
  reactivation, revocation and replay denial, digest-only token persistence, and a complete
  ten-event canonical audit chain.
- Replaceable authenticated HTTP invitation-email relay with strict configuration, bounded timeout,
  redirect rejection, token-free delivery audit/log metadata, explicit provider-acceptance status,
  and a one-time manual-link fallback for disabled or failed delivery.
- Administrator accounting-import rollback by immutable canonical supersession, bounded exact-filter
  queue export, and tenant-authorized review-policy controls.
- Live backing-service verification for PostgreSQL migration/RLS/durability, Redis-backed BullMQ
  deduplication and capability rejection, and S3-compatible immutable object checksums.
- Durable token-digest job-execution leases with heartbeat and terminal state, conservative
  unpublished/never-started/retryable/stale-running recovery classification, append-only recovery
  evidence, rolling-writer compatibility, and guarded empty-Redis reconstruction.
- Checksum-verified Keycloak 26.7.0 local OIDC smoke covering real browser login, tenant-authorized
  connector/import reads, and browser-to-BFF-to-API-to-outbox-to-worker reconciliation completion.
- Disabled-by-default Shopify/Stripe OAuth authorization with digest-only single-claim state, fixed
  callbacks/provider origins, bounded code exchange and locked refresh generations, encrypted
  account/scope/mode metadata, Shopify provider-first uninstall, Stripe action-required disconnect,
  and exact signed app-deauthorization finalization.
- Fixed app-level Shopify mandatory privacy intake with exact app-secret HMAC verification,
  post-authentication canonical-shop tenant resolution, minimized request evidence, 30-day deadline,
  action-required connection state, and customer/shop-scoped raw-object deletion jobs.
- Owner/administrator-only Shopify privacy operations view with server-resolved tenant authority,
  tenant-bound earliest-deadline keyset pagination, aggregate raw-object deletion progress, explicit
  incomplete fulfillment messaging, and API-level exclusion of customer/order/event/digest/storage
  fields.
- Default-enabled bounded Shopify privacy deadline monitor with worker-only cross-tenant candidate
  discovery, exact tenant-context creation, append-only seven-day/24-hour/overdue signals,
  same-transaction hash-chained audit evidence, aggregate-only warning/error logs, and minimized
  operator rendering.
- Dual-authorized, reasoned Shopify customer-data evidence package preparation with tenant-bound
  Shopify/Stripe order linkage, verified immutable raw payloads, sanitized normalized records,
  100-record/one-MiB-object/five-MiB complete-or-fail limits, fixed safe JSON download headers,
  metadata-only audit evidence, and explicit non-delivery/non-fulfillment messaging.
- Digest-only Shopify privacy-package browser receipts with random 256-bit ten-minute authority,
  exact tenant/request/package/same-active-membership binding, one append-only idempotent
  receipt/audit event, a dual-authorized 48th API route, no-store BFF headers, and fail-closed
  acknowledgement before download. The evidence remains explicitly `not_delivered` and does not
  claim merchant/customer transfer, fulfillment, or downloaded-copy expiry.
- Deterministic per-tenant audit-chain topology with late/same-time-safe head selection, canonical
  version-2 hashes, legacy graph preflight, one-genesis/one-child/tenant-self-FK constraints,
  same-lock insert validation, and fail-closed fork/orphan/cross-tenant/multi-row-cycle protection.
- Production-required Redis API rate limiting with one pseudonymous address budget across replicas,
  explicit direct-proxy CIDR trust, bounded fail-closed store access, safe correlated 429 responses,
  limiter-independent liveness, a statically validated Nginx outer budget, and preserved Next.js
  BFF/direct-versioned-API routing.

### Security

- Defined mandatory tenant, money, webhook, audit, credential, and AI-safety invariants.
- Hardened production session configuration and cache controls, user identity RLS, migration
  checksum/concurrency behavior, dependency overrides, log redaction, CSP, CSRF/origin checks, and
  container non-root execution.
- Restricted provider secrets to allowlisted external references, isolated cross-tenant outbox relay
  authority to a worker role, and database-protected canonical provenance/proposal/approval history.
- Restricted invitation mutation to tenant-checked database functions; raw invitation tokens are
  never persisted or audited, owner access can be minted only by an owner, and acceptance requires a
  matching provider-verified email.
- Bound successful invitation acceptance to the existing subject-signed organization context only
  after strict upstream response validation; rejected, malformed, cross-site, expired, and
  subjectless requests cannot receive the context cookie.
- Corrected invitation acceptance output-parameter qualification and replaced BullMQ-incompatible
  colon-delimited queue names with one shared, versioned, hyphen-delimited producer/consumer name.
- Removed an unused Drizzle runtime wrapper that replaced postgres.js JSON serializers on the shared
  client and broke composed import/audit writes; live integration now exercises the production
  database handle.
- Updated the local Keycloak pin from 26.3.2 to security-maintained 26.7.0.
- Bound Stripe uninstall events to the globally unique account, live/test mode, and current
  authorization generation before tenant-scoped credential revocation; exact replays are idempotent
  and stale reinstall events cannot disconnect a later authorization.
- Removed mandatory Shopify privacy topics from tenant-routed connection webhooks; added
  least-privilege, legal-hold-serialized checksum-bound raw deletion with bounded retry/dead-letter
  state and immutable tenant tombstones, while explicitly retaining unresolved canonical/backup
  obligations.
- Prevented direct application/worker mutation of privacy deadline signals; the worker can use only
  fixed RLS-on discovery/creation functions, and each stage is database-recomputed and idempotent.
- Excluded shared accounting CSV objects, storage keys, digests, and internal authority identifiers
  from Shopify customer-data packages; corrupt/missing/oversized evidence produces no partial
  package or success audit, and the BFF validates the complete package identity before download.
- Replaced production process-local request budgets with a shared Redis authority; limiter keys use
  environment-scoped HMAC address digests, untrusted forwarding headers cannot select an identity,
  and missing distributed/proxy configuration now prevents production startup.
- Prevented automatic matching, duplicate grouping, candidate ranking, fee/refund/accounting
  linkage, and visually unsafe rendering for canonical records containing malformed identity fields;
  safe records continue deterministically and rejected CSV rows remain pre-canonical import
  outcomes.
- Prevented one accounting row from silently satisfying multiple refunds, replaced boolean
  accounting existence with an immutable exact match artifact, bounded per-refund candidate work and
  overflow taint, and stopped classifying duplicate processing fees as accounting-entry duplicates.

### Known limitations

- No production release, staging reliability evidence, or statistically representative load result
  exists. The recorded synthetic benchmark is a single local regression datum.
- Working name has material collisions and is not approved for public release.
- See `docs/known-limitations.md`.
