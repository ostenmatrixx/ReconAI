# ADR 0004: Immutable events, transactional outbox, at-least-once jobs

Status: Accepted — 2026-07-27

## Context

Provider events duplicate, reorder, delay, and fail between database and queue writes. Webhooks are
not complete histories.

## Decision

Authenticate and store immutable provider receipts with unique identities, write a transactional
outbox record atomically, publish to Redis-backed BullMQ, and process at least once with idempotent
handlers. Scheduled cursor sync and gap repair supplement webhooks. Raw events remain separate from
versioned normalized records.

Reconciliation requests use the same durable authority pattern: the API atomically stores the queued
run, complete evaluated policy, exact canonical record versions/content hashes, and outbox envelope.
The worker verifies that authority and recomputes the full identity before it writes artifacts.
Recovery replay increments a bounded dispatch counter but reuses the same immutable snapshot.
Retries are bounded/jittered with DLQ and audited replay.

## Consequences

Additional tables/worker states reduce dual-write loss and make recovery/replay explicit. Redis is
not financial authority; outbox/job records support reconstruction. Alternatives: synchronous
processing (latency/reliability risk), exactly-once claims (not realistic across boundaries), and
webhooks-only correctness (rejected).
