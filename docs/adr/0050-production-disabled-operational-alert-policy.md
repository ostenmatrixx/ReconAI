# ADR 0050: Production-disabled operational alert policy

- Status: Accepted
- Date: 2026-07-29
- Extends: ADRs 0037, 0043, and 0044

## Context

ReconAI emits bounded operational metrics for durable queue state, the oldest unresolved exception,
and the oldest active Shopify/Stripe sync. The source and local OTLP contract are tested, but the
repository previously contained only a narrative list of possible alerts. It did not select
thresholds, define silence/error behavior, bind rules to instrument and attribute contracts, or
prevent a future backend rule from adding tenant/customer dimensions.

Checking in a backend-specific rule before selecting and exercising the protected collector,
backend, notification path, and on-call ownership would create false confidence. OpenTelemetry
backends may translate names, units, temporality, and no-data semantics differently. Conversely,
leaving no machine-readable policy makes drift and unsafe label additions easy.

## Decision

1. Define a backend-neutral V1 policy for the lease-owned operational monitors. It covers 13 queue,
   unresolved-exception, and active-provider-sync failure, silence, presence/age, warning, and
   critical rules.
2. Keep the policy `proposed` and `productionEnabled: false`. Record all backend translation,
   delivery-path, protected-environment exercise, and owner-approval fields as incomplete. The
   policy is not deployed alert evidence.
3. Bind instrument creation and policy validation to one TypeScript metric contract containing the
   exact OpenTelemetry names, instrument kinds, attribute names, and complete fixed values.
4. Permit only counter rates and observable-gauge last/max reductions. Permit only `greater_than`
   thresholds or metric absence. Reject unknown fields, metrics, dimensions, values, reducers,
   duplicate IDs, dynamic/high-cardinality dimensions, and unbounded rule collections.
5. Treat threshold no-data as normal because the active-sync age gauge is intentionally absent when
   no sync is active; absence never means a healthy zero. Alert on evaluation errors and use an
   explicit 20-minute absence rule for each always-emitted monitor counter, covering two complete
   cycles at the maximum configured five-minute monitor interval plus maximum five-minute export
   interval.
6. Propose five-/15-minute queue-frontier warning/critical thresholds, one-/three-day
   oldest-unresolved thresholds, and 30-minute/two-hour oldest-active-sync thresholds. These are
   operating defaults for protected validation, not SLOs, reliability claims, or customer
   commitments.
7. Group active-sync age only by the fixed provider and queued/running status. All other V1 rules
   are environment-wide. Do not add organization, user, membership, connection, record, event,
   payment, job/request ID, token, credential, email, raw URL, or provider error text.
8. Require every rule to reference a checked-in runbook anchor. Alerts convey evidence and urgency
   only; they never authorize financial approval, deterministic-rule override, source-system write,
   direct database/queue mutation, retention deletion, permission change, or AI action.
9. Require a separate owner-approved backend decision before enablement. It must evidence exact
   translation, warning/critical/failure/silence injection, collector and worker outage, routing,
   receipt/acknowledgement/escalation/recovery, cardinality/load, maintenance silences, threshold
   suitability, and rollback. Record exact policy and translation digests.

## Consequences

Metric and label drift now fails the repository gate, and the initial operational thresholds,
silence semantics, response boundaries, and promotion checklist are reviewable in source. The policy
remains portable across monitoring backends and cannot silently acquire tenant/customer dimensions.

There is still no production alert. The policy does not configure a collector, backend, dashboard,
notification integration, on-call roster, or maintenance-silence system. It covers only three
lease-owned monitor families; API, outbox, provider-ingestion, circuit, reconciliation, gap-repair,
review-decision, collector, and infrastructure alerts remain separate work. Proposed thresholds may
be unsuitable under representative load and must not be presented as SLOs.

## Alternatives considered

- Check in Prometheus/Grafana rules now: rejected because no protected backend or OpenTelemetry
  name, unit, temporality, routing, and no-data translation has been selected or exercised.
- Enable the proposed policy by default: rejected because an unexercised paging path is not a
  production control and may create both missed incidents and alert fatigue.
- Allow arbitrary backend expressions and labels: rejected because drift and high-cardinality or
  customer-identifying dimensions would escape source validation.
- Alert only on thresholds and ignore missing data: rejected because worker, collector, egress, or
  backend loss can make stale or absent telemetry appear healthy.
- Treat the thresholds as service objectives: rejected because no representative measurement or
  owner/customer commitment supports that claim.

## Security, tenant, financial, AI, and operational effects

The policy and its notifications must remain environment-wide or grouped only by fixed provider and
sync status. It contains no customer data, credentials, tokens, public identifiers, raw provider
errors, financial values, or tenant route keys. It introduces no database, cache, object, connector,
browser, API, permission, source-write, or AI authority.

Responders must locate affected work through existing tenant-authorized product and operational
surfaces. They must not infer tenant identity, exception count/severity, provider completeness, or
financial outcome from an aggregate alert. Maintenance silences require a reason, owner, bounded
expiry, exact rule IDs, narrow service/environment scope, and an independent alert-path health
check.

## Migration, rollout, rollback, and verification

There is no database migration or runtime configuration change. The source policy remains disabled.
A future backend adapter must preserve exact semantics and requires a new owner-approved decision;
promotion is not achieved by changing the boolean alone.

Rollback removes or disables only the backend translation after first proving the target and
retaining the policy/translation digests and incident evidence. Application telemetry and financial
work remain active. Do not weaken metric validation or delete evidence to quiet an alert.

Acceptance requires formatting, lint, strict typecheck, unit tests, production build, the
source-policy validator, secret scan, production dependency audit, and immutable evidence. Local
acceptance proves only schema, low-cardinality vocabulary, instrument binding, required rules,
silence floors, monotonic escalation, and runbook linkage; it does not prove a collector/backend,
alert delivery, protected thresholds, or responder behavior.
