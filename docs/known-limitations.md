# Known limitations

- No production or staging deployment exists; ReconAI is not production-ready.
- The checked-in cross-layer tenant manifest fails closed on current database, API/BFF, durable-job,
  object, Redis/BullMQ/map, export, telemetry, and restricted-support source drift. It is a bounded
  discovery and review control, not a language-level information-flow proof or deployed penetration
  test. Its new 43-table RLS/forced-RLS/policy catalog assertion awaits hosted execution; multi-host
  partitions, stale messages, cache loss/eviction, timing, representative scale, and independent
  adversarial review remain Goal 2 work. Evidence:
  `artifacts/cross-layer-tenant-surface-verification-2026-07-30.json`.
- One versioned mixed profile now reconciles exactly 100,000 synthetic records in five fresh local
  processes with stable identities/results and conserved integer money. Recorded pure-engine
  durations were 1,664.48–1,948.55 ms and maximum observed RSS was 521,650,176 bytes; see
  `artifacts/reconciliation-representative-load-post-lint-verification-2026-07-30.json`. Five
  samples do not establish a p95, the fixture is not a measured merchant distribution, and the
  result excludes API, PostgreSQL, outbox, Redis, worker persistence, browser/network latency,
  sustained concurrency, multi-host behavior, and protected staging.
- The production Next.js bundle now discovers its request proxy, returns a per-request nonce-bound
  script/style CSP, denies style attributes, and rendered the public page in local production
  Chromium with zero console errors. A separate application-image run completes authenticated pages
  with a production-configured web container, isolated Keycloak, one-run TLS, Secure cookies, and
  Redis revocation. These prove bounded application behavior only; trusted external TLS/identity,
  deployed edge/header preservation, managed Redis, and a deployed CSP report remain unverified.
- Docker is unavailable on the current workstation. Rootless Podman Compose now passes the
  digest-pinned local dependency network, current 56-migration runner, synthetic fixture load,
  host-run application readiness, real local OIDC/API/BFF/browser smoke, and clean shutdown; see
  `artifacts/local-podman-compose-quickstart-verification-2026-07-30.json`. A separate rootless
  Linux ARM64 exercise now builds all three checked-in application images after correcting two
  Git-free package-lifecycle failures. The non-root, capability-dropped image API/worker complete
  one eight-input deterministic tenant run. A fresh rerun also completes production web-image
  Keycloak authorization code plus PKCE over one-run TLS, explicit tenant selection, BFF run
  creation/detail, Secure HttpOnly cookies, foreign-tenant 404, and tenantless RLS zeros. It
  observes API with only its application database role, worker with only its worker role, and web
  without database/object/connector authority; see
  `artifacts/container-image-runtime-scan-bound-verification-2026-07-30.json`. A separate bounded
  verifier now builds native ARM64 OCI candidates, scans extracted layouts with checksum-verified
  Trivy 0.72.0, and hashes CycloneDX 1.7 summaries; all three report zero fixed High and zero fixed
  Critical findings and their IDs exactly match the runtime proof. See
  `artifacts/local-native-oci-candidate-runtime-bound-verification-2026-07-30.json`. This is not
  Docker Engine, the hosted amd64 candidate/attestation path, trusted external TLS/identity,
  prior/current rollout, fresh-clone, protected staging, or deployment evidence. An isolated
  data-checksummed PostgreSQL 17.10 source build previously applied the prior 55-migration chain,
  including the populated 0041-to-0054 upgrade. Dedicated suites cover bounded classification
  repair, the one-way writer fence, and restricted support access, including an in-flight old-writer
  race and actual current Shopify/CSV paths. This is local loopback evidence, not a real
  prior/current-image, hosted database, or protected-staging exercise; see
  `artifacts/source-event-classification-writer-fence-verification-2026-07-29.json`. An earlier
  isolated data-checksummed PostgreSQL 17.10 cluster, authenticated Redis 8.2.8, and pinned MinIO
  instance passed the latest combined-service 54-test integration baseline across 19 files. It
  included the then-current 44-migration chain, a populated 0041-to-0043 upgrade, and
  restricted-role organization bootstrap service execution. Isolated PostgreSQL 17.10 also verified
  the prior 40-migration chain from empty and 34 tests across all 11 then-current PostgreSQL-backed
  files, including OAuth/privacy/audit repository behavior and a populated 0038-to-0039 upgrade that
  preserved membership and legacy audit-chain evidence. The earlier 15-test integration command
  passed against live PostgreSQL, Redis, and MinIO. A checksum-verified Keycloak 26.7.0 host process
  completed a real browser login and browser-to-BFF-to-API-to-outbox-to-worker reconciliation smoke
  against those services. A Git-ignore-clean candidate-source export now passes its frozen install,
  Secretlint, production audit, full static verification/build, and Chromium suite without changing
  a publishable file; it remains a historical non-literal export because it predates the initial
  commit. A new literal remote-clone run remains pending. A current reusable verifier separately
  completed an eight-record Chromium/BFF/API/ outbox/Redis/restricted-worker journey against fresh
  local infrastructure and read four exact immutable occurrence snapshots, including a conserved
  two-row accounting split and one duplicate-fee exception; its identity authority was a minimal
  RS256/JWKS fixture, not Keycloak. A prior/current application-image runtime rollback, literal
  fresh-clone, operational cutover, and representative-volume migration timing remain unverified. A
  distinct data-checksummed PostgreSQL 17.10 cluster now has an exact synthetic logical-restore
  comparison plus passing restored database/RLS/audit/reconciliation tests, `pg_amcheck`, and
  offline checksum evidence. A separate local component drill matched two keys, three object
  versions, and one current delete marker across distinct versioned MinIO processes, then rebuilt
  one unpublished outbox event from a distinct exact logical PostgreSQL restore into an empty
  authenticated Redis 8.2.8 database. Migration 0040 and nine live restricted-role tests now add a
  token-digest execution/recovery ledger plus rolling-writer opt-in; a fresh-cluster drill rebuilt
  ten jobs across all four safe classifications and excluded active/succeeded/dead/legacy work. This
  does not verify encrypted base-backup/WAL recovery, an atomic database/object/Redis recovery
  point, object tags/lock/lifecycle/replication, key references, prior-image runtime compatibility,
  staging cutover, or RPO/RTO. Queue add and PostgreSQL evidence recording also remain a
  deliberately guarded cross-store, non-atomic operation.
