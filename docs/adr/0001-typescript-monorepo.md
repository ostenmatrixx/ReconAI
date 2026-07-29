# ADR 0001: TypeScript pnpm monorepo

Status: Accepted — 2026-07-27

## Context

The product needs web, API, worker, provider adapters, deterministic domain rules, shared schemas,
and an open-source contributor workflow. Consistent types help, but runtime validation remains
mandatory.

## Decision

Use a TypeScript strict-mode monorepo with pnpm workspaces and a pinned lockfile. Deployable apps
are Next.js web, Fastify API, and BullMQ worker. Dependency-light domain/reconciliation packages are
separated from framework/provider/database adapters.

## Consequences

One toolchain and shared contracts reduce drift and enable package tests. The repository is larger
and build boundaries must prevent server secrets in web client bundles. TypeScript types are not
security boundaries; external input uses runtime schemas.

Alternatives considered: separate repositories (coordination/version overhead), full-stack Next.js
only (weaker worker/API separation), and multiple languages (operational burden before evidence).
Rollback is possible by extracting packages/services behind existing contracts.
