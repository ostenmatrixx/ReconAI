# Deployment

No production deployment is authorized or present. This is the required deployment process.

## Environments

Development, test, staging, and production have separate identities, credentials, databases,
buckets, queues, OIDC clients, encryption keys, domains, and telemetry. Never promote a mutable
database or customer payload between environments. Staging uses synthetic/provider-sandbox data.

## Build and artifact gate

From a clean locked install: formatting, lint, typecheck, unit/integration/tenant/invariant/e2e/
accessibility tests; migration validation; dependency/secret/static/license/container scans; build;
SBOM; immutable image digest; checksums/signatures/provenance. Untrusted pull requests cannot access
deployment secrets or protected environments.

The repository's manual candidate workflow produces signed local OCI archives only. Before an
authorized deployment, verify `SHA256SUMS` and the GitHub attestations against the expected
owner/repository and main-branch workflow identity, then verify the separately authorized registry
image's exact digest and image-level attestations. Never deploy from a mutable tag, an unattested
digest, a candidate archive with a mismatched source identity, or a workflow artifact alone. See
`docs/container-integrity.md`.

## Change plan

Every production change includes owner approval, linked goal/release, exact image digests,
configuration diff without values, expansion/contraction migration and estimated impact, backup
prerequisite, compatibility window, rollback trigger/steps, health/smoke plan, operator/incident
owner, and communication plan.

## Order

1. Verify backup/replication and capacity; freeze conflicting operations.
2. Validate the edge configuration, public-boundary forwarding-header overwrite, direct-peer proxy
   CIDRs, shared limiter key distribution, and dedicated Redis connectivity without printing secret
   values. If another approved proxy precedes Nginx, prove its exact `set_real_ip_from` allowlist
   before accepting `$remote_addr` as authority. Validate the exact Keycloak back-channel URL, `sid`
   support, signing algorithm, and shared web-session revocation namespace. Confirm the API S3
   credential has `s3:ListBucket` only on the configured private bucket for the read-only readiness
   probe, plus the separately required tenant-object actions. Validate the fixed HTTPS OTLP
   collector origin, private authentication boundary, egress rule, backend retention/access policy,
   and telemetry-silence alert.
3. Apply backward-compatible migration using the migration role and record checksum/duration.
4. Deploy workers in a queue-compatible order, then API/web; use canary/rolling strategy. Do not mix
   limiter keys across API replicas.
5. Check liveness/readiness, migration version, queue age/DLQ, errors, connector health, rate-limit
   store health, API/job metrics, traces, and collector rejected/dropped telemetry.
6. Run tenant-safe smoke tests: authenticate, read own organization, import synthetic preview,
   deterministic reconciliation replay, exception review without external write.
7. Exercise a bounded 429 at the edge and application layers from an approved test address. Send
   forged forwarding headers through every ingress hop, prove that they cannot split either budget,
   verify the selected address without recording the raw chain, then observe the defined window and
   record evidence. Explicitly close or roll back.
8. End a synthetic Keycloak session outside ReconAI, verify the old cookie is rejected by every web
   replica, then prove a later login works. Do not capture the cookie or Logout Token.

For migration 0043, record a current backup/replication check before the additive empty-table
creation, then deploy new workers before the API/web evidence reader. Old workers may write
occurrences without snapshots during the compatibility window; these are deliberately labeled as
legacy current projections. Record the worker cutover time, drain older workers, and monitor both
missing-snapshot queries in ADR 0028 until they remain zero for post-cutover runs. Do not backfill
from mutable current artifacts or remove the compatibility path during the same release.

## Rollback

Stop/circuit new work if integrity or isolation may be affected. Revert application images first
when schema remains backward compatible. Do not down-migrate destructively. For incompatible data,
activate the prewritten forward fix or restore procedure in an isolated environment before any
production replacement. Preserve evidence and audit incident actions.

## Health acceptance

Required: no critical security/error signal; correct build/migration versions; API readiness
simultaneously proves PostgreSQL/Redis/object storage and remains opaque publicly; web readiness;
queue processing without age growth; no unexpected DLQ/retry rise; connector freshness normal or
explicitly degraded; database/object/Redis healthy; one shared request budget across API replicas;
spoofed forwarding headers ignored; smoke replay identical; alerts operational. Targets are not
claims until linked deployment evidence exists.

## Session-revocation rollback

Do not switch production web replicas to the local store during Redis or IdP incidents. Keep
liveness independent, drain authenticated traffic if the distributed revocation authority cannot be
checked, restore it, and exercise cross-replica old-cookie rejection before reopening. Rotate
`SESSION_SECRET` only with a coordinated drain/restart because it invalidates all cookies and
changes pseudonymous revocation indexes. See `docs/session-revocation.md`.

## Request-perimeter rollback

Do not remove the edge limiter or switch production to the local store to recover a Redis incident.
Keep liveness available, stop or drain normal admission if necessary, restore the dedicated Redis
path, and verify one shared counter before returning replicas. If a proxy topology change selects
the wrong client address, remove the new traffic path or restore the prior exact allowlist; never
temporarily trust the public address space. Limiter-key rotation resets counters and must use a
coordinated restart/drain behind the still-active edge budget.

## Observability rollback

Do not remove production telemetry configuration or point it at an insecure endpoint to recover a
collector incident. Preserve financial processing, restore the private collector/backend path, and
use the external telemetry-silence alert plus application health to bound the incident. A telemetry
SDK rollback is an application-image rollback; keep the collector compatible with both image
versions during the window. Exercise flush behavior with the real termination grace period before
closing the change. See `docs/observability.md`.