- No provider credentials or sandboxes were used. Shopify/Stripe OAuth, refresh, uninstall, and
  signed-deauthorization behavior rely on synthetic provider responses until authorized sandbox
  verification.
- OIDC/JWT authorization, verified-email invitation acceptance, guarded membership deactivation, and
  the BFF session boundary exist; a live Keycloak authorization-code/PKCE login reached
  tenant-authorized data successfully. Bounded provider access-token refresh and zero-reuse
  refresh-token rotation passed against an isolated short-lifetime Keycloak realm without browser
  credential disclosure. A fresh post-patch repeat ran the actual web process under fatal Node
  deprecation handling and verified the authorization-code/S256-PKCE request, access and zero-reuse
  refresh-token rotation, CSRF-safe RP-initiated logout, local chunked-cookie cleanup, provider
  browser-session termination, and no silent SSO reuse. Multi-organization selection now has a
  subject-bound signed HttpOnly context, server-derived active-membership directory, synthetic
  browser/BFF/API negatives, and a fresh live PostgreSQL application-role proof for two memberships
  under one identity. Provider-initiated OIDC logout now has bounded signed-token validation,
  replay-safe HMAC-indexed `sid`/subject cutoffs, a production-required shared Redis index, and
  fail-closed checks across NextAuth, server pages, and every BFF cookie path. Exact signed Keycloak
  delivery now passes against one actual Next.js process: a distinct browser context replaying the
  pre-logout encrypted cookie received only a reauthentication requirement and no provider
  credential. A separate fresh loopback exercise now runs two production-built Next.js processes
  with one authenticated persistent Redis 8.2.8 authority. Two distinct same-subject sessions work
  through both replicas; signed `sid` logout revokes only the target; replay remains idempotent;
  Redis `SIGKILL` fails authenticated admission and logout closed without stopping anonymous
  liveness; persistent restart preserves the cutoff and restores unaffected/later sessions.
  Protected multi-host scheduling/partitions, managed Redis, external ingress/TLS, clock,
  coordinated session/provider-key rotation, and alert behavior remain unverified. A distinct
  two-identity Keycloak 26.7.0 browser exercise now creates an independent organization for the
  reviewer identity, accepts that identity's auditor invitation into the first organization,
  switches between the exact two authorized organizations, and proves tenant-specific owner/auditor
  roles. It also verifies subject-bound automatic selection, auditor denial, administrator
  promotion, invited-tenant-only deactivation with unaffected owner access, least-privilege reviewer
  reactivation, relay rejection/manual fallback, revocation, and accepted/revoked token replay
  denial. This remains isolated local identity evidence, not external federation, production IdP,
  MFA, recovery, TLS, or staging evidence. The replaceable authenticated HTTP invitation-email relay
  has synthetic coverage plus this isolated local accepted/rejected runtime proof; no authorized
  third-party relay, inbox delivery, asynchronous bounce, complaint, or provider availability
  evidence exists.
