# Local verification — 2026-07-27

Environment: Node 24.15.0, pnpm 11.9.0, Darwin arm64.  
Recorded at: 2026-07-27T16:04:02Z.

## Passed

- `pnpm verify`: formatting, strict ESLint, all workspace type checks, 177 deterministic
  unit/tenant/reconciliation tests in 33 files, migration/schema/config/dependency validation, and
  all workspace production builds.
- `pnpm migrations:check`: 32 ordered migrations; chain SHA-256
  `fed45566c68de11255ba0d7efc3031091a6a73ad897671af48f7075ca6ae9af2`.
- Current isolated PostgreSQL 17.10 verification: all 32 migrations applied as
  `reconai_migrator` to a brand-new database, and all nine PostgreSQL-backed files passed 23 tests
  through administrator, migration, `reconai_app`, and `reconai_worker` roles. Coverage includes
  API repository behavior, immutable run execution/authority, CSV commit/replay/rollback, provider
  receipt idempotency, least-privilege outbox relay, direct/cross-tenant RLS, audit immutability,
  identity-derived multi-organization access, bounded Stripe/Shopify provider-sync
  tenant/cursor/immutable-progress authority and six-attempt ceiling, fixed-service scheduled
  repair authority, replay/concurrency/cross-tenant denial, disabled/held/nonterminal retention
  denial, terminal-object claim/retry/tombstone behavior, and the populated 31-to-32 upgrade. One
  verified OIDC
  identity enumerated exactly its two active organizations, while an unknown subject saw none. The
  `@embedded-postgres/darwin-arm64@17.10.0-beta.17` server binary reported PostgreSQL 17.10 and had
  SHA-256
  `8776e8dfcc8fd7eaaf02db978d00f225a1905b6cbe9ecdd3cf5e86cf3a00e33f`.
  The server was stopped, its temporary cluster was moved to Trash, and its verification port was
  no longer listening.
- Populated previous-release upgrade verification: an isolated database applied and checksummed
  migrations 0000–0030, then the normal migration runner applied only
  `0031_scheduled_provider_gap_repair.sql`. Two upgrade tests preserved every asserted seeded
  organization/user/membership field and existing member-requested provider run, retained the
  previous tenant-scoped membership query through `reconai_app`, verified the 32-entry ledger,
  returned both memberships through the restricted directory, and confirmed a connection without a
  separate read credential remained scheduler-ineligible.
  Evidence: `artifacts/database-upgrade-verification-2026-07-27.json`.
- Isolated live PostgreSQL 16.14 verification: all 28 migrations applied as `reconai_migrator` to
  a brand-new database, and six PostgreSQL-backed test files passed 12 tests as the administrator,
  `reconai_app`, and `reconai_worker` roles. The checksum-verified Postgres.app 2.9.5 DMG had SHA-256
  `3fddff8f7c94b62f428c3972d65bc930b820c1d8f15220dc51ab4e0e819f3a59`. Coverage includes
  same-tenant access and cross-tenant denial, tenant relationship constraints, append-only audit
  and ingestion evidence, CSV commit/replay/rollback, provider receipt idempotency, least-privilege
  outbox relay, verified-email invitation acceptance/replay/revocation, immutable run snapshots,
  fail-closed content hashes, and newer-run authority over a late older completion.
- At the earlier 28-migration snapshot, the then-complete `pnpm test:integration` set passed all
  eight files and 15 tests against live PostgreSQL, Redis 8.2.1, and MinIO
  `RELEASE.2025-07-23T15-54-02Z`. The Redis source SHA-256 was
  `e2c1cb9dd4180a35b943b85dfc7dcdd42566cdbceca37d0d0b14c21731582d3e`; the MinIO Darwin arm64
  binary SHA-256 was `0939ce5553ce9e6451b69e049fbf399794368276b61da8166f84cbd8c7f2d641`.
  Live queue coverage verifies stable job deduplication and unrecoverable capability rejection.
  Live object coverage verifies conditional immutable write/replay and exact payload checksum
  retrieval.
- The current pinned MinIO `RELEASE.2025-07-23T15-54-02Z` binary passed the raw-retention object
  contract against this source state: checksum mismatch failed closed, deletion was conditional on
  the current ETag/checksum, post-delete absence was confirmed, and repeated deletion returned the
  idempotent `already_missing` outcome. The checksum matched the official Darwin arm64 release:
  `0939ce5553ce9e6451b69e049fbf399794368276b61da8166f84cbd8c7f2d641`.
  The server was stopped, its temporary files were moved to Trash, and both API/console ports were
  no longer listening.
