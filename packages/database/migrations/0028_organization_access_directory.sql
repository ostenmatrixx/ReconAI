-- Let the authenticated API enumerate only the caller's active organization memberships without
-- granting the application role cross-tenant table access.

-- The function owner is the migration role. These owner-only SELECT policies let the narrowly
-- granted SECURITY DEFINER function cross FORCE RLS while reconai_app retains no direct unscoped
-- table access.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_migrator') THEN
    CREATE POLICY memberships_directory_migrator_policy ON memberships
      FOR SELECT
      TO reconai_migrator
      USING (current_user = 'reconai_migrator');

    CREATE POLICY organizations_directory_migrator_policy ON organizations
      FOR SELECT
      TO reconai_migrator
      USING (current_user = 'reconai_migrator');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.reconai_list_active_organizations(
  p_issuer text,
  p_subject text
)
RETURNS TABLE (
  organization_id uuid,
  organization_name text,
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
    AND users.issuer = p_issuer
    AND users.subject = p_subject
    AND users.status = 'active'
    AND memberships.status = 'active'
    AND organizations.status = 'active'
  ORDER BY lower(organizations.name) COLLATE "C", organizations.id
  LIMIT 101
$$;

REVOKE ALL ON FUNCTION public.reconai_list_active_organizations(text, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT EXECUTE ON FUNCTION public.reconai_list_active_organizations(text, text)
      TO reconai_app;
  END IF;
END
$$;
