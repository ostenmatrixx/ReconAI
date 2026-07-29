-- Add a first-organization bootstrap boundary without treating browser tenant input as authority.

CREATE TABLE public.organization_bootstrap_requests (
  id uuid NOT NULL,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  input_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_bootstrap_requests_organization_id_id_pk
    PRIMARY KEY (organization_id, id),
  CONSTRAINT organization_bootstrap_requests_organization_fk
    FOREIGN KEY (organization_id)
    REFERENCES public.organizations (id),
  CONSTRAINT organization_bootstrap_requests_user_fk
    FOREIGN KEY (user_id)
    REFERENCES public.users (id),
  CONSTRAINT organization_bootstrap_requests_membership_fk
    FOREIGN KEY (organization_id, membership_id)
    REFERENCES public.memberships (organization_id, id),
  CONSTRAINT organization_bootstrap_requests_input_hash_check
    CHECK (input_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX organization_bootstrap_requests_identity_idempotency_uidx
  ON public.organization_bootstrap_requests (user_id, idempotency_key);

CREATE INDEX organization_bootstrap_requests_org_created_idx
  ON public.organization_bootstrap_requests (organization_id, created_at, id);

ALTER TABLE public.organization_bootstrap_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_bootstrap_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_bootstrap_requests_tenant_policy
  ON public.organization_bootstrap_requests
  FOR SELECT
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

-- The migration-owned function needs narrow cross-tenant insert/select authority while every
-- application call remains constrained to its verified issuer/subject and first active membership.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_migrator') THEN
    CREATE POLICY organizations_bootstrap_migrator_insert_policy ON public.organizations
      FOR INSERT
      TO reconai_migrator
      WITH CHECK (current_user = 'reconai_migrator');

    CREATE POLICY memberships_bootstrap_migrator_insert_policy ON public.memberships
      FOR INSERT
      TO reconai_migrator
      WITH CHECK (current_user = 'reconai_migrator');

    CREATE POLICY organization_bootstrap_requests_migrator_policy
      ON public.organization_bootstrap_requests
      FOR ALL
      TO reconai_migrator
      USING (current_user = 'reconai_migrator')
      WITH CHECK (current_user = 'reconai_migrator');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.reject_organization_bootstrap_request_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'organization bootstrap requests are append-only';
END;
$$;

CREATE TRIGGER organization_bootstrap_requests_reject_update_delete
BEFORE UPDATE OR DELETE ON public.organization_bootstrap_requests
FOR EACH ROW EXECUTE FUNCTION public.reject_organization_bootstrap_request_mutation();

CREATE OR REPLACE FUNCTION public.reconai_bootstrap_first_organization(
  p_issuer text,
  p_subject text,
  p_email text,
  p_organization_id uuid,
  p_membership_id uuid,
  p_request_id uuid,
  p_idempotency_key uuid,
  p_input_sha256 text,
  p_organization_name text,
  p_business_time_zone text,
  p_new_user_id uuid
)
RETURNS TABLE (
  bootstrap_status text,
  organization_id uuid,
  organization_name text,
  business_time_zone text,
  membership_id uuid,
  user_id uuid,
  membership_role text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_existing record;
  v_user record;
  v_now timestamptz := statement_timestamp();
BEGIN
  IF
    p_issuer IS NULL
    OR p_subject IS NULL
    OR p_email IS NULL
    OR p_organization_id IS NULL
    OR p_membership_id IS NULL
    OR p_request_id IS NULL
    OR p_idempotency_key IS NULL
    OR p_input_sha256 IS NULL
    OR p_organization_name IS NULL
    OR p_business_time_zone IS NULL
    OR p_new_user_id IS NULL
    OR length(p_issuer) NOT BETWEEN 1 AND 2048
    OR length(p_subject) NOT BETWEEN 1 AND 512
    OR p_issuer ~ '[[:cntrl:]]'
    OR p_subject ~ '[[:cntrl:]]'
    OR p_email IS DISTINCT FROM lower(btrim(p_email))
    OR length(p_email) NOT BETWEEN 3 AND 320
    OR position('@' IN p_email) <= 1
    OR p_email ~ '[[:space:][:cntrl:]]'
    OR p_input_sha256 !~ '^[0-9a-f]{64}$'
    OR p_organization_name IS DISTINCT FROM btrim(p_organization_name)
    OR length(p_organization_name) NOT BETWEEN 1 AND 200
    OR p_organization_name ~ '[[:cntrl:]]'
    OR p_business_time_zone IS DISTINCT FROM btrim(p_business_time_zone)
    OR length(p_business_time_zone) NOT BETWEEN 1 AND 100
    OR p_business_time_zone ~ '[[:cntrl:]]'
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_timezone_names
      WHERE pg_timezone_names.name = p_business_time_zone
    )
  THEN
    RETURN QUERY SELECT
      'invalid'::text,
      NULL::uuid,
      NULL::text,
      NULL::text,
      NULL::uuid,
      NULL::uuid,
      NULL::text;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(length(p_issuer)::text || ':' || p_issuer || p_subject, 0)
  );

  INSERT INTO public.users (id, issuer, subject, email, status, created_at)
  VALUES (p_new_user_id, p_issuer, p_subject, p_email, 'active', v_now)
  ON CONFLICT (issuer, subject) DO NOTHING;

  SELECT users.id, users.email, users.status
  INTO v_user
  FROM public.users
  WHERE users.issuer = p_issuer
    AND users.subject = p_subject
  FOR UPDATE;

  IF
    NOT FOUND
    OR v_user.status <> 'active'
    OR v_user.email IS NULL
    OR lower(v_user.email) <> p_email
  THEN
    RETURN QUERY SELECT
      'identity_conflict'::text,
      NULL::uuid,
      NULL::text,
      NULL::text,
      NULL::uuid,
      NULL::uuid,
      NULL::text;
    RETURN;
  END IF;

  SELECT
    requests.input_sha256,
    organizations.id AS organization_id,
    organizations.name AS organization_name,
    organizations.business_time_zone,
    organizations.status AS organization_status,
    memberships.id AS membership_id,
    memberships.role AS membership_role,
    memberships.status AS membership_status
  INTO v_existing
  FROM public.organization_bootstrap_requests AS requests
  INNER JOIN public.organizations AS organizations
    ON organizations.id = requests.organization_id
  INNER JOIN public.memberships AS memberships
    ON memberships.organization_id = requests.organization_id
    AND memberships.id = requests.membership_id
  WHERE requests.user_id = v_user.id
    AND requests.idempotency_key = p_idempotency_key
  FOR UPDATE OF requests;

  IF FOUND THEN
    IF v_existing.input_sha256 <> p_input_sha256 THEN
      RETURN QUERY SELECT
        'idempotency_conflict'::text,
        NULL::uuid,
        NULL::text,
        NULL::text,
        NULL::uuid,
        NULL::uuid,
        NULL::text;
      RETURN;
    END IF;

    IF
      v_existing.organization_status <> 'active'
      OR v_existing.membership_status <> 'active'
      OR v_existing.membership_role <> 'owner'
    THEN
      RETURN QUERY SELECT
        'not_eligible'::text,
        NULL::uuid,
        NULL::text,
        NULL::text,
        NULL::uuid,
        NULL::uuid,
        NULL::text;
      RETURN;
    END IF;

    RETURN QUERY SELECT
      'replayed'::text,
      v_existing.organization_id::uuid,
      v_existing.organization_name::text,
      v_existing.business_time_zone::text,
      v_existing.membership_id::uuid,
      v_user.id::uuid,
      v_existing.membership_role::text;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.memberships
    WHERE memberships.user_id = v_user.id
      AND memberships.status = 'active'
  ) THEN
    RETURN QUERY SELECT
      'not_eligible'::text,
      NULL::uuid,
      NULL::text,
      NULL::text,
      NULL::uuid,
      NULL::uuid,
      NULL::text;
    RETURN;
  END IF;

  INSERT INTO public.organizations (
    id,
    name,
    business_time_zone,
    status,
    ai_enabled,
    created_at,
    updated_at
  ) VALUES (
    p_organization_id,
    p_organization_name,
    p_business_time_zone,
    'active',
    false,
    v_now,
    v_now
  );

  INSERT INTO public.memberships (
    id,
    organization_id,
    user_id,
    role,
    status,
    created_at,
    updated_at
  ) VALUES (
    p_membership_id,
    p_organization_id,
    v_user.id,
    'owner',
    'active',
    v_now,
    v_now
  );

  INSERT INTO public.organization_bootstrap_requests (
    id,
    organization_id,
    user_id,
    membership_id,
    idempotency_key,
    input_sha256,
    created_at
  ) VALUES (
    p_request_id,
    p_organization_id,
    v_user.id,
    p_membership_id,
    p_idempotency_key,
    p_input_sha256,
    v_now
  );

  RETURN QUERY SELECT
    'created'::text,
    p_organization_id,
    p_organization_name,
    p_business_time_zone,
    p_membership_id,
    v_user.id::uuid,
    'owner'::text;
