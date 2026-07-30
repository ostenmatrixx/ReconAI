# Goal 1 evidence — Deterministic vertical slice

Status: active

Current requirement-to-evidence audit: `docs/goals/goal-1-audit-2026-07-30-28.md`. The earlier
2026-07-29 and 2026-07-30 audits remain immutable point-in-time evidence; this living page and
`GOALS.md` track later implementation without rewriting them.

## Available repository evidence

- Identity/tenancy: standards-based OIDC JWT verification, encrypted HTTP-only provider
  access/refresh credentials, bounded access-token refresh rotation with fail-closed
  reauthentication, literal-search/keyset-paginated identity-derived active-organization
  enumeration, exact membership-intersected selection outside the current page, HttpOnly HMAC-signed
  subject-bound tenant selection, verified-email/first-membership-only idempotent organization
  bootstrap with a fixed owner and atomic first audit event, current membership/permission
  re-resolution, API cross-tenant rejection tests, a typed 55-route authorization inventory with
  fail-closed registration and centralized tenant admission, uniform authenticated
  foreign-tenant/permission `404`, forced RLS policy SQL, organization-scoped foreign keys, and
  digest-only 256-bit invitations with verified-email/expiry/single-use binding, owner-role
  controls, revocation, audited acceptance, and a replaceable authenticated email relay with
  failure-safe one-time-link fallback.
- OIDC dependency boundary: the exact NextAuth transitive `openid-client@5.7.1` is bound to a
  reviewed pnpm patch replacing every legacy `url.parse()` call with WHATWG `URL`. Configured
  issuers must already be canonical. The OIDC gate validates the patch mapping/hash, scans installed
  sources, executes discovery/callback/logout/Passport behavior, verifies Keycloak PKCE/state, and
  passes under `NODE_OPTIONS=--throw-deprecation`. Focused issuer, refresh, logout, and revocation
  tests pass without changing session authority. A fresh isolated Keycloak 26.7.0 exercise now
  proves the patched authorization-code/S256 PKCE path, access and zero-reuse refresh-token
  rotation, provider-credential nondisclosure, RP logout, signed Back-Channel Logout into one actual
  Next.js process, old-cookie denial, and repeat-login behavior under fatal deprecation handling. A
  second fresh exercise runs two production-built Next.js processes against one authenticated
  persistent Redis 8.2.8 authority and proves targeted `sid` isolation, old-cookie rejection through
  both replicas, unaffected-session admission, cross-replica replay, fail-closed Redis loss,
  liveness independence, persistent restart, and later-login recovery. The patch remains a local
  maintenance bridge; protected multi-host Redis/ingress, clock/secret rotation, alert delivery, and
  a stable upstream replacement remain open. Evidence:
  `artifacts/oidc-url-parser-patch-verification-2026-07-29.json` and
  `artifacts/post-patch-oidc-lifecycle-verification-2026-07-29.json`, plus
  `artifacts/oidc-distributed-revocation-recovery-verification-2026-07-29.json`; decision: ADR 0059;
  threats: TM-09 and TM-49.
- Restricted support: default-disabled platform support identity is separate from tenant membership
  and requires an exact configured OIDC group plus exact MFA authentication context. The raw issuer
  and subject are reduced to a dedicated keyed digest. A support identity can create only a
  15-minute organization-unbound request; an active tenant owner must exchange the one-time
  digest-only code for one fixed `diagnostics:view` grant lasting 5–60 minutes. Forced-RLS ledgers,
  execute-only fixed functions, exact tenant/grant/identity checks, uniform not-found responses,
  revocation, capped aggregate diagnostics, worker/direct-table denial, and hash-chained
  approval/use/revocation audit pass unit, API/tenant, static, populated-upgrade, and fresh
  PostgreSQL tests. No tenant directory, impersonation, financial record, raw payload, credential,
  export, note, or write capability is exposed. A distinct organization-blind support console now
  keeps one-time codes only in page memory and loads only exact approved aggregate diagnostics; the
  tenant Security surface separately lists, explicitly approves, and revokes grants through signed
  organization context. Fixed-route BFF, cookie non-forwarding, response-ceiling, uniform denial,
  action-injection, Chromium, storage-negative, and accessibility tests pass. A fresh isolated
  Keycloak 26.7.0/PostgreSQL 17.10/API/web/Chromium run now binds Keycloak's native LoA 2 flow,
  requests `acr_values=2`, completes password plus TOTP, denies a wrong TOTP before any application
  session, admits only the exact `/reconai-support` group and signed `acr=2`, and composes request,
  owner approval, fixed diagnostics, outsider denial, revocation, RLS, and the v2 audit chain
  through the product. Deployed/protected IdP policy and bypass resistance, ticket-system
  validation, customer notification, clipboard/endpoint controls, key rotation across replicas,
  offboarding, periodic access review, timing, incident, and protected-staging evidence remain open.
  Evidence: `artifacts/restricted-support-access-verification-2026-07-29.json`,
  `artifacts/restricted-support-browser-tools-verification-2026-07-29.json`, and
  `artifacts/oidc-restricted-support-mfa-verification-2026-07-30.json`. The restricted-support BFF
  additionally enforces exact action-specific success statuses, strict three-code errors, fatal
  UTF-8, explicit credential omission, and redirect rejection. Evidence:
  `artifacts/restricted-support-response-boundary-verification-2026-07-29.json`; threats: TM-17 and
  TM-44; decisions: ADRs 0053 and 0054.
- Browser error boundary: internal API errors are bounded to 64 KiB and accepted only when a strict
  envelope, route-specific code/status pair, and UUID correlation identifier validate. The BFF
  discards internal messages and emits fixed browser-safe copy; unknown fields, diagnostics,
  malformed responses, and status drift fail closed to a private generic `502`. Invitation
  acceptance, exception export, and privacy-package preparation/receipt use the shared control and
  explicitly omit ambient upstream credentials and reject redirects. Evidence:
  `artifacts/browser-api-error-boundary-verification-2026-07-29.json`; threat: TM-41.
