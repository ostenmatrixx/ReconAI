ALTER TABLE "connector_credentials" ALTER COLUMN "created_by_membership_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD COLUMN "created_by_service" text;

ALTER TABLE connector_credentials
  ADD CONSTRAINT connector_credentials_creator_authority_check CHECK (
    (
      created_by_membership_id IS NOT NULL
      AND created_by_service IS NULL
    )
    OR
    (
      created_by_membership_id IS NULL
      AND created_by_service = 'provider-token-refresh-v1'
    )
  );

CREATE OR REPLACE FUNCTION validate_connector_credential_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM data_source_connections AS connections
    WHERE connections.organization_id = NEW.organization_id
      AND connections.id = NEW.connection_id
      AND connections.provider::text = (NEW.encrypted_envelope ->> 'provider')
  ) THEN
    RAISE EXCEPTION 'connector credential provider does not match its connection';
  END IF;

  IF NEW.created_by_membership_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM memberships
      WHERE memberships.organization_id = NEW.organization_id
        AND memberships.id = NEW.created_by_membership_id
        AND memberships.status = 'active'
    )
  THEN
    RAISE EXCEPTION 'connector credential creator is not an active membership';
  END IF;

  IF NEW.created_by_service IS NOT NULL
    AND (
      NEW.created_by_service <> 'provider-token-refresh-v1'
      OR NEW.purpose <> 'api_read'
      OR NEW.rotated_from_credential_id IS NULL
    )
  THEN
    RAISE EXCEPTION 'connector credential service authority is invalid';
  END IF;

  IF NEW.rotated_from_credential_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM connector_credentials AS previous
      WHERE previous.organization_id = NEW.organization_id
        AND previous.id = NEW.rotated_from_credential_id
        AND previous.connection_id = NEW.connection_id
        AND previous.purpose = NEW.purpose
        AND previous.status = 'superseded'
    )
  THEN
    RAISE EXCEPTION 'connector credential rotation predecessor is invalid';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_connector_credential()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    OLD.id,
    OLD.organization_id,
    OLD.connection_id,
    OLD.purpose,
    OLD.encrypted_envelope,
    OLD.key_version,
    OLD.envelope_sha256,
    OLD.created_by_membership_id,
    OLD.created_by_service,
    OLD.rotated_from_credential_id,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id,
    NEW.organization_id,
    NEW.connection_id,
    NEW.purpose,
    NEW.encrypted_envelope,
    NEW.key_version,
    NEW.envelope_sha256,
    NEW.created_by_membership_id,
    NEW.created_by_service,
    NEW.rotated_from_credential_id,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'connector credential authority and ciphertext are immutable';
  END IF;

  IF OLD.status <> 'active'
    OR NEW.status NOT IN ('superseded', 'revoked')
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'connector credential lifecycle transition is invalid';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION reconai_lock_oauth_credential(
  p_organization_id uuid,
  p_connection_id uuid,
  p_provider text,
  p_reference text
)
RETURNS TABLE (
  credential_id uuid,
  encrypted_envelope jsonb,
  key_version text,
  external_account_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_active_organization_id uuid;
BEGIN
  v_active_organization_id :=
    nullif(current_setting('app.organization_id', true), '')::uuid;
  IF v_active_organization_id IS NULL
    OR v_active_organization_id <> p_organization_id
    OR p_provider NOT IN ('shopify', 'stripe')
    OR p_reference !~
      '^sealed:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION 'OAuth credential lock authority is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    credentials.id,
    credentials.encrypted_envelope,
    credentials.key_version,
    connections.external_account_id
  INTO
    credential_id,
    encrypted_envelope,
    key_version,
    external_account_id
  FROM public.data_source_connections AS connections
  INNER JOIN public.connector_credentials AS credentials
    ON credentials.organization_id = connections.organization_id
   AND credentials.connection_id = connections.id
  WHERE connections.organization_id = p_organization_id
    AND connections.id = p_connection_id
    AND connections.provider::text = p_provider
    AND connections.api_credential_reference = 'sealed:' || credentials.id::text
    AND (
      credentials.id = substring(p_reference FROM 8)::uuid
      OR (
        credentials.created_by_service = 'provider-token-refresh-v1'
        AND credentials.rotated_from_credential_id = substring(p_reference FROM 8)::uuid
      )
    )
    AND credentials.purpose = 'api_read'
    AND credentials.status = 'active'
  LIMIT 1
  FOR UPDATE OF connections, credentials;

  IF credential_id IS NULL THEN
    RAISE EXCEPTION 'OAuth credential is unavailable'
      USING ERRCODE = 'P0002';
  END IF;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION reconai_rotate_oauth_credential(
  p_organization_id uuid,
  p_connection_id uuid,
  p_provider text,
  p_expected_credential_id uuid,
  p_new_credential_id uuid,
  p_encrypted_envelope jsonb,
  p_key_version text,
  p_envelope_sha256 text,
  p_rotated_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_active_organization_id uuid;
  v_current_reference text;
BEGIN
  v_active_organization_id :=
    nullif(current_setting('app.organization_id', true), '')::uuid;
  IF v_active_organization_id IS NULL
    OR v_active_organization_id <> p_organization_id
    OR p_provider NOT IN ('shopify', 'stripe')
    OR p_expected_credential_id IS NULL
    OR p_new_credential_id IS NULL
    OR p_expected_credential_id = p_new_credential_id
    OR p_encrypted_envelope IS NULL
    OR p_key_version !~ '^[a-z0-9][a-z0-9._-]{0,31}$'
    OR p_envelope_sha256 !~ '^[a-f0-9]{64}$'
    OR p_rotated_at IS NULL
    OR p_rotated_at NOT BETWEEN clock_timestamp() - interval '5 minutes'
                            AND clock_timestamp() + interval '1 minute'
  THEN
    RAISE EXCEPTION 'OAuth credential rotation authority is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT connections.api_credential_reference
  INTO v_current_reference
  FROM public.data_source_connections AS connections
  INNER JOIN public.connector_credentials AS credentials
    ON credentials.organization_id = connections.organization_id
   AND credentials.connection_id = connections.id
  WHERE connections.organization_id = p_organization_id
    AND connections.id = p_connection_id
    AND connections.provider::text = p_provider
    AND connections.api_credential_reference =
      'sealed:' || p_expected_credential_id::text
    AND credentials.id = p_expected_credential_id
    AND credentials.purpose = 'api_read'
    AND credentials.status = 'active'
  LIMIT 1
  FOR UPDATE OF connections, credentials;

  IF v_current_reference IS NULL THEN
    RAISE EXCEPTION 'OAuth credential rotation predecessor is unavailable'
      USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.connector_credentials
  SET status = 'superseded',
      superseded_at = p_rotated_at,
      updated_at = p_rotated_at
  WHERE organization_id = p_organization_id
    AND id = p_expected_credential_id
    AND status = 'active';

  INSERT INTO public.connector_credentials (
    id,
    organization_id,
    connection_id,
    purpose,
    encrypted_envelope,
    key_version,
    envelope_sha256,
    status,
    created_by_membership_id,
    created_by_service,
    rotated_from_credential_id,
    created_at,
    updated_at
  ) VALUES (
    p_new_credential_id,
    p_organization_id,
    p_connection_id,
    'api_read',
    p_encrypted_envelope,
    p_key_version,
    p_envelope_sha256,
    'active',
    NULL,
    'provider-token-refresh-v1',
    p_expected_credential_id,
    p_rotated_at,
    p_rotated_at
  );

  UPDATE public.data_source_connections
  SET api_credential_reference = 'sealed:' || p_new_credential_id::text,
      encrypted_credential = NULL,
      credential_key_version = NULL,
      updated_at = p_rotated_at
  WHERE organization_id = p_organization_id
    AND id = p_connection_id;

  RETURN p_new_credential_id;
END;
$$;

REVOKE ALL ON FUNCTION reconai_lock_oauth_credential(
  uuid, uuid, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconai_rotate_oauth_credential(
  uuid, uuid, text, uuid, uuid, jsonb, text, text, timestamptz
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    REVOKE ALL ON FUNCTION reconai_lock_oauth_credential(
      uuid, uuid, text, text
    ) FROM reconai_app;
    REVOKE ALL ON FUNCTION reconai_rotate_oauth_credential(
      uuid, uuid, text, uuid, uuid, jsonb, text, text, timestamptz
    ) FROM reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    GRANT EXECUTE ON FUNCTION reconai_lock_oauth_credential(
      uuid, uuid, text, text
    ) TO reconai_worker;
    GRANT EXECUTE ON FUNCTION reconai_rotate_oauth_credential(
      uuid, uuid, text, uuid, uuid, jsonb, text, text, timestamptz
    ) TO reconai_worker;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE
      ON connector_credentials FROM reconai_worker;
  END IF;
END
$$;
