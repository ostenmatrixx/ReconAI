# OIDC session revocation

ReconAI implements OpenID Connect Back-Channel Logout 1.0 for its Keycloak-backed web session. The
public IdP callback is:

```text
https://<WEB_ORIGIN>/api/auth/backchannel-logout
```

This is a server-to-server endpoint. It does not accept browser session authority and does not use
ReconAI's browser CSRF token. Authenticity comes exclusively from the signed logout JWT after
issuer, audience, algorithm, key, age, event, and claim validation. Requests and responses are
uncacheable, and failures never echo a logout token, subject, or session ID.

## Keycloak client registration

On the confidential ReconAI OIDC client:

1. Set **Backchannel logout URL** to the exact HTTPS endpoint above.
2. Enable **Backchannel logout session required** so the `sid` in the Logout Token identifies the
   matching `sid` issued in the ID Token.
3. Keep the configured ID-token signing algorithm equal to `OIDC_ID_TOKEN_SIGNING_ALGORITHM`
   (`RS256` by default).
4. Do not negotiate encrypted ID/logout tokens; this implementation accepts signed compact JWTs, not
   JWE.
5. Confirm the provider and web hosts use synchronized clocks.

The checked-in local realm uses `http://host.docker.internal:3000/api/auth/backchannel-logout`
because Keycloak runs in Compose while the development web process runs on the host. Compose
supplies the host-gateway mapping. This loopback development exception is not a production URL;
production uses the exact externally routable HTTPS web origin.

Keycloak treats its front- and back-channel client settings as alternatives. Keep the back-channel
URL registered in the client mode used by the deployment. The existing RP-initiated browser logout
remains separate and still clears all local cookie chunks.

## Runtime configuration

Production requires:

```text
SESSION_REVOCATION_STORE=redis
SESSION_REVOCATION_REDIS_CONNECT_TIMEOUT_MS=1000
SESSION_REVOCATION_REDIS_COMMAND_TIMEOUT_MS=1000
```

`REDIS_URL`, `APP_ENV`, `SESSION_SECRET`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and
`OIDC_ID_TOKEN_SIGNING_ALGORITHM` must be identical across web replicas in one environment.
Development may use `SESSION_REVOCATION_STORE=local` only when a single process is sufficient.

The web process opens a dedicated bounded Redis connection. Redis keys contain the environment
namespace and an HMAC digest; they do not contain raw `sub`, `sid`, `jti`, organization, token, or
financial data. A session cutoff remains slightly longer than the eight-hour maximum local session,
and a replay marker remains longer than the accepted logout-token age/skew window. `sid` logout
revokes one provider session; `sub` is used only when the Logout Token has no `sid`.

Authenticated server pages, every BFF route, and NextAuth's browser-readable session endpoint check
the same index. Redis failure, missing session identity, or a matching cutoff fails closed as
unauthenticated. Liveness should stay independent so an orchestrator does not create a restart
storm.

The local runtime baseline in `artifacts/redis-security-runtime-verification-2026-07-28.json` passed
against authenticated loopback Redis 8.2.8 using two independent store clients. It proves
cross-client revocation, unaffected-session handling, idempotent replay, pseudonymous key shape,
positive TTLs, and clean teardown. It is not evidence of Keycloak delivery, actual web replicas,
ingress, Redis transport security, outage recovery, rotation, or alerting.

A later isolated run in
`artifacts/oidc-distributed-revocation-recovery-verification-2026-07-29.json` exercises two
production-built Next.js processes with the shared authenticated persistent Redis 8.2.8 authority.
It proves one signed Keycloak `sid` logout, targeted old-cookie denial and unaffected-session
admission through both replicas, idempotent cross-replica replay, authenticated fail-closed behavior
and independent anonymous liveness during a Redis `SIGKILL`, durable restart, preserved cutoff, and
later-login recovery. The run uses ephemeral loopback TLS and a memory-only loopback back-channel
relay; it is not protected-staging, multi-host, managed-Redis, external-ingress, clock/rotation, or
alert-delivery evidence.

## Local reproducibility

`pnpm verify:live-oidc-distributed` reruns the isolated topology only when the caller supplies
absolute paths to checksum-verified Keycloak, Java, and Redis runtimes through the documented
`OIDC_DISTRIBUTED_*` process environment. The verifier creates its own temporary realm, client
secret, synthetic password, TLS certificate, Redis credential, and application session secret. Use
only fresh local runtime directories and synthetic identities; never point this command at
production, protected staging, customer data, or a shared Redis authority. The verifier discards
child-process output and records only minimized assertions, but callers must still treat its
temporary directory as sensitive until cleanup completes.

## Staging exercise

Use only synthetic identities and do not capture cookies or logout JWTs in evidence.

1. Start two web replicas with the same Redis authority, environment, OIDC client, and session
   secret. Confirm production startup rejects `SESSION_REVOCATION_STORE=local`.
2. Sign in through Keycloak and prove the authenticated session works through each replica.
3. End that Keycloak session from the account console and from the administrator console. Confirm
   Keycloak delivers a successful back-channel request.
4. Replay the pre-logout browser cookie against both replicas. Each request must be rejected without
   reaching an authenticated BFF upstream.
5. Sign in again. The new session must work; a prior subject cutoff must not revoke a later login.
6. Exercise two sessions for one subject. A `sid` logout must revoke only the targeted session. A
   provider token without `sid` must revoke every earlier session for that subject.
7. Replay the same Logout Token. The endpoint must remain successful and create no divergent state.
8. Stop Redis. Authenticated requests must fail closed and a valid logout action must not report
   success. Restore Redis and verify recovery plus the configured alert.
9. Exercise accepted clock-skew boundaries and reject a token older than five minutes plus
   tolerance.
10. Perform a coordinated session-secret rotation after draining old replicas. Verify all old
    cookies are invalid and no mixed-secret replica remains.

Record only timestamps, instance counts, safe result classes, provider delivery IDs if non-secret,
and aggregate Redis key shape/TTL. Never record the logout JWT, cookie, `sid`, `sub`, Redis
credentials, or raw Redis keys.

## Rollback

Do not restore a provider-blind stateless session as a production recovery shortcut. Keep the edge
available, drain authenticated traffic if necessary, restore the shared Redis path, and verify
cross-replica invalidation before reopening. See ADR 0020 and the operations runbook.
