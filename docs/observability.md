# Observability

ReconAI has a provider-neutral OpenTelemetry boundary for the API and worker. It exports explicit
traces and metrics over OTLP/HTTP protobuf. This is local implementation and contract evidence, not
proof that a staging or production collector, dashboard, retention policy, or alert path exists.

## Runtime contract

`packages/observability` owns SDK and exporter setup. API and worker processes use distinct stable
service names (`reconai-api` and `reconai-worker`) and the configured deployment environment.
Automatic instrumentation and host/process resource detection are intentionally disabled. The only
resource attributes are:

- `service.name`
- `deployment.environment.name`
- `service.version`, when an explicit bounded version is supplied

The configured value is a collector origin. ReconAI derives only `/v1/traces` and `/v1/metrics`.
Credentials, paths, query strings, fragments, and non-HTTP protocols are rejected. Production
requires HTTPS and refuses to start without a collector origin. Authenticate at a private collector,
sidecar, service-mesh, or egress boundary; never put a token in the URL or source-controlled
configuration.

Outside production an empty endpoint makes the runtime a network-free no-op. This keeps unit tests
and local development isolated unless a collector is explicitly selected.

## Implemented signals

| Boundary                   | Trace/span                         | Metrics                                                      | Bounded attributes                                                |
| -------------------------- | ---------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Fastify request            | `METHOD <registered-route>` server | `reconai.api.server.requests`, `reconai.api.server.duration` | method, route template, success/client-error/server-error/aborted |
| Run-creation unavailable   | no additional span                 | `reconai.reconciliation.run_creation.unavailable`            | `admission_saturated` or `interrupted`                            |
| Durable worker job         | `durable_job <type>` consumer      | `reconai.worker.jobs`, `reconai.worker.job.duration`         | four schema job types plus invalid; seven fixed outcomes          |
| Reconciliation run         | `reconciliation_run` internal      | run/result counts and duration                               | four fixed outcomes and four aggregate result kinds               |
| Outbox relay batch         | no span                            | batch count/duration and event outcomes                      | success/failure plus published/retried/dead-lettered              |
| Durable queue monitor      | no span                            | state gauges, ready-head age, poll outcomes                  | seven fixed states and success/failure                            |
| Provider webhook ingress   | no additional span                 | `reconai.provider.webhook.ingress.requests`                  | two providers, four fixed surfaces, nine response outcomes        |
| Provider normalization     | no additional span                 | run count and duration                                       | two providers plus invalid, three sources, nine outcomes          |
| Provider event freshness   | no additional span                 | classified sample count and bounded source-lag histogram     | three providers/sources defensively, four timestamp outcomes      |
| Provider repair freshness  | no additional span                 | scan/candidate counts and bounded last-successful-sync age   | three providers/references/dispositions defensively               |
| Provider active sync       | no additional span                 | per-provider presence/oldest-age gauges and monitor polls    | two providers, two active statuses, five poll outcomes            |
| Provider sync execution    | no additional span                 | provider-sync attempt count and duration                     | two providers, two triggers, fixed outcomes                       |
| Provider request circuit   | no additional span                 | circuit decision and transition counts                       | two providers, fixed decisions/transitions                        |
| Proposal review decision   | no additional span                 | classified sample count and bounded decision-age histogram   | three decisions, four statuses, four timestamp outcomes           |
| Exception final resolution | no additional span                 | classified sample count and bounded final-resolution age     | four timestamp outcomes                                           |
| Unresolved exception queue | no additional span                 | presence/oldest-age gauges and classified monitor polls      | five fixed poll outcomes; gauges have no attributes               |
| Structured log line        | active trace and span IDs          | not applicable                                               | existing redacted service/environment log fields                  |

