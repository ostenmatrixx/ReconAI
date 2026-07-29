# Contributing to ReconAI

ReconAI welcomes contributions once the repository owner authorizes public release. Until then,
these guidelines define the internal contribution standard. Read `AGENTS.md`, `PRD.md`, `GOALS.md`,
and the relevant architecture/security docs before changing behavior.

## Set up

Use Node 24.14+, Corepack, pnpm 11.9.0, and Docker Compose:

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm hooks:install
pnpm infra:up
pnpm db:migrate
pnpm fixtures:load
pnpm dev
```

Everything runs with synthetic fixtures and local services. Never use real customer data or
production credentials in development, tests, issues, or pull requests.

## Choose work

Good first issues should be labeled `good first issue`, have a narrow boundary, name relevant tests,
and avoid migrations, auth, tenant isolation, cryptography, connector secrets, money rules, or AI
safety unless paired with a maintainer. Feature requests use the template and must connect to a
validated user problem rather than a technology preference.

For consequential behavior, open an issue/design discussion and ADR before implementation. Private
security findings follow `SECURITY.md`, never a public issue.

## Change workflow

1. Branch from the current default branch.
2. Make a focused change using Conventional Commits.
3. Add tests, migrations, observability, docs, and rollback notes appropriate to risk.
4. Run `pnpm verify` and relevant integration/e2e suites. Evidence added under `artifacts/` must be
   synthetic, bounded, redacted, linked, and pass `pnpm evidence:check` plus `pnpm secret:scan`.
5. Complete every applicable pull-request template section and attach objective evidence.

Do not amend another contributor’s work, rewrite shared history, publish packages, push deployments,
or change repository visibility/settings without explicit authorization.

## Git hooks

`pnpm hooks:install` installs repository-managed Lefthook hooks:

- Pre-commit: staged secret/environment/customer-fixture guard, staged formatting/lint, config
  check.
- Commit message: Conventional Commit validation with a correction example.
- Pre-push: typecheck, unit and invariant suites, migration/schema/dependency validation.

Run them manually with `pnpm hooks:pre-commit` or `pnpm hooks:pre-push`. If the binary is missing,
rerun `pnpm install` then `pnpm hooks:install`. CI is authoritative.

Emergency bypass is allowed only for a broken local hook, never to ignore a finding. Record the
reason in the pull request and run the skipped command before review.

## Pull-request expectations

Explain the user outcome, scope, permission/tenant impact, money/rule-version impact, security and
privacy impact, migrations/configuration, failure modes, rollback, test evidence, and limitations. A
passing build is necessary but not sufficient. Reviewers may request negative tests, fixture
provenance, performance evidence, an ADR, or a smaller change.

## Financial and tenant rules

Never use float money. Never trust a client organization ID. Customer rows and jobs are tenant
scoped. Rule changes are versioned. Webhooks are authenticated/idempotent. Audit history is
append-only. AI cannot approve. Source connectors are read-only. See `AGENTS.md` for the full set.

## Releases

Only maintainers release. Releases use semantic versioning and require changelog, migrations,
upgrade/rollback, versioned images, checksums/signatures, SBOM, supported-version statement, tests,
security evidence, and explicit breaking-change notes. See `docs/release.md`.
