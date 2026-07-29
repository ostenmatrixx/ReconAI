# Operations runbook

## Service map and first checks

Operator order: status page/alerts → recent deployment/migration/config/key events → web/API
readiness → database connections/replication/storage → queue depth/oldest age/DLQ → worker retries/
circuit state → object storage → OIDC → affected provider → reconciliation and connector freshness.
Use correlation IDs. Never paste raw payloads, tokens, or customer records into tickets/chat.

## API health

`/health/live` proves only that the API process can serve HTTP. `/health/ready` concurrently checks
PostgreSQL, Redis, and the configured private object bucket within `API_READINESS_TIMEOUT_MS`; it
returns only `ready` or `not_ready` and caches the result for one second. A live/not-ready replica
should be drained, not restarted repeatedly.

Use the transition log's fixed `failedChecks` values to select the next private diagnostic. For
`postgresql`, check connection capacity, role access, migration state, replication/storage, and
latency. For `redis`, check the shared queue/admission authority and network path; never switch
production admission to a local store. For `object_storage`, check the fixed endpoint/bucket,
private network/TLS, and narrow `s3:ListBucket` plus required object permissions. Never add an
endpoint, credential, object key, tenant ID, or raw SDK/database error to the public health response
or an incident ticket.

OIDC, invitation email, provider APIs, and OTLP do not control API readiness. Diagnose them from
their bounded request/job paths and dedicated signals. After a dependency recovers, wait through the
one-second cache, require readiness on every replica, then run a tenant-safe synthetic
import/enqueue/evidence-read smoke before reopening traffic.

## Severity

- SEV-1: confirmed/suspected cross-tenant access, credential compromise, financial evidence
  corruption, unauthorized source action, destructive loss, or broad outage.
- SEV-2: major tenant/workflow unavailable, growing queue beyond recovery objective, failed
  backfill/restore, or material stale data without safe workaround.
- SEV-3: limited degradation, isolated retry/DLQ, optional AI/email/telemetry failure.
- SEV-4: cosmetic or low-impact operational defect.

Security/privacy incidents follow `docs/incident-response.md` immediately.

## OIDC session revocation

Treat repeated `oidc_backchannel_logout_failed` signals as an identity/session-control incident.
Check the safe failure classification, web-to-Redis availability, Keycloak status, clock
synchronization, exact client back-channel URL, `sid` setting, and configured signing algorithm.
Never log, replay through a shell, or paste the Logout Token, session cookie, `sid`, `sub`, JWKS
body, or Redis key into tickets.

`INVALID_LOGOUT_REQUEST` can indicate a provider/client algorithm or audience mismatch, stale clock,
malformed delivery, or an attack. Compare only Keycloak delivery metadata and safe timestamps.
`REVOCATION_STORE_UNAVAILABLE` means ReconAI could authenticate the provider request but could not
durably apply the logout; the endpoint reports failure and authenticated web traffic also fails
closed. Keep liveness independent, preserve the edge, restore the dedicated Redis path, and ask
Keycloak to retry through its supported delivery mechanism. Never return success without a durable
cutoff and replay marker.

Production must not switch `SESSION_REVOCATION_STORE` to `local`. After recovery, use a synthetic
session to prove old-cookie rejection on every replica and later-login success. Rotate
`SESSION_SECRET` only through a coordinated drain/restart; mixed-secret replicas produce different
cookie and pseudonymous-index authorities. Follow `docs/session-revocation.md` for the complete
staging exercise and evidence-minimization rules.

## Queue growth

Start with `reconai.queue.jobs` for the fixed waiting, paused, active, delayed, prioritized,
waiting-children, and failed states. Use `reconai.queue.ready_head.maximum_age` as the maximum
creation age among the next dispatchable waiting/paused/prioritized list heads; it is a bounded
frontier signal, not an exact scan of every prioritized job. Correlate it with producer rate,
durable-job outcomes, outbox retries/dead letters, provider limits, worker resources, and database
latency.

If queue gauges disappear while worker telemetry continues, inspect `reconai.queue.monitor.polls`,
the dedicated monitor Redis path, and lease TTL before diagnosing job processing. Monitor Redis
failure never makes the worker unready and never authorizes queue mutation. Do not treat an absent
gauge as zero. Empty queues explicitly report zero for every state and the frontier age.

Do not blindly add concurrency against a throttled provider/database. Open circuit or pause the
specific tenant/connector job type only through the approved operational control, preserve receipts,
fix the cause, then replay bounded, tenant-scoped batches with permission/reason and watch
idempotency/DLQ. Never inspect or paste raw Redis job bodies, lease values, tenant IDs, or connector
credentials into a dashboard or incident ticket.

## Connector stale or unauthorized

Check credential state/expiry/scope, provider status, API version, cursor, last verified webhook,
scheduled repair, rate circuit, and redacted error code. Never log or test-print the token. Reauth
requires an authorized organization administrator. After recovery, run bounded gap repair and
compare watermarks/counts; do not clear history.

The tenant-authorized connector view lists every fixed V1 source family for that provider.
`Never observed` means complete classification coverage contains no persisted receipt classified as
that family for the tenant connection. `Classification unavailable` means at least one operational
receipt lacks its immutable classification; it is not evidence that any family is absent. An
observed entry shows two independent maxima: provider/source time and ReconAI receipt time. They may
come from different events. A recent value does not prove normalization, provider pagination,
webhook delivery, gap-repair completeness, active-run progress, reconciliation correctness, or
continued raw-payload retention. A future source time can reflect provider clock skew; compare the
fixed freshness classification metric and provider evidence rather than clamping it.

Never investigate with an unscoped source-event query. The product view requires
`financial-records:view`, resolves the tenant from active membership, uses explicit organization
predicates inside the tenant transaction, and returns no object ID or count. Check migration 0049,
the append-only classification rows, classifier version, classification-aware writer inventory,
migration 0048 index ready/valid state, query plan, and API/BFF schema before treating
classification unavailability as connector degradation. Do not infer a family from a Shopify
snapshot topic alone or manually fill a gap. Preserve receipt/object-integrity evidence and use only
a reviewed bounded repair.

### Bounded legacy source-classification repair

This is an owner-approved maintenance procedure, not a normal worker loop. It applies only to
operational source receipts created without classifier version `source-object-family-v1`.