- The active-organization selector now provides bounded literal search and stable identity-derived
  keyset pages of at most 100 memberships, verifies selections outside the current page through an
  exact membership intersection, and bounds client accumulation at 500 before requiring a narrower
  search. In addition to static and synthetic database/API/BFF evidence, a fresh local
  Keycloak/PostgreSQL/browser run now gives one provider-authenticated reviewer 101 active
  tenant-complete memberships, traverses 50/50/1 pages without duplicates, accumulates all 101
  options, selects the last tenant, conceals a foreign identity in both directions, and immediately
  reflects deactivation/reactivation. A bounded 501-membership follow-up traverses all eleven pages,
  stops browser accumulation at 500 with refine-search guidance, reaches membership 501 through
  exact search, and repeats the denial and lifecycle assertions. Those rows are fixture-seeded
  directory evidence, not product tenant-creation/invitation evidence. A fresh PostgreSQL test now
  proves the accepted non-snapshot rename drift plus current exact lookup, immediate deactivation,
  reactivation, foreign concealment, and tenantless RLS denial; Chromium deduplicates a renamed ID
  repeated across pages. Those are deterministic fixture controls. A separate fresh
  PostgreSQL/Fastify run exercises two simultaneous administrators through the actual membership
  route and restricted repository, proves serialized previous/new state in one linear v2 audit
  chain, restores the reviewer through the route, and returns 404 without an audit append for a
  foreign administrator. A separate fresh PostgreSQL 17.10/Fastify exercise applies the current
  56-migration chain and proves the versioned organization-name product route: one accepted and one
  conflicting concurrent write, stale/no-op behavior, immediate directory refresh, linear v2 audit,
  analyst/foreign denial, and tenantless RLS concealment. Chromium separately passes confirmation,
  conflict reload, switcher refresh, and accessibility. Substantially larger representative
  directories, sustained concurrent administration, representative query timing, multi-host
  behavior, staging, and prior/new-image rolling deployment remain unverified. Business time zone
  remains read-only pending a separate financial-impact policy. Migration 0041 retains the prior
  two-argument function for compatibility; its later contraction is not yet scheduled. Evidence:
  `artifacts/organization-directory-concurrent-mutation-verification-2026-07-30.json` and
  `artifacts/membership-lifecycle-concurrent-api-verification-2026-07-30.json`, plus
  `artifacts/organization-profile-concurrent-api-verification-2026-07-30.json`.
- A provider-verified identity with no active membership can now create one first organization and
  fixed owner through a rate-bounded, exact-origin path. Server-generated authority identifiers,
  AI-disabled state, issuer/subject serialization, digest-bound append-only idempotency evidence,
  same-transaction first audit, and exact uncertain-retry behavior have static and synthetic
  database/service/API/BFF coverage. A local Chromium exercise with a synthetic signed session and
  mocked directory/bootstrap boundaries confirmed the empty-membership form, uncertain-status alert,
  locked name, and exact idempotency-key reuse; it is not end-to-end service evidence. A fresh
  PostgreSQL 17.10 exercise now covers migration 0042, actual restricted-role service execution,
  exact replay, two-transaction convergence, identity exclusion, atomic audit creation, and complete
  rollback on forced audit failure. A populated 0041-to-0043 upgrade also preserves existing
  tenant/audit/provider state and installs the boundary. A real isolated Keycloak 26.7.0
  authorization-code/PKCE exercise now covers first login from zero memberships, two same-session
  browser tabs racing different names with 201/409 convergence, one persisted owner tenant and
  canonical first audit, browser credential non-disclosure, and the distinct invited-identity
  lifecycle described above. External IdP federation, representative abuse/query behavior,
  prior/new-image rolling deployment, sustained or multi-host product-API administrative mutation,
  MFA/account recovery, one identity creating more than one organization through product flows, and
  invitation-driven high-membership behavior remain unverified. Organization-name mutation has the
  separate local evidence described above. The separate 101- and 501-membership scale runs prove the
  live directory with tenant-complete seeded fixtures only. Later-organization creation is
  intentionally unavailable until entitlement, limits, billing, and abuse policy are designed.
  Evidence: `artifacts/organization-bootstrap-postgresql-verification-2026-07-29.json` and
  `artifacts/oidc-first-owner-bootstrap-verification-2026-07-29.json`, plus
  `artifacts/oidc-organization-directory-scale-verification-2026-07-30.json` and
  `artifacts/oidc-organization-directory-ceiling-verification-2026-07-30.json`.
