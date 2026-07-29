# Security review

Review date: 2026-07-30  
Scope: repository source, manifests/lockfile, workflows, Dockerfiles, migrations, API, worker,
Next.js BFF/session boundary, connector parsers, reconciliation engine, and security/operations
documentation.  
Result: no open Critical or High finding in the reviewed source. Three Medium and one Low finding
remain. This is a pre-release source review, not a penetration test or production certification.

## Evidence and limitations

Executed locally during this work: exact locked install; formatting; strict lint/typecheck; 634
unit/property/tenant/reconciliation tests in 91 files; 45 Chromium tests, including 14 accessibility
scans; a separate local production Chromium CSP render with zero console errors; production build;
schema/config/edge/dependency/migration validators; prior Drizzle no-drift generation through the
snapshot-managed schema chain; static custom-migration/schema alignment for the current
classification, privacy-package receipt, and restricted-support tables/functions; OIDC/Keycloak
security configuration validation including the default-disabled exact group/MFA/keyed-identity
support boundary and the lock-bound `openid-client@5.7.1` WHATWG URL patch under
`NODE_OPTIONS=--throw-deprecation`; container-input/release-candidate policy validation;
production-disabled operational-alert policy validation against nine fixed metric contracts;
dependency audit; Secretlint; offline lockfile-bound validation of 224 production and cross-platform
optional package licenses; and CycloneDX SBOM generation. The dependency audit reported no known
vulnerability. The latest source migration set contains 56 files and validates to SHA-256
`4c05eb0dc3685fcf04cdd9f236b7632e6263a8e097196bc6ca8849bfa04e1f96`. A focused fresh PostgreSQL 17.10
database applies the complete 56-migration chain and passes the organization-profile
Fastify/restricted-role concurrency test. The prior complete fresh data-checksummed database applied
the 55-migration chain and passed all 39 tests across the 11 database integration files through
separate administrator, migrator, application, worker, and maintenance roles. This includes a
populated 0041-to-0054 upgrade and live classification, Stripe balance-transaction,
privacy-package-receipt, bounded classification-repair, and restricted-support
request/owner-approval/diagnostics/revocation paths. The dedicated repair suite adds two live tests,
and the isolated writer-fence suite adds one. Evidence:
`artifacts/restricted-support-access-verification-2026-07-29.json` and
`artifacts/source-event-classification-writer-fence-verification-2026-07-29.json`. The latest
combined service integration baseline remains a fresh data-checksummed PostgreSQL 17.10 cluster,
authenticated Redis 8.2.8, and pinned MinIO instance passing all 54 integration tests across 19
files on the 44-migration chain. This includes restricted-role migration 0042 service
creation/replay/concurrency/audit rollback and a populated 0041-to-0043 upgrade; the
organization-directory/bootstrap evidence is no longer static-only. Earlier combined PostgreSQL
evidence below remains useful historical coverage for the prior 40-migration graph.

The documentation evidence boundary is now Git-visible, size/name/link/redaction validated, and
limited to reviewed synthetic/local records; prior personal home-directory prefixes were redacted
before initial publication. The clean-source audit also found and corrected an unanchored `exports/`
ignore rule that had hidden both financial export BFF routes and their six tests from a candidate
commit; a seven-root source validator now prevents that class of omission. A temporary
Git-ignore-clean candidate-source export completed its frozen install, Secretlint, high-severity
production audit, full static verification/build, and Chromium suite without modifying or creating a
publishable file. Evidence: `artifacts/clean-source-export-verification-2026-07-29.json`; decision:
ADR 0055. The historical artifact predates the initial commit, so a new literal remote-clone
verification remains pending. It is not staging or production evidence. A separate rootless Podman
Compose quick start now exercises the digest-pinned development dependency network, current
migrations/fixtures, host applications, and real local OIDC/API/BFF/browser smoke; it does not
replace that revision-bound proof. Evidence:
`artifacts/local-podman-compose-quickstart-verification-2026-07-30.json`; decision: ADR 0062.

A separate isolated Keycloak 26.7.0/PostgreSQL 17.10/Chromium verifier now covers two provider-
verified identities and two organizations. It proves the first-owner 201/409 race, the second
identity's independent first organization, relay-accepted invitation delivery and acceptance into
the first organization, an exact two-option browser switcher, tenant-specific owner/auditor roles,
automatic subject-bound selection, auditor denial, administrator promotion, tenant-scoped
deactivation with unaffected independent-owner access, reviewer reactivation with member-directory
denial, relay rejection/manual fallback, revocation, accepted/revoked token replay denial,
digest-only token storage, and canonical version-2 audit evidence. The local authenticated relay is
not third-party inbox, bounce, complaint, or production-provider evidence.

An isolated PostgreSQL 17.10 instance applied all 40 migrations from empty, and all 11
PostgreSQL-backed files passed 34 tests through administrator, migration, application, and worker
roles. Coverage includes repository, worker execution, CSV, provider receipt, outbox, tenant/RLS,
multi-organization, bounded provider-sync authority/cursors/retries, system-authorized scheduled
repair/replay/concurrency, raw-object retention/legal hold/deletion, OAuth/privacy lifecycles,
audit-chain concurrency/topology denials, and a populated 0038-to-0039 upgrade. Both provider files
also passed a same-database 7-test repeat. A separate fresh PostgreSQL 17.10 database applied the
then-current 43 migrations and passed the three-test restricted-worker reconciliation execution
file. Its rule 1.4 case persisted exact refund/accounting and duplicate-processing-fee evidence,
retained stable per-run occurrences on replay, and returned zero run/artifact/occurrence rows under
a foreign organization RLS context. A current fresh PostgreSQL 17.10 cluster applied all 44
migrations and sequentially passed the two-test populated upgrade file, three-test restricted-worker
snapshot file, and four-test API repository file. That proof covers exact immutable snapshots,
replay equality, worker update denial, rolling-window legacy projection, a 12-to-10 bounded preview,
and foreign-tenant zero-row results. Separate API tenant, BFF, and browser tests cover
server-authorized tenant selection, a five-MiB response ceiling, accessible evidence rendering, and
mobile containment. A checked-in continuous verifier then traversed that chain against an isolated
44-migration PostgreSQL 17.10 database, Redis 8.2.8, and the pinned MinIO release: Chromium
submitted the run through an encrypted session and same-origin BFF; the API verified a local
RS256/JWKS token and returned `202`; the outbox published; BullMQ and the restricted worker
completed attempt one; and the browser read three exact matches and one exact duplicate-fee
exception from four immutable occurrence snapshots. The current eight-record fixture makes the third
match a conserved two-row accounting split and verifies its three record references in the
browser/API read model and PostgreSQL snapshot. A direct foreign-tenant request returned `404`. This
is local host-process evidence with a minimal test JWKS authority, not Keycloak, containers, TLS,
staging, or production. The current pinned MinIO release also passed checksum/ETag-bound conditional
deletion, integrity failure, confirmed absence, and idempotent-missing behavior. An earlier
28-migration snapshot passed the then-complete 15-test integration command in eight files against
live PostgreSQL 16.14, Redis 8.2.1, and the repository's pinned MinIO release. A separate same-stack
smoke loaded fixtures through live PostgreSQL/Redis/MinIO, authenticated a real browser against
Keycloak 26.7.0, loaded tenant-authorized BFF/API data, and completed one browser-requested
reconciliation through the transactional outbox and worker. Docker remains unavailable, and
application container images were previously unexecuted. Rootless Podman now builds all three
checked-in images on Linux ARM64 and composes one non-root, capability-dropped API/worker
deterministic run. A fresh isolated rerun additionally completes real Keycloak authorization code
plus PKCE through the production web image over one-run TLS, Secure HttpOnly cookies, Redis
revocation, explicit tenant selection, the BFF, API/outbox, and worker. It proves the minimized
browser session and BFF response, foreign-tenant 404, tenantless RLS zeros, and exact
three-match/one-exception persistence. The build exposed and corrected two Git-free
package-lifecycle failures; exact command scoping is now policy-tested. Earlier harness attempts
also exposed an overbroad environment projection, an invalid HTTP issuer, a local-only OIDC secret,
and an omitted production tenant selection. Service-specific parsers and live-container inspection
now prove API receives only its application database role, worker only its worker role, and web no
database/object/connector authority. A separate bounded native ARM64 candidate run then exported and
validated each OCI archive, passed checksum-verified Trivy 0.72.0 at zero fixed High/zero fixed
Critical, and generated hashed CycloneDX 1.7 summaries. These results are not Docker, the hosted
amd64 BuildKit/provenance/attestation path, trusted external TLS/identity, complete backup/restore,
hosted CI, protected staging, or deployment proof. Remote image inputs are immutable-digest pinned
and the non-publishing candidate workflow is statically validated. The hosted baseline Security
workflow passed; CI failed on the configuration/test drift described below, and the candidate
workflow failed parsing before job creation. No successful hosted candidate run exists. Separately,
Redis 8.2.8 was built from the official source archive after its SHA-256 matched Redis's published
hash. An authenticated, protected-mode, loopback-only server passed four queue,
distributed-rate-limit, and distributed-session-revocation tests across three files; the test
namespaces were removed and the database was empty afterward. This host-process result does not
execute the pinned OCI image or Compose network.

A separate authenticated loopback Redis 8.8.0 process with two independent clients passed the
provider-circuit integration file. It proved cross-client opening/denial, tenant/connection
isolation, a single half-open probe, probe-busy denial, reopening, successful close, immediate
rate-limit opening, bounded retry-after, positive TTL, pseudonymous key shape, and cleanup. The
binary came from an existing local development cache and its exact SHA-256 is recorded; this is not
official-download verification, managed Redis, TLS/ACL, multi-host, partition, provider, staging, or
production evidence.

Migrations 0033–0038 and the provider OAuth/privacy lifecycle have static migration/role checks plus
synthetic unit, tenant, API, BFF, callback, refresh, uninstall, signed-deauthorization,
privacy-request, minimized operator-read, deadline-threshold/monitor, browser/accessibility, and
raw-object deletion coverage. The current complete 54-test integration graph exercises these
repositories through application and worker roles on the 44-migration chain; a populated
0041-to-0043 upgrade also passes. Earlier isolated PostgreSQL 17.10 evidence applied the prior 40
migrations from empty and passed 34 tests across all 11 then-current database-backed files,
including a populated 0038-to-0039 audit-chain upgrade. No real Shopify/Stripe credential or
provider request was used, and representative-volume migration timing, prior-image rollback, and
complete backup restore remain staging requirements. A separate local PostgreSQL logical-dump
component drill restored the synthetic 40-migration database into a distinct data-checksummed
PostgreSQL 17.10 cluster. Metadata- only SHA-256 comparison matched all 34 tables/55 rows and
catalog/RLS/grant surfaces; all 11 database-backed files then passed 34 tests on the restored copy,
`pg_amcheck` completed, and offline checksum scans found zero bad checksums. A second local
component drill used distinct versioned MinIO processes to match a complete tenant history
containing three object versions and a current delete marker. It also restored a PostgreSQL dump
containing one unpublished outbox event to a distinct checksummed cluster and rebuilt exactly one
stable waiting job in an initially empty authenticated Redis 8.2.8 database. Atomic database/object
recovery, the published- but-unprocessed queue boundary, object tags/lock/lifecycle/replication,
encryption/key custody, base backup/WAL recovery, representative volume, prior-image compatibility,
and staging cutover remained unverified in that drill.

Migration 0040 now adds a nullable explicit-writer tracking marker, token-digest execution leases
with heartbeat/terminal immutability, and append-only classified-recovery evidence. Nine live
restricted-role tests on a fresh checksummed PostgreSQL 17.10 cluster cover execution lifecycle,
forged-tenant/application-role denial, all-four-class recovery, conservative exclusions, and
scheduled-writer rollout opt-in. The guarded command rebuilt ten stable waiting jobs into an
initially empty authenticated Redis 8.2.8 database, retained ten under duplicate replay, and
rejected non-empty Redis plus a wrong restored-system identifier. The exercise does not establish an
atomic database/object/Redis recovery point, migration timing, prior-image runtime compatibility,
production-like restored data, staging cutover, alerts, RPO, or RTO.