Before running:

1. Provision the exact non-superuser/non-inheriting/non-RLS-bypassing `reconai_maintenance` role
   from `infra/postgres/init/001_roles.sql` through the approved platform role lifecycle, then apply
   migration 0051. Never substitute the admin, migrator, application, or worker credential.
2. Verify a restorable backup/PITR point, free disk, expected WAL and replica headroom, reviewed
   lock/statement limits, and object-storage availability. Use a temporary `GetObject`-only
   credential scoped to the immutable source prefixes; deny put/delete/list authority.
3. Stop provider-sync admission and CSV imports, drain or terminally account for prior writes, and
   prove that every admitted API/worker/CSV image writes classifications. Do not let an old writer
   recreate gaps during repair.
4. Record the approved PostgreSQL system identifier independently:

   ```sh
   psql "$DATABASE_MAINTENANCE_URL" -X -A -t \
     -c "select system_identifier from pg_control_system()"
   ```

5. Inventory the fixed aggregate only:

   ```sh
   psql "$DATABASE_MAINTENANCE_URL" -X \
     -c "select * from reconai_source_event_classification_repair_gap_counts()"
   ```

   `total_gaps` excludes exact Shopify privacy topics. `repairable_gaps` is the closed V1 topic set.
   If total exceeds repairable, stop and review the unsupported source/topic/payload path through
   tenant-authorized tooling. Never hide, delete, or manually classify the gap.

Supply secrets through the approved secret runner, not a committed file or shell-history argument.
Use small initial batches; the hard maximum is 100 and the default is 25:

```sh
DATABASE_MAINTENANCE_URL='postgresql://reconai_maintenance:...@db.example/reconai?sslmode=verify-full' \
SOURCE_CLASSIFICATION_REPAIR_EXPECTED_DATABASE_SYSTEM_IDENTIFIER='<approved-system-identifier>' \
SOURCE_CLASSIFICATION_REPAIR_REQUESTED_BY='<approved-operator-or-ticket>' \
SOURCE_CLASSIFICATION_REPAIR_REASON='<20-to-500-character-approved-reason>' \
SOURCE_CLASSIFICATION_REPAIR_CONFIRMATION='REPAIR-INTEGRITY-VERIFIED-SOURCE-CLASSIFICATIONS' \
SOURCE_CLASSIFICATION_REPAIR_MAXIMUM_EVENTS=25 \
SOURCE_CLASSIFICATION_REPAIR_REQUIRE_ZERO=true \
SOURCE_CLASSIFICATION_REPAIR_ALLOW_NON_LOOPBACK=true \
S3_ENDPOINT='https://objects.example' \
S3_REGION='<region>' \
S3_BUCKET='<private-bucket>' \
S3_ACCESS_KEY_ID='<temporary-read-only-key>' \
S3_SECRET_ACCESS_KEY='<temporary-read-only-secret>' \
S3_FORCE_PATH_STYLE=false \
pnpm repair:source-classifications
```

The command verifies target identity, claims one locked row at a time, verifies object SHA-256 under
the one-/ten-MiB ceiling and 15-second deadline, uses the production classifier, and commits one
classification plus fixed hash-chained audit atomically. It emits aggregate counts and a repair-run
digest only. Exit 2 means the batch was safe but total gaps remain; repeat only after reviewing
database/object/WAL/replica health. Exit 1 with `SOURCE_OBJECT_NOT_FOUND`,
`SOURCE_OBJECT_INTEGRITY_FAILED`, `SOURCE_OBJECT_READ_TIMEOUT`, or `SOURCE_PAYLOAD_UNSUPPORTED`
means the current transaction rolled back. Preserve evidence and correct the underlying retention,
integrity, availability, or schema issue before retrying.

Completion requires all of the following: `remainingGaps` and `remainingRepairableGaps` are zero;
the independent gap-count function returns zero/zero; the tenant-authorized product view no longer
reports `classification_unavailable`; classification-aware writer inventory is clean; and audit
chain verification passes. A zero result does not prove provider pagination, webhook delivery,
normalization, reconciliation, or source-system completeness.

To stop, terminate the command normally and keep traffic drained until the current transaction has
rolled back or committed. Revoke the temporary object/database credentials. Leave migration 0051
functions/policies, the maintenance role, and all classification/audit evidence in place. A forward
application rollback must drain new readers/writers first; never drop the classification table,
rewrite audit history, delete evidence, or edit migration checksums.

### One-way source-classification writer-fence activation

Migration 0052 closes the final old-writer race, but activation is a separate, owner-approved,
one-way maintenance action. Applying the migration does not activate the fence. Do not activate
until migration 0051 repair reports zero/zero, provider and CSV admission is stopped, every
pre-classifier transaction has drained, and the inventory of application, worker, scheduled job,
supervisor, rollback, and disaster-recovery images proves that none can write a source receipt
without its exact V1 classification.

Before activation, verify the recovery point and target system identifier again, record database
write/lock/replica health, and run the restored-data mixed-image rehearsal. This repository
currently has no prior commit or deployable prior image, so local evidence covers the old-writer
database effect and in-flight transaction race only. That is not a substitute for a protected
rehearsal with the actual prior and current images.

Supply the temporary maintenance database credential through the approved secret runner:

```sh
DATABASE_MAINTENANCE_URL='postgresql://reconai_maintenance:...@db.example/reconai?sslmode=verify-full' \
SOURCE_CLASSIFICATION_FENCE_EXPECTED_DATABASE_SYSTEM_IDENTIFIER='<approved-system-identifier>' \
SOURCE_CLASSIFICATION_FENCE_REQUESTED_BY='<approved-operator-or-ticket>' \
SOURCE_CLASSIFICATION_FENCE_REASON='<20-to-500-character-approved-reason>' \
SOURCE_CLASSIFICATION_FENCE_CONFIRMATION='ENABLE-SOURCE-CLASSIFICATION-WRITER-FENCE' \
SOURCE_CLASSIFICATION_FENCE_ALLOW_NON_LOOPBACK=true \
pnpm activate:source-classification-fence
```

