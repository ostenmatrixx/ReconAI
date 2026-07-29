# ADR 0023: Bounded composite API readiness

Status: accepted  
Date: 2026-07-28

## Context

The API exposed process liveness and a readiness route, but readiness executed only `select 1`
against PostgreSQL. Core ingestion and reconciliation paths also require the Redis authority used by
BullMQ and private immutable object storage. An orchestrator could therefore route work to an API
replica that could query PostgreSQL but could not durably enqueue work or preserve/read source
evidence.

Putting every external integration into readiness would create the opposite failure: an identity
provider, invitation relay, commerce provider, or telemetry collector incident could remove every
otherwise usable API replica. Returning component detail from the public endpoint would also expose
deployment topology and failure information. This decision supersedes only ADR 0018's statement that
readiness traffic executes through the application Redis limiter; its normal-traffic, fail-closed,
HMAC-key, proxy-trust, and independent-edge decisions remain in force.

## Decision

- `/health/live` reports process health only and has no database, Redis, object-storage, identity,
  email, telemetry, or application-limiter dependency.
- `/health/ready` requires concurrent success from PostgreSQL, the Redis deployment used for queue
  and production admission authority, and the configured S3-compatible bucket.
- One validated `API_READINESS_TIMEOUT_MS` value bounds the whole evaluation, the dedicated Redis
  connection/command, the cancellable PostgreSQL query, and the S3 request. The public route catches
  all failures and returns only `{"status":"ready"}` or the same-shape opaque
  `503 {"status":"not_ready"}`.
- Evaluations are single-flight and cached for one second, including failures, to bound
  amplification from orchestrator polling. Readiness bypasses the application Redis limiter so a
  limiter incident is represented as a deterministic 503 instead of preventing the health handler
  from executing; the independent edge health budget remains required.
- Internal transition-only logs use the fixed component names `postgresql`, `redis`, and
  `object_storage`, plus a fixed timeout classification. They contain no endpoint, credential,
  tenant, object key, payload, or raw error.
- The object-store probe uses `HeadBucket`, performs no write/list operation, and requires the API
  bucket credential to have `s3:ListBucket` in addition to the object actions needed by application
  paths.
- OIDC is excluded because bearer verification already fails closed with a bounded remote-JWKS path
  and cached keys may remain usable during a provider interruption. Invitation email is replaceable
  and non-core. Provider APIs are used by durable workers, not API request admission. OTLP is
  explicitly non-blocking so telemetry loss cannot alter financial work.

## Consequences

The scheduler/load balancer can stop new traffic to an API replica whenever the database, Redis
authority, or evidence store is unusable while avoiding restart storms for a live process. Readiness
never grants tenant or financial authority and does not replace authenticated connector health,
queue-age/DLQ monitoring, migration checks, or synthetic transaction tests.

The one-second failure cache deliberately delays recovery visibility by at most that interval. Each
API replica opens one additional bounded Redis connection. S3 deployments must grant the narrow
bucket-level action required by `HeadBucket`; a policy that omits it keeps the replica not ready
even if known-object reads would otherwise succeed.

## Alternatives

PostgreSQL-only readiness was rejected because it admitted replicas unable to enqueue or preserve
evidence. A write/delete S3 canary was rejected because health polling must not mutate evidence
storage. Probing every provider, OIDC, email, and OTLP was rejected because it couples core API
availability to optional or independently bounded services. Returning component details publicly was
rejected as unnecessary topology disclosure. Keeping readiness behind the Redis application limiter
was rejected because the handler could not represent that exact dependency failure.

## Migration, rollback, and verification

No database, tenant data, financial rule, connector, or queue schema changes are introduced.
Deployments add one API configuration value and one Redis connection and must add `s3:ListBucket`
for the exact private bucket before enabling the new image. Rollback removes the composite probe and
that permission, but restores the unsafe PostgreSQL-only admission signal; use load-balancer
dependency checks as a compensating control during any rollback.

Synthetic tests cover all-healthy, false, thrown, timeout/abort, cache, concurrent single-flight,
recovery, opaque 503, and liveness independence. A local real API process with all three
dependencies absent returned liveness 200 and readiness 503 and emitted only fixed internal
classifications. A later checksum-pinned exercise ran two API replicas against live PostgreSQL,
Redis, and MinIO: independent transport loss for each dependency made both replicas fail readiness
closed while preserving liveness, then both recovered with the expected redacted transition
sequence. Dependency process crashes, cross-host partitions, edge/scheduler polling, and alert
delivery remain staging requirements.
