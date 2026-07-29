-- Preserve immutable run authority while granting the worker only its execution surface.

ALTER TABLE reconciliation_run_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_run_inputs FORCE ROW LEVEL SECURITY;

CREATE POLICY reconciliation_run_inputs_tenant_policy ON reconciliation_run_inputs
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

-- Existing relay functions are SECURITY DEFINER but outbox_events is FORCE RLS. Give only the
-- controlled migration owner a policy for those fixed-query functions and keep row security on.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_migrator') THEN
    EXECUTE '
      CREATE POLICY outbox_events_relay_owner_policy ON outbox_events
      FOR ALL TO reconai_migrator
      USING (true)
      WITH CHECK (true)
    ';
  END IF;
END
$$;

ALTER FUNCTION reconai_pending_outbox(integer) SET row_security = on;
ALTER FUNCTION reconai_mark_outbox_published(uuid, text, timestamptz) SET row_security = on;
ALTER FUNCTION reconai_mark_outbox_failed(uuid, text, text, timestamptz, integer)
  SET row_security = on;

ALTER TABLE reconciliation_run_inputs
  ADD CONSTRAINT reconciliation_run_inputs_version_check CHECK (record_version > 0),
  ADD CONSTRAINT reconciliation_run_inputs_ordinal_check CHECK (ordinal >= 0),
  ADD CONSTRAINT reconciliation_run_inputs_hash_check
    CHECK (content_sha256 ~ '^[a-f0-9]{64}$');

ALTER TABLE reconciliation_runs
  ADD CONSTRAINT reconciliation_run_dispatch_count_check CHECK (dispatch_count > 0),
  ADD CONSTRAINT reconciliation_run_error_count_upper_bound_check
    CHECK (error_count BETWEEN 0 AND 100),
  ADD CONSTRAINT reconciliation_run_last_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,100}$'),
  ADD CONSTRAINT reconciliation_run_policy_snapshot_object_check
    CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  ADD CONSTRAINT reconciliation_run_terminal_time_check CHECK (
    (status IN ('succeeded', 'failed', 'partial', 'cancelled') AND completed_at IS NOT NULL)
    OR
    (status IN ('queued', 'running') AND completed_at IS NULL)
  );

CREATE OR REPLACE FUNCTION reject_reconciliation_run_input_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'reconciliation run inputs are append-only';
END;
$$;

CREATE TRIGGER reconciliation_run_inputs_reject_update_delete
BEFORE UPDATE OR DELETE ON reconciliation_run_inputs
FOR EACH ROW EXECUTE FUNCTION reject_reconciliation_run_input_mutation();

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

  IF OLD.status = 'succeeded' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a succeeded reconciliation run is terminal';
  END IF;

  IF NEW.dispatch_count < OLD.dispatch_count OR NEW.dispatch_count > OLD.dispatch_count + 1 THEN
    RAISE EXCEPTION 'reconciliation run dispatch count transition is invalid';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER reconciliation_runs_protect_authority
BEFORE UPDATE ON reconciliation_runs
FOR EACH ROW EXECUTE FUNCTION protect_reconciliation_run_authority();

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
    REVOKE UPDATE, DELETE, TRUNCATE ON reconciliation_runs FROM reconai_app;
    GRANT SELECT, INSERT ON reconciliation_runs, reconciliation_run_inputs TO reconai_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON reconciliation_run_inputs FROM reconai_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
      matches,
      match_occurrences,
      exception_occurrences
    FROM reconai_app;
    REVOKE INSERT, DELETE, TRUNCATE ON exceptions FROM reconai_app;
    GRANT SELECT ON matches, match_occurrences, exception_occurrences TO reconai_app;
    GRANT EXECUTE ON FUNCTION reconai_requeue_reconciliation_run(uuid, uuid) TO reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    REVOKE ALL ON FUNCTION reconai_requeue_reconciliation_run(uuid, uuid)
      FROM reconai_worker;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON reconciliation_runs FROM reconai_worker;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON reconciliation_run_inputs FROM reconai_worker;
    REVOKE INSERT, DELETE, TRUNCATE ON resolution_proposals FROM reconai_worker;

    GRANT SELECT ON reconciliation_runs, reconciliation_run_inputs, canonical_records
      TO reconai_worker;
    GRANT UPDATE (
      status,
      started_at,
      completed_at,
      match_count,
      exception_count,
      error_count,
      last_error_code
    ) ON reconciliation_runs TO reconai_worker;
    GRANT SELECT, INSERT ON matches, match_occurrences, exception_occurrences, audit_events
      TO reconai_worker;
    GRANT SELECT, INSERT, UPDATE ON exceptions TO reconai_worker;
    GRANT SELECT, UPDATE ON resolution_proposals TO reconai_worker;
    REVOKE DELETE, TRUNCATE ON
      reconciliation_runs,
      reconciliation_run_inputs,
      matches,
      match_occurrences,
      exceptions,
      exception_occurrences,
      resolution_proposals,
      audit_events
    FROM reconai_worker;
    REVOKE UPDATE ON
      reconciliation_run_inputs,
      canonical_records,
      matches,
      match_occurrences,
      exception_occurrences,
      audit_events
    FROM reconai_worker;
  END IF;
END
$$;
