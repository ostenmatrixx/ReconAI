# Security policy

ReconAI handles operational and financial evidence. Treat suspected vulnerabilities, exposed data,
and credentials as sensitive.

## Supported versions

No production release exists yet. Security fixes target the default branch until the first release.
Before release, this section will list supported semantic-version lines and end-of-support dates.

## Report privately

Do not file a public issue, pull request, discussion, or chat message containing a vulnerability,
customer data, credentials, exploit payload, or production detail.

Until a dedicated security address and private repository reporting are configured, contact the
repository owner through an existing verified private channel. Include:

- affected version/commit and component;
- prerequisites and minimal reproduction using synthetic data;
- impact and tenant/source-system boundary;
- logs or screenshots with secrets and personal/financial data removed;
- suggested mitigation if known; and
- a safe contact method.

Do not access data that is not yours, disrupt service, persist access, exfiltrate data, perform
social engineering, or test production without written authorization.

## Response process (proposed)

Targets—not measured commitments: acknowledge within 3 business days, triage within 7, and provide
status at least every 7 days until remediation or closure. Severity, exploitability, tenant impact,
financial integrity, and disclosure coordination determine priority. The incident procedure is in
`docs/incident-response.md`.

The maintainer will preserve evidence, restrict access, reproduce safely, coordinate a fix and
advisory, rotate affected credentials, and credit reporters who want attribution. Publication timing
is coordinated to protect users.

## Security design

See `docs/threat-model.md`, `docs/privacy-and-retention.md`, and `AGENTS.md`. Core invariants
include tenant-scoped access plus PostgreSQL RLS, integer money, authenticated/idempotent webhooks,
encrypted connector tokens, append-only audit, read-only connectors, and non-authoritative AI.

## Release security gate

Before public release: confirm private reporting, scan full Git history and fixtures, enable
dependency and secret alerts plus push protection where supported, run static/dependency/license/
container scans, generate an SBOM, verify a fresh clone, and publish limitations and threat model.
