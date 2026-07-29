-- Add a disabled-by-default, tenant-scoped raw-evidence retention policy and a worker-only
-- checksum-bound deletion workflow. Canonical records, provenance, source/import metadata, audit
-- events, and terminal deletion tombstones remain retained.

CREATE TABLE organization_retention_policies (
  organization_id uuid PRIMARY KEY NOT NULL,
  raw_import_retention_days integer,
  provider_event_retention_days integer,
  legal_hold_enabled boolean DEFAULT false NOT NULL,
  legal_hold_reason text,
  updated_by_membership_id uuid NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT organization_retention_policies_organization_id_organizations_id_fk
    FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT organization_retention_policies_updater_membership_fk
    FOREIGN KEY (organization_id, updated_by_membership_id)
    REFERENCES memberships(organization_id, id),
  CONSTRAINT organization_retention_policies_raw_import_days_check
    CHECK (raw_import_retention_days IS NULL OR raw_import_retention_days BETWEEN 1 AND 3650),
  CONSTRAINT organization_retention_policies_provider_event_days_check
    CHECK (
      provider_event_retention_days IS NULL
      OR provider_event_retention_days BETWEEN 1 AND 3650
    ),
  CONSTRAINT organization_retention_policies_legal_hold_reason_check
    CHECK (
      (
        legal_hold_enabled
        AND legal_hold_reason IS NOT NULL
        AND length(btrim(legal_hold_reason)) BETWEEN 3 AND 2000
      )
      OR
      (NOT legal_hold_enabled AND legal_hold_reason IS NULL)
    )
);

CREATE TABLE retention_deletion_jobs (
  id uuid NOT NULL,
  organization_id uuid NOT NULL,
  source_kind text NOT NULL,
  source_id uuid NOT NULL,
  object_key text NOT NULL,
  payload_sha256 char(64) NOT NULL,
  retention_days integer NOT NULL,
  eligible_at timestamptz NOT NULL,
  status text NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  next_attempt_at timestamptz DEFAULT now() NOT NULL,
  last_error_code text,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT retention_deletion_jobs_organization_id_id_pk
    PRIMARY KEY (organization_id, id),
  CONSTRAINT retention_deletion_jobs_organization_id_organizations_id_fk
    FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT retention_deletion_jobs_source_kind_check
    CHECK (source_kind IN ('raw_import', 'provider_event')),
  CONSTRAINT retention_deletion_jobs_object_key_check
    CHECK (
      length(object_key) BETWEEN 1 AND 1024
      AND object_key !~ '(^|/)\.\.?(/|$)'
      AND object_key !~ '//'
    ),
  CONSTRAINT retention_deletion_jobs_payload_hash_check
    CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT retention_deletion_jobs_retention_days_check
    CHECK (retention_days BETWEEN 1 AND 3650),
  CONSTRAINT retention_deletion_jobs_status_check
    CHECK (status IN ('processing', 'retry', 'deleted', 'already_missing', 'dead_lettered')),
  CONSTRAINT retention_deletion_jobs_attempts_check
    CHECK (attempts BETWEEN 0 AND 10),
  CONSTRAINT retention_deletion_jobs_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,100}$'),
  CONSTRAINT retention_deletion_jobs_terminal_state_check
    CHECK (
      (
        status IN ('deleted', 'already_missing', 'dead_lettered')
        AND completed_at IS NOT NULL
      )
      OR
      (status IN ('processing', 'retry') AND completed_at IS NULL)
    )
);

