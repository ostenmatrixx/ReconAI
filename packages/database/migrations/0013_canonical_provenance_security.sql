-- Field-level normalization evidence is tenant-isolated and append-only.

ALTER TABLE canonical_field_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE canonical_field_provenance FORCE ROW LEVEL SECURITY;

CREATE POLICY canonical_field_provenance_tenant_policy ON canonical_field_provenance
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

ALTER TABLE canonical_field_provenance
  ADD CONSTRAINT canonical_field_provenance_version_check CHECK (record_version > 0),
  ADD CONSTRAINT canonical_field_provenance_path_check CHECK (
    field_path ~ '^[A-Za-z][A-Za-z0-9_.]{0,199}$'
  ),
  ADD CONSTRAINT canonical_field_provenance_source_reference_check CHECK (
    length(source_value_reference) BETWEEN 1 AND 500
    AND source_value_reference !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT canonical_field_provenance_normalized_scalar_check CHECK (
    jsonb_typeof(normalized_value) IN ('string', 'number', 'boolean', 'null')
  ),
  ADD CONSTRAINT canonical_field_provenance_transformation_check CHECK (
    length(transformation_rule) BETWEEN 1 AND 300
    AND length(transformation_version) BETWEEN 1 AND 100
  ),
  ADD CONSTRAINT canonical_field_provenance_warnings_check CHECK (
    jsonb_typeof(warnings) = 'array'
  );

CREATE OR REPLACE FUNCTION reject_canonical_field_provenance_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'canonical field provenance is append-only';
END;
$$;

CREATE TRIGGER canonical_field_provenance_reject_update_delete
BEFORE UPDATE OR DELETE ON canonical_field_provenance
FOR EACH ROW EXECUTE FUNCTION reject_canonical_field_provenance_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT SELECT, INSERT ON canonical_field_provenance TO reconai_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON canonical_field_provenance FROM reconai_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    GRANT SELECT, INSERT ON canonical_field_provenance TO reconai_worker;
    REVOKE UPDATE, DELETE, TRUNCATE ON canonical_field_provenance FROM reconai_worker;
  END IF;
END
$$;