The cross-layer tenant audit now has a fail-closed exact manifest rather than relying on scattered
prose counts. Independent discovery currently reconciles 43 executable schema tables and their
enabled/forced-RLS migration authority, 55 Fastify contracts, 13 Next.js API/BFF routes, four
tenant-bound job discriminators, three object-key builders and nine verified object operations, 19
Redis/BullMQ/in-memory state source files, two exports, and 39 evidence references. New or stale
surfaces, missing evidence, missing forced RLS, tenant telemetry identifiers, and support enablement
drift fail the ordinary verification path. Tenant object keys now parse branded organization IDs and
every bounded segment. The unused stable tenant-telemetry pseudonym helper was removed.

The first hosted baseline run replaces the prior absence of remote evidence. Security passed; CI
completed 63 integration tests before exposing a missing maintenance-role integration URL and a
previous-release assertion that stopped before migration 0055. The manually dispatched candidate
workflow also failed parsing because a job-level expression used the unavailable `runner` context.
All three source defects are corrected in the tenant-hardening branch and guarded by policy tests,
but remain open evidence until the hosted PR rerun passes. The new all-table PostgreSQL catalog
assertion could not run in the current desktop shell because no container/Compose provider or local
PostgreSQL binary is available.

## Open findings

### SEC-M-002 — Provider lifecycle lacks sandbox and production-operations evidence

- Rule ID: SECRETS-CONNECTOR-001
- Severity: Medium
- Location: `packages/database/src/provider-authorization.ts`;
  `packages/database/src/provider-deauthorization.ts`; `packages/database/src/provider-privacy.ts`;
  `packages/database/src/provider-privacy-deletion.ts`;
  `packages/database/src/provider-privacy-operations.ts`;
  `packages/connector-shopify/src/authorization.ts`;
  `packages/connector-stripe/src/authorization.ts`; `apps/api/src/provider-disconnect.ts`;
  `packages/ingestion/src/provider-privacy.ts`
- Evidence: connections keep webhook-signing and read API authority distinct. Operator-installed
  secrets are sealed locally with AES-256-GCM and authenticated
  tenant/connection/provider/purpose/key-version context; raw credentials do not enter the browser
  or JSON API. Forced-RLS append-only lifecycle rows, one-active-version constraints, retired
  envelope replay rejection, server-only resolution, versioned key rotation, redacted metadata, and
  exact-confirmation ReconAI-side disconnect are implemented. OAuth adds digest-only, tenant-bound,
  single-claim state; fixed callbacks/provider origins; bounded code exchange and refresh; encrypted
  provider token bundles; account/scope/mode drift rejection; atomic refresh generations; Shopify
  provider-first uninstall; and exact-raw-body Stripe App deauthorization with generation/mode
  binding, append-only evidence, and tenant-scoped finalization. Legacy allowlisted
  `env:RECONAI_CONNECTOR_*` references remain supported. Shopify privacy requests now use a fixed
  app-level exact-HMAC endpoint, post-authentication canonical-shop tenant resolution, minimized
  append-only evidence, legal-hold-serialized checksum-bound raw-object deletion, bounded retry, and
  immutable tombstones. A `retention:manage`-gated operator read establishes RLS tenant context and
  returns only deadlines plus aggregate deletion states; API allowlisting and negative tenant/role
  tests prevent customer/order/event/digest/object-key fields from crossing the boundary. A
  separately confirmed action additionally requires `data:export` and a reason before assembling a
  complete-or-fail, checksum-verified package of linked Shopify/Stripe evidence. Its
  100-record/one-MiB-object/five-MiB contract excludes shared CSV and internal storage authority,
  validates the buffered BFF response, and writes metadata-only `not_delivered` audit evidence. A
  random 256-bit receipt token is digest-only at rest, expires after ten minutes, and is bound to
  the exact tenant/request/package/same active membership. The browser acknowledges complete bytes
  before download through a fixed database function; one append-only receipt/audit event is
  idempotent and still states `not_delivered`. An approved production secret-manager/KMS operating
  model, populated pre-0033/pre-0036 upgrade timing, provider sandbox/subscription execution,
  external alert exercises, secure merchant/customer transfer and recipient acknowledgement,
  downloaded-copy expiry, over-limit export, canonical privacy disposition, and
  backup/noncurrent-version expiry remain absent.
- Impact: provider API/permission drift, routing or clock errors, untested provider responses, and
  ambiguous provider-success/local-commit failures could leave a connection action-required or an
  unusable encrypted credential needing manual recovery.
- Fix: execute both provider authorization/refresh/disconnect flows in authorized sandboxes, repeat
  populated upgrades at representative volume in protected staging, approve key-custody/rotation and
  scope procedures, configure NTP and alerting, exercise ambiguous refresh and uninstall recovery,
  and complete the remaining privacy inventory/delivery/disposition work before production
  enablement.
- Mitigation: sealed envelopes fail authentication when moved across authority context; missing,
  retired, mismatched, or disconnected references fail closed. Provider sync still requires a
  separate read authority, explicit tenant/window/page authority, and a fixed/validated provider
  origin. Stripe disconnect clears the read reference before provider confirmation. Automatic repair
  remains disabled by default and excludes action-required/disconnected connections.
- False positive notes: synthetic tests establish code behavior but cannot prove current provider
  contracts, app configuration, external routing, or production key operations.

### SEC-M-003 — Distributed abuse controls lack live deployment enforcement evidence

- Rule ID: DOS-RATE-001
- Severity: Medium
- Status: local two-production-API Redis loss/recovery/rotation passed; protected deployment open
- Location: `apps/api/src/rate-limit.ts`; `apps/api/src/readiness.ts`; `apps/api/src/main.ts`;
  `packages/config/src/index.ts`; `infra/nginx/reconai.conf`; `scripts/validate-edge-security.mjs`;
  `scripts/verify-live-edge.mjs`; `artifacts/live-edge-verification-2026-07-29.json`;
  `artifacts/edge-access-log-redaction-verification-2026-07-29.json`;
  `scripts/verify-live-api-readiness.mjs`; `artifacts/api-readiness-verification-2026-07-28.json`;
  `scripts/verify-live-api-rate-limit.mjs`;
  `artifacts/api-rate-limit-replica-recovery-verification-2026-07-29.json`;
  `docs/adr/0018-distributed-api-rate-limit-and-proxy-trust.md`;
  `docs/adr/0023-bounded-composite-api-readiness.md`;
  `docs/adr/0060-query-free-structured-edge-access-logs.md`
- Evidence: production configuration now rejects a local store, a missing HMAC key, or an empty/
  malformed/global proxy allowlist. API replicas use one dedicated, bounded Redis limiter and
  environment-scoped HMAC address keys; raw addresses, authorization values, organization IDs, and
  tenant data do not enter keys. Store errors prevent route execution, exceeded requests return a
  safe correlated 429, and process liveness is independent. Synthetic tests share an exact 120/121
  budget across two Fastify instances, distinguish trusted/untrusted forwarding chains, exercise
  store failure and liveness, and statically validate outer Nginx limits plus the BFF/API routing
  split. Required API dependencies now execute behind a bounded single-flight/cached readiness probe
  with process-only liveness, opaque public failures, and fixed transition diagnostics. Synthetic
  checks cover false/throw/timeout/recovery/concurrency; a real API process with all three
  dependencies absent returned liveness 200 and readiness 503. A separate checksum-pinned live
  exercise ran two API replicas against PostgreSQL 17.10, Redis 8.2.8, and MinIO; independently
  severing each dependency transport made both replicas return opaque readiness 503 while liveness
  stayed 200, and both recovered to readiness 200 after the exact path returned. Each replica logged
  only the named unavailable check across the seven expected transitions, without raw errors,
  endpoints, or credentials. The two-client integration passed against authenticated loopback Redis
  8.2.8: exactly 120 requests were admitted across separate Fastify/Redis clients, the 121st
  returned 429, the single stored key was an environment-scoped 64-hex HMAC rather than a raw
  address, and it had a positive TTL. Test cleanup left the Redis database empty. A later edge
  review found that the original public policy used `$proxy_add_x_forwarded_for`; that preserved a
  caller-selected prefix and could let a client influence Fastify's proxy-resolved limiter address.
  The edge now derives address, host, and protocol forwarding metadata itself, removes `Forwarded`,
  and rejects either copied or appended client forwarding chains. A local Nginx 1.30.4 exercise
  parsed the canonical policy and sent traffic across two Fastify upstreams. The spoof probe
  resolved only `127.0.0.1`; 100 distinct forged forwarding identities shared one outer burst, with
  41 admitted and 59 edge 429s; rejected requests did not reach either upstream; and a 12 MiB plus
  one-byte body returned 413 before upstream. Browser `/api/*` remained on the web boundary, direct
  `/v1/*` reached both Fastify replicas, security headers covered 200/413/429 responses, and the
  Nginx version was hidden. A later review found that the implicit default combined access log would
  retain callback query credentials through `$request`. The edge now selects a fixed JSON allowlist
  with normalized query-free `$uri` and no referrer, cookie, authorization, user-agent, or arbitrary
  request string. Static negative self-tests reject query-bearing and combined formats. A fresh
  exact Nginx 1.30.4 run parsed thirteen JSON entries and omitted both `code` and `state` from a
  synthetic callback-shaped request while repeating the existing routing, spoof, ceiling, and rate
  controls. A later isolated run starts two compiled API processes with production configuration
  against one authenticated persistent Redis 8.2.8 authority behind a forwarding-overwrite proxy.
  Exactly 120 requests are admitted across both processes and request 121 returns the fixed 429; one
  expected HMAC key has a positive TTL and no forged or resolved raw address. Redis `SIGKILL` makes
  both limited requests return the fixed opaque 500 before authentication while liveness
  remains 200. The persistent restart retains the exhausted budget, a second address recovers
  through both replicas, and a full old-replica drain followed by one new shared key again produces
  one cross-replica 120/121 budget. Old HMAC keys remain only for their bounded TTL. Child output
  and every credential, raw address/header/key, authorization value, and correlation ID are
  excluded. These are single-host loopback exercises, not staging.
- Impact: an incorrect production proxy allowlist, mixed HMAC keys, unavailable Redis, or an edge
  policy not actually loaded can deny legitimate traffic or restore parallel/bypassable budgets. The
  code and reference policy do not prove hosting-provider, network, load, or alert behavior.
- Fix: repeat the now-live local edge and shared-budget proofs in a multi-replica staging topology;
  test the exact TLS/ingress/load-balancer forwarding chain, approved direct-peer CIDRs, 120/121
  boundaries, sensitive endpoints, managed Redis failure/failover, coordinated key rotation,
  realistic burst/load behavior, alert delivery, and readiness polling through the actual scheduler/
  load balancer. Repeat dependency process loss and cross-host partition recovery in that topology
  before closing.
- Mitigation: production fails configuration/startup closed, later store errors fail request
  admission closed, explicit CIDR trust ignores client-selected forwarding prefixes, the edge
  retains an independent connected-peer budget, access logs use an explicit query-free JSON
  allowlist, and strict input/query bounds remain.
- False positive notes: the synthetic paths and local live Redis/readiness/Nginx/actual-API proofs
  establish application/store coordination, forwarding-header overwrite, reference routing,
  production-mode process behavior, one process crash/restart, and coordinated local key rotation.
  They do not establish the deployed TLS/ingress chain, multi-host scheduler topology, managed
  failover, capacity, logging/collector policy, or alert delivery. A hosting platform may enforce
  equivalent outer and query-redaction controls only after its exact configuration and observed
  behavior are recorded.

### SEC-M-004 — Release integrity lacks hosted and deployment evidence

- Rule ID: SUPPLY-CONTAINER-001
- Severity: Medium
- Location: application Dockerfiles; `compose.yaml`; `.github/workflows/ci.yml`;
  `.github/workflows/release-candidate.yml`; `scripts/validate-container-integrity.mjs`