API metric routes come from Fastify's registered route template, never a raw URL or query. Unknown
routes collapse to `unmatched`. Worker types and outcomes are closed vocabularies. Attempt number is
a bounded span attribute and is not a metric label. Organization, user, connector, job, correlation,
object, payment, and customer identifiers are not metric attributes. Successful first executions
record input, match, exception, and ambiguous-candidate totals as metric values, not labels.
Already-completed reconciliation replays increment only the run outcome and do not double-count
results. Outbox activity records aggregate event values only.

The run-creation counter distinguishes only a fail-fast local admission rejection from an
interrupted admitted operation. The reason is internal operational telemetry: both cases retain the
same opaque retry-safe public `503`, and neither tenant nor financial context is added to the
metric.

Provider ingress observations are derived only from the four provider-signature contracts in the
fail-closed route manifest. They finish at response completion and distinguish accepted, duplicate,
authentication-failed, validation-failed, evidence-conflict, rate-limited, dispatch-unavailable,
failed, and aborted outcomes. Authentication intentionally combines missing authority, secret
resolution, and invalid signature so telemetry cannot reveal resource existence. An accepted
response proves durable intake only; it does not claim normalization success.

Provider normalization observations begin only after the worker exactly matches the tenant-bound
PostgreSQL outbox authority. Source is `webhook`, `sync`, or `invalid`; outcomes are `processed`,
`already_processed`, five stable terminal classifications, `failed_terminal`, or `failed_retryable`.
Event types, requester values, provider errors, receipt/object/job/correlation IDs, raw paths,
tenant/connection IDs, credentials, payloads, and money never become attributes. Unknown dynamic
values emit nothing or collapse to a fixed fallback.

A newly `processed` provider event records one `reconai.provider.event.freshness.samples` outcome. A
validated source-to-normalization lag from zero through 30 days inclusive also records
`reconai.provider.event.source_lag` in seconds. Future, invalid, and over-30-day timestamps are
counted by fixed classification but never enter the histogram. `already_processed` replays do not
emit another freshness sample. Source timestamp strings are never exported. This signal is
deliberately at-most-once and lossy after database completion; it must not participate in retry or
idempotency authority.

When the opt-in gap-repair scheduler runs, each attempt records `reconai.provider.gap_repair.scans`
as `succeeded` or `failed`; a successful empty scan is a heartbeat. The existing worker-only
database function returns at most 100 oldest due connections. For those same candidates only,
`reconai.provider.gap_repair.candidates` records fixed provider, `last_successful_sync` or
`never_succeeded`, `scheduled` or `skipped`, and a fixed age classification. A finite
last-successful-sync age from zero through 365 days inclusive also records
`reconai.provider.gap_repair.last_successful_sync_age` in seconds. Negative, invalid,
never-succeeded, and over-window values do not enter the histogram. Organization, connection,
account/shop, run, credential, and timestamp values never reach telemetry, and the scheduler logs
only aggregate counts.

These are delta observations of bounded due candidates, not a complete connection gauge. The scan
excludes queued/running connections, its 100-row count is not a total backlog under saturation, and
it runs only when scheduled repair is enabled. The metrics do not prove per-object provider
watermarks, completeness, active-sync progress, or recovery success.

The product's tenant-authorized connector view separately exposes classification-backed fixed-family
persisted source and receipt watermarks. Those timestamps are deliberately not metric attributes and
do not become an environment-wide tenant locator. An unclassified operational receipt makes the
connection state classification-unavailable rather than producing partial or never-observed
evidence. These states still do not prove normalization or completeness; see ADR 0047.

The lease-owned worker monitor separately observes the oldest `queued` or `running` provider sync
for each fixed provider. Age starts at immutable run creation, so it includes queue delay and
execution time and does not reset on page progress or retry. A fixed worker-only function performs
two provider-keyed partial-index lookups, hydrates at most one row per provider, and returns exactly
Shopify and Stripe as either `empty` or `active` with fixed status and database-computed age. It
never returns tenant, connection, run, requester, correlation, window, cursor, error, count,
timestamp, account/shop, credential, object, money, or currency data.

