# ReconAI governance

ReconAI uses a maintainer-led, evidence-based governance model during its pre-release phase.

## Roles

- Repository owner: final authority for product direction, licensing, name, public release, security
  disclosure, maintainer appointment, production deployment, and irreversible decisions.
- Maintainer: reviews and merges changes, triages issues/security reports, manages releases, and
  protects invariants. Maintainers disclose conflicts and recuse when necessary.
- Contributor: proposes and implements changes under `CONTRIBUTING.md` and `AGENTS.md`.
- Security responder: privately triages vulnerabilities; may be a maintainer or delegated expert.

No current list of named maintainers is published. The repository owner must establish `CODEOWNERS`
and verified private contacts before public release.

## Decision process

Routine, reversible changes use normal review. Consequential or hard-to-reverse architecture,
financial, tenant, security, privacy, dependency, compatibility, governance, or licensing decisions
require an ADR. Proposals include alternatives, operational/security consequences, migration and
rollback, and evidence. The owner resolves deadlocks.

Community feedback informs but does not override the safety boundary. Financial correctness, tenant
isolation, read-only V1, audit immutability, and AI non-authority cannot be weakened through a
routine feature vote.

## Changes to governance

Governance changes require a dedicated pull request, public rationale after release, at least two
maintainer approvals when two unconflicted maintainers exist, and owner approval. Security-response
details may remain private.

## Maintainer lifecycle

New maintainers demonstrate sustained, technically sound, respectful contribution; understand the
threat model; and accept private-reporting duties. The owner appoints and may remove maintainers.
Access is least privilege, MFA-protected, reviewed quarterly, and revoked promptly on departure.

## Releases and publication

Maintainers prepare releases; an authorized owner approves production/publication. The complete
production application and core interfaces remain open source. No maintainer may publish, transfer
packages/domains, make the repository public, or deploy production without explicit authority.

## Conflicts and commercial interests

Decision-makers disclose employer, vendor, investment, or personal interests that could reasonably
affect a decision. They recuse when the conflict is material. Provider neutrality and self-hosting
must not be impaired by undisclosed private infrastructure.