The command takes the exclusive half of the source-writer advisory lock, waits for in-flight source
transactions, and checks every operational receipt for an exact compatible V1 classification.
Missing, unsupported, or incompatible evidence fails with
`SOURCE_CLASSIFICATION_FENCE_ACTIVATION_FAILED`; the transaction rolls back and the fence remains
disabled. A successful or repeated command emits no operator, reason, database credential, tenant,
source-event, object-key, or payload value.

Independently verify:

```sh
psql "$DATABASE_MAINTENANCE_URL" -X \
  -c "select * from reconai_source_event_classification_writer_fence_status()"
```

Require `enabled = true`, fence version `source-classification-writer-fence-v1`, a single immutable
activation authority, zero/zero independent repair gaps, and successful smoke/replay for current
Shopify, Stripe, and CSV writers plus privacy intake. A deliberately classification-unaware
synthetic write must roll back without a source row. Monitor source-write errors and lock latency;
do not expose tenant identifiers in telemetry.

There is no disable command. After activation, only classification-aware images are rollback-safe.
If current writers fail, stop admission and repair the current image forward; do not restart an old
writer, delete/update the activation row, disable either trigger, restore a pre-fence database over
newer evidence, or edit the migration ledger. Any proposed disable requires a separately reviewed
forward migration.

Use `reconai.provider.webhook.ingress.requests` to separate aggregate provider delivery outcomes. An
increase in `authentication_failed` can mean missing authority, secret lookup failure, or an invalid
signature; do not attempt to split those cases with tenant, connection, shop/account, raw path, or
error labels. `accepted` proves durable intake, `duplicate` proves an existing immutable receipt,
and neither proves downstream normalization. `dispatch_unavailable` and sustained `rate_limited`
require checking the durable intake path and shared admission control without replaying raw provider
bodies through ad hoc tools.

Use `reconai.provider.normalization.runs` and `reconai.provider.normalization.duration` only after
confirming worker telemetry is present. Retryable growth calls for the ordinary bounded retry/DLQ
investigation. `authority_mismatch`, `object_invalid`, and `payload_invalid` are
integrity/security-relevant terminal outcomes; preserve the immutable receipt and outbox evidence,
stop unreviewed replay, and investigate the tenant-bound authority/object chain. `event_unsupported`
can indicate provider subscription or API-version drift. Never infer connector freshness from these
counters alone.

`reconai.provider.event.source_lag` measures only newly processed events with a validated
source-to-normalization lag of at most 30 days. Check `reconai.provider.event.freshness.samples` for
`future_timestamp`, `invalid_timestamp`, or `outside_window` before interpreting the histogram.
Replays do not emit another sample, and an export/process loss after database completion can omit
one. Never infer silent-connector freshness from these counters: compare the tenant-authorized
connection fixed-family watermarks, scheduled gap-repair evidence, and provider delivery history
separately.

When `PROVIDER_GAP_REPAIR_ENABLED=true`, require regular successful
`reconai.provider.gap_repair.scans` heartbeat samples. A failed scan or missing heartbeat after the
configured cadence requires checking the worker scheduler, its worker-only database function,
database connectivity, and telemetry path without issuing an ad hoc cross-tenant query.
`reconai.provider.gap_repair.candidates` distinguishes due connections that have
`last_successful_sync` from `never_succeeded`, and whether the tenant-scoped creation recheck
`scheduled` or `skipped` them. Interpret `reconai.provider.gap_repair.last_successful_sync_age` only
for valid ages no greater than 365 days.

The scan returns at most 100 oldest due candidates, excludes queued/running connections, and is
disabled by default, so its candidate count is not a total connection backlog and absence is not
healthy unless the enabled scheduler heartbeat is also present. Do not add organization, connection,
account/shop, run, credential, or timestamp labels. Use the tenant-authorized connection and
sync-run views for investigation. These signals do not prove per-object provider completeness,
active-run progress, or repair success. The operator source watermarks are separate
tenant-authorized database evidence, not telemetry.

`reconai.provider.sync.active.has_active` reports whether Shopify and Stripe each have any
`queued`/`running` sync. When present, `reconai.provider.sync.active.oldest_age` reports total age
from immutable run creation and labels only the fixed provider and current `queued`/`running`
status. A high queued age points first to outbox/BullMQ dispatch and worker capacity; a high running
age points first to provider latency/rate limits, cursor/page progress, retry history, worker
execution, and credential/connection health.

Check `reconai.provider.sync.active.monitor.polls` before interpreting either gauge. `empty` and
`observed` are successful whole-environment polls. `future_timestamp`, `invalid_age`, and `failed`
clear the complete two-provider snapshot. Gauge absence can also mean lease transfer/expiry,
worker/Redis/database failure, exporter loss, collector rejection, or backend failure. Verify worker
liveness, durable queue monitor status, lease/Redis health, migrations 0046–0047, database
connectivity, and the telemetry path before treating absence as healthy.

Never add organization, connection, run, account/shop, cursor, error, credential, or timestamp
labels and never issue an unreviewed cross-tenant table query. Use tenant-authorized connection and
sync-run views to identify the affected work. These gauges do not count active runs, prove
per-object completeness, show provider delivery, or establish recovery success.

Every provider recovery page must first receive a distributed circuit permit.
`reconai.provider.circuit.decisions` distinguishes `closed`, `half_open`, `open`, `probe_busy`,
`failed`, and `invalid`; `reconai.provider.circuit.transitions` distinguishes `failure_counted`,
`opened`, `reopened`, `closed`, `stale`, `failed`, and `invalid`. Both use only the fixed provider
plus fixed outcome. `reconai.provider.sync.runs` and `reconai.provider.sync.duration` use only fixed
provider, `scheduled`/`user_requested` trigger, and closed outcome.

Sustained `open`/`reopened` with retryable sync failures indicates an observed provider outage or
rate limit for at least one tenant connection; it does not reveal which connection or prove a
provider-wide outage. `probe_busy` is normal while another replica owns the single half-open probe.
An acquire-side `failed` decision means the provider call was suppressed because circuit authority
could not be established. Check the dedicated worker circuit Redis connection,
authentication/TLS/ACL, latency/timeouts, failover, and worker version before retrying. Then use
only tenant-authorized connection/sync-run evidence to inspect a suspected connection.