- Provider webhook endpoints, exact signature verification, immutable object receipts, transactional
  outbox relay, and idempotent normalization workers are implemented with synthetic tests. Shopify
  mandatory privacy topics use a fixed app-level endpoint, exact app-secret HMAC before parsing,
  post-authentication shop-to-tenant resolution, email/phone-minimized request evidence, and
  database-authorized raw-object deletion jobs/tombstones serialized with legal hold. An
  owner/administrator-only operator view exposes minimized deadlines and aggregate raw-deletion
  states with synthetic tenant/BFF/browser/accessibility coverage. A default-enabled bounded worker
  monitor creates append-only seven-day, 24-hour, and overdue signals with same-transaction audit
  evidence and aggregate-only logs. A dual-authorized, reasoned customer-data action now prepares a
  complete-or-fail, checksum-verified package of at most 100/five-MiB linked Shopify/Stripe evidence
  records, with fixed download headers and metadata-only `not_delivered` audit evidence. Shared
  accounting CSV objects are excluded. These privacy migrations, repositories, and workers have
  static/synthetic coverage plus current live PostgreSQL repository execution; provider
  subscription, external alert delivery, and merchant package delivery remain unverified. Bounded
  Stripe Events and Shopify order/refund snapshot pagination plus operator-requested backfill/gap
  repair now have origin/window/page/item/byte/timeout/cursor controls, distinct read credentials,
  immutable run authority, and synthetic adapter/service/API/BFF/browser plus live PostgreSQL
  evidence. Shopify additionally enforces a canonical shop domain, pinned response-verified API
  version, bounded GraphQL cost/error handling, and complete bounded refund transactions. Stripe's
  Events history is limited to 30 days; Shopify history remains limited by app authorization and
  provider account rules. An opt-in periodic scheduler now creates bounded repair runs through a
  fixed service identity, immutable outbox authority, deterministic cadence idempotency, and
  tenant/concurrency checks; it remains disabled pending approved production cadence, provider
  capacity, rate, and alert evidence. Disabled-by- default Shopify/Stripe OAuth installation and
  locked refresh generations are implemented with fixed callbacks, bounded exchanges, encrypted
  account/scope/mode/generation metadata, and synthetic replay/race/error tests. Shopify disconnect
  is provider-first. Stripe disconnect stops reads immediately and remains action-required until the
  exact signed app-deauthorization event matches account, live/test mode, and current authorization
  generation. Production app configuration, provider sandboxes, external webhook routing,
  clock/alert exercises, distributed provider rate coordination, an approved secret-manager/KMS
  operating model, Shopify app-subscription delivery, secure merchant/customer data-package
  transfer, recipient identity verification/acknowledgement, downloaded-copy expiry, an over-limit
  export path, legal review, legacy/canonical disposition, noncurrent object versions,
  cache/search/export/replica/backup handling, and whole-tenant deletion remain.
- Provider refresh occurs before its database rotation commits. A provider-success/local-commit
  failure can orphan a newly rotated refresh token and requires reauthorization rather than
  automatic retry. Shopify uninstall can similarly succeed before local cleanup; provider authority
  is removed, but an unusable encrypted local token may require reasoned operator cleanup. Stripe
  requires the user to uninstall the app in its settings, so disconnect completion depends on
  signed-event delivery and synchronized clocks.
- Accounting CSV upload/preview/commit and administrator rollback-by-supersession are implemented
  with synthetic service/API/browser tests and a passing live PostgreSQL contract. The isolated
  S3-compatible immutable-object contract passed, and the live fixture path stored, committed, and
  displayed a MinIO-backed accounting import. Disabled-by-default per-organization raw
  import/provider retention now has legal hold, exact confirmation, audit, terminal eligibility,
  checksum/ETag-bound conditional deletion, bounded retry/dead-letter state, and immutable
  tombstones with live PostgreSQL/MinIO and browser evidence. Approved production defaults,
  noncurrent object-version lifecycle, cache/search/export expiry, backup expiry, dead-letter
  alerting, and whole-tenant deletion remain unverified.
- The operator interface demonstrates dashboard, queue, source-record evidence, proposal,
  one/two-reviewer approval states, tenant-authorized connector health, guarded membership editing,
  an accessible multi-organization switcher, append-only notes, assignment/defer/reopen controls,
  stable server-side exception pagination with exact filters, bounded organization audit history, a
  bounded chronological exception timeline, and tenant-authorized reconciliation run
  list/detail/start/recovery-replay controls. Verified-email invitation
  creation/revocation/acceptance and the full exception note/workflow/dual-control journey have
  synthetic authenticated browser coverage; invitation and membership-role controls additionally
  have the isolated two-identity runtime evidence described above. The run ledger exposes the single
  current queue authority, and automatic supersession appears in immutable investigation history.
  The connector surface also exposes read-enabled Stripe and Shopify accounts, bounded recovery
  confirmation, OAuth authorization, provider-aware disconnect state, and immutable sync run
  progress without exposing credential references. The security surface exposes
  owner/administrator-only Shopify privacy deadlines and aggregate raw-object deletion progress
  without customer/order identifiers or storage authority, and now shows the highest durable
  deadline escalation. For data requests it provides an explicit-confirmation evidence-package
  download with digest-only, ten-minute, same-membership authenticated-browser receipt before
  download. That receipt is not fulfillment, completion, external alert delivery/acknowledgement,
  merchant/customer delivery, recipient verification, or downloaded-copy expiry. A tenant-authorized
  rules surface manages bounded dual-approval currency thresholds and sensitive resolution types
  with explicit confirmation, reason, and audit. A permission-gated, exact-filter queue CSV export
  is bounded to 10,000 rows and 5 MiB, formula-safe, fixed-name, metadata-audited, and covered by
  synthetic API/BFF/browser checks. PostgreSQL, Redis, object storage, live OIDC, tenant-authorized
  connector/import reads, and one browser-requested deterministic run have local runtime evidence;
  containerized topology remains unverified.