`reconai.provider.sync.active.has_active` publishes `0` or `1` with only the fixed provider
dimension. `reconai.provider.sync.active.oldest_age` is emitted only for an active provider and uses
fixed provider plus `queued`/`running` status. The attribute-free
`reconai.provider.sync.active.monitor.polls` counter uses only `empty`, `observed`,
`future_timestamp`, `invalid_age`, and `failed`. The whole two-provider snapshot expires with the
operational lease; a follower, failure, malformed/incomplete result, future age, or shutdown clears
it without publishing partial or healthy-zero state.

This signal detects old active work but does not count active runs, report page progress, prove
per-object completeness or provider delivery, identify the affected tenant, or establish recovery
success. Investigate only through tenant-authorized connection and sync-run views. Migrations
0046–0047 and ADR 0044 define the online index, fixed authority, rollout, and remaining live
verification.

A provider-sync durable attempt starts an observation only after its exact outbox/sync-run authority
is loaded. `reconai.provider.sync.runs` and `reconai.provider.sync.duration` use fixed provider,
`scheduled` or `user_requested` trigger, and a closed outcome vocabulary including success, partial
success, already processed, terminal failure, and retryable failure. The scheduler's exact service
identity is `scheduled`; a valid user UUID is `user_requested`; all other requester values collapse
to `invalid`. These post-attempt metrics are at-most-once and may be absent after work settles.
`already_processed` does not distinguish a prior success from a prior terminal state, so the durable
sync-run and audit evidence remains authoritative.

Before every Shopify/Stripe page request, the worker records a fixed
`reconai.provider.circuit.decisions` outcome. Allowed closed/half-open work, open denial, concurrent
probe denial, store unavailability, and invalid values are distinct. Atomic state transitions record
`reconai.provider.circuit.transitions` for open/reopen, probe start, close, stale-result ignore, or
invalid input. Only the fixed provider and fixed decision/transition are attributes. Tenant,
connection, run, account, requester, cursor, credential, error, retry-after, permit token, Redis
key, payload, timestamp, money, and currency are excluded. These metrics describe request
suppression and recovery probes, not provider-wide availability, a tenant locator, sync
completeness, or financial authority. ADR 0045 defines the distributed state and rollback.

A committed reviewer decision records one `reconai.review.proposal_decision.samples` outcome after
the tenant-scoped transaction returns. A valid proposal-creation-to-approval-insert age from zero
through 365 days inclusive also records `reconai.review.proposal_decision.age` in seconds. Future,
invalid, and over-365-day timestamps are counted by fixed classification but never enter the
histogram. The only dimensions are the fixed decision and resulting proposal status: the first
dual-control approval is `approve`/`pending`, the threshold-crossing approval is
`approve`/`approved`, and a rejection is `reject`/`rejected`. Tenant, reviewer, proposal, exception,
type, severity, amount, reason, and timestamps never become attributes. This at-most-once,
post-commit signal can be lost after database completion and does not measure the unresolved
exception queue or time to final resolution.

A threshold-crossing approval also records one `reconai.review.exception_final_resolution.samples`
outcome after the tenant-scoped transaction returns. A valid
exception-creation-to-approved-status-transition age from zero through 365 days inclusive records
`reconai.review.exception_final_resolution.age` in seconds. Future, invalid, and over-365-day
timestamps are counted by fixed classification but never enter the histogram. Neither instrument has
tenant, reviewer, proposal, exception, type, severity, amount, reason, status, or timestamp
attributes.

This is specifically final reviewer resolution: the threshold-crossing approval is the only review
transition into `approved`; rejected proposals reopen the exception, and first-stage dual-control
approvals remain pending. Reconciliation preserves approved exceptions. Automated `superseded`
transitions are excluded because a later authoritative run can reobserve and reopen those
exceptions. Conflicting, unauthorized, rolled-back, pending, and rejected attempts emit no final
resolution sample. The signal is at-most-once and lossy after commit, and it is not a gauge of the
current unresolved queue.

