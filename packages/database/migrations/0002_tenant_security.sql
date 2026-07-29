-- Defense-in-depth tenant isolation and append-only audit restrictions.
-- This follows the generated schema migration and must execute as a migration owner.

DO $$
DECLARE
  table_name text;
  tenant_tables text[] := ARRAY[
    'organizations',
    'memberships',
    'data_source_connections',
    'source_events',
    'canonical_records',
    'reconciliation_runs',
    'matches',
    'exceptions',
    'resolution_proposals',
    'approvals',
    'audit_events',
    'outbox_events'
  ];
BEGIN
  FOREACH table_name IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY users_membership_tenant_select_policy ON users
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM memberships
      WHERE memberships.user_id = users.id
        AND memberships.organization_id =
          nullif(current_setting('app.organization_id', true), '')::uuid
    )
  );

CREATE POLICY organizations_tenant_policy ON organizations
  FOR ALL
  USING (id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.organization_id', true), '')::uuid);

DO $$
DECLARE
  table_name text;
  tenant_tables text[] := ARRAY[
    'memberships',
    'data_source_connections',
    'source_events',
    'canonical_records',
    'reconciliation_runs',
    'matches',
    'exceptions',
    'resolution_proposals',
    'approvals',
    'audit_events',
    'outbox_events'
  ];
BEGIN
  FOREACH table_name IN ARRAY tenant_tables LOOP
    EXECUTE format(
      'CREATE POLICY %I_tenant_policy ON %I FOR ALL USING (
        organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid
      ) WITH CHECK (
        organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid
      )',
      table_name,
      table_name
    );
  END LOOP;
END
$$;

ALTER TABLE canonical_records
  ADD CONSTRAINT canonical_currency_iso_check CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT canonical_record_version_check CHECK (version > 0);

ALTER TABLE exceptions
  ADD CONSTRAINT exceptions_money_pair_check CHECK (
    (amount_minor IS NULL AND currency IS NULL)
    OR
    (amount_minor IS NOT NULL AND currency ~ '^[A-Z]{3}$')
  );

ALTER TABLE reconciliation_runs
  ADD CONSTRAINT reconciliation_counts_nonnegative_check CHECK (
    input_count >= 0 AND match_count >= 0 AND exception_count >= 0 AND error_count >= 0
  );

CREATE OR REPLACE FUNCTION reject_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only';
END;
$$;

CREATE TRIGGER audit_events_reject_update_delete
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      organizations,
      memberships,
      data_source_connections,
      source_events,
      canonical_records,
      reconciliation_runs,
      matches,
      exceptions,
      resolution_proposals,
      approvals,
      outbox_events
    TO reconai_app;

    GRANT SELECT, INSERT ON audit_events TO reconai_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM reconai_app;
    GRANT SELECT ON users TO reconai_app;
  END IF;
END
$$;
