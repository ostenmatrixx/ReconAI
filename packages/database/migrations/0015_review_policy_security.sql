-- Validate review policy at the database boundary and preserve the decision record.

CREATE OR REPLACE FUNCTION reconai_valid_dual_approval_thresholds(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN jsonb_typeof(value) <> 'object' THEN false
    ELSE (
      SELECT
        count(*) <= 50
        AND count(*) FILTER (
          WHERE key !~ '^[A-Z]{3}$'
            OR jsonb_typeof(item) <> 'string'
            OR (item #>> '{}') !~ '^(0|[1-9][0-9]{0,30})$'
        ) = 0
      FROM jsonb_each(value) AS entries(key, item)
    )
  END;
$$;

CREATE OR REPLACE FUNCTION reconai_valid_sensitive_resolution_types(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN jsonb_typeof(value) <> 'array' THEN false
    ELSE (
      SELECT
        count(*) <= 50
        AND count(*) FILTER (
          WHERE jsonb_typeof(item) <> 'string'
            OR (item #>> '{}') !~ '^[a-z0-9_]{1,100}$'
        ) = 0
      FROM jsonb_array_elements(value) AS entries(item)
    )
  END;
$$;

ALTER TABLE organizations
  ADD CONSTRAINT organizations_dual_approval_thresholds_check
    CHECK (reconai_valid_dual_approval_thresholds(dual_approval_thresholds)),
  ADD CONSTRAINT organizations_sensitive_resolution_types_check
    CHECK (reconai_valid_sensitive_resolution_types(sensitive_resolution_types));

ALTER TABLE resolution_proposals
  ADD CONSTRAINT resolution_proposals_version_check CHECK (version > 0),
  ADD CONSTRAINT resolution_proposals_required_approvals_check
    CHECK (required_approvals BETWEEN 1 AND 2),
  ADD CONSTRAINT resolution_proposals_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'superseded'));

ALTER TABLE approvals
  ADD CONSTRAINT approvals_decision_check CHECK (decision IN ('approve', 'reject'));

CREATE OR REPLACE FUNCTION protect_resolution_proposal_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'resolution proposals are retained decision evidence';
  END IF;
  IF ROW(
    OLD.id,
    OLD.organization_id,
    OLD.exception_id,
    OLD.version,
    OLD.proposed_by,
    OLD.proposal_type,
    OLD.reason,
    OLD.evidence,
    OLD.required_approvals,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id,
    NEW.organization_id,
    NEW.exception_id,
    NEW.version,
    NEW.proposed_by,
    NEW.proposal_type,
    NEW.reason,
    NEW.evidence,
    NEW.required_approvals,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'resolution proposal evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER resolution_proposals_protect_evidence
BEFORE UPDATE OR DELETE ON resolution_proposals
FOR EACH ROW EXECUTE FUNCTION protect_resolution_proposal_evidence();

CREATE OR REPLACE FUNCTION reject_approval_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'approval decisions are append-only';
END;
$$;

CREATE TRIGGER approvals_reject_update_delete
BEFORE UPDATE OR DELETE ON approvals
FOR EACH ROW EXECUTE FUNCTION reject_approval_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    REVOKE DELETE, TRUNCATE ON resolution_proposals FROM reconai_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON approvals FROM reconai_app;
  END IF;
END
$$;
