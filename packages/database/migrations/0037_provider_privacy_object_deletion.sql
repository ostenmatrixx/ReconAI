CREATE TABLE "provider_privacy_object_deletion_jobs" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"payload_sha256" char(64) NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_privacy_object_deletion_jobs_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "provider_privacy_object_deletion_tombstones" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"payload_sha256" char(64) NOT NULL,
	"outcome" text NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_privacy_object_deletion_tombstones_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "provider_privacy_object_deletion_jobs" ADD CONSTRAINT "provider_privacy_object_deletion_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_privacy_object_deletion_jobs" ADD CONSTRAINT "provider_privacy_object_deletion_jobs_request_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."provider_privacy_requests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_privacy_object_deletion_jobs" ADD CONSTRAINT "provider_privacy_object_deletion_jobs_source_fk" FOREIGN KEY ("organization_id","source_event_id") REFERENCES "public"."source_events"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_privacy_object_deletion_tombstones" ADD CONSTRAINT "provider_privacy_object_deletion_tombstones_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_privacy_object_deletion_tombstones" ADD CONSTRAINT "provider_privacy_object_deletion_tombstones_job_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."provider_privacy_object_deletion_jobs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_privacy_object_deletion_tombstones" ADD CONSTRAINT "provider_privacy_object_deletion_tombstones_request_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."provider_privacy_requests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_privacy_object_deletion_tombstones" ADD CONSTRAINT "provider_privacy_object_deletion_tombstones_source_fk" FOREIGN KEY ("organization_id","source_event_id") REFERENCES "public"."source_events"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_privacy_object_deletion_jobs_request_source_uidx" ON "provider_privacy_object_deletion_jobs" USING btree ("organization_id","request_id","source_event_id");--> statement-breakpoint
CREATE INDEX "provider_privacy_object_deletion_jobs_retry_idx" ON "provider_privacy_object_deletion_jobs" USING btree ("status","next_attempt_at","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_privacy_object_deletion_tombstones_job_uidx" ON "provider_privacy_object_deletion_tombstones" USING btree ("organization_id","job_id");--> statement-breakpoint
CREATE INDEX "provider_privacy_object_deletion_tombstones_request_idx" ON "provider_privacy_object_deletion_tombstones" USING btree ("organization_id","request_id","deleted_at");

ALTER TABLE provider_privacy_object_deletion_jobs
  ADD CONSTRAINT provider_privacy_object_deletion_jobs_object_key_check CHECK (
    length(object_key) BETWEEN 1 AND 1024
    AND object_key !~ '(^|/)\.\.?(/|$)'
    AND object_key !~ '//'
  ),
  ADD CONSTRAINT provider_privacy_object_deletion_jobs_payload_check CHECK (
    payload_sha256 ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT provider_privacy_object_deletion_jobs_status_check CHECK (
    status IN ('pending', 'processing', 'retry', 'deleted', 'already_missing', 'dead_lettered')
  ),
  ADD CONSTRAINT provider_privacy_object_deletion_jobs_attempts_check CHECK (
    attempts BETWEEN 0 AND 10
  ),
  ADD CONSTRAINT provider_privacy_object_deletion_jobs_error_check CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,100}$'
  ),
  ADD CONSTRAINT provider_privacy_object_deletion_jobs_terminal_check CHECK (
    (
      status IN ('deleted', 'already_missing', 'dead_lettered')
      AND completed_at IS NOT NULL
    )
    OR
    (
      status IN ('pending', 'processing', 'retry')
      AND completed_at IS NULL
    )
  );

