# Incident response

## Principles

Protect people and tenant data, stop ongoing harm, preserve evidence, communicate verified facts,
and restore safely. Do not destroy logs or rewrite audit history. Do not expose customer/security
details in public channels. A target metric is not an achieved response time.

## Lifecycle

1. **Report and classify:** record time, reporter, affected service/tenant/data/rule, correlation,
   suspected severity, and a redacted symptom. Open a private incident channel and assign commander,
   operations, security/privacy, communications, and scribe roles as scale requires.
2. **Contain:** revoke sessions/tokens, disable a connector/rule/AI flag, pause scoped queues,
   isolate an instance, block egress/ingress, or freeze deployment. Prefer tenant/component scope,
   but prioritize containment for cross-tenant or credential risk.
3. **Preserve:** snapshot relevant immutable logs/audit/config/deploy/artifact hashes and volatile
   state with access controls and chain of custody. Never copy raw production data unnecessarily.
4. **Investigate:** build a verified timeline; identify initial access, blast radius, exposed or
   corrupted assets, persistence, tenant/rule/version scope, and whether source systems changed.
5. **Eradicate and recover:** remove cause, rotate affected secrets, patch with tests, restore from
   verified data if required, replay idempotently, validate tenant/integrity, exercise alerts, and
   monitor before closure.
6. **Notify:** owner/legal/privacy decide regulatory/customer/provider/law-enforcement duties and
   timing. Communications separate confirmed fact, scope, action, risk, and next update.
7. **Learn:** blameless review, root and contributing causes, detection gaps, action owners/dates,
   threat-model/test/runbook updates, and follow-up verification.

## Special cases

- Cross-tenant: treat as SEV-1; disable affected surface, preserve database/audit/access evidence,
  identify every query/export/cache/object/log path, and do not rely only on application logs.
- Connector credential: revoke at provider, block egress/connection, rotate encryption material if
  implicated, audit provider activity, gap-repair after controlled reauthorization.
- Financial integrity/rule: pause exact version, retain artifacts, identify all runs/snapshots,
  reproduce, version the fix, supersede visibly, and never silently edit history.
- AI leakage/injection: tenant/global disable, stop provider calls, preserve minimized request
  metadata, review provider retention/training configuration, rotate any exposed secret,
  re-evaluate.
- Supply chain: freeze releases, revoke CI/package credentials, validate source/build provenance,
  identify affected versions, rebuild cleanly, coordinate an advisory.

## Evidence and closure

Closure requires containment verified, scope documented, credentials rotated where needed, restored
state and replay checked, monitoring stable, customer/legal decisions recorded, critical actions
completed or explicitly owned, and incident artifacts stored privately under retention policy.
