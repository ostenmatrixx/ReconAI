# Connector development guide

1. Start from `packages/connectors` contracts and the synthetic reference connector.
2. Document provider objects, read scopes, authentication, API/webhook versions, pagination,
   ordering/update semantics, limits, privacy/deletion, disconnect, and data minimization.
3. Add a provider package only; do not put provider logic in apps or the reconciliation engine.
4. Implement authorization/disconnect, bounded backfill/cursor repair, authentication/signature
   verification before parse, immutable receipt, pure versioned normalization, and health.
5. Expose no V1 mutation capability. Fixed provider base URLs and outbound allowlists prevent SSRF.
6. Record only required fields; credentials use the encrypted token store; all telemetry is
   redacted.
7. Use synthetic or provider-sandbox fixtures reviewed for secrets and personal/financial data.

The conformance suite must cover auth/scope, raw signature, tamper/stale, duplicate/concurrent,
out-of-order/update, pagination, backoff/rate/timeout, malformed/oversized, provenance/version,
repair, disconnect/deletion, telemetry redaction, tenant tamper, and stable replay. Add an ADR for a
new provider or a shared-contract exception.

Connector versions describe provider-facing behavior. Normalizer versions describe canonical
interpretation. Change either when replay output or supported payload changes; never silently
reinterpret old records.
