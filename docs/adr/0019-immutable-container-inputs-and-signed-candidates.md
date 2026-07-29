# ADR 0019: Immutable container inputs and signed non-publishing candidates

Status: accepted  
Date: 2026-07-28

## Context

Exact container tags remain mutable publisher-controlled pointers. Application Dockerfiles,
GitHub-hosted integration services, and local Compose therefore could consume different bytes
without a source change. Existing CI built and scanned local images but loaded them into the Docker
store, which does not retain BuildKit attestations, and no release artifact had verifiable source
provenance.

No public publication, registry, package, or deployment authority has been granted. A source change
must improve reproducibility and create an evidence path without silently creating a release
mechanism or depending on long-lived signing keys.

## Decision

- Pin the Dockerfile frontend and every remote image in application Dockerfiles, Compose, and GitHub
  Actions to a reviewed multi-platform manifest-list SHA-256 digest while retaining its
  human-readable tag.
- Pin every external GitHub Action to a full commit SHA. A repository validator enforces action and
  image pins, restricts images to the explicitly reviewed repository allowlist, and runs inside
  `pnpm verify`.
- Keep weekly Docker, Compose, and GitHub Actions update automation. Digest changes are reviewed
  source changes; mutable upstream movement never enters a build automatically.
- Add a manual, main-branch-only, explicitly confirmed candidate workflow. It builds one
  `linux/amd64` OCI archive per application with BuildKit maximum provenance and SBOM, gates fixed
  High/Critical vulnerabilities, produces a CycloneDX SBOM and checksum manifest, and generates
  GitHub OIDC/Sigstore-signed provenance and SBOM attestations.
- Grant that workflow only repository read, OIDC-token, attestation, and artifact-metadata
  permissions. It may preserve short-lived workflow artifacts but cannot log in to a registry,
  publish a package/image/release, write repository contents, access a deployment environment, or
  deploy.
- Treat an OCI archive attestation as candidate evidence, not production admission. An authorized
  future release must bind the registry image digest to its attestations and verify the expected
  repository/workflow identity before deployment.

## Consequences

The same source now resolves the same reviewed base and service manifests until a digest changes.
The adjacent tag keeps intent understandable, while a source diff and review record every upstream
refresh. Security fixes also stop flowing automatically, so update automation and prompt review are
required.

Candidate provenance uses GitHub's short-lived OIDC identity instead of a repository signing secret.
Its availability depends on the repository's GitHub plan and visibility. The workflow has not been
executed on a hosted runner, and local Docker is unavailable, so its archive, embedded attestations,
vulnerability scan, signed bundles, and verification command remain required external evidence.

The candidate is `linux/amd64` only. Adding another platform requires a reviewed emulation/native
builder, a scan strategy that covers every platform manifest, and updated evidence. No release or
deployment is implied by this decision.

## Alternatives

Exact tags without digests were rejected because they are not immutable. Silently accepting current
tag movement was rejected because it removes source review and an audit trail. A publication-capable
workflow was rejected because the owner has not authorized a registry, public name, release, or
deployment. Long-lived signing keys were rejected because key custody and rotation would add an
unnecessary secret when a bounded workload identity is available. Package-only SBOM generation was
rejected because it omits operating-system packages and does not bind the deployed container.

## Rollback and verification

No database, tenant, or financial-rule behavior changes. Reverting the candidate workflow does not
change a runtime artifact because it never publishes one. Reverting image digests to tag-only
references is not an acceptable rollback; replace an unsuitable digest with a separately reviewed
digest instead.

`pnpm container:check` validates all current Dockerfiles, Compose services, workflow service/command
images, action pins, and the workflow's non-publishing permissions and outputs. `pnpm verify` must
pass after each input update. Hosted verification additionally requires successful candidate builds
and scans, checksum verification, GitHub attestation verification for all three archives, and
inspection of the expected source repository, workflow identity, and commit.
