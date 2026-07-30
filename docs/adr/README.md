# Architecture decision records

ADRs are immutable after acceptance except status/link corrections. Superseding a decision creates a
new ADR and links both. Use: context, decision, consequences, alternatives, security/tenant/
financial/operational effects, migration/rollback, and status.

Connector credential lifecycle decisions are split between
[ADR 0011](0011-encrypted-connector-credential-lifecycle.md) for tenant-bound envelopes and
[ADR 0012](0012-provider-oauth-authorization-refresh-and-revocation.md) for provider authorization,
refresh, and provider-confirmed revocation.

Shopify mandatory privacy intake and bounded raw-object erasure are defined by
[ADR 0013](0013-shopify-mandatory-privacy-webhook-boundary.md).

Append-only, tenant-bound deadline escalation for those requests is defined by
[ADR 0014](0014-shopify-privacy-deadline-escalation.md).

Bounded, complete-or-fail preparation of linked Shopify customer-data evidence is defined by
[ADR 0015](0015-bounded-shopify-customer-data-evidence-package.md).

Tenant-linear audit topology and canonical version-2 event hashing are defined by
[ADR 0016](0016-deterministic-audit-chain-topology.md).

Complete bounded ambiguous-candidate ranking and fail-closed overflow are defined by
[ADR 0017](0017-fail-closed-ambiguous-candidate-overflow.md).

Distributed API request budgets, pseudonymous network keys, and explicit reverse-proxy trust are
defined by [ADR 0018](0018-distributed-api-rate-limit-and-proxy-trust.md).

Immutable container inputs and non-publishing signed candidates are defined by
[ADR 0019](0019-immutable-container-inputs-and-signed-candidates.md).

Provider-initiated OIDC logout and the distributed local-session revocation index are defined by
[ADR 0020](0020-oidc-backchannel-session-revocation.md).

Fail-closed API route classification, centralized tenant admission, and foreign-tenant response
concealment are defined by [ADR 0021](0021-fail-closed-api-route-authorization-contract.md).

Token-digest worker leases, conservative published-job classification, and guarded empty-Redis
reconstruction are defined by [ADR 0022](0022-durable-job-execution-and-queue-recovery.md).

Process-only liveness and bounded, opaque PostgreSQL/Redis/object-storage readiness are defined by
[ADR 0023](0023-bounded-composite-api-readiness.md).

Identity-derived literal search, stable keyset organization pagination, and exact selection
verification are defined by [ADR 0024](0024-identity-derived-organization-directory-pagination.md).

Verified-identity, first-membership-only organization creation with durable retry evidence is
defined by [ADR 0025](0025-identity-bound-first-organization-bootstrap.md).

Provider-neutral malformed-identifier detection, display-safe evidence, and fail-closed canonical
record quarantine are defined by [ADR 0026](0026-fail-closed-malformed-identifier-quarantine.md).

Unique evidence-backed refund/accounting linkage, bounded candidate overflow, and explicit
processing-fee duplicate classification are defined by
[ADR 0027](0027-unique-refund-accounting-linkage.md).

Immutable per-run occurrence snapshots, honest rolling-window projections, and bounded operator
evidence are defined by [ADR 0028](0028-immutable-reconciliation-occurrence-evidence.md).

Bounded, whole-bucket, money-conserving refund/accounting split linkage is defined by
[ADR 0029](0029-conserved-refund-accounting-splits.md).

Tenant-bound keyset traversal of immutable run artifacts, including cursor and response ceilings, is
defined by [ADR 0030](0030-tenant-bound-run-artifact-pagination.md).

Tenant-bound ordinal traversal of immutable pinned run inputs is defined by
[ADR 0031](0031-tenant-bound-run-input-pagination.md).

Bounded, atomic persistence of maximum-size reconciliation run input ledgers is defined by
[ADR 0032](0032-bounded-reconciliation-run-input-persistence.md).

Bounded, cancellation-aware creation of one atomic reconciliation run authority is defined by
[ADR 0033](0033-bounded-reconciliation-run-creation-deadline.md).

Prompt public deadline settlement while a signal-guarded, non-cancellable pool acquisition drains is
defined by [ADR 0034](0034-prompt-run-creation-deadline-settlement.md).

Fail-fast process-local admission that retains capacity until hidden run-creation database work
settles is defined by [ADR 0035](0035-bounded-run-creation-admission.md).

Locally sampled, versioned trace context that becomes trusted only after exact durable outbox
authority is defined by [ADR 0036](0036-authenticated-durable-trace-context.md).

Lease-owned, constant-size durable queue telemetry with expiring observable snapshots is defined by
[ADR 0037](0037-leased-durable-queue-observability.md).

Manifest-derived provider webhook ingress and post-authority normalization telemetry with closed
attribute vocabularies is defined by [ADR 0038](0038-bounded-provider-ingestion-observability.md).

At-most-once, post-normalization provider-event source-lag samples with bounded timestamp
classification are defined by [ADR 0039](0039-bounded-provider-event-freshness-samples.md).

Post-commit proposal-review decision ages with bounded timestamp classification and no customer
dimensions are defined by [ADR 0040](0040-bounded-proposal-review-decision-age.md).

Identifier-free, bounded freshness observations derived from the existing scheduled provider
gap-repair candidate scan are defined by
[ADR 0041](0041-bounded-provider-gap-repair-freshness-observability.md).

