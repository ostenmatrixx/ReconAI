# Release guide

ReconAI uses semantic versioning after `0.1.0`; pre-1.0 breaking changes are still called out
explicitly. Only an authorized maintainer may release, and public publication requires owner
approval plus the name/license/publication gate.

## Checklist

- Freeze scope and supported-version statement; update `CHANGELOG.md`.
- Review migrations, configuration, compatibility, upgrade, rollback, and breaking changes.
- Run clean locked install, full tests/build, migration suites, secret/history/fixture scan,
  dependency/static/license/container scans, and accessibility/e2e as applicable.
- Generate CycloneDX or SPDX SBOM; build immutable versioned images; record source commit and image
  digest; create checksums and signed artifacts/provenance through the approved identity.
- Test a fresh install and previous-supported-version upgrade/rollback in an isolated environment.
- Publish known limitations, threat model changes, passing evidence, and advisories.
- Tag only after approval; never overwrite a tag/artifact. Monitor the release and retain rollback.

Do not run release workflows with secrets for untrusted pull requests. Package, container, Git, and
documentation versions must agree.

## Candidate evidence before authorization

The manual `Release candidate integrity` workflow is a non-publishing evidence builder, not a
release workflow. It accepts only `main` plus the exact non-publishing confirmation, exports local
`linux/amd64` OCI archives, scans them, and signs their provenance/checksum and SBOM relationships
with the GitHub workflow identity. It has no registry, package, release, repository-write,
deployment, or production-secret authority. See `docs/container-integrity.md`.

When hosted execution is unavailable, `pnpm verify:local-candidate` can produce bounded native Linux
ARM64 scan/SBOM evidence from an absolute checksum-verified Trivy 0.72.0 binary. It does not sign,
publish, deploy, contact providers, or replace the hosted workflow's amd64 BuildKit provenance,
embedded SBOM, GitHub identity, and Sigstore attestations. The accepted local result is recorded in
`artifacts/local-native-oci-candidate-runtime-bound-verification-2026-07-30.json`.

Before any future publication, an authorized maintainer must verify the downloaded candidate
checksums and GitHub attestations, inspect the source commit and workflow identity, obtain the
owner's name/license/publication approval, and define the protected registry and environment. The
published image digest must then receive image-level registry attestations and be verified again at
deployment. A candidate archive or successful workflow run does not authorize those actions.