END;
$$;

REVOKE ALL ON TABLE public.organization_bootstrap_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_organization_bootstrap_request_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconai_bootstrap_first_organization(
  text,
  text,
  text,
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  uuid
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    REVOKE ALL ON TABLE public.organization_bootstrap_requests FROM reconai_app;
    REVOKE ALL ON FUNCTION public.reject_organization_bootstrap_request_mutation()
      FROM reconai_app;
    GRANT EXECUTE ON FUNCTION public.reconai_bootstrap_first_organization(
      text,
      text,
      text,
      uuid,
      uuid,
      uuid,
      uuid,
      text,
      text,
      text,
      uuid
    ) TO reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    REVOKE ALL ON TABLE public.organization_bootstrap_requests FROM reconai_worker;
    REVOKE ALL ON FUNCTION public.reconai_bootstrap_first_organization(
      text,
      text,
      text,
      uuid,
      uuid,
      uuid,
      uuid,
      text,
      text,
      text,
      uuid
    ) FROM reconai_worker;
  END IF;
END
$$;

COMMENT ON TABLE public.organization_bootstrap_requests IS
  'Append-only tenant-scoped idempotency evidence for verified first-organization creation';

COMMENT ON FUNCTION public.reconai_bootstrap_first_organization(
  text,
  text,
  text,
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  uuid
) IS
  'Atomically creates or replays one verified identity first-organization owner membership';