Do not delete circuit keys globally or disable the guard. Successful validated pages close the
connection circuit; inactive state expires. Rate limits open immediately, and durable retry uses the
larger of bounded exponential delay and validated retry-after guidance, capped at 15 minutes. Old
workers do not participate, so drain provider-sync work or confirm all prior workers are gone before
relying on the control during rollout. These metrics are at-most-once operational observations, not
provider availability, completeness, reconciliation, or financial authority.

`reconai.review.proposal_decision.age` measures proposal creation to each committed reviewer
decision only when the age is valid and no more than 365 days. Use
`reconai.review.proposal_decision.samples` to separate observed, future, invalid, and over-window
timestamps. `approve`/`pending` is the first decision in a dual-control flow, `approve`/`approved`
crosses the threshold, and `reject`/`rejected` is a committed rejection. Do not add tenant,
reviewer, proposal, exception, reason, severity, or amount labels. This metric is at-most-once and
can be lost after commit; it does not measure the current unresolved queue or time to final
resolution. Investigate review backlog only through tenant-authorized exception views and preserve
the proposal, approval, and audit evidence.

`reconai.review.exception_final_resolution.age` measures exception creation to the committed
threshold-crossing `approved` transition only when the age is valid and no more than 365 days. Use
`reconai.review.exception_final_resolution.samples` to separate observed, future, invalid, and
over-window timestamps. First-stage dual-control approvals and rejections do not produce a final
sample; rejection reopens the exception. Automated `superseded` transitions are excluded because
later authoritative evidence can reobserve them. Do not add tenant, reviewer, proposal, exception,
reason, type, severity, amount, status, or timestamp labels.

Treat this metric as an at-most-once latency distribution, not an exact financial ledger or a
backlog gauge. A process/export failure after commit can omit a sample. Investigate a high or
missing distribution through tenant-authorized exception, proposal, approval, and audit views. Alert
thresholds and absence behavior require protected deployment validation before enablement.

`reconai.review.exception_queue.has_unresolved` and `reconai.review.exception_queue.oldest_age` are
attribute-free, environment-wide gauges refreshed only by the current durable-queue lease owner. A
successful empty observation publishes `0` for both; a nonempty observation publishes presence `1`
and the database-computed age of the oldest `open`, `assigned`, `deferred`, `proposed`, or legacy
`rejected` exception. `approved` and reobservable `superseded` rows are excluded.

Check `reconai.review.exception_queue.monitor.polls` before interpreting the gauges. `observed` and
`empty` are successful polls; `future_timestamp`, `invalid_age`, and `failed` clear the snapshot.
Gauge absence can also mean lease transfer/expiry, worker or Redis failure, database/function
failure, exporter loss, collector rejection, or backend failure. Check worker liveness, durable
queue monitor polls, lease/Redis health, migration state, database connectivity, then the telemetry
path. Never issue an unreviewed cross-tenant table query or add tenant/exception labels. Use
tenant-authorized exception views to locate and investigate the backlog while preserving proposal,
approval, status-event, and audit evidence.

Before applying migration 0044, verify backup, free index disk, representative scan and replica
impact, and reviewed lock/statement timeouts. A failed concurrent build can leave
`exceptions_unresolved_oldest_idx` invalid: the runner deliberately leaves 0044 unapplied unless the
index is both ready and valid. Preserve the error and catalog state; use a reviewed forward repair
to remove only the confirmed invalid index, then rerun the unchanged migration. Never insert the
checksum manually, delete a valid ledger row, or drop a valid index while a new worker may use it.

Apply the same concurrent-index precautions to migration 0046. A same-named invalid
`provider_sync_runs_active_oldest_idx` leaves 0046 unapplied; preserve the catalog/error evidence,
perform only a reviewed forward repair of the confirmed invalid index, and rerun the unchanged
migration before deploying the observer.

### Bounded provider recovery

Use **Connectors → Provider recovery sync** only for a known backfill or gap-repair window. Confirm
the selected Stripe account or Shopify shop, UTC-equivalent start/end, reason, and page ceiling. The
window must be positive and no more than 30 days; 100 pages/10,000 supported records is the hard
ceiling. A `partial` result means the page ceiling stopped retrieval while the provider still
reported more data—review the last cursor and request a new bounded window rather than editing the
row. A `failed` run is immutable; correct authentication/scope/provider availability, then make a
new reasoned request.

Stripe runs complete two phases: supported Events, then `type=charge` balance transactions with an
expanded Charge source. A zero-event window still performs the bounded balance phase. Before
enabling this read path, confirm the reviewed Stripe App grants `balance_transaction_source_read`,
record its implied permissions, and exercise the exact account mode in an authorized sandbox. A 403
is an authorization failure; do not broaden permissions ad hoc or substitute a secret.

Balance transactions may appear asynchronously, so keep the approved periodic gap-repair overlap or
make a new reasoned bounded run; never edit the recovery cursor or insert a fee manually. A Charge
without a PaymentIntent produces an explicit incomplete record. Interchange-plus accounts are not
supported by this fee path and must not be reported as fee-complete. The source-family watermark
shows persisted intake only, not completed pagination or settlement finality.

`PROVIDER_SYNC_AUTHENTICATION_FAILED` and `PROVIDER_SYNC_AUTHORIZATION_FAILED` require
restricted-key or account review. `PROVIDER_SYNC_RATE_LIMITED`, `PROVIDER_SYNC_TIMEOUT`, and
`PROVIDER_SYNC_UNAVAILABLE` retry up to six recorded attempts. Payload/cursor/authority failures are
terminal. Never substitute the webhook signing secret for `api_credential_reference`, copy a raw
credential into SQL, or manually advance a cursor.

Seal new credentials locally with `pnpm connector:credential:seal`, reading plaintext from standard
input. Install only the resulting envelope through the administrator surface. During key rotation,
add the new version and key first, make it active for sealing, rotate every active credential, and
retain the old key through the tested rollback/retention window. Verify metadata and a bounded
provider read before removing an old key. A request already in flight when read authority is cleared
may finish.

### Provider OAuth and disconnect

Keep both OAuth flags false until the app registration, exact callbacks, scopes/permissions,
provider webhook routing, key custody, clock synchronization, and alerts are reviewed. Enable one
provider at a time and restart the API/web services after changing configuration. Use only the
administrator connector surface to begin authorization; do not paste codes, state, access tokens, or
refresh tokens into logs, tickets, SQL, or API tools.

