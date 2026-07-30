# Goal 0 evidence — Foundation

Status: active

## Available repository evidence

- Product/governance: `PRD.md`, `GOALS.md`, `AGENTS.md`, root community/governance files.
- Design/security: `docs/architecture.md`, `docs/threat-model.md`, `docs/data-model.md`,
  `docs/reconciliation-engine.md`, `docs/connectors.md`, and accepted ADRs.
- Operations: self-hosting, deployment, runbook, incident, backup, privacy, migration, release, and
  upgrade documentation.
- Name review: `docs/name-review.md` records material collision and do-not-publish decision.
- Local verification through 2026-07-30: frozen install; format/lint/typecheck; 576
  unit/property/tenant/reconciliation tests in 86 files; 45 Chromium tests, including 14
  accessibility scans; the current 56-file source migration chain passes static integrity
  validation. A fresh data-checksummed PostgreSQL 17.10 cluster, authenticated Redis 8.2.8, and
  pinned MinIO instance passed the current complete 54-test integration set across 19 files; this
  included an actual restricted-role organization-bootstrap service transaction and a populated
  0041-to-0043 upgrade. A separate isolated Keycloak 26.7.0/PostgreSQL 17.10/Chromium run passed the
  real authorization-code/PKCE first-login and two-tab first-owner bootstrap. Its current extension
  has the second verified identity create an independent organization, accept an invitation into the
  first, switch between both with tenant-specific roles, retain unaffected owner access through
  invited-tenant deactivation, and pass relay rejection, revocation/replay denial, and canonical
  audit assertions. The then-current 40-migration chain and 34 tests across all 11 PostgreSQL-backed
  files also passed, including a populated 0038-to-0039 upgrade and a repeat provider suite; the
  earlier 28-migration snapshot passed the then-complete 15-test integration set across eight files
  against PostgreSQL 16.14, Redis, and MinIO; checksum-verified Keycloak 26.7.0 browser login and
  browser-to-BFF-to-API-to-outbox-to-worker reconciliation smoke; a populated 32-to-33 migration
  through the actual runner with previous-query compatibility; production build;
  migration/schema/config/dependency validators; clean dependency audit; secret/license checks;
  immutable container/action input and non-publishing candidate policy validation; and CycloneDX
  SBOM generation.
- Hook evidence on 2026-07-27: Lefthook installed executable `pre-commit`, `commit-msg`, and
  `pre-push` hooks in `.git/hooks`; the commit-message validator rejected an empty message with the
  documented Conventional Commit correction. The pre-commit dispatcher ran but correctly skipped
  file commands because no files were staged.
- Security review: `docs/security-review.md` records remediations, three Medium and two Low open
  pre-release findings, and the remaining unavailable-infrastructure boundary.
- Consolidated local transcript: `artifacts/local-verification-2026-07-27.md`.
- Distributed request-perimeter evidence:
  `artifacts/distributed-rate-limit-verification-2026-07-28.json`.
- Corrected forwarding-authority and two-upstream live Nginx evidence:
  `artifacts/live-edge-verification-2026-07-29.json`.
- Two-replica live dependency readiness/fault-recovery evidence:
  `artifacts/api-readiness-verification-2026-07-28.json`.
- Identity-derived organization-directory pagination evidence:
  `artifacts/organization-directory-pagination-verification-2026-07-29.json`; real local
  provider-authenticated 101-membership 50/50/1 traversal, final-item selection, cross-identity
  denial, and deactivation/reactivation evidence:
  `artifacts/oidc-organization-directory-scale-verification-2026-07-30.json`; real local
  501-membership 500-option ceiling, refine-search, and exact membership-501 selection evidence:
  `artifacts/oidc-organization-directory-ceiling-verification-2026-07-30.json`; fresh PostgreSQL
  mutable-page authorization and Chromium renamed-ID deduplication evidence:
  `artifacts/organization-directory-concurrent-mutation-verification-2026-07-30.json`; real
  concurrent membership-route, restricted-role, directory, and audit-chain evidence:
  `artifacts/membership-lifecycle-concurrent-api-verification-2026-07-30.json`.
- Immutable reconciliation occurrence/operator evidence:
  `artifacts/reconciliation-operator-evidence-verification-2026-07-29.json`.
- Restricted-role organization bootstrap and populated-upgrade evidence:
  `artifacts/organization-bootstrap-postgresql-verification-2026-07-29.json`.
- Real local OIDC first-login, concurrent-browser first-owner, and two-identity access-lifecycle
  evidence: `artifacts/oidc-first-owner-bootstrap-verification-2026-07-29.json`; current
  two-organization identity/switching evidence:
  `artifacts/oidc-multi-organization-membership-verification-2026-07-30.json`.
- OIDC back-channel session-revocation evidence:
  `artifacts/oidc-backchannel-revocation-verification-2026-07-28.json`.
- Full-graph production license evidence:
  `artifacts/production-license-verification-2026-07-28.json`.
- Production web CSP evidence: `artifacts/web-csp-verification-2026-07-28.json`.
- Container source-policy evidence: `artifacts/container-integrity-verification-2026-07-28.json`;
  hosted candidate execution remains required.
- Hosted CI and Git-hook evidence: PR 11 implementation commit `715eea1` passed CI run
  `30501635095`, Security run `30501635079`, and enabled pre-commit/pre-push gates. The exact run
  boundary and limitations are recorded in
  `artifacts/cross-layer-tenant-surface-verification-2026-07-30.json`.
- Git-ignore-clean candidate-source evidence:
  `artifacts/clean-source-export-verification-2026-07-29.json`. A new temporary repository received
  only publishable files, copied the synthetic `.env.example`, completed the frozen install,
  Secretlint, production audit, full static verification/build, and Chromium suite, and retained the
  exact source manifest. This remains a historical export rather than the still-pending literal
  clone of the initialized remote.
- Rootless Podman Compose quick-start evidence:
  `artifacts/local-podman-compose-quickstart-verification-2026-07-30.json`. The digest-pinned
  PostgreSQL/Redis/MinIO/Keycloak network became healthy, all 56 migrations and synthetic fixtures
  loaded, host-run web/API/worker plus real local OIDC/API/BFF/browser smoke passed, tenantless RLS
  reads returned zero, `pnpm infra:up` passed idempotently, bounded logs omitted checked local
  credential values, and shutdown removed every project container, volume, and listener. ADR 0062
  defines the fixed Docker-or-Podman launcher and bounded Podman readiness contract.
- Toolchain review: `docs/dependency-policy.md`; registry comparison reports only deliberate
  TypeScript 6 and Node 24 types versus newer incompatible runtime/tooling majors.

## Required but not yet available

- A literal initial-commit fresh-clone transcript. The clean-source export and Podman Compose
  dependency/migration/fixture/application smoke boundaries are verified separately; Docker-engine
  compatibility and release application images are not.
- Authoritative CI run URL for quality/security/container/SBOM jobs.
- Full pre-push dispatcher transcript and pre-commit checks against staged files. The user has not
  authorized staging or pushing; no files were staged for this local check.

Do not change Goal 0 to complete until every missing item is linked with date and result.