- Evidence: the Dockerfile frontend and all current remote Dockerfile, Compose, workflow-service,
  and workflow-command images now retain exact tags plus reviewed multi-platform manifest-list
  digests. The Redis service is pinned to security-maintained `8.2.8-alpine` at the reviewed
  multi-platform digest, and the validator rejects floating Redis tags or versions below 8.2.8.
  Application stages now use the reviewed Node 24.18.0 Active LTS digest and remove npm/Corepack
  from the final runtime filesystem. `pnpm container:check` also enforces full action SHAs, the
  immutable Trivy action v0.36.0 commit and explicit Trivy 0.72.0 in both ordinary container CI and
  the extracted-OCI candidate path. Ordinary quality/browser CI uses exact Node 24.18.0 and now runs
  the mixed 100,000-record correctness verifier without a host-dependent timing gate. The candidate
  workflow remains main-only and manually confirmed; it exports local OCI archives with BuildKit
  maximum provenance/SBOM, gates High/Critical vulnerabilities, creates CycloneDX/checksums, and
  generates GitHub OIDC/Sigstore provenance and SBOM attestations. A bounded rootless native Linux
  ARM64 verifier rebuilt all three applications, exported and validated OCI archives, and used
  checksum-verified Trivy 0.72.0 plus a fresh database. API, worker, and web each passed with zero
  fixed High and zero fixed Critical findings, generated hashed CycloneDX 1.7 summaries, and exactly
  matched the IDs in a fresh authenticated runtime proof. Evidence:
  `artifacts/local-native-oci-candidate-runtime-bound-verification-2026-07-30.json` and
  `artifacts/container-image-runtime-scan-bound-verification-2026-07-30.json`.
- Impact: source-level tag drift is prevented, but a broken hosted builder/workflow or future
  registry/deployment path could still substitute or accept an unverified image. Operators cannot
  yet verify a published or deployed artifact because none exists.
- Fix: run the candidate workflow in an eligible authorized repository; verify all checksums,
  attestations, identities, commits, embedded provenance/SBOM, and scan results; then, only after
  owner publication approval, bind image-level attestations to the published registry digest and
  enforce signer/workflow identity plus digest verification before deployment.
- Mitigation: package installs are exact/frozen, actions and container inputs are immutable-pinned,
  runtimes are non-root and omit build-only package managers, the local and hosted candidate paths
  grant no publication/deployment authority, and no artifact is currently published.
- False positive notes: native ARM64 OCI scan/SBOM evidence and source controls are implemented, but
  they are not hosted amd64 provenance, GitHub/Sigstore identity, registry-digest, or
  artifact-admission evidence. GitHub attestation availability also depends on repository
  visibility/plan.

### SEC-L-002 — Provider-initiated revocation needs live topology evidence

- Rule ID: SESSION-LIFECYCLE-001
- Severity: Low
- Status: local two-replica Keycloak/Redis loss-and-recovery passed; protected topology open
- Location: `apps/web/src/auth.ts`; `apps/web/src/oidc-session.ts`;
  `apps/web/src/session-revocation.ts`; `apps/web/src/oidc-backchannel-logout.ts`;
  `apps/web/src/server-session.ts`; `apps/web/src/app/api/auth/backchannel-logout/route.ts`
- Evidence: encrypted HttpOnly JWT sessions are capped at eight hours. Bounded issuer-specific
  access-token refresh and refresh-token rotation are implemented, with expired credentials removed
  on failure and only a reauthentication boolean exposed to browser session data. A live Keycloak
  26.7.0 authorization-code/S256-PKCE login and a short-lifetime, zero-reuse refresh-token rotation
  completed successfully without browser credential disclosure. The current post-patch repeat ran
  the patched web process under fatal Node deprecation handling. CSRF-safe RP-initiated logout
  cleared every local session-cookie chunk and ended the Keycloak browser session; a repeat sign-in
  showed the provider login form rather than silent SSO reuse. Keycloak also delivered a signed OIDC
  Back-Channel Logout token to one actual Next.js process. Replaying the pre-logout encrypted cookie
  from a distinct browser context required reauthentication and disclosed no provider credential.
  The receiver pins issuer/audience/asymmetric-algorithm/JWKS verification; five-minute age and
  one-minute skew bounds; required event/`jti`/`sid`-or-`sub` and prohibited `nonce` checks;
  idempotent replay; and an atomic Redis cutoff/replay index. Provider identifiers are HMAC-indexed
  rather than stored raw. NextAuth, server pages, and every BFF cookie decoder check the same index
  and fail closed on missing identity, cutoff, or store failure. Synthetic tests cover signature
  claims, stale/nonce/type/event/locator failures, `sid` versus `sub` scope, later login, replay,
  bounded fixed JWKS retrieval, and dependency failure. An authenticated loopback Redis 8.2.8
  exercise passed cross-client revocation and replay: a logout written through one store was
  observed through another, a different `sid` remained valid, replay was idempotent, only two
  HMAC-indexed keys existed, both had positive TTLs, and no raw subject, session ID, or JWT ID
  appeared in a key. A fresh separate exercise now runs two production-built Next.js processes
  against one authenticated persistent Redis 8.2.8 authority. Two distinct same-subject sessions
  work through both replicas; a signed Keycloak `sid` logout delivered to one replica revokes only
  the targeted old cookie through both; the different `sid` remains valid; replay through the other
  replica remains successful without divergent state; and the two expected pseudonymous keys retain
  positive TTLs. After a forced snapshot and Redis `SIGKILL`, both replicas fail authenticated
  admission closed while anonymous liveness remains `200`, and a valid replayed logout returns
  `400`. Persistent Redis restart restores the cutoff/replay marker, the targeted cookie remains
  rejected on both replicas, the unaffected session recovers, and a later login works through both.
  Evidence: `artifacts/oidc-distributed-revocation-recovery-verification-2026-07-29.json`.
- Impact: incorrect Keycloak client registration, signing-algorithm drift, clock skew, divergent
  session secrets/namespaces, or unavailable Redis can deny authenticated traffic or leave a failed
  provider logout requiring retry. Source behavior alone does not prove IdP delivery, horizontal
  consistency, recovery, rotation, or alerting.
- Fix: register the exact HTTPS endpoint on an authorized protected-staging Keycloak client with
  session-scoped logout, then repeat account/admin logout across independently scheduled hosts and a
  managed Redis path; exercise partitions/failover, clock boundaries, coordinated session and
  provider-signing-key rotation, external ingress, and alert delivery before closing.
- Mitigation: provider access and refresh tokens never enter browser-readable session data; refresh
  uses a fixed issuer-derived endpoint, five-second timeout, disabled redirects, a 64 KiB response
  ceiling, strict response schema, rotation support, and no retry amplification after terminal
  failure. RP logout requires a signed double-submit token and exact canonical Origin, accepts no
  client-selected redirect, uses the validated fixed issuer, and returns no-store/no-referrer.
  Production rejects a process-local revocation store; Redis requests use bounded deadlines, one
  retry, no offline queue, and fail-closed authenticated admission. Cookies are Secure in
  production/HttpOnly/SameSite=Lax, and the API independently verifies issuer, audience, algorithm,
  and a 15-minute maximum token age.
- False positive notes: source, synthetic cryptography, one-process, two-client, and actual
  two-production-built-replica Redis loss/recovery evidence pass locally. Single-host loopback
  processes and verifier-owned TLS/relay are not evidence that protected multi-host scheduling,
  managed Redis, external ingress, clocks, coordinated rotation, or alerts are configured correctly.

## Remediated during this review

- EDGE-LOG-QUERY-001: the reference Nginx edge previously relied on its implicit default combined
  access log, whose `$request` field includes callback queries. No deployed exposure is claimed, but
  the source could have retained OIDC/provider authorization codes and state values. ADR 0060 now
  selects an `escape=json` allowlist containing only timestamp, generated request ID, connected
  address, method, query-free normalized path, protocol, status, response bytes, and duration.
  `pnpm edge:check` rejects request/query/referrer/cookie/authorization variables and combined logs,
  including negative self-tests. An exact Nginx 1.30.4 run parsed the canonical policy and thirteen
  bounded JSON entries; a synthetic callback-shaped request recorded only `/api/edge-probe` and
  neither query value. External TLS ingress, load-balancer/CDN/hosting logs, collectors, retention,
  and access policy remain open under SEC-M-003. Evidence:
  `artifacts/edge-access-log-redaction-verification-2026-07-29.json`; decision: ADR 0060; threat:
  TM-50.
- SEC-L-003 / SUPPLY-AUTH-URL-001: the exact `openid-client@5.7.1` transitive now has a
  pnpm/lockfile-bound patch replacing every `url.parse()` call in issuer discovery, relative
  callback parsing, end-session URL generation, WebFinger, and the optional Passport strategy with
  WHATWG `URL`. Existing query parsing/default precedence remains intact. `OIDC_ISSUER` additionally
  rejects credentials, query data, fragments, non-HTTP(S) schemes, backslash or dot-segment
  spellings, and doubled trailing slashes instead of silently normalizing them. `pnpm oidc:check`
  validates the patch mapping and SHA-256, scans the installed runtime, executes discovery/callback/
  logout/Passport behavior, and verifies Keycloak PKCE/state; it passes with
  `NODE_OPTIONS=--throw-deprecation`. Thirty-one focused issuer/refresh/logout/revocation tests
  pass. This closes the deprecated-parser source/runtime finding locally without replacing session
  authority. A fresh isolated Keycloak 26.7.0 browser exercise now passes authorization-code/S256
  PKCE, access and refresh-token rotation, RP logout, signed single-process Back-Channel Logout,
  old-cookie denial, repeat login, and credential nondisclosure against the patched web process
  under fatal deprecation handling. The patch remains a maintenance bridge; multi-replica,
  protected-staging, and stable upstream replacement evidence remain open. Evidence:
  `artifacts/oidc-url-parser-patch-verification-2026-07-29.json` and
  `artifacts/post-patch-oidc-lifecycle-verification-2026-07-29.json`; decision: ADR 0059; threats:
  TM-09 and TM-49.
- REVIEW-PROPOSAL-REVISION-001: implemented the PRD's proposal-edit action as immutable replacement.
  Only the original proposer can revise the tenant-scoped exception while exactly one proposal is
  pending. The transaction supersedes the old version, inserts a new ID/version with current
  approval policy, preserves old approvals as append-only history, and records exact
  `resolution.revised` before/after evidence. Approval and revision now lock the exception authority
  row in the same order; a fresh checksum-enabled PostgreSQL 17.10 race proves that no old approval
  attaches to or counts for the replacement. The API denies another review-capable actor uniformly,
  the BFF exposes only `canRevise`, and the browser requires confirmation before replacement.
  Focused API/BFF and Chromium tests cover the authorized and denied paths. This adds no autonomous
  financial action, source-system write, currency conversion, AI authority, or migration. Protected
  multi-replica timing remains open. Evidence:
  `artifacts/resolution-proposal-revision-verification-2026-07-29.json`; decision: ADR 0056; threat:
  TM-46.
- BFF-INVITATION-SUCCESS-BOUNDARY-001: successful invitation acceptance no longer uses the unbounded
  convenience JSON reader before issuing organization context. The BFF now reads at most 64 KiB by
  declared and streamed size, decodes fatal UTF-8, requires exact `201`, and validates the existing
  strict minimal invitation/membership response before setting the subject-bound cookie. Oversized,
  invalidly encoded, malformed, expanded, rejected, or status-drifted responses receive no
  organization context. The fixed upstream path retains an eight-second timeout, explicitly omits
  ambient credentials, and rejects redirects; route-specific failures remain behind the strict
  shared error parser. Negative tests cover declared oversize and invalid UTF-8 in addition to
  malformed authority, rejection, CSRF, identity/session, token, and fetch-containment cases. This
  closes the local denial-of-service/contract gap without changing membership authority, invitation
  semantics, tenant selection, database state, or provider permissions. Protected runtime
  memory/stream interruption exercises remain open. Evidence:
  `artifacts/invitation-acceptance-response-boundary-verification-2026-07-29.json`; threat: TM-45.