- Invitation-acceptance success boundary: the membership-creating BFF reads at most 64 KiB by
  declared and streamed size, decodes fatal UTF-8, requires exact `201`, and validates the strict
  minimal invitation/membership response before issuing subject-bound organization context.
  Oversized, malformed, expanded, status-drifted, or invalidly encoded responses receive no cookie.
  The fixed upstream request omits ambient credentials, rejects redirects, and retains its bounded
  timeout. Evidence:
  `artifacts/invitation-acceptance-response-boundary-verification-2026-07-29.json`; threat: TM-45.
- Browser mutation response boundary: all 18 shared mutation actions enforce explicit success
  statuses and strict error allowlists. Nine data-bearing successes are parsed and reconstructed
  from only client-required fields; nine others become a fixed acknowledgement. Response ceilings,
  fatal UTF-8 decoding, fixed upstream destinations, omitted ambient credentials, and rejected
  redirects fail schema/status drift closed without forwarding credentials, tokens, diagnostics, or
  unknown fields. Evidence:
  `artifacts/browser-mutation-response-boundary-verification-2026-07-29.json`; threat: TM-42.
- Browser read response boundary: all 19 `/api/recon` read modes are validated and minimized. The 17
  general tenant views now have exhaustive success schemas; organization discovery and support
  grants retain their strict dedicated contracts. Exact success status, list/page ceilings, fatal
  UTF-8, a 5 MiB tenant-success ceiling, four fixed read errors, omitted ambient credentials, and
  rejected redirects prevent API-only authority, audit-value, credential, token, diagnostic, and
  unknown fields from crossing the BFF. Deterministic evidence, record references, canonical
  normalized records, and field lineage now use strict bounded typed projections with one fixed
  unavailable state; no raw or partial JSON fallback crosses the boundary. Evidence:
  `artifacts/browser-read-response-boundary-verification-2026-07-29.json`; threat: TM-43.
- Ingestion contracts: raw-body Shopify HMAC and Stripe signature verification; explicit provider
  event/API-version allowlists; immutable tenant object keys with checksum verification; durable
  receipt/outbox transactions; idempotent worker normalization; bounded Shopify, Stripe, and CSV
  normalization; fixed/validated-origin cursor-paginated Stripe Events and Shopify order/refund
  snapshot recovery adapters with distinct read credentials, 30-day/window/page/item/byte/timeout/
  retry ceilings, API-version capture/validation, immutable tenant run authority, and
  operator-requested backfill/gap repair plus opt-in periodic repair through a fixed system
  identity, bounded configuration, deterministic cadence idempotency, and shared concurrency lock;
  fixed app-level Shopify mandatory privacy intake with exact app-secret HMAC, post-authentication
  shop-to-tenant resolution, minimized append-only request evidence, action-required connection
  state, legal-hold-serialized checksum-bound raw-object deletion jobs/tombstones, and an
  append-only seven-day/24-hour/overdue monitor with worker-only bounded discovery and exact
  tenant-context creation plus dual-authorized, complete-or-fail linked-provider evidence package
  preparation and digest-only, ten-minute, same-active-membership browser receipt before download;
  CSV mapping/preview/commit; tenant-authorized, exact-confirmation, rollback-by-supersession that
  preserves source/canonical history while excluding future run inputs; and synthetic
  duplicate/reorder/privacy/invalid-input tests.
- Canonical/reconciliation: runtime canonical schemas, integer minor-unit money, immutable per-field
  provenance, a deterministic/versioned engine, source-version/content-hash and complete policy
  snapshots, transactional run-request outbox authority, least-privileged worker execution,
  immutable per-run match/exception occurrence evidence with honest legacy projections, bounded
  recovery replay of the original immutable snapshot, organization-serialized completion authority,
  historical-only out-of-order results, append-only exception lifecycle transitions,
  replay/supersession behavior, cross-currency refusal, broad exception taxonomy, strict bounded
  stored rule evidence, and safe kind-specific browser projections with all-or-nothing field
  lineage. A separate production-hardening profile now executes exactly 100,000 mixed synthetic
  records in five fresh processes. Canonical, reversed, rotated, and repeated inputs retain one run
  identity and result digest with exact money conservation; pure-engine timing excludes every
  persistence/network stage and is not an SLO. Evidence:
  `artifacts/reconciliation-representative-load-post-lint-verification-2026-07-30.json`; decision:
  ADR 0067.
- Review: authenticated exception list/detail and run APIs, proposal/independent approval
  transactions, versioned proposals, configurable amount/category/high-severity dual approval,
  distinct-reviewer enforcement, original-proposer-only immutable pending revision with old-version
  supersession and approval reset, append-only proposal/approval and hash-chained audit evidence,
  exception-first approval/revision serialization, BFF CSRF/origin checks, append-only internal
  notes, self-assignment, bounded defer/reopen controls, a chronological exception timeline, a
  bounded organization audit-history view, stable keyset queue pagination with exact
  status/severity/ID/type filters and database-derived totals, permission-gated exact-filter CSV
  export with 10,000-row/5 MiB ceilings, formula-safe RFC 4180 cells, fixed content disposition,
  full-payload BFF verification, and metadata-only audit evidence, tenant-authorized run
  list/detail/start/replay controls with confirmation and audit-visible reasons, and accessible
  dashboard/queue/investigation/proposal UI states. Investigation and run-artifact views render
  paired source/normalized comparisons, deterministic rule/tolerance/search summaries, verified
  references, and a fixed unsupported/malformed fallback without generic evidence JSON.
- Policy controls: tenant-authorized, database-constrained review-policy read/update; deterministic
  currency-threshold and sensitive-resolution ordering; duplicate rejection; required audit-visible
  reason and explicit confirmation; and an accessible administrator rules surface. Run amount/time
  tolerances remain separately pinned to every immutable run.
- Organization/health: authenticated membership listing and role/status mutation, self-mutation and
  last-owner lockout prevention, owner-role boundary, bounded organization directory and accessible
  selector with search, paging, exact selection verification, and bounded accumulation, invitation
  creation/revocation/acceptance, verified first-organization creation with durable exact-retry
  evidence and an accessible empty-membership form, versioned organization-name read/update with
  exact expected-version conflicts, same-transaction v2 audit, same-name no-op, immediate directory
  refresh, and an accessible confirmation/conflict-reload form, token-free email-delivery outcome
  audit, reasoned audit events, membership/connection state database constraints, and
  tenant-authorized connector freshness/retry/DLQ APIs with accessible UI states. Business time zone
  remains read-only. Connector administration also has disabled-by-default Shopify/Stripe OAuth with
  digest-only single-claim state, fixed callbacks, bounded code exchange/refresh, encrypted token
  generations, Shopify provider-first uninstall, and exact-raw-body Stripe App deauthorization bound
  to account, mode, and authorization generation.
