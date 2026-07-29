-- Default-disabled, tenant-approved restricted support diagnostics.
-- Support identities never become tenant members and the application/worker roles receive no
-- direct table access. All authority flows through the fixed SECURITY DEFINER functions below.

CREATE TABLE public.support_access_requests (
  id uuid PRIMARY KEY,
  support_identity_digest char(64) NOT NULL,
  request_token_sha256 char(64) NOT NULL,
  requested_duration_minutes integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  request_expires_at timestamptz NOT NULL,
  claimed_organization_id uuid REFERENCES public.organizations (id),
  claimed_grant_id uuid,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL,
  CONSTRAINT support_access_requests_identity_digest_check
    CHECK (support_identity_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT support_access_requests_token_digest_check
    CHECK (request_token_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT support_access_requests_duration_check
    CHECK (requested_duration_minutes BETWEEN 5 AND 60),
  CONSTRAINT support_access_requests_expiry_check
    CHECK (request_expires_at = created_at + interval '15 minutes'),
  CONSTRAINT support_access_requests_state_check
    CHECK (
      (
        status = 'pending'
        AND claimed_organization_id IS NULL
        AND claimed_grant_id IS NULL
        AND claimed_at IS NULL
      )
      OR
      (
        status = 'claimed'
        AND claimed_organization_id IS NOT NULL
        AND claimed_grant_id IS NOT NULL
        AND claimed_at IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX support_access_requests_token_uidx
  ON public.support_access_requests (request_token_sha256);
CREATE INDEX support_access_requests_identity_expiry_idx
  ON public.support_access_requests (
    support_identity_digest,
    request_expires_at,
    id
  );

CREATE TABLE public.support_access_grants (
  id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  support_identity_digest char(64) NOT NULL,
  capability text NOT NULL,
  ticket_reference text NOT NULL,
  reason text NOT NULL,
  approved_by_membership_id uuid NOT NULL,
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active',
  revoked_by_membership_id uuid,
  revocation_reason text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  CONSTRAINT support_access_grants_organization_id_id_pk
    PRIMARY KEY (organization_id, id),
  CONSTRAINT support_access_grants_approver_membership_fk
    FOREIGN KEY (organization_id, approved_by_membership_id)
    REFERENCES public.memberships (organization_id, id),
  CONSTRAINT support_access_grants_revoker_membership_fk
    FOREIGN KEY (organization_id, revoked_by_membership_id)
    REFERENCES public.memberships (organization_id, id),
  CONSTRAINT support_access_grants_identity_digest_check
    CHECK (support_identity_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT support_access_grants_capability_check
    CHECK (capability = 'diagnostics:view'),
  CONSTRAINT support_access_grants_duration_check
    CHECK (
      expires_at BETWEEN
        approved_at + interval '5 minutes'
        AND approved_at + interval '60 minutes'
    ),
  CONSTRAINT support_access_grants_created_check
    CHECK (created_at = approved_at),
  CONSTRAINT support_access_grants_reason_check
    CHECK (
      length(ticket_reference) BETWEEN 3 AND 200
      AND ticket_reference !~ '[[:cntrl:]]'
      AND length(reason) BETWEEN 3 AND 2000
      AND reason !~ '[[:cntrl:]]'
    ),
  CONSTRAINT support_access_grants_state_check
    CHECK (
      (
        status = 'active'
        AND revoked_by_membership_id IS NULL
        AND revocation_reason IS NULL
        AND revoked_at IS NULL
      )
      OR
      (
        status = 'revoked'
        AND revoked_by_membership_id IS NOT NULL
        AND revocation_reason IS NOT NULL
        AND revoked_at IS NOT NULL
      )
    )
);

CREATE INDEX support_access_grants_org_created_idx
  ON public.support_access_grants (organization_id, created_at, id);
CREATE INDEX support_access_grants_authority_idx
  ON public.support_access_grants (
    organization_id,
    id,
    support_identity_digest,
    status,
    expires_at
  );

ALTER TABLE public.support_access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_access_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.support_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_access_grants FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_migrator') THEN
    CREATE POLICY support_access_requests_owner_policy
      ON public.support_access_requests
      FOR ALL
      TO reconai_migrator
      USING (current_user = 'reconai_migrator')
      WITH CHECK (current_user = 'reconai_migrator');

    CREATE POLICY support_access_grants_owner_policy
      ON public.support_access_grants
      FOR ALL
      TO reconai_migrator
      USING (current_user = 'reconai_migrator')
      WITH CHECK (current_user = 'reconai_migrator');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.support_access_requests_restrict_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'support access request evidence cannot be deleted';
  END IF;
  IF OLD.status = 'pending'
    AND NEW.status = 'claimed'
    AND NEW.id = OLD.id
    AND NEW.support_identity_digest = OLD.support_identity_digest
    AND NEW.request_token_sha256 = OLD.request_token_sha256
    AND NEW.requested_duration_minutes = OLD.requested_duration_minutes
    AND NEW.request_expires_at = OLD.request_expires_at
    AND NEW.created_at = OLD.created_at
    AND OLD.claimed_organization_id IS NULL
    AND OLD.claimed_grant_id IS NULL
    AND OLD.claimed_at IS NULL
    AND NEW.claimed_organization_id IS NOT NULL
    AND NEW.claimed_grant_id IS NOT NULL
    AND NEW.claimed_at IS NOT NULL
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'support access request transition is not permitted';
END
$$;

CREATE TRIGGER support_access_requests_restrict_mutation
BEFORE UPDATE OR DELETE ON public.support_access_requests
FOR EACH ROW EXECUTE FUNCTION public.support_access_requests_restrict_mutation();

CREATE OR REPLACE FUNCTION public.support_access_grants_restrict_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'support access grant evidence cannot be deleted';
  END IF;
  IF OLD.status = 'active'
    AND NEW.status = 'revoked'
    AND NEW.id = OLD.id
    AND NEW.organization_id = OLD.organization_id
    AND NEW.support_identity_digest = OLD.support_identity_digest
    AND NEW.capability = OLD.capability
    AND NEW.ticket_reference = OLD.ticket_reference
    AND NEW.reason = OLD.reason
    AND NEW.approved_by_membership_id = OLD.approved_by_membership_id
    AND NEW.approved_at = OLD.approved_at
    AND NEW.expires_at = OLD.expires_at
    AND NEW.created_at = OLD.created_at
    AND OLD.revoked_by_membership_id IS NULL
    AND OLD.revocation_reason IS NULL
    AND OLD.revoked_at IS NULL
    AND NEW.revoked_by_membership_id IS NOT NULL
    AND NEW.revocation_reason IS NOT NULL
    AND NEW.revoked_at IS NOT NULL
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'support access grant transition is not permitted';
END
$$;

CREATE TRIGGER support_access_grants_restrict_mutation
BEFORE UPDATE OR DELETE ON public.support_access_grants
FOR EACH ROW EXECUTE FUNCTION public.support_access_grants_restrict_mutation();

CREATE OR REPLACE FUNCTION public.reconai_create_support_access_request(
  p_request_id uuid,
  p_support_identity_digest text,
  p_request_token_sha256 text,
  p_requested_duration_minutes integer,
  p_created_at timestamptz
)
RETURNS TABLE (
  request_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF p_request_id IS NULL
    OR p_support_identity_digest !~ '^[a-f0-9]{64}$'
    OR p_request_token_sha256 !~ '^[a-f0-9]{64}$'
    OR p_requested_duration_minutes NOT BETWEEN 5 AND 60
    OR p_created_at IS NULL
    OR p_created_at NOT BETWEEN
      statement_timestamp() - interval '5 minutes'
      AND statement_timestamp() + interval '5 minutes'
  THEN
    RAISE EXCEPTION 'support access request authority is invalid';
  END IF;

  INSERT INTO public.support_access_requests (
    id,
    support_identity_digest,
    request_token_sha256,
    requested_duration_minutes,
    status,
    request_expires_at,
    created_at
  ) VALUES (
    p_request_id,
    p_support_identity_digest,
    p_request_token_sha256,
    p_requested_duration_minutes,
    'pending',
    p_created_at + interval '15 minutes',
    p_created_at
  );

  RETURN QUERY SELECT p_created_at + interval '15 minutes';
END
$$;

CREATE OR REPLACE FUNCTION public.reconai_approve_support_access_request(
  p_organization_id uuid,
  p_grant_id uuid,
  p_approver_membership_id uuid,
  p_request_token_sha256 text,
  p_ticket_reference text,
  p_reason text,
  p_approved_at timestamptz
)
RETURNS TABLE (
  grant_id uuid,
  support_identity_digest text,
  capability text,
  ticket_reference text,
  reason text,
  approved_at timestamptz,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_active_organization_id uuid;
  v_request public.support_access_requests%ROWTYPE;
BEGIN
  v_active_organization_id :=
    nullif(current_setting('app.organization_id', true), '')::uuid;
  IF v_active_organization_id IS NULL
    OR v_active_organization_id <> p_organization_id
  THEN
    RAISE EXCEPTION 'tenant context does not authorize support grant approval'
      USING ERRCODE = '42501';
  END IF;
  IF p_grant_id IS NULL
    OR p_approver_membership_id IS NULL
    OR p_request_token_sha256 !~ '^[a-f0-9]{64}$'
    OR length(p_ticket_reference) NOT BETWEEN 3 AND 200
    OR p_ticket_reference ~ '[[:cntrl:]]'
    OR length(p_reason) NOT BETWEEN 3 AND 2000
    OR p_reason ~ '[[:cntrl:]]'
    OR p_approved_at IS NULL
    OR p_approved_at NOT BETWEEN
      statement_timestamp() - interval '5 minutes'
      AND statement_timestamp() + interval '5 minutes'
  THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.memberships AS memberships
    JOIN public.users AS users
      ON users.id = memberships.user_id
    WHERE memberships.organization_id = p_organization_id
      AND memberships.id = p_approver_membership_id
      AND memberships.role = 'owner'
      AND memberships.status = 'active'
      AND users.status = 'active'
  ) THEN
    RETURN;
  END IF;

  SELECT requests.*
  INTO v_request
  FROM public.support_access_requests AS requests
  WHERE requests.request_token_sha256 = p_request_token_sha256
    AND requests.status = 'pending'
    AND requests.request_expires_at > statement_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO public.support_access_grants (
    id,
    organization_id,
    support_identity_digest,
    capability,
    ticket_reference,
    reason,
    approved_by_membership_id,
    approved_at,
    expires_at,
    status,
    created_at
  ) VALUES (
    p_grant_id,
    p_organization_id,
    v_request.support_identity_digest,
    'diagnostics:view',
    p_ticket_reference,
    p_reason,
    p_approver_membership_id,
    p_approved_at,
    p_approved_at + make_interval(mins => v_request.requested_duration_minutes),
    'active',
    p_approved_at
  );

  UPDATE public.support_access_requests
  SET
    status = 'claimed',
    claimed_organization_id = p_organization_id,
    claimed_grant_id = p_grant_id,
    claimed_at = p_approved_at
  WHERE id = v_request.id;

  RETURN QUERY SELECT
    p_grant_id,
    trim(v_request.support_identity_digest)::text,
    'diagnostics:view'::text,
    p_ticket_reference,
    p_reason,
    p_approved_at,
    p_approved_at + make_interval(mins => v_request.requested_duration_minutes);
END
$$;

CREATE OR REPLACE FUNCTION public.reconai_list_support_access_grants(
  p_organization_id uuid,
  p_membership_id uuid,
  p_limit integer
)
RETURNS TABLE (
  grant_id uuid,
  support_identity_reference text,
  capability text,
  ticket_reference text,
  reason text,
  approved_at timestamptz,
  expires_at timestamptz,
  grant_status text,
  revoked_at timestamptz,
  revocation_reason text
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
    OR p_limit NOT BETWEEN 1 AND 100
  THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.memberships AS memberships
    JOIN public.users AS users
      ON users.id = memberships.user_id
    WHERE memberships.organization_id = p_organization_id
      AND memberships.id = p_membership_id
      AND memberships.role = 'owner'
      AND memberships.status = 'active'
      AND users.status = 'active'
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    grants.id,
    left(trim(grants.support_identity_digest), 12),
    grants.capability,
    grants.ticket_reference,
    grants.reason,
    grants.approved_at,
    grants.expires_at,
    CASE
      WHEN grants.status = 'revoked' THEN 'revoked'
      WHEN grants.expires_at <= statement_timestamp() THEN 'expired'
      ELSE 'active'
    END,
    grants.revoked_at,
    grants.revocation_reason
  FROM public.support_access_grants AS grants
  WHERE grants.organization_id = p_organization_id
  ORDER BY grants.created_at DESC, grants.id DESC
  LIMIT p_limit;
END
$$;

CREATE OR REPLACE FUNCTION public.reconai_revoke_support_access_grant(
  p_organization_id uuid,
  p_grant_id uuid,
  p_revoker_membership_id uuid,
  p_revocation_reason text,
  p_revoked_at timestamptz
)
RETURNS TABLE (
  outcome text,
  support_identity_reference text,
  capability text,
  ticket_reference text,
  expires_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_active_organization_id uuid;
  v_grant public.support_access_grants%ROWTYPE;
BEGIN
  v_active_organization_id :=
    nullif(current_setting('app.organization_id', true), '')::uuid;
  IF v_active_organization_id IS NULL
    OR v_active_organization_id <> p_organization_id
  THEN
    RAISE EXCEPTION 'tenant context does not authorize support grant revocation'
      USING ERRCODE = '42501';
  END IF;
  IF p_grant_id IS NULL
    OR p_revoker_membership_id IS NULL
    OR length(p_revocation_reason) NOT BETWEEN 3 AND 2000
    OR p_revocation_reason ~ '[[:cntrl:]]'
    OR p_revoked_at IS NULL
    OR p_revoked_at NOT BETWEEN
      statement_timestamp() - interval '5 minutes'
      AND statement_timestamp() + interval '5 minutes'
  THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.memberships AS memberships
    JOIN public.users AS users
      ON users.id = memberships.user_id
    WHERE memberships.organization_id = p_organization_id
      AND memberships.id = p_revoker_membership_id
      AND memberships.role = 'owner'
      AND memberships.status = 'active'
      AND users.status = 'active'
  ) THEN
    RETURN;
  END IF;

  SELECT grants.*
  INTO v_grant
  FROM public.support_access_grants AS grants
  WHERE grants.organization_id = p_organization_id
    AND grants.id = p_grant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_grant.status = 'revoked' THEN
    RETURN QUERY SELECT
      'already_revoked'::text,
      left(trim(v_grant.support_identity_digest), 12),
      v_grant.capability,
      v_grant.ticket_reference,
      v_grant.expires_at,
      v_grant.revoked_at;
    RETURN;
  END IF;

  UPDATE public.support_access_grants
  SET
    status = 'revoked',
    revoked_by_membership_id = p_revoker_membership_id,
    revocation_reason = p_revocation_reason,
    revoked_at = p_revoked_at
  WHERE organization_id = p_organization_id
    AND id = p_grant_id;

  RETURN QUERY SELECT
    'revoked'::text,
    left(trim(v_grant.support_identity_digest), 12),
    v_grant.capability,
    v_grant.ticket_reference,
    v_grant.expires_at,
    p_revoked_at;
END
$$;

CREATE OR REPLACE FUNCTION public.reconai_support_diagnostics(
  p_organization_id uuid,
  p_grant_id uuid,
  p_support_identity_digest text
)
RETURNS TABLE (
  generated_at timestamptz,
  grant_expires_at timestamptz,
  connection_count integer,
  non_healthy_connection_count integer,
  latest_successful_sync_at timestamptz,
  provider_sync_active_count integer,
  provider_sync_failed_count integer,
  latest_provider_sync_completed_at timestamptz,
  reconciliation_active_count integer,
  reconciliation_failed_count integer,
  latest_reconciliation_completed_at timestamptz,
  unresolved_exception_count integer,
  oldest_unresolved_exception_at timestamptz,
  unpublished_outbox_count integer,
  dead_lettered_outbox_count integer,
  oldest_unpublished_outbox_at timestamptz,
  counts_capped boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_active_organization_id uuid;
  v_grant_expires_at timestamptz;
  v_connection_count bigint;
  v_non_healthy_connection_count bigint;
  v_provider_sync_active_count bigint;
  v_provider_sync_failed_count bigint;
  v_reconciliation_active_count bigint;
  v_reconciliation_failed_count bigint;
  v_unresolved_exception_count bigint;
  v_unpublished_outbox_count bigint;
  v_dead_lettered_outbox_count bigint;
  v_latest_successful_sync_at timestamptz;
  v_latest_provider_sync_completed_at timestamptz;
  v_latest_reconciliation_completed_at timestamptz;
  v_oldest_unresolved_exception_at timestamptz;
  v_oldest_unpublished_outbox_at timestamptz;
  v_counts_capped boolean;
BEGIN
  v_active_organization_id :=
    nullif(current_setting('app.organization_id', true), '')::uuid;
  IF v_active_organization_id IS NULL
    OR v_active_organization_id <> p_organization_id
    OR p_grant_id IS NULL
    OR p_support_identity_digest !~ '^[a-f0-9]{64}$'
  THEN
    RETURN;
  END IF;

  SELECT grants.expires_at
  INTO v_grant_expires_at
  FROM public.support_access_grants AS grants
  WHERE grants.organization_id = p_organization_id
    AND grants.id = p_grant_id
    AND grants.support_identity_digest = p_support_identity_digest
    AND grants.capability = 'diagnostics:view'
    AND grants.status = 'active'
    AND grants.approved_at <= statement_timestamp()
    AND grants.expires_at > statement_timestamp();
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT
    count(*),
    count(*) FILTER (WHERE status <> 'healthy'),
    max(last_successful_sync_at)
  INTO
    v_connection_count,
    v_non_healthy_connection_count,
    v_latest_successful_sync_at
  FROM public.data_source_connections
  WHERE organization_id = p_organization_id;

  SELECT
    count(*) FILTER (WHERE status IN ('queued', 'running')),
    count(*) FILTER (WHERE status = 'failed'),
    max(completed_at)
  INTO
    v_provider_sync_active_count,
    v_provider_sync_failed_count,
    v_latest_provider_sync_completed_at
  FROM public.provider_sync_runs
  WHERE organization_id = p_organization_id;

  SELECT
    count(*) FILTER (WHERE status IN ('queued', 'running')),
    count(*) FILTER (WHERE status IN ('partial', 'failed')),
    max(completed_at)
  INTO
    v_reconciliation_active_count,
    v_reconciliation_failed_count,
    v_latest_reconciliation_completed_at
  FROM public.reconciliation_runs
  WHERE organization_id = p_organization_id;

  SELECT
    count(*),
    min(created_at)
  INTO
    v_unresolved_exception_count,
    v_oldest_unresolved_exception_at
  FROM public.exceptions
  WHERE organization_id = p_organization_id
    AND status IN ('open', 'assigned', 'deferred', 'proposed', 'rejected');

  SELECT
    count(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL),
    count(*) FILTER (WHERE dead_lettered_at IS NOT NULL),
    min(created_at) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL)
  INTO
    v_unpublished_outbox_count,
    v_dead_lettered_outbox_count,
    v_oldest_unpublished_outbox_at
  FROM public.outbox_events
  WHERE organization_id = p_organization_id;

  v_counts_capped := GREATEST(
    v_connection_count,
    v_non_healthy_connection_count,
    v_provider_sync_active_count,
    v_provider_sync_failed_count,
    v_reconciliation_active_count,
    v_reconciliation_failed_count,
    v_unresolved_exception_count,
    v_unpublished_outbox_count,
    v_dead_lettered_outbox_count
  ) > 2147483647;

  RETURN QUERY SELECT
    statement_timestamp(),
    v_grant_expires_at,
    least(v_connection_count, 2147483647)::integer,
    least(v_non_healthy_connection_count, 2147483647)::integer,
    v_latest_successful_sync_at,
    least(v_provider_sync_active_count, 2147483647)::integer,
    least(v_provider_sync_failed_count, 2147483647)::integer,
    v_latest_provider_sync_completed_at,
    least(v_reconciliation_active_count, 2147483647)::integer,
    least(v_reconciliation_failed_count, 2147483647)::integer,
    v_latest_reconciliation_completed_at,
    least(v_unresolved_exception_count, 2147483647)::integer,
    v_oldest_unresolved_exception_at,
    least(v_unpublished_outbox_count, 2147483647)::integer,
    least(v_dead_lettered_outbox_count, 2147483647)::integer,
    v_oldest_unpublished_outbox_at,
    v_counts_capped;
END
$$;

REVOKE ALL ON public.support_access_requests FROM PUBLIC;
REVOKE ALL ON public.support_access_grants FROM PUBLIC;
REVOKE ALL ON FUNCTION public.support_access_requests_restrict_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.support_access_grants_restrict_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconai_create_support_access_request(
  uuid, text, text, integer, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconai_approve_support_access_request(
  uuid, uuid, uuid, text, text, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconai_list_support_access_grants(
  uuid, uuid, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconai_revoke_support_access_grant(
  uuid, uuid, uuid, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconai_support_diagnostics(
  uuid, uuid, text
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    REVOKE ALL ON public.support_access_requests FROM reconai_app;
    REVOKE ALL ON public.support_access_grants FROM reconai_app;
    GRANT EXECUTE ON FUNCTION public.reconai_create_support_access_request(
      uuid, text, text, integer, timestamptz
    ) TO reconai_app;
    GRANT EXECUTE ON FUNCTION public.reconai_approve_support_access_request(
      uuid, uuid, uuid, text, text, text, timestamptz
    ) TO reconai_app;
    GRANT EXECUTE ON FUNCTION public.reconai_list_support_access_grants(
      uuid, uuid, integer
    ) TO reconai_app;
    GRANT EXECUTE ON FUNCTION public.reconai_revoke_support_access_grant(
      uuid, uuid, uuid, text, timestamptz
    ) TO reconai_app;
    GRANT EXECUTE ON FUNCTION public.reconai_support_diagnostics(
      uuid, uuid, text
    ) TO reconai_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    REVOKE ALL ON public.support_access_requests FROM reconai_worker;
    REVOKE ALL ON public.support_access_grants FROM reconai_worker;
  END IF;
END
$$;
