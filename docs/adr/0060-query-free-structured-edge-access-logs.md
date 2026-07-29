# ADR 0060: Emit query-free structured edge access logs

- Status: Accepted
- Date: 2026-07-29

## Context

Nginx enables its default access log unless configured otherwise. The default `combined` format
includes `$request`, which contains the complete request target and query string. OIDC and provider
OAuth callbacks carry short-lived authorization codes and state values in that query string. A local
real OIDC exercise made this behavior visible in the Next.js development terminal; reviewing the
reference Nginx configuration then showed that a deployed default access log would have the same
credential-retention class.

No production or staging edge exists, so no production credential exposure is claimed. The source
configuration nevertheless violated ReconAI's rule that credentials and tokens must not enter logs.

## Decision

1. Define one `escape=json` Nginx access-log format and select it explicitly for the reference edge.
2. Record only a fixed operational field set: timestamp, edge-generated request ID, connected client
   address, method, normalized query-free `$uri` path, protocol, status, response bytes, and request
   duration.
3. Do not configure `$request`, `$request_uri`, `$args`, `$query_string`, referrer, cookie,
   authorization, or the default `combined` format in access logs.
4. Extend `pnpm edge:check` with fail-closed positive controls and negative self-tests for a
   query-bearing URI and an additional combined log.
5. Extend the real Nginx verifier to send a synthetic callback-shaped request containing `code` and
   `state`, parse every emitted log line as the exact bounded JSON contract, and prove that neither
   value nor any query delimiter enters the recorded path.

## Consequences

The reference edge retains the minimum request metadata needed for response-layer, correlation,
abuse, and latency investigation without retaining query credentials. Operators lose arbitrary
query-string and referrer reconstruction by design. Investigations must use redacted application
events, fixed route contracts, and correlation IDs rather than widening access logs.

`$uri` is normalized and excludes arguments, but paths may still contain resource identifiers.
Access control, retention, tenant-aware investigation, and deletion policy therefore remain
mandatory. This decision does not prove that an external load balancer, CDN, hosting platform, or
collector applies equivalent redaction.

## Alternatives considered

- Keep the default combined log because authorization codes are short-lived: rejected because short
  lifetime does not make a credential appropriate for durable logs.
- Redact only known `code` and `state` parameter names: rejected because current and future routes
  can carry other secrets, and an allowlisted query-free format is simpler and safer.
- Disable edge access logs entirely: rejected because bounded response-layer and abuse investigation
  still needs correlation, status, path, size, and duration evidence.
- Log referrer and user agent: rejected from the baseline because neither is required for the
  current operational contract and both add untrusted or identifying data.

## Security, tenant, financial, AI, and operational effects

The change removes query credentials and unbounded request/referrer strings from the deployable edge
log. It does not add authentication, authorization, tenant, database, connector, source-system,
financial, approval, or AI authority.

The remaining client address and resource path are operationally sensitive. Log access must remain
least-privileged, retention-bounded, and used only with a tenant-authorized or security-incident
context.

## Migration, rollback, and verification

There is no database or reconciliation-rule migration. The configuration is compatible with the
existing reference Nginx HTTP log module. Rollback to the default or query-bearing log format is a
security regression and is not an acceptable operational rollback.

Verification includes the negative static validator, an exact Nginx 1.30.4 configuration parse,
thirteen parsed access-log entries, synthetic callback query omission, existing forwarding-spoof
controls, two-upstream routing, request ceiling, response headers, version hiding, and bounded outer
rate behavior. Results are recorded in
`artifacts/edge-access-log-redaction-verification-2026-07-29.json`.