ALTER TABLE provider_privacy_object_deletion_tombstones
  ADD CONSTRAINT provider_privacy_object_deletion_tombstones_object_key_check CHECK (
    length(object_key) BETWEEN 1 AND 1024
    AND object_key !~ '(^|/)\.\.?(/|$)'
    AND object_key !~ '//'
  ),
  ADD CONSTRAINT provider_privacy_object_deletion_tombstones_payload_check CHECK (
    payload_sha256 ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT provider_privacy_object_deletion_tombstones_outcome_check CHECK (
    outcome IN ('deleted', 'already_missing')
  );

ALTER TABLE provider_privacy_object_deletion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_privacy_object_deletion_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_privacy_object_deletion_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_privacy_object_deletion_tombstones FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_privacy_object_deletion_jobs_tenant_select_policy
  ON provider_privacy_object_deletion_jobs
  FOR SELECT
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

CREATE POLICY provider_privacy_object_deletion_jobs_tenant_insert_policy
  ON provider_privacy_object_deletion_jobs
  FOR INSERT
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

CREATE POLICY provider_privacy_object_deletion_tombstones_tenant_select_policy
  ON provider_privacy_object_deletion_tombstones
  FOR SELECT
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_migrator') THEN
    CREATE POLICY provider_privacy_object_deletion_jobs_migrator_policy
      ON provider_privacy_object_deletion_jobs
      FOR ALL
      TO reconai_migrator
      USING (current_user = 'reconai_migrator')
      WITH CHECK (current_user = 'reconai_migrator');

    CREATE POLICY provider_privacy_object_deletion_tombstones_migrator_policy
      ON provider_privacy_object_deletion_tombstones
      FOR ALL
      TO reconai_migrator
      USING (current_user = 'reconai_migrator')
      WITH CHECK (current_user = 'reconai_migrator');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.validate_provider_privacy_object_deletion_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM provider_privacy_requests AS requests
    INNER JOIN source_events AS events
      ON events.organization_id = requests.organization_id
     AND events.connection_id = requests.connection_id
     AND events.source = 'shopify'
    WHERE requests.organization_id = NEW.organization_id
      AND requests.id = NEW.request_id
      AND requests.topic IN ('customers/redact', 'shop/redact')
      AND events.id = NEW.source_event_id
      AND events.payload_object_key = NEW.object_key
      AND events.payload_sha256 = NEW.payload_sha256
      AND (
        requests.topic = 'shop/redact'
        OR requests.external_object_ids ? events.external_object_id
        OR EXISTS (
          SELECT 1
          FROM canonical_records AS records
          WHERE records.organization_id = events.organization_id
            AND records.source_event_id = events.id
            AND (
              requests.external_object_ids ? records.external_object_id
              OR (
                records.order_reference IS NOT NULL
                AND requests.external_object_ids ? records.order_reference
              )
            )
        )
      )
  ) THEN
    RAISE EXCEPTION 'provider privacy object deletion authority is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_privacy_object_deletion_jobs_validate_insert
BEFORE INSERT ON provider_privacy_object_deletion_jobs
FOR EACH ROW EXECUTE FUNCTION public.validate_provider_privacy_object_deletion_insert();

CREATE OR REPLACE FUNCTION public.protect_provider_privacy_object_deletion_job()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    OLD.id,
    OLD.organization_id,
    OLD.request_id,
    OLD.source_event_id,
    OLD.object_key,
    OLD.payload_sha256,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id,
    NEW.organization_id,
    NEW.request_id,
    NEW.source_event_id,
    NEW.object_key,
    NEW.payload_sha256,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'provider privacy deletion source evidence is immutable';
  END IF;

  IF OLD.status IN ('deleted', 'already_missing', 'dead_lettered') THEN
    RAISE EXCEPTION 'a terminal provider privacy deletion job is immutable';
  END IF;

  IF NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1 THEN
    RAISE EXCEPTION 'provider privacy deletion attempt transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_privacy_object_deletion_jobs_protect_evidence
BEFORE UPDATE ON provider_privacy_object_deletion_jobs
FOR EACH ROW EXECUTE FUNCTION public.protect_provider_privacy_object_deletion_job();

CREATE OR REPLACE FUNCTION public.reject_provider_privacy_object_deletion_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'provider privacy deletion evidence is append-only';
END;
$$;

CREATE TRIGGER provider_privacy_object_deletion_jobs_reject_delete
BEFORE DELETE ON provider_privacy_object_deletion_jobs
FOR EACH ROW EXECUTE FUNCTION public.reject_provider_privacy_object_deletion_mutation();

