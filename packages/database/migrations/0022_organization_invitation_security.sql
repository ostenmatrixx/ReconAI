-- Tenant-scoped, single-use organization invitations with fixed database authority.

ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invitations FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_invitations_tenant_policy ON organization_invitations
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

-- SECURITY DEFINER invitation functions are owned by the migration role. Explicit owner policies
-- let those narrowly exposed functions cross the onboarding boundary while FORCE RLS remains on.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_migrator') THEN
    CREATE POLICY organization_invitations_migrator_policy ON organization_invitations
      FOR ALL
      TO reconai_migrator
      USING (current_user = 'reconai_migrator')
      WITH CHECK (current_user = 'reconai_migrator');

    CREATE POLICY users_invitation_migrator_policy ON users
      FOR ALL
      TO reconai_migrator
      USING (current_user = 'reconai_migrator')
      WITH CHECK (current_user = 'reconai_migrator');
  END IF;
END
$$;

ALTER TABLE organization_invitations
  ADD CONSTRAINT organization_invitations_email_check
    CHECK (
      email = lower(btrim(email))
      AND length(email) BETWEEN 3 AND 320
      AND position('@' IN email) > 1
    ),
  ADD CONSTRAINT organization_invitations_role_check
    CHECK (role IN ('owner', 'administrator', 'analyst', 'reviewer', 'auditor')),
  ADD CONSTRAINT organization_invitations_token_hash_check
    CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT organization_invitations_expiry_check
    CHECK (expires_at > created_at),
  ADD CONSTRAINT organization_invitations_state_check
    CHECK (
      (
        status IN ('pending', 'expired')
        AND accepted_by_user_id IS NULL
        AND accepted_membership_id IS NULL
        AND accepted_at IS NULL
        AND revoked_at IS NULL
      )
      OR
      (
        status = 'accepted'
        AND accepted_by_user_id IS NOT NULL
        AND accepted_membership_id IS NOT NULL
        AND accepted_at IS NOT NULL
        AND revoked_at IS NULL
      )
      OR
      (
        status = 'revoked'
        AND accepted_by_user_id IS NULL
        AND accepted_membership_id IS NULL
        AND accepted_at IS NULL
        AND revoked_at IS NOT NULL
      )
    );

CREATE UNIQUE INDEX organization_invitations_pending_email_uidx
  ON organization_invitations (organization_id, lower(email))
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION enforce_organization_invitation_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.email <> OLD.email
    OR NEW.role <> OLD.role
    OR NEW.token_sha256 <> OLD.token_sha256
    OR NEW.invited_by_membership_id <> OLD.invited_by_membership_id
    OR NEW.expires_at <> OLD.expires_at
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'organization invitation authority is immutable';
  END IF;

  IF OLD.status <> 'pending' OR NEW.status NOT IN ('accepted', 'revoked', 'expired') THEN
    RAISE EXCEPTION 'invalid organization invitation transition';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER organization_invitations_enforce_transition
BEFORE UPDATE ON organization_invitations
FOR EACH ROW EXECUTE FUNCTION enforce_organization_invitation_transition();

CREATE OR REPLACE FUNCTION reject_organization_invitation_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'organization invitations are retained as audit evidence';
END;
$$;

CREATE TRIGGER organization_invitations_reject_delete
BEFORE DELETE ON organization_invitations
FOR EACH ROW EXECUTE FUNCTION reject_organization_invitation_delete();