- Reconciliation run detail initially exposes at most ten match and ten exception observations from
  immutable `artifact-occurrence-v1` snapshots. Occurrences created by older workers during the 0043
  rolling window have no reconstructable exact snapshot and are deliberately labeled
  `legacy_current_projection`; they are not backfilled or presented as historical proof. Truncated
  previews can be expanded through tenant/run/type-bound keyset pages; the API allows at most 100,
  the BFF requests 25, and each response remains capped at five MiB. Current local evidence
  traverses only 12 synthetic match artifacts and one exception. It does not establish
  representative high-volume page latency, concurrent active-run behavior, TLS, container,
  multi-host, staging, alert, or operator-outcome behavior. The isolated continuous journey covers
  eight synthetic records and three matches plus one exception, not those operational dimensions.
- Reconciliation run detail initially exposes 100 pinned input record/version/content-hash
  references. Tenant/run-bound ordinal pages can load the remainder in 100-row API/BFF pages.
  Current fresh-PostgreSQL and Chromium evidence covers 102 synthetic inputs with continuous
  ordinals, duplicate-free loading, cursor replay denial, and foreign-tenant concealment. It does
  not represent production data or connect the mocked browser pages to that PostgreSQL fixture. A
  separate fresh PostgreSQL 17.10 verifier now traverses the configured 100,000-input maximum with
  100-row and 97-row concurrent readers both in-process and in two independent restricted-role
  processes. All four traversals reach ordinal 99,999 with the same complete identity digest; the
  run also uses the ordinal index, rejects cross-run cursor replay, and exposes zero rows to a
  foreign tenant. The same-process 431.68/442.47 ms and independent-process 330.44/338.38 ms
  single-workstation observations are not an SLO, capacity guarantee, or production projection.
  Representative data, multi-host concurrency, network partitions, protected staging, TLS/ingress,
  and operator behavior remain unverified.
- Reconciliation run creation now inserts its immutable input ledger in 1,000-row statements inside
  the existing atomic run/input/outbox/audit transaction. A fresh PostgreSQL 17.10 verifier created
  one queued 100,000-input run through the actual restricted-role repository, logged exactly 100
  input statements, retained ordinals 0–99,999, returned the same authority on repeat, concealed it
  from a foreign tenant, and passed offline checksums. The synthetic seed omitted field-provenance
  rows and customer references, and the run remained queued. Its 2,694.99 ms direct repository call
  and 105,627,648-byte RSS-growth observation are not an HTTP/API SLO, end-to-end job-completion
  result, constant-memory claim, production-data result, representative concurrency/load result, or
  staging-capacity projection. Worker execution, field provenance, multi-host contention, timeout
  behavior, protected staging, TLS/ingress, and alert evidence remain open. A later fresh-database
  negative injected a rejection at ordinal 1,000 after the first batch statement and proved zero
  run/input/outbox/audit rows after rollback, followed by successful recovery of the identical
  100,000-input snapshot. Another fresh maximum-volume run delayed that second batch and separately
  applied the new bounded authority deadline and a direct repository client signal. Both attempts
  left zero authority rows and ordinary PostgreSQL cancellation logs, then the snapshot recovered
  completely and repeated idempotently. The direct signal does not emulate a real proxy/socket
  disconnect. Pool admission is not cancellable in postgres.js, but ADR 0034 now lets the repository
  settle its fixed error at the signal deadline while continuing to observe the guarded queued
  operation. A fresh two-connection saturation run returned after 5,002.55 ms with both holders
  still occupied, then released capacity and proved the expired operation drained with zero
  authority. ADR 0035 now adds a fail-fast 1–10 per-process cap, default two, whose leases follow
  the hidden database promises. A fresh repeat admitted two blocked requests, rejected 32 excess
  attempts in 0.28 ms without database admission, rejected again after both public deadlines, and
  drained both hidden operations with zero authority. This is bounded single-process burst evidence,
  not sustained multi-replica pressure, throughput, fairness, or capacity proof. Client/proxy loss,
  cross-host failure, representative load, end-to-end API latency, and protected staging remain
  unverified. A separate fresh verifier killed the actual direct creator process during the delayed
  second batch. PostgreSQL logged an unexpected EOF with an open transaction and retained zero
  authority rows; retry created one complete 100,000-input authority. It then observed two direct
  creator backends concurrently, including one advisory-lock waiter, before both returned the same
  independently keyed run with exactly one complete ledger/outbox/audit authority. Offline checksums
  were clean. This closes one bounded single-host process-loss and contention exercise, not real
  proxy loss, supervisor recovery, multi-host partitions, or a guarantee that every lost client
  rolls back; a full commit before loss detection remains valid. Evidence:
  `artifacts/reconciliation-run-creation-interruption-verification-2026-07-29.json` and
  `artifacts/reconciliation-run-creation-process-loss-contention-verification-2026-07-29.json`. Pool
  evidence: `artifacts/reconciliation-run-creation-pool-saturation-verification-2026-07-29.json`.
  Bounded admission evidence:
  `artifacts/reconciliation-run-creation-admission-pressure-verification-2026-07-29.json`. The two
  unavailable outcomes now have a fixed-vocabulary aggregate OTLP counter, with local protobuf/API
  contract evidence in
  `artifacts/reconciliation-run-creation-unavailability-observability-verification-2026-07-29.json`.
  No external collector, dashboard, alert, or representative rate/capacity result was exercised.
