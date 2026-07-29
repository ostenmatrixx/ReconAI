-- Qualify invitation-acceptance membership lookups so PL/pgSQL output parameters cannot shadow
-- tenant-owned column names.

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
    WHERE users.id = v_user.id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.memberships AS memberships
    WHERE memberships.organization_id = v_invitation.organization_id
      AND memberships.user_id = v_user.id
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