- Reliability: queue jobs are authorized against tenant-bound outbox authority; an independent
  worker role owns cross-tenant relay functions; retries are bounded and failed relays dead-letter.
  The disabled-by-default provider repair scheduler can only create due Shopify/Stripe runs through
  `row_security=on` worker functions, a fixed service identity, exact envelope validation, and a
  shared per-connection advisory lock. Production API admission requires a shared Redis limiter,
  environment-scoped HMAC address keys, and explicit direct-proxy CIDRs; synthetic two-instance,
  forwarding-spoof, store-failure, 120/121, correlated-response, liveness, and static edge-routing
  checks pass without using organization IDs as pre-authentication evidence. A local two-process
  production-mode API exercise now proves one exact shared 120/121 budget, forwarding overwrite,
  pseudonymous keys, fail-closed Redis process loss with independent liveness, persistent recovery,
  and coordinated drain/restart HMAC-key rotation. A local Nginx 1.30.4 run parses the canonical
  edge policy, discards client-selected forwarding chains, routes across two Fastify upstreams,
  enforces the request ceiling, and proves that 100 forged identities cannot split the outer budget.
  A fresh exact-source run also parses the explicit query-free JSON access log and omits synthetic
  callback `code`/`state` values from all thirteen bounded entries. External ingress/CDN/hosting and
  collector logging policy remains unverified. Evidence:
  `artifacts/api-rate-limit-replica-recovery-verification-2026-07-29.json` and
  `artifacts/edge-access-log-redaction-verification-2026-07-29.json`; decision: ADR 0060; threats:
  TM-21 and TM-50. API readiness now concurrently requires PostgreSQL, Redis, and private object
  storage behind a bounded, single-flight/cached probe, returns no component detail publicly, and
  keeps liveness process-only; a checksum-pinned live run proved independent transport
  failure/recovery for all three dependencies across two local API replicas. Dependency process
  crashes, cross-host partitions, scheduler polling, and alert delivery remain unverified.
- Retention: raw import/provider object expiry is disabled by default and independently configurable
  from 1–3,650 days per organization. A reasoned legal hold, exact confirmation, audit-visible
  changes, terminal-source eligibility, serialized policy recheck, checksum/ETag/version-bound
  deletion, bounded retry/dead-letter state, forced RLS, worker least privilege, and append-only
  tombstones have API/BFF/browser and live PostgreSQL/MinIO evidence. Canonical, provenance,
  reconciliation, review, audit, job, and tombstone evidence remains retained.
- Shopify privacy: all three mandatory topics enter through a fixed app-level endpoint without
  client tenant IDs. Synthetic/static tests cover exact-body authentication, forged/topic/domain/
  API-version rejection, identifier bounds, email/phone minimization, tenant resolution, forced
  RLS/role structure, raw-object job authority, retry/dead-letter behavior, and legal-hold
  serialization. Owners/administrators can view bounded deadlines and aggregate raw-deletion
  progress plus the highest durable escalation through a field-minimized tenant/API/BFF/UI path;
  customer/order/event/digest/object-key fields remain excluded. Threshold, replay, fixed-function,
  configuration-bound, API, and browser/accessibility tests are synthetic/static. A reasoned,
  dual-authorized data-request action now returns at most 100/five-MiB checksum-verified
  Shopify/Stripe raw and normalized evidence records through a fixed-name BFF download and writes
  metadata-only `not_delivered` audit evidence; shared accounting CSV is excluded and failures never
  return a partial package. The complete browser bytes are acknowledged through digest-only,
  ten-minute authority bound to the same active membership before download; one idempotent
  append-only receipt/audit event still says `not_delivered`. Every request stays action-required
  because secure merchant/customer transfer, recipient verification/acknowledgement, downloaded-copy
  expiry, over-limit handling, external alert acknowledgement, legacy/canonical disposition,
  noncurrent versions, caches/search/exports/replicas, and backups are not complete. Evidence:
  `artifacts/privacy-package-browser-receipt-verification-2026-07-29.json`; decision: ADR 0049.