- Audit writes now select the tenant topological head and migration 0039 defines one-genesis,
  unique-child, tenant-self-FK, hash-format, version, and same-lock insert controls with canonical
  version-2 digests. Existing version-1 rows are not rewritten and arbitrary legacy caller object
  order may not be recomputable. Local PostgreSQL verifies empty and populated migration execution,
  application-role concurrency, multi-row-cycle denial, and exact synthetic logical restoration;
  representative-volume preflight/index timing, base-backup/WAL recovery, atomic object/database
  consistency, atomic Redis/PostgreSQL recovery, staging cutover, and external integrity anchoring
  remain without evidence.
- Local synthetic engine 0.7.0 measurements exist for one 99,999-record exact-match dataset, all 19
  canonical exception types, unique/multiple/reused/500/501 one-row refund-accounting candidates,
  conserved positive 2-row splits, split mismatch, 50/51 split overflow, 500/501/10,000-way payment
  collisions, and seven unsafe-identifier categories plus one visible-Unicode case. A fresh loopback
  PostgreSQL 17.10 cluster applied all 44 migrations and proved restricted-worker persistence of a
  three-record `refund-accounting-split` occurrence snapshot, replay idempotency, append-only
  enforcement, and foreign-tenant RLS denial; the general tenant integration file also passed 11
  tests on that cluster. Historical rule 1.4 persistence evidence is retained separately. The
  browser and BFF suites still use mocked upstreams for broad UI coverage; their current run-detail
  fixture renders the exact split rule/reason and three-record cardinality without detected
  accessibility or mobile-overflow failures. The separate continuous local verifier now traverses
  one live host-process outbox/queue case with the same two-row split and verifies its three record
  references in Chromium, the API read model, and the immutable PostgreSQL snapshot. These are local
  synthetic regression results. Rule 1.5 deliberately does not aggregate order-reference-only,
  mixed-reference, zero/negative, or more-than-50-row groups and never chooses a subset. No
  representative malformed-source/accounting distribution, split-shape prevalence,
  production/staging load distribution, concurrency, availability, freshness, accuracy, time-saving,
  complete restore, alert, operator-outcome, or AI-agreement metric has been achieved.