CREATE TABLE retention_deletion_tombstones (
  id uuid NOT NULL,
  organization_id uuid NOT NULL,
  job_id uuid NOT NULL,
  source_kind text NOT NULL,
  source_id uuid NOT NULL,
  object_key text NOT NULL,
  payload_sha256 char(64) NOT NULL,
  retention_days integer NOT NULL,
  eligible_at timestamptz NOT NULL,
  outcome text NOT NULL,
  deleted_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT retention_deletion_tombstones_organization_id_id_pk
    PRIMARY KEY (organization_id, id),
  CONSTRAINT retention_deletion_tombstones_organization_id_organizations_id_fk
    FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT retention_deletion_tombstones_job_fk
    FOREIGN KEY (organization_id, job_id)
    REFERENCES retention_deletion_jobs(organization_id, id),
  CONSTRAINT retention_deletion_tombstones_source_kind_check
    CHECK (source_kind IN ('raw_import', 'provider_event')),
  CONSTRAINT retention_deletion_tombstones_object_key_check
    CHECK (
      length(object_key) BETWEEN 1 AND 1024
      AND object_key !~ '(^|/)\.\.?(/|$)'
      AND object_key !~ '//'
    ),
  CONSTRAINT retention_deletion_tombstones_payload_hash_check
    CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT retention_deletion_tombstones_retention_days_check
    CHECK (retention_days BETWEEN 1 AND 3650),
  CONSTRAINT retention_deletion_tombstones_outcome_check
    CHECK (outcome IN ('deleted', 'already_missing')),
  CONSTRAINT retention_deletion_tombstones_time_check
    CHECK (deleted_at >= eligible_at)
);

CREATE UNIQUE INDEX retention_deletion_jobs_org_source_uidx
  ON retention_deletion_jobs(organization_id, source_kind, source_id);
CREATE INDEX retention_deletion_jobs_retry_idx
  ON retention_deletion_jobs(status, next_attempt_at, organization_id);
CREATE UNIQUE INDEX retention_deletion_tombstones_org_source_uidx
  ON retention_deletion_tombstones(organization_id, source_kind, source_id);
CREATE UNIQUE INDEX retention_deletion_tombstones_org_object_uidx
  ON retention_deletion_tombstones(organization_id, object_key);
CREATE INDEX retention_deletion_tombstones_org_time_idx
  ON retention_deletion_tombstones(organization_id, deleted_at);

ALTER TABLE organization_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_retention_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE retention_deletion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_deletion_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE retention_deletion_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_deletion_tombstones FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_retention_policies_tenant_policy
  ON organization_retention_policies
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

CREATE POLICY retention_deletion_jobs_tenant_select_policy
  ON retention_deletion_jobs
  FOR SELECT
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

CREATE POLICY retention_deletion_tombstones_tenant_select_policy
  ON retention_deletion_tombstones
  FOR SELECT
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

-- The function owner is the migration role. Owner-only policies let the fixed-query SECURITY
-- DEFINER functions traverse FORCE RLS without granting the worker broad table access.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_migrator') THEN
    CREATE POLICY organization_retention_policies_maintenance_owner_policy
      ON organization_retention_policies
      FOR ALL
      TO reconai_migrator
      USING (current_user = 'reconai_migrator')
      WITH CHECK (current_user = 'reconai_migrator');

    CREATE POLICY retention_deletion_jobs_maintenance_owner_policy
      ON retention_deletion_jobs
      FOR ALL
      TO reconai_migrator
      USING (current_user = 'reconai_migrator')
      WITH CHECK (current_user = 'reconai_migrator');

    CREATE POLICY retention_deletion_tombstones_maintenance_owner_policy
      ON retention_deletion_tombstones
      FOR ALL
      TO reconai_migrator
      USING (current_user = 'reconai_migrator')
      WITH CHECK (current_user = 'reconai_migrator');

    CREATE POLICY imports_retention_maintenance_owner_policy
      ON imports
      FOR SELECT
      TO reconai_migrator
      USING (current_user = 'reconai_migrator');

    CREATE POLICY source_events_retention_maintenance_owner_policy
      ON source_events
      FOR SELECT
      TO reconai_migrator
      USING (current_user = 'reconai_migrator');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION reject_retention_tombstone_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'retention deletion tombstones are append-only';
END;
$$;

CREATE TRIGGER retention_deletion_tombstones_reject_update_delete
BEFORE UPDATE OR DELETE ON retention_deletion_tombstones
FOR EACH ROW EXECUTE FUNCTION reject_retention_tombstone_mutation();