- Live first-run and OIDC smoke against the same isolated services: Keycloak 26.7.0 imported the
  repository realm; `pnpm fixtures:load` persisted six canonical records, six source events, one
  completed immutable accounting import, and 43 field-provenance entries through live PostgreSQL,
  Redis, and MinIO. A real browser authenticated `owner@example.test` through Keycloak, returned to
  `/dashboard`, loaded the three tenant-authorized connector rows and completed import, then queued
  a reconciliation run through the BFF/API. The API returned `202`; the outbox relay published one
  message; the worker completed it on the first attempt; and the run succeeded over six pinned
  records with two matches, zero exceptions, live queue authority, one dispatch, and visible input
  and policy SHA-256 evidence. Keycloak was downloaded from its official 26.7.0 release with
  SHA-256 `f771df0aa1e4820f57d56f7d6d015beb6415487b43f8de7e5a6d48f8a7fe118a` and ran on the
  checksum-verified Temurin 21.0.11+10 JDK
  (`6ebcf221c9b41507b14c098e93c6ead6440b8d9bd154f8ec666c4c73abbdb201`).
- Isolated OIDC rotation exercise against the same checksum-verified Keycloak 26.7.0/JDK artifacts:
  a synthetic realm used a 65-second access-token lifetime, refresh-token revocation, and zero
  refresh-token reuse. A real authorization-code/PKCE browser login produced an encrypted
  HTTP-only session; after entering the 60-second refresh window, the NextAuth session endpoint
  rotated both provider tokens, advanced access-token expiry by six seconds, retained
  `HttpOnly`/`SameSite=Lax`, returned `reauthenticationRequired: false`, and disclosed no provider
  credential in browser-readable session JSON. Evidence:
  `artifacts/oidc-refresh-verification-2026-07-27.json`.
- Isolated RP-initiated logout exercise against a clean import of the repository Keycloak 26.7.0
  realm: a real authorization-code/PKCE login produced a two-chunk encrypted `HttpOnly`/
  `SameSite=Lax` session. A same-origin, NextAuth-token-protected POST retained the ID token only
  server-side, redirected to Keycloak's fixed end-session endpoint with the registered fixed
  post-logout origin, and removed both local session chunks. A second sign-in displayed Keycloak's
  login form rather than silently reusing SSO, proving termination of that local provider browser
  session. Browser-readable session JSON disclosed no provider credential. Evidence:
  `artifacts/oidc-logout-verification-2026-07-27.json`.
- The live first-run smoke exposed and closed a database-client composition defect: constructing an
  unused Drizzle wrapper replaced the shared postgres.js JSON serializer and broke raw JSONB writes
  in fixtures and production app composition. The runtime database handle now owns only the
  postgres.js client actually used by the API/worker; the live CSV integration test constructs that
  production handle so the regression is covered.
- Drizzle generation against the typed schema, using the documented synthetic local migration URL,
  produced the checked-in 0030 snapshot for the read-credential and provider-sync-run additions.
- `pnpm audit --prod --audit-level=low`: no known vulnerabilities reported at execution time.
- `pnpm license:check`: production dependency license allowlist passed.
- `pnpm secret:scan`: passed after adding the exact synthetic worker-role development URL to the
  local-fixture allowlist.
- `pnpm sbom:generate`: CycloneDX application SBOM written to `artifacts/sbom.cdx.json`.
- `pnpm test:e2e`: 27 Chromium tests passed, including ten automated accessibility scans,
  authenticated queue pagination/filtering, exact-filter non-empty CSV download, zero-byte download
  prevention, permanent-note, workflow assignment, two-of-two approval, automatic-supersession
  history, live-versus-historical run authority, reconciliation recovery, invitation journeys, and
  CSRF-negative/chunk-cleanup RP logout coverage with synthetic API/provider responses. Invitation
  coverage includes relay-accepted delivery plus manual-link fallback after failure. Accounting
  import coverage requires the exact import ID and verifies the retained-evidence rollback outcome.
  Review-policy coverage verifies canonical bounded thresholds, audit-visible reason, and explicit
  confirmation. Multi-organization coverage selects between two identity-authorized memberships,
  submits only the selected UUID to the same-origin selection endpoint, and verifies organization
  context cleanup during logout. The downloaded CSV’s saved byte count and UTF-8 BOM were checked;
  the invitation acceptance test proves the token fragment is removed before the state-changing
  request. Retention coverage requires bounded durations, legal-hold evidence, audit reason, and
  explicit permanent-deletion confirmation while explaining which evidence remains. Provider-sync
  coverage requires a read-enabled Shopify connection, bounded window/page ceiling, audit reason,
  explicit read-only confirmation, durable queued status, and accessible provider-neutral run
  history.
- `pnpm test:accessibility`: all ten Chromium/Axe scans passed using one worker so the dedicated
  dev-server run does not race concurrent cold route compilation.
