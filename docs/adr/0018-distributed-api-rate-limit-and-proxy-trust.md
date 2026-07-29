# ADR 0018: Distributed API rate limit and explicit proxy trust

Status: accepted  
Date: 2026-07-28

## Context

The API previously used an in-process IP budget. Each replica therefore granted an independent
budget, so horizontal scaling multiplied the permitted request rate. Enabling generic proxy trust
would make a client-supplied forwarding header a limiter-bypass primitive, while storing raw client
addresses in Redis would create unnecessary network-identity data.

The rate limiter is an availability control, not authorization or tenant evidence. Organization IDs
are client-selected resource identifiers until membership is verified and must never form this
pre-authentication key. Redis failure must not silently remove abuse protection, and the process
liveness endpoint must remain independent so an orchestrator does not restart healthy processes
during a shared-store incident.

## Decision

- Production configuration requires a Redis-backed API limiter, a stable environment-specific HMAC
  key, and one or more explicit trusted reverse-proxy IP/CIDR entries. Local process memory remains
  a non-production default only.
- Fastify derives the client address by walking the forwarding chain only through configured trusted
  peers. Empty trust is safe outside production; global `/0`, malformed, duplicate, whitespace-
  ambiguous, and oversized allowlists are rejected.
- All API replicas share a fixed 120-request/60-second network budget. Existing tighter route
  budgets remain in force for sensitive mutations.
- Redis keys contain a bounded environment namespace and HMAC-SHA-256 of the Fastify-verified client
  address. They contain no raw address, authorization value, organization ID, tenant data, or
  financial data.
- The API uses a dedicated Redis connection with bounded connect/command timeouts, no offline queue,
  and no fail-open behavior. Production startup fails if that dependency is unavailable; a later
  limiter-store error prevents the route handler from running.
- Exceeded requests return an application-owned `429 RATE_LIMITED` response with a generated
  correlation ID. `/health/live` does not consume or require the limiter; readiness and normal API
  traffic remain dependency-sensitive.
- The reference Nginx policy applies a second connected-peer budget to browser `/api/*` and direct
  `/v1/*` traffic. Browser API/auth routes remain on the Next.js BFF; versioned API/provider routes
  preserve their path to Fastify. As the public trust boundary, Nginx derives address, host, and
  protocol forwarding metadata itself: it overwrites `X-Forwarded-For` and `X-Real-IP` with the
  observed peer, `X-Forwarded-Host` with `$host`, and `X-Forwarded-Proto` with `$scheme`; it removes
  the standardized `Forwarded` header. A deployment with another approved proxy in front must first
  derive `$remote_addr` through an explicit `set_real_ip_from` allowlist.

## Consequences

Replica count no longer multiplies the application budget when every instance uses the same Redis
authority and HMAC key. Network identifiers in Redis are pseudonymous, although the HMAC key and
short-lived counters remain sensitive operational data.

Redis availability now affects request admission by design. Liveness stays available to avoid a
restart storm, while ordinary/readiness traffic fails closed. The edge limiter reduces amplification
during that incident but is not a substitute for restoring Redis.

All replicas must receive the same key and proxy allowlist. HMAC-key rotation resets counters; a
rolling mixed-key deployment temporarily creates separate budgets, so rotation requires an
edge-protected coordinated restart or drain. Changes to proxy topology require a reviewed allowlist
update before traffic moves.

## Alternatives

Edge-only limiting was rejected because the application would depend on undocumented hosting
behavior and would not share a verifiable budget in self-hosted multi-replica deployments.
Process-local limiting was rejected because its effective rate scales with replica count. Trusting
all forwarding headers was rejected because clients could select their limiter identity. Raw-IP
Redis keys were rejected as unnecessary personal/network data. Fail-open Redis behavior was rejected
because an attacker or outage could silently disable the control.

## Rollback and verification

No database or financial-rule migration is introduced. A code rollback must keep the reviewed edge
policy and either retain equivalent distributed enforcement or temporarily constrain the API to one
replica; reverting production to an unverified process-local multi-replica budget is not an
acceptable steady state.

Synthetic tests exercise one shared budget across two independent Fastify instances, exact 120/121
behavior, safe 429 responses, route non-execution on Redis errors, pseudonymous key shape,
trusted/untrusted forwarding chains, liveness independence, and production configuration rejection.
Static validation binds the reference proxy to the rate zones, client-chain overwrite, payload
limits, explicit upstreams, and the BFF/API routing split. The two-client integration passed against
authenticated loopback Redis 8.2.8 with an exact shared 120/121 boundary, one pseudonymous HMAC key,
a positive TTL, and clean teardown. A local Nginx 1.30.4 exercise parsed the canonical policy, sent
traffic across two Fastify upstreams, proved that forged forwarding prefixes were discarded, routed
browser `/api/*` only to the web boundary, rejected a 12 MiB plus one-byte body before upstream, and
admitted 41 of 100 concurrent requests while returning 59 edge-generated 429 responses. The live
exercise was added after review found that the original `$proxy_add_x_forwarded_for` policy and
validator preserved attacker-selected prefixes; both now require `$remote_addr` overwrite. See
`artifacts/live-edge-verification-2026-07-29.json`. Multi-host/staging load, the deployed TLS and
load-balancer chain, Redis failure/recovery, key rotation, failure alerting, and scheduler behavior
remain required evidence.