The lease-owned worker monitor also calls a fixed worker-only database function for the oldest
environment-wide unresolved exception. Unresolved means `open`, `assigned`, `deferred`, `proposed`,
or legacy `rejected`; reviewer-final `approved` and reobservable `superseded` rows are excluded. The
function uses a global partial `(created_at, id)` index, hydrates at most one row, and returns only
`empty` or `nonempty` plus a numeric database-computed age. It never returns a tenant, exception,
timestamp, status, severity, type, assignee, evidence, money, or currency value.

Only the existing durable-queue lease owner performs this read.
`reconai.review.exception_queue.has_unresolved` publishes `0` or `1`, and
`reconai.review.exception_queue.oldest_age` publishes seconds; both gauges are attribute-free. A
successfully observed empty queue publishes zero for both. The poll counter
`reconai.review.exception_queue.monitor.polls` uses only `empty`, `observed`, `future_timestamp`,
`invalid_age`, and `failed`. A follower, ownership loss, shutdown, Redis/queue failure, database
failure, malformed result, future age, or lease-TTL expiry clears the process-local exception
snapshot instead of publishing a fabricated healthy zero.

This is an environment-wide backlog indicator, not a tenant locator, unresolved count, severity
distribution, reviewer-productivity measure, or financial authority. Operators must investigate
through tenant-authorized product/support views. Its additive concurrent index and fixed database
authority are described in ADR 0043; the source defines live restricted-role assertions, but this
increment has not executed them without PostgreSQL.

The worker queue monitor exports `reconai.queue.jobs` for the fixed `waiting`, `paused`, `active`,
`delayed`, `prioritized`, `waiting-children`, and `failed` states.
`reconai.queue.ready_head.maximum_age` is the maximum creation age among the next dispatchable
waiting, paused, and prioritized list heads. It is not the oldest creation time across every
prioritized job: calculating that exactly would require an unbounded scan because priority, not
creation time, orders that list. Each poll reads seven aggregate counters and hydrates at most one
job from each of those three ready lists. Empty frontiers publish zero.

Only the replica holding an environment/queue-scoped Redis lease reads and records a snapshot.
Observable gauges retain that process-local snapshot only until the lease TTL; a follower, failed
poll, or clean shutdown clears it. This prevents an old leader from indefinitely re-exporting a
stale synchronous gauge after ownership changes. Poll outcomes use only `succeeded` and `failed`;
ordinary follower skips do not increment a metric. The lease key/token, Redis endpoint, job data,
job IDs, tenant IDs, and queue name are never telemetry attributes.

The metric reader also enforces 256 time series per instrument. Spans allow at most 16 bounded
attributes and no events. Export concurrency, queue size, batch size, sampling ratio, interval, and
timeout are bounded.

Metric temporality is selected by application code rather than an ambient OpenTelemetry environment
variable. API metrics use cumulative temporality. Worker metrics use delta temporality so a
lease-losing queue observer can stop producing its gauge series instead of having the SDK merge and
re-export the last cumulative observation. Collectors and dashboards must preserve the temporality
carried by each OTLP data point.

## Trace trust and correlation

The API accepts a bounded W3C `traceparent` header and creates a server span using that parent.
Caller-controlled `tracestate` is not propagated. A remote caller cannot force sampling: the local
ratio sampler re-evaluates both sampled and unsampled remote parents, while local child spans
preserve their parent's decision. Active Pino logs include only the resulting trace and span IDs.

The generated correlation ID continues across every API, outbox, and worker path. All four current
shared durable-envelope types capture only locally accepted trace/span identity and sampled bit:
reconciliation run creation, signature-verified provider webhook intake, tenant-authorized CSV
commit, and user-requested provider sync. A provider-sync consumer also captures its active,
already-authorized worker span for each child webhook envelope. `tracestate`, baggage, raw headers,
and payload content are not persisted. The field participates in the canonical job hash, and the
worker creates a parented consumer span only after loading and exactly matching the tenant-bound
PostgreSQL outbox authority. Existing envelopes without the field remain valid and start a new
worker root. Scheduled provider-sync requests deliberately start roots because no authenticated API
request exists; their child event jobs can continue from the active sync-consumer span.

