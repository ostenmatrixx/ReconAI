# ADR 0055: Versioned bounded verification evidence

- Status: Accepted
- Date: 2026-07-29

## Context

Repository documentation cites dated local verification artifacts as the basis for narrowly scoped
claims. The original Git-ignore policy excluded every `artifacts/*` file except `.gitkeep`. In a
future initial commit or clone, the documentation would therefore retain its claims while losing the
evidence it named.

Blindly publishing an artifact directory is also unsafe. Runtime output can contain customer data,
credentials, personal filesystem paths, unrestricted logs, or large generated files. A source
verification that reuses the working tree's installed dependencies and build output additionally
does not prove that the publishable source boundary is sufficient for a locked install and build.
This repository has no initial commit yet, so a literal fresh-clone proof is not available.

The first source export also exposed a separate ignore defect: the unanchored `exports/` rule
matched application route directories at any depth. It omitted both financial export BFF routes and
their two test files from the candidate source, reducing the isolated unit suite from 527 tests in
81 files to 521 tests in 79 files and removing both routes from the production route manifest.

## Decision

1. Bounded JSON evidence, the consolidated dated local Markdown transcript, the artifact policy, and
   the application SBOM are part of the publishable source boundary. Other artifact types remain
   ignored.
2. Runtime `tmp`, `temp`, `uploads`, and `exports` ignore rules are anchored to the repository root.
   `pnpm source:check` walks seven source/workflow/documentation roots and rejects any regular
   source file hidden by Git-ignore policy.
3. `pnpm evidence:check` rejects unexpected names, files over 512 KiB, a directory total over 5 MiB,
   invalid JSON, broken documentation references, ignored publishable evidence, and absolute
   personal home-directory paths. Secretlint remains a separate required check.
4. Only synthetic, sandbox, or local control-test evidence may be published. Credentials, provider
   tokens, customer or production payloads, private keys, unrestricted logs, and personal paths are
   prohibited even if another validator would accept the file.
5. Historical evidence is superseded with a new dated record rather than silently rewritten.
   Redaction required before the initial publication boundary is established is documented by this
   decision and preserves the measured result while removing workstation identity.
6. `pnpm verify:clean-source` runs the source-boundary check, then exports exactly
   `git ls-files --cached --others --exclude-standard` into a new temporary directory, rejects
   runtime environment files, credential-like extensions, generated directories, symlinks, and files
   over 5 MiB, initializes temporary Git metadata for the documented hook boundary, and copies
   `.env.example` to `.env`.
7. The verifier executes the frozen install, Secretlint, high-severity production dependency audit,
   Chromium browser suite, and complete static verification and production build. It hashes every
   candidate source file before and after and rejects source modification or a newly generated
   publishable file. Next.js may rewrite only `apps/web/next-env.d.ts` to its fixed development type
   path during Chromium startup; the final production build must restore the exact original
   manifest.
8. A requested evidence output is created append-only only after successful cleanup. The output file
   cannot hash itself, so the record names that limitation. During that single run, the
   evidence-link validator may accept exactly the declared pending output path; ordinary validation
   still rejects the link until the artifact exists.

## Consequences

Evidence links can survive an initial commit and clone, and regressions in the publication boundary
fail the normal verification command. The two financial export routes and all six of their tests are
now included in formatting, lint, typecheck, test, and production builds. The source export is
independent of the working tree's `node_modules`, build products, `.env`, and prior test output. The
added size and naming ceilings keep this from becoming a general-purpose log or release-artifact
directory.

The checked-in SBOM is a point-in-time generated record and may change when the lockfile changes.
Reviewers must distinguish a recorded local result from CI, staging, production, reliability,
capacity, or compliance evidence. Machine checks reduce accidental disclosure but do not replace
human review.

## Alternatives considered

- Keep artifacts ignored and remove documentation links: rejected because it would discard the
  repository's stated evidence-before-confidence model.
- Publish every artifact recursively: rejected because it creates an unsafe and unbounded data
  boundary.
- Claim the source export as a fresh clone: rejected because no commit or authorized remote exists.
- Copy the existing working tree with `node_modules`: rejected because it would not test the locked
  dependency or clean build boundary.
- Rewrite historical evidence after publication: rejected because review history must remain
  explicit; this pre-publication redaction is the bounded exception.

## Security, tenant, financial, AI, and operational effects

The policy reduces accidental source-control disclosure and requires synthetic evidence. It adds no
tenant query, organization authority, customer record, connector permission, money operation,
reconciliation behavior, review action, AI capability, or external write. Evidence must never be
used as a substitute for negative tenant tests or live protected-environment controls.

Temporary export cleanup is restricted to the exact operating-system temporary prefix created by the
verifier. The verifier contacts the package registry for installation and audit but must not contact
customer, provider, staging, or production services. Docker/Compose and live infrastructure remain
separate acceptance boundaries.

## Rollout, rollback, and verification

Before initial publication, review all newly visible evidence, run `pnpm evidence:check` and
`pnpm secret:scan`, and inspect the candidate source manifest. The clean-source record is
`artifacts/clean-source-export-verification-2026-07-29.json`.

Rollback may restore the previous ignore pattern only if every documentation evidence claim is
simultaneously removed or moved to another versioned, reviewed location. Removing the validator
without restoring an equivalent link, size, redaction, and publication check reopens the original
integrity and disclosure defect.
