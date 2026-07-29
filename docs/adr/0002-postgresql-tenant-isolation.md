# ADR 0002: Shared PostgreSQL with mandatory tenant scope and RLS

Status: Accepted — 2026-07-27

## Context

Every customer-owned row must be tenant-isolated. Application predicates alone are vulnerable to
omission; database-per-tenant is operationally heavy for the initial target.

## Decision

Use PostgreSQL with non-null `organization_id`, tenant-leading indexes/composite references,
repository predicates, and forced row-level security for the non-owner/non-BYPASSRLS application
role. Each authorized transaction sets local `app.organization_id`; job/storage/cache/export
contexts use the same server-issued tenant.

## Consequences

RLS adds defense in depth but requires live tests for pool context, roles, migrations, and query
plans. Migration/backup roles remain privileged and separately audited. Alternatives: schema or
database per tenant (stronger physical boundary, higher migration/connection complexity) and
application-only predicates (rejected as insufficient). A future high-isolation tier can implement
database-per-tenant behind repositories.