For a refresh failure, inspect the stable error class and provider status without printing the
credential. Account, scope, or Stripe mode drift requires reauthorization. A provider may accept a
refresh and rotate the refresh token before the local database commit fails; because that result is
ambiguous, do not retry it automatically. Mark the connection action-required, stop recovery reads,
and reauthorize through the provider. Never reactivate a superseded credential row.

Shopify disconnect calls `appUninstall` first. If the provider call fails or is ambiguous, local
authority remains and the UI reports failure; retry only after establishing that the app is still
installed. If Shopify confirms uninstall but the following local transaction fails, provider
authority is already gone. Stop reads, preserve audit/error evidence, and use the normal
exact-confirmation local lifecycle operation to revoke the now-unusable encrypted token after an
owner-reviewed incident record. Do not reinstall merely to clean up local ciphertext.

Stripe disconnect is intentionally two-step. The request immediately clears ReconAI's read reference
and cursor and marks the connection `action_required`, then directs the administrator to the fixed
Stripe app-settings page. The connection is not provider-confirmed disconnected until the signed
`account.application.deauthorized` event reaches `/v1/webhooks/stripe/app-deauthorizations`. Monitor
for the append-only deauthorization event and system audit entry. If confirmation is delayed, verify
external routing, the app-level webhook secret and event subscription, Stripe delivery status, the
exact account/mode, and host NTP; never forge an event or manually update the ledger.
Reauthorization creates a new generation, so a delayed uninstall event from an older installation
must remain unmatched.

### Shopify mandatory privacy requests

Keep Shopify OAuth disabled until the app registration routes all three mandatory privacy topics to
the fixed external path `/v1/webhooks/shopify/privacy` and the app secret/API version are reviewed.
The endpoint is app-level: never add a tenant or connection ID, never substitute a per-connection
webhook secret, and never paste a privacy payload into logs, tickets, or replay tools. A successful
2xx acknowledgement only proves bounded intake, not completed fulfillment.

Monitor `provider_privacy_requests` by stable status/deadline metadata and
`provider_privacy_object_deletion_jobs` by attempts, next retry, and stable error code. A resolved
request makes the connection `action_required`, which pauses periodic repair. Customer/shop
redaction deletes only database-authorized raw objects and appends tombstones; a data-access request
can prepare a bounded evidence package and record authenticated-browser receipt of complete bytes,
but does not deliver it to a merchant/customer or prove fulfillment. Never edit the
request/job/tombstone/package/receipt ledgers directly.

Owners and administrators can review deadlines in **Security & retention → Shopify privacy
requests**. The tenant-authorized view loads stable 50-row pages in earliest-deadline order through
a tenant-bound opaque cursor. It exposes only the shop domain, topic, API version, received/due
times, bounded object-identifier count, and aggregate raw-deletion states. It does not expose
customer IDs, order IDs, webhook/event IDs, payload digests, object keys, or checksums.
`customers/data_request` always displays that a merchant data package is required; do not interpret
the absence of raw-deletion jobs as completion. An owner/administrator may choose **Prepare evidence
package**, enter an audit-visible reason, acknowledge the declared scope, and download the
fixed-name JSON package. The operation fails without a partial file if linked evidence exceeds 100
provider records/five MiB or any raw object is absent, malformed, or fails its checksum. The browser
buffers the complete package and records a digest-bound receipt before starting the download.
Receipt authority expires after ten minutes if unused and is bound to the same active membership. If
receipt acknowledgement fails, the UI must not start the download; retry by preparing a new package
rather than bypassing the receipt route.

Before controlled delivery, review the package limitations and contents on an approved endpoint,
verify the intended merchant recipient through a separate trusted channel, use an approved encrypted
transfer with expiry and access logging, and record delivery, acknowledgement, package
deletion/expiry, reviewer, and case reference outside ReconAI. The ReconAI audit proves preparation
plus authenticated-browser receipt only and records `not_delivered`; it does not prove transfer,
recipient identity, review, fulfillment, or downloaded-copy deletion. Never email the JSON as an
ordinary attachment, paste payloads or receipt tokens into tickets/logs, rename an incomplete manual
selection as complete, or clear `action_required` solely because a download succeeded. Requests over
the bounds require owner/security review and a separately approved export method. Use
database/repository access only for approved incident investigation, never as the normal operator
workflow.

The default-enabled privacy deadline monitor creates one immutable escalation at seven days, 24
hours, and overdue as each threshold is reached. Configure
`PROVIDER_PRIVACY_DEADLINE_MONITOR_INTERVAL_MS` between one minute and one day and
`PROVIDER_PRIVACY_DEADLINE_MONITOR_BATCH_SIZE` between 1 and 500. A 15-minute/100-row default is a
software bound, not an approved operational policy. New seven-day/24-hour signals emit an aggregate
warning; overdue signals emit an aggregate error. Route those structured service logs into an
approved paging or case-management rule without using tenant/request IDs as metric labels. Alert on
scan failures, persistent full batches, overdue creation, and worker silence. Record external
delivery, acknowledgement, owner, remediation, and closure in the incident/case system; the database
signal proves threshold detection only.

If a legal hold applies, set the reasoned organization hold through the authorized retention
surface. It serializes with privacy deletion and must never be bypassed. Owner/legal review must
decide data-package delivery, legacy and canonical/provenance/audit disposition, exports,
caches/search, telemetry, replicas, noncurrent object versions, and backups. Do not clear
`action_required` merely because raw tombstones exist. For retry or dead-letter growth, inspect only
stable metadata, repair storage/database authority, and resume through the bounded claimant.

For Shopify, verify the connection uses its canonical `*.myshopify.com` domain and the approved
quarterly API version. `PROVIDER_SYNC_PAYLOAD_INVALID` can mean Shopify returned a different
version; inspect redacted telemetry and stop to review the version/contract instead of accepting
fall-forward. Authorization failures may mean missing order scope, protected customer-data access,
or history access. The adapter rejects refund snapshots requiring more than 100 transaction nodes
rather than silently truncating.

### Periodic provider gap repair

Periodic repair is disabled by default. Enable it only after approving provider capacity, cadence,
lookback, overlap, page ceiling, and alert thresholds:

- `PROVIDER_GAP_REPAIR_ENABLED=true`
- `PROVIDER_GAP_REPAIR_INTERVAL_MS` controls the scan cadence from one minute to one day.
- `PROVIDER_GAP_REPAIR_LOOKBACK_MS` controls the positive repair window up to 30 days.
- `PROVIDER_GAP_REPAIR_OVERLAP_MS` controls bounded overlap and must be less than the lookback.
- `PROVIDER_GAP_REPAIR_MAXIMUM_PAGES` controls automatic pages from 1–25.
- `PROVIDER_GAP_REPAIR_BATCH_SIZE` controls each due-connection scan from 1–100.

The scheduler uses the fixed `provider-gap-repair-scheduler` system identity and only creates
immutable run/outbox/audit authority; it never contacts a provider directly. The existing outbox
relay and provider-sync worker perform the request. A shared per-organization/connection advisory
lock and deterministic cadence-slot idempotency prevent an automatic run from racing another
automatic or operator run. `action_required`, `backfilling`, and `disconnected` connections, those
without a separate read credential, and connections with an active run are not eligible.

Monitor connector run history for `Automatic repair`, the corresponding system-actor audit event,
oldest outbox age, retry codes, and `partial` page-ceiling results. A partial automatic run is not
silently extended. During provider instability or unexpected capacity pressure, set
`PROVIDER_GAP_REPAIR_ENABLED=false`, restart the worker, preserve existing immutable runs, and let
already claimed work reach a known terminal/error boundary. Do not impersonate a membership,
manually insert a run, or broaden the configured bounds.

## Reconciliation discrepancy regression

Pause new runs for the affected rule version; do not alter existing matches/exceptions. Identify
input snapshot, policy, rule, connector/normalizer versions. Reproduce with authorized minimized or
synthetic data. Ship a new rule version and migration/repair plan; supersede affected artifacts and
retain audit. Notify affected tenants based on verified impact.

## Reconciliation occurrence snapshot gap

After migration 0043 and the new-worker cutover, monitor the two missing-snapshot queries in ADR
0028 using the recorded cutover instant. A nonzero result means an older worker is still writing, a
new worker failed before completing its tenant transaction, or the deployed image/schema contract
does not match. Stop new dispatch if the count grows, record aggregate tenant-safe counts plus image
and migration identifiers, inspect queue consumers, and preserve the affected run/occurrence rows.

Do not copy current artifact evidence into the snapshot tables, update an existing snapshot, disable
the append-only trigger, or call a legacy projection exact. Drain the mismatched worker and use a
reviewed forward fix. `RUN_ARTIFACT_SNAPSHOT_CONFLICT` is an integrity signal: pause the affected
worker path and compare deterministic minimized inputs, rule/engine versions, and stored snapshot
evidence before resuming. Application rollback leaves the additive tables in place.

## Audit-chain integrity failure

Treat `AuditChainIntegrityError`, migration 0039 preflight failure, or an audit insert rejected by
the predecessor/genesis/hash constraints as an integrity incident. Stop audit-producing mutations
for the affected tenant—or all writers when migration scope is unknown—while preserving read-only
access and database/error evidence. Do not retry in a tight loop, edit audit rows, disable triggers,
drop constraints, invent a predecessor, or restore an older application writer.

Using approved read-only incident access, determine whether the condition is a malformed/duplicate
digest, fork, orphan, missing/multiple genesis, unreachable event, or capacity/lock failure. Verify
backup state and compare a restored isolated copy before proposing any repair. Escalate to the
security/data owner with tenant scope, correlation IDs, migration version/checksum, and redacted
counts—not before/after payloads. Recovery is a reviewed forward migration or compatible writer;
immutable history is never silently re-chained. After recovery, prove exactly one topological head,
full genesis reachability, canonical version-2 recomputation for new rows, tenant isolation, and
normal update/delete denial before resuming writes.

## Database/object/Redis

For database saturation, identify query/lock/connection cause before terminating work. Preserve
transactions that protect idempotency. For object failure, stop payload-dependent normalization but
retain receipts/outbox for replay. For Redis failure, stop accepting work that cannot be durably
queued; do not process from an untracked in-memory fallback.

For disaster-recovery reconstruction, keep workers and outbound connectors stopped, compare the
isolated PostgreSQL restore first, and provision a completely empty isolated Redis logical database.
Follow `docs/backup-restore.md`; the exact-confirmation `pnpm backup:rebuild-queue` command handles
only a bounded preflighted set classified by the restored outbox and durable job-execution ledger.
Approve an explicit stale-before instant and restored PostgreSQL system identifier. Active,
succeeded, dead-lettered, and legacy published/no-ledger rows remain excluded; this is not
permission to replay historical published rows. Preserve the source recovery snapshot, aggregate
output/digests, append-only recovery evidence, queue counts, excluded-state summary, and any
mid-command failure before starting normal workers. A non-empty Redis refusal requires incident
review, not flushing and blind rerun.

## API authorization contract

An API image that registers a method/template absent from the typed route-security inventory fails
startup. Treat this as a release defect: compare the registered route with ADR 0021, review its
public/identity/provider-signature/tenant boundary and exact permissions, update the manifest and
negative tests, then rebuild. Do not remove the registration hook, mark a tenant route as public, or
reuse provider-signature classification to restore availability.

For suspected enumeration, compare only bounded status/route-template aggregates: missing or invalid
authentication should return `401`, while an authenticated foreign/missing membership and
insufficient permission should both return the same `404 RESOURCE_NOT_FOUND`. Do not log raw bearer
tokens, subject IDs, organization IDs, or timing samples tied to customer identity. Escalate any
handler execution after authorization denial as SEV-1 and preserve the correlation ID plus redacted
route contract.

## Distributed request limiter and proxy trust

Production API replicas must use the same Redis authority and `API_RATE_LIMIT_KEY_SECRET`. Fastify
trusts forwarding data only from `API_TRUST_PROXY_CIDRS`; verify the actual direct peer addresses
after every load-balancer, ingress, or network change. A public address, `/0`, or a copied client
forwarding chain is never an emergency substitute. The public reference Nginx edge derives
`X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Host`, and `X-Forwarded-Proto` itself and removes
`Forwarded`; `$proxy_add_x_forwarded_for` is forbidden at that trust boundary. If an approved proxy
precedes Nginx, use an exact `set_real_ip_from` allowlist to derive `$remote_addr`, then rerun the
forwarding-spoof proof through the complete chain.

