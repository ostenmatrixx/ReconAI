## Outcome

Describe the user/operational outcome and link the issue/goal.

## Scope and boundaries

- [ ] No source-system financial write is introduced.
- [ ] Tenant context/permissions are enforced server-side and negative-tested.
- [ ] Money remains integer minor units with explicit currency.
- [ ] Rule behavior changes include a new rule version and tests.
- [ ] AI remains optional, non-authoritative, schema-bounded, and human-reviewed.

## Security and privacy

Threats/controls, secrets, auth/CSRF, input/output limits, connector scope, data minimization,
retention/export/deletion, telemetry redaction, and any threat-model update:

## Database, jobs, and operations

Migration/backfill/lock impact; RLS; idempotency; retry/DLQ; configuration; observability; partial
failure; deployment and rollback:

## Verification evidence

Commands/results, including relevant unit/integration/tenant/reconciliation/e2e/accessibility/load
checks. Attach evidence; do not report targets as results.

## Documentation and limitations

- [ ] Docs/changelog/ADR are current.
- [ ] Fixtures are synthetic and reviewed for secrets/customer data.
- [ ] Known limitations and follow-up risks are explicit.
