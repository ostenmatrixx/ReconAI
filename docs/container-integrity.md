# Container and release-candidate integrity

Last reviewed: 2026-07-30

ReconAI treats container images and the Dockerfile frontend as executable supply-chain inputs. Every
remote image in an application Dockerfile, Compose, or a GitHub Actions service/command must retain
a human-readable tag and an immutable lowercase SHA-256 digest. Every external GitHub Action must
use a full commit SHA. `pnpm container:check`, included in `pnpm verify`, enforces this policy and
the non-publishing boundary described below. It also rejects any Redis input below the reviewed
8.2.8 security patch so a tag/digest edit cannot silently restore the known-vulnerable version. Only
the seven repositories in the reviewed input ledger are allowed; adding another publisher requires
an explicit policy and documentation change.

Digest pinning makes an input reproducible; it does not prove that the publisher is trustworthy or
that the image remains free of newly disclosed vulnerabilities. Dependabot proposes reviewed digest
updates. Reviewers must confirm the expected publisher, tag, manifest platforms, release notes,
license, vulnerability result, and official-registry digest before accepting an update. Retaining
the tag next to the digest makes that review legible without restoring tag mutability.

The application Node input must also remain on the reviewed Node 24 Active LTS line at or above
24.18.0 with the exact `bookworm-slim` distribution. Final runtime stages remove npm, Corepack, and
their command shims because the long-lived services require Node but no package manager. The
container validator enforces both boundaries.

The ordinary quality, browser, and supply-chain CI jobs also select exact Node 24.18.0, and the
container matrix uses the same immutable Trivy action v0.36.0 commit plus explicit Trivy 0.72.0 as
the candidate workflow. The quality job runs the mixed 100,000-record reconciliation verifier as a
correctness regression; its host-dependent durations are informational and cannot fail a release on
a timing threshold. `pnpm container:check` rejects stale/ambiguous workflow Node versions, inherited
Trivy defaults, mutable scanner versions, and the March 2026 incident-affected releases.

## Git-free build lifecycle boundary

`.dockerignore` excludes Git metadata from every application build context. The locked workspace
install and API/worker production deployment still run package lifecycle scripts, including the root
`prepare` hook. `scripts/install-hooks.mjs` skips only repository-hook installation when `LEFTHOOK`
is exactly `0`; otherwise it executes Lefthook and propagates failure.

Each Dockerfile scopes that value directly to its locked install. API and worker separately scope it
to `pnpm deploy`, whose release installation runs `prepare` again. `ENV LEFTHOOK`, `ARG LEFTHOOK`,
`--ignore-scripts`, altered or duplicate install commands, and unscoped deploy commands fail
`pnpm container:check`. Ordinary `pnpm prepare` continues to install all three repository hooks.
This boundary is defined by ADR 0063.

The install and deploy lifecycle commands share one locked BuildKit cache mount at `/pnpm/store`.
This preserves already verified package content across transient registry failures and serializes
writers, while the frozen lockfile remains authoritative and the cache is absent from final image
layers. `pnpm container:check` requires the exact cache identity, target, sharing mode, scoped
lifecycle bypass, and command; ADR 0066 records the resilience revision.

A rootless Linux ARM64 exercise built all three images and ran them on the private local dependency
network. A fresh run completed real Keycloak authorization code plus PKCE through the production web
image over one-run TLS, explicit tenant selection, authenticated BFF run creation/detail, the image
API/outbox/worker path, foreign-tenant denial, and tenantless RLS checks. Application containers ran
as UID 1000 with capabilities dropped and no-new-privileges. The exercise is bounded local evidence,
not the workflow's amd64 candidate/scan/SBOM/attestation, trusted ingress/IdP, or protected-staging
result. The post-remediation rerun is recorded in
`artifacts/container-image-runtime-scan-bound-verification-2026-07-30.json` and ADR 0065.

The same verifier uses explicit per-service environment allowlists and inspects the live container
configuration. API receives only its application database role and public OIDC verification inputs;
worker receives only its worker role and no API/web/email/support authority; web receives no
database, object-storage, connector, operational, or AI credential. API and worker independently
strip unrelated injected inputs from their parsed configuration. `pnpm container:check` also rejects
either long-lived entrypoint if it imports the full-stack compatibility parser or the wrong service
parser. ADR 0064 defines this credential projection and parsing boundary.

## Local native candidate evidence

`pnpm verify:local-candidate` provides a bounded non-publishing fallback when the hosted candidate
workflow is unavailable. It requires an absolute externally verified Trivy binary and exact binary
SHA-256, accepts only Trivy 0.72.0, uses rootless Podman, and:

1. hashes the exact Git-ignore-clean files included by the Docker build context;
2. builds API, worker, and web for native `linux/arm64` with missing-only base pulls;
3. exports and validates OCI archives, rejects unsafe archive members, and scans extracted OCI
   layouts;
4. rejects fixed High or Critical OS/library findings while recording the matching `ignore-unfixed`
   boundary;
5. generates and hashes CycloneDX SBOMs; and
6. removes exact candidate tags and its isolated registry/scanner temporary directory.

The accepted 2026-07-30 run used checksum-verified Trivy 0.72.0 and a fresh vulnerability database.
All three candidates declared user `node`, exposed no forbidden baked environment names, and
reported zero fixed High and zero fixed Critical findings. The hashed CycloneDX 1.7 summaries
covered 254 API, 185 worker, and 111 web components. Evidence:
`artifacts/local-native-oci-candidate-runtime-bound-verification-2026-07-30.json`; decision:
ADR 0066. The candidate image identities exactly match the separate authenticated post-remediation
runtime artifact.

