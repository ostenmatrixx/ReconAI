CREATE TABLE "provider_privacy_request_deadline_alerts" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_privacy_request_deadline_alerts_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "provider_privacy_request_deadline_alerts" ADD CONSTRAINT "provider_privacy_request_deadline_alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_privacy_request_deadline_alerts" ADD CONSTRAINT "provider_privacy_request_deadline_alerts_request_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."provider_privacy_requests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_privacy_request_deadline_alerts_request_stage_uidx" ON "provider_privacy_request_deadline_alerts" USING btree ("organization_id","request_id","stage");--> statement-breakpoint
CREATE INDEX "provider_privacy_request_deadline_alerts_org_due_idx" ON "provider_privacy_request_deadline_alerts" USING btree ("organization_id","due_at","observed_at");

ALTER TABLE provider_privacy_request_deadline_alerts
  ADD CONSTRAINT provider_privacy_request_deadline_alerts_stage_check CHECK (
    stage IN ('due_7_days', 'due_24_hours', 'overdue')
  ),
  ADD CONSTRAINT provider_privacy_request_deadline_alerts_threshold_check CHECK (
    (
      stage = 'due_7_days'
      AND observed_at >= due_at - interval '7 days'
      AND observed_at < due_at - interval '24 hours'
    )
    OR
    (
      stage = 'due_24_hours'
      AND observed_at >= due_at - interval '24 hours'
      AND observed_at < due_at
    )
    OR
    (
      stage = 'overdue'
      AND observed_at >= due_at
    )
  ),
  ADD CONSTRAINT provider_privacy_request_deadline_alerts_created_check CHECK (
    created_at = observed_at
  );

ALTER TABLE provider_privacy_request_deadline_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_privacy_request_deadline_alerts FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_privacy_request_deadline_alerts_tenant_select_policy
  ON provider_privacy_request_deadline_alerts
  FOR SELECT
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_migrator') THEN
    CREATE POLICY provider_privacy_request_deadline_alerts_migrator_policy
      ON provider_privacy_request_deadline_alerts
      FOR ALL
      TO reconai_migrator
      USING (current_user = 'reconai_migrator')
      WITH CHECK (current_user = 'reconai_migrator');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.reject_provider_privacy_request_deadline_alert_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'provider privacy request deadline alerts are append-only';
END;
$$;

CREATE TRIGGER provider_privacy_request_deadline_alerts_reject_update_delete
BEFORE UPDATE OR DELETE ON provider_privacy_request_deadline_alerts
FOR EACH ROW EXECUTE FUNCTION public.reject_provider_privacy_request_deadline_alert_mutation();

-- Worker candidate discovery is cross-tenant but fixed and minimized. The function returns only
-- internal tenant/request identifiers, a deadline snapshot, and the computed escalation stage.
CREATE OR REPLACE FUNCTION public.reconai_due_provider_privacy_deadline_alerts(
  p_observed_at timestamptz,
  p_requested_limit integer
)
RETURNS TABLE (
  organization_id uuid,
  request_id uuid,
  stage text,
  due_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  WITH candidates AS (
    SELECT
      requests.organization_id,
      requests.id AS request_id,
      CASE
        WHEN p_observed_at >= requests.due_at THEN 'overdue'
        WHEN p_observed_at >= requests.due_at - interval '24 hours' THEN 'due_24_hours'
        ELSE 'due_7_days'
      END AS stage,
      requests.due_at
    FROM public.provider_privacy_requests AS requests
    WHERE p_observed_at IS NOT NULL
      AND p_observed_at BETWEEN
        statement_timestamp() - interval '5 minutes'
        AND statement_timestamp() + interval '5 minutes'
      AND p_requested_limit BETWEEN 1 AND 500
      AND requests.status = 'action_required'
      AND requests.due_at <= p_observed_at + interval '7 days'
  )
  SELECT
    candidates.organization_id,
    candidates.request_id,
    candidates.stage,
    candidates.due_at
  FROM candidates
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.provider_privacy_request_deadline_alerts AS alerts
    WHERE alerts.organization_id = candidates.organization_id
      AND alerts.request_id = candidates.request_id
      AND alerts.stage = candidates.stage
  )
  ORDER BY candidates.due_at, candidates.organization_id, candidates.request_id
  LIMIT p_requested_limit
