-- A worker-only, fixed-query relay boundary for cross-tenant unpublished outbox events.

ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_attempts_nonnegative_check CHECK (attempts >= 0),
  ADD CONSTRAINT outbox_error_code_check CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,100}$'
  ),
  ADD CONSTRAINT outbox_terminal_state_check CHECK (
    NOT (published_at IS NOT NULL AND dead_lettered_at IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION reconai_pending_outbox(requested_limit integer)
RETURNS TABLE (
  organization_id uuid,
  event_type text,
  idempotency_key text,
  payload jsonb,
  attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF requested_limit < 1 OR requested_limit > 500 THEN
    RAISE EXCEPTION 'outbox batch limit must be between 1 and 500';
  END IF;
  RETURN QUERY
    SELECT
      event.organization_id,
      event.event_type,
      event.idempotency_key,
      event.payload,
      event.attempts
    FROM public.outbox_events AS event
    WHERE event.published_at IS NULL
      AND event.dead_lettered_at IS NULL
      AND event.next_attempt_at <= now()
    ORDER BY event.created_at, event.organization_id, event.id
    LIMIT requested_limit;
END;
$$;

CREATE OR REPLACE FUNCTION reconai_mark_outbox_published(
  requested_organization_id uuid,
  requested_idempotency_key text,
  requested_published_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  changed boolean;
BEGIN
  UPDATE public.outbox_events
  SET published_at = requested_published_at,
      attempts = attempts + 1,
      last_error_code = NULL
  WHERE organization_id = requested_organization_id
    AND idempotency_key = requested_idempotency_key
    AND published_at IS NULL
    AND dead_lettered_at IS NULL
  RETURNING true INTO changed;
  RETURN coalesce(changed, false);
END;
$$;

CREATE OR REPLACE FUNCTION reconai_mark_outbox_failed(
  requested_organization_id uuid,
  requested_idempotency_key text,
  requested_error_code text,
  requested_next_attempt_at timestamptz,
  requested_maximum_attempts integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  changed boolean;
BEGIN
  IF requested_error_code !~ '^[A-Z0-9_]{1,100}$' THEN
    RAISE EXCEPTION 'outbox error code is invalid';
  END IF;
  IF requested_maximum_attempts < 1 OR requested_maximum_attempts > 100 THEN
    RAISE EXCEPTION 'outbox maximum attempts must be between 1 and 100';
  END IF;
  UPDATE public.outbox_events
  SET attempts = attempts + 1,
      last_error_code = requested_error_code,
      next_attempt_at = requested_next_attempt_at,
      dead_lettered_at = CASE
        WHEN attempts + 1 >= requested_maximum_attempts THEN now()
        ELSE NULL
      END
  WHERE organization_id = requested_organization_id
    AND idempotency_key = requested_idempotency_key
    AND published_at IS NULL
    AND dead_lettered_at IS NULL
  RETURNING true INTO changed;
  RETURN coalesce(changed, false);
END;
$$;

REVOKE ALL ON FUNCTION reconai_pending_outbox(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconai_mark_outbox_published(uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconai_mark_outbox_failed(uuid, text, text, timestamptz, integer)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    REVOKE ALL ON FUNCTION reconai_pending_outbox(integer) FROM reconai_app;
    REVOKE ALL ON FUNCTION reconai_mark_outbox_published(uuid, text, timestamptz)
      FROM reconai_app;
    REVOKE ALL ON FUNCTION reconai_mark_outbox_failed(uuid, text, text, timestamptz, integer)
      FROM reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    GRANT USAGE ON SCHEMA public TO reconai_worker;
    GRANT EXECUTE ON FUNCTION reconai_pending_outbox(integer) TO reconai_worker;
    GRANT EXECUTE ON FUNCTION reconai_mark_outbox_published(uuid, text, timestamptz)
      TO reconai_worker;
    GRANT EXECUTE ON FUNCTION reconai_mark_outbox_failed(
      uuid, text, text, timestamptz, integer
    ) TO reconai_worker;

    GRANT SELECT, INSERT, UPDATE ON
      data_source_connections,
      source_events,
      imports,
      outbox_events
    TO reconai_worker;
    GRANT SELECT, INSERT ON canonical_records, audit_events TO reconai_worker;
    REVOKE DELETE, TRUNCATE ON
      data_source_connections,
      source_events,
      imports,
      canonical_records,
      audit_events,
      outbox_events
    FROM reconai_worker;
    REVOKE UPDATE ON canonical_records, audit_events FROM reconai_worker;
  END IF;
END
$$;
