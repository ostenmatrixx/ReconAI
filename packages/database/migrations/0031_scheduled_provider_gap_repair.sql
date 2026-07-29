-- Add a distinct service authority and a narrow worker-only scheduling boundary for periodic
-- provider gap repair. Existing member-requested runs remain unchanged.

ALTER TABLE provider_sync_runs
  ADD COLUMN requester_type text NOT NULL DEFAULT 'user',
  ADD COLUMN requested_by_service text,
  ALTER COLUMN requested_by_membership_id DROP NOT NULL,
  ADD CONSTRAINT provider_sync_runs_requester_type_check
    CHECK (requester_type IN ('user', 'system')),
  ADD CONSTRAINT provider_sync_runs_requester_authority_check CHECK (
    (
      requester_type = 'user'
      AND requested_by_membership_id IS NOT NULL
      AND requested_by_service IS NULL
    )
    OR
    (
      requester_type = 'system'
      AND requested_by_membership_id IS NULL
      AND requested_by_service = 'provider-gap-repair-scheduler'
    )
  );

CREATE OR REPLACE FUNCTION protect_provider_sync_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    OLD.id,
    OLD.organization_id,
    OLD.connection_id,
    OLD.provider,
    OLD.mode,
    OLD.window_start,
    OLD.window_end,
    OLD.maximum_pages,
    OLD.idempotency_key,
    OLD.correlation_id,
    OLD.requester_type,
    OLD.requested_by_membership_id,
    OLD.requested_by_service,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id,
    NEW.organization_id,
    NEW.connection_id,
    NEW.provider,
    NEW.mode,
    NEW.window_start,
    NEW.window_end,
    NEW.maximum_pages,
    NEW.idempotency_key,
    NEW.correlation_id,
    NEW.requester_type,
    NEW.requested_by_membership_id,
    NEW.requested_by_service,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'provider sync authority is immutable';
  END IF;

  IF OLD.status IN ('partial', 'succeeded', 'failed') THEN
    RAISE EXCEPTION 'terminal provider sync evidence is immutable';
  END IF;

  IF NEW.page_count < OLD.page_count
    OR NEW.page_count > OLD.page_count + 1
    OR NEW.item_count < OLD.item_count
    OR NEW.duplicate_count < OLD.duplicate_count
    OR NEW.failed_attempts < OLD.failed_attempts
    OR NEW.failed_attempts > OLD.failed_attempts + 1 THEN
    RAISE EXCEPTION 'provider sync progress transition is invalid';
  END IF;

  RETURN NEW;
END;
$$;

