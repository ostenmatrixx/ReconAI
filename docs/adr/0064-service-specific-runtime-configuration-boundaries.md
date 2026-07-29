# ADR 0064: Parse and inject runtime configuration by service authority

- Status: Accepted
- Date: 2026-07-30

## Context

The API and worker entrypoints both parsed one full-stack configuration object. That schema required
the API database URL, worker database URL, confidential web OIDC client secret, session secret, and
settings owned by unrelated services even though neither entrypoint used all of them. The
environment reference documented the intended narrower ownership, but runtime validation did not
enforce it.

The first application-image runtime harness mirrored the same mistake by spreading all values from
`.env.example` into every container. The deterministic run passed, but that execution could not
serve as least-privilege evidence: API, worker, and web each received credentials or authorities
they did not need.

## Decision

1. `packages/config` exports separate `parseApiRuntimeConfig` and `parseWorkerRuntimeConfig`
   entrypoints. Each schema contains only fields read by that service. Unknown inputs are discarded
   and do not become part of the returned configuration object.
2. API requires only `DATABASE_URL`; worker requires only `DATABASE_WORKER_URL`. Neither parser
   accepts administrator, migration, or maintenance database URLs. API does not accept the worker
   role, web OIDC client secret, session secret, or AI credential. Worker does not accept the API
   role, OIDC/session, invitation-email, support, API-rate-limit, or AI authority.
3. Shared object-storage, telemetry, connector-key-reference, and production controls are validated
   by common code. API-only email, support, rate-limit, proxy, and identity controls and worker-only
   queue, provider-circuit, gap-repair, and privacy-monitor controls remain service-local.
4. Provider authorization is capability-specific. API startup requires the full app-level Stripe
   authorization and webhook authority when enabled; worker startup requires only the client
   authority used for token refresh. Both retain read-only Shopify scope validation.
5. The full `parseRuntimeConfig` entrypoint remains for bounded local fixture and compatibility
   tooling, but long-lived API and worker processes must not call it.
6. Deployment manifests and verification harnesses must inject explicit service allowlists. The
   image-runtime verifier inspects live container environments and fails if peer database roles,
   administrative roles, session/OIDC client secrets, or other named unrelated authorities are
   present.
7. The default `pnpm container:check` gate reads both long-lived entrypoints and rejects the
   full-stack compatibility parser or the wrong service parser.

Dynamic connector secrets referenced by the allowlisted `CONNECTOR_ENCRYPTION_KEYS` mapping remain
available through the process environment because their names are connection-specific. The mapping
continues to restrict which encryption-key environment variables may be resolved; provider
connection references retain their existing scoped resolver and lifecycle controls.

## Consequences

A missing peer-service secret can no longer prevent an otherwise valid API or worker startup.
Conversely, injecting an unused value does not make that value available through the parsed service
configuration. Tests prove each service starts from its own database role without the peer role or
web/admin authority and that service-specific production checks still apply.

Operators must maintain separate secret projections for web, API, worker, migrations, maintenance,
and test/bootstrap tooling. A single full-stack secret bundle is no longer an acceptable
application-container interface.

The corrected rootless ARM64 proof observed the allowlisted variable names on all three live
containers. API received only its application role; worker received only its worker role; web
received no database, object-storage, connector, email, support, or AI credential. The same
synthetic eight-input reconciliation completed with tenant denial, RLS, occurrence snapshots,
outbox, worker, and audit assertions intact.

## Alternatives considered

- Keep one schema and rely on application code not to read unused fields: rejected because unused
  secrets would still be required, parsed, and routinely injected.
- Make every full-stack field optional: rejected because the service that owns a field must still
  fail closed when its required authority or security control is absent.
- Share one deployment secret across all containers: rejected because compromise of one service
  would expose unrelated database roles and web or operational authority.
- Validate only the deployment manifest: rejected because application startup and runtime inspection
  provide independent boundaries against drift.

## Security, tenant, financial, and operational effects

This is a privilege-reduction change. It does not alter tenant resolution, RLS predicates, money,
matching rules, audit semantics, migrations, provider write authority, or AI behavior. The
deterministic result remained ruleset 1.5.0 with three matches, one evidence-backed exception, and
zero errors.

The local proof uses synthetic credentials and fixtures only. It does not prove production secret
manager policy, orchestrator identity, managed-service ACLs, protected staging, mixed-image rollout,
or production readiness. Evidence: `artifacts/container-image-runtime-verification-2026-07-30.json`.

## Rollback

Reverting to the full-stack parser or a shared secret projection would broaden credential exposure
and requires a new security decision. Application rollback should instead use a prior image whose
service-specific required variables are still available. No data or migration rollback follows from
this decision.
