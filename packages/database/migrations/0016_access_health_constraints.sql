-- Keep authorization and connector health state within the application contract.

ALTER TABLE memberships
  ADD CONSTRAINT memberships_role_check
    CHECK (role IN ('owner', 'administrator', 'analyst', 'reviewer', 'auditor'));

ALTER TABLE data_source_connections
  ADD CONSTRAINT connections_status_check
    CHECK (
      status IN (
        'healthy',
        'backfilling',
        'degraded',
        'stale',
        'disconnected',
        'action_required'
      )
    );