$$;

-- The worker sets an exact tenant context before using this narrow creation function. The function
-- recomputes the threshold against immutable request evidence, serializes concurrent monitors, and
-- relies on the unique request/stage key for replay idempotency.
CREATE OR REPLACE FUNCTION public.reconai_create_provider_privacy_deadline_alert(
  p_organization_id uuid,
  p_request_id uuid,
  p_alert_id uuid,
  p_stage text,
  p_due_at timestamptz,
  p_observed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_active_organization_id uuid;
  v_inserted boolean;
BEGIN
  v_active_organization_id :=
    nullif(current_setting('app.organization_id', true), '')::uuid;
  IF v_active_organization_id IS NULL
    OR v_active_organization_id <> p_organization_id
  THEN
    RAISE EXCEPTION 'tenant context does not authorize privacy deadline escalation'
      USING ERRCODE = '42501';
  END IF;

  IF p_organization_id IS NULL
    OR p_request_id IS NULL
    OR p_alert_id IS NULL
    OR p_stage NOT IN ('due_7_days', 'due_24_hours', 'overdue')
    OR p_due_at IS NULL
    OR p_observed_at IS NULL
    OR p_observed_at NOT BETWEEN
      statement_timestamp() - interval '5 minutes'
      AND statement_timestamp() + interval '5 minutes'
  THEN
    RAISE EXCEPTION 'privacy deadline escalation authority is invalid';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_organization_id::text || ':' || p_request_id::text, 4)
  );

  INSERT INTO public.provider_privacy_request_deadline_alerts (
    id,
    organization_id,
    request_id,
    stage,
    due_at,
    observed_at,
    created_at
  )
  SELECT
    p_alert_id,
    requests.organization_id,
    requests.id,
    p_stage,
    requests.due_at,
    p_observed_at,
    p_observed_at
  FROM public.provider_privacy_requests AS requests
  WHERE requests.organization_id = p_organization_id
    AND requests.id = p_request_id
    AND requests.status = 'action_required'
    AND requests.due_at = p_due_at
    AND (
      (
        p_stage = 'due_7_days'
        AND p_observed_at >= requests.due_at - interval '7 days'
        AND p_observed_at < requests.due_at - interval '24 hours'
      )
      OR
      (
        p_stage = 'due_24_hours'
        AND p_observed_at >= requests.due_at - interval '24 hours'
        AND p_observed_at < requests.due_at
      )
      OR
      (
        p_stage = 'overdue'
        AND p_observed_at >= requests.due_at
      )
    )
  ON CONFLICT (organization_id, request_id, stage) DO NOTHING
  RETURNING true INTO v_inserted;

  RETURN coalesce(v_inserted, false);
END;
$$;

REVOKE ALL ON FUNCTION public.reconai_due_provider_privacy_deadline_alerts(
  timestamptz,
  integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconai_create_provider_privacy_deadline_alert(
  uuid,
  uuid,
  uuid,
  text,
  timestamptz,
  timestamptz
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT SELECT ON provider_privacy_request_deadline_alerts TO reconai_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE
      ON provider_privacy_request_deadline_alerts
      FROM reconai_app;
    REVOKE ALL ON FUNCTION public.reconai_due_provider_privacy_deadline_alerts(
      timestamptz,
      integer
    ) FROM reconai_app;
    REVOKE ALL ON FUNCTION public.reconai_create_provider_privacy_deadline_alert(
      uuid,
      uuid,
      uuid,
      text,
      timestamptz,
      timestamptz
    ) FROM reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    REVOKE ALL ON provider_privacy_request_deadline_alerts FROM reconai_worker;
    GRANT EXECUTE ON FUNCTION public.reconai_due_provider_privacy_deadline_alerts(
      timestamptz,
      integer
    ) TO reconai_worker;
    GRANT EXECUTE ON FUNCTION public.reconai_create_provider_privacy_deadline_alert(
      uuid,
      uuid,
      uuid,
      text,
      timestamptz,
      timestamptz
    ) TO reconai_worker;
  END IF;
END
$$;
