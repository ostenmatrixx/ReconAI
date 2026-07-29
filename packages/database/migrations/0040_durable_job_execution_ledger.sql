CREATE TABLE "job_executions" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"outbox_event_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"event_type" text NOT NULL,
	"schema_version" integer NOT NULL,
	"queue_name" text NOT NULL,
	"job_id" char(64) NOT NULL,
	"correlation_id" uuid NOT NULL,
	"status" text NOT NULL,
	"attempts" integer NOT NULL,
	"maximum_attempts" integer NOT NULL,
	"execution_token_sha256" char(64),
	"started_at" timestamp with time zone NOT NULL,
	"last_heartbeat_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_executions_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "queue_recovery_events" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"recovery_run_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"event_type" text NOT NULL,
	"classification" text NOT NULL,
	"job_id" char(64) NOT NULL,
	"requested_by" text NOT NULL,
	"reason" text NOT NULL,
	"recovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_recovery_events_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
-- Expansion rollout: legacy and old-writer rows remain NULL and therefore cannot be guessed as
-- recoverable. Updated writers explicitly opt new events into version-1 execution tracking.
ALTER TABLE "outbox_events" ADD COLUMN "execution_tracking_version" integer;--> statement-breakpoint
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_outbox_fk" FOREIGN KEY ("organization_id","outbox_event_id") REFERENCES "public"."outbox_events"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_recovery_events" ADD CONSTRAINT "queue_recovery_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_recovery_events" ADD CONSTRAINT "queue_recovery_events_outbox_fk" FOREIGN KEY ("organization_id","idempotency_key") REFERENCES "public"."outbox_events"("organization_id","idempotency_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_executions_org_outbox_uidx" ON "job_executions" USING btree ("organization_id","outbox_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_executions_org_idempotency_uidx" ON "job_executions" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "job_executions_recovery_idx" ON "job_executions" USING btree ("status","lease_expires_at","organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_recovery_events_run_job_uidx" ON "queue_recovery_events" USING btree ("organization_id","recovery_run_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "queue_recovery_events_org_time_idx" ON "queue_recovery_events" USING btree ("organization_id","recovered_at","id");--> statement-breakpoint

ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_execution_tracking_version_check
    CHECK (execution_tracking_version IS NULL OR execution_tracking_version = 1);

ALTER TABLE job_executions
  ADD CONSTRAINT job_executions_event_type_check
    CHECK (event_type ~ '^[a-z0-9._/-]{1,100}$'),
  ADD CONSTRAINT job_executions_schema_version_check
    CHECK (schema_version BETWEEN 1 AND 100),
  ADD CONSTRAINT job_executions_queue_name_check
    CHECK (queue_name ~ '^[a-z0-9][a-z0-9-]{1,99}$'),
  ADD CONSTRAINT job_executions_job_id_check
    CHECK (job_id ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT job_executions_status_check
    CHECK (status IN ('running', 'retryable', 'succeeded', 'dead_lettered')),
  ADD CONSTRAINT job_executions_attempts_check
    CHECK (
      attempts BETWEEN 1 AND 100
      AND maximum_attempts BETWEEN 1 AND 100
      AND attempts <= maximum_attempts
    ),
  ADD CONSTRAINT job_executions_token_check
    CHECK (
      execution_token_sha256 IS NULL
      OR execution_token_sha256 ~ '^[a-f0-9]{64}$'
    ),
  ADD CONSTRAINT job_executions_error_code_check
    CHECK (
      last_error_code IS NULL
      OR last_error_code ~ '^[A-Z0-9_]{1,100}$'
    ),
  ADD CONSTRAINT job_executions_time_check
    CHECK (
      created_at <= updated_at
      AND started_at <= last_heartbeat_at
      AND last_heartbeat_at <= lease_expires_at
      AND (completed_at IS NULL OR started_at <= completed_at)
    ),
  ADD CONSTRAINT job_executions_state_shape_check
    CHECK (
      (
        status = 'running'
        AND execution_token_sha256 IS NOT NULL
        AND completed_at IS NULL
        AND last_error_code IS NULL
      )
      OR
      (
        status = 'retryable'
        AND execution_token_sha256 IS NULL
        AND completed_at IS NULL
        AND last_error_code IS NOT NULL
      )
      OR
      (
        status = 'succeeded'
        AND execution_token_sha256 IS NULL
        AND completed_at IS NOT NULL
        AND last_error_code IS NULL
      )
      OR
      (
        status = 'dead_lettered'
        AND execution_token_sha256 IS NULL
        AND completed_at IS NOT NULL
        AND last_error_code IS NOT NULL
      )
    );

ALTER TABLE queue_recovery_events
  ADD CONSTRAINT queue_recovery_events_event_type_check
    CHECK (event_type ~ '^[a-z0-9._/-]{1,100}$'),
  ADD CONSTRAINT queue_recovery_events_classification_check
    CHECK (
      classification IN (
        'unpublished',
        'never_started',
        'retryable',
        'stale_running'
      )
    ),
  ADD CONSTRAINT queue_recovery_events_job_id_check
    CHECK (job_id ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT queue_recovery_events_requested_by_check
    CHECK (requested_by ~ '^[A-Za-z0-9][A-Za-z0-9@._:/-]{2,99}$'),
  ADD CONSTRAINT queue_recovery_events_reason_check
    CHECK (
      char_length(reason) BETWEEN 20 AND 500
      AND reason !~ '[[:cntrl:]]'
    );

ALTER TABLE job_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_executions FORCE ROW LEVEL SECURITY;
ALTER TABLE queue_recovery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_recovery_events FORCE ROW LEVEL SECURITY;

CREATE POLICY job_executions_tenant_policy ON job_executions
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

CREATE POLICY queue_recovery_events_tenant_policy ON queue_recovery_events
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
    EXECUTE '
      CREATE POLICY job_executions_owner_policy ON job_executions
      FOR ALL TO reconai_migrator
      USING (true)
      WITH CHECK (true)
    ';
    EXECUTE '
      CREATE POLICY queue_recovery_events_owner_policy ON queue_recovery_events
      FOR ALL TO reconai_migrator
      USING (true)
      WITH CHECK (true)
    ';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION apply_outbox_execution_tracking()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF
    NEW.execution_tracking_version IS NULL
    AND current_setting('app.execution_tracking_version', true) = '1'
  THEN
    NEW.execution_tracking_version := 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbox_events_apply_execution_tracking
BEFORE INSERT ON outbox_events
FOR EACH ROW EXECUTE FUNCTION apply_outbox_execution_tracking();

CREATE OR REPLACE FUNCTION protect_outbox_execution_tracking()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.execution_tracking_version IS DISTINCT FROM OLD.execution_tracking_version THEN
    RAISE EXCEPTION 'outbox execution tracking authority is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbox_events_protect_execution_tracking
BEFORE UPDATE OF execution_tracking_version ON outbox_events
FOR EACH ROW EXECUTE FUNCTION protect_outbox_execution_tracking();

CREATE OR REPLACE FUNCTION protect_job_execution_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF
    NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
    NEW.id IS DISTINCT FROM OLD.id OR
    NEW.outbox_event_id IS DISTINCT FROM OLD.outbox_event_id OR
    NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
    NEW.event_type IS DISTINCT FROM OLD.event_type OR
    NEW.schema_version IS DISTINCT FROM OLD.schema_version OR
    NEW.queue_name IS DISTINCT FROM OLD.queue_name OR
    NEW.job_id IS DISTINCT FROM OLD.job_id OR
    NEW.correlation_id IS DISTINCT FROM OLD.correlation_id OR
    NEW.maximum_attempts IS DISTINCT FROM OLD.maximum_attempts OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'job execution authority is immutable';
  END IF;

  IF OLD.status IN ('succeeded', 'dead_lettered') THEN
    RAISE EXCEPTION 'terminal job execution is immutable';
  END IF;

  IF NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1 THEN
    RAISE EXCEPTION 'job execution attempt transition is invalid';
  END IF;

  IF OLD.status = 'retryable' AND NEW.status NOT IN ('running', 'dead_lettered') THEN
    RAISE EXCEPTION 'retryable job execution transition is invalid';
  END IF;

  IF OLD.status = 'running' AND NEW.status NOT IN (
    'running',
    'retryable',
    'succeeded',
    'dead_lettered'
  ) THEN
    RAISE EXCEPTION 'running job execution transition is invalid';
  END IF;

  IF
    OLD.status = 'running' AND
    NEW.status = 'running' AND
    NEW.execution_token_sha256 IS DISTINCT FROM OLD.execution_token_sha256 AND
    OLD.lease_expires_at > statement_timestamp()
  THEN
    RAISE EXCEPTION 'live job execution lease cannot be replaced';
  END IF;

  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'job execution update time cannot move backward';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER job_executions_protect_authority
BEFORE UPDATE ON job_executions
FOR EACH ROW EXECUTE FUNCTION protect_job_execution_authority();

CREATE OR REPLACE FUNCTION reject_queue_recovery_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'queue recovery events are append-only';
END;
$$;

CREATE TRIGGER queue_recovery_events_reject_update_delete
BEFORE UPDATE OR DELETE ON queue_recovery_events
FOR EACH ROW EXECUTE FUNCTION reject_queue_recovery_event_mutation();

CREATE OR REPLACE FUNCTION reconai_begin_job_execution(
  requested_organization_id uuid,
  requested_idempotency_key text,
  requested_event_type text,
  requested_schema_version integer,
  requested_queue_name text,
  requested_job_id text,
  requested_correlation_id uuid,
  requested_execution_token_sha256 text,
  requested_maximum_attempts integer,
  requested_lease_seconds integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  active_organization_id uuid;
  authority public.outbox_events%ROWTYPE;
  execution public.job_executions%ROWTYPE;
  operation_time timestamptz := statement_timestamp();
BEGIN
  active_organization_id :=
    nullif(current_setting('app.organization_id', true), '')::uuid;
  IF active_organization_id IS NULL
    OR active_organization_id <> requested_organization_id
  THEN
    RAISE EXCEPTION 'tenant context does not authorize job execution'
      USING ERRCODE = '42501';
  END IF;

  IF requested_idempotency_key IS NULL
    OR char_length(requested_idempotency_key) NOT BETWEEN 1 AND 500
    OR requested_event_type !~ '^[a-z0-9._/-]{1,100}$'
    OR requested_schema_version NOT BETWEEN 1 AND 100
    OR requested_queue_name !~ '^[a-z0-9][a-z0-9-]{1,99}$'
    OR requested_job_id !~ '^[a-f0-9]{64}$'
    OR requested_execution_token_sha256 !~ '^[a-f0-9]{64}$'
    OR requested_maximum_attempts NOT BETWEEN 1 AND 100
    OR requested_lease_seconds NOT BETWEEN 60 AND 3600
  THEN
    RAISE EXCEPTION 'job execution authority is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO authority
  FROM public.outbox_events
  WHERE organization_id = requested_organization_id
    AND idempotency_key = requested_idempotency_key
  FOR UPDATE;

  IF NOT FOUND
    OR authority.published_at IS NULL
    OR authority.dead_lettered_at IS NOT NULL
    OR authority.event_type <> requested_event_type
    OR authority.schema_version <> requested_schema_version
    OR authority.correlation_id <> requested_correlation_id
  THEN
    RAISE EXCEPTION 'job execution does not match published outbox authority'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO execution
  FROM public.job_executions
  WHERE organization_id = requested_organization_id
    AND idempotency_key = requested_idempotency_key
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.job_executions (
      id,
      organization_id,
      outbox_event_id,
      idempotency_key,
      event_type,
      schema_version,
      queue_name,
      job_id,
      correlation_id,
      status,
      attempts,
      maximum_attempts,
      execution_token_sha256,
      started_at,
      last_heartbeat_at,
      lease_expires_at,
      completed_at,
      last_error_code,
      created_at,
      updated_at
    ) VALUES (
      gen_random_uuid(),
      requested_organization_id,
      authority.id,
      requested_idempotency_key,
      requested_event_type,
      requested_schema_version,
      requested_queue_name,
      requested_job_id,
      requested_correlation_id,
      'running',
      1,
      requested_maximum_attempts,
      requested_execution_token_sha256,
      operation_time,
      operation_time,
      operation_time + make_interval(secs => requested_lease_seconds),
      NULL,
      NULL,
      operation_time,
      operation_time
    );
    RETURN 'acquired';
  END IF;

  IF
    execution.outbox_event_id <> authority.id OR
    execution.event_type <> requested_event_type OR
    execution.schema_version <> requested_schema_version OR
    execution.queue_name <> requested_queue_name OR
    execution.job_id <> requested_job_id OR
    execution.correlation_id <> requested_correlation_id OR
    execution.maximum_attempts <> requested_maximum_attempts
  THEN
    RAISE EXCEPTION 'job execution ledger authority mismatch'
      USING ERRCODE = '42501';
  END IF;

  IF execution.status = 'succeeded' THEN
    RETURN 'already_succeeded';
  END IF;
  IF execution.status = 'dead_lettered' THEN
    RETURN 'dead_lettered';
  END IF;
  IF execution.status = 'running' AND execution.lease_expires_at > operation_time THEN
    RETURN 'busy';
  END IF;
  IF execution.attempts >= execution.maximum_attempts THEN
    UPDATE public.job_executions
    SET status = 'dead_lettered',
        execution_token_sha256 = NULL,
        completed_at = operation_time,
        last_error_code = 'EXECUTION_ATTEMPTS_EXHAUSTED',
        updated_at = operation_time
    WHERE organization_id = requested_organization_id
      AND idempotency_key = requested_idempotency_key;
    RETURN 'dead_lettered';
  END IF;

  UPDATE public.job_executions
  SET status = 'running',
      attempts = attempts + 1,
      execution_token_sha256 = requested_execution_token_sha256,
      started_at = operation_time,
      last_heartbeat_at = operation_time,
      lease_expires_at = operation_time + make_interval(secs => requested_lease_seconds),
      completed_at = NULL,
      last_error_code = NULL,
      updated_at = operation_time
  WHERE organization_id = requested_organization_id
    AND idempotency_key = requested_idempotency_key;

  RETURN 'acquired';
END;
$$;

CREATE OR REPLACE FUNCTION reconai_heartbeat_job_execution(
  requested_organization_id uuid,
  requested_idempotency_key text,
  requested_execution_token_sha256 text,
  requested_lease_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  active_organization_id uuid;
  changed boolean;
  operation_time timestamptz := statement_timestamp();
BEGIN
  active_organization_id :=
    nullif(current_setting('app.organization_id', true), '')::uuid;
  IF active_organization_id IS NULL
    OR active_organization_id <> requested_organization_id
  THEN
    RAISE EXCEPTION 'tenant context does not authorize job execution heartbeat'
      USING ERRCODE = '42501';
  END IF;
  IF requested_execution_token_sha256 !~ '^[a-f0-9]{64}$'
    OR requested_lease_seconds NOT BETWEEN 60 AND 3600
  THEN
    RAISE EXCEPTION 'job execution heartbeat authority is invalid'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.job_executions
  SET last_heartbeat_at = operation_time,
      lease_expires_at = operation_time + make_interval(secs => requested_lease_seconds),
      updated_at = operation_time
  WHERE organization_id = requested_organization_id
    AND idempotency_key = requested_idempotency_key
    AND status = 'running'
    AND execution_token_sha256 = requested_execution_token_sha256
  RETURNING true INTO changed;

  RETURN coalesce(changed, false);
END;
$$;

CREATE OR REPLACE FUNCTION reconai_complete_job_execution(
  requested_organization_id uuid,
  requested_idempotency_key text,
  requested_execution_token_sha256 text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  active_organization_id uuid;
  changed boolean;
  operation_time timestamptz := statement_timestamp();
BEGIN
  active_organization_id :=
    nullif(current_setting('app.organization_id', true), '')::uuid;
  IF active_organization_id IS NULL
    OR active_organization_id <> requested_organization_id
  THEN
    RAISE EXCEPTION 'tenant context does not authorize job execution completion'
      USING ERRCODE = '42501';
  END IF;
  IF requested_execution_token_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'job execution completion authority is invalid'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.job_executions
  SET status = 'succeeded',
      execution_token_sha256 = NULL,
      completed_at = operation_time,
      last_error_code = NULL,
      updated_at = operation_time
  WHERE organization_id = requested_organization_id
    AND idempotency_key = requested_idempotency_key
    AND status = 'running'
    AND execution_token_sha256 = requested_execution_token_sha256
  RETURNING true INTO changed;

  RETURN coalesce(changed, false);
END;
$$;

CREATE OR REPLACE FUNCTION reconai_fail_job_execution(
  requested_organization_id uuid,
  requested_idempotency_key text,
  requested_execution_token_sha256 text,
  requested_error_code text,
  requested_terminal boolean
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  active_organization_id uuid;
  execution public.job_executions%ROWTYPE;
  next_status text;
  operation_time timestamptz := statement_timestamp();
BEGIN
  active_organization_id :=
    nullif(current_setting('app.organization_id', true), '')::uuid;
  IF active_organization_id IS NULL
    OR active_organization_id <> requested_organization_id
  THEN
    RAISE EXCEPTION 'tenant context does not authorize job execution failure'
      USING ERRCODE = '42501';
  END IF;
  IF requested_execution_token_sha256 !~ '^[a-f0-9]{64}$'
    OR requested_error_code !~ '^[A-Z0-9_]{1,100}$'
  THEN
    RAISE EXCEPTION 'job execution failure authority is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO execution
  FROM public.job_executions
  WHERE organization_id = requested_organization_id
    AND idempotency_key = requested_idempotency_key
    AND status = 'running'
    AND execution_token_sha256 = requested_execution_token_sha256
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'job execution failure lease is no longer current'
      USING ERRCODE = '40001';
  END IF;

  next_status := CASE
    WHEN requested_terminal OR execution.attempts >= execution.maximum_attempts
      THEN 'dead_lettered'
    ELSE 'retryable'
  END;

  UPDATE public.job_executions
  SET status = next_status,
      execution_token_sha256 = NULL,
      completed_at = CASE WHEN next_status = 'dead_lettered' THEN operation_time ELSE NULL END,
      last_error_code = requested_error_code,
      updated_at = operation_time
  WHERE organization_id = requested_organization_id
    AND idempotency_key = requested_idempotency_key;

  RETURN next_status;
END;
$$;

CREATE OR REPLACE FUNCTION reconai_recoverable_queue_events(
  requested_limit integer,
  requested_stale_before timestamptz
)
RETURNS TABLE (
  organization_id uuid,
  event_type text,
  schema_version integer,
  idempotency_key text,
  payload jsonb,
  correlation_id uuid,
  classification text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF requested_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'queue recovery batch limit must be between 1 and 500';
  END IF;
  IF requested_stale_before IS NULL
    OR requested_stale_before > statement_timestamp() - interval '15 minutes'
  THEN
    RAISE EXCEPTION 'queue recovery stale boundary must be at least 15 minutes old';
  END IF;

  RETURN QUERY
    SELECT
      event.organization_id,
      event.event_type,
      event.schema_version,
      event.idempotency_key,
      event.payload,
      event.correlation_id,
      CASE
        WHEN event.published_at IS NULL THEN 'unpublished'
        WHEN execution.id IS NULL THEN 'never_started'
        WHEN execution.status = 'retryable' THEN 'retryable'
        ELSE 'stale_running'
      END
    FROM public.outbox_events AS event
    LEFT JOIN public.job_executions AS execution
      ON execution.organization_id = event.organization_id
     AND execution.outbox_event_id = event.id
    WHERE event.dead_lettered_at IS NULL
      AND (
        (
          event.published_at IS NULL
          AND event.next_attempt_at <= statement_timestamp()
        )
        OR
        (
          event.published_at IS NOT NULL
          AND (
            (
              execution.id IS NULL
              AND (
                event.execution_tracking_version = 1
                OR EXISTS (
                  SELECT 1
                  FROM public.queue_recovery_events AS recovery
                  WHERE recovery.organization_id = event.organization_id
                    AND recovery.idempotency_key = event.idempotency_key
                )
              )
            )
            OR execution.status = 'retryable'
            OR (
              execution.status = 'running'
              AND execution.last_heartbeat_at <= requested_stale_before
              AND execution.lease_expires_at <= statement_timestamp()
            )
          )
        )
      )
    ORDER BY event.created_at, event.organization_id, event.id
    LIMIT requested_limit;
END;
$$;

CREATE OR REPLACE FUNCTION reconai_queue_recovery_summary(
  requested_stale_before timestamptz
)
RETURNS TABLE (
  recoverable_unpublished bigint,
  recoverable_never_started bigint,
  recoverable_retryable bigint,
  recoverable_stale_running bigint,
  legacy_unclassified bigint,
  active_running bigint,
  succeeded bigint,
  dead_lettered bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF requested_stale_before IS NULL
    OR requested_stale_before > statement_timestamp() - interval '15 minutes'
  THEN
    RAISE EXCEPTION 'queue recovery stale boundary must be at least 15 minutes old';
  END IF;

  RETURN QUERY
    SELECT
      count(*) FILTER (
        WHERE event.published_at IS NULL
          AND event.dead_lettered_at IS NULL
          AND event.next_attempt_at <= statement_timestamp()
      ),
      count(*) FILTER (
        WHERE event.published_at IS NOT NULL
          AND event.dead_lettered_at IS NULL
          AND execution.id IS NULL
          AND (
            event.execution_tracking_version = 1
            OR EXISTS (
              SELECT 1
              FROM public.queue_recovery_events AS recovery
              WHERE recovery.organization_id = event.organization_id
                AND recovery.idempotency_key = event.idempotency_key
            )
          )
      ),
      count(*) FILTER (
        WHERE event.published_at IS NOT NULL
          AND event.dead_lettered_at IS NULL
          AND execution.status = 'retryable'
      ),
      count(*) FILTER (
        WHERE event.published_at IS NOT NULL
          AND event.dead_lettered_at IS NULL
          AND execution.status = 'running'
          AND execution.last_heartbeat_at <= requested_stale_before
          AND execution.lease_expires_at <= statement_timestamp()
      ),
      count(*) FILTER (
        WHERE event.published_at IS NOT NULL
          AND event.dead_lettered_at IS NULL
          AND event.execution_tracking_version IS NULL
          AND execution.id IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM public.queue_recovery_events AS recovery
            WHERE recovery.organization_id = event.organization_id
              AND recovery.idempotency_key = event.idempotency_key
          )
      ),
      count(*) FILTER (
        WHERE execution.status = 'running'
          AND NOT (
            execution.last_heartbeat_at <= requested_stale_before
            AND execution.lease_expires_at <= statement_timestamp()
          )
      ),
      count(*) FILTER (WHERE execution.status = 'succeeded'),
      count(*) FILTER (
        WHERE event.dead_lettered_at IS NOT NULL
          OR execution.status = 'dead_lettered'
      )
    FROM public.outbox_events AS event
    LEFT JOIN public.job_executions AS execution
      ON execution.organization_id = event.organization_id
     AND execution.outbox_event_id = event.id;
END;
$$;

CREATE OR REPLACE FUNCTION reconai_record_queue_recovery(
  requested_event_id uuid,
  requested_recovery_run_id uuid,
  requested_organization_id uuid,
  requested_idempotency_key text,
  requested_classification text,
  requested_job_id text,
  requested_by text,
  requested_reason text,
  requested_stale_before timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  authority public.outbox_events%ROWTYPE;
  execution public.job_executions%ROWTYPE;
  actual_classification text;
  inserted boolean;
  operation_time timestamptz := statement_timestamp();
BEGIN
  IF requested_classification NOT IN (
    'unpublished',
    'never_started',
    'retryable',
    'stale_running'
  )
    OR requested_job_id !~ '^[a-f0-9]{64}$'
    OR requested_by !~ '^[A-Za-z0-9][A-Za-z0-9@._:/-]{2,99}$'
    OR char_length(requested_reason) NOT BETWEEN 20 AND 500
    OR requested_reason ~ '[[:cntrl:]]'
    OR requested_stale_before IS NULL
    OR requested_stale_before > operation_time - interval '15 minutes'
  THEN
    RAISE EXCEPTION 'queue recovery evidence is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.queue_recovery_events
    WHERE organization_id = requested_organization_id
      AND recovery_run_id = requested_recovery_run_id
      AND idempotency_key = requested_idempotency_key
  ) THEN
    RETURN false;
  END IF;

  SELECT *
  INTO authority
  FROM public.outbox_events
  WHERE organization_id = requested_organization_id
    AND idempotency_key = requested_idempotency_key
  FOR UPDATE;

  IF NOT FOUND OR authority.dead_lettered_at IS NOT NULL THEN
    RAISE EXCEPTION 'queue recovery outbox authority is unavailable'
      USING ERRCODE = '40001';
  END IF;

  SELECT *
  INTO execution
  FROM public.job_executions
  WHERE organization_id = requested_organization_id
    AND outbox_event_id = authority.id
  FOR UPDATE;

  actual_classification := CASE
    WHEN authority.published_at IS NULL
      AND authority.next_attempt_at <= operation_time
      THEN 'unpublished'
    WHEN authority.published_at IS NOT NULL
      AND execution.id IS NULL
      AND (
        authority.execution_tracking_version = 1
        OR EXISTS (
          SELECT 1
          FROM public.queue_recovery_events AS recovery
          WHERE recovery.organization_id = authority.organization_id
            AND recovery.idempotency_key = authority.idempotency_key
        )
      )
      THEN 'never_started'
    WHEN authority.published_at IS NOT NULL
      AND execution.status = 'retryable'
      THEN 'retryable'
    WHEN authority.published_at IS NOT NULL
      AND execution.status = 'running'
      AND execution.last_heartbeat_at <= requested_stale_before
      AND execution.lease_expires_at <= operation_time
      THEN 'stale_running'
    ELSE NULL
  END;

  IF actual_classification IS DISTINCT FROM requested_classification THEN
    RAISE EXCEPTION 'queue recovery classification changed after preflight'
      USING ERRCODE = '40001';
  END IF;

  IF execution.id IS NOT NULL AND execution.job_id <> requested_job_id THEN
    RAISE EXCEPTION 'queue recovery job identity does not match execution authority'
      USING ERRCODE = '42501';
  END IF;

  IF actual_classification = 'unpublished' THEN
    UPDATE public.outbox_events
    SET published_at = operation_time,
        attempts = attempts + 1,
        last_error_code = NULL
    WHERE organization_id = requested_organization_id
      AND idempotency_key = requested_idempotency_key
      AND published_at IS NULL
      AND dead_lettered_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unpublished outbox recovery transition was lost'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  INSERT INTO public.queue_recovery_events (
    id,
    organization_id,
    recovery_run_id,
    idempotency_key,
    event_type,
    classification,
    job_id,
    requested_by,
    reason,
    recovered_at
  ) VALUES (
    requested_event_id,
    requested_organization_id,
    requested_recovery_run_id,
    requested_idempotency_key,
    authority.event_type,
    requested_classification,
    requested_job_id,
    requested_by,
    requested_reason,
    operation_time
  )
  ON CONFLICT (organization_id, recovery_run_id, idempotency_key) DO NOTHING
  RETURNING true INTO inserted;

  RETURN coalesce(inserted, false);
END;
$$;

REVOKE ALL ON FUNCTION reconai_begin_job_execution(
  uuid, text, text, integer, text, text, uuid, text, integer, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconai_heartbeat_job_execution(uuid, text, text, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION reconai_complete_job_execution(uuid, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION reconai_fail_job_execution(uuid, text, text, text, boolean)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION reconai_recoverable_queue_events(integer, timestamptz)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION reconai_queue_recovery_summary(timestamptz)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION reconai_record_queue_recovery(
  uuid, uuid, uuid, text, text, text, text, text, timestamptz
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    REVOKE ALL ON job_executions, queue_recovery_events FROM reconai_app;
    REVOKE ALL ON FUNCTION reconai_begin_job_execution(
      uuid, text, text, integer, text, text, uuid, text, integer, integer
    ) FROM reconai_app;
    REVOKE ALL ON FUNCTION reconai_heartbeat_job_execution(uuid, text, text, integer)
      FROM reconai_app;
    REVOKE ALL ON FUNCTION reconai_complete_job_execution(uuid, text, text)
      FROM reconai_app;
    REVOKE ALL ON FUNCTION reconai_fail_job_execution(uuid, text, text, text, boolean)
      FROM reconai_app;
    REVOKE ALL ON FUNCTION reconai_recoverable_queue_events(integer, timestamptz)
      FROM reconai_app;
    REVOKE ALL ON FUNCTION reconai_queue_recovery_summary(timestamptz)
      FROM reconai_app;
    REVOKE ALL ON FUNCTION reconai_record_queue_recovery(
      uuid, uuid, uuid, text, text, text, text, text, timestamptz
    ) FROM reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON job_executions, queue_recovery_events
      FROM reconai_worker;
    GRANT SELECT ON job_executions, queue_recovery_events TO reconai_worker;
    GRANT EXECUTE ON FUNCTION reconai_begin_job_execution(
      uuid, text, text, integer, text, text, uuid, text, integer, integer
    ) TO reconai_worker;
    GRANT EXECUTE ON FUNCTION reconai_heartbeat_job_execution(uuid, text, text, integer)
      TO reconai_worker;
    GRANT EXECUTE ON FUNCTION reconai_complete_job_execution(uuid, text, text)
      TO reconai_worker;
    GRANT EXECUTE ON FUNCTION reconai_fail_job_execution(uuid, text, text, text, boolean)
      TO reconai_worker;
    GRANT EXECUTE ON FUNCTION reconai_recoverable_queue_events(integer, timestamptz)
      TO reconai_worker;
    GRANT EXECUTE ON FUNCTION reconai_queue_recovery_summary(timestamptz)
      TO reconai_worker;
    GRANT EXECUTE ON FUNCTION reconai_record_queue_recovery(
      uuid, uuid, uuid, text, text, text, text, text, timestamptz
    ) TO reconai_worker;
  END IF;
END
$$;

REVOKE DELETE, TRUNCATE ON job_executions, queue_recovery_events FROM PUBLIC;
