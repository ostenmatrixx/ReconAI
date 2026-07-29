# ADR 0066: Use incident-aware scanner pins and a bounded local OCI candidate gate

- Status: Accepted
- Date: 2026-07-30

## Context

The non-publishing release-candidate workflow had source-level controls for immutable inputs,
vulnerability scans, SBOMs, checksums, and signed attestations, but it had never run in a hosted
repository. The local application-image proof exercised runtime behavior without exporting or
scanning its exact images.

The first local OCI candidate scan exposed two separate problems:

1. the Node 24.14.0 runtime carried fixed Debian and globally installed package-manager
   vulnerabilities; and
2. Trivy's `--input` path treats an extracted OCI image layout differently from an OCI archive, so
   the workflow's direct archive input was not a valid compatibility assumption for the reviewed
   scanner.

The scanner is itself a high-authority supply-chain input. The March 2026
[Trivy ecosystem incident](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23)
affected a binary release, mutable action tags, and additional container tags. Inheriting a moving
action or scanner default would therefore be inconsistent with ReconAI's immutable-input policy.

## Decision

1. Keep `aquasecurity/trivy-action` at the full immutable v0.36.0 commit
   `ed142fd0673e97e23eac54620cfb913e5ce36c25` and pass the explicit immutable scanner release
   `v0.72.0`. The validator rejects other action commits, missing scanner versions, `latest`, and
   the incident-affected `0.69.4`, `0.69.5`, and `0.69.6` versions.
2. Extract each BuildKit OCI archive into a runner-temporary OCI image layout before both the
   vulnerability and CycloneDX steps. Checksums and attestations remain bound to the original
   archive.
3. Pin application build and runtime stages to the official `node:24.18.0-bookworm-slim`
   multi-platform manifest-list digest
   `sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`. The validator rejects
   Node 24 tags below that reviewed Active LTS patch and ambiguous distribution tags.
4. Remove npm, Corepack, and their command shims from every final runtime stage before copying the
   application. They remain available in the build stage; the long-lived API, worker, and web
   processes require only Node. The validator requires the exact removal boundary.
5. Give the frozen install and API/worker deploy steps the same locked `reconai-pnpm-store` BuildKit
   cache mount. A failed registry transfer may be retried without discarding already verified
   package content; the cache is not copied into a final image. The validator requires the exact
   mount identity, target, lock mode, lifecycle bypass, and command.
6. Provide `pnpm verify:local-candidate` as a non-publishing native verifier. It accepts only an
   absolute external Trivy binary plus its exact SHA-256 digest, requires Trivy 0.72.0, uses
   rootless Podman, hashes the Git-ignore-clean Docker build context, builds native Linux ARM64
   images, exports and validates OCI archives, scans extracted layouts, generates CycloneDX SBOMs,
   and removes exact tags and temporary files.
7. Match the hosted gate: reject fixed High or Critical OS/library findings and record that unfixed
   findings are ignored. A pass is bounded evidence, not a vulnerability-free claim.
8. Do not publish, sign, deploy, contact provider systems, retain raw scan/SBOM files, or infer
   production readiness from the local verifier. Retain only the credential-free summary, hashes,
   tool/database versions, image metadata, counts, cleanup result, and explicit limitations.

## Consequences

The first local gate failed with thirteen fixed High and three fixed Critical findings across the
old Debian base and globally installed npm toolchain. The reviewed Node 24.18.0 base removed the OS
findings; deleting the unneeded runtime package-manager toolchain removed the remaining fixed
library findings.

The final fresh run used checksum-verified Trivy 0.72.0 and a newly downloaded vulnerability
database. API, worker, and web each passed with zero fixed High and zero fixed Critical findings.
They declared user `node`, exposed no forbidden baked environment names, and produced hashed
CycloneDX 1.7 summaries covering 254, 185, and 111 components respectively.

The first post-remediation rebuild encountered a registry timeout after the frozen lockfile passed.
The cache-mount revision then completed the same locked install and let the other service builds and
candidate verifier reuse the exact content. The final scan image identities also matched the
separately tagged images used by the authenticated runtime verifier. Those exact images completed
the Keycloak PKCE/BFF/API/outbox/worker path with the expected deterministic and tenant-isolation
results.

The verifier binds source to a deterministic build-context manifest because this workspace has no
Git HEAD. It does not exercise hosted BuildKit on amd64, embedded attestations, GitHub OIDC,
Sigstore bundles, registry publication, a deployed digest, admission policy, or prior/current
rollout compatibility.

## Alternatives considered

- Keep the action's Trivy 0.70.0 default: rejected because an explicit, newer immutable 0.72.0
  release was available and independently checksum-verifiable.
- Use `latest` to receive scanner updates automatically: rejected because it is mutable and would
  defeat incident-aware review and reproducibility.
- Scan the OCI archive directly: rejected after the reviewed scanner did not identify Podman's OCI
  archive as a supported Docker save archive.
- Install fixed npm packages globally in the runtime image: rejected because the application does
  not need a package manager after construction; removal has less runtime authority and future
  vulnerability surface.
- Ignore the first candidate findings as build tooling: rejected because those packages were present
  in the final runtime filesystem and the gate correctly treated them as candidate risk.
- Retry every failed image build with an empty package store: rejected because a locked cache mount
  preserves verified downloads without weakening the frozen lockfile or adding runtime content.

## Security, tenant, financial, and operational effects

The change reduces final-image software and prevents silent regressions in the Node base, scanner,
action, OCI input form, runtime user, or baked-environment boundary. It adds no application
permission, secret, provider scope, database access, tenant query, money calculation, matching rule,
migration, AI capability, release authority, or deployment authority.

The external Trivy binary review recorded:

- release checksum-manifest SHA-256:
  `ebe9d19a774b950e240b1017a038e9b5a002ea068e02023369ff6d241c10c580`;
- macOS ARM64 archive SHA-256: `88f208680dc05da2b459e19b4f5aa2b4dc7c2117892ba4aab2ae63baba330016`;
- extracted binary SHA-256: `7f8266768e8ba12d17800c67725613855737e9afcfb681ce11f55d7b86632672`.

Evidence: `artifacts/local-native-oci-candidate-runtime-bound-verification-2026-07-30.json` and
`artifacts/container-image-runtime-scan-bound-verification-2026-07-30.json`.

## Rollback

Reverting the Node base or restoring package-manager tooling would reintroduce the observed
candidate findings and is not an acceptable rollback. A future base or scanner change must retain an
immutable reviewed identity, update the enforced boundary and tests, rebuild all candidates, and
produce a fresh passing artifact before it supersedes this decision.