- BFF-RESTRICTED-SUPPORT-RESPONSE-001: the organization-blind restricted-support BFF no longer
  accepts arbitrary 2xx success or preserves arbitrary upstream failure statuses. Request creation
  requires exact `201`; diagnostics require exact `200`; both already strict aggregate-only
  responses remain under a 64 KiB ceiling and now use fatal UTF-8. Failures accept only
  `AUTHENTICATION_REQUIRED`/`401`, `RESOURCE_NOT_FOUND`/`404`, or `RATE_LIMITED`/`429` through the
  shared strict error parser with fixed browser messages. Expanded errors and status/schema drift
  become a private generic `502`. Upstream requests explicitly omit ambient credentials and reject
  redirects. Negative tests cover expanded support-identity diagnostics, mismatched 2xx statuses,
  oversized/expanded success, exact endpoint/body/cookie containment, malformed authority, and
  shared error drift. This adds no support capability or tenant/financial authority; real IdP/MFA,
  endpoint control, timing, incident, and protected-runtime evidence remain open. Evidence:
  `artifacts/restricted-support-response-boundary-verification-2026-07-29.json`; threat: TM-44.
- REVIEW-EVIDENCE-BOUNDARY-003: replaced generic investigation and run-artifact evidence with a
  strict bounded contract. The reconciliation engine validates current `RuleEvidence`; the API emits
  only paired source/normalized comparisons, deterministic rule/result/tolerance/search summaries,
  safe kind-specific canonical values, and all-or-nothing validated field lineage. Unknown, future,
  legacy, malformed, oversized, or inconsistent stored values emit the fixed
  `EVIDENCE_UNSUPPORTED_OR_MALFORMED` state without raw or partial fallback. Browser-visible record
  references must be unique, bounded, and exactly equal the tenant-resolved source-record set.
  Canonical/provenance reads now repeat explicit organization predicates inside forced RLS and omit
  organization IDs, source-event IDs, raw-object provenance, and source-value references. The BFF
  independently validates and reconstructs the same view. Contract, API/BFF minimization, Chromium,
  accessibility, and a fresh PostgreSQL 17.10 restricted-role test—including a crafted
  foreign-tenant stored reference—pass locally. Representative historical-evidence audit,
  protected-runtime timing/fault injection, and staging remain open. Evidence:
  `artifacts/typed-investigation-evidence-verification-2026-07-29.json`; decision: ADR 0058; threat:
  TM-48.
- BFF-READ-RESPONSE-001: `/api/recon` no longer relays successful tenant API JSON verbatim. All 17
  general tenant views now have exhaustive server-side schemas and reconstructed outputs; the
  already strict organization directory and support-grant list bring the route to 19 validated read
  modes. Every tenant read requires exact `200`, uses fatal UTF-8 JSON under the existing 5 MiB
  ceiling, emits only browser-required queue/pagination metadata, and strips unknown fields at every
  declared object layer. Tests inject credential references, invitation authority, audit
  before/after values, provider organization IDs, tokens, diagnostics, and unknown metadata across
  every view and confirm they do not cross the boundary. Deterministic evidence, record references,
  canonical normalized records, and field lineage now use strict typed projections with fixed
  unavailable states; policy snapshots retain their separate bounded contract. Read errors accept
  only four fixed code/status pairs through the shared 64 KiB boundary. Unexpected
  status/schema/error drift becomes a private generic `502`; upstream credentials are omitted and
  redirects rejected. Protected-runtime fault injection and evidence-content review remain open.
  Evidence: `artifacts/browser-read-response-boundary-verification-2026-07-29.json`; threat: TM-43.
- BFF-MUTATION-RESPONSE-001: the shared tenant mutation BFF no longer relays successful internal API
  objects verbatim. All 18 enumerated actions enforce an explicit accepted-status contract. Nine
  data-bearing actions parse and reconstruct only the fields used by their browser clients; the
  remaining nine validate an object response and emit a fixed acknowledgement. Successful JSON is
  bounded to 1 MiB and decoded as fatal UTF-8. Unexpected statuses, malformed response contracts,
  and unsafe Stripe provider-action URLs fail closed to a private generic `502`. The route now also
  uses the strict shared error allowlist, omits ambient credentials, and rejects redirects. Negative
  tests inject credential references, tokens, diagnostics, unknown fields, status drift, and unsafe
  URLs and confirm they never reach the browser. This closes the mutation-response finding locally;
  view-specific minimization of the general read BFF and protected-runtime exercises remain open.
  Evidence: `artifacts/browser-mutation-response-boundary-verification-2026-07-29.json`; threat:
  TM-42.
- BFF-UPSTREAM-ERROR-001: invitation acceptance, exception export, and privacy-package
  preparation/receipt no longer relay an internal API error object verbatim. One bounded shared
  parser accepts only a strict code/message/correlation envelope, then applies a route-specific
  code/status allowlist, discards the upstream message, and emits fixed browser-safe copy plus the
  validated UUID correlation identifier. Extra fields, unknown codes, mismatched statuses, malformed
  identifiers, invalid JSON/UTF-8, non-JSON content, and bodies over 64 KiB fail closed to a private
  generic `502`; upstream ambient credentials are explicitly omitted and redirects are rejected.
  Shared negative tests plus all three route contracts pass. This prevents an internal diagnostic or
  token accidentally crossing the BFF boundary; it does not claim protection from a fully
  compromised web process or replace API authorization, RLS, CSRF, or protected runtime exercises.
  Evidence: `artifacts/browser-api-error-boundary-verification-2026-07-29.json`; threat: TM-41.
- API-AUTHORIZATION-INVENTORY-001: the API now has a typed, exhaustive security contract for all 55
  registered routes. Fastify registration fails on an unknown method/template, and a centralized
  pre-handler authenticates identity routes plus resolves active membership and every declared
  permission for tenant routes before handler side effects. The verified identity and tenant context
  are request-local and reused; handler permission checks, repository predicates, and RLS remain
  layered controls. Provider webhook routes are explicitly classified under their existing
  exact-body Shopify/Stripe signature verifiers rather than user authentication. The same change
  corrected authenticated foreign-membership responses from distinguishable `401` to the bounded
  `404 RESOURCE_NOT_FOUND` used for insufficient permission; missing/invalid credentials remain
  `401`. Source-congruence, unclassified-route, single-resolution, foreign-tenant, role, webhook,
  and dual-permission export tests pass. Staging adversarial and response-timing evidence remains
  open.
- RESTRICTED-SUPPORT-ACCESS-001: support identity is separate from tenant membership and disabled by
  default. Enabling requires an exact configured OIDC group, exact MFA authentication-context claim,
  and dedicated canonical 32–64-byte HMAC key; issuer and subject are persisted only as a keyed
  digest. A support principal creates only a 15-minute organization-unbound request. One active
  tenant owner with explicit `support:manage` exchanges its one-time SHA-256-bound code for one
  `diagnostics:view` grant lasting 5–60 minutes. Fixed `SECURITY DEFINER` functions, forced-RLS
  request/grant ledgers, a tenant-composite request/grant foreign key, direct-table denial, worker
  denial, exact organization/grant/digest checks, revocation, and uniform not-found handling bound
  the path. Diagnostics return only capped aggregate counts and timestamps; no tenant directory,
  impersonation, financial records, raw payloads, credentials, exports, notes, or writes are
  available. Approval, each diagnostic read, and revocation enter the versioned tenant audit chain.
  Unit/config/API/tenant/static OIDC checks and a fresh restricted-role PostgreSQL 17.10 run pass,
  including a populated 0041-to-0054 upgrade, one-time request use, expiry, cross-tenant and wrong-
  identity concealment, mutation denial, and audit evidence. A fresh isolated Keycloak
  26.7.0/PostgreSQL 17.10/API/web/Chromium run now binds the provider's native LoA 2 flow, requests
  `acr_values=2`, completes password plus TOTP, proves wrong-code denial before application-session
  creation, accepts only exact group and signed `acr=2`, denies a valid-MFA non-group identity
  without durable state, and composes request, owner approval, fixed diagnostics, revocation,
  restricted-role RLS, and the v2 audit chain. Deployed/protected IdP policy, recovery and
  administrator-bypass resistance, ticket-system validation, customer notification,
  clipboard/endpoint controls, multi-replica key consistency, offboarding, periodic review,
  incident/timing, and protected staging remain open. A separate organization-blind support console
  and tenant-owner Security control pass fixed-route BFF, cookie non-forwarding, response-ceiling,
  memory-only code, uniform denial, explicit approval/revocation, aggregate-only render, full
  Chromium, and accessibility checks. Evidence:
  `artifacts/restricted-support-access-verification-2026-07-29.json`,
  `artifacts/restricted-support-browser-tools-verification-2026-07-29.json`, and
  `artifacts/oidc-restricted-support-mfa-verification-2026-07-30.json`; decisions: ADRs 0053
  and 0054.
- WEB-CSP-001: production runtime inspection disproved the earlier static assumption that CSP was
  active. Because this application uses `src/app`, the root-level `apps/web/proxy.ts` was not
  discovered by Next.js and a production page returned no CSP header. The proxy now lives at
  `apps/web/src/proxy.ts`; the build reports `Proxy (Middleware)`; production applies one fresh
  nonce to the request/response policy, framework scripts, and stylesheet; `style-src` is
  nonce-bound; `style-src-attr 'none'` denies attributes; the configured OIDC origin is validated
  before it enters `form-action` for federated logout; and the development-only style and
  `unsafe-eval` exceptions do not enter production. Policy/proxy/source tests cover malformed
  nonces, issuer rejection, fresh per-request forwarding, production/development directives, and
  absence of inline style/HTML sinks. A local production Chromium render loaded the external
  stylesheet with expected computed typography and zero console errors. Evidence:
  `artifacts/web-csp-verification-2026-07-28.json`. TLS-edge/header preservation and authenticated
  production topology remain deployment evidence rather than source closure requirements.
- AUDIT-CHAIN-TOPOLOGY-001: replaced business-time/UUID predecessor selection with the sole
  tenant-topological head under the existing advisory transaction lock. Canonical version-2 hashes
  bind explicit authority/evidence fields, normalized UTC instants, explicit nulls, and recursively
  sorted JSON. Migration 0039 preserves version-1 rows, aborts on malformed/forked/orphaned/
  unreachable legacy topology, and installs tenant event/predecessor/genesis uniqueness, a composite
  self-foreign key, hash/version checks, and a same-lock insert trigger that also blocks multi-row
  cycles. Synthetic tests cover canonical stability and field mutation; static migration tests cover
  every preflight/control; PostgreSQL 17.10 tests now pass for late/equal times, concurrent writers,
  fork/orphan/second-genesis/self/cross-tenant/multi-row-cycle rejection, one head, update denial,
  and a populated 0038-to-0039 transition without rewriting legacy evidence. A local logical restore
  preserved the exact audit-table/catalog/RLS digests and the restored tenant suite re-passed every
  topology/mutation denial. Representative lock timing, encrypted base-backup/WAL recovery,
  object/queue consistency, staging cutover, and external anchoring remain open.

- SHOPIFY-PRIVACY-BOUNDARY-001: replaced tenant-ID-routed privacy-topic handling with a fixed
  app-level endpoint that verifies the exact raw-body Shopify app HMAC before parsing or tenant
  resolution. It accepts only the mandatory topics/configured API version/canonical matching shop
  domain, discards email/phone/unknown fields, persists append-only tenant evidence with a 30-day
  due time, and makes the connection action-required. Customer/shop redaction creates
  database-authorized checksum-bound raw-object jobs; the least-privilege worker serializes with
  legal hold, retries/dead-letters within bounds, and appends immutable tombstones. A bounded
  worker-only monitor creates one forced-RLS append-only seven-day, 24-hour, or overdue signal and
  hash-chained system audit event inside exact tenant context; operational logs contain aggregate
  counts only. Synthetic/static coverage includes an owner/administrator-only minimized
  deadline/job-progress/escalation API, signed-context BFF, operator UI, negative tenant/role
  checks, threshold boundaries, and accessibility scan. A dual-authorized, confirmed data-request
  action adds bounded verified raw/normalized evidence, fixed JSON download, no-partial behavior,
  and metadata-only preparation audit. Digest-only, ten-minute, same-membership browser receipt is
  now separately controlled by SHOPIFY-PRIVACY-PACKAGE-RECEIPT-001. Live PostgreSQL, Shopify
  subscription delivery, secure merchant/customer transfer, recipient acknowledgement,
  downloaded-copy expiry, over-limit handling, external alert delivery/response exercise, canonical
  disposition, noncurrent versions, and backups remain under SEC-M-002.