-- The migration owner receives only the cross-tenant SELECT needed by the fixed due-candidate
-- function. The normal worker still cannot enumerate connection rows directly without tenant RLS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_migrator') THEN
    CREATE POLICY connections_gap_repair_migrator_policy
      ON data_source_connections
      FOR SELECT
      TO reconai_migrator
      USING (current_user = 'reconai_migrator');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION reconai_due_provider_gap_repairs(
  p_due_before timestamptz,
  p_requested_limit integer
)
RETURNS TABLE (
  organization_id uuid,
  connection_id uuid,
  provider text,
  last_successful_sync_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT
    connections.organization_id,
    connections.id,
    connections.provider::text,
    connections.last_successful_sync_at
  FROM public.data_source_connections AS connections
  WHERE p_due_before IS NOT NULL
    AND p_requested_limit BETWEEN 1 AND 100
    AND connections.provider IN ('shopify', 'stripe')
    AND connections.status IN ('healthy', 'degraded', 'stale')
    AND connections.api_credential_reference IS NOT NULL
    AND coalesce(connections.last_successful_sync_at, connections.created_at) <= p_due_before
    AND NOT EXISTS (
      SELECT 1
      FROM public.provider_sync_runs AS runs
      WHERE runs.organization_id = connections.organization_id
        AND runs.connection_id = connections.id
        AND runs.status IN ('queued', 'running')
    )
  ORDER BY
    coalesce(connections.last_successful_sync_at, connections.created_at),
    connections.organization_id,
    connections.id
  LIMIT p_requested_limit
$$;

CREATE OR REPLACE FUNCTION reconai_create_scheduled_provider_gap_repair(
  p_organization_id uuid,
  p_connection_id uuid,
  p_provider text,
  p_run_id uuid,
  p_run_idempotency_key text,
  p_correlation_id uuid,
  p_outbox_id uuid,
  p_outbox_idempotency_key text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_maximum_pages integer,
  p_due_before timestamptz,
  p_created_at timestamptz,
  p_envelope jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_active_organization_id uuid;
  v_inserted boolean;
BEGIN
  v_active_organization_id :=
    nullif(current_setting('app.organization_id', true), '')::uuid;
  IF v_active_organization_id IS NULL
    OR v_active_organization_id <> p_organization_id
  THEN
    RAISE EXCEPTION 'tenant context does not authorize scheduled provider gap repair'
      USING ERRCODE = '42501';
  END IF;

  IF p_organization_id IS NULL
    OR p_connection_id IS NULL
    OR p_run_id IS NULL
    OR p_correlation_id IS NULL
    OR p_outbox_id IS NULL
    OR p_provider NOT IN ('shopify', 'stripe')
    OR p_window_start IS NULL
    OR p_window_end IS NULL
    OR p_due_before IS NULL
    OR p_created_at IS NULL
    OR p_window_end <= p_window_start
    OR p_window_end - p_window_start > interval '30 days'
    OR p_window_end <> p_created_at
    OR p_due_before >= p_created_at
    OR p_created_at - p_due_before NOT BETWEEN interval '1 minute' AND interval '1 day'
    OR p_maximum_pages NOT BETWEEN 1 AND 25
    OR p_run_idempotency_key !~ '^[a-f0-9]{64}$'
    OR p_outbox_idempotency_key <>
      p_provider || ':sync:' || p_run_id::text || ':dispatch:1'
    OR jsonb_typeof(p_envelope) <> 'object'
    OR p_envelope ->> 'createdAt' IS NULL
    OR p_envelope <> jsonb_build_object(
      'schemaVersion', 1,
      'type', 'connector.sync.requested',
      'organizationId', p_organization_id::text,
      'connectionId', p_connection_id::text,
      'provider', p_provider,
      'syncRunId', p_run_id::text,
      'executionAttempt', 1,
      'correlationId', p_correlation_id::text,
      'idempotencyKey', p_outbox_idempotency_key,
      'requestedBy', 'provider-gap-repair-scheduler',
      'createdAt', p_envelope ->> 'createdAt'
    )
    OR (p_envelope ->> 'createdAt')::timestamptz <> p_created_at
  THEN
    RAISE EXCEPTION 'scheduled provider gap repair authority is invalid';
  END IF;

  -- Serialize all scheduler instances and user requests for this connection without requiring
  -- cross-tenant UPDATE authority on the connection row.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_organization_id::text || ':' || p_connection_id::text, 0)
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.data_source_connections AS connections
    WHERE connections.organization_id = p_organization_id
      AND connections.id = p_connection_id
      AND connections.provider::text = p_provider
      AND connections.status IN ('healthy', 'degraded', 'stale')
      AND connections.api_credential_reference IS NOT NULL
      AND coalesce(connections.last_successful_sync_at, connections.created_at) <= p_due_before
  ) OR EXISTS (
    SELECT 1
    FROM public.provider_sync_runs AS runs
    WHERE runs.organization_id = p_organization_id
      AND runs.connection_id = p_connection_id
      AND runs.status IN ('queued', 'running')
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO public.provider_sync_runs (
    id,
    organization_id,
    connection_id,
    provider,
    mode,
    window_start,
    window_end,
    status,
    maximum_pages,
    idempotency_key,
    correlation_id,
    requester_type,
    requested_by_membership_id,
    requested_by_service,
    created_at,
    updated_at
  ) VALUES (
    p_run_id,
    p_organization_id,
    p_connection_id,
    p_provider::public.source_system,
    'gap_repair',
    p_window_start,
    p_window_end,
    'queued',
    p_maximum_pages,
    p_run_idempotency_key,
    p_correlation_id,
    'system',
    NULL,
    'provider-gap-repair-scheduler',
    p_created_at,
    p_created_at
  )
  ON CONFLICT (organization_id, idempotency_key) DO NOTHING
  RETURNING true INTO v_inserted;

  IF NOT coalesce(v_inserted, false) THEN
    RETURN false;
  END IF;

  INSERT INTO public.outbox_events (
    id,
    organization_id,
    event_type,
    schema_version,
    idempotency_key,
    payload,
    correlation_id,
    created_at
  ) VALUES (
    p_outbox_id,
    p_organization_id,
    'connector.sync.requested',
    1,
    p_outbox_idempotency_key,
    p_envelope,
    p_correlation_id,
    p_created_at
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION reconai_due_provider_gap_repairs(timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconai_create_scheduled_provider_gap_repair(
  uuid, uuid, text, uuid, text, uuid, uuid, text, timestamptz, timestamptz,
  integer, timestamptz, timestamptz, jsonb
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    REVOKE ALL ON FUNCTION reconai_due_provider_gap_repairs(timestamptz, integer)
      FROM reconai_app;
    REVOKE ALL ON FUNCTION reconai_create_scheduled_provider_gap_repair(
      uuid, uuid, text, uuid, text, uuid, uuid, text, timestamptz, timestamptz,
      integer, timestamptz, timestamptz, jsonb
    ) FROM reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    GRANT EXECUTE ON FUNCTION reconai_due_provider_gap_repairs(timestamptz, integer)
      TO reconai_worker;
    GRANT EXECUTE ON FUNCTION reconai_create_scheduled_provider_gap_repair(
      uuid, uuid, text, uuid, text, uuid, uuid, text, timestamptz, timestamptz,
      integer, timestamptz, timestamptz, jsonb
    ) TO reconai_worker;
    REVOKE INSERT, DELETE, TRUNCATE ON provider_sync_runs FROM reconai_worker;
  END IF;
END
$$;
