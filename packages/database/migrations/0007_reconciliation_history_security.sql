-- Tenant-isolate run occurrences and prevent application code from rewriting observation history.

ALTER TABLE match_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_occurrences FORCE ROW LEVEL SECURITY;
ALTER TABLE exception_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE exception_occurrences FORCE ROW LEVEL SECURITY;

CREATE POLICY match_occurrences_tenant_policy ON match_occurrences
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

CREATE POLICY exception_occurrences_tenant_policy ON exception_occurrences
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

ALTER TABLE reconciliation_runs
  ADD CONSTRAINT reconciliation_stable_run_key_hex_check
    CHECK (stable_run_key ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT reconciliation_input_snapshot_hash_hex_check
    CHECK (input_snapshot_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT reconciliation_policy_snapshot_hash_hex_check
    CHECK (policy_snapshot_hash ~ '^[a-f0-9]{64}$');

ALTER TABLE matches
  ADD CONSTRAINT matches_stable_key_hex_check CHECK (stable_key ~ '^[a-f0-9]{64}$');

ALTER TABLE exceptions
  ADD CONSTRAINT exceptions_stable_key_hex_check CHECK (stable_key ~ '^[a-f0-9]{64}$');

CREATE OR REPLACE FUNCTION reject_reconciliation_occurrence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'reconciliation occurrences are append-only';
END;
$$;

CREATE TRIGGER match_occurrences_reject_update_delete
BEFORE UPDATE OR DELETE ON match_occurrences
FOR EACH ROW EXECUTE FUNCTION reject_reconciliation_occurrence_mutation();

CREATE TRIGGER exception_occurrences_reject_update_delete
BEFORE UPDATE OR DELETE ON exception_occurrences
FOR EACH ROW EXECUTE FUNCTION reject_reconciliation_occurrence_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT SELECT, INSERT ON match_occurrences, exception_occurrences TO reconai_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON match_occurrences, exception_occurrences FROM reconai_app;
  END IF;
END
$$;
