# Environment variable reference

`.env.example` contains safe local values or placeholders. `.env`, `.env.*`, credentials, tokens,
and production payloads are never committed. Runtime schemas reject missing/invalid values and
production use of local placeholders.

| Variable                                         | Scope             | Secret        | Purpose                                                       |
| ------------------------------------------------ | ----------------- | ------------- | ------------------------------------------------------------- |
| `NODE_ENV`                                       | all               | no            | `development`, `test`, or `production`                        |
| `APP_ENV`                                        | all               | no            | isolated environment namespace                                |
| `WEB_ORIGIN`                                     | web/api           | no            | exact browser origin and CSRF allowlist                       |
| `NEXTAUTH_URL`                                   | web               | no            | canonical auth origin; must equal `WEB_ORIGIN` in production  |
| `API_ORIGIN`                                     | web               | no            | server-side API base; browser exposure is separately explicit |
| `API_HOST`, `API_PORT`, `PORT`                   | each app          | no            | bounded service listen interface/port                         |
| `API_READINESS_TIMEOUT_MS`                       | api               | no            | whole PostgreSQL/Redis/object readiness budget; 100–5,000 ms  |
| `API_TRUST_PROXY_CIDRS`                          | api               | no            | at most 16 exact trusted proxy IP/CIDR entries                |
| `API_RATE_LIMIT_STORE`                           | api               | no            | `local` outside production; production requires `redis`       |
| `API_RATE_LIMIT_KEY_SECRET`                      | api               | yes           | canonical base64url encoding of 32–64 random bytes            |
| `API_RATE_LIMIT_REDIS_CONNECT_TIMEOUT_MS`        | api               | no            | bounded dedicated limiter connection timeout; 100–5,000 ms    |
| `API_RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS`        | api               | no            | bounded limiter command timeout; 50–5,000 ms                  |
| `RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS`      | api               | no            | run-authority transaction limit; 5,000–120,000 ms             |
| `RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS` | api               | no            | per-process run-authority admission cap; 1–10                 |
| `DATABASE_URL`                                   | api               | yes           | tenant-RLS application PostgreSQL connection                  |
| `DATABASE_WORKER_URL`                            | worker            | yes           | worker role; relay and tenant-scoped processing               |
| `DATABASE_MAINTENANCE_URL`                       | maintenance CLI   | yes           | execute-only bounded repair role; never an app runtime URL    |
| `DATABASE_MIGRATION_URL`                         | migration command | yes           | schema owner used only for controlled migrations              |
| `DATABASE_ADMIN_URL`                             | local tests only  | yes           | bootstrap/adversarial integration-test authority              |
| `REDIS_URL`                                      | web/api/worker    | yes           | private revocation/queue/cache connection                     |
| `DURABLE_QUEUE_MONITOR_INTERVAL_MS`              | worker            | no            | queue telemetry cadence; 1,000–300,000 ms                     |
| `DURABLE_QUEUE_MONITOR_REDIS_CONNECT_TIMEOUT_MS` | worker            | no            | dedicated monitor connect timeout; 100–5,000 ms               |
| `DURABLE_QUEUE_MONITOR_REDIS_COMMAND_TIMEOUT_MS` | worker            | no            | monitor command timeout; 50–5,000 ms, no longer than cadence  |
| `PROVIDER_CIRCUIT_REDIS_CONNECT_TIMEOUT_MS`      | worker            | no            | dedicated circuit Redis connect timeout; 100–5,000 ms         |
| `PROVIDER_CIRCUIT_REDIS_COMMAND_TIMEOUT_MS`      | worker            | no            | circuit command timeout; 50–5,000 ms                          |
| `PROVIDER_CIRCUIT_FAILURE_THRESHOLD`             | worker            | no            | consecutive transient failures before opening; 1–20           |
| `PROVIDER_CIRCUIT_OPEN_MS`                       | worker            | no            | open interval; 1,000–900,000 ms                               |
| `PROVIDER_CIRCUIT_PROBE_LEASE_MS`                | worker            | no            | one half-open probe lease; 1,000–60,000 ms                    |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`          | api/worker        | endpoint no   | S3-compatible private storage                                 |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`       | api/worker        | yes           | least-privilege object credentials                            |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`                  | web/api           | client ID no  | standards-based identity                                      |
| `OIDC_CLIENT_SECRET`                             | web only          | yes           | confidential OIDC client                                      |
| `OIDC_ID_TOKEN_SIGNING_ALGORITHM`                | web               | no            | exact asymmetric ID/logout-token algorithm                    |
| `OIDC_ACR_VALUES`                                | web               | no            | optional bounded canonical OIDC step-up request               |
| `SUPPORT_ACCESS_ENABLED`                         | api               | no            | restricted diagnostics; defaults to false                     |
| `SUPPORT_OIDC_GROUP`                             | api               | no            | exact signed group required for support identity              |
| `SUPPORT_OIDC_AUTHENTICATION_CONTEXT`            | api               | no            | exact signed `acr` required for approved MFA assurance        |
| `SUPPORT_IDENTITY_HMAC_KEY`                      | api               | yes           | dedicated 32–64 byte base64url OIDC identity-index key        |
| `SESSION_SECRET`                                 | web               | yes           | high-entropy session/auth library secret                      |
| `SESSION_COOKIE_SECURE`                          | web               | no            | true in HTTPS production; false for loopback HTTP only        |
| `SESSION_REVOCATION_STORE`                       | web               | no            | `local` outside production; production requires `redis`       |
| `SESSION_REVOCATION_REDIS_CONNECT_TIMEOUT_MS`    | web               | no            | bounded revocation connection timeout; 100–5,000 ms           |
| `SESSION_REVOCATION_REDIS_COMMAND_TIMEOUT_MS`    | web               | no            | bounded revocation command timeout; 50–5,000 ms               |
| `RECONAI_DEFAULT_ORGANIZATION_ID`                | web development   | no            | optional local fallback; ignored in production                |
| `CONNECTOR_ENCRYPTION_KEYS`                      | api/worker/CLI    | no            | version-to-allowlisted-key-reference mapping                  |
| `CONNECTOR_ENCRYPTION_ACTIVE_KEY_VERSION`        | api/worker/CLI    | no            | key version used for newly sealed credentials                 |
| `RECONAI_CONNECTOR_ENCRYPTION_KEY_*`             | api/worker/CLI    | yes           | 32-byte base64url AES-GCM keys supplied by secret manager     |
| `SHOPIFY_OAUTH_ENABLED`                          | api/web           | no            | enables Shopify OAuth; defaults to false                      |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`     | api               | secret varies | app identity; secret also signs app-level privacy webhooks    |
| `SHOPIFY_OAUTH_SCOPES`                           | api               | no            | comma-separated allowlisted read scopes                       |
| `SHOPIFY_API_VERSION`                            | api               | no            | pinned quarterly Admin API version                            |
| `STRIPE_OAUTH_ENABLED`                           | api/web           | no            | enables Stripe Apps OAuth; defaults to false                  |
| `STRIPE_OAUTH_CLIENT_ID`                         | api               | no            | Stripe Apps OAuth client ID                                   |
| `STRIPE_OAUTH_SECRET_KEY`                        | api               | yes           | Stripe OAuth token-exchange/refresh authority                 |
| `STRIPE_APP_ID`                                  | api               | no            | fixed Stripe App identifier used in settings URL              |
| `STRIPE_APP_WEBHOOK_SECRET`                      | api               | yes           | app-level deauthorization endpoint signing secret             |
| `RECONAI_CONNECTOR_*`                            | api/worker        | yes           | distinct per-connection signing or read secret by reference   |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                    | api/worker        | config        | fixed collector origin; required HTTPS in production          |
| `OTEL_TRACE_SAMPLE_RATIO`                        | api/worker        | no            | bounded 0–1 local sampling decision                           |
| `OTEL_METRIC_EXPORT_INTERVAL_MS`                 | api/worker        | no            | bounded OTLP metric push interval                             |
| `OTEL_EXPORT_TIMEOUT_MS`                         | api/worker        | no            | bounded per-export/flush timeout                              |
| `EMAIL_PROVIDER`                                 | api               | no            | `disabled` or replaceable `http_webhook` relay                |
| `EMAIL_WEBHOOK_URL`, `EMAIL_FROM`                | api               | config        | bounded invitation email relay endpoint/sender                |
| `EMAIL_DELIVERY_TOKEN`                           | api               | yes           | relay bearer; never sent to web or written to logs            |
| `EMAIL_REQUEST_TIMEOUT_MS`                       | api               | no            | bounded invitation relay timeout                              |
| `PROVIDER_GAP_REPAIR_ENABLED`                    | worker            | no            | opt-in periodic read-only repair scheduler                    |
| `PROVIDER_GAP_REPAIR_INTERVAL_MS`                | worker            | no            | repair cadence; one minute to one day                         |
| `PROVIDER_GAP_REPAIR_LOOKBACK_MS`                | worker            | no            | bounded repair history; at most 30 days                       |
| `PROVIDER_GAP_REPAIR_OVERLAP_MS`                 | worker            | no            | dedupe-safe overlap; less than lookback                       |
| `PROVIDER_GAP_REPAIR_MAXIMUM_PAGES`              | worker            | no            | automatic run ceiling; 1–25 pages                             |
| `PROVIDER_GAP_REPAIR_BATCH_SIZE`                 | worker            | no            | connections examined per scan; 1–100                          |
| `PROVIDER_PRIVACY_DEADLINE_MONITOR_ENABLED`      | worker            | no            | deadline escalation monitor; defaults true                    |
| `PROVIDER_PRIVACY_DEADLINE_MONITOR_INTERVAL_MS`  | worker            | no            | escalation scan cadence; one minute to one day                |
| `PROVIDER_PRIVACY_DEADLINE_MONITOR_BATCH_SIZE`   | worker            | no            | privacy requests examined per scan; 1–500                     |
| `AI_ENABLED`                                     | config/tooling    | no            | reserved global kill switch; default false                    |
| `AI_PROVIDER`, `AI_MODEL`                        | config/tooling    | no            | reserved provider adapter/version                             |
| `AI_API_KEY`                                     | config/tooling    | yes           | reserved; no long-lived app currently receives it             |
| `AI_REQUEST_TIMEOUT_MS`, `AI_MAX_COST_MINOR`     | config/tooling    | no            | reserved bounded policy inputs                                |