## Configuration

| Variable                                         | Bounds/default                | Behavior                                           |
| ------------------------------------------------ | ----------------------------- | -------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                    | origin or empty outside prod  | production-required HTTPS collector origin         |
| `OTEL_TRACE_SAMPLE_RATIO`                        | 0–1; default 0.1              | local decision for root and remote-parent spans    |
| `OTEL_METRIC_EXPORT_INTERVAL_MS`                 | 1,000–300,000; default 60,000 | push interval; must be at least the export timeout |
| `OTEL_EXPORT_TIMEOUT_MS`                         | 100–30,000; default 5,000     | per-export and trace-force-flush timeout           |
| `DURABLE_QUEUE_MONITOR_INTERVAL_MS`              | 1,000–300,000; default 15,000 | worker queue snapshot cadence                      |
| `DURABLE_QUEUE_MONITOR_REDIS_CONNECT_TIMEOUT_MS` | 100–5,000; default 1,000      | dedicated Redis connect timeout                    |
| `DURABLE_QUEUE_MONITOR_REDIS_COMMAND_TIMEOUT_MS` | 50–5,000; default 1,000       | command bound; no longer than cadence              |
| `PROVIDER_CIRCUIT_REDIS_CONNECT_TIMEOUT_MS`      | 100–5,000; default 1,000      | dedicated circuit Redis connect timeout            |
| `PROVIDER_CIRCUIT_REDIS_COMMAND_TIMEOUT_MS`      | 50–5,000; default 1,000       | circuit Redis command timeout                      |
| `PROVIDER_CIRCUIT_FAILURE_THRESHOLD`             | 1–20; default 3               | consecutive transient failures before open         |
| `PROVIDER_CIRCUIT_OPEN_MS`                       | 1,000–900,000; default 60,000 | open/cooldown interval                             |
| `PROVIDER_CIRCUIT_PROBE_LEASE_MS`                | 1,000–60,000; default 15,000  | one half-open probe; bounded by open interval      |

Use a lower production sample ratio only after validating useful coverage and cost. Metrics are not
sampled. Apply an egress allowlist for the exact collector host and monitor the collector and
backend separately.

## Failure and shutdown behavior

Exporter traffic has one concurrent request per signal and bounded in-memory queues. A collector
outage does not authorize dropping, delaying, or changing financial work; telemetry may be dropped
after its bound. The collector/backend must alert on missing service telemetry because an in-process
alert cannot report its own broken export path reliably.

Queue telemetry has a dedicated bounded Redis connection and never participates in API readiness or
worker job execution. A count/frontier/lease error emits no fabricated zero snapshot, clears the
local observable state, increments the fixed failed-poll counter when possible, and writes only a
redacted structured error. Other replicas may take the lease after its bounded TTL. Queue data and
financial work continue independently.

The provider circuit uses a different dedicated Redis connection with offline queuing disabled.
Unlike optional telemetry, circuit admission is part of source-system protection: a connection or
command failure prevents the provider request and produces a retryable durable outcome. State
contains only bounded counters/times plus a random permit token under a pseudonymous key and expires
after inactivity. It does not participate in API readiness or authorize work.

SIGINT/SIGTERM handling closes application resources and then shuts down the telemetry providers,
which flushes within configured exporter bounds. The deployment termination grace period must cover
application drain plus telemetry timeout. A production collector outage, retry/backpressure
behavior, termination kill, and silence alert still require staging exercises.

## Proposed dashboards and alerts

The current metrics can support API request rate/error ratio/latency, durable-job attempt
rate/outcome/duration, reconciliation result/duration, and outbox dispatch views. Before production,
add and exercise backend rules for:

