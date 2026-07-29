# ADR 0006: Open production code and replaceable infrastructure

Status: Accepted — 2026-07-27

## Context

The production application must be genuinely open source and self-hostable without maintainer-
private services.

## Decision

Keep web/API/workers, data model/migrations, reconciliation/rules, connector interfaces/official
connectors, audit, evaluation, and self-host config in this repository under the owner-confirmed OSI
license. Authentication, model, object storage, queue, email, telemetry, and deployment use
documented interfaces. Reference local infrastructure uses open components.

## Consequences

Provider-specific managed optimizations cannot become undocumented requirements. Conformance and
compatibility tests are required. Alternatives: reduced community edition/open-core core workflow
(rejected by product commitment) and one proprietary deployment platform (rejected).