- Quality through 2026-07-30: 641 unit/property/tenant/reconciliation tests in 92 files, 50 Chromium
  tests including 14 accessibility scans, and 56 migration files pass local static checks. The
  organization-profile verifier applies all 56 migrations to a fresh PostgreSQL 17.10 cluster and
  passes its focused Fastify/restricted-role concurrency test plus three Chromium tests. The prior
  complete fresh, data-checksummed PostgreSQL 17.10 database applied all 55 migrations and passed
  all 39 tests across the 11 database integration files through separate administrator, migrator,
  application, worker, and maintenance roles. This includes the populated 0041-to-0054
  previous-release upgrade, source-family classification, minimized Stripe balance-transaction fee
  persistence, privacy-package browser receipt, bounded classification repair authority, and
  restricted support request/approval/diagnostics/revocation; RLS, restricted grants, append-only
  enforcement, replay, and cross-tenant negatives pass. The dedicated repair suite adds two live
  tests for concurrent claims, audit integrity, rollback/retry, replay, and unsupported gaps.
  Evidence: `artifacts/restricted-support-access-verification-2026-07-29.json` and
  `artifacts/source-event-classification-repair-verification-2026-07-29.json`. A prior fresh
  data-checksummed PostgreSQL 17.10 cluster, authenticated Redis 8.2.8, and pinned MinIO instance
  passed all 54 current integration tests across 19 files with no skips on the then-current
  44-migration chain. It exercised the actual restricted-role organization bootstrap service, exact
  replay, two-call concurrency, atomic audit rollback, identity exclusion, and a populated
  0041-to-0043 upgrade while leaving Redis and tenant object buckets empty after cleanup. A clean
  PostgreSQL 17.10 database applied the 40 migrations through 0039 and all 11 PostgreSQL-backed
  files passed 34 tests through administrator, migration, application, and worker roles, including
  provider OAuth/privacy repositories, audit writer concurrency/topology denials, and the populated
  0038-to-0039 upgrade. A later fresh-cluster exercise applied migration 0040 and verified its
  restricted execution ledger. A separate fresh cluster applied the then-current 43 migrations and
  passed the three-test restricted-worker reconciliation execution file; its rule 1.4 case persisted
  the exact refund/accounting and duplicate-fee artifacts, replayed without duplicate occurrences,
  and exposed zero rows to a foreign tenant under RLS. A same-database repeat of both provider
  lifecycle files also passed 7 tests. An earlier 28-migration snapshot passed the then-complete
  15-test integration command in eight files against PostgreSQL 16.14, Redis 8.2.1, and the pinned
  MinIO release. A same-stack host-process smoke authenticated a real browser against Keycloak
  26.7.0, loaded three tenant-authorized connectors and one completed immutable import, and
  completed a browser-requested six-record reconciliation through the BFF, API, outbox, and worker
  with two matches, zero exceptions, live queue authority, and one dispatch. The current
  44-migration chain passed fresh-database upgrade, restricted-worker, and API repository tests for
  exact append-only occurrence snapshots, replay equality, rolling-window legacy labeling, bounded
  previews, and foreign-tenant denial. A checked-in continuous verifier also passed against a fresh
  44-migration PostgreSQL 17.10 database, Redis 8.2.8, and the pinned MinIO release. Headless
  Chromium submitted a reasoned run through an encrypted session and same-origin BFF; the API
  verified RS256 through a local JWKS, resolved tenant authority, and returned `202`; the
  transactional outbox published one run event; BullMQ and the restricted worker completed it on
  attempt one; and the browser read three exact matches plus one exact duplicate-fee exception from
  four immutable `artifact-occurrence-v1` snapshots. Its eight inputs include two positive
  accounting rows under one strong refund reference; the browser, BFF read model, and PostgreSQL
  snapshot all reported the resulting `refund-accounting-split` with reason
  `REFUND_ACCOUNTING_SPLIT_TOTAL_MATCHED` and three record references. The same exercise returned
  `404` for a foreign-tenant run request and recorded no credential. This local identity authority
  was a minimal RS256/JWKS fixture, not Keycloak or staging. Evidence:
  `artifacts/reconciliation-continuous-split-journey-verification-2026-07-29.json`. Run detail keeps
  a ten-artifact-per-type preview and five-MiB upstream ceiling, while a new read-only endpoint and
  fixed 25-row BFF path traverse a truncated ledger with tenant/run/type-bound keyset cursors. Fresh
  PostgreSQL 17.10 evidence loads 12 matches in 5/5/2 pages with exact/legacy fidelity, cursor
  replay denial, and foreign-tenant RLS concealment; Chromium replaces the preview and loads all 12
  without duplication. Evidence:
  `artifacts/reconciliation-artifact-pagination-verification-2026-07-29.json`. The separate
  100-record pinned-input preview can now be expanded through fixed 100-row BFF pages and a
  tenant/run-bound ordinal cursor. Fresh PostgreSQL traverses 102 inputs in 40/40/22 pages with
  continuous ordinals and zero foreign rows; Chromium loads 100/2 without duplication. Evidence:
  `artifacts/reconciliation-input-lineage-pagination-verification-2026-07-29.json`. A separate fresh
  PostgreSQL 17.10 run traverses the configured 100,000-input maximum with concurrent 100-row and
  97-row restricted-role readers both in-process and in two independent processes. All four
  complete-set digests match with continuous ordinals; the run also confirms the expected index,
  cross-run cursor denial, and zero foreign rows. Its single-host local timings are not an SLO.
  Evidence: `artifacts/reconciliation-input-pagination-maximum-volume-verification-2026-07-29.json`.
  The matching creation path now persists inputs in 1,000-row batches within the unchanged atomic
  run/input/outbox/audit transaction. On another fresh checksummed PostgreSQL 17.10 database, the
  restricted application role created one 100,000-input queued run with continuous ordinals, one
  dispatch, one audit event, exact-repeat idempotency, and foreign-tenant concealment. The log
  independently recorded 100 input inserts and offline checksums were clean. This direct repository
  timing is not evidence of the proposed job-completion SLO. Evidence:
  `artifacts/reconciliation-run-creation-maximum-volume-verification-2026-07-29.json`. Browser
  evidence is supplemented by an explicit cross-batch rollback negative on a later fresh PostgreSQL
  17.10 database. A verifier-only trigger rejected ordinal 1,000 in the second input statement; the
  earlier statement and every run/input/outbox/audit row rolled back to zero. Removing the trigger
  allowed the identical deterministic 100,000-input snapshot to recover and repeat idempotently,
  with clean offline checksums. Evidence:
  `artifacts/reconciliation-run-creation-atomic-rollback-verification-2026-07-29.json`. A third
  fresh checksummed PostgreSQL 17.10 run delayed the same second input statement and separately
  interrupted it through the new bounded authority deadline and a direct client signal. Each attempt
  left zero run/input/outbox/audit rows, PostgreSQL logged ordinary cancellation with no fatal
  session event, and removing verifier objects allowed complete 100,000-input recovery and
  exact-repeat idempotency. Evidence:
  `artifacts/reconciliation-run-creation-interruption-verification-2026-07-29.json`. Browser
  evidence is also supplemented by a fourth fresh-database fault/contention run. The harness killed
  the actual direct creator process during the delayed second batch; PostgreSQL logged an unexpected
  EOF with an open transaction, retained zero authority rows, and an identical retry created one
  complete 100,000-input authority. A distinct policy snapshot launched two direct creators that
  PostgreSQL observed concurrently with one advisory-lock waiter. Both returned the same run and
  only one complete 100-batch ledger/outbox/audit authority persisted. This establishes the bounded
  single-host zero-or-complete plus idempotent-retry contract, not guaranteed rollback for every
  disconnect or multi-host behavior. Evidence:
  `artifacts/reconciliation-run-creation-process-loss-contention-verification-2026-07-29.json`. A
  fifth fresh maximum-volume run occupied both connections in the restricted application's
  two-connection pool. The repository returned its fixed interruption after 5,002.55 ms while both
  holder transactions remained occupied. Capacity was released afterward; the expired queued
  operation drained with zero run/input/outbox/audit rows, and the later process-loss and contention
  controls still passed. This closes one local pool-saturation response case, not sustained queue
  pressure or end-to-end API latency. Evidence:
  `artifacts/reconciliation-run-creation-pool-saturation-verification-2026-07-29.json`. Browser
  evidence is now supplemented by a fail-fast 1–10 per-process transaction cap, default two, before
  postgres.js. A sixth fresh maximum-volume run admitted two blocked requests, rejected 32 excess
  attempts in 0.28 ms without database admission, settled both admitted callers after
  5,001.93/5,002.10 ms, and still rejected another request in 0.21 ms while the two hidden
  operations retained their leases. Capacity release drained them with zero authority, and all later
  fault, retry, and contention controls passed. This bounds one local process's burst, not sustained
  multi-replica pressure, protected-staging capacity, or an API SLO. Evidence:
  `artifacts/reconciliation-run-creation-admission-pressure-verification-2026-07-29.json`. Browser
  evidence is now also supplemented by a fixed-vocabulary
  `reconai.reconciliation.run_creation.unavailable` OTLP counter. Local protobuf capture contains
  only the `admission_saturated` and `interrupted` reasons, and the public `503` does not expose
  either. This is local contract evidence, not an exercised backend/dashboard/alert path. Evidence:
  `artifacts/reconciliation-run-creation-unavailability-observability-verification-2026-07-29.json`.
  All four shared durable-envelope types now persist locally accepted version-1 W3C context in
  immutable outbox payload and canonical job identity: reconciliation, signature-verified webhook,
  tenant-authorized CSV commit, and user-requested provider sync. Provider-sync consumers parent
  their child webhook jobs to the active authorized span. The worker loads and exactly matches
  tenant-bound authority before creating any parented consumer; legacy envelopes and scheduled sync
  requests remain roots. Schema/worker/loopback OTLP tests and fresh webhook/CSV/sync
  restricted-role PostgreSQL repository runs pass. Evidence:
  `artifacts/reconciliation-durable-trace-context-verification-2026-07-29.json` and
  `artifacts/durable-producer-trace-context-verification-2026-07-29.json`; decision: ADR 0036. A
  leased worker monitor now adds environment-wide unresolved-exception presence and oldest-age
  gauges through one identifier-free, worker-only database function. Its partial global index is
  built concurrently; the migration runner refuses to record 0044 unless the same-named index is
  ready and valid. Followers are read-free, and failed/future/malformed/expired observations remove
  the process snapshot. Static/repository/worker/loopback OTLP evidence passes, while live 0044/0045
  PostgreSQL execution, protected thresholds, dashboards, and alerts remain open. Evidence:
  `artifacts/unresolved-exception-queue-age-observability-verification-2026-07-29.json`; decision:
  ADR 0043. The same lease owner also publishes one atomic, expiring Shopify/Stripe snapshot for the
  oldest queued or running sync through a fixed worker-only two-provider database function and
  concurrent partial index. Followers are read-free; incomplete, future, malformed, failed, expired,
  and shutdown observations clear both providers. Local static/repository/worker/OTLP evidence
  passes; live 0046/0047 PostgreSQL execution, protected thresholds, dashboards, silence handling,
  and alerts remain open. Evidence:
  `artifacts/provider-active-sync-age-observability-verification-2026-07-29.json`; decision:
  ADR 0044. A backend-neutral 13-rule policy now selects production-disabled queue,
  unresolved-exception, and active-sync failure/silence/age defaults against nine exact
  low-cardinality metric contracts. Threshold no-data is normal for the legitimately absent
  active-sync age, while three always-emitted monitor counters have explicit 20-minute absence
  alerts and evaluation errors alert. Static tests reject production enablement, dynamic labels,
  reducer/schema drift, short silence, non-monotonic escalation, and missing runbook anchors. No
  backend translation, protected alert injection, notification, on-call, dashboard, or owner
  approval is claimed. Evidence:
  `artifacts/production-disabled-operational-alert-policy-verification-2026-07-29.json`; decision:
  ADR 0050. Every Shopify/Stripe recovery page now requires a distributed Redis circuit scoped to
  environment/provider/tenant/connection. Atomic permit-bound state coordinates replicas, admits one
  half-open probe, ignores stale results, counts only rate-limit/timeout/unavailable failures, and
  fails closed before a provider request when circuit authority is unavailable. Durable retry honors
  bounded retry-after, and fixed provider-sync/circuit metrics exclude tenant and financial
  identifiers. Unit and authenticated local Redis 8.8.0 two-client evidence passes; managed Redis
  TLS/ACL/failover, multi-host partitions, mixed workers, provider traffic/limits, protected
  thresholds, dashboards, silence handling, and alerts remain open. Evidence:
  `artifacts/provider-request-circuit-verification-2026-07-29.json`; decision: ADR 0045. The
  tenant-authorized connector view now lists every fixed Shopify, Stripe, and accounting CSV source
  family as never observed or with independent latest source/receipt timestamps. Same-transaction
  tenant predicates/RLS and strict mapping reject foreign connections, incompatible/dynamic types,
  duplicates, and malformed times; browser runtime validation and copy refuse completeness claims.
  Migration 0048 adds the restart-safe concurrent tenant/connection access index. Unit/API/static
  and six focused Chromium tests pass; current PostgreSQL index/RLS and populated-upgrade execution
  pass. Representative timing, provider completeness, bounded legacy repair, and protected staging
  remain open. Evidence: `artifacts/tenant-source-object-watermarks-verification-2026-07-29.json`
  and `artifacts/postgresql-51-migration-integration-verification-2026-07-29.json`; decision:
  ADR 0046. The direct-topic premise in that accepted increment was subsequently found not to
  represent normal provider ingestion: source events preserve transport topics and a Shopify
  snapshot can classify to more than one family. ADR 0046 and its artifact remain immutable
  historical records, but the premise is withdrawn. ADR 0047 corrects the path forward with atomic
  versioned tenant-scoped source-event classification, a connection-wide
  `classification_unavailable` state for any legacy/old-writer gap, and migration 0049 with no
  unsound automatic backfill. That corrective increment intentionally left Stripe
  balance-transaction ingestion open. Focused classification/API/static and seven Chromium tests
  pass; current PostgreSQL execution verifies migration, forced RLS, restricted grants, atomic
  classification persistence, replay, and cross-tenant denial. ADR/migration 0051 now add the
  dedicated execute-only maintenance role and bounded exact-classifier repair. Local two-session
  PostgreSQL 17.10 evidence on the 53-migration chain verifies concurrent locked claims,
  immutable-object digest/size/deadline checks, atomic hash-chained audit, direct privilege denial,
  integrity rollback/retry, replay, and unsupported gaps that block completion. ADR/migration 0052
  now add disabled-by-default one-way activation serialized against shared in-flight source-writer
  transactions and a deferred exact-classification commit trigger. A fresh isolated database proves
  the synthetic old-writer race, zero-gap activation, missing/incompatible rollback, actual
  Shopify/CSV writers, privacy exemption, replay, restricted roles, and tenant isolation. The
  repository has no prior deployable image, so real mixed-image rollout, representative
  timing/storage, hosted PostgreSQL, and protected staging remain open. Evidence:
  `artifacts/source-object-classification-correction-verification-2026-07-29.json` and
  `artifacts/source-event-classification-repair-verification-2026-07-29.json`, extended by
  `artifacts/source-event-classification-writer-fence-verification-2026-07-29.json`; decisions: ADRs
  0047, 0051, and 0052. Stripe connector/normalizer 1.1.0 now adds a bounded second recovery phase
  for charge balance transactions, with one circuit permit per request, versioned/legacy-compatible
  cursors, minimized Charge reference evidence, integer minor-unit conservation, atomic source
  classification, replay-safe fee normalization, and explicit incomplete handling when no
  PaymentIntent exists. Focused connector/sync/ingestion tests pass; the current PostgreSQL
  application-role path verifies minimized fee persistence, classification, replay, and
  foreign-tenant denial. Permission review, authorized Stripe sandbox execution, async repair,
  mixed-worker rollout, interchange-plus exclusion, and protected staging remain open. Evidence:
  `artifacts/stripe-balance-transaction-recovery-verification-2026-07-29.json` and
  `artifacts/postgresql-51-migration-integration-verification-2026-07-29.json`; decision: ADR 0048.
  The complete browser suite records 43 Chromium tests, including authenticated organization
  selection, queue pagination, permanent-note, assignment, dual-control approval, original-proposer
  immutable proposal revision with approval reset, automatic-supersession history, exact-filter
  queue export, zero-byte download prevention, run-authority states, exact match/exception evidence,
  mobile containment, retention/legal-hold confirmation, bounded Shopify recovery, and 11
  accessibility scans. Engine `0.7.0` / rules `1.5.0` processed a correctness-checked 99,999-record
  synthetic complete dataset in 1,194.91 ms with 240,484,352 bytes RSS growth on Node 24.15.0,
  darwin-arm64. Its versioned collision evaluator fully scored and retained the strongest candidate
  at 500 eligible payments, then produced exact fail-closed ambiguity with no shortlist at 501 and
  10,000; reversed inputs replayed identically. Separate evaluators exercise all 19 canonical
  exception types; create evidence-backed accounting matches for either one unique row or one
  complete conserved positive 2–50-row strong-reference bucket; fail closed for mismatch, competing
  identities, non-positive rows, reuse, and overflow; detect seven unsafe identifier categories;
  quarantine a trimmed exact-link record with display-safe evidence; and accept visible Unicode.
  Fresh PostgreSQL 17.10 evidence persists the three-record split snapshot through the restricted
  worker, verifies replay and append-only behavior, and returns no rows under a foreign tenant. A
  mocked Chromium run detail renders the current split rule/reason and three-record cardinality
  without detected accessibility or mobile-overflow failures. These are local regression runs, not
  p95/SLO, staging-accuracy, source-data-prevalence, operator-outcome, or production-capacity
  results. Evidence: `artifacts/reconciliation-benchmark-engine-0.7.0-2026-07-29.json`,
  `artifacts/reconciliation-collision-evaluation-engine-0.7.0-2026-07-29.json`,
  `artifacts/reconciliation-malformed-identifier-evaluation-engine-0.7.0-2026-07-29.json`,
  `artifacts/reconciliation-taxonomy-accounting-evaluation-engine-0.7.0-2026-07-29.json`,
  `artifacts/reconciliation-split-accounting-verification-2026-07-29.json`,
  `artifacts/reconciliation-split-browser-verification-2026-07-29.json`,
  `artifacts/reconciliation-operator-evidence-verification-2026-07-29.json`, and
  `artifacts/reconciliation-continuous-split-journey-verification-2026-07-29.json`, plus
  `artifacts/local-verification-2026-07-27.md`, with structured selection evidence in
  `artifacts/organization-selection-verification-2026-07-27.json` and current pagination/search
  evidence in `artifacts/organization-directory-pagination-verification-2026-07-29.json`. Verified
  first-organization bootstrap evidence is in
  `artifacts/organization-bootstrap-verification-2026-07-29.json`, with current restricted-role and
  populated-upgrade execution in
  `artifacts/organization-bootstrap-postgresql-verification-2026-07-29.json` and real isolated
  Keycloak first-login/two-tab plus two-identity invitation/role/deactivation/relay execution in
  `artifacts/oidc-first-owner-bootstrap-verification-2026-07-29.json`. The second identity's
  independent organization, invitation into the first organization, two-option browser switcher,
  tenant-specific owner/auditor roles, tenant-scoped deactivation, unaffected owner access, and
  least-privilege reactivation are recorded in
  `artifacts/oidc-multi-organization-membership-verification-2026-07-30.json`. A separate fresh
  provider-authenticated scale composition gives one reviewer 101 active tenant-complete
  memberships, traverses exact 50/50/1 pages without duplicates, accumulates all 101 browser
  options, selects the final tenant, conceals a foreign identity both ways, and reflects
  deactivation/reactivation on the next request. Its fixture-only scope and exclusions are recorded
  in `artifacts/oidc-organization-directory-scale-verification-2026-07-30.json`. A bounded
  501-membership follow-up traverses all eleven pages, stops browser accumulation at 500, requires
  refinement, selects membership 501 through exact search, and repeats the denial/lifecycle
  assertions. Evidence:
  `artifacts/oidc-organization-directory-ceiling-verification-2026-07-30.json`. Current database and
  browser evidence for the accepted non-snapshot rename behavior, current exact lookup, immediate
  deactivation/reactivation, foreign concealment, tenantless RLS denial, and renamed-ID
  deduplication is recorded in
  `artifacts/organization-directory-concurrent-mutation-verification-2026-07-30.json`. Current
  product-route evidence for two simultaneous administrators, serialized membership changes,
  immediate exact-directory state, a linear three-event audit chain, corrective reactivation, and
  foreign-tenant concealment is recorded in
  `artifacts/membership-lifecycle-concurrent-api-verification-2026-07-30.json`. Current database and
  populated 0038-to-0039 evidence is recorded in
  `artifacts/postgresql-verification-2026-07-28.json`; the preceding 33-migration scope remains in
  `artifacts/postgresql-verification-2026-07-27.json`. Raw-evidence retention is recorded in
  `artifacts/retention-verification-2026-07-27.json`; provider sync is recorded in
  `artifacts/provider-sync-verification-2026-07-27.json`, with the Shopify extension recorded in
  `artifacts/shopify-sync-verification-2026-07-27.json` and periodic repair recorded in
  `artifacts/scheduled-provider-gap-repair-verification-2026-07-27.json`. Encrypted credential
  rotation/disconnect evidence is recorded in
  `artifacts/connector-credential-lifecycle-verification-2026-07-28.json`. Provider OAuth, refresh,
  Shopify uninstall, and Stripe signed-deauthorization evidence is recorded in
  `artifacts/provider-oauth-lifecycle-verification-2026-07-28.json`; its historical unavailable-
  runtime note is superseded by the current combined PostgreSQL artifact. Shopify privacy evidence
  is recorded in `artifacts/shopify-privacy-lifecycle-verification-2026-07-28.json`, with current
  database execution in the combined artifact. Audit topology and canonical-hash evidence is
  recorded separately in `artifacts/audit-chain-topology-verification-2026-07-28.json`, with its
  historical runtime gap likewise superseded. Distributed request-budget, proxy-trust, static-edge,
  and the earlier unavailable live Redis/Nginx result is recorded in
  `artifacts/distributed-rate-limit-verification-2026-07-28.json`. Its live Redis gap is superseded
  by `artifacts/redis-security-runtime-verification-2026-07-28.json`, which records authenticated
  Redis 8.2.8 queue, two-client 120/121 rate-budget, and two-store revocation/replay execution. The
  actual-process gap is narrowed by
  `artifacts/api-rate-limit-replica-recovery-verification-2026-07-29.json`, which records two
  compiled production API replicas, one shared budget, abrupt Redis loss, durable restart, and
  coordinated key rotation. The historical edge authority claim is superseded by
  `artifacts/live-edge-verification-2026-07-29.json`, which records the discovered unsafe append
  policy, corrected overwrite contract, canonical Nginx parse, two-upstream routing, spoof
  resistance, request ceiling, and bounded 100-request exercise. Deployed TLS/ingress and multi-host
  evidence remain open. Local production CSP discovery, strict style policy, nonce propagation, and
  browser evidence is recorded in `artifacts/web-csp-verification-2026-07-28.json`; deployed
  TLS-edge preservation remains part of staging evidence. Complete route-inventory, centralized
  authorization, and foreign-tenant concealment evidence is recorded in
  `artifacts/api-route-authorization-verification-2026-07-28.json`. A synthetic PostgreSQL 17.10
  logical backup/restore, exact metadata-only data/catalog/RLS/grant comparison, restored 34-test
  database suite, `pg_amcheck`, and offline checksum evidence is recorded in
  `artifacts/postgresql-logical-restore-verification-2026-07-28.json`. A separate component drill
  compared one complete tenant object history across two versioned MinIO processes and rebuilt one
  unpublished outbox event from a distinct exact PostgreSQL logical restore into initially empty
  authenticated Redis with one stable waiting job. Evidence:
  `artifacts/object-and-unpublished-queue-restore-verification-2026-07-28.json`. A later
  fresh-cluster exercise applied migration 0040, passed nine restricted PostgreSQL tests across the
  execution/recovery ledger and scheduled-writer opt-in, and rebuilt ten jobs spanning all four safe
  classifications into authenticated empty Redis. It excluded active/succeeded/dead/legacy work and
  rejected non-empty Redis plus a wrong restored-system identifier. Evidence:
  `artifacts/durable-queue-recovery-verification-2026-07-28.json`.