This is native Linux ARM64 evidence bound to a deterministic source manifest because the repository
has no Git HEAD. It is not the hosted BuildKit linux/amd64 workflow, embedded provenance/SBOM,
GitHub OIDC/Sigstore attestation, registry publication, deployment admission, or a
vulnerability-free/production-readiness claim.

## Reviewed input ledger

The following multi-platform manifest-list digests were resolved from the Docker Hub or Quay
Registry V2 APIs on 2026-07-28, with the Node security-baseline refresh resolved on 2026-07-30. They
apply across the listed platform set; the non-publishing candidate workflow currently builds
`linux/amd64` only.

| Input tag                                          | Immutable manifest-list digest                                            | Reviewed platforms                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `docker/dockerfile:1.7`                            | `sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e` | 386, amd64, arm/v7, arm64, mips variants, ppc64le, riscv64, s390x |
| `node:24.18.0-bookworm-slim`                       | `sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` | amd64, arm64/v8, ppc64le                                          |
| `postgres:17.6-alpine3.22`                         | `sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94` | amd64, 386, arm/v6, arm/v7, arm64/v8, ppc64le, riscv64, s390x     |
| `redis:8.2.8-alpine`                               | `sha256:a7859ed111db3c1f5404a973a4747505d559fb5ca32d37e447afc0ef845a2103` | amd64, 386, arm/v6, arm/v7, arm64/v8, ppc64le, riscv64, s390x     |
| `quay.io/minio/minio:RELEASE.2025-07-23T15-54-02Z` | `sha256:d249d1fb6966de4d8ad26c04754b545205ff15a62e4fd19ebd0f26fa5baacbc0` | amd64, arm64, ppc64le                                             |
| `quay.io/minio/mc:RELEASE.2025-07-21T05-28-08Z`    | `sha256:fb8f773eac8ef9d6da0486d5dec2f42f219358bcb8de579d1623d518c9ebd4cc` | amd64, arm64, ppc64le                                             |
| `quay.io/keycloak/keycloak:26.7.0`                 | `sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13` | amd64, arm64, ppc64le                                             |

Docker documents that digest references select immutable image content and that pins need deliberate
security updates: [pull by digest](https://docs.docker.com/reference/cli/docker/image/pull/) and
[build best practices](https://docs.docker.com/build/building/best-practices/).

Redis 8.2.8 replaces 8.2.1 because the current 8.2 patch carries security fixes for crafted
`RESTORE` payloads that may lead to remote code execution. The tag and manifest-list digest above
were resolved independently through the Docker Registry V2 API; the official
[8.2.8 release](https://github.com/redis/redis/releases/tag/8.2.8) and
[Redis security advisory](https://redis.io/blog/security-advisory-cve202623479-cve202625243-cve-2026-25588-cve202625589-cve-2026-23631/)
are the review basis.

## Non-publishing candidate workflow

`.github/workflows/release-candidate.yml` can be manually dispatched only from `main` with the exact
confirmation `BUILD-NON-PUBLISHING-CANDIDATE`. For each application it:

1. builds a local `linux/amd64` OCI archive from digest-pinned inputs with BuildKit maximum
   provenance and an embedded SPDX SBOM attestation;
2. extracts a runner-temporary OCI layout and rejects fixed High or Critical
   operating-system/library vulnerabilities with explicit Trivy 0.72.0;
3. produces an external CycloneDX image SBOM and SHA-256 checksum manifest;
4. uses the GitHub OIDC identity and `actions/attest` to create signed SLSA build-provenance and
   SBOM attestations over the local candidate archive; and
5. retains the archive, SBOM, checksum manifest, and Sigstore bundles as 30-day workflow artifacts.

The workflow has no package, repository-write, release, deployment, registry-login, or production
secret permission. It explicitly sets `push: false`, exports an OCI archive, and never creates a
tag, release, registry artifact, or deployment. The repository validator rejects attempts to weaken
those boundaries. Both scanner steps use the immutable Trivy action v0.36.0 commit; the first
installs the explicit immutable scanner and the second reuses that installation. The March 2026
[Trivy ecosystem advisory](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23)
is the basis for rejecting mutable/default and incident-affected scanner identities.

GitHub artifact attestations use a short-lived Sigstore certificate and can be verified with the
GitHub CLI. They are available for public repositories on current plans and for private/internal
repositories on GitHub Enterprise Cloud; this candidate workflow has no successful hosted
build/attestation execution evidence yet. See the official
[artifact-attestation guide](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
and [`actions/attest`](https://github.com/actions/attest).

## Verification and promotion boundary

After downloading one candidate artifact from the expected repository, main-branch commit, and
workflow run:

```sh
cd artifacts/release-candidate/api
sha256sum --check SHA256SUMS
gh attestation verify image.oci.tar --repo OWNER/REPOSITORY
```

Repeat for `worker` and `web`; inspect the verified subject digest, workflow identity, source
commit, SBOM, BuildKit provenance, and vulnerability result. A downloaded bundle is retained for
evidence, but the verifier must trust only the expected GitHub owner/repository identity.

This candidate is not a production release. Publishing, multi-platform expansion, registry naming,
tagging, environment approval, and deployment remain owner-authorized future actions. An approved
publication flow must push the already scanned image by immutable digest, attach image-level
provenance/SBOM in the registry, verify the signer/workflow identity before deployment, record the
resolved deployment digest, and fail closed on missing or invalid evidence.
