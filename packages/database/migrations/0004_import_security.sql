-- Tenant isolation and integrity constraints for the durable accounting import receipt.

ALTER TABLE imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE imports FORCE ROW LEVEL SECURITY;

CREATE POLICY imports_tenant_policy ON imports
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

ALTER TABLE imports
  ADD CONSTRAINT imports_accounting_source_check CHECK (source = 'accounting_csv'),
  ADD CONSTRAINT imports_byte_count_check CHECK (byte_count > 0 AND byte_count <= 10485760),
  ADD CONSTRAINT imports_content_type_check CHECK (content_type IN ('text/csv', 'application/csv')),
  ADD CONSTRAINT imports_filename_check CHECK (
    length(original_filename) BETWEEN 1 AND 255
    AND right(lower(original_filename), 4) = '.csv'
    AND original_filename !~ '[[:cntrl:]/\\]'
  ),
  ADD CONSTRAINT imports_hashes_check CHECK (
    payload_sha256 ~ '^[a-f0-9]{64}$'
    AND idempotency_key ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT imports_counts_check CHECK (
    row_count >= 0
    AND valid_row_count >= 0
    AND invalid_row_count >= 0
    AND valid_row_count + invalid_row_count = row_count
  ),
  ADD CONSTRAINT imports_json_shapes_check CHECK (
    jsonb_typeof(mapping) = 'object'
    AND jsonb_typeof(preview_rows) = 'array'
    AND jsonb_typeof(preview_errors) = 'array'
  ),
  ADD CONSTRAINT imports_object_key_check CHECK (
    length(object_key) BETWEEN 1 AND 1024
    AND object_key !~ '(^|/)\.\.?(/|$)'
    AND object_key !~ '//'
  );

ALTER TABLE source_events
  ADD CONSTRAINT source_events_accounting_import_check CHECK (
    (source = 'accounting_csv' AND import_id IS NOT NULL)
    OR
    (source <> 'accounting_csv' AND import_id IS NULL)
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON imports TO reconai_app;
  END IF;
END
$$;
