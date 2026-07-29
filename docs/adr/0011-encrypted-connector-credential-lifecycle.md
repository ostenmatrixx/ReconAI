# ADR 0011: tenant-bound connector credential envelopes

Status: accepted  
Date: 2026-07-28

## Context

ReconAI needs separate Shopify/Stripe webhook-signing and read-API authorities. Environment
references are useful for local and externally managed deployments, but they do not provide an
application-visible rotation ledger, tenant binding, replay protection, or a safe administrator
disconnect flow. Accepting raw provider credentials in the browser or JSON API would expand the
credential exposure boundary.

## Decision

- Raw provider credentials are sealed locally with AES-256-GCM. The versioned envelope authenticates
  the organization, connection, provider, purpose, and key version as additional data.
- `CONNECTOR_ENCRYPTION_KEYS` maps versions to allowlisted `env:RECONAI_CONNECTOR_ENCRYPTION_KEY_*`
  references. One separately configured version is active for new envelopes; retained versions can
  decrypt existing envelopes during key rotation.
- The sealing CLI reads the provider credential only from standard input. It never accepts the
  credential as an argument. The browser and API receive only the sealed JSON envelope.
- `connector_credentials` is tenant-scoped under forced RLS. Ciphertext and authority fields are
  immutable; one active row exists per connection and purpose; retirement is append-only as
  `superseded` or `revoked`.
- Installation validates and opens the envelope before persistence, rechecks its exact provider and
  tenant connection under a lock, atomically retires the prior active version, updates the
  connection to a `sealed:<credential-id>` reference, and writes redacted audit metadata.
- Exact-envelope replay is idempotent only while that row remains active. Reuse after retirement or
  against another target fails closed.
- API and worker resolution rechecks the active credential row, connection reference, provider,
  purpose, and tenant RLS context before decryption. Legacy allowlisted environment references
  remain supported for migration and externally managed secret stores.
- Disconnect requires the exact connection ID and an audit reason. It revokes all active credential
  rows, clears legacy/sealed references and cursors, and marks the connection `disconnected`.

## Consequences

Provider plaintext stays in the local sealing process and the minimum server-side request that uses
it. Database disclosure alone does not reveal the credential without an encryption key, and moving
ciphertext across tenants, connections, providers, purposes, or key versions invalidates
authentication. Audit and health APIs expose metadata only.

Key material is still supplied to API/worker processes through an operator's secret manager or
file/environment injection. This is not an HSM/KMS remote-cryptography adapter. Actual provider
OAuth installation, least-scope approval, and provider-side token revocation remain separate work. A
provider request already in flight when disconnect commits may finish.

## Alternatives

Storing plaintext, accepting raw credentials in the web UI, or putting credentials in command
arguments was rejected. Storing only opaque external references remains supported but cannot by
itself provide ReconAI's lifecycle evidence. A mandatory cloud KMS was rejected as the only
implementation because the open-source self-hosted baseline must remain replaceable.

## Migration and rollback

Migration 0032 adds the credential table, RLS, constraints, lifecycle triggers, narrow role grants,
and sealed-reference support without changing existing connection references. Existing deployments
remain on their environment references until an administrator installs a sealed envelope.

Application rollback must stop new lifecycle mutations and may run the previous compatible
application while the additive table remains dormant. Do not delete credential evidence or run a
destructive down migration. Disconnect or remove provider egress through an approved operator path
if containment is required.