The source-classification repair command also requires
`SOURCE_CLASSIFICATION_REPAIR_EXPECTED_DATABASE_SYSTEM_IDENTIFIER`,
`SOURCE_CLASSIFICATION_REPAIR_REQUESTED_BY`, `SOURCE_CLASSIFICATION_REPAIR_REASON`, and the exact
`SOURCE_CLASSIFICATION_REPAIR_CONFIRMATION`. Its optional batch count is 1–100, zero-gap enforcement
defaults true, and non-loopback access defaults false. Approved non-loopback execution additionally
requires `SOURCE_CLASSIFICATION_REPAIR_ALLOW_NON_LOOPBACK=true`, PostgreSQL `sslmode=verify-full`,
HTTPS `S3_ENDPOINT`, and temporary read-only object credentials. These are one-command maintenance
inputs, not API/web/long-lived-worker configuration. See ADR 0051 and the bounded
classification-repair runbook.

The one-way source-classification writer-fence command requires
`SOURCE_CLASSIFICATION_FENCE_EXPECTED_DATABASE_SYSTEM_IDENTIFIER`,
`SOURCE_CLASSIFICATION_FENCE_REQUESTED_BY`, `SOURCE_CLASSIFICATION_FENCE_REASON`, and the exact
`SOURCE_CLASSIFICATION_FENCE_CONFIRMATION`. Non-loopback access defaults false; approved remote
execution requires `SOURCE_CLASSIFICATION_FENCE_ALLOW_NON_LOOPBACK=true` and PostgreSQL
`sslmode=verify-full`. These are one-command maintenance inputs, not API/web/long-lived-worker
configuration. They do not belong in `.env`, an image, shell history, logs, or evidence. See ADR
0052 and the one-way activation runbook.