## Required before verification

- Complete operational rollback/restore evidence remains. The populated previous-release migration
  ledger advanced from 0038 to 0039 through the real runner, preserved all seeded
  organization/user/membership fields and a valid two-event legacy audit chain, labeled those audit
  rows as version 1 without changing their IDs/digests/predecessors, retained an existing
  member-requested provider run as user authority, and kept the previous tenant query compatible
  through `reconai_app`. The current 44-migration chain and all 54 integration tests across 19 files
  pass against fresh PostgreSQL/Redis/MinIO, including application-role bootstrap and audit writer
  concurrency, topology denials, OAuth/privacy repositories, connector credentials, provider
  sync/webhooks, CSV, retention, outbox, API repositories, reconciliation worker contracts, and the
  populated 0041-to-0043 upgrade. The prior database also passed a synthetic custom-format logical
  dump into a distinct data-checksummed PostgreSQL 17.10 cluster: all table/catalog/RLS/grant
  digests matched, the 34-test database suite passed on the restored copy, `pg_amcheck` completed,
  and offline checksums reported zero bad blocks. The component drills now prove bounded
  version/delete-marker comparison plus conservative unpublished/published in-flight classification,
  but not an atomic database/object/Redis recovery point. A populated pre-0033 and pre-0036 upgrade
  at representative volume, a prior application image, lock/scan timing, encrypted base-backup/WAL
  recovery, key/configuration recovery, staging cutover, and measured RPO/RTO remain unexercised.
