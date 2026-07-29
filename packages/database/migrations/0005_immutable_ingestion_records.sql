-- Prevent an application compromise from rewriting source evidence or canonical interpretations.
-- Retention deletion remains a separate maintenance-role operation.

CREATE OR REPLACE FUNCTION protect_source_event_immutable_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    OLD.id, OLD.organization_id, OLD.connection_id, OLD.import_id, OLD.source,
    OLD.external_event_id, OLD.external_object_type, OLD.external_object_id,
    OLD.source_timestamp, OLD.received_at, OLD.connector_version, OLD.api_version,
    OLD.payload_object_key, OLD.payload_sha256, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id, NEW.organization_id, NEW.connection_id, NEW.import_id, NEW.source,
    NEW.external_event_id, NEW.external_object_type, NEW.external_object_id,
    NEW.source_timestamp, NEW.received_at, NEW.connector_version, NEW.api_version,
    NEW.payload_object_key, NEW.payload_sha256, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'source event evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER source_events_protect_immutable_fields
BEFORE UPDATE ON source_events
FOR EACH ROW EXECUTE FUNCTION protect_source_event_immutable_fields();

CREATE OR REPLACE FUNCTION protect_import_immutable_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    OLD.id, OLD.organization_id, OLD.connection_id, OLD.source, OLD.object_key,
    OLD.payload_sha256, OLD.byte_count, OLD.content_type, OLD.original_filename,
    OLD.template_version, OLD.mapping_version, OLD.mapping, OLD.idempotency_key,
    OLD.row_count, OLD.valid_row_count, OLD.invalid_row_count, OLD.preview_rows,
    OLD.preview_errors, OLD.errors_truncated, OLD.uploaded_by, OLD.uploaded_at, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id, NEW.organization_id, NEW.connection_id, NEW.source, NEW.object_key,
    NEW.payload_sha256, NEW.byte_count, NEW.content_type, NEW.original_filename,
    NEW.template_version, NEW.mapping_version, NEW.mapping, NEW.idempotency_key,
    NEW.row_count, NEW.valid_row_count, NEW.invalid_row_count, NEW.preview_rows,
    NEW.preview_errors, NEW.errors_truncated, NEW.uploaded_by, NEW.uploaded_at, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'import evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER imports_protect_immutable_fields
BEFORE UPDATE ON imports
FOR EACH ROW EXECUTE FUNCTION protect_import_immutable_fields();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    REVOKE DELETE, TRUNCATE ON source_events, imports FROM reconai_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON canonical_records FROM reconai_app;
    GRANT SELECT, INSERT, UPDATE ON source_events, imports TO reconai_app;
    GRANT SELECT, INSERT ON canonical_records TO reconai_app;
  END IF;
END
$$;
