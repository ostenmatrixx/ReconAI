-- Add a fixed, worker-only, identifier-free observation boundary over the online partial index.
-- The function owner receives only the cross-tenant SELECT policy required by this exact query.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_migrator')
    AND NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'exceptions'
        AND policyname = 'exceptions_observability_migrator_policy'
    )
  THEN
    CREATE POLICY exceptions_observability_migrator_policy
      ON exceptions
      FOR SELECT
      TO reconai_migrator
      USING (current_user = 'reconai_migrator');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION reconai_observe_exception_queue()
RETURNS TABLE (
  queue_state text,
  oldest_age_seconds double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  WITH oldest AS (
    SELECT exceptions.created_at
    FROM public.exceptions
    WHERE exceptions.status IN ('open', 'assigned', 'deferred', 'proposed', 'rejected')
    ORDER BY exceptions.created_at, exceptions.id
    LIMIT 1
  )
  SELECT
    CASE WHEN oldest.created_at IS NULL THEN 'empty' ELSE 'nonempty' END,
    CASE
      WHEN oldest.created_at IS NULL THEN NULL
      ELSE extract(epoch FROM (statement_timestamp() - oldest.created_at))::double precision
    END
  FROM (SELECT (SELECT created_at FROM oldest) AS created_at) AS oldest
$$;

REVOKE ALL ON FUNCTION reconai_observe_exception_queue() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    REVOKE ALL ON FUNCTION reconai_observe_exception_queue() FROM reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    GRANT EXECUTE ON FUNCTION reconai_observe_exception_queue() TO reconai_worker;
  END IF;
END
$$;
