# ADR 0014: Append-only Shopify privacy deadline escalation

Status: accepted  
Date: 2026-07-28

## Context

Shopify privacy requests have a recorded 30-day due time and remain action-required until a human
completes every applicable delivery and disposition obligation. The operator view made deadlines
visible, but visibility alone did not produce durable evidence that the system detected an
approaching or crossed deadline. A process-local timer must also work across many organizations
without granting the worker unrestricted tenant-table access or putting privacy identifiers in logs
and metric labels.

The system cannot honestly claim external notification or human response without an approved
paging/case-management integration and an exercised delivery path. It can, however, create a
minimal, idempotent internal escalation boundary that such an integration can consume.

## Decision

- Add a forced-RLS, append-only `provider_privacy_request_deadline_alerts` ledger. Each row contains
  only organization/request authority, one `due_7_days`, `due_24_hours`, or `overdue` stage, the
  immutable due-time snapshot, and the observation time.
- A unique `(organization_id, request_id, stage)` key makes repeated and concurrent scans
  idempotent. Database checks bind every stage to its exact time window and require creation time to
  equal observation time.
- The worker receives no direct table access. A fixed `SECURITY DEFINER`, RLS-on candidate function
  returns at most 500 internal organization/request IDs, stages, and due times for requests inside
  the final seven-day window. Its supplied time must be within five minutes of the database clock.
- For each candidate, the worker opens an exact tenant transaction and calls a second narrow
  function. That function verifies the active tenant, immutable request/deadline, database-derived
  stage, clock proximity, and action-required state under an advisory lock before inserting.
- A successful insert and a hash-chained `provider_privacy.deadline_alerted` system audit event
  commit in the same tenant transaction. The audit value contains stage, due time, and status only.
- The monitor runs immediately and at a startup-validated one-minute-to-one-day cadence. Batch size
  is startup-validated from 1–500. It is enabled by default because it performs only bounded local
  database work and does not contact a provider or third party.
- New seven-day or 24-hour signals emit an aggregate warning. New overdue signals emit an aggregate
  error. Logs contain scan counts only—no organization, request, shop, customer, order, or object
  identifiers.
- The owner/administrator operator projection exposes only the highest durable stage and observation
  time alongside the existing minimized request fields. It does not expose the alert-row ID or any
  privacy-subject/storage authority.

## Consequences

Threshold detection becomes replay-safe, queryable, tenant-isolated evidence rather than an
ephemeral log line. Concurrent worker replicas cannot duplicate a stage, and a compromised browser
or application role cannot mint or mutate signals. A foreign tenant cannot read them. The monitor
can feed a production log alert without creating new copies of customer/order identifiers.

The ledger still does not prove that an external pager, email, or ticket was delivered,
acknowledged, remediated, or closed. It also cannot mark the underlying privacy request complete;
all requests remain action-required because merchant delivery, canonical/legacy disposition, and
independent-copy expiry remain separate obligations.

## Alternatives

A mutable `alerted_at` column on the request was rejected because it would weaken append-only
request evidence and collapse multiple thresholds. Logging request identifiers directly was rejected
because logs are broader, longer-lived privacy copies. A global worker table grant was rejected
because it would permit unrestricted cross-tenant enumeration/mutation. Sending email or creating
tickets directly from this migration was rejected because no delivery provider, recipient policy,
secret boundary, retry model, or acknowledgement contract has been approved.

## Migration, rollback, and verification

Migration 0038 is additive. It creates the alert ledger, constraints, forced RLS, append-only
trigger, migrator policy, and two fixed worker-only functions. It does not backfill historical
signals or rewrite/delete request, financial, or object evidence. Apply it before starting a worker
image that enables the monitor.

Application rollback sets `PROVIDER_PRIVACY_DEADLINE_MONITOR_ENABLED=false` and returns to the prior
worker/API/web image while leaving alert/audit evidence dormant. Do not drop or edit the ledger.
Restarting a compatible worker safely resumes from unique request/stage state.

Synthetic verification covers exact threshold boundaries, bounded configuration, fixed-function and
role/RLS structure, tenant/API allowlisting, worker scheduling, idempotent future PostgreSQL
coverage, minimized multi-page rendering, overdue/24-hour UI states, and accessibility. Current live
PostgreSQL execution plus external alert delivery, acknowledgement, response, and worker-silence
exercises remain required.