- Dangerous-sink/log review: no application `eval`, `new Function`, dangerous HTML sink, console
  secret/payload logging, or runtime unparameterized SQL call found. Remaining `.unsafe()` calls are
  fixed migration contents or local integration-role bootstrap statements. Run start/replay and
  invitation browser boundaries use bounded Zod contracts, same-origin checks, private responses,
  explicit confirmation, required reasons, server-side permission checks, and parameterized SQL.
  Invitation material uses 256 random bits, digest-only persistence, a 72-hour expiry,
  provider-verified email binding, single-use terminal transitions, and fixed least-privilege
  database functions. Exception queue inputs are bounded, exact-match filters; opaque keyset
  cursors are schema-validated and bound to the active filter set; all list queries remain
  tenant-predicated and parameterized. Run completion uses tenant-scoped, parameterized authority
  and lifecycle statements; database constraints limit authority to one successful run and make
  status events append-only. Exception export requires the explicit `data:export` permission, exact
  bounded filters, 10,000-row/5 MiB ceilings, formula-safe quoted cells, a fixed filename, CSRF
  checks, private/no-sniff/sandbox headers, complete non-empty BFF buffering before download, and a
  metadata-only append-only audit event. Invitation email delivery uses a replaceable authenticated
  HTTP relay, a five-second timeout, disabled redirects, discarded provider bodies, stable failure
  codes, and token-free logs/audit; unavailable delivery preserves the one-time manual link.
  Accounting import rollback requires `connectors:manage`, exact typed ID confirmation, and a
  bounded reason; shares the organization snapshot lock; appends tenant-isolated immutable
  per-version supersessions and audit; leaves raw/canonical/provenance evidence intact; and prevents
  rolled-back imports from producing later canonical versions.
  RP-initiated logout is POST-only, requires an exact canonical Origin plus NextAuth-compatible
  signed double-submit token, accepts one bounded URL-encoded field, takes no client redirect,
  derives the provider endpoint from the validated fixed issuer, clears the exact session cookie
  and all numeric chunks plus the tenant-selection cookie, and returns
  private/no-store/no-referrer responses. Organization discovery is a bounded authenticated API
  read derived only from the verified issuer/subject. Selection is exact-origin, strict-JSON, and
  limited to that directory; the resulting HMAC cookie is HttpOnly, SameSite=Lax, eight-hour,
  subject-bound, and tamper-resistant. Business BFF routes take no browser organization ID and the
  API still re-resolves active membership and permissions on each request.
  Retention updates require `retention:manage`, an audit-visible reason, exact organization
  confirmation injected by the BFF, database bounds, and a reasoned legal hold. The worker has only
  three fixed-function grants, keeps the policy row locked through one 15-second-bounded
  checksum/ETag/version-bound deletion, rechecks eligibility before finalization, caps exponential
  retry at ten attempts, and writes an append-only tombstone without deleting canonical,
  provenance, reconciliation, review, or audit evidence.
  Provider sync requires `connectors:manage`, an audit-visible reason, exact BFF-injected
  organization confirmation, a distinct bounded read credential reference, and a positive
  at-most-30-day window/page ceiling. The worker accepts only exact tenant outbox authority, uses the
  fixed Stripe Events origin with no redirects, bounds timeout/response/page/item/cursor/retries,
  preserves event API versions, stages each event through immutable ingestion, and never exposes a
  provider mutation method. The disabled-by-default periodic scheduler may create only due
  Shopify/Stripe runs through a fixed service identity, exact user/system authority XOR,
  `row_security=on` worker functions, bounded lookback/overlap/page/batch settings, deterministic
  cadence-slot idempotency, and the same per-connection advisory lock used by operator requests. It
  never calls a provider directly.
- Hook smoke: Lefthook installed all three executable hooks; the commit-message validator rejected
  an empty message with the documented correction.

## Performance datum

`artifacts/reconciliation-benchmark-2026-07-27.json` records one correctness-checked 99,999-record
synthetic run for engine `0.3.0` / rules `1.1.0`: 33,333 matches, zero exceptions, 1,172.65 ms engine
duration, and 241,467,392 bytes RSS growth. This is a local regression datum, not a p95, SLO, or
production capacity claim.

## Not executed

- Docker Compose/containerized multi-process startup. Equivalent host processes were exercised
  together for the OIDC browser-to-BFF-to-API-to-outbox-to-worker flow, but that does not verify
  image construction, container health checks, internal DNS, or the Compose network boundary.
- Prior application-image runtime rollback and backup/restore cutover. The current additive
  31-to-32 database transition and previous-query compatibility passed, but no prior image was
  launched and no destructive down migration is intended.
- Container builds/scans, provider sandbox contracts (including real Stripe Events and Shopify
  GraphQL requests), production scheduler cadence/capacity/rate/alert exercise, backup/restore, a
  configured email relay/inbox delivery, alerts, or staging deployment.
- Hosted CI and CodeQL.

Reason: Docker and Podman are unavailable on this workstation. PostgreSQL, Redis, MinIO, Keycloak,
and its JDK were run from checksum-verified artifacts in isolated temporary directories without
system installation. No remote, provider credentials, or deployment authorization exists. The
remaining suites and CI services are defined but are not counted as passing evidence.