CREATE OR REPLACE FUNCTION protect_retention_deletion_job_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    OLD.id,
    OLD.organization_id,
    OLD.source_kind,
    OLD.source_id,
    OLD.object_key,
    OLD.payload_sha256,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id,
    NEW.organization_id,
    NEW.source_kind,
    NEW.source_id,
    NEW.object_key,
    NEW.payload_sha256,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'retention deletion job source evidence is immutable';
  END IF;

  IF OLD.status IN ('deleted', 'already_missing', 'dead_lettered') THEN
    RAISE EXCEPTION 'a terminal retention deletion job is immutable';
  END IF;

  IF NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1 THEN
    RAISE EXCEPTION 'retention deletion job attempt transition is invalid';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER retention_deletion_jobs_protect_evidence
BEFORE UPDATE ON retention_deletion_jobs
FOR EACH ROW EXECUTE FUNCTION protect_retention_deletion_job_evidence();

CREATE OR REPLACE FUNCTION reconai_claim_retention_candidate(p_job_id uuid)
RETURNS TABLE (
  job_id uuid,
  organization_id uuid,
  source_kind text,
  source_id uuid,
  object_key text,
  payload_sha256 text,
  retention_days integer,
  eligible_at timestamptz,
  attempt integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
#variable_conflict use_column
DECLARE
  v_organization_id uuid;
  v_candidate record;
  v_job_id uuid;
  v_attempt integer;
BEGIN
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'retention deletion job id is required';
  END IF;

  -- Locking the policy row serializes policy/legal-hold changes against the object deletion. The
  -- worker keeps this transaction open through conditional object deletion and finalization.
  SELECT policies.organization_id
  INTO v_organization_id
  FROM public.organization_retention_policies AS policies
  WHERE policies.legal_hold_enabled = false
    AND (
      (
        policies.raw_import_retention_days IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.imports AS imports
          LEFT JOIN public.retention_deletion_tombstones AS tombstones
            ON tombstones.organization_id = imports.organization_id
            AND tombstones.source_kind = 'raw_import'
            AND tombstones.source_id = imports.id
          LEFT JOIN public.retention_deletion_jobs AS jobs
            ON jobs.organization_id = imports.organization_id
            AND jobs.source_kind = 'raw_import'
            AND jobs.source_id = imports.id
          WHERE imports.organization_id = policies.organization_id
            AND imports.status IN ('succeeded', 'rolled_back')
            AND (
              CASE
                WHEN imports.status = 'rolled_back' THEN imports.rolled_back_at
                ELSE imports.completed_at
              END
            ) IS NOT NULL
            AND (
              CASE
                WHEN imports.status = 'rolled_back' THEN imports.rolled_back_at
                ELSE imports.completed_at
              END
            ) + make_interval(days => policies.raw_import_retention_days)
              <= statement_timestamp()
            AND tombstones.id IS NULL
            AND (
              jobs.id IS NULL
              OR (
                jobs.status = 'retry'
                AND jobs.next_attempt_at <= statement_timestamp()
                AND jobs.attempts < 10
              )
            )
        )
      )
      OR
      (
        policies.provider_event_retention_days IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.source_events AS events
          LEFT JOIN public.retention_deletion_tombstones AS tombstones
            ON tombstones.organization_id = events.organization_id
            AND tombstones.source_kind = 'provider_event'
            AND tombstones.source_id = events.id
          LEFT JOIN public.retention_deletion_jobs AS jobs
            ON jobs.organization_id = events.organization_id
            AND jobs.source_kind = 'provider_event'
            AND jobs.source_id = events.id
          WHERE events.organization_id = policies.organization_id
            AND events.source <> 'accounting_csv'
            AND events.status IN ('processed', 'normalized')
            AND events.received_at
              + make_interval(days => policies.provider_event_retention_days)
              <= statement_timestamp()
            AND tombstones.id IS NULL
            AND (
              jobs.id IS NULL
              OR (
                jobs.status = 'retry'
                AND jobs.next_attempt_at <= statement_timestamp()
                AND jobs.attempts < 10
              )
            )
        )
      )
    )
  ORDER BY policies.organization_id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_organization_id IS NULL THEN
    RETURN;
  END IF;

  SELECT candidates.*
  INTO v_candidate
  FROM (
    SELECT
      'raw_import'::text AS source_kind,
      imports.id AS source_id,
      imports.object_key,
      imports.payload_sha256::text AS payload_sha256,
      policies.raw_import_retention_days AS retention_days,
      (
        CASE
          WHEN imports.status = 'rolled_back' THEN imports.rolled_back_at
          ELSE imports.completed_at
        END
      ) + make_interval(days => policies.raw_import_retention_days) AS eligible_at
    FROM public.organization_retention_policies AS policies
    INNER JOIN public.imports AS imports
      ON imports.organization_id = policies.organization_id
    LEFT JOIN public.retention_deletion_tombstones AS tombstones
      ON tombstones.organization_id = imports.organization_id
      AND tombstones.source_kind = 'raw_import'
      AND tombstones.source_id = imports.id
    LEFT JOIN public.retention_deletion_jobs AS jobs
      ON jobs.organization_id = imports.organization_id
      AND jobs.source_kind = 'raw_import'
      AND jobs.source_id = imports.id
    WHERE policies.organization_id = v_organization_id
      AND policies.raw_import_retention_days IS NOT NULL
      AND imports.status IN ('succeeded', 'rolled_back')
      AND (
        CASE
          WHEN imports.status = 'rolled_back' THEN imports.rolled_back_at
          ELSE imports.completed_at
        END
      ) IS NOT NULL
      AND (
        CASE
          WHEN imports.status = 'rolled_back' THEN imports.rolled_back_at
          ELSE imports.completed_at
        END
      ) + make_interval(days => policies.raw_import_retention_days)
        <= statement_timestamp()
      AND tombstones.id IS NULL
      AND (
        jobs.id IS NULL
        OR (
          jobs.status = 'retry'
          AND jobs.next_attempt_at <= statement_timestamp()
          AND jobs.attempts < 10
        )
      )

    UNION ALL

    SELECT
      'provider_event'::text AS source_kind,
      events.id AS source_id,
      events.payload_object_key AS object_key,
      events.payload_sha256::text AS payload_sha256,
      policies.provider_event_retention_days AS retention_days,
      events.received_at
        + make_interval(days => policies.provider_event_retention_days) AS eligible_at
    FROM public.organization_retention_policies AS policies
    INNER JOIN public.source_events AS events
      ON events.organization_id = policies.organization_id
    LEFT JOIN public.retention_deletion_tombstones AS tombstones
      ON tombstones.organization_id = events.organization_id
      AND tombstones.source_kind = 'provider_event'
      AND tombstones.source_id = events.id
    LEFT JOIN public.retention_deletion_jobs AS jobs
      ON jobs.organization_id = events.organization_id
      AND jobs.source_kind = 'provider_event'
      AND jobs.source_id = events.id
    WHERE policies.organization_id = v_organization_id
      AND policies.provider_event_retention_days IS NOT NULL
      AND events.source <> 'accounting_csv'
      AND events.status IN ('processed', 'normalized')
      AND events.received_at
        + make_interval(days => policies.provider_event_retention_days)
        <= statement_timestamp()
      AND tombstones.id IS NULL
      AND (
        jobs.id IS NULL
        OR (
          jobs.status = 'retry'
          AND jobs.next_attempt_at <= statement_timestamp()
          AND jobs.attempts < 10
        )
      )
  ) AS candidates
  ORDER BY candidates.eligible_at, candidates.source_kind, candidates.source_id
  LIMIT 1;

  IF v_candidate.source_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.retention_deletion_jobs (
    id,
    organization_id,
    source_kind,
    source_id,
    object_key,
    payload_sha256,
    retention_days,
    eligible_at,
    status,
    attempts,
    next_attempt_at,
    last_error_code,
    completed_at,
    created_at,
    updated_at
  ) VALUES (
    p_job_id,
    v_organization_id,
    v_candidate.source_kind,
    v_candidate.source_id,
    v_candidate.object_key,
    v_candidate.payload_sha256,
    v_candidate.retention_days,
    v_candidate.eligible_at,
    'processing',
    1,
    statement_timestamp(),
    NULL,
    NULL,
    statement_timestamp(),
    statement_timestamp()
  )
  ON CONFLICT (organization_id, source_kind, source_id)
  DO UPDATE SET
    retention_days = EXCLUDED.retention_days,
    eligible_at = EXCLUDED.eligible_at,
    status = 'processing',
    attempts = retention_deletion_jobs.attempts + 1,
    next_attempt_at = statement_timestamp(),
    last_error_code = NULL,
    completed_at = NULL,
    updated_at = statement_timestamp()
  WHERE retention_deletion_jobs.status = 'retry'
    AND retention_deletion_jobs.next_attempt_at <= statement_timestamp()
    AND retention_deletion_jobs.attempts < 10
  RETURNING
    retention_deletion_jobs.id,
    retention_deletion_jobs.attempts
  INTO v_job_id, v_attempt;

  IF v_job_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT
      v_job_id,
      v_organization_id,
      v_candidate.source_kind::text,
      v_candidate.source_id::uuid,
      v_candidate.object_key::text,
      v_candidate.payload_sha256::text,
      v_candidate.retention_days::integer,
      v_candidate.eligible_at::timestamptz,
      v_attempt;