- Protected multi-host back-channel revocation evidence. Signed logout validation, replay-safe
  HMAC-indexed cutoffs, and fail-closed NextAuth/server-page/BFF checks have synthetic coverage; a
  local authenticated Redis 8.2.8 exercise also passed two-store revocation, replay,
  pseudonymous-key, and TTL assertions. Signed Keycloak delivery to one actual Next.js process and
  replayed old-cookie denial pass. A separate fresh loopback exercise now runs two production-built
  Next.js replicas with shared authenticated persistent Redis and proves distinct same-subject `sid`
  isolation, targeted old-cookie denial on both replicas, unaffected-session admission,
  cross-replica replay, Redis `SIGKILL` fail-closed behavior with liveness independence, persistent
  recovery, and later login. Protected multi-host scheduling/partition, managed Redis, clock,
  coordinated session/provider-key rotation, external ingress/TLS, and alert delivery remain open.
  Bounded identity-provider refresh-token rotation keeps both identity credentials out of
  browser-readable session data, rotates a replacement refresh token when supplied, and fails closed
  without retry amplification. Real Keycloak 26.7.0 authorization-code/PKCE, isolated 65-second
  access-token/zero-reuse refresh-token rotation, and CSRF-safe provider logout exercises passed
  locally without credential disclosure; the current post-patch repeat also passes signed
  single-process Back-Channel Logout under fatal deprecation handling, and the next sign-in requires
  credentials rather than silently reusing SSO. Multi-organization selection has synthetic
  BFF/browser coverage, fresh application-role PostgreSQL proof, and an isolated
  Keycloak/browser/local-relay composition. The second verified identity creates an independent
  tenant, accepts an auditor invitation to the first tenant, sees exactly two authorized options,
  switches both ways, retains owner access in the independent tenant during invited-tenant
  deactivation, and regains only reviewer access after reactivation. Accepted and rejected delivery,
  revocation, replay denial, digest-only storage, two genesis events, and the invited tenant's
  ten-event canonical audit chain also pass. Separate 101- and 501-membership provider-authenticated
  directory exercises plus deterministic between-page rename/status mutation coverage pass. A fresh
  restricted-role PostgreSQL/Fastify run also serializes conflicting membership changes from two
  administrators through the product route, preserves one linear audit chain, re-resolves the exact
  directory, restores reviewer access, and denies a foreign administrator. A separate fresh
  PostgreSQL/Fastify/Chromium verifier now proves the strict versioned organization-name product
  route, one-winner/one-conflict concurrency, immediate directory refresh, same-name no-op, linear
  v2 audit, analyst/foreign denial, explicit confirmation, conflict reload, and accessibility.
  External federation, sustained or multi-host product-API administration, MFA/account recovery, and
  staging identity lifecycle evidence remain open. Evidence:
  `artifacts/organization-profile-concurrent-api-verification-2026-07-30.json`; decision: ADR 0061.
