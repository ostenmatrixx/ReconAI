# Backup and restoration

Proposed objectives (not achieved): RPO 24 hours and RTO 4 hours. Staging measurements must revise
these. Backups are incomplete unless PostgreSQL, object versions, configuration/key references, and
queue recovery semantics form a recoverable consistency point.

## Backup design

- PostgreSQL: encrypted automated base backup plus WAL/point-in-time recovery; separate
  least-privilege backup identity and account/location; retention and immutable/versioned copies.
- Object storage: encryption, versioning, lifecycle, replication or backup inventory/checksums.
- Redis: Redis is not the financial source of truth; configure persistence appropriate to BullMQ,
  while outbox/job-execution records permit safe reconstruction. Document in-flight boundary.
- Configuration: versioned non-secret manifests and recoverable secret-manager/KMS configuration;
  keys remain separately protected and tested for decryptability.
- Audit backup job result, size, checksum/inventory, age, and alert. Never log backup credentials.

## Logical restore comparison

`pnpm backup:verify` is a read-only comparator for an approved source snapshot and an isolated
logical restore. It streams every public table through SHA-256 inside one serializable, read-only,
deferrable transaction, then compares row counts/content digests plus columns, constraints,
policies, indexes, triggers, functions, forced-RLS flags, and application/worker grants. It emits
only table names, counts, hashes, catalog metadata digests, server/checksum state, and the
PostgreSQL system identifiers; it does not emit row contents or connection URLs.

```sh
DATABASE_BACKUP_SOURCE_URL='postgresql://<backup-reader>@127.0.0.1:5432/reconai' \
DATABASE_RESTORE_URL='postgresql://<restore-verifier>@127.0.0.1:55432/reconai' \
BACKUP_RESTORE_VERIFY_CONFIRMATION='COMPARE-ISOLATED-RESTORE' \
pnpm backup:verify
```

The verifier defaults to loopback and rejects the same URL, the same cluster system identifier,
catalog/data drift, a server-version mismatch, or a restored cluster without data checksums.
`BACKUP_RESTORE_VERIFY_ALLOW_NON_LOOPBACK=true` is only for an approved isolated remote drill with
new credentials and documented egress controls. The command scans all public data and can be
expensive; never point it at an active production writer or run it without a capacity/timeout plan.
Treat the metadata-only output as internal operational evidence.