`RECONCILIATION_RUN_TRANSACTION_TIMEOUT_MS` defaults to 30 seconds. The API starts this authority
deadline before database-pool admission, cancels the pending run-creation query when it expires, and
sets the same transaction-local PostgreSQL `statement_timeout` as a blocked-statement backstop.
Client disconnect uses the same cancellation path. Every interruption rolls back the run, pinned
inputs, outbox event, and audit event together; a request whose deadline expires while waiting for a
connection cannot later create authority. The repository settles the safe error when the signal
expires while continuing to observe the signal-guarded pool operation.

`RECONCILIATION_RUN_MAX_CONCURRENT_TRANSACTIONS` defaults to two per API process. Admission occurs
before constructing the postgres.js operation; excess attempts fail immediately with the same
retry-safe response. A slot is retained until hidden database work settles after any earlier public
deadline response. Pool acquisition itself remains non-cancellable and drains only after capacity
returns. The deployment-wide bound is this value multiplied by live API replicas, so shared Redis
request admission, bounded replica count, database/pool sizing, and rejection/latency monitoring
remain required. Neither setting is an end-to-end API latency or throughput guarantee and neither
covers worker execution. Select both values from protected-staging measurements at the configured
100,000-input ceiling, leave database headroom for read/authorization paths, and keep the edge
timeout longer than the approved transaction ceiling.

