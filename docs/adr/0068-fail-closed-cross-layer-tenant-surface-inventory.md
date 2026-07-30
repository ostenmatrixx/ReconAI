# ADR 0068: Fail closed on unclassified cross-layer tenant surfaces

- Status: Accepted
- Date: 2026-07-30

## Context

ReconAI already had strong tenant controls at individual boundaries: forced PostgreSQL RLS,
server-derived tenant contexts, an exact API route-security registry, tenant-bound durable job
envelopes, server-generated object keys, scoped Redis coordination, minimized exports, and
identifier-free operational telemetry. The evidence was distributed across schema, migrations, apps,
packages, tests, and prior audit documents.

That distribution created an omission risk. A new table, BFF route, job type, object-store call
site, cache/queue module, or export could be implemented without updating one consolidated review
surface. Counts written only in documentation would not fail CI when the source changed.

## Decision

1. Maintain `config/tenant-surface-manifest.json` as the versioned, reviewable classification of:
   - every application schema table and its tenant-scope model;
   - the API route-security registry and every Next.js API/BFF route;
   - every durable job discriminator and mandatory tenant field;
   - object-key purposes, key-builder call sites, and verified object operations;
   - Redis, BullMQ, and in-memory map source surfaces;
   - tenant financial/privacy exports;
   - the low-cardinality observability rule; and
   - default-disabled, tenant-approved restricted support.
2. Discover those surfaces independently from executable schema/contract exports and repository
   source. Compare exact sets, reject duplicates and stale entries, and require every referenced
   evidence file to exist.
3. Independently scan all numbered migrations and require every executable schema table to appear in
   both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` authority.
4. Run `pnpm tenant:check` in the ordinary `pnpm verify` path. A newly discovered surface fails
   until its scope and evidence are reviewed and added atomically.
5. Keep the live PostgreSQL integration assertion that queries the migrated catalog and requires all
   43 current application tables to have enabled and forced RLS plus at least one policy.
6. Validate tenant object-key segments at runtime. The organization identifier is a branded
   `OrganizationId`; environment, purpose, opaque identifier, and suffix use closed bounded schemas.
   Unsafe traversal-like or untyped values fail before key construction.
7. Prohibit tenant/customer identifiers and their pseudonyms as telemetry dimensions. Remove the
   unused tenant-pseudonym export and compare the manifest to the source-level forbidden-dimension
   vocabulary.

## Consequences

The current exact inventory contains 43 schema tables, 55 API routes, 13 BFF routes, four durable
job types, three object-key purposes and builders, nine verified object operations, 19 state-store
source surfaces, two export surfaces, and 39 evidence references. All 43 tables are independently
found in both enabled- and forced-RLS migration authority.

The state-store discovery intentionally errs toward review: it includes deterministic run-local,
browser-ephemeral, fixture, and fixed-registry maps as well as Redis/BullMQ state. Classification
does not itself prove semantic tenant isolation; the referenced negative tests, runtime schemas,
database policies, and integration tests remain authoritative.

The source scan is a bounded repository control, not a language-level information-flow proof. A new
storage library or dynamically constructed mechanism may require extending discovery. Protected
multi-host, timing-sensitive, cache-eviction, partition, and external security review remain Goal 2
work.

## Alternatives considered

- Keep a prose checklist only: rejected because it cannot fail on source drift.
- Duplicate all 55 API contracts in the cross-layer JSON: rejected because the existing
  `routeSecurityContracts` registry already fails closed at registration and is independently
  compared to Fastify handlers.
- Detect only Redis and database state: rejected because browser/BFF routes, queues, object keys,
  exports, and in-memory registries are also tenant-boundary review surfaces.
- Hash organization IDs into telemetry labels: rejected because a stable pseudonym remains
  high-cardinality and linkable; current operational metrics do not require tenant dimensions.

## Security, tenant, financial, and operational effects

This decision changes no reconciliation rule, money arithmetic, currency policy, source-system
permission, financial approval authority, or AI behavior. It adds a fail-closed review gate and
tightens server-generated object keys.

No migration or production configuration change is introduced. The live catalog assertion is
read-only. The CI correction in the same increment supplies only the already documented synthetic
maintenance-role URL to integration tests; applications still do not receive maintenance authority.

Evidence: `artifacts/cross-layer-tenant-surface-verification-2026-07-30.json`.

## Rollback

Reverting the manifest gate would remove a defense-in-depth omission detector and should require a
new security decision. A legitimate surface addition updates implementation, classification,
negative evidence, and the manifest in one reviewed change. If discovery produces a false positive,
classify the bounded source honestly or refine the detector with positive and negative tests; do not
silence an entry without documenting its state and tenant scope.
