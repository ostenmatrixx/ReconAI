-- Integrity constraints for secret references and immutable provider webhook receipts.

ALTER TABLE data_source_connections
  ADD CONSTRAINT connections_credential_reference_check CHECK (
    credential_reference IS NULL
    OR credential_reference ~ '^env:RECONAI_CONNECTOR_[A-Z0-9_]{1,100}$'
  ),
  ADD CONSTRAINT connections_single_credential_storage_check CHECK (
    encrypted_credential IS NULL OR credential_reference IS NULL
  );

ALTER TABLE source_events
  ADD CONSTRAINT source_events_payload_hash_check CHECK (
    payload_sha256 ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT source_events_object_key_check CHECK (
    length(payload_object_key) BETWEEN 1 AND 1024
    AND payload_object_key !~ '(^|/)\.\.?(/|$)'
    AND payload_object_key !~ '//'
  ),
  ADD CONSTRAINT source_events_status_check CHECK (
    status IN ('received', 'processed', 'normalized', 'failed', 'privacy_pending')
  ),
  ADD CONSTRAINT source_events_error_code_check CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,100}$'
  );