END;
$$;

CREATE OR REPLACE FUNCTION reconai_finalize_retention_candidate(
  p_job_id uuid,
  p_tombstone_id uuid,
  p_outcome text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_job public.retention_deletion_jobs%ROWTYPE;
  v_policy public.organization_retention_policies%ROWTYPE;
  v_source_eligible boolean;
BEGIN
  IF p_tombstone_id IS NULL OR p_outcome NOT IN ('deleted', 'already_missing') THEN
    RAISE EXCEPTION 'retention deletion finalization is invalid';
  END IF;

  SELECT jobs.*
  INTO v_job
  FROM public.retention_deletion_jobs AS jobs
  WHERE jobs.id = p_job_id
    AND jobs.status = 'processing'
  FOR UPDATE;

  IF v_job.id IS NULL THEN
    RETURN false;
  END IF;

  SELECT policies.*
  INTO v_policy
  FROM public.organization_retention_policies AS policies
  WHERE policies.organization_id = v_job.organization_id
  FOR UPDATE;

  IF v_policy.organization_id IS NULL OR v_policy.legal_hold_enabled THEN
    RAISE EXCEPTION 'retention deletion is blocked by policy or legal hold'
      USING ERRCODE = '42501';
  END IF;

  IF v_job.source_kind = 'raw_import' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.imports AS imports
      WHERE imports.organization_id = v_job.organization_id
        AND imports.id = v_job.source_id
        AND imports.object_key = v_job.object_key
        AND imports.payload_sha256 = v_job.payload_sha256
        AND imports.status IN ('succeeded', 'rolled_back')
        AND v_policy.raw_import_retention_days IS NOT NULL
        AND v_job.retention_days = v_policy.raw_import_retention_days
        AND v_job.eligible_at = (
          CASE
            WHEN imports.status = 'rolled_back' THEN imports.rolled_back_at
            ELSE imports.completed_at
          END
        ) + make_interval(days => v_policy.raw_import_retention_days)
        AND v_job.eligible_at <= statement_timestamp()
    ) INTO v_source_eligible;
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM public.source_events AS events
      WHERE events.organization_id = v_job.organization_id
        AND events.id = v_job.source_id
        AND events.source <> 'accounting_csv'
        AND events.payload_object_key = v_job.object_key
        AND events.payload_sha256 = v_job.payload_sha256
        AND events.status IN ('processed', 'normalized')
        AND v_policy.provider_event_retention_days IS NOT NULL
        AND v_job.retention_days = v_policy.provider_event_retention_days
        AND v_job.eligible_at = events.received_at
          + make_interval(days => v_policy.provider_event_retention_days)
        AND v_job.eligible_at <= statement_timestamp()
    ) INTO v_source_eligible;
  END IF;

  IF NOT coalesce(v_source_eligible, false) THEN
    RAISE EXCEPTION 'retention deletion source is no longer eligible'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.retention_deletion_tombstones (
    id,
    organization_id,
    job_id,
    source_kind,
    source_id,
    object_key,
    payload_sha256,
    retention_days,
    eligible_at,
    outcome,
    deleted_at,
    created_at
  ) VALUES (
    p_tombstone_id,
    v_job.organization_id,
    v_job.id,
    v_job.source_kind,
    v_job.source_id,
    v_job.object_key,
    v_job.payload_sha256,
    v_job.retention_days,
    v_job.eligible_at,
    p_outcome,
    statement_timestamp(),
    statement_timestamp()
  );

  UPDATE public.retention_deletion_jobs
  SET status = p_outcome,
      last_error_code = NULL,
      completed_at = statement_timestamp(),
      updated_at = statement_timestamp()
  WHERE organization_id = v_job.organization_id
    AND id = v_job.id
    AND status = 'processing';

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION reconai_fail_retention_candidate(
  p_job_id uuid,
  p_error_code text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_job public.retention_deletion_jobs%ROWTYPE;
  v_next_status text;
BEGIN
  IF p_error_code !~ '^[A-Z0-9_]{1,100}$' THEN
    RAISE EXCEPTION 'retention deletion error code is invalid';
  END IF;

  SELECT jobs.*
  INTO v_job
  FROM public.retention_deletion_jobs AS jobs
  WHERE jobs.id = p_job_id
    AND jobs.status = 'processing'
  FOR UPDATE;

  IF v_job.id IS NULL THEN
    RETURN 'not_found';
  END IF;

  v_next_status := CASE WHEN v_job.attempts >= 10 THEN 'dead_lettered' ELSE 'retry' END;

  UPDATE public.retention_deletion_jobs
  SET status = v_next_status,
      next_attempt_at = statement_timestamp()
        + make_interval(
            secs => least(
              3600,
              (60 * power(2::numeric, greatest(v_job.attempts - 1, 0)))::integer
            )
          ),
      last_error_code = p_error_code,
      completed_at = CASE
        WHEN v_next_status = 'dead_lettered' THEN statement_timestamp()
        ELSE NULL
      END,
      updated_at = statement_timestamp()
  WHERE organization_id = v_job.organization_id
    AND id = v_job.id
    AND status = 'processing';

  RETURN v_next_status;
END;
$$;

REVOKE ALL ON FUNCTION reconai_claim_retention_candidate(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconai_finalize_retention_candidate(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconai_fail_retention_candidate(uuid, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT SELECT, INSERT, UPDATE ON organization_retention_policies TO reconai_app;
    GRANT SELECT ON retention_deletion_jobs, retention_deletion_tombstones TO reconai_app;
    REVOKE DELETE, TRUNCATE ON organization_retention_policies FROM reconai_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
      retention_deletion_jobs,
      retention_deletion_tombstones
    FROM reconai_app;
    REVOKE ALL ON FUNCTION reconai_claim_retention_candidate(uuid) FROM reconai_app;
    REVOKE ALL ON FUNCTION reconai_finalize_retention_candidate(uuid, uuid, text)
      FROM reconai_app;
    REVOKE ALL ON FUNCTION reconai_fail_retention_candidate(uuid, text) FROM reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    REVOKE ALL ON
      organization_retention_policies,
      retention_deletion_jobs,
      retention_deletion_tombstones
    FROM reconai_worker;
    GRANT EXECUTE ON FUNCTION reconai_claim_retention_candidate(uuid) TO reconai_worker;
    GRANT EXECUTE ON FUNCTION reconai_finalize_retention_candidate(uuid, uuid, text)
      TO reconai_worker;
    GRANT EXECUTE ON FUNCTION reconai_fail_retention_candidate(uuid, text)
      TO reconai_worker;
  END IF;
END
$$;
