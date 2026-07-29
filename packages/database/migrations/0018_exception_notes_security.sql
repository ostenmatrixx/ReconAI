-- Tenant-isolate internal notes and retain them as append-only investigation evidence.

ALTER TABLE exception_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE exception_notes FORCE ROW LEVEL SECURITY;

CREATE POLICY exception_notes_tenant_policy ON exception_notes
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

ALTER TABLE exception_notes
  ADD CONSTRAINT exception_notes_body_length_check
    CHECK (char_length(body) BETWEEN 3 AND 4000);

CREATE OR REPLACE FUNCTION reject_exception_note_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'exception notes are append-only';
END;
$$;

CREATE TRIGGER exception_notes_reject_update_delete
BEFORE UPDATE OR DELETE ON exception_notes
FOR EACH ROW EXECUTE FUNCTION reject_exception_note_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT SELECT, INSERT ON exception_notes TO reconai_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON exception_notes FROM reconai_app;
  END IF;
END
$$;