- SHOPIFY-PRIVACY-PACKAGE-RECEIPT-001: added append-only, forced-RLS package-authority and receipt
  ledgers without storing package bytes or raw tokens. Preparation generates 256-bit authority,
  persists only content/token SHA-256 digests, exact byte count, preparing membership, and a
  ten-minute expiry, then returns the raw token only in private/no-store headers. The exhaustive
  55-route API contract requires both privacy/export permissions; a fixed tenant-checked function
  requires the exact request/package/token and same active preparing membership, serializes one
  receipt, conceals mismatches, distinguishes unused expiry, and replays exact success without a
  second row/audit. The BFF is same-origin, session/tenant-context bound, redirect-free, and
  response bounded. Chromium buffers complete bytes and acknowledges before download, failing closed
  without a download on acknowledgement error. Audit language remains `not_delivered` and explicitly
  does not claim merchant/customer transfer, review, fulfillment, or downloaded-copy expiry. Unit,
  API/BFF, static migration, route-contract, live restricted-role PostgreSQL, browser, and
  accessibility checks pass locally. The database run covers same-membership, idempotence,
  cross-tenant concealment, digest-only storage, audit atomicity, and application/worker grant
  denials; protected-staging interruption/timing, secure downstream transfer, recipient
  acknowledgement, and copy disposal remain required. Evidence:
  `artifacts/privacy-package-browser-receipt-verification-2026-07-29.json` and
  `artifacts/postgresql-51-migration-integration-verification-2026-07-29.json`; decision: ADR 0049.

- PROVIDER-OAUTH-LIFECYCLE-001: added disabled-by-default Shopify and Stripe authorization with
  digest-only single-claim state, fixed callbacks/origins, bounded response handling, encrypted
  versioned token bundles, database-locked refresh generation rotation, account/scope/mode drift
  rejection, provider-aware disconnect, and API/BFF/UI controls. Shopify uninstall is
  provider-first. Stripe stops reads immediately and finalizes only from the exact signed
  app-deauthorization event, bound to account, mode, authorization generation, unique event
  identity, forced-RLS evidence, and a redacted system audit. Synthetic coverage is linked from
  `artifacts/provider-oauth-lifecycle-verification-2026-07-28.json`; authorized sandbox and current
  live PostgreSQL evidence remain under SEC-M-002.

- RETENTION-DELETE-001: added disabled-by-default, tenant-scoped raw import/provider object
  retention with 1–3,650-day database bounds; reasoned legal hold; exact-confirmation admin UI/BFF;
  audited prior/new policy; terminal-source eligibility; a policy lock held across one 15-second-
  bounded checksum/ETag/version-bound deletion; final eligibility recheck; exponential retry and
  dead-letter after ten attempts; forced RLS; worker-only fixed-query functions; and immutable
  tombstones. Live PostgreSQL and MinIO tests cover default/held/nonterminal denial, least
  privilege, mutation denial, exact deletion, idempotent absence, and integrity mismatch. Noncurrent
  object versions, backups, other retention classes, and whole-tenant erasure remain explicit
  operational gaps.

- DB-CLIENT-COMPOSITION-001: removed the unused Drizzle runtime wrapper that replaced postgres.js
  JSON/JSONB serializers on the shared raw-SQL client and broke audit/import writes in production
  composition. The live CSV integration now uses the production database factory, and the fixture,
  authenticated BFF/API, outbox, and worker path completed against the corrected handle.
- IDP-PATCH-001: advanced the local Keycloak pin from 26.3.2 to 26.7.0 and completed a real
  authorization-code/PKCE browser login. Provider refresh rotation and end-session integration
  remain tracked separately under SEC-L-002.
- OIDC-REFRESH-001: added bounded Keycloak refresh-token exchange, replacement refresh-token
  rotation, terminal fail-closed state, browser session gating, and tests for credential
  non-disclosure, success, non-rotation, rejection, and oversized responses. A live isolated
  short-lifetime/zero-reuse Keycloak exercise rotated both tokens and disclosed no provider
  credential in session JSON.
- OIDC-LOGOUT-001: retained the provider ID token only in the encrypted HttpOnly session, added
  bounded CSRF-safe RP-initiated Keycloak logout with a fixed provider endpoint and fixed registered
  return origin, cleared normal and chunked local session cookies, and added negative Origin/GET,
  browser non-disclosure, and end-session redirect tests. A clean live Keycloak 26.7.0 exercise
  terminated the provider browser session and required credentials on the next sign-in.
- OIDC-BACKCHANNEL-LOGOUT-001: added standards-validated provider logout, bounded fixed Keycloak
  JWKS retrieval, `sid`/subject cutoffs, atomic replay defense, pseudonymous Redis indexes, and
  revocation-aware NextAuth/server-page/BFF session checks. Production rejects local storage and
  store failures fail closed. Synthetic source evidence is recorded in
  `artifacts/oidc-backchannel-revocation-verification-2026-07-28.json`; local exact Keycloak
  delivery, two production-built shared-Redis replicas, targeted isolation, replay, Redis loss, and
  persistent recovery are recorded in
  `artifacts/oidc-distributed-revocation-recovery-verification-2026-07-29.json`. Protected
  multi-host, managed-Redis, ingress, clock, rotation, and alert evidence remains under SEC-L-002.
- PROVIDER-GAP-REPAIR-001: added opt-in periodic Shopify/Stripe repair with a fixed service identity
  distinct from user membership authority, an exact immutable envelope, `row_security=on`
  worker-only functions, due/active-run checks, shared per-connection advisory locking,
  deterministic cadence-slot idempotency, bounded lookback/overlap/page/batch settings, and
  system-actor audit/run-history provenance. Synthetic unit/browser and live PostgreSQL tests cover
  replay, concurrency, cross-tenant denial, ineligible states, service-envelope forgery, and
  preservation of existing user-run authority.
- CONNECTOR-CREDENTIAL-001: added locally sealed AES-256-GCM credential envelopes with authenticated
  tenant/connection/provider/purpose/key-version context, versioned runtime keys, forced-RLS
  append-only lifecycle rows, active replay idempotency, retired replay rejection, server-only
  resolution, metadata-only API/UI responses, atomic rotation, and exact-confirmation disconnect.
  Synthetic cryptography/API/BFF/browser tests and a live PostgreSQL 17.10 role exercise cover
  tampering, cross-tenant movement, key rotation, worker resolution, revocation, and mutation/delete
  denial. Evidence: `artifacts/connector-credential-lifecycle-verification-2026-07-28.json`.
- TENANT-RLS-VERIFY-001: applied the prior 40-migration chain from empty as the non-superuser
  migration role and passed the tenant control file through the restricted application role,
  including subject-derived multi-organization enumeration, unknown-subject denial, audit writer
  concurrency, and negative topology controls. The full live suite also passed same-tenant/
  cross-tenant RLS, composite relationships, append-only evidence, ingestion durability, outbox
  authority, invitation, OAuth/privacy, and reconciliation execution tests using restricted
  application and worker roles. Prior-image runtime rollback and hosted PostgreSQL CI remain release
  evidence gaps rather than an absence of live adversarial database evidence.
- DURABLE-QUEUE-RECOVERY-001: migration 0040 adds forced-RLS execution and append-only recovery
  ledgers, fixed worker-only token-digest lease functions, exact stable job authority, heartbeat,
  terminal-state denial, bounded stale classification, legacy exclusion, and a no-default rolling
  writer opt-in. Live PostgreSQL/Redis tests cover all four admitted classes, active/succeeded/dead/
  legacy exclusions, application/foreign-tenant denial, duplicate queue replay, append-only
  evidence, restored-system binding, and non-empty Redis refusal. The Redis-add/PostgreSQL-evidence
  boundary cannot be atomic; the command stops and preserves a non-empty queue for reconciliation.
  Evidence: `artifacts/durable-queue-recovery-verification-2026-07-28.json`.
- DURABLE-QUEUE-COMPAT-001: replaced colon-delimited BullMQ queue names, which BullMQ 5 rejects,
  with a shared hyphen-delimited versioned name used by API producers, fixture loaders, and workers;
  a live Redis suite verifies stable job deduplication and unrecoverable invalid-capability failure.
- OBSERVABILITY-DURABLE-CONTEXT-001: all four shared durable-envelope types persist only locally
  accepted version-00 trace/span identity and sampled bit in an optional version-1 field:
  reconciliation, signature-verified provider webhook, tenant-authorized CSV commit, and
  user-requested provider sync. Provider-sync consumers pass their active authorized span into child
  webhook jobs. Raw `tracestate`, baggage, and request/payload fields are excluded. The context
  participates in the canonical job hash, and the worker loads and exactly matches the tenant-bound
  PostgreSQL outbox authority before using it as a local parent. Schema tests reject zero IDs,
  uppercase, unsupported flags, unknown fields, and forged context; worker tests reject a recomputed
  forged job ID against authority. Loopback OTLP proves a three-span API/durable/nested durable
  chain. A fresh PostgreSQL 17.10 cluster applied all 44 migrations and passed the webhook, CSV, and
  sync repository files through restricted application/worker roles, including exact immutable
  payload assertions and scheduled-root omission. Legacy envelopes, a deployed collector/backend,
  and representative multi-process trace behavior remain open. Evidence:
  `artifacts/reconciliation-durable-trace-context-verification-2026-07-29.json` and
  `artifacts/durable-producer-trace-context-verification-2026-07-29.json`; decision: ADR 0036.
- OBSERVABILITY-PROVIDER-GAP-REPAIR-FRESHNESS-001: the opt-in gap-repair scheduler reuses its
  existing worker-only, maximum-100 due-candidate query and tenant-scoped creation recheck. It
  exports only scan outcome, fixed provider/reference/disposition classifications, and a numeric
  last-successful-sync age bounded to 365 days; organization, connection, account/shop, run,
  credential, and raw timestamp values are excluded. Successful empty scans provide a heartbeat,
  while scan failures are recorded before the existing error path. This is bounded due-candidate
  evidence, not a total connection inventory, per-object provider watermark, active-sync health, or
  protected alert result. Evidence:
  `artifacts/provider-gap-repair-freshness-observability-verification-2026-07-29.json`; decision:
  ADR 0041.
- OBSERVABILITY-PROVIDER-ACTIVE-SYNC-001: the existing environment/queue Redis lease elects the only
  worker allowed to call a fixed, worker-only, `row_security=on` database function. Two
  provider-keyed limit-one lookups return exactly Shopify and Stripe as empty or active, with only
  queued/running status and database-computed age from immutable run creation. No organization,
  connection, run, requester, correlation, cursor, error, count, timestamp, account/shop,
  credential, object, money, or currency value crosses the boundary. The two-provider snapshot is
  atomic and expires on lease loss, failure, malformed/future data, or shutdown; followers do not
  query PostgreSQL. Migration 0046 builds the active partial index concurrently and is recorded only
  after catalog ready/valid checks; migration 0047 revokes execution from `PUBLIC` and the
  application role and grants only the worker. Static, repository, worker, and loopback OTLP
  evidence passes; live PostgreSQL role/index execution remains unverified in this increment.
  Evidence: `artifacts/provider-active-sync-age-observability-verification-2026-07-29.json`;
  decision: ADR 0044.