- API and worker processes now initialize an explicit OTLP/HTTP protobuf pipeline with fixed
  resources, bounded W3C API parent extraction, trace-correlated logs, and low-cardinality API/job
  result and duration metrics. Aggregate reconciliation result/duration and outbox
  published/retried/dead-lettered signals and fixed-reason run-creation unavailability are also
  emitted without tenant identifiers. A loopback capture proves the local exporter contract only.
  Reconciliation, signature-verified webhook, tenant-authorized CSV-commit, and user-requested
  provider-sync envelopes now carry a locally sampled, versioned trace parent across the outbox
  after exact worker authority verification. Provider-sync child event jobs continue from the active
  authorized worker span. Legacy envelopes and scheduled sync requests remain roots. A leased,
  constant-size queue monitor now emits seven fixed state gauges and a bounded ready-head age from
  real BullMQ structures; its authenticated local Redis/OTLP proof does not establish multi-host
  lease transfer, partitions, sustained backlog cost, thresholds, silence handling, or alert
  delivery. Four fixed provider-signature surfaces now emit response-derived ingress outcomes, and
  post-authority provider webhook work emits fixed normalization results and duration without
  tenant, event, receipt, object, job, credential, payload, or error attributes. Local OTLP bytes
  prove the closed vocabularies and dynamic-value suppression only; they do not establish provider
  delivery behavior, connector freshness, thresholds, dashboards, alerts, or operator response.
  Newly processed events also emit at-most-once fixed freshness classifications and a source-lag
  histogram only within an inclusive 30-day bound. That event distribution does not detect a silent
  connector, prove current provider watermarks/completeness, or guarantee telemetry delivery after
  database completion. The opt-in gap-repair scheduler now emits success/failure heartbeats,
  identifier-free due-candidate classifications, and a last-successful-sync-age histogram within an
  inclusive 365-day bound by reusing its existing maximum-100 candidate scan. This can expose
  never-succeeded or overdue scheduled-sync candidates, but it is not a total connection gauge,
  excludes queued/running work, and does not prove per-object provider watermarks, completeness,
  active-sync progress, recovery success, or enabled/deployed alerting. A separate lease-owned
  observer now emits the oldest queued/running age and state for each fixed provider through a
  worker-only two-provider database function and concurrent partial index. Followers are read-free,
  and incomplete/future/failed/expired observations clear both providers rather than publishing a
  partial or healthy snapshot. Static migration, repository, worker, and loopback OTLP tests pass,
  and migrations 0046/0047 executed successfully in the then-current 55-migration PostgreSQL chain.
  This does not add a protected multi-worker observer exercise. The gauges do not count active
  syncs, show page progress, identify a tenant/connection, prove provider
  delivery/completeness/recovery, or establish a protected threshold, silence rule, dashboard, or
  alert. Every provider recovery page now requires a Redis-backed circuit scoped to
  environment/provider/tenant/connection, with atomic permit tokens, one half-open probe,
  transient-only failure counting, immediate bounded rate-limit opening, fail-closed store errors,
  and retry-after-aware durable delay. Provider-sync attempt outcomes and circuit
  decisions/transitions use fixed telemetry only. An authenticated loopback Redis 8.8.0 run with two
  independent clients proves open/denial/isolation/half-open/reopen/close/rate-limit/TTL/key
  behavior on one host. It does not exercise a managed Redis topology, TLS/ACLs, multi-host
  partitions, mixed worker images, provider traffic, contract-specific rate limits, thresholds,
  dashboards, silence behavior, or alert delivery. Circuits are connection scoped rather than a
  global provider/account capacity budget, and prior workers bypass them until drained. The original
  tenant-authorized connector watermark increment incorrectly treated provider transport topics as
  product-facing families. ADR 0046 and its artifact remain immutable historical evidence, but that
  direct-topic premise is withdrawn by ADR 0047. New provider/CSV intake writes a separate immutable
  source-event classification atomically; the reader joins it and exposes any operational receipt
  without classification as connection-wide `classification_unavailable`, never partial freshness or
  false absence. Migration 0049 adds forced-RLS, tenant-composite, append-only classification
  storage without automatic legacy backfill. Migration 0048 remains only a raw topic/time access
  path. Current live PostgreSQL 17.10 evidence covers both migrations, forced RLS, restricted
  grants, atomic classification persistence, replay, tenant isolation, and the populated
  previous-release upgrade. Migration 0051 now provides execute-only, dedicated-role repair of
  allowlisted legacy rows using locked claims, immutable-object digest/size/deadline verification,
  the exact classifier, receipt rechecks, and atomic hash-chained audit. Synthetic live PostgreSQL
  covers concurrent claims, missing/corrupt/timeout/unsupported rollback, retry, replay, direct
  privilege denial, and zero-gap behavior. Migration 0052 adds opt-in one-way activation serialized
  against in-flight source transactions and a deferred exact-classification commit fence. Local
  evidence proves synthetic old-writer rejection and actual current provider/CSV compatibility, but
  the repository has no prior deployable image. Real mixed-image rollout, representative
  repair/query/write/activation timing, storage/WAL/replica growth, tenant timing, hosted
  PostgreSQL, and protected staging remain unverified. Stripe connector/normalizer 1.1.0 now defines
  bounded charge balance-transaction recovery and minimized fee normalization, and the
  application-role PostgreSQL persistence/replay/tenant path passes. No authorized Stripe sandbox
  run was performed. Exact `balance_transaction_source_read` manifest review, implied permissions,
  direct/destination-charge behavior, async availability, periodic-repair convergence, fee-detail
  variants, 403/rate-limit behavior, mixed-worker rollout, protected staging, and alerts remain
  unverified. Interchange-plus fee retrieval is unsupported. Independent observed maxima can come
  from different events and do not prove normalization, retained raw payload, provider pagination,
  completeness, availability, recovery, settlement finality, or reconciliation. Committed proposal
  decisions now emit fixed timing classifications and a proposal-age histogram only within an
  inclusive 365-day bound, with first-stage, final, and rejected decision status but no tenant,
  reviewer, proposal, exception, reason, severity, or money dimensions. That distribution is
  at-most-once and can be lost after commit; it does not measure the current exception queue or
  operator outcomes. Threshold-crossing approvals additionally emit a bounded
  exception-creation-to-approved final-resolution age with only a fixed timing outcome. Pending
  approvals and rejections emit no final sample, while reobservable automated supersession is
  deliberately excluded. The final-resolution distribution is also at-most-once and does not
  establish backlog completeness, reviewer productivity, a protected threshold, or alert delivery. A
  lease-owned worker observer now adds attribute-free environment-wide unresolved-presence and
  oldest-age gauges from a fixed, worker-only, one-row database function.
  Invalid/future/failed/expired observations remove the process snapshot; followers do not query the
  database. Static migration, repository, worker, and loopback OTLP tests pass, and migrations
  0044/0045 executed successfully in the then-current 55-migration PostgreSQL chain. This does not
  add a protected multi-worker observer exercise. The gauges do not identify a tenant, count
  exceptions, describe severity, or prove a threshold, dashboard, silence rule, or alert delivery.
  Several planned business signals remain absent, and no protected collector/backend,
  retention/access policy, representative multi-process trace, load, outage, termination, dashboard,
  or alert path has staging evidence.
- Raw-object retention has no default by design; customer/legal approval is still required before a
  production duration is selected. Tolerance, delayed-event, high-value, other retention classes,
  and data-residency defaults also require validation.