The global application budget is 120 requests per verified client address per 60 seconds, with
tighter route budgets for sensitive operations. Nginx applies an independent connected-peer budget
to `/api/*` BFF/auth traffic and `/v1/*` Fastify traffic. `/health/live` bypasses the application
limiter so a Redis incident does not trigger a restart storm; normal and readiness traffic remains
fail closed. `pnpm edge:check` enforces the canonical static contract. Before accepting an edge
configuration, run `LIVE_EDGE_NGINX_BIN=<reviewed-absolute-path> pnpm verify:live-edge` with the
intended Nginx build and archive the redacted JSON output plus binary/configuration digests.

The reference edge access log must use only the reviewed `reconai_access` JSON format. Do not add
`$request`, `$request_uri`, `$args`, `$query_string`, referrer, cookie, authorization, user-agent,
or the default combined format: callback queries can contain short-lived credentials. Correlate
using the generated request ID, query-free normalized path, response status, bytes, duration, and
redacted application events. Any external load balancer, CDN, hosting platform, or collector must
prove the same query omission, least-privileged access, and approved retention before protected use.
Treat a discovered callback query in durable logs as a security incident: restrict access, preserve
only redacted metadata needed for investigation, rotate or revoke still-live authority where
applicable, and follow the incident process.

For an unexpected 429 increase, correlate only bounded aggregate counts, response layer, route
template, environment, and correlation IDs. Confirm whether the edge observed a shared upstream
proxy address and whether Fastify selected the intended first untrusted hop. Never log forwarding
chains, raw Redis keys, authorization values, or tenant/customer data for diagnosis.

For limiter Redis failure, keep the edge control active and restore the dedicated bounded Redis
connection. Do not enable local or fail-open production behavior. Before reopening normal traffic,
send a bounded approved probe across at least two API replicas and prove that request 121 in one
minute is rejected by the shared application budget. Key rotation is a security-managed operation:
coordinate a drain/restart of all replicas because mixed keys create parallel budgets, then confirm
the old namespace expires naturally. Rotation changes only pseudonymous counters, not sessions,
tenant state, or financial evidence.

For a bounded local repeat, build a fresh supported Redis binary and supply its reviewed absolute
path, exact version, SHA-256, and an isolated writable runtime directory to
`pnpm verify:live-api-rate-limit` through the `API_RATE_LIMIT_*` process environment. The verifier
uses only synthetic documentation-range addresses, generates ephemeral credentials in memory, starts
compiled API processes with production configuration, removes its Redis state, and records no raw
address, forwarding chain, Redis key/credential, HMAC key, authorization value, or correlation ID.
Never point it at shared, protected, customer, staging, or production infrastructure.

## Raw-object retention

Retention is disabled when a class duration is blank. Before enabling it, record the approved
organization/class/duration, verify object-version and backup lifecycle separately, and confirm the
administrator understands that raw deletion is permanent while canonical/provenance/audit evidence
remains.

For an emergency stop, enable a reasoned legal hold or set both durations to blank, then verify no
retention transaction remains active. Do not kill a transaction while its object request may have
completed; allow the 15-second request bound and database outcome recording to resolve first.

For retry or dead-letter growth, inspect only the stable error code, attempt count, source class,
eligibility time, and storage/database health—never raw payloads or credentials. Fix integrity,
authorization, availability, or lifecycle configuration, then replay a bounded batch through the
normal claimant. Do not directly update jobs or tombstones. Reconcile each terminal job to one
append-only tombstone and sample that the current key is absent; separately sample noncurrent object
versions and backup expiry because the application receipt does not cover them.

## Restricted support diagnostics

Support access is off unless `SUPPORT_ACCESS_ENABLED=true`. Before enabling it, record
owner/security approval for the exact environment, configure one signed IdP group claim and one
exact MFA authentication-context (`acr`) value, verify both claims in a short-lived API access
token, and inject a dedicated 32–64 byte base64url `SUPPORT_IDENTITY_HMAC_KEY`. The key must not be
reused for sessions, rate limiting, connectors, webhooks, or other identity indexes. Every API
replica needs the exact same configuration.

The supported flow is deliberately two-party and organization-blind until customer approval:

1. An eligible support identity opens `/support` and creates a request for only a duration from 5 to
   60 minutes. The organization-blind BFF calls `POST /v1/support/access-requests`. The response
   returns one random request code once and expires in 15 minutes. The page keeps the code only in
   memory: do not reload until transfer is complete, and use **Clear code** immediately afterward.
   Do not put the code in logs, shell history, browser storage, URLs, telemetry, general chat, or an
   unauthenticated ticket comment.
2. Transfer the code through the existing authenticated support-ticket channel. The customer owner
   verifies the requester and ticket out of band, opens **Security → Restricted support access** in
   the exact selected organization, and approves the request. That tenant BFF calls
   `POST /v1/organizations/:organizationId/support-access-grants` with the exact organization
   confirmation, code, ticket reference, and reason. A tenant administrator, analyst, reviewer, or
   auditor cannot approve it. The browser clears the code as soon as submission begins.
3. The returned grant is valid only for the requested interval and only for the requesting support
   identity's `diagnostics:view` capability. In `/support`, the support caller enters the exact
   grant and organization from the authenticated ticket. The support BFF calls
   `GET /v1/support/organizations/:organizationId/diagnostics`; there is no organization list,
   tenant selector, search, or identifier-bearing URL. Denied, expired, revoked, foreign, and
   malformed diagnostic authority receives one unavailable state.
4. The owner reviews `support.access.approved`, `support.diagnostics.viewed`, and
   `support.access.revoked` in the normal tenant audit history. End access through **Revoke access**
   in the same tenant Security surface, which calls
   `POST /v1/organizations/:organizationId/support-access-grants/:grantId/revoke`; do not update the
   database directly. Repeated revocation is safe and does not append a second revocation event.

The diagnostics response is not permission to open raw records. It contains only fixed capped
counts/timestamps for connection health, provider sync, reconciliation, unresolved exceptions, and
outbox state. Never ask a customer to paste payloads, source records, amounts, credentials, exports,
OIDC claims, identity digests, or database rows into the ticket to compensate for this limit.