- PROVIDER-CIRCUIT-001: every bounded Shopify/Stripe recovery page now requires a Redis-backed
  circuit scoped to environment, fixed provider, tenant, and connection. Its key contains only the
  environment/provider plus a SHA-256 authority digest; state contains bounded counters/times and a
  random permit token. Atomic scripts coordinate replicas, admit one half-open probe, ignore stale
  results, count only rate-limit/timeout/unavailable failures, force-open for bounded rate-limit
  guidance, and fail closed before a provider request when the dedicated store is unavailable.
  Durable delay honors the larger of bounded exponential backoff and validated retry-after. Fixed
  provider-sync outcomes and circuit decisions/transitions exclude tenant, connection, account, run,
  requester, cursor, credential, error, payload, timestamp, and financial dimensions. Unit and
  authenticated loopback Redis 8.8.0 two-client evidence proves suppression, isolation,
  open/half-open/reopen/close, rate-limit, TTL, token, and key-shape behavior. Managed Redis
  TLS/ACL/failover, multi-host partitions, mixed-image drain, provider traffic/contract limits,
  thresholds, dashboards, silence behavior, and alert delivery remain open. Evidence:
  `artifacts/provider-request-circuit-verification-2026-07-29.json`; decision: ADR 0045.
- CONNECTOR-SOURCE-WATERMARK-001: the accepted ADR 0046 increment added strict tenant/API/browser
  shapes and a raw-event access index, but its direct aggregation premise was invalid: normal
  provider intake stores transport topics, not product-facing families. Its immutable artifact is
  retained as historical evidence and must not be used to claim normal-ingestion family coverage.
  The premise is explicitly superseded by ADR 0047.
- CONNECTOR-SOURCE-CLASSIFICATION-001: authenticated, schema-valid provider receipts and committed
  CSV rows now persist one complete immutable fixed-family classification atomically with source
  evidence. The tenant-owned table has a tenant-composite source-event foreign key, fixed allowlist,
  classifier version, forced RLS, append-only trigger, and application/worker `SELECT`/`INSERT`
  only. The `financial-records:view` endpoint joins classifications under the server-derived tenant
  transaction with explicit organization predicates and separately detects unclassified operational
  receipts. One gap makes every expected family on that connection `classification_unavailable`; it
  never combines partial observations with `never_observed`. Strict server and browser validation
  rejects foreign connections, incompatible/dynamic or duplicate families, malformed times/gaps, and
  incomplete response shapes. Migration 0049 performs no unsound legacy inference or unbounded
  backfill. Focused unit/tenant/static/browser evidence and current live PostgreSQL forced-RLS,
  restricted-grant, persistence, replay, and cross-tenant execution pass. ADR/migration 0051 add a
  non-bypass maintenance role with no direct source/classification/audit table access, one-row
  `SKIP LOCKED` claims, exact object digest/size/deadline checks, the live payload classifier,
  immutable receipt rechecks, fixed family shapes, and atomic hash-chained repair audit. Live
  two-session PostgreSQL evidence covers concurrency, function/table denial, audit-hash validity,
  missing/corrupt/timeout/unsupported failure, rollback/retry, replay, and zero-total-gap semantics.
  Migration 0052 adds disabled-by-default shared source-writer transaction locks, exclusive
  zero-compatible-gap activation, an append-only singleton, and a deferred exact-family commit
  trigger with no disable authority. Isolated PostgreSQL proves the in-flight old-writer race,
  idempotent activation, missing/incompatible rollback, actual Shopify/CSV compatibility, privacy
  exemption, replay, role denial, and tenant isolation. The repository has no prior deployable
  image, so real mixed-image rollout, representative timing/storage, and protected staging remain
  open. Evidence: `artifacts/source-object-classification-correction-verification-2026-07-29.json`
  and `artifacts/source-event-classification-repair-verification-2026-07-29.json`, extended by
  `artifacts/source-event-classification-writer-fence-verification-2026-07-29.json`; decisions: ADRs
  0047, 0051, and 0052.
- STRIPE-BALANCE-TRANSACTION-001: Stripe connector/normalizer 1.1.0 extends each authorized bounded
  recovery run from Events to a separate `type=charge` balance-transaction phase. Each request
  reacquires the required tenant/connection circuit permit and uses only fixed Stripe paths,
  configured account/version headers, bounded window/cursor/page/byte/time limits, and the distinct
  read credential. A versioned runtime-validated snapshot retains only required transaction fields
  plus Charge ID/PaymentIntent, strips unrelated Charge/customer/billing data, requires safe integer
  minor units and `amount - fee = net`, performs no conversion, and classifies/persists the result
  atomically through the existing tenant receipt/outbox path. Missing PaymentIntent is explicit
  incomplete evidence. Focused unit/ingestion/provider-sync tests and current live PostgreSQL
  application-role persistence/replay/tenant negatives pass. Owner review of
  `balance_transaction_source_read` and implied permissions, authorized Stripe sandbox behavior,
  async repair, interchange-plus exclusion, mixed-worker rollout, protected staging, dashboards,
  silence handling, and alerts remain open. Evidence:
  `artifacts/stripe-balance-transaction-recovery-verification-2026-07-29.json` and
  `artifacts/postgresql-51-migration-integration-verification-2026-07-29.json`; decision: ADR 0048.
- OBSERVABILITY-EXCEPTION-FINAL-RESOLUTION-001: the tenant-scoped reviewer transaction returns only
  internal database-authored exception creation and status-transition timestamps. After commit, a
  threshold-crossing approval records one bounded final-resolution classification and, for valid
  ages through 365 days inclusive, a numeric age. Pending dual-control approvals and rejected,
  conflicting, unauthorized, or rolled-back attempts emit no final sample. Automated supersession is
  excluded because it can be reobserved. No tenant, reviewer, proposal, exception, type, severity,
  reason, money, status, or timestamp attribute is exported, and the public API schema is unchanged.
  Evidence: `artifacts/exception-final-resolution-age-observability-verification-2026-07-29.json`;
  decision: ADR 0042.
- OBSERVABILITY-UNRESOLVED-EXCEPTION-QUEUE-001: one existing environment/queue Redis lease elects
  the only worker allowed to call a fixed, worker-only, `row_security=on` database function. The
  function uses a global partial index to return only empty/nonempty plus the database-computed age
  of the oldest unresolved exception; it returns no tenant, exception, timestamp, status, severity,
  type, evidence, assignee, money, or currency field. Attribute-free presence/age gauges expire on
  lease loss, failure, malformed/future data, or shutdown, and the poll counter has five fixed
  outcomes. Migration 0044 builds the index concurrently through a path restricted statically and at
  runtime to one named idempotent index statement; the ledger is written only after catalog checks
  confirm the index is ready and valid. Migration 0045 revokes the function from `PUBLIC` and the
  application role and grants only the worker. Static, repository, worker, and loopback OTLP
  evidence passes; live PostgreSQL role/index execution remains unverified in this increment.
  Evidence: `artifacts/unresolved-exception-queue-age-observability-verification-2026-07-29.json`;
  decision: ADR 0043.
- OBSERVABILITY-ALERT-POLICY-001: added a backend-neutral, production-disabled policy for 13
  lease-owned queue, unresolved-exception, and active-provider-sync failure, silence, and age rules.
  Instrument creation and validation share exact OpenTelemetry names, kinds, dimensions, and fixed
  values. The parser rejects unknown fields, dynamic/high-cardinality dimensions, unsupported
  values, reducer mismatches, duplicate IDs, and unbounded rule sets. Repository validation requires
  all control rules, 20-minute silence floors derived from maximum monitor/export intervals,
  threshold no-data normal for the legitimately absent active-sync age, monotonic
  warning-to-critical thresholds, and live runbook anchors. Dedicated monitor-counter absence
  remains alerting. No tenant/customer identifier, financial value, credential, raw error,
  source-write, permission, approval, retention, or AI authority is added. The proposed thresholds
  are not SLOs, and the file is not installed backend syntax. Collector/backend translation,
  protected synthetic warning/critical/failure/silence exercises, worker/collector outage,
  cardinality/load, notification receipt/ack/escalation/recovery, maintenance silences, rollback,
  and owner approval remain open. Evidence:
  `artifacts/production-disabled-operational-alert-policy-verification-2026-07-29.json`; decision:
  ADR 0050.
- WEB-SESSION-001: removed duplicated production session-secret fallbacks from BFF routes; added
  strong fail-closed validation, canonical auth-origin checks, and explicit private/no-store
  response headers with regression tests.
- WEB-INPUT-001: added media-type, UTF-8, declared-length, and streaming 16 KiB enforcement before
  parsing state-changing BFF JSON.
- API-REQUEST-001: untrusted correlation IDs are accepted only when UUID-shaped; otherwise the API
  generates a fresh identifier. Authenticated API responses are explicitly private/no-store.
- TENANT-IDENTITY-001: replaced globally readable runtime identity rows with forced,
  membership-filtered user RLS.
- MIGRATION-INTEGRITY-001: applied migrations now verify stored SHA-256 checksums and concurrent
  migration processes serialize through an advisory lock.
- MIGRATION-UPGRADE-001: created an isolated populated database at the 0030 checksum ledger, invoked
  the actual migration runner, and verified it applied only additive migration 0031. Seeded
  organization/user/membership fields were unchanged, an existing membership-requested provider run
  retained user authority, a connection without a read reference remained scheduler-ineligible, and
  the previous application-role tenant query and restricted directory remained compatible.
  Application rollback can disable the scheduler and leave the additive columns/functions/policies
  dormant. The current schema now has an exact synthetic PostgreSQL logical restore plus full
  database-suite proof, and a separate component drill verifies tenant object history plus
  unpublished-outbox reconstruction. Migration 0040 separately verifies conservative published
  in-flight queue classification on a fresh cluster. Prior-image runtime, base-backup/WAL recovery,
  atomic object/database/Redis consistency, and staging cutover remain operational evidence gaps.
- SUPPLY-DEPENDENCY-001: updated Zod and React types, retained runtime-aligned Node types and the
  TypeScript 6 compatibility line intentionally, removed an unused worker dependency, and resolved
  known audited transitive vulnerabilities with exact overrides.
- CI-BROWSER-001: corrected Playwright installation to execute from the package that declares it,
  expanded Docker update coverage to every application, pinned both ordinary CI Node runtimes to
  24.18.0, pinned ordinary container scans to Trivy 0.72.0 instead of an inherited action default,
  and added the representative reconciliation load verifier as a timing-informational correctness
  regression.
- REVIEW-CONTROL-001: persisted bounded organization review policies and proposal approval counts;
  high-severity, threshold-level, and sensitive categories can require two distinct reviewers;
  proposers cannot decide their own proposal; proposal evidence and approvals are database-protected
  against mutation. Pending edits now create immutable replacement versions, and approval authority
  never crosses proposal versions.
- INGESTION-DURABILITY-001: added exact raw-body provider verification, immutable checksummed object
  receipts, transactional outbox, a least-privilege relay role, tenant-authorized job validation,
  bounded retries/dead-lettering, and idempotent worker normalization.
- RECONCILIATION-SCALE-001: replaced pairwise exact-link scans with deterministic lookup indexes,
  bounded ambiguous candidate work, source-content snapshot identities, and per-run occurrence
  history. Five fresh local processes now execute one versioned mixed 100,000-record profile with
  stable canonical/reversed/rotated/repeated identities and result digests plus conserved integer
  money. Pure-engine timing and memory remain local observations, not an end-to-end SLO or
  production capacity result; see ADR 0067.
- RECONCILIATION-CANDIDATE-COMPLETENESS-001: removed silent ranking of the first 500 rows from a
  larger eligible payment population. Rule set 1.2.0 scores every candidate only when the complete
  indexed range is within 500; larger ranges create an explicit high-severity ambiguity with exact
  eligible/evaluated/emitted counts and no shortlist. Synthetic 500/501/10,000 boundary,
  strongest-candidate, and permutation evidence is preserved without claiming staging accuracy or
  capacity.
- RECONCILIATION-IDENTIFIER-SAFETY-001: rule set 1.3.0 detects unsafe boundary whitespace,
  control/line/bidirectional/invisible formatting, replacement characters, and unpaired surrogates
  across identity-bearing canonical fields. It emits display-safe field evidence and quarantines the
  whole affected record from automatic duplicate, exact/composite, fee, refund, and accounting
  linkage while independent safe records continue. Visible Unicode remains valid; synthetic evidence
  does not establish staging prevalence or operator outcomes.