Post-commit, threshold-crossing approved-exception final-resolution age with bounded timestamp
classification and no customer dimensions is defined by
[ADR 0042](0042-bounded-exception-final-resolution-age.md).

Lease-owned, environment-wide oldest-unresolved exception gauges over a restart-safe concurrent
partial index and fixed worker-only database authority are defined by
[ADR 0043](0043-lease-owned-unresolved-exception-queue-age.md).

Lease-owned, fixed-provider oldest queued/running sync gauges over an online partial index and
worker-only database authority are defined by
[ADR 0044](0044-lease-owned-provider-active-sync-age.md).

Distributed, tenant/connection-scoped provider page-request admission with atomic Redis
open/half-open state and retry-after-aware durable backoff is defined by
[ADR 0045](0045-distributed-provider-request-circuit.md).

Tenant-authorized, fixed-family source-object watermarks with an online tenant/connection access
path and no completeness claim are defined by
[ADR 0046](0046-tenant-authorized-source-object-watermarks.md).

Append-only, tenant-scoped classification separates fixed source-object families from provider event
topics and supersedes ADR 0046's direct-topic aggregation premise in
[ADR 0047](0047-source-event-object-family-classification.md).

Bounded two-phase Stripe Events and charge-balance-transaction recovery, minimized fee evidence, and
versioned rolling cursor compatibility are defined by
[ADR 0048](0048-bounded-stripe-balance-transaction-recovery.md).

Digest-only, tenant/request/package/same-membership-bound Shopify privacy-package browser receipts,
ten-minute unused authority, and precise non-delivery semantics are defined by
[ADR 0049](0049-digest-bound-privacy-package-browser-receipts.md).

Backend-neutral, low-cardinality operational alert rules that remain production-disabled pending
owner-approved backend translation and protected exercises are defined by
[ADR 0050](0050-production-disabled-operational-alert-policy.md).

Dedicated-role, object-integrity-verified, exact-classifier, audit-chained repair of legacy
source-event classification gaps is defined by
[ADR 0051](0051-bounded-source-event-classification-repair.md).

Exclusive activation serialized against shared source-writer transactions, followed by a deferred
exact-classification commit fence with no disable path, is defined by
[ADR 0052](0052-one-way-source-classification-writer-fence.md).

Default-disabled, tenant-approved aggregate support diagnostics are defined by
[ADR 0053](0053-tenant-approved-restricted-support-diagnostics.md). Their organization-blind support
console, in-memory request-code handling, and separate tenant-owner grant surface are defined by
[ADR 0054](0054-separated-browser-boundaries-for-restricted-support.md).

Bounded, synthetic, Git-visible verification evidence and the Git-ignore-clean source export
boundary are defined by [ADR 0055](0055-versioned-bounded-verification-evidence.md).

Original-proposer-only immutable replacement of a pending resolution proposal, with version-bound
approval history and exception-first concurrency serialization, is defined by
[ADR 0056](0056-immutable-resolution-proposal-revision.md).

Currency-bound integer amount ranges, deterministic evidence confidence, tenant-relative assignment,
exact bounded source resolution, and server-anchored UTC age traversal for the exception queue are
defined by [ADR 0057](0057-bounded-deterministic-exception-queue-filters.md).

Strict bounded deterministic investigation evidence, safe canonical projections, exact
tenant-resolved record references, and all-or-nothing lineage are defined by
[ADR 0058](0058-bounded-typed-investigation-evidence.md).

The exact, lockfile-bound `openid-client@5.7.1` WHATWG URL compatibility patch and its stable
upstream replacement criteria are defined by [ADR 0059](0059-pinned-oidc-url-parser-patch.md).

Query-free, fixed-field structured Nginx access logs that omit callback and provider query
credentials are defined by [ADR 0060](0060-query-free-structured-edge-access-logs.md).

Tenant-authorized, optimistic organization-name changes with same-transaction version-2 audit
evidence and read-only business time zone are defined by
[ADR 0061](0061-versioned-audited-organization-profile-mutation.md).

Fixed Docker-or-Podman Compose selection and bounded explicit Podman service readiness are defined
by [ADR 0062](0062-portable-bounded-local-compose-launcher.md).

Exact command-scoped repository-hook bypasses for Git-free application image installation and
production deployment are defined by [ADR 0063](0063-git-free-release-image-build-boundary.md).

Service-specific API/worker configuration parsing and explicit runtime credential projections are
defined by [ADR 0064](0064-service-specific-runtime-configuration-boundaries.md).

Isolated TLS verification of production web-image OIDC, Secure cookies, explicit tenant selection,
and authenticated BFF reconciliation is defined by
[ADR 0065](0065-isolated-tls-container-authentication-verification.md).

Incident-aware Trivy pins, extracted OCI-layout scanning, the reviewed Node runtime baseline,
runtime package-manager removal, and bounded local candidate verification are defined by
[ADR 0066](0066-incident-aware-local-oci-candidate-verification.md).

Exact mixed 100,000-record deterministic load construction, isolated permutation/repeat sampling,
and the strict separation between local pure-engine measurements and an end-to-end service objective
are defined by [ADR 0067](0067-bounded-representative-reconciliation-load-evidence.md).

Exact cross-layer discovery and fail-closed classification of tenant tables, routes, jobs, object
operations, state stores, exports, telemetry, and restricted support are defined by
[ADR 0068](0068-fail-closed-cross-layer-tenant-surface-inventory.md).