- Authorized Shopify/Stripe sandbox installation, refresh, uninstall/deauthorization, permission
  review, external callback/webhook routing, clock/alert exercises, Shopify privacy app-subscription
  delivery, secure merchant/customer data-package transfer, recipient acknowledgement,
  downloaded-copy expiry, over-limit handling, canonical/legacy disposition and independent-copy
  expiry, approved production secret-manager/KMS operations, repair cadence/ capacity/rate policy,
  and scheduler alert evidence. Authenticated webhook endpoints, tenant-bound encrypted OAuth
  credential generations, Shopify provider-first uninstall, signed Stripe App deauthorization,
  object storage, outbox relay, worker handlers, bounded Stripe Events/charge-balance plus Shopify
  order/refund snapshot recovery, and opt-in periodic repair tests now exist. No real provider
  request or credential was used.
- Approved production retention defaults and complete retention scope. Raw import/provider object
  execution now passes live PostgreSQL/MinIO and browser tests, but noncurrent object versions,
  caches/search/exports, replicas, backups, dead-letter alert exercise, other retention classes, and
  whole-tenant deletion remain unverified. Shopify redaction now has a separate bounded raw-object
  path, append-only deadline monitor, and minimized operator progress/escalation view with
  synthetic/static evidence only; neither closes those broader classes or proves external alert
  delivery, acknowledgement, or response.