- RECONCILIATION-ACCOUNTING-CARDINALITY-001: rule set 1.4.0 replaces boolean refund/accounting
  existence checks with a versioned exact match only for one normalized-reference, same-currency,
  tolerance-valid entry assigned to one refund. Multiple or reused entries fail closed as explicit
  ambiguity. A 500-candidate ceiling prevents unbounded evidence/work; larger ranges report a
  conservative lower bound, and every lookup key used by the overflowing refund taints otherwise
  unique entries in the same amount interval so they cannot escape reuse detection through another
  reference. Processing-fee duplicates now retain their own canonical type. Golden scenarios cover
  all 19 exception types, 500/501 boundaries, mixed-key overflow taint, and permutation replay. A
  fresh PostgreSQL 17.10 cluster applied the then-current 43 migrations and the restricted worker
  persisted exact rule/version/reason/reference evidence, stable per-run occurrences after replay,
  and foreign-tenant RLS denial for the new artifacts. Split/aggregated accounting rows,
  representative distributions, concurrency, and staging load remained outside rule 1.4. One
  isolated seven-record browser/BFF/API/outbox/Redis/worker journey proves the local operator path
  only.
- RECONCILIATION-ACCOUNTING-SPLIT-CONSERVATION-001: rule set 1.5.0 adds a bounded
  `refund-accounting-split` only for one complete 2–50-row, same-currency, strictly positive
  accounting bucket under one exact normalized transaction reference matching the refund external ID
  or refund reference. Checked signed-64-bit integer addition and the pinned currency tolerance
  enforce conservation. The engine never selects a subset, aggregates by order reference, nets
  non-positive rows, or prefers a split over competing one-row evidence. Multiple populated strong
  references, mismatch, sign violations, arithmetic overflow, candidate overflow, and any
  cross-refund row reuse fail closed. Exact-range overflow taints the entire strong key as well as
  the amount interval so an out-of-window row cannot escape hidden reuse. Golden/property tests
  exercise arbitrary positive partitions, tolerance, permutation replay, no subset selection,
  mismatch, 50/51 boundaries, signed-64 overflow, mixed-key taint, and row reuse. A fresh PostgreSQL
  17.10 cluster applied all 44 migrations; the restricted worker persisted an immutable three-record
  split snapshot, replayed idempotently, rejected snapshot mutation, and returned zero
  run/artifact/occurrence rows under a foreign tenant. A mocked Chromium run-detail fixture renders
  the exact rule/reason and three-record cardinality without detected accessibility or mobile
  overflow failures. An isolated continuous
  Chromium/BFF/API/outbox/Redis/restricted-worker/PostgreSQL verifier now executes the same two-row
  split, observes its exact reason and three record references, persists the matching immutable
  snapshot, and returns a foreign-tenant `404`. Representative accounting distributions, split-shape
  prevalence, concurrent load, alerts, mixed-image deployment, rollback, and protected staging
  remain unverified.
- RECONCILIATION-OCCURRENCE-EVIDENCE-001: additive migration 0043 separates stable workflow
  artifacts from immutable per-run observation evidence using forced-RLS, append-only
  `artifact-occurrence-v1` snapshots. The worker inserts and replay-verifies exact
  rule/type/version/reference/evidence/state context; disagreement fails closed. The application
  role is read-only, the worker cannot update/delete, and tenant-composite keys plus RLS conceal
  foreign rows. Run detail returns at most ten rows per artifact type, labels older-worker gaps as
  `legacy_current_projection`, and never fabricates a backfill from mutable current artifacts.
  Truncated previews can be expanded with stable primary-key pages whose canonical cursor is bound
  to the authorized tenant, run, artifact type, and last ID. The API limits pages to 100; the BFF
  fixes them at 25 and caps upstream JSON at five MiB. Fresh PostgreSQL repository, tenant/BFF, and
  Chromium tests cover exact/legacy rendering, 5/5/2 traversal, malformed and cross-scope cursor
  denial, foreign-tenant concealment, duplicate-free loading, accessibility, and mobile containment.
  A checked-in local verifier now covers one continuous browser-to-worker execution with exact
  match/exception evidence—including the conserved split’s three-record snapshot—and a cross-tenant
  `404`. Rolling deployment, representative concurrency/load, staging topology, and alert behavior
  remain operational evidence gaps. Evidence:
  `artifacts/reconciliation-artifact-pagination-verification-2026-07-29.json`.
- RECONCILIATION-INPUT-LINEAGE-001: the 100-row pinned-input preview can be expanded through a
  read-only tenant/run-bound ordinal cursor. Each page re-resolves `financial-records:view`, checks
  the tenant run, queries with an explicit organization predicate inside forced RLS, and admits at
  most 100 rows through a fixed 100-row BFF request and five-MiB response ceiling. The client
  rejects malformed UUID/version/hash/ordinal data, non-increasing pages, cross-page identity
  overlap, and invalid response cursors. Fresh PostgreSQL traversed 102 inputs in 40/40/22 pages and
  returned no run/input rows under a foreign tenant; Chromium replaced the 100-row preview and
  loaded 100/2 without duplication. A separate fresh PostgreSQL 17.10 exercise traversed the
  100,000-input ceiling with concurrent 100-row and 97-row restricted-role readers both in-process
  and in two independent processes. All four digests match with continuous ordinals; the run also
  confirms the intended index, cross-run cursor denial, and zero foreign rows. Its single-host local
  timings do not establish an SLO; representative multi-host concurrency and protected staging
  remain open. Evidence:
  `artifacts/reconciliation-input-lineage-pagination-verification-2026-07-29.json` and
  `artifacts/reconciliation-input-pagination-maximum-volume-verification-2026-07-29.json`.
- RECONCILIATION-RUN-CREATION-001: replaced one database execution per pinned input with
  deterministic 1,000-row batches inside the existing run/input/outbox/audit transaction. Unit
  coverage proves the 6,000-parameter full-batch ceiling and global ordinal preservation. A fresh
  checksummed PostgreSQL 17.10 database applied all 44 migrations; the restricted non-superuser,
  non-`BYPASSRLS` application role then created one 100,000-input queued run through the actual
  repository in 100 logged input statements. It persisted continuous ordinals, one dispatch, and one
  audit event; exact repetition returned the same authority, foreign-tenant reads returned no
  result, both run tables retained forced RLS, and offline checksums had zero bad blocks. The
  privacy trigger first rejected a verifier fixture carrying customer references; the corrected
  fixture omitted them and no control was weakened. A later verifier-only outbox query error was
  corrected and final evidence was rerun on a new empty cluster. Timing and memory are local
  measurements, not API or production claims. Evidence:
  `artifacts/reconciliation-run-creation-maximum-volume-verification-2026-07-29.json`.
- RECONCILIATION-RUN-CREATION-002: exercised the atomic boundary across input batches rather than
  inferring it from transaction structure. A verifier-only PostgreSQL trigger rejected ordinal 1,000
  during the second statement after the first 1,000-row statement executed. The restricted
  repository call returned SQLSTATE `23514`; administrator evidence then showed zero run, input,
  outbox, and audit rows. After the trigger and function were removed, the same deterministic
  100,000-record snapshot created one complete authority and repeated idempotently. PostgreSQL log
  blocks independently split into two input executes before the error and 100 successful executes
  after it; forced RLS remained enabled and offline checksums had zero bad blocks. This closes the
  deterministic cross-batch statement-failure case. Process loss, multi-host, and protected-staging
  evidence remain open. Evidence:
  `artifacts/reconciliation-run-creation-atomic-rollback-verification-2026-07-29.json`.
- RECONCILIATION-RUN-CREATION-003: added a validated 5–120 second application authority deadline (30
  seconds by default), transaction-local PostgreSQL statement backstop, API request-abort
  propagation, per-query cancellation, between-stage signal checks, and a fixed retry-safe `503`.
  PostgreSQL `transaction_timeout` was rejected because it fatally terminates the session and an
  exploratory maximum-volume run exposed an unsafe postgres.js 3.4.9 write-after-disconnect failure.
  A new clean PostgreSQL 17.10 database then applied all 44 migrations and seeded 100,000 valid
  synthetic canonical orders. A verifier-only delay at ordinal 1,000 let the first input statement
  execute before a 5,000 ms deadline and, separately, a client signal cancelled the second
  statement. Each attempt logged two input executes and ordinary user-request cancellation, left
  zero run/input/outbox/audit rows, and exposed no fatal server event. Removing the verifier objects
  allowed the same snapshot to create in 100 statements and repeat idempotently; forced RLS,
  foreign-tenant concealment, and offline checksums remained intact. Direct-signal evidence is not a
  real ingress disconnect or API SLO; pool saturation, process loss, multi-host, protected staging,
  and external alerting remain open. Evidence:
  `artifacts/reconciliation-run-creation-interruption-verification-2026-07-29.json`.
- RECONCILIATION-RUN-CREATION-004: made the fault harness launch the TypeScript child through Node's
  direct import hook so its spawned PID, reported PID, PostgreSQL application identity, and
  `SIGKILL` target are the same process. On a new data-checksummed PostgreSQL 17.10 database with
  all 44 migrations, the restricted creator reached the verifier-delayed second input batch and was
  killed. Its backend executed two input statements, logged an unexpected EOF with an open
  transaction, disappeared after 5,030.21 ms, and left zero run/input/outbox/audit rows. An
  identical retry created one complete 100,000-input authority. A separate policy snapshot then
  launched two direct creators; live `pg_stat_activity` evidence showed both backends and one
  `Lock/advisory` waiter. Both processes exited successfully with the same run, while only one
  100,000-input ledger, outbox event, and audit event persisted. Forced RLS and foreign-tenant
  concealment remained intact, the post-verifier log contained no fatal server event, and offline
  checksums scanned 1,473 files/37,290 blocks with zero bad checksums. This is a bounded single-host
  fault/contention result. Client loss remains an ambiguous-commit boundary that may yield zero or
  one fully complete authority; real ingress/proxy loss, pool saturation, supervisor recovery,
  multi-host partitions, protected staging, API latency, and external alert evidence remain open.
  Evidence:
  `artifacts/reconciliation-run-creation-process-loss-contention-verification-2026-07-29.json`.
- RECONCILIATION-RUN-CREATION-005: a fresh maximum-volume diagnostic occupied both connections in a
  restricted two-connection postgres.js pool and showed that the existing authority deadline
  prevented later writes but did not settle the repository call until capacity returned. Added a
  signal-first settlement helper that continues observing the non-cancellable, signal-guarded
  transaction promise. Unit tests cover abort-first settlement with a later operation result,
  operation-first settlement, and harmless late abort. On a second fresh data-checksummed PostgreSQL
  17.10 database with all 44 migrations and 100,000 valid synthetic canonical records, both pool
  holders were independently visible as `idle in transaction` / `ClientRead` before the request and
  after its response. The repository returned `RepositoryRunCreationUnavailableError` after 5,002.55
  ms while capacity remained unavailable. Releasing the holders afterward drained the expired
  operation with zero run/input/outbox/audit rows. The later process-loss, exact-retry, two-process
  contention, RLS, and offline-checksum controls still passed. This closes one bounded local
  pool-saturation response case, not sustained queue pressure, ingress latency, process-supervisor
  recovery, multi-host partitions, protected staging, or an end-to-end API SLO. Evidence:
  `artifacts/reconciliation-run-creation-pool-saturation-verification-2026-07-29.json`; decision:
  ADR 0034.