- Restricted support diagnostics are now default-disabled and locally prove separate OIDC/MFA
  identity, organization-unbound request plus owner approval, 5–60 minute exact grants, forced
  RLS/function-only access, capped aggregate output, expiry/revocation, tenant isolation, and
  hash-chained audit. A local organization-blind support console and separate tenant-owner Security
  surface now prove fixed BFF paths, memory-only request-code handling, explicit
  approval/revocation, aggregate-only rendering, uniform denial, and accessibility in Chromium. A
  fresh isolated Keycloak 26.7.0 run additionally proves the native LoA 2 password-plus-TOTP flow,
  wrong-code denial before an application session, exact group/`acr` authorization, valid-MFA
  non-group denial, and the complete product journey against a fresh PostgreSQL 17.10 database. This
  remains a loopback exercise, not a deployed support program: protected IdP policy governance,
  recovery/admin-bypass resistance, ticket-system validation, customer notification,
  clipboard/endpoint-control exercise, multi-replica key consistency, offboarding, periodic access
  review, incident drill, and staging timing remain absent. The ticket reference is
  operator-supplied, the 12-hex identity reference is display-only, expired unclaimed request-row
  retention has no approved purge policy, and HMAC-key rotation requires a maximum-lifetime drain.
- AI production use is disabled pending a dataset and evaluation evidence.
- The working name has material collisions and is not approved for publication.
- Apache-2.0 is the default owner-requested license but must be owner-confirmed before public
  release and before external contributions are accepted.
- Production now rejects process-local API limiting and requires a shared Redis budget, stable
  pseudonymization key, and explicit trusted-proxy CIDRs. Synthetic two-instance, spoofing,
  fail-closed, liveness, and static reference-edge checks pass. An authenticated loopback Redis
  8.2.8 run passed two-client 120/121 sharing, pseudonymous-key, and TTL assertions. A later
  isolated run starts two compiled production API processes with one authenticated persistent Redis
  authority: both receive the shared load, request 121 returns 429, forged forwarding prefixes
  create no parallel key, abrupt Redis loss makes admission fail closed while liveness remains 200,
  persistent restart retains the exhausted budget, and a full drain/restart rotates both replicas to
  one new HMAC budget. A security review found that the original public-edge
  `$proxy_add_x_forwarded_for` policy could preserve an attacker-selected limiter identity; the
  config and validator now require `$remote_addr` overwrite. A local Nginx 1.30.4 run parsed the
  canonical policy, routed across two Fastify upstreams, discarded forged forwarding identities,
  enforced the body ceiling, and rejected 59 of 100 concurrent requests without sending rejections
  upstream. A fresh exact-source run also parsed the new query-free JSON access log, accepted a
  synthetic callback-shaped `code`/`state` request, and recorded thirteen bounded entries without
  either query value. These are single-host loopback controls only; external
  load-balancer/CDN/hosting logs, deployed TLS/ingress behavior, collector access/retention,
  multi-host scheduling/load/partitions, managed failover, and alert behavior have no staging
  evidence.
- API readiness now checks PostgreSQL, Redis, and the private object bucket concurrently within a
  bounded, single-flight/cached probe; public failure is opaque and liveness stays process-only.
  Synthetic timeout/recovery tests and a real API process with all dependencies absent pass. A
  checksum-pinned local run also proved independent PostgreSQL, Redis, and object-storage transport
  failure/recovery across two live API replicas, with liveness preserved and fixed redacted
  transitions. Dependency process crashes, cross-host partitioning, S3 least-privilege policy,
  multi-replica scheduler behavior, and readiness alerts have no staging evidence.
- The Dockerfile frontend and current Dockerfile/Compose/CI container inputs are immutable-digest
  pinned and statically enforced. A manual main-only workflow can build, scan, checksum, SBOM, and
  GitHub-attest non-publishing `linux/amd64` OCI candidates without registry/deployment authority. A
  rootless native Linux ARM64 verifier now passes exact-image OCI export, Trivy 0.72.0 fixed
  High/Critical gates, CycloneDX generation, bounded hashing, and cleanup for API, worker, and web.
  Docker and a remote remain unavailable, so no hosted amd64 candidate, embedded BuildKit
  attestation, signed bundle, GitHub identity verification, multi-platform artifact, published
  registry digest, or deployment admission result has executed.
- The exact NextAuth v4 transitive `openid-client@5.7.1` is now lock-bound to a reviewed patch that
  removes every legacy `url.parse()` call; the OIDC validator passes under
  `NODE_OPTIONS=--throw-deprecation`, and configured issuers reject noncanonical spellings. This is
  a locally maintained compatibility bridge, not an upstream release or post-patch real Keycloak
  result. A stable replacement must preserve authorization-code PKCE/state, bounded encrypted
  sessions, provider-token refresh rotation, RP/back-channel logout, distributed revocation, and the
  BFF/API boundary before the patch is removed.
- Ambiguous payment candidate evaluation fully scores at most 500 amount-window candidates and
  returns at most five. A larger set fails closed as `ambiguous_identity` with exact counts and no
  shortlist. Representative collision distributions, operator workflow, alerts, and a complete
  indexed top-k design above the boundary remain unevaluated.
- See `docs/security-review.md` for prioritized findings and mitigations.
