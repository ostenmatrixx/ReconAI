# ADR 0003: Integer money and versioned deterministic authority

Status: Accepted — 2026-07-27

## Context

Financial matching must be reproducible, explainable, and safe across retries. Floating point and
unversioned fuzzy/AI decisions cannot satisfy that.

## Decision

Represent money as signed integer minor units plus ISO currency and explicit exponent/rounding
policy. V1 never converts currency. The matching engine is a pure versioned pipeline over immutable
canonical versions; deterministic evidence is authoritative. Ambiguous scoring/AI produces only
human-review proposals. Stable keys and database uniqueness make replay idempotent.

## Consequences

Provider decimal parsing and maximum ranges require explicit validation. Currency/exponent policy is
data, not locale inference. Every behavior change increments rule version and tests. Alternatives:
decimal library/storage (valid but integer minor units are simpler for supported currencies) and
AI-first matching (rejected for authority and reproducibility).
