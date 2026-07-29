# ADR 0024: Identity-derived organization directory pagination

Status: accepted  
Date: 2026-07-29

## Context

The organization selector originally returned at most 100 active memberships for the verified
external identity. It reported truncation, but an operator with more than 100 memberships could not
search or reach a membership outside that first deterministic page. Selection therefore had an
availability/correctness gap even though every downstream business request still re-resolved
membership.

Accepting an organization ID from the browser as authority would close the navigation gap by
weakening the tenant boundary. Offset pagination would also become unstable when organization names
or memberships changed between requests. Search must not turn SQL wildcard characters into an
unbounded pattern, and directory cursors must not become bearer authority.

## Decision

- The API lists at most 100 items per request, with a default of 50, through an
  identity-issuer/subject-derived `SECURITY DEFINER` function. It intersects active users,
  memberships, and organizations and runs with a fixed search path, row security enabled, revoked
  public execution, and a narrow application-role grant.
- Ordering is stable keyset order by `lower(organization.name) COLLATE "C"` and organization UUID.
  The API fetches one lookahead row and returns an opaque canonical base64url cursor only when
  another row exists.
- The cursor contains only version, normalized search, last sort name, and last organization UUID.
  It is schema/length/canonical-encoding validated and bound to the normalized search. It is not
  signed because it grants no access: every page is recomputed from the verified identity, and every
  business endpoint independently resolves current membership and permissions.
- Search is trimmed, control-character-free, and limited to 100 characters. PostgreSQL escapes
  backslash, percent, and underscore before using a literal case-insensitive contains match.
- Exact selection verification accepts an organization UUID only as a filter intersected with the
  verified identity directory. It cannot be combined with search or a cursor and returns the same
  empty result for a foreign or nonexistent organization.
- The web BFF forwards only bounded search/cursor inputs, strictly parses a response of at most 100
  organizations/64 KiB, and verifies a signed selected context with an exact identity-derived lookup
  when it is outside the current page. The client accumulates at most 500 unique options and then
  requires a narrower search.
- The existing two-argument directory function remains during a rolling-image compatibility window.
  Removing it requires a later contraction migration after prior API images are excluded.

## Consequences

Operators can navigate more than 100 memberships without treating a client-supplied tenant ID as
authority. Keyset pagination avoids offset drift and lookahead avoids an extra count query. A name
change between pages can move an item across the boundary, so a browsing session is not a snapshot;
exact selection remains correct because it rechecks current membership by UUID.

An unsigned cursor may be edited to change the starting position, but can reveal only another
identity-authorized page and cannot select or access an organization. Organization names are already
directory response data for that identity; cursors contain no membership ID, subject, email,
credential, or financial evidence.

## Alternatives

Increasing or removing the 100-row cap was rejected because it leaves response and UI work
unbounded. Browser-side filtering was rejected because it cannot discover omitted memberships.
Offset pagination was rejected because concurrent membership/name changes create skips and
duplicates. Treating the signed selection cookie or a submitted organization UUID as sufficient
membership authority was rejected because authorization must be current and server-derived. Signing
or server-storing every cursor was rejected because the cursor is navigation state, not an
authorization capability.

## Migration, rollback, and verification

Migration 0041 is an additive function/grant expansion with no table scan, row rewrite, financial
rule change, backfill, or customer-data mutation. Expected impact is a brief catalog lock for
function creation and grants. Apply it before the new API image. The prior API continues using the
retained two-argument function; the new API requires 0041.

Rollback the API/web images together and leave 0041 plus the compatibility function in place. Do not
revoke the old function during the compatibility window. A later forward migration may remove it
only after deployment inventory proves no prior image remains.

Static and synthetic tests cover fixed grants/search path/RLS, literal wildcard escaping, keyset
lookahead, filter-bound malformed cursors, page/search limits, exact identity intersection, BFF
query containment, selected membership beyond the first page, cross-site selection, and UI
boundaries. The 2026-07-30 local follow-up applies the migration on a fresh empty schema and closes
only the more-than-100 composition item: an isolated Keycloak/PostgreSQL/browser run traversed one
provider-authenticated reviewer's 101 active tenant-complete memberships in 50/50/1 pages, selected
the last tenant, denied a foreign identity both ways, and reflected deactivation/reactivation
immediately. A bounded 2026-07-30 follow-up then traversed 501 memberships in ten 50-item pages plus
one, stopped browser accumulation at 500, required refinement, selected membership 501 through exact
search, and repeated the denial/lifecycle assertions. A populated 0040-to-0041 upgrade,
substantially larger directories, sustained or multi-host product-API mutation, organization-name
mutation through a product route, representative timing, protected staging, and prior/new-image
rolling deployment remain required evidence. A fresh PostgreSQL follow-up makes the accepted
non-snapshot contract executable: a rename can move an unseen row behind the cursor, exact lookup
still returns current authority, deactivation excludes it immediately, and reactivation restores it.
Chromium also deduplicates and updates one organization ID repeated across mutable pages. A separate
fresh PostgreSQL/Fastify follow-up proves two administrators' simultaneous membership changes
serialize through the actual product route, preserve a linear v2 audit chain, immediately update
exact directory authority, and conceal a foreign administrator.
