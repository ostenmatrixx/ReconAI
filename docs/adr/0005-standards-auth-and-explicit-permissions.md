# ADR 0005: Standards-based auth boundary and explicit permissions

Status: Accepted — 2026-07-27

## Context

Managed and self-hosted deployments need secure identity without a custom cryptographic protocol,
while organization membership and financial permissions remain application concerns.

## Decision

Use a standards-based OIDC-compatible authentication boundary with secure server-managed, revocable,
bounded sessions. A replaceable adapter supports hosted/self-hosted OIDC and local development
provider. ReconAI maps verified subjects to users/memberships and checks explicit permissions
server-side for each action. Privileged MFA capability and session rotation/revocation are required.

Organization onboarding uses email-bound, single-use application invitations rather than trusting an
identity-provider group or client-supplied tenant claim. A 256-bit token is delivered in a URL
fragment, only its SHA-256 digest is stored, expiry is fixed at 72 hours, and acceptance requires an
authenticated OIDC identity with a matching `email_verified=true` claim. Fixed database functions
make creation, revocation, expiry, acceptance, and membership creation atomic and replay-safe.

## Consequences

OIDC provider configuration and account recovery vary by deployment. The application never trusts a
client tenant/role claim without current membership. Deployments must configure their OIDC provider
to issue verified email claims and choose an approved invitation-delivery channel; automated email
delivery remains replaceable rather than embedded in identity logic. Alternatives: custom
password/crypto protocol (rejected), browser-stored session bearer tokens (rejected for exposure),
identity-provider groups as tenant authority (rejected for stale/cross-provider semantics), and
hosted-only identity (rejected for self-hosting).