No secret may use a `NEXT_PUBLIC_` prefix. `CONNECTOR_ENCRYPTION_KEYS` contains references such as
`v1=env:RECONAI_CONNECTOR_ENCRYPTION_KEY_V1`, not key material. The separately configured active
version must exist in that mapping. Referenced values decode to exactly 32 bytes; production startup
rejects the development all-zero placeholder. Retain old keys until every active envelope has been
rotated and the rollback/retention window has closed. Production secret values come from a secret
manager/file mount, not image layers or source-controlled manifests.

Long-lived services parse separate runtime schemas. API receives `DATABASE_URL` but not the worker,
maintenance, migration, or administrator roles and does not accept the web OIDC client secret,
session secret, or AI credential. Worker receives `DATABASE_WORKER_URL` but not the API or
administrative roles and does not accept OIDC/session, email, support, API-rate-limit, or AI
authority. Web receives no database, object-storage, connector, email, support, or AI credentials.
Keep separate secret-manager projections for every service and command; do not mount one full-stack
environment bundle into application containers. The full parser remains limited to fixture and
compatibility tooling. See ADR 0064.

`OIDC_ACR_VALUES` is optional and non-authoritative. When present, the web runtime accepts at most
ten unique, single-space-delimited OIDC Authentication Context Class Reference values with no
whitespace normalization and passes them as `acr_values` on authorization requests. This requests
step-up behavior from the provider; it does not grant support access. The API must independently
receive and exactly match the signed `acr` against `SUPPORT_OIDC_AUTHENTICATION_CONTEXT`, in
addition to the exact signed support group and every grant check. Provider policy, mapper, and
recovery-flow changes therefore require protected-environment verification before enablement.

Production startup rejects a local rate-limit store or an empty trusted-proxy list. Configure only
the private reverse-proxy addresses/CIDRs that directly connect to Fastify; `/0`, duplicate,
whitespace-ambiguous, invalid, and more than 16 entries are rejected. Do not trust the public
internet or copy a client-supplied forwarding chain into this setting. Generate
`API_RATE_LIMIT_KEY_SECRET` from at least 32 random bytes and keep it stable across API replicas in
one environment. Rotation resets only pseudonymous limiter counters; it does not affect sessions or
financial data. Redis keys contain an environment namespace plus an HMAC digest, never the raw IP,
authorization header, organization ID, or tenant data.

The public edge must derive forwarding metadata rather than copy it from the caller. The reference
Nginx policy sets `X-Forwarded-For` and `X-Real-IP` from `$remote_addr`, derives forwarded host and
protocol, removes `Forwarded`, and deliberately rejects `$proxy_add_x_forwarded_for`. If a reviewed
load balancer precedes Nginx, use the real-IP module with exact trusted peer CIDRs so `$remote_addr`
is derived before forwarding. This edge trust configuration is deployment state, not an application
environment variable.

API readiness checks PostgreSQL, the Redis authority used for queue/production admission, and the
configured S3 bucket concurrently within `API_READINESS_TIMEOUT_MS`; results are single-flight and
cached for one second. The S3 credential needs `s3:ListBucket` on that exact private bucket so
`HeadBucket` can remain read-only. OIDC, provider APIs, invitation email, and OTLP are deliberately
excluded: their request/job paths are independently bounded or optional, and telemetry must never
control financial work. Public health responses never include component names or raw errors. See
ADR 0023.