- Authorized third-party email-relay and inbox evidence, including asynchronous bounce/complaint
  behavior. The authenticated no-redirect relay adapter, explicit disabled/accepted/failed states,
  token-free outcome audit, and one-time fallback link are implemented with synthetic
  provider/API/browser tests and an isolated runtime relay passed accepted/rejected request,
  correlation, fallback, audit, and token-placement assertions.
- Staging deployment, migration/rollback, complete backup/restore, load, freshness, protected
  collector/backend compatibility, telemetry access/retention, remaining signals, dashboards,
  multi-host managed Redis behavior, complete deployed trusted-proxy/edge enforcement,
  representative recovery/load, and alert evidence. Local application-image construction and one
  bounded runtime path now pass on rootless Linux ARM64: all three checked-in images build after the
  Git-free lifecycle correction; API/worker complete the deterministic eight-input tenant path as
  non-root, capability-dropped containers; and a fresh isolated run completes real Keycloak
  authorization code plus PKCE through the production web image over one-run TLS, Secure cookies,
  Redis revocation, explicit tenant selection, authenticated BFF run creation/detail, foreign-tenant
  denial, and tenantless RLS checks. The rerun also inspects explicit service credential
  projections: API receives only its application database role, worker only its worker role, and web
  no database/object/connector authority. A separate bounded verifier rebuilt API, worker, and web
  as native Linux ARM64 OCI candidates from the reviewed Node 24.18.0 digest, scanned extracted
  layouts with checksum-verified Trivy 0.72.0, generated hashed CycloneDX 1.7 summaries, and passed
  zero fixed High/zero fixed Critical for each image. The scanned IDs exactly match a fresh
  authenticated runtime rerun. This does not exercise Docker Engine, the hosted workflow's amd64
  BuildKit provenance/embedded SBOM/signed attestations, trusted external TLS/identity,
  prior/current rollout, or protected staging. Evidence:
  `artifacts/container-image-runtime-scan-bound-verification-2026-07-30.json` and
  `artifacts/local-native-oci-candidate-runtime-bound-verification-2026-07-30.json`; decisions: ADR
  0063 through ADR 0066. The local PostgreSQL logical-restore, OTLP loopback, two-production-API
  Redis loss/recovery/rotation, Nginx two-upstream, and application-image exercises do not satisfy
  the staging criterion.

Code presence alone is not completion evidence. Goal 1 remains active until each missing item above
has a dated, reviewable result.

The latest immutable requirement-level status matrix is recorded in
`docs/goals/goal-1-audit-2026-07-30-28.md`; earlier immutable audits remain linked above.
