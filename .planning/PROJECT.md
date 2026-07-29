# Project context

ReconAI is a production-oriented, open-source, multi-tenant e-commerce reconciliation system with
read-only providers, deterministic financial rules, human approval, immutable audit, and optional
non-authoritative AI. The owner-supplied specification is maintained in `PRD.md`; repository rules
are `AGENTS.md`; execution and evidence are `GOALS.md`.

The exact working name has material collision risk and cannot be published. The initial architecture
is a TypeScript pnpm monorepo with Next.js, Fastify, BullMQ, PostgreSQL/RLS, Redis, S3-compatible
storage, standards-based OIDC, and OpenTelemetry.