- RECONCILIATION-RUN-CREATION-006: added a validated 1–10 fail-fast cap for heavyweight
  run-authority transactions, defaulting to two per API process. Admission occurs before
  constructing the postgres.js operation; rejection invokes no database work, and an admitted lease
  is released only when the underlying promise settles rather than when an earlier public deadline
  response returns. Unit tests prove bounds, non-invocation, hidden-work lease retention, and
  reopening after drain. On a fresh data-checksummed PostgreSQL 17.10 database with all 44
  migrations and 100,000 valid synthetic records, two held pool connections caused exactly two
  admitted requests to settle at 5,001.93/5,002.10 ms. A simultaneous 32-request burst was rejected
  in 0.28 ms without database admission, and another attempt after both public deadlines was
  rejected in 0.21 ms because the hidden operations retained both slots. Releasing capacity drained
  both with zero run/input/outbox/audit rows; the process-loss, exact-retry, two-process contention,
  forced-RLS, and offline-checksum regressions passed. This closes a bounded single-process burst
  case, not sustained multi-replica load, ingress behavior, protected-staging capacity, or an API
  SLO. Evidence:
  `artifacts/reconciliation-run-creation-admission-pressure-verification-2026-07-29.json`; decision:
  ADR 0035.
- RECONCILIATION-RUN-CREATION-007: classified retry-safe run-creation unavailability internally as
  exactly `admission_saturated` or `interrupted` and emitted one aggregate OTLP counter. The API
  retains the same opaque public `503`; tests prove the internal reason is not serialized. A real
  loopback OTLP/HTTP protobuf capture contains the instrument and both fixed values while forbidden
  tenant, customer, payment, and credential sentinels remain absent. This is local contract
  evidence, not proof of a protected collector/backend, retention policy, dashboard, alert delivery,
  or representative failure rate. Evidence:
  `artifacts/reconciliation-run-creation-unavailability-observability-verification-2026-07-29.json`.
- RECONCILIATION-AUTHORITY-001: serialized run completion per organization; ordered authority by
  immutable creation time/UUID; enforced one successful current queue authority; prevented late
  older runs from moving exception state backward; superseded pending proposals atomically; and
  added tenant-isolated, worker-insert-only, append-only exception lifecycle events with operator
  visibility.
- ACCESS-LIFECYCLE-001: added tenant-authorized membership/connector health APIs, reason-audited
  membership role/status changes, organization-level serialization, self-mutation/owner-escalation/
  last-owner protections, and database constraints for roles and connection health states.
- ACCESS-INVITATION-001: added tenant-scoped, expiring single-use invitations with 256-bit bearer
  entropy, digest-only storage, provider-verified normalized-email binding, owner-only owner-role
  creation, fixed `SECURITY DEFINER` create/revoke/accept functions, immutable terminal state,
  same-origin private BFF handling, URL-fragment removal, and audit events that exclude token
  material. Successful acceptance now issues the subject-bound organization context only after
  strict 201 response validation; rejected or malformed upstream responses never receive it. A real
  isolated two-identity Keycloak/browser/local-relay run passed accepted and rejected delivery,
  acceptance, role/deactivation transitions, revocation, replay denial, digest-only persistence, and
  the terminal audit-chain assertions.
- ACCESS-ORGANIZATION-PROFILE-001: added a strict tenant-authorized organization profile read and
  rename path requiring current `organization:manage`. Migration 0055 adds a positive
  `profile_version`; the repository locks the tenant row, compares the exact expected version,
  increments only an accepted name change, and appends `organization.profile.updated` with
  previous/new values, required reason, and profile schema version to the v2 audit chain in the same
  transaction. A canonical same-name request is a no-op. Unknown fields, control characters, and
  invalid versions fail before mutation; stale writes conflict; analyst and foreign-tenant requests
  use the uniform not-found response. Strict BFF read/action schemas strip unknown response fields,
  and the accessible browser form requires confirmation, reloads current authority after conflict,
  and updates the selected organization label after validated success. Business time zone remains
  read-only because changing it can alter financial business-date interpretation. A fresh isolated
  PostgreSQL 17.10/Fastify run applies all 56 migrations and proves one `200`/one `409` concurrent
  result, exact directory refresh, stale/no-op behavior, two-event linear v2 audit evidence, and
  zero tenantless application-role rows; three Chromium tests pass with zero detected accessibility
  violations. Sustained or multi-host mutation, replica lag/failover, representative timing, rolling
  images, and protected staging remain open. Evidence:
  `artifacts/organization-profile-concurrent-api-verification-2026-07-30.json`; decision: ADR 0061;
  threat: TM-02.
- ACCESS-CONTEXT-001: replaced the global runtime tenant choice with a bounded identity-derived
  literal-search/keyset-paginated organization directory and an exact-origin selection endpoint.
  Exact organization IDs only filter the verified identity relation and never grant access; opaque
  cursors are schema/encoding/search-bound navigation state. The BFF issues an eight-hour
  HttpOnly/SameSite=Lax HMAC context bound to the OIDC subject, clears it on logout, and never
  accepts a browser organization ID at business endpoints; the API still re-resolves active
  membership and permissions for every operation. Strict upstream parsing, wildcard/cursor/page
  bounds, selection beyond the first page, tamper/replay, cross-site, expired-session, and
  foreign-identity tests pass synthetically. Prior live application-role multi-membership evidence
  remains valid, and the isolated Keycloak/browser composition now proves one provider-authenticated
  identity with memberships and distinct roles in two organizations. A separate fresh isolated
  Keycloak/PostgreSQL/browser run now gives one provider-authenticated reviewer 101 active
  tenant-complete memberships, traverses exact 50/50/1 pages without duplicates, accumulates all 101
  options, selects the final tenant, denies cross-identity exact selection, and immediately reflects
  deactivation/reactivation. A bounded 501-membership follow-up traverses ten 50-item pages plus
  one, stops browser accumulation at 500 with refine-search guidance, selects membership 501 through
  exact search, and repeats the current-membership and cross-identity assertions. These close the
  local more-than-100 and exact 500-item-ceiling composition gaps. A fresh PostgreSQL between-page
  mutation test now proves the documented non-snapshot rename drift, current exact lookup,
  deactivation exclusion, reactivation recovery, foreign concealment, and tenantless RLS denial;
  Chromium deduplicates and updates a renamed ID repeated across pages. A separate fresh
  PostgreSQL/Fastify run now proves two administrators' simultaneous membership changes serialize
  through the real route and restricted repository, exact directory state follows the winning write,
  three successful writes form one v2 audit chain, and a foreign administrator receives 404 without
  an append. The separate organization-profile verifier proves actual name mutation, optimistic
  concurrency, current exact lookup, audit, BFF, and browser behavior. Substantially larger
  representative directories, sustained or multi-host product-API mutation, representative timing,
  rolling images, and protected staging remain unverified. Evidence:
  `artifacts/organization-directory-concurrent-mutation-verification-2026-07-30.json` and
  `artifacts/membership-lifecycle-concurrent-api-verification-2026-07-30.json`, plus
  `artifacts/organization-profile-concurrent-api-verification-2026-07-30.json`.
- ACCESS-BOOTSTRAP-001: closed the new-identity dead end with a verified-email,
  first-active-membership-only bootstrap. Authority IDs, owner role, and AI-disabled state are
  server-fixed. A narrow fixed-path database function serializes issuer/subject calls and atomically
  binds one organization/owner membership to append-only, forced-RLS request-digest evidence; an
  exact retry replays and conflicting input or a second active membership fails closed. The first
  canonical audit event is in the same application transaction. The route is identity-classified,
  schema/rate bounded, and generic on conflicts; the exact-origin BFF forwards bearer-only and
  issues the existing subject-bound selected context. Static and synthetic database/service/API/BFF
  tests pass. A local Chromium exercise with a synthetic signed session and mocked boundaries
  confirmed that an uncertain response exposes the retry state and reuses the exact idempotency key.
  Fresh PostgreSQL 17.10 now proves migration 0042, actual restricted-role service execution, exact
  replay, two-call concurrency convergence, foreign-identity exclusion, one atomic audit, complete
  rollback on a forced audit failure, and populated 0041-to-0043 compatibility. A real isolated
  Keycloak 26.7.0 authorization-code/PKCE browser exercise now proves zero-membership first login,
  two-tab 201/409 convergence, exactly one AI-disabled owner tenant/bootstrap request/canonical
  audit event, HttpOnly session/context cookies, and no browser-readable provider credential. The
  extended run then proves the second identity's independent organization, invitation into the first
  organization, browser switching, distinct owner/auditor roles, tenant-scoped deactivation,
  unaffected owner access, reviewer reactivation, and immediate permission re-resolution. External
  IdP federation, representative abuse timing, sustained or multi-host product-API administrative
  mutation, substantially larger representative directories, MFA/recovery, and rolling deployment
  still need runtime evidence. The organization-name product route is covered separately by
  ACCESS-ORGANIZATION-PROFILE-001. The separate 101- and 501-membership runs use tenant-complete
  fixture seeding and therefore prove directory behavior, not the product organization-creation or
  invitation lifecycle. Evidence: `artifacts/organization-bootstrap-verification-2026-07-29.json`
  and `artifacts/organization-bootstrap-postgresql-verification-2026-07-29.json`, plus
  `artifacts/oidc-first-owner-bootstrap-verification-2026-07-29.json` and
  `artifacts/oidc-multi-organization-membership-verification-2026-07-30.json`, and
  `artifacts/oidc-organization-directory-scale-verification-2026-07-30.json`, plus
  `artifacts/oidc-organization-directory-ceiling-verification-2026-07-30.json`.
- REVIEW-WORKFLOW-001: added tenant-authorized, length-bounded, append-only exception notes;
  reason-audited assignment/defer/reopen transitions with row locking and a 365-day defer ceiling; a
  bounded chronological timeline spanning reconciliation observations, notes, proposals, and
  decisions; and a separately permissioned, bounded organization audit-history view.
- REVIEW-QUEUE-001: replaced incomplete client filtering of the first bounded result set with exact
  server-side status/severity/ID/type filters, stable severity/age/ID keyset pagination,
  filter-bound schema-validated cursors, tenant-wide database totals, supporting indexes, and
  authenticated browser coverage for pagination and the note/workflow/dual-control journey.
- REVIEW-QUEUE-FILTERING-002: completed the promised queue dimensions with a closed API/BFF/export
  contract. Amount ranges require an exact ISO currency and signed integer minor units; no
  cross-currency comparison or conversion occurs. Source resolution expands at most 500
  exception-held references and joins canonical records through the same explicit organization
  predicate under forced RLS; malformed, oversized, empty, or unresolved references remain
  unclassified. Confidence is deterministic review metadata (`fail` high, `ambiguous`/`defer` low,
  other evidence unclassified), never a probability or AI score, and low/unclassified evidence
  requires two independent reviewers when dual control is enabled. Assignment is limited to
  membership-derived `me`, any assigned, or unassigned states. Disjoint UTC age buckets share one
  transaction timestamp carried by cursor v2, whose digest binds every normalized filter. The
  permissioned formula-safe CSV v2 export uses the same predicates and appends its filters/time
  anchor to the tenant audit chain. Malformed amount, cursor/filter replay, strict response
  minimization, combined Chromium filtering/export, accessibility, wrong-source, and foreign-tenant
  empty-result tests pass, plus five fresh PostgreSQL 17.10 restricted-role scenarios.
  Representative query-plan/load, cursor-tamper, multi-replica, and protected-staging evidence
  remain open. Evidence: `artifacts/exception-queue-filtering-verification-2026-07-29.json`;
  decision: ADR 0057; threat: TM-47.
- REVIEW-EVIDENCE-BOUNDARY-003: current deterministic evidence is strict and bounded at engine,
  storage-read, API, BFF, and browser layers. Side-by-side comparisons, safe canonical values, and
  complete validated lineage replace generic JSON; malformed/future evidence has one fixed
  unavailable state. Browser record references require exact equality with tenant-resolved source
  records, and fresh PostgreSQL proves a crafted foreign-tenant stored UUID remains concealed. No
  rule, tolerance, money, approval, AI, provider, or source-write authority changes. Historical
  evidence disposition, representative load, fault injection, and protected staging remain open.
  Evidence: `artifacts/typed-investigation-evidence-verification-2026-07-29.json`; decision: ADR
  0058; threat: TM-48.

## Required re-review triggers

Re-run this review for any auth/session, tenant policy, connector credential, webhook, file upload,
outbound URL, AI capability, migration, container/release, or source-write change; after a relevant
advisory; and before any staging or public release.
