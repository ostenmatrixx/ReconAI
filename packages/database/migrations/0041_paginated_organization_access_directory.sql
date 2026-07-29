-- Add a keyset-paginated, searchable organization directory without removing the bounded
-- two-argument function used by the previous application image during the rollout window.

CREATE OR REPLACE FUNCTION public.reconai_list_active_organization_page(
  p_issuer text,
  p_subject text,
  p_search text,
  p_organization_id uuid,
  p_after_name text,
  p_after_id uuid,
  p_limit integer
)
RETURNS TABLE (
  organization_id uuid,
  organization_name text,
  organization_sort_name text,
  membership_id uuid,
  membership_role text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT
    organizations.id,
    organizations.name,
    lower(organizations.name),
    memberships.id,
    memberships.role
  FROM public.users AS users
  INNER JOIN public.memberships AS memberships
    ON memberships.user_id = users.id
  INNER JOIN public.organizations AS organizations
    ON organizations.id = memberships.organization_id
  WHERE p_issuer IS NOT NULL
    AND p_subject IS NOT NULL
    AND length(p_issuer) BETWEEN 1 AND 2048
    AND length(p_subject) BETWEEN 1 AND 512
    AND p_limit BETWEEN 1 AND 101
    AND (
      p_search IS NULL
      OR (
        length(p_search) BETWEEN 1 AND 100
        AND p_search !~ '[[:cntrl:]]'
      )
    )
    AND (
      (p_after_name IS NULL AND p_after_id IS NULL)
      OR (
        p_after_name IS NOT NULL
        AND p_after_id IS NOT NULL
        AND length(p_after_name) BETWEEN 1 AND 200
      )
    )
    AND users.issuer = p_issuer
    AND users.subject = p_subject
    AND users.status = 'active'
    AND memberships.status = 'active'
    AND organizations.status = 'active'
    AND (
      p_organization_id IS NULL
      OR organizations.id = p_organization_id
    )
    AND (
      p_search IS NULL
      OR organizations.name ILIKE (
        '%' ||
        replace(
          replace(
            replace(p_search, E'\\', E'\\\\'),
            '%',
            E'\\%'
          ),
          '_',
          E'\\_'
        ) ||
        '%'
      ) ESCAPE E'\\'
    )
    AND (
      p_after_name IS NULL
      OR lower(organizations.name) COLLATE "C" > p_after_name COLLATE "C"
      OR (
        lower(organizations.name) COLLATE "C" = p_after_name COLLATE "C"
        AND organizations.id > p_after_id
      )
    )
  ORDER BY lower(organizations.name) COLLATE "C", organizations.id
  LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION public.reconai_list_active_organization_page(
  text,
  text,
  text,
  uuid,
  text,
  uuid,
  integer
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT EXECUTE ON FUNCTION public.reconai_list_active_organization_page(
      text,
      text,
      text,
      uuid,
      text,
      uuid,
      integer
    ) TO reconai_app;
  END IF;
END
$$;

COMMENT ON FUNCTION public.reconai_list_active_organization_page(
  text,
  text,
  text,
  uuid,
  text,
  uuid,
  integer
) IS
  'Returns one bounded identity-derived active-organization page; exact IDs filter but never grant access';