- sustained API server-error ratio and latency;
- sustained run-creation `admission_saturated` or `interrupted` rates, evaluated separately;
- worker terminal/dead-letter/busy and retryable-failure growth;
- outbox retry/dead-letter growth and reconciliation failure/duration anomalies;
- provider authentication/validation/dispatch failures and post-authority normalization
  retryable/terminal failures;
- processed-event source lag plus future, invalid, and over-window timestamp classifications;
- provider gap-repair scan failures or silence while enabled, never-succeeded due candidates, and
  due-candidate last-successful-sync age classifications;
- provider active-sync poll failures/silence and sustained per-provider queued/running oldest age;
- provider-sync retryable/terminal/partial outcomes or duration anomalies, separated by fixed
  provider and scheduled/user-requested trigger;
- sustained circuit open/reopen/acquire-failed outcomes, probe-busy anomalies, and absence of
  expected recovery transitions;
- proposal-decision age plus future, invalid, and over-window timestamp classifications, separated
  by first-stage, final, and rejected decisions;
- approved-exception final-resolution age plus future, invalid, and over-window timestamp
  classifications;
- oldest-unresolved exception age/presence, invalid/future/failed monitor polls, and absence of
  exception gauge samples;
- sustained waiting/prioritized/delayed/failed depth, ready-head maximum age, failed monitor polls,
  and absence of queue gauge samples;
- absence of both API and worker telemetry;
- collector rejected/dropped data and exporter/backend saturation.

A backend-neutral, production-disabled first policy pack now selects proposed defaults for 13
lease-owned queue, unresolved-exception, and active-provider-sync failure, silence, and age rules in
`infra/observability/operational-alert-policy.yaml`. Its parser accepts only exact checked-in metric
names, instrument-compatible reducers, and complete fixed attribute vocabularies. The 20-minute
silence bound covers two cycles at the maximum configured five-minute monitor and export intervals;
the three always-emitted monitor counters have explicit absence rules and evaluation errors alert.
Threshold no-data is normal because the active-sync age gauge is correctly absent when no sync is
active; absence never becomes a healthy zero. Warning/critical age thresholds are operating
proposals, not measured SLOs.

The pack is not backend syntax and is not installed. Per-object provider completeness, provider
recovery completeness, unresolved exception counts/severity, AI metrics, the other rule families
above, dashboard aggregation, backend name/unit/temporality translation, routing, delivery,
acknowledgement, threshold suitability, and silence behavior still require an owner-approved
protected-deployment exercise. Local metric and policy validation is not alert evidence. Promotion
and response requirements are in `docs/operations-runbook.md#telemetry-alert-policy-pack`.

## Verification