This comparator does not create a backup, inspect archive encryption, validate untrusted dump code,
restore object versions, reconstruct Redis queues, prove key decryptability, or establish RPO/RTO.
PostgreSQL warns that restoring a dump executes code selected by the source superuser; trust and
inspect the source/archive before restoration, use `pg_restore --exit-on-error`, and restore only
into an isolated target. See the official
[SQL dump guidance](https://www.postgresql.org/docs/17/backup-dump.html) and
[`pg_restore` warning](https://www.postgresql.org/docs/17/app-pgrestore.html).

## Tenant object-version comparison

`pnpm backup:verify-objects` is a read-only comparator for one server-generated tenant prefix in a
versioned backup bucket and an isolated restored bucket. Both buckets must report versioning
`Enabled`. The command paginates every object version and delete marker under
`<environment>/<organization UUID>/`, streams each object through bounded SHA-256 verification,
checks its `content-sha256` metadata, and compares body, content-type, custom-metadata, logical
history order, and current delete-marker/object state. Provider-assigned version IDs and restoration
timestamps are intentionally not treated as portable identities.

```sh
OBJECT_BACKUP_SOURCE_ENDPOINT='http://127.0.0.1:9100' \
OBJECT_BACKUP_SOURCE_REGION='us-east-1' \
OBJECT_BACKUP_SOURCE_BUCKET='<approved-backup-bucket>' \
OBJECT_BACKUP_SOURCE_ACCESS_KEY_ID='<source-reader>' \
OBJECT_BACKUP_SOURCE_SECRET_ACCESS_KEY='<injected-secret>' \
OBJECT_RESTORE_ENDPOINT='http://127.0.0.1:9200' \
OBJECT_RESTORE_REGION='us-east-1' \
OBJECT_RESTORE_BUCKET='<isolated-restored-bucket>' \
OBJECT_RESTORE_ACCESS_KEY_ID='<restore-reader>' \
OBJECT_RESTORE_SECRET_ACCESS_KEY='<injected-secret>' \
OBJECT_RESTORE_ENVIRONMENT='<environment>' \
OBJECT_RESTORE_ORGANIZATION_ID='<organization UUID>' \
OBJECT_RESTORE_VERIFY_CONFIRMATION='COMPARE-ISOLATED-TENANT-OBJECTS' \
pnpm backup:verify-objects
```

The defaults cap the scan at 10,000 versions, 10 MiB per object, 1 GiB total, and 15 seconds per
request; the bounded environment overrides must be approved before a larger scan. The verifier
defaults to loopback, requires HTTPS for an explicitly approved non-loopback drill, rejects a
source/target bucket identity match, and emits aggregate counts and hashes without object keys,
bodies, or credentials. It fails closed when timestamps cannot unambiguously reconstruct a
provider-neutral history order; use and retain a provider-native ordered inventory in that case.

This command verifies an already restored tenant prefix. It does not copy objects, prove the
backup/replication mechanism, compare object tags or object-lock/legal-hold state, validate
lifecycle/replication/KMS configuration, or prove that database and object snapshots share a
consistency point. S3-compatible versioning retains noncurrent versions and represents a
non-version-specific delete as a delete marker, so current-object listing alone is not acceptable
restore evidence. See the official
[S3 version-listing semantics](https://docs.aws.amazon.com/AmazonS3/latest/userguide/list-obj-version-enabled-bucket.html)
and
[MinIO versioned deletion behavior](https://min.io/docs/minio/linux/administration/object-management/object-delete.html).

## Empty-Redis classified queue reconstruction

`pnpm backup:rebuild-queue` is a state-changing recovery command for an already validated, isolated
PostgreSQL restore and a completely empty isolated Redis logical database. Run the read-only
database comparison first. The command binds the operation to the approved restored PostgreSQL
system identifier, requires an explicit stale-before instant at least 15 minutes old, and accepts a
bounded batch of at most 499 events. It uses only these database-rechecked classifications:

- `unpublished`: due, non-dead-lettered outbox authority not yet marked published;
- `never_started`: published version-1 tracking authority, or a previously recovered legacy
  unpublished authority, with no execution-ledger row;
- `retryable`: a published authority whose latest durable execution is explicitly retryable;
- `stale_running`: a published running execution whose heartbeat is no newer than the approved
  boundary and whose database lease has expired.

Active leases, succeeded/dead-lettered executions, dead-lettered outbox rows, and pre-migration
published rows without execution or recovery evidence are excluded. The command never treats
historical publication alone as proof that a job should be replayed.

```sh
DATABASE_WORKER_URL='postgresql://<restore-worker>@127.0.0.1:55432/reconai' \
REDIS_URL='redis://:<injected-secret>@127.0.0.1:6389/15' \
QUEUE_RECOVERY_ENVIRONMENT='<isolated-environment>' \
QUEUE_RECOVERY_EXPECTED_DATABASE_SYSTEM_IDENTIFIER='<approved-system-identifier>' \
QUEUE_RECOVERY_STALE_BEFORE='<approved-UTC-instant>' \
QUEUE_RECOVERY_REQUESTED_BY='<bounded-operator-identity>' \
QUEUE_RECOVERY_REASON='<approved reason of at least 20 characters>' \
QUEUE_RECOVERY_MAXIMUM_EVENTS='100' \
QUEUE_RECOVERY_CONFIRMATION='REBUILD-RECOVERABLE-IN-ISOLATED-REDIS' \
pnpm backup:rebuild-queue
```

The Redis URL must select database 1 through 15 and contain no query or fragment. The command
refuses any existing Redis key, validates every envelope against its organization/event/schema/key/
correlation authority, uses the production stable BullMQ job identity, and re-adds the same set to
prove deduplication. After each queue add, it rechecks classification and appends a tenant-bound
recovery event with recovery run, operator, reason, classification, stable job ID, and time.
Unpublished rows are marked published in that same PostgreSQL transaction. Output is limited to
counts and digests; it excludes tenant IDs, job IDs, payloads, operator/reason text, and
credentials.

Loopback is the default. Approved remote use requires `rediss:`, PostgreSQL `sslmode=verify-full`,
and `QUEUE_RECOVERY_ALLOW_NON_LOOPBACK=true`. Keep all service workers and outbound connectors
stopped while preflighting and rebuilding. Redis and PostgreSQL cannot share one transaction: if a
queue add succeeds but evidence recording fails, the command stops with a non-empty Redis database.
Preserve that state and investigate/reconcile it; do not flush and rerun blindly. Only after
reviewing the aggregate output, excluded-state summary, and append-only evidence should the normal
worker start and reauthorize every job against the tenant-bound outbox row.

Migration 0040 deliberately gives `execution_tracking_version` no database default. Deploy it while
old writers continue to create null/unclassified rows, upgrade all workers, and only then upgrade
the API/other explicit version-1 writers. The updated scheduled-repair writer opts in through a
transaction-local flag. Do not roll workers back to a pre-ledger image while version-1 producers are
active; quiesce production and drain/preserve the queue first. This expansion sequence favors a
bounded conservative recovery gap during rollout over an unsafe false `never_started`
classification.

## Restoration drill

1. Obtain explicit approval and define point, scope, isolation, success criteria, and timer.
2. Provision an isolated environment with no provider/customer egress and new access credentials.
3. Restore PostgreSQL to the selected point; validate engine/schema/migration versions and
   integrity.
4. Restore/version-select object data and compare inventory/checksums referenced by source events.
5. Configure Redis/queue empty; rebuild safe pending work from transactional outbox/job state.
6. Start services with outbound connectors/AI/email disabled.
7. Validate row counts/constraints/RLS/audit immutability; sample raw-to-canonical provenance.
8. Run a known synthetic/authorized reconciliation snapshot and confirm deterministic result.
9. Record elapsed time, achieved recovery point, gaps, evidence, and securely destroy the drill.

## Local component evidence

On 2026-07-28, two fresh loopback-only PostgreSQL 17.10 clusters with data checksums enabled were
used for a synthetic custom-format logical backup and single-transaction restore. The archive
SHA-256 and table of contents were recorded, its expanded SQL passed a bounded high-risk construct
scan, and the checked-in comparator found an exact match across 34 tables/55 rows plus every
catalog/RLS/grant digest. The restored copy passed all 11 database-backed files (34 tests),
including tenant isolation, audit topology, the populated upgrade, and deterministic reconciliation
worker execution. `pg_amcheck` completed without error and offline checksum scans reported zero bad
checksums. Evidence: `artifacts/postgresql-logical-restore-verification-2026-07-28.json`.

A second local drill used two loopback-only MinIO `RELEASE.2025-07-23T15-54-02Z` processes. The
source and restored versioned buckets matched one tenant prefix with two keys, three object
versions, one current delete marker, 66 bytes, and exact history/current-state digests. A separate
PostgreSQL 17.10 custom dump containing one unpublished outbox event restored into a distinct
checksummed cluster with exact 34-table/48-row and catalog/RLS/grant digests. Authenticated Redis
8.2.8 database 15 began empty; the guarded command published exactly one stable tenant-authorized
waiting job, duplicate replay retained one job, and the restored database had zero unpublished
events afterward. Evidence:
`artifacts/object-and-unpublished-queue-restore-verification-2026-07-28.json`.

A third local component exercise applied the 41-migration schema to a fresh data-checksummed
PostgreSQL 17.10 cluster and used authenticated protected-mode Redis 8.2.8 database 15. Restricted
application/worker tests passed the token-digest execution lifecycle, heartbeat, terminal
immutability, forged-tenant denial, append-only recovery evidence, rolling-writer tracking, and
legacy/active/succeeded/dead-letter exclusions. The guarded command then reconstructed ten stable
waiting jobs from an initially empty database: six unpublished, two never-started, one retryable,
and one stale-running. Duplicate replay retained ten jobs; a second command invocation refused the
non-empty database, and a separate wrong-system-identifier invocation failed before Redis mutation.
Evidence: `artifacts/durable-queue-recovery-verification-2026-07-28.json`.

These are local synthetic components, not a completed disaster-recovery claim. They do not achieve
the proposed RPO/RTO or prove an atomic database/object recovery point, encrypted/immutable backup
storage, base backup/WAL/PITR, KMS/key/configuration recovery, object tags/lock/lifecycle/
replication, an atomic Redis/PostgreSQL recovery transaction, representative volume, prior-image
runtime compatibility, staging cutover, or external alerts. The latest queue exercise used a fresh
synthetic cluster rather than a restored production-like base backup.

## Production recovery

Contain writes and preserve incident evidence. Never restore over the only production copy. Restore
and validate isolated, determine data divergence, then use an approved cutover/reconciliation plan.
Replayed jobs are bounded, tenant-scoped, idempotent, and reason-audited. Communicate verified loss
window and limitations.

## Required evidence

Dated backup success and age; encrypted storage/access review; restore transcript; achieved RPO/RTO;
database/object integrity; RLS/tenant tests; audit immutability; deterministic replay; queue
rebuild; and remediation owners. No restoration claim exists until this evidence is linked in
`GOALS.md`.
