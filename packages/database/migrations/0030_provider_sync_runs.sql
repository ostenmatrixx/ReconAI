-- Add distinct read-API authority and durable, tenant-scoped provider sync runs. No connection is
-- sync-enabled by this migration: api_credential_reference remains null until explicitly
-- configured.

ALTER TABLE data_source_connections
  ADD COLUMN api_credential_reference text,
  ADD CONSTRAINT connections_api_credential_reference_check CHECK (
    api_credential_reference IS NULL
    OR api_credential_reference ~ '^env:RECONAI_CONNECTOR_[A-Z0-9_]{1,100}$'
  );

CREATE TABLE provider_sync_runs (
  id uuid NOT NULL,
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider source_system NOT NULL,
  mode text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  cursor text,
  status text NOT NULL,
  page_count integer DEFAULT 0 NOT NULL,
  item_count integer DEFAULT 0 NOT NULL,
  duplicate_count integer DEFAULT 0 NOT NULL,
  maximum_pages integer NOT NULL,
  failed_attempts integer DEFAULT 0 NOT NULL,
  idempotency_key char(64) NOT NULL,
  correlation_id uuid NOT NULL,
  requested_by_membership_id uuid NOT NULL,
  last_error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT provider_sync_runs_organization_id_id_pk
    PRIMARY KEY (organization_id, id),
  CONSTRAINT provider_sync_runs_organization_id_organizations_id_fk
    FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT provider_sync_runs_connection_fk
    FOREIGN KEY (organization_id, connection_id)
    REFERENCES data_source_connections(organization_id, id),
  CONSTRAINT provider_sync_runs_requester_membership_fk
    FOREIGN KEY (organization_id, requested_by_membership_id)
    REFERENCES memberships(organization_id, id),
  CONSTRAINT provider_sync_runs_provider_check
    CHECK (provider IN ('shopify', 'stripe')),
  CONSTRAINT provider_sync_runs_mode_check
    CHECK (mode IN ('backfill', 'gap_repair')),
  CONSTRAINT provider_sync_runs_window_check
    CHECK (
      window_end > window_start
      AND window_end - window_start <= interval '30 days'
    ),
  CONSTRAINT provider_sync_runs_cursor_check
    CHECK (cursor IS NULL OR length(cursor) BETWEEN 1 AND 1024),
  CONSTRAINT provider_sync_runs_status_check
    CHECK (status IN ('queued', 'running', 'partial', 'succeeded', 'failed')),
  CONSTRAINT provider_sync_runs_counts_check
    CHECK (
      page_count BETWEEN 0 AND maximum_pages
      AND item_count BETWEEN 0 AND 10000
      AND duplicate_count BETWEEN 0 AND item_count
      AND maximum_pages BETWEEN 1 AND 100
      AND failed_attempts BETWEEN 0 AND 6
    ),
  CONSTRAINT provider_sync_runs_idempotency_check
    CHECK (idempotency_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT provider_sync_runs_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,100}$'),
  CONSTRAINT provider_sync_runs_lifecycle_check
    CHECK (
      (
        status = 'queued'
        AND started_at IS NULL
        AND completed_at IS NULL
      )
      OR
      (
        status = 'running'
        AND started_at IS NOT NULL
        AND completed_at IS NULL
      )
      OR
      (
        status IN ('partial', 'succeeded', 'failed')
        AND started_at IS NOT NULL
        AND completed_at IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX provider_sync_runs_org_idempotency_uidx
  ON provider_sync_runs(organization_id, idempotency_key);
CREATE INDEX provider_sync_runs_org_connection_created_idx
  ON provider_sync_runs(organization_id, connection_id, created_at DESC, id DESC);

ALTER TABLE provider_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_sync_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_sync_runs_tenant_policy
  ON provider_sync_runs
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_migrator') THEN
    CREATE POLICY provider_sync_runs_maintenance_owner_policy
      ON provider_sync_runs
      FOR ALL
      TO reconai_migrator
      USING (current_user = 'reconai_migrator')
      WITH CHECK (current_user = 'reconai_migrator');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION protect_provider_sync_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    OLD.id,
    OLD.organization_id,
    OLD.connection_id,
    OLD.provider,
    OLD.mode,
    OLD.window_start,
    OLD.window_end,
    OLD.maximum_pages,
    OLD.idempotency_key,
    OLD.correlation_id,
    OLD.requested_by_membership_id,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id,
    NEW.organization_id,
    NEW.connection_id,
    NEW.provider,
    NEW.mode,
    NEW.window_start,
    NEW.window_end,
    NEW.maximum_pages,
    NEW.idempotency_key,
    NEW.correlation_id,
    NEW.requested_by_membership_id,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'provider sync authority is immutable';
  END IF;

  IF OLD.status IN ('partial', 'succeeded', 'failed') THEN
    RAISE EXCEPTION 'terminal provider sync evidence is immutable';
  END IF;

  IF NEW.page_count < OLD.page_count
    OR NEW.page_count > OLD.page_count + 1
    OR NEW.item_count < OLD.item_count
    OR NEW.duplicate_count < OLD.duplicate_count
    OR NEW.failed_attempts < OLD.failed_attempts
    OR NEW.failed_attempts > OLD.failed_attempts + 1 THEN
    RAISE EXCEPTION 'provider sync progress transition is invalid';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_sync_runs_protect_authority
BEFORE UPDATE ON provider_sync_runs
FOR EACH ROW EXECUTE FUNCTION protect_provider_sync_run();

CREATE OR REPLACE FUNCTION reject_provider_sync_run_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'provider sync runs are append-only';
END;
$$;

CREATE TRIGGER provider_sync_runs_reject_delete
BEFORE DELETE ON provider_sync_runs
FOR EACH ROW EXECUTE FUNCTION reject_provider_sync_run_delete();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT SELECT, INSERT ON provider_sync_runs TO reconai_app;
    GRANT SELECT (api_credential_reference) ON data_source_connections TO reconai_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON provider_sync_runs FROM reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    GRANT SELECT, UPDATE ON provider_sync_runs TO reconai_worker;
    GRANT SELECT (api_credential_reference) ON data_source_connections TO reconai_worker;
    REVOKE INSERT, DELETE, TRUNCATE ON provider_sync_runs FROM reconai_worker;
  END IF;
END
$$;