The OTLP value is an origin without credentials, path, query, or fragment. ReconAI appends the
standard `/v1/traces` and `/v1/metrics` paths. Production startup rejects an empty or non-HTTPS
collector origin; collector authentication belongs at a private sidecar/service-mesh/egress
boundary. See `docs/observability.md`.

The durable queue monitor runs only when worker OTLP is enabled. It uses its own timeout-bounded
Redis connection so monitoring cannot hold the worker's queue-processing connection or control
readiness. Its interval defaults to 15 seconds and must be at least its command timeout. The monitor
is lossy and read-only: a monitor failure can suppress telemetry but cannot pause, retry, reorder,
or mutate a durable job. See ADR 0037.

Provider recovery has no circuit-disable flag. Every worker uses a dedicated, timeout-bounded Redis
client with offline queuing disabled; if circuit admission cannot be established, the worker
suppresses the provider request and returns retryable failure. The default threshold is three
consecutive transient failures, the default open interval is 60 seconds, and the default half-open
probe lease is 15 seconds. The probe lease must be at least the Redis command timeout and no longer
than the open interval. Redis keys contain environment, fixed provider, and a SHA-256 digest of
tenant/connection authority—not raw organization, connection, account, run, cursor, credential, or
payload values. Validate thresholds, managed-Redis authentication/TLS/ACLs, failover, latency,
mixed-worker rollout, provider limits, and alert behavior in protected staging before production.
See ADR 0045.

Rotate the limiter key only through an edge-protected coordinated drain/restart. A rolling
deployment with old and new keys creates parallel budgets until the old counters expire. Validate
the direct proxy peer addresses and a shared 120/121 response boundary across at least two replicas
after topology or key changes; never print the key or raw forwarding chain in evidence.

Production web replicas also require `SESSION_REVOCATION_STORE=redis`. Keep `APP_ENV`,
`SESSION_SECRET`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_ID_TOKEN_SIGNING_ALGORITHM`, and the Redis
authority identical across replicas. Revocation keys contain only a bounded namespace plus
HMAC-SHA-256 indexes of provider `sub`, `sid`, and Logout Token `jti`; no raw identifier or token is
stored. `SESSION_SECRET` rotation invalidates existing cookies and changes those indexes, so drain
and restart every web replica together. See `docs/session-revocation.md`.

Provider recovery requires a connection-level read authority. It can be a sealed lifecycle reference
created through provider OAuth or `pnpm connector:credential:seal` and the administrator credential
API. An externally managed reference such as `env:RECONAI_CONNECTOR_STRIPE_READ_DEVELOPMENT` or
`env:RECONAI_CONNECTOR_SHOPIFY_READ_DEVELOPMENT` remains supported. Read authority never reuses the
connection's webhook-signing `credential_reference`. Inject an external value into the worker only
where practical, use minimum read authority, and never put raw credentials in SQL, an API request, a
`NEXT_PUBLIC_` variable, or browser-readable session state.

When Shopify OAuth is enabled, configure the exact callback
`{WEB_ORIGIN}/api/recon/provider-authorizations/callback/shopify` and route
`customers/data_request`, `customers/redact`, and `shop/redact` to the fixed app-level
`{API_ORIGIN}/v1/webhooks/shopify/privacy` endpoint. The privacy endpoint uses
`SHOPIFY_CLIENT_SECRET` and accepts no tenant/connection path parameter. When Stripe OAuth is
enabled, configure `{WEB_ORIGIN}/api/recon/provider-authorizations/callback/stripe` and send the
app-level `account.application.deauthorized` event to
`{API_ORIGIN}/v1/webhooks/stripe/app-deauthorizations`. `API_ORIGIN` is deployment terminology here;
the provider must reach the externally routed API origin. The Stripe event endpoint requires
`STRIPE_APP_WEBHOOK_SECRET`, which is distinct from every connection webhook secret and read token.

Enabling Shopify requires its client ID and secret. Enabling Stripe requires its OAuth client ID,
secret key, app ID, and app-level webhook secret. Supplying either provider's OAuth authority while
its flag is false fails configuration validation. A Shopify connection also requires a canonical
`*.myshopify.com` account ID and the pinned quarterly API version.