CREATE TRIGGER provider_privacy_object_deletion_tombstones_reject_update_delete
BEFORE UPDATE OR DELETE ON provider_privacy_object_deletion_tombstones
FOR EACH ROW EXECUTE FUNCTION public.reject_provider_privacy_object_deletion_mutation();

-- The same advisory lock protects a legal-hold change and an in-flight privacy object deletion,
-- including an organization that did not yet have a retention-policy row.
CREATE OR REPLACE FUNCTION public.serialize_privacy_deletion_with_legal_hold()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_organization_id uuid;
BEGIN
  v_organization_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_organization_id::text, 3));
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER organization_retention_policies_serialize_privacy_deletion
BEFORE INSERT OR UPDATE OR DELETE ON organization_retention_policies
FOR EACH ROW EXECUTE FUNCTION public.serialize_privacy_deletion_with_legal_hold();

CREATE OR REPLACE FUNCTION public.reconai_claim_provider_privacy_object_deletion(
  p_job_id uuid
)
RETURNS TABLE (
  job_id uuid,
  organization_id uuid,
  request_id uuid,
  source_event_id uuid,
  object_key text,
  payload_sha256 text,
  attempt integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
#variable_conflict use_column
DECLARE
  v_job public.provider_privacy_object_deletion_jobs%ROWTYPE;
  v_attempt integer;
BEGIN
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'provider privacy deletion claim id is required';
  END IF;

  SELECT jobs.*
  INTO v_job
  FROM public.provider_privacy_object_deletion_jobs AS jobs
  INNER JOIN public.provider_privacy_requests AS requests
    ON requests.organization_id = jobs.organization_id
   AND requests.id = jobs.request_id
  LEFT JOIN public.organization_retention_policies AS policies
    ON policies.organization_id = jobs.organization_id
  WHERE jobs.status IN ('pending', 'retry')
    AND jobs.next_attempt_at <= statement_timestamp()
    AND jobs.attempts < 10
    AND requests.topic IN ('customers/redact', 'shop/redact')
    AND coalesce(policies.legal_hold_enabled, false) = false
  ORDER BY requests.due_at, jobs.created_at, jobs.id
  FOR UPDATE OF jobs SKIP LOCKED
  LIMIT 1;

  IF v_job.id IS NULL THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_job.organization_id::text, 3));
  IF EXISTS (
    SELECT 1
    FROM public.organization_retention_policies AS policies
    WHERE policies.organization_id = v_job.organization_id
      AND policies.legal_hold_enabled
  ) THEN
    RETURN;
  END IF;

  UPDATE public.provider_privacy_object_deletion_jobs AS jobs
  SET status = 'processing',
      attempts = jobs.attempts + 1,
      next_attempt_at = statement_timestamp(),
      last_error_code = NULL,
      updated_at = statement_timestamp()
  WHERE jobs.organization_id = v_job.organization_id
    AND jobs.id = v_job.id
    AND jobs.status IN ('pending', 'retry')
  RETURNING jobs.id, jobs.attempts
  INTO v_job.id, v_attempt;

  IF v_job.id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT
    v_job.id,
    v_job.organization_id,
    v_job.request_id,
    v_job.source_event_id,
    v_job.object_key,
    v_job.payload_sha256::text,
    v_attempt;
END;
$$;