CREATE OR REPLACE FUNCTION reconai_create_organization_invitation(
  p_organization_id uuid,
  p_invitation_id uuid,
  p_email text,
  p_role text,
  p_token_sha256 text,
  p_invited_by_membership_id uuid,
  p_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_role text;
  v_now timestamptz := statement_timestamp();
BEGIN
  IF
    p_organization_id IS NULL
    OR p_invitation_id IS NULL
    OR p_email IS NULL
    OR p_role IS NULL
    OR p_token_sha256 IS NULL
    OR p_invited_by_membership_id IS NULL
    OR p_expires_at IS NULL
    OR nullif(current_setting('app.organization_id', true), '')::uuid IS DISTINCT FROM p_organization_id
    OR p_email IS DISTINCT FROM lower(btrim(p_email))
    OR length(p_email) NOT BETWEEN 3 AND 320
    OR position('@' IN p_email) <= 1
    OR p_role NOT IN ('owner', 'administrator', 'analyst', 'reviewer', 'auditor')
    OR p_token_sha256 !~ '^[0-9a-f]{64}$'
    OR p_expires_at < v_now + interval '5 minutes'
    OR p_expires_at > v_now + interval '7 days'
  THEN
    RETURN false;
  END IF;

  SELECT role
  INTO v_actor_role
  FROM public.memberships
  WHERE organization_id = p_organization_id
    AND id = p_invited_by_membership_id
    AND status = 'active'
  FOR SHARE;

  IF
    v_actor_role IS NULL
    OR v_actor_role NOT IN ('owner', 'administrator')
    OR (p_role = 'owner' AND v_actor_role <> 'owner')
  THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.memberships
    INNER JOIN public.users ON users.id = memberships.user_id
    WHERE memberships.organization_id = p_organization_id
      AND lower(users.email) = p_email
  ) THEN
    RETURN false;
  END IF;

  UPDATE public.organization_invitations
  SET status = 'expired', updated_at = v_now
  WHERE organization_id = p_organization_id
    AND lower(email) = p_email
    AND status = 'pending'
    AND expires_at <= v_now;

  IF EXISTS (
    SELECT 1
    FROM public.organization_invitations
    WHERE organization_id = p_organization_id
      AND lower(email) = p_email
      AND status = 'pending'
      AND expires_at > v_now
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO public.organization_invitations (
    id,
    organization_id,
    email,
    role,
    status,
    token_sha256,
    invited_by_membership_id,
    expires_at,
    created_at,
    updated_at
  ) VALUES (
    p_invitation_id,
    p_organization_id,
    p_email,
    p_role,
    'pending',
    p_token_sha256,
    p_invited_by_membership_id,
    p_expires_at,
    v_now,
    v_now
  );

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION reconai_revoke_organization_invitation(
  p_organization_id uuid,
  p_invitation_id uuid,
  p_actor_membership_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_role text;
  v_invitation_role text;
  v_expires_at timestamptz;
  v_now timestamptz := statement_timestamp();
BEGIN
  IF
    p_organization_id IS NULL
    OR p_invitation_id IS NULL
    OR p_actor_membership_id IS NULL
    OR nullif(current_setting('app.organization_id', true), '')::uuid IS DISTINCT FROM p_organization_id
  THEN
    RETURN NULL;
  END IF;

  SELECT role
  INTO v_actor_role
  FROM public.memberships
  WHERE organization_id = p_organization_id
    AND id = p_actor_membership_id
    AND status = 'active'
  FOR SHARE;

  SELECT role, expires_at
  INTO v_invitation_role, v_expires_at
  FROM public.organization_invitations
  WHERE organization_id = p_organization_id
    AND id = p_invitation_id
    AND status = 'pending'
  FOR UPDATE;

  IF
    v_actor_role IS NULL
    OR v_actor_role NOT IN ('owner', 'administrator')
    OR v_invitation_role IS NULL
    OR (v_invitation_role = 'owner' AND v_actor_role <> 'owner')
  THEN
    RETURN NULL;
  END IF;

  IF v_expires_at <= v_now THEN
    UPDATE public.organization_invitations
    SET status = 'expired', updated_at = v_now
    WHERE organization_id = p_organization_id
      AND id = p_invitation_id;
    RETURN 'expired';
  END IF;

  UPDATE public.organization_invitations
  SET status = 'revoked', revoked_at = v_now, updated_at = v_now
  WHERE organization_id = p_organization_id
    AND id = p_invitation_id;
  RETURN 'revoked';
END;
$$;

CREATE OR REPLACE FUNCTION reconai_accept_organization_invitation(
  p_token_sha256 text,
  p_issuer text,
  p_subject text,
  p_email text,
  p_new_user_id uuid,
  p_new_membership_id uuid
)
RETURNS TABLE (
  organization_id uuid,
  invitation_id uuid,
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
  v_invitation record;
  v_user record;
  v_now timestamptz := statement_timestamp();
BEGIN
  IF
    p_token_sha256 IS NULL
    OR p_issuer IS NULL
    OR p_subject IS NULL
    OR p_email IS NULL
    OR p_new_user_id IS NULL
    OR p_new_membership_id IS NULL
    OR p_token_sha256 !~ '^[0-9a-f]{64}$'
    OR length(p_issuer) NOT BETWEEN 1 AND 2048
    OR length(p_subject) NOT BETWEEN 1 AND 512
    OR p_email IS DISTINCT FROM lower(btrim(p_email))
    OR length(p_email) NOT BETWEEN 3 AND 320
    OR position('@' IN p_email) <= 1
  THEN
    RETURN;
  END IF;

  SELECT
    invitations.id,
    invitations.organization_id,
    invitations.role
  INTO v_invitation
  FROM public.organization_invitations AS invitations
  WHERE invitations.token_sha256 = p_token_sha256
    AND invitations.email = p_email
    AND invitations.status = 'pending'
    AND invitations.expires_at > v_now
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM set_config('app.organization_id', v_invitation.organization_id::text, true);

  INSERT INTO public.users (id, issuer, subject, email, status, created_at)
  VALUES (p_new_user_id, p_issuer, p_subject, p_email, 'active', v_now)
  ON CONFLICT DO NOTHING;

  SELECT users.id, users.email, users.status
  INTO v_user
  FROM public.users
  WHERE users.issuer = p_issuer
    AND users.subject = p_subject
  FOR UPDATE;

  IF
    NOT FOUND
    OR v_user.status <> 'active'
    OR (v_user.email IS NOT NULL AND lower(v_user.email) <> p_email)
  THEN
    RETURN;
  END IF;

  IF v_user.email IS NULL THEN
    UPDATE public.users
    SET email = p_email
    WHERE id = v_user.id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.memberships
    WHERE organization_id = v_invitation.organization_id
      AND user_id = v_user.id
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.memberships (
    id,
    organization_id,
    user_id,
    role,
    status,
    created_at,
    updated_at
  ) VALUES (
    p_new_membership_id,
    v_invitation.organization_id,
    v_user.id,
    v_invitation.role,
    'active',
    v_now,
    v_now
  );

  UPDATE public.organization_invitations
  SET
    status = 'accepted',
    accepted_by_user_id = v_user.id,
    accepted_membership_id = p_new_membership_id,
    accepted_at = v_now,
    updated_at = v_now
  WHERE organization_invitations.organization_id = v_invitation.organization_id
    AND organization_invitations.id = v_invitation.id;

  RETURN QUERY
  SELECT
    v_invitation.organization_id,
    v_invitation.id,
    p_new_membership_id,
    v_user.id,
    v_invitation.role;
END;
$$;

DO $$
BEGIN
  REVOKE ALL ON organization_invitations FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    REVOKE ALL ON organization_invitations FROM reconai_app;
    GRANT SELECT (
      id,
      organization_id,
      email,
      role,
      status,
      invited_by_membership_id,
      accepted_by_user_id,
      accepted_membership_id,
      expires_at,
      accepted_at,
      revoked_at,
      created_at,
      updated_at
    ) ON organization_invitations TO reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    REVOKE ALL ON organization_invitations FROM reconai_worker;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION reconai_create_organization_invitation(
  uuid, uuid, text, text, text, uuid, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconai_revoke_organization_invitation(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconai_accept_organization_invitation(
  text, text, text, text, uuid, uuid
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT EXECUTE ON FUNCTION reconai_create_organization_invitation(
      uuid, uuid, text, text, text, uuid, timestamptz
    ) TO reconai_app;
    GRANT EXECUTE ON FUNCTION reconai_revoke_organization_invitation(
      uuid, uuid, uuid
    ) TO reconai_app;
    GRANT EXECUTE ON FUNCTION reconai_accept_organization_invitation(
      text, text, text, text, uuid, uuid
    ) TO reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    REVOKE ALL ON FUNCTION reconai_create_organization_invitation(
      uuid, uuid, text, text, text, uuid, timestamptz
    ) FROM reconai_worker;
    REVOKE ALL ON FUNCTION reconai_revoke_organization_invitation(
      uuid, uuid, uuid
    ) FROM reconai_worker;
    REVOKE ALL ON FUNCTION reconai_accept_organization_invitation(
      text, text, text, text, uuid, uuid
    ) FROM reconai_worker;
  END IF;
END
$$;
