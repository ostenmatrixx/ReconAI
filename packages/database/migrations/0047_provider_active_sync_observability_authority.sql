-- Add a fixed, worker-only, identifier-free observation boundary over the online partial index.
-- The migration owner already has the forced-RLS maintenance policy required by this exact query.

CREATE OR REPLACE FUNCTION reconai_observe_provider_active_syncs()
RETURNS TABLE (
  provider text,
  activity_state text,
  sync_status text,
  oldest_age_seconds double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  WITH providers(provider) AS (
    VALUES
      ('shopify'::public.source_system),
      ('stripe'::public.source_system)
  )
  SELECT
    providers.provider::text,
    CASE WHEN oldest.created_at IS NULL THEN 'empty' ELSE 'active' END,
    oldest.status,
    CASE
      WHEN oldest.created_at IS NULL THEN NULL
      ELSE extract(epoch FROM (statement_timestamp() - oldest.created_at))::double precision
    END
  FROM providers
  LEFT JOIN LATERAL (
    SELECT runs.status, runs.created_at
    FROM public.provider_sync_runs AS runs
    WHERE runs.provider = providers.provider
      AND runs.status IN ('queued', 'running')
    ORDER BY runs.created_at, runs.id
    LIMIT 1
  ) AS oldest ON true
  ORDER BY providers.provider
$$;

REVOKE ALL ON FUNCTION reconai_observe_provider_active_syncs() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    REVOKE ALL ON FUNCTION reconai_observe_provider_active_syncs() FROM reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    GRANT EXECUTE ON FUNCTION reconai_observe_provider_active_syncs() TO reconai_worker;
  END IF;
END
$$;
