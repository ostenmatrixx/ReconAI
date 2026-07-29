-- Expand reconciliation occurrence history with immutable per-run evidence snapshots.
--
-- This is intentionally additive for rolling compatibility: an older worker may continue writing
-- the existing occurrence rows while a new worker writes both the occurrence and its snapshot.
-- Readers must label an occurrence without a snapshot as a legacy current projection. A later
-- contraction migration may require one snapshot per occurrence only after all older workers have
-- drained and the missing-snapshot query has remained empty for an approved compatibility window.

CREATE TABLE public.match_occurrence_snapshots (
  organization_id uuid NOT NULL,
  run_id uuid NOT NULL,
  match_id uuid NOT NULL,
  snapshot_version text NOT NULL,
  rule_id text NOT NULL,
  rule_version text NOT NULL,
  record_references jsonb NOT NULL,
  evidence jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_occurrence_snapshots_organization_id_run_id_match_id_pk
    PRIMARY KEY (organization_id, run_id, match_id),
  CONSTRAINT match_occurrence_snapshots_occurrence_fk
    FOREIGN KEY (organization_id, run_id, match_id)
    REFERENCES public.match_occurrences (organization_id, run_id, match_id),
  CONSTRAINT match_occurrence_snapshots_version_check
    CHECK (snapshot_version = 'artifact-occurrence-v1'),
  CONSTRAINT match_occurrence_snapshots_rule_id_check
    CHECK (rule_id ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  CONSTRAINT match_occurrence_snapshots_rule_version_check
    CHECK (rule_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  CONSTRAINT match_occurrence_snapshots_references_check
    CHECK (jsonb_typeof(record_references) = 'array'),
  CONSTRAINT match_occurrence_snapshots_evidence_check
    CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE TABLE public.exception_occurrence_snapshots (
  organization_id uuid NOT NULL,
  run_id uuid NOT NULL,
  exception_id uuid NOT NULL,
  snapshot_version text NOT NULL,
  type text NOT NULL,
  observed_status exception_status NOT NULL,
  severity text NOT NULL,
  record_references jsonb NOT NULL,
  amount_minor bigint,
  currency char(3),
  evidence jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exception_occurrence_snapshots_organization_id_run_id_exception_id_pk
    PRIMARY KEY (organization_id, run_id, exception_id),
  CONSTRAINT exception_occurrence_snapshots_occurrence_fk
    FOREIGN KEY (organization_id, run_id, exception_id)
    REFERENCES public.exception_occurrences (organization_id, run_id, exception_id),
  CONSTRAINT exception_occurrence_snapshots_version_check
    CHECK (snapshot_version = 'artifact-occurrence-v1'),
  CONSTRAINT exception_occurrence_snapshots_type_check
    CHECK (type ~ '^[a-z0-9][a-z0-9_]{0,99}$'),
  CONSTRAINT exception_occurrence_snapshots_severity_check
    CHECK (severity IN ('high', 'medium', 'low')),
  CONSTRAINT exception_occurrence_snapshots_references_check
    CHECK (jsonb_typeof(record_references) = 'array'),
  CONSTRAINT exception_occurrence_snapshots_money_check
    CHECK (
      (amount_minor IS NULL AND currency IS NULL)
      OR
      (amount_minor IS NOT NULL AND currency ~ '^[A-Z]{3}$')
    ),
  CONSTRAINT exception_occurrence_snapshots_evidence_check
    CHECK (jsonb_typeof(evidence) = 'object')
);

ALTER TABLE public.match_occurrence_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_occurrence_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE public.exception_occurrence_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exception_occurrence_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY match_occurrence_snapshots_tenant_policy
  ON public.match_occurrence_snapshots
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

CREATE POLICY exception_occurrence_snapshots_tenant_policy
  ON public.exception_occurrence_snapshots
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

CREATE TRIGGER match_occurrence_snapshots_reject_update_delete
BEFORE UPDATE OR DELETE ON public.match_occurrence_snapshots
FOR EACH ROW EXECUTE FUNCTION public.reject_reconciliation_occurrence_mutation();

CREATE TRIGGER exception_occurrence_snapshots_reject_update_delete
BEFORE UPDATE OR DELETE ON public.exception_occurrence_snapshots
FOR EACH ROW EXECUTE FUNCTION public.reject_reconciliation_occurrence_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT SELECT ON
      public.match_occurrence_snapshots,
      public.exception_occurrence_snapshots
    TO reconai_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
      public.match_occurrence_snapshots,
      public.exception_occurrence_snapshots
    FROM reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    GRANT SELECT, INSERT ON
      public.match_occurrence_snapshots,
      public.exception_occurrence_snapshots
    TO reconai_worker;
    REVOKE UPDATE, DELETE, TRUNCATE ON
      public.match_occurrence_snapshots,
      public.exception_occurrence_snapshots
    FROM reconai_worker;
  END IF;
END
$$;