Emergency stop: set `SUPPORT_ACCESS_ENABLED=false` consistently, restart/drain all API replicas,
revoke known active grants through tenant owners, revoke/offboard the IdP identity or group as
appropriate, preserve correlation IDs and tenant audit evidence, and perform a ticket-to-grant/
access review. Disabling new support authentication does not rewrite or delete durable grant/audit
evidence. Treat diagnostic access without a current approved ticket/grant as a privileged-access
incident.

Key rotation has a bounded drain procedure rather than overlapping keys. Disable new requests,
revoke active grants where possible, wait at least 60 minutes after the last approval and 15 minutes
after the last unclaimed request, rotate the secret in every API replica together, verify that the
old keyed namespace no longer authorizes a probe, then reenable only with owner approval. Mixed keys
cause legitimate grants to fail closed. Do not keep the old key in application configuration as an
undocumented fallback.

Quarterly review must reconcile the configured IdP group membership, approved ticket references,
tenant audit events, revocations/expiries, and operator offboarding. A bounded ticket string is not
proof that an external ticket exists; protected-environment evidence must include ticket ownership,
status, approval, and response timing. Expired unclaimed request-row retention has no approved purge
policy yet and must be included in the privacy/retention review.

## Routine schedule (proposed)

Daily: readiness, backups, queue/DLQ, connector freshness, security alerts. Weekly: dependency
alerts, restore sample/checksum, capacity trends, failed deletion/export. Monthly: access review,
key/secret age, SLO/error budget, tenant-isolation suite, runbook contact validation. Quarterly:
full restore and incident exercise, privileged access review, threat model, retention deletion,
provider scopes/API versions, disaster assumptions.

No exercise is marked complete until dated evidence and remediation are linked from `GOALS.md`.

## Telemetry alert policy pack

The backend-neutral policy at `infra/observability/operational-alert-policy.yaml` defines 13
proposed rules for the lease-owned durable-queue, unresolved-exception, and active-provider-sync
monitors. It is deliberately `productionEnabled: false`. The file is a reviewed input to a future
backend adapter, not an installed Prometheus, Grafana, cloud-monitoring, paging, or ticketing rule.
Its one-day/three-day exception, five-/fifteen-minute queue-frontier, and 30-minute/two-hour active
sync thresholds are proposed operating defaults, not measured SLOs or customer commitments.

The 20-minute silence window covers two complete cycles at the configured maximum five-minute
monitor interval plus maximum five-minute metric-export interval. A deployment using different
collector buffering, ingestion delay, or evaluation timing must increase and exercise the bound. Do
not shorten it from local defaults alone.

When a rule fires:

| Signal family                            | First bounded checks                                                                                                                                                                    | Do not infer                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| monitor failure or invalid time evidence | Check worker liveness, the lease-owning replica, Redis/database availability, clock synchronization, and the fixed poll outcome. Clear snapshots on failure; do not reuse stale gauges. | A provider/customer outage, a tenant identity, or a financial discrepancy from the aggregate signal |
| monitor silence                          | Independently check worker process readiness, collector availability/rejections, OTLP egress/TLS, backend ingestion, then lease acquisition.                                            | An empty queue; silence is an unknown state and must alert                                          |
| failed jobs or old dispatchable frontier | Inspect bounded job metadata, stable error codes, attempts, queue storage, worker capacity, and dependency health. Replay only through the normal authorized claimant.                  | Permission to mutate queue rows, bypass idempotency, or alter financial evidence                    |
| oldest unresolved exception              | Confirm the environment-wide gauge and review staffing/workflow health; use the tenant-authorized review queue to locate work.                                                          | Tenant identity, exception count/severity, SLA breach, or permission to approve                     |
| oldest queued/running provider sync      | Split only by fixed provider/status; check circuit state, provider status/rate limits, durable retry state, and the connection health surface.                                          | Which tenant/connection is affected, provider completeness, or permission to bypass the circuit     |

Never add organization, user, membership, connection, record, event, payment, job/request ID,
credential, token, email, raw URL, or provider error text to alert labels, annotations, routing
keys, or notification bodies. A responder may pause or drain through an already authorized
operational control, but an alert never authorizes a source-system write, financial approval,
deterministic-rule override, direct database/queue mutation, retention deletion, permission change,
or AI action.

Before promotion, an owner must approve a separate backend-specific decision and evidence all of the
following:

1. Translate exact OpenTelemetry metric names, units, counter temporality/rates, fixed filters, and
   groupings for the selected collector/backend. Threshold no-data remains normal because an absent
   active-sync age is valid when no sync is active; retain dedicated monitor-counter absence alerts
   and evaluation-error alerting.
2. Prove each warning, critical escalation, invalid/failure path, and 20-minute silence path with
   synthetic protected-environment telemetry. Exercise collector rejection/outage and worker loss
   independently.
3. Prove notification routing, on-call receipt, acknowledgement, escalation, bounded deduplication,
   recovery, and alert-path health without customer or credential content.
4. Measure cardinality, query cost, ingestion/evaluation delay, false positives, and threshold
   suitability under representative load. Owner-approved changes must update the source policy,
   decision, tests, and evidence together.
5. Test rollback by disabling the backend rules while leaving application telemetry and financial
   work intact. Record the exact deployed policy digest and backend translation digest.

Maintenance silences must identify an owner, reason, start, expiry, affected rule IDs, and the
narrowest service/environment selectors. Never use tenant/customer dimensions. Keep an independent
alert-path health check active, and remove the silence at expiry. Because no backend adapter or
delivery path is checked in, none of these promotion or silence exercises is currently claimed.

## Telemetry triage

Use route templates, fixed job/provider/surface/source/outcome values, service, environment, and
trace ID when triaging; never add organization, user, connector, job, event, payment, provider
error, requested-by, or raw URL values as metric labels. A total signal gap can mean application
outage, collector/egress failure, backend rejection, or alert-path failure. Check process liveness
independently, then collector availability/rejections, egress/TLS, backend ingestion, and only then
application instrumentation. Keep financial work running unless a separate integrity or isolation
condition requires a stop. The current local exporter contract is documented in
`docs/observability.md`; external silence and failure alerts remain unexercised.
