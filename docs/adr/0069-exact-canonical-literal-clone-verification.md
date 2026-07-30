# ADR 0069: Verify literal clones only from an exact canonical revision

- Status: Accepted
- Date: 2026-07-30

## Context

ADR 0055 established a bounded clean-source export because the repository did not yet have an
initial commit or authorized remote. That exercise proved the Git-ignore-clean publication boundary,
but it could not prove that GitHub contained a sufficient revision or that an ordinary clone could
install and pass the documented gates.

The baseline is now pushed to the canonical public repository. The first manual clone exercise also
exposed an environment-dependent browser boundary: copying `.env.example` supplied a different
`SESSION_SECRET` from the fixed synthetic tokens created by the Playwright tests. Hosted CI passed
because it did not create `.env`; the documented local-clone path failed authentication. The browser
server must own its synthetic test secret explicitly instead of inheriting an ambient or copied
runtime value.

A general command that accepts any repository URL and then installs dependencies and executes its
scripts would be an unsafe remote-code execution helper. A branch name alone is also mutable and
cannot identify the source that produced evidence.

## Decision

1. `pnpm verify:literal-clone` accepts only the reviewed canonical public HTTPS remote
   `https://github.com/ostenmatrixx/ReconAI.git`. It rejects alternate hosts, forks, embedded
   credentials, SSH URLs, and non-HTTPS transports.
2. Every run requires a conservative named branch and one full lowercase 40-character expected
   commit ID. The clone succeeds only when `origin` and `HEAD` exactly match those inputs.
3. Git credential helpers and interactive prompts are disabled for the public clone. The verifier
   uses a new direct child of the operating-system temporary directory, clones only the named branch
   without tags, runs `git fsck --full`, and requires an initially clean worktree.
4. The verifier copies only `.env.example` to the ignored `.env`, then runs the frozen install,
   installs the lockfile-pinned Playwright Chromium, runs Secretlint, the production high-severity
   dependency audit, the complete Chromium suite, and `pnpm verify`.
5. Playwright starts the development web server with its fixed synthetic `SESSION_SECRET`
   explicitly. Production configuration validation and runtime secrets are unchanged.
6. After install, Secretlint, and audit, any tracked or unignored change fails. Chromium may make
   only the exact reviewed Next.js route-type rewrite in `apps/web/next-env.d.ts`; the production
   build must restore the original bytes. The final Git status must be empty.
7. On POSIX, child commands run in their own process groups with bounded timeouts. An interruption
   terminates the active group and escalates to a forced stop after five seconds so the Next.js
   server does not remain listening after the verifier exits. Windows uses the direct-child fallback
   and remains an unverified platform boundary. Recursive cleanup is restricted to the exact direct
   temporary child created by `mkdtemp`.
8. Optional JSON evidence is created append-only only after successful clone cleanup. It records the
   exact commit/tree, tracked-file count, lockfile digest, tool versions, bounded command outcomes,
   and limitations. The artifact necessarily is not part of the commit that it verifies.
9. Literal-clone verification remains an explicit networked acceptance command rather than part of
   ordinary `pnpm verify`. Hosted CI, container, migration, live-infrastructure, and protected
   staging checks remain separate evidence boundaries.

## Consequences

The repository can now test the actual public Git boundary instead of inferring it from an export.
An expected commit prevents a branch move between review and execution from silently changing the
verified source. Exact origin restriction prevents the command from becoming a generic
clone-and-execute facility.

The command requires GitHub, package-registry, and Playwright browser-download availability,
sufficient temporary/cache disk, and supported Chromium system libraries. It is intentionally
unsuitable for verifying an arbitrary fork without first reviewing and changing the canonical-source
policy. One successful workstation run does not establish default-branch protection, Docker
compatibility, staging readiness, reliability, capacity, compliance, or deployability.

## Alternatives considered

- Treat the clean-source export as a clone: rejected because it does not exercise the remote or Git
  object boundary.
- Accept any HTTPS Git URL: rejected because the verifier executes package lifecycle and repository
  scripts.
- Verify only a branch name: rejected because branches are mutable.
- Skip `.env.example` during browser verification: rejected because it would avoid the documented
  self-hosting path instead of testing it.
- Ignore every browser-produced source change: rejected because only one reviewed, byte-exact
  Next.js interim rewrite is expected.
- Add the networked clone to every `pnpm verify`: rejected because ordinary local and hosted quality
  checks must not recursively execute a remote checkout.

## Security, tenant, financial, AI, and operational effects

This decision adds no customer record, tenant query, money comparison, reconciliation rule,
financial approval, connector write, provider permission, migration, or AI authority. The copied
environment is synthetic and the verifier must not contact customer, provider, staging, or
production systems.

The canonical remote and expected commit are still executable trusted-source inputs; reviewers must
inspect the revision before running it. Evidence contains no credential, customer payload, personal
home-directory path, or unrestricted command output. Secretlint and the evidence publication policy
remain independent gates.

## Rollout, rollback, and verification

After pushing a reviewed implementation commit, run:

```sh
pnpm verify:literal-clone -- \
  --ref codex/foundation-literal-clone \
  --expected-commit <full-pushed-commit-id> \
  --evidence-output <dated-literal-clone-artifact-path>
```

Review the bounded artifact, run `pnpm evidence:check` and `pnpm secret:scan`, and commit the
artifact separately so its source commit remains explicit. Rollback may remove the verifier only if
literal clone evidence is again marked unavailable and no goal or release claim depends on it.
Reverting the explicit Playwright secret would restore the documented `.env.example` authentication
defect.