`packages/observability/src/observability.test.ts` starts a loopback HTTP capture endpoint, exports
real OTLP protobuf trace and metric requests, verifies the two standard paths/content types,
confirms W3C parent extraction and non-empty payloads, proves a durable consumer reloaded outside
the API execution context retains its trace ID with a distinct span ID, then proves a nested durable
consumer retains that trace with a third span ID. Captured bytes are scanned for forbidden
sentinels. Captured metrics cover API, run-creation unavailability with both fixed reasons, worker,
reconciliation, outbox, queue, unresolved-exception, provider-active-sync, provider-sync outcome,
and provider-circuit instruments. Exception-observer unit tests prove exact empty/nonempty result
parsing, dynamic/non-finite/inconsistent result rejection, lease ownership, follower read
suppression, database-failure clearing, and single-flight execution. Provider-active-sync tests
require one ordered Shopify and Stripe result, reject
missing/duplicate/reversed/inconsistent/non-finite rows, prove lease-owner-only reads and atomic
failure clearing, and exercise both active statuses plus all five fixed poll outcomes. Queue unit
tests prove fixed-size reads, zero snapshots, malformed-metadata rejection, lease ownership,
follower read suppression, single-flight execution, and compare-token lease release. An
authenticated loopback Redis 8.2.8 integration test uses three Redis connections and real BullMQ
state, proves exact counts and a 120-second ready-head age, confirms one positive-TTL lease and a
read-free follower, and scans real OTLP protobuf bytes for forbidden payload, tenant, token, and key
sentinels. A second forced export after follower transition proves the delta worker pipeline no
longer exports the prior queue gauges. Schema and worker tests prove trace-context format/hash
binding and authority-before-parent ordering. Producer tests prove invalid context is rejected
before provider storage, immutable webhook replay keeps the first context, and provider-sync child
items receive the active worker context. API tests separately prove that raw inbound trace headers
are not copied without a locally active span. Fresh PostgreSQL repository tests verify exact
context-bearing webhook, CSV, and user-sync outbox payloads while scheduled sync payloads omit the
field. Provider circuit unit tests prove required admission, transient-only classification,
open/store-failure request suppression, token-bound state mutation, retry-after bounds, strict
configuration, and dynamic metric suppression. A separate authenticated loopback Redis test uses two
clients to prove shared open/half-open behavior, one probe, isolation, rate-limit opening, positive
TTL, and pseudonymous keys. Configuration tests cover disabled local telemetry behavior, production
telemetry presence/TLS, URL ambiguity, sampling, interval, and timeout bounds plus the required
circuit bounds.

`scripts/operational-alert-policy.test.mjs` proves the checked-in policy remains production-disabled
and rejects high-cardinality dimensions, dynamic attribute values, instrument/reducer mismatches,
unknown fields, and duplicate rule IDs. `pnpm alerts:check` binds every alertable instrument
creation to the shared metric contract, requires all 13 control rules, checks 20-minute silence
floors, warning-to-critical monotonicity, and live runbook anchors. This is static local contract
evidence only.

The dated local results are `artifacts/observability-runtime-verification-2026-07-28.json`,
`artifacts/reconciliation-durable-trace-context-verification-2026-07-29.json`, and
`artifacts/durable-producer-trace-context-verification-2026-07-29.json`. This does not replace a
real collector/backend compatibility, retention/access-control, load, dashboard, or alert exercise.
The narrower run-creation addition is recorded in
`artifacts/reconciliation-run-creation-unavailability-observability-verification-2026-07-29.json`.
Authenticated durable reconciliation propagation is recorded separately in
`artifacts/reconciliation-durable-trace-context-verification-2026-07-29.json` and ADR 0036. The
queue-monitor addition is recorded in
`artifacts/durable-queue-observability-verification-2026-07-29.json` and ADR 0037.
Provider-ingestion signals are recorded in
`artifacts/provider-ingestion-observability-verification-2026-07-29.json` and ADR 0038. Bounded
processed-event freshness samples are recorded in
`artifacts/provider-event-freshness-observability-verification-2026-07-29.json` and ADR 0039.
Bounded committed proposal-decision ages are recorded in
`artifacts/proposal-review-decision-age-observability-verification-2026-07-29.json` and ADR 0040.
Bounded scheduled-repair due-candidate freshness is recorded in
`artifacts/provider-gap-repair-freshness-observability-verification-2026-07-29.json` and ADR 0041.
Bounded approved-exception final-resolution age is recorded in
`artifacts/exception-final-resolution-age-observability-verification-2026-07-29.json` and ADR 0042.
Lease-owned oldest-unresolved exception-queue observability is recorded in
`artifacts/unresolved-exception-queue-age-observability-verification-2026-07-29.json` and ADR 0043.
Lease-owned oldest-active provider-sync observability is recorded in
`artifacts/provider-active-sync-age-observability-verification-2026-07-29.json` and ADR 0044.
Distributed provider-request circuit behavior, retry-after-aware durable delay, provider-sync
outcomes, and local two-client Redis evidence are recorded in
`artifacts/provider-request-circuit-verification-2026-07-29.json` and ADR 0045.
