-- Preserve deterministic exception lifecycle history and prevent an older snapshot from
-- becoming the live operational authority after a newer run has already succeeded.

ALTER TABLE exception_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE exception_status_events FORCE ROW LEVEL SECURITY;

CREATE POLICY exception_status_events_tenant_policy ON exception_status_events
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

ALTER TABLE exception_status_events
  ADD CONSTRAINT exception_status_events_reason_code_check
    CHECK (reason_code ~ '^[a-z0-9_]{1,100}$'),
  ADD CONSTRAINT exception_status_events_transition_check
    CHECK (previous_status IS NULL OR previous_status IS DISTINCT FROM next_status);

ALTER TABLE reconciliation_runs
  ADD CONSTRAINT reconciliation_runs_operational_authority_status_check
    CHECK (operational_state_applied = false OR status = 'succeeded');

CREATE OR REPLACE FUNCTION reject_exception_status_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'exception status events are append-only';
END;
$$;

CREATE TRIGGER exception_status_events_reject_update_delete
BEFORE UPDATE OR DELETE ON exception_status_events
FOR EACH ROW EXECUTE FUNCTION reject_exception_status_event_mutation();

-- Existing installations had one effective live queue without an explicit run marker. Preserve
-- that state by marking the newest successful run in each organization as operational authority.
WITH newest_successful_run AS (
  SELECT organization_id, id
  FROM (
    SELECT
      organization_id,
      id,
      row_number() OVER (
        PARTITION BY organization_id
        ORDER BY created_at DESC, id DESC
      ) AS authority_rank
    FROM reconciliation_runs
    WHERE status = 'succeeded'
  ) ranked_runs
  WHERE authority_rank = 1
)
UPDATE reconciliation_runs AS runs
SET operational_state_applied = true
FROM newest_successful_run
WHERE runs.organization_id = newest_successful_run.organization_id
  AND runs.id = newest_successful_run.id;

CREATE UNIQUE INDEX reconciliation_runs_one_operational_authority_uidx
ON reconciliation_runs (organization_id)
WHERE operational_state_applied;

CREATE OR REPLACE FUNCTION protect_reconciliation_run_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
    NEW.id IS DISTINCT FROM OLD.id OR
    NEW.stable_run_key IS DISTINCT FROM OLD.stable_run_key OR
    NEW.input_snapshot_hash IS DISTINCT FROM OLD.input_snapshot_hash OR
    NEW.policy_snapshot_hash IS DISTINCT FROM OLD.policy_snapshot_hash OR
    NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot OR
    NEW.policy_version IS DISTINCT FROM OLD.policy_version OR
    NEW.rule_set_version IS DISTINCT FROM OLD.rule_set_version OR
    NEW.engine_version IS DISTINCT FROM OLD.engine_version OR
    NEW.initiated_by IS DISTINCT FROM OLD.initiated_by OR
    NEW.input_count IS DISTINCT FROM OLD.input_count OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'reconciliation run authority is immutable';
  END IF;

  IF OLD.status = 'succeeded' AND (
    NEW.status IS DISTINCT FROM OLD.status OR
    NEW.started_at IS DISTINCT FROM OLD.started_at OR
    NEW.completed_at IS DISTINCT FROM OLD.completed_at OR
    NEW.match_count IS DISTINCT FROM OLD.match_count OR
    NEW.exception_count IS DISTINCT FROM OLD.exception_count OR
    NEW.error_count IS DISTINCT FROM OLD.error_count OR
    NEW.dispatch_count IS DISTINCT FROM OLD.dispatch_count OR
    NEW.last_error_code IS DISTINCT FROM OLD.last_error_code OR
    (
      OLD.operational_state_applied = false
      AND NEW.operational_state_applied = true
    )
  ) THEN
    RAISE EXCEPTION 'a succeeded reconciliation run is terminal';
  END IF;

  IF NEW.dispatch_count < OLD.dispatch_count OR NEW.dispatch_count > OLD.dispatch_count + 1 THEN
    RAISE EXCEPTION 'reconciliation run dispatch count transition is invalid';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION reconai_requeue_reconciliation_run(
  requested_organization_id uuid,
  requested_run_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  active_organization_id uuid;
  next_dispatch_count integer;
BEGIN
  active_organization_id :=
    nullif(current_setting('app.organization_id', true), '')::uuid;
  IF active_organization_id IS NULL
    OR active_organization_id <> requested_organization_id
  THEN
    RAISE EXCEPTION 'tenant context does not authorize reconciliation replay'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.reconciliation_runs
  SET status = 'queued',
      completed_at = NULL,
      dispatch_count = dispatch_count + 1,
      operational_state_applied = false,
      last_error_code = NULL
  WHERE organization_id = requested_organization_id
    AND id = requested_run_id
    AND status IN ('failed', 'partial', 'cancelled')
    AND dispatch_count < 100
  RETURNING dispatch_count INTO next_dispatch_count;

  RETURN next_dispatch_count;
END;
$$;

REVOKE ALL ON FUNCTION reconai_requeue_reconciliation_run(uuid, uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON exception_status_events FROM reconai_app;
    GRANT SELECT ON exception_status_events TO reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    GRANT UPDATE (operational_state_applied) ON reconciliation_runs TO reconai_worker;
    REVOKE UPDATE, DELETE, TRUNCATE ON exception_status_events FROM reconai_worker;
    GRANT SELECT, INSERT ON exception_status_events TO reconai_worker;
  END IF;
END
$$;