CREATE OR REPLACE FUNCTION public.reconai_finalize_provider_privacy_object_deletion(
  p_organization_id uuid,
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
  v_job public.provider_privacy_object_deletion_jobs%ROWTYPE;
BEGIN
  IF p_tombstone_id IS NULL OR p_outcome NOT IN ('deleted', 'already_missing') THEN
    RAISE EXCEPTION 'provider privacy deletion finalization is invalid';
  END IF;

  SELECT jobs.*
  INTO v_job
  FROM public.provider_privacy_object_deletion_jobs AS jobs
  WHERE jobs.organization_id = p_organization_id
    AND jobs.id = p_job_id
    AND jobs.status = 'processing'
  FOR UPDATE;

  IF v_job.id IS NULL THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.organization_retention_policies AS policies
    WHERE policies.organization_id = v_job.organization_id
      AND policies.legal_hold_enabled
  ) THEN
    RAISE EXCEPTION 'provider privacy deletion is blocked by legal hold'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.provider_privacy_requests AS requests
    INNER JOIN public.source_events AS events
      ON events.organization_id = requests.organization_id
     AND events.connection_id = requests.connection_id
     AND events.source = 'shopify'
    WHERE requests.organization_id = v_job.organization_id
      AND requests.id = v_job.request_id
      AND requests.topic IN ('customers/redact', 'shop/redact')
      AND events.id = v_job.source_event_id
      AND events.payload_object_key = v_job.object_key
      AND events.payload_sha256 = v_job.payload_sha256
  ) THEN
    RAISE EXCEPTION 'provider privacy deletion source is no longer eligible'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.provider_privacy_object_deletion_tombstones (
    id,
    organization_id,
    job_id,
    request_id,
    source_event_id,
    object_key,
    payload_sha256,
    outcome,
    deleted_at,
    created_at
  ) VALUES (
    p_tombstone_id,
    v_job.organization_id,
    v_job.id,
    v_job.request_id,
    v_job.source_event_id,
    v_job.object_key,
    v_job.payload_sha256,
    p_outcome,
    statement_timestamp(),
    statement_timestamp()
  );

  UPDATE public.provider_privacy_object_deletion_jobs
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

CREATE OR REPLACE FUNCTION public.reconai_fail_provider_privacy_object_deletion(
  p_organization_id uuid,
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
  v_job public.provider_privacy_object_deletion_jobs%ROWTYPE;
  v_next_status text;
BEGIN
  IF p_error_code !~ '^[A-Z0-9_]{1,100}$' THEN
    RAISE EXCEPTION 'provider privacy deletion error code is invalid';
  END IF;

  SELECT jobs.*
  INTO v_job
  FROM public.provider_privacy_object_deletion_jobs AS jobs
  WHERE jobs.organization_id = p_organization_id
    AND jobs.id = p_job_id
    AND jobs.status = 'processing'
  FOR UPDATE;

  IF v_job.id IS NULL THEN
    RETURN 'not_found';
  END IF;

  v_next_status := CASE WHEN v_job.attempts >= 10 THEN 'dead_lettered' ELSE 'retry' END;

  UPDATE public.provider_privacy_object_deletion_jobs
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

REVOKE ALL ON FUNCTION public.reconai_claim_provider_privacy_object_deletion(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconai_finalize_provider_privacy_object_deletion(
  uuid,
  uuid,
  uuid,
  text
)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconai_fail_provider_privacy_object_deletion(uuid, uuid, text)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT SELECT, INSERT ON provider_privacy_object_deletion_jobs TO reconai_app;
    GRANT SELECT ON provider_privacy_object_deletion_tombstones TO reconai_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON
      provider_privacy_object_deletion_jobs,
      provider_privacy_object_deletion_tombstones
    FROM reconai_app;
    REVOKE ALL ON FUNCTION public.reconai_claim_provider_privacy_object_deletion(uuid)
      FROM reconai_app;
    REVOKE ALL ON FUNCTION public.reconai_finalize_provider_privacy_object_deletion(
      uuid,
      uuid,
      uuid,
      text
    ) FROM reconai_app;
    REVOKE ALL ON FUNCTION public.reconai_fail_provider_privacy_object_deletion(
      uuid,
      uuid,
      text
    )
      FROM reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    REVOKE ALL ON
      provider_privacy_requests,
      provider_privacy_object_deletion_jobs,
      provider_privacy_object_deletion_tombstones
    FROM reconai_worker;
    GRANT EXECUTE ON FUNCTION public.reconai_claim_provider_privacy_object_deletion(uuid)
      TO reconai_worker;
    GRANT EXECUTE ON FUNCTION public.reconai_finalize_provider_privacy_object_deletion(
      uuid,
      uuid,
      uuid,
      text
    ) TO reconai_worker;
    GRANT EXECUTE ON FUNCTION public.reconai_fail_provider_privacy_object_deletion(
      uuid,
      uuid,
      text
    )
      TO reconai_worker;
  END IF;
END
$$;
