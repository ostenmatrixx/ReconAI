-- Record one digest-bound, expiring browser-receipt authority for each prepared Shopify
-- customer-data evidence package. Package bytes and raw bearer tokens are never stored here.

CREATE TABLE public.provider_privacy_data_packages (
  id uuid NOT NULL,
  organization_id uuid NOT NULL,
  request_id uuid NOT NULL,
  prepared_by_membership_id uuid NOT NULL,
  content_sha256 char(64) NOT NULL,
  byte_count integer NOT NULL,
  receipt_token_sha256 char(64) NOT NULL,
  prepared_at timestamptz NOT NULL,
  receipt_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT provider_privacy_data_packages_organization_id_id_pk
    PRIMARY KEY (organization_id, id),
  CONSTRAINT provider_privacy_data_packages_request_fk
    FOREIGN KEY (organization_id, request_id)
    REFERENCES public.provider_privacy_requests (organization_id, id),
  CONSTRAINT provider_privacy_data_packages_preparer_membership_fk
    FOREIGN KEY (organization_id, prepared_by_membership_id)
    REFERENCES public.memberships (organization_id, id),
  CONSTRAINT provider_privacy_data_packages_content_hash_check
    CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT provider_privacy_data_packages_token_hash_check
    CHECK (receipt_token_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT provider_privacy_data_packages_byte_count_check
    CHECK (byte_count BETWEEN 1 AND 5242880),
  CONSTRAINT provider_privacy_data_packages_expiry_check
    CHECK (receipt_expires_at = prepared_at + interval '10 minutes'),
  CONSTRAINT provider_privacy_data_packages_created_check
    CHECK (created_at = prepared_at)
);

CREATE UNIQUE INDEX provider_privacy_data_packages_token_uidx
  ON public.provider_privacy_data_packages (receipt_token_sha256);

CREATE INDEX provider_privacy_data_packages_request_prepared_idx
  ON public.provider_privacy_data_packages (
    organization_id,
    request_id,
    prepared_at,
    id
  );

CREATE TABLE public.provider_privacy_data_package_receipts (
  id uuid NOT NULL,
  organization_id uuid NOT NULL,
  package_id uuid NOT NULL,
  received_by_membership_id uuid NOT NULL,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT provider_privacy_data_package_receipts_organization_id_id_pk
    PRIMARY KEY (organization_id, id),
  CONSTRAINT provider_privacy_data_package_receipts_package_fk
    FOREIGN KEY (organization_id, package_id)
    REFERENCES public.provider_privacy_data_packages (organization_id, id),
  CONSTRAINT provider_privacy_data_package_receipts_membership_fk
    FOREIGN KEY (organization_id, received_by_membership_id)
    REFERENCES public.memberships (organization_id, id),
  CONSTRAINT provider_privacy_data_package_receipts_created_check
    CHECK (created_at = received_at)
);

CREATE UNIQUE INDEX provider_privacy_data_package_receipts_package_uidx
  ON public.provider_privacy_data_package_receipts (organization_id, package_id);

ALTER TABLE public.provider_privacy_data_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_privacy_data_packages FORCE ROW LEVEL SECURITY;
ALTER TABLE public.provider_privacy_data_package_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_privacy_data_package_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_privacy_data_packages_tenant_insert_policy
  ON public.provider_privacy_data_packages
  FOR INSERT
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_migrator') THEN
    CREATE POLICY provider_privacy_data_packages_migrator_policy
      ON public.provider_privacy_data_packages
      FOR ALL
      TO reconai_migrator
      USING (current_user = 'reconai_migrator')
      WITH CHECK (current_user = 'reconai_migrator');

    CREATE POLICY provider_privacy_data_package_receipts_migrator_policy
      ON public.provider_privacy_data_package_receipts
      FOR ALL
      TO reconai_migrator
      USING (current_user = 'reconai_migrator')
      WITH CHECK (current_user = 'reconai_migrator');
  END IF;
END
$$;

CREATE POLICY provider_privacy_data_packages_tenant_function_policy
  ON public.provider_privacy_data_packages
  FOR SELECT
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

CREATE POLICY provider_privacy_data_package_receipts_tenant_function_policy
  ON public.provider_privacy_data_package_receipts
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

CREATE OR REPLACE FUNCTION public.reject_provider_privacy_data_package_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'provider privacy data package evidence is append-only';
END;
$$;

CREATE TRIGGER provider_privacy_data_packages_reject_update_delete
BEFORE UPDATE OR DELETE ON public.provider_privacy_data_packages
FOR EACH ROW EXECUTE FUNCTION public.reject_provider_privacy_data_package_mutation();

CREATE TRIGGER provider_privacy_data_package_receipts_reject_update_delete
BEFORE UPDATE OR DELETE ON public.provider_privacy_data_package_receipts
FOR EACH ROW EXECUTE FUNCTION public.reject_provider_privacy_data_package_mutation();

CREATE OR REPLACE FUNCTION public.reconai_acknowledge_provider_privacy_data_package(
  p_organization_id uuid,
  p_request_id uuid,
  p_package_id uuid,
  p_receipt_id uuid,
  p_membership_id uuid,
  p_receipt_token_sha256 text,
  p_received_at timestamptz
)
RETURNS TABLE (
  outcome text,
  content_sha256 text,
  byte_count integer,
  prepared_at timestamptz,
  receipt_expires_at timestamptz,
  received_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_active_organization_id uuid;
  v_package public.provider_privacy_data_packages%ROWTYPE;
  v_existing_received_at timestamptz;
BEGIN
  v_active_organization_id :=
    nullif(current_setting('app.organization_id', true), '')::uuid;
  IF v_active_organization_id IS NULL
    OR v_active_organization_id <> p_organization_id
  THEN
    RAISE EXCEPTION 'tenant context does not authorize privacy package receipt'
      USING ERRCODE = '42501';
  END IF;

  IF p_organization_id IS NULL
    OR p_request_id IS NULL
    OR p_package_id IS NULL
    OR p_receipt_id IS NULL
    OR p_membership_id IS NULL
    OR p_receipt_token_sha256 !~ '^[a-f0-9]{64}$'
    OR p_received_at IS NULL
    OR p_received_at NOT BETWEEN
      statement_timestamp() - interval '5 minutes'
      AND statement_timestamp() + interval '5 minutes'
  THEN
    RAISE EXCEPTION 'privacy package receipt authority is invalid';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_organization_id::text || ':' || p_package_id::text,
      7
    )
  );

  SELECT packages.*
  INTO v_package
  FROM public.provider_privacy_data_packages AS packages
  JOIN public.memberships AS memberships
    ON memberships.organization_id = packages.organization_id
   AND memberships.id = packages.prepared_by_membership_id
  WHERE packages.organization_id = p_organization_id
    AND packages.request_id = p_request_id
    AND packages.id = p_package_id
    AND packages.prepared_by_membership_id = p_membership_id
    AND packages.receipt_token_sha256 = p_receipt_token_sha256
    AND memberships.status = 'active';

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT receipts.received_at
  INTO v_existing_received_at
  FROM public.provider_privacy_data_package_receipts AS receipts
  WHERE receipts.organization_id = p_organization_id
    AND receipts.package_id = p_package_id;

  IF FOUND THEN
    RETURN QUERY SELECT
      'already_acknowledged'::text,
      trim(v_package.content_sha256)::text,
      v_package.byte_count,
      v_package.prepared_at,
      v_package.receipt_expires_at,
      v_existing_received_at;
    RETURN;
  END IF;

  IF p_received_at >= v_package.receipt_expires_at THEN
    RETURN QUERY SELECT
      'expired'::text,
      trim(v_package.content_sha256)::text,
      v_package.byte_count,
      v_package.prepared_at,
      v_package.receipt_expires_at,
      NULL::timestamptz;
    RETURN;
  END IF;

  INSERT INTO public.provider_privacy_data_package_receipts (
    id,
    organization_id,
    package_id,
    received_by_membership_id,
    received_at,
    created_at
  ) VALUES (
    p_receipt_id,
    p_organization_id,
    p_package_id,
    p_membership_id,
    p_received_at,
    p_received_at
  );

  RETURN QUERY SELECT
    'acknowledged'::text,
    trim(v_package.content_sha256)::text,
    v_package.byte_count,
    v_package.prepared_at,
    v_package.receipt_expires_at,
    p_received_at;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT INSERT ON public.provider_privacy_data_packages TO reconai_app;
    REVOKE SELECT, UPDATE, DELETE, TRUNCATE ON
      public.provider_privacy_data_packages
    FROM reconai_app;
    REVOKE ALL ON public.provider_privacy_data_package_receipts FROM reconai_app;
    GRANT EXECUTE ON FUNCTION
      public.reconai_acknowledge_provider_privacy_data_package(
        uuid,
        uuid,
        uuid,
        uuid,
        uuid,
        text,
        timestamptz
      )
    TO reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    REVOKE ALL ON public.provider_privacy_data_packages FROM reconai_worker;
    REVOKE ALL ON public.provider_privacy_data_package_receipts FROM reconai_worker;
    REVOKE ALL ON FUNCTION
      public.reconai_acknowledge_provider_privacy_data_package(
        uuid,
        uuid,
        uuid,
        uuid,
        uuid,
        text,
        timestamptz
      )
    FROM reconai_worker;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION
  public.reconai_acknowledge_provider_privacy_data_package(
    uuid,
    uuid,
    uuid,
    uuid,
    uuid,
    text,
    timestamptz
  )
FROM PUBLIC;
