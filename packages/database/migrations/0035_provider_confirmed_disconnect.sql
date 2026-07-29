CREATE TABLE "provider_deauthorization_events" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" "source_system" NOT NULL,
	"external_event_id" text NOT NULL,
	"external_account_id" text NOT NULL,
	"payload_sha256" char(64) NOT NULL,
	"livemode" boolean NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_deauthorization_events_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "provider_deauthorization_events" ADD CONSTRAINT "provider_deauthorization_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_deauthorization_events" ADD CONSTRAINT "provider_deauthorization_events_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "public"."data_source_connections"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_deauthorization_events_provider_event_uidx" ON "provider_deauthorization_events" USING btree ("provider","external_event_id");--> statement-breakpoint
CREATE INDEX "provider_deauthorization_events_org_connection_received_idx" ON "provider_deauthorization_events" USING btree ("organization_id","connection_id","received_at");

ALTER TABLE provider_deauthorization_events
  ADD CONSTRAINT provider_deauthorization_events_provider_check
    CHECK (provider = 'stripe'),
  ADD CONSTRAINT provider_deauthorization_events_event_check
    CHECK (external_event_id ~ '^evt_[A-Za-z0-9]{1,250}$'),
  ADD CONSTRAINT provider_deauthorization_events_account_check
    CHECK (external_account_id ~ '^acct_[A-Za-z0-9]{1,250}$'),
  ADD CONSTRAINT provider_deauthorization_events_payload_check
    CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT provider_deauthorization_events_time_check CHECK (
    occurred_at <= received_at + interval '5 minutes'
    AND created_at >= received_at - interval '5 minutes'
  );

ALTER TABLE provider_deauthorization_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_deauthorization_events FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_deauthorization_events_tenant_policy
  ON provider_deauthorization_events
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

-- The narrowly granted resolver must map a signed app-level event to its globally unique Stripe
-- account before a tenant context is known. Its owner gets SELECT only; application code retains no
-- unscoped table grant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_migrator') THEN
    CREATE POLICY connections_stripe_deauthorization_migrator_policy
      ON data_source_connections
      FOR SELECT
      TO reconai_migrator
      USING (
        current_user = 'reconai_migrator'
        AND provider = 'stripe'
      );

    CREATE POLICY provider_deauthorization_events_migrator_policy
      ON provider_deauthorization_events
      FOR ALL
      TO reconai_migrator
      USING (current_user = 'reconai_migrator')
      WITH CHECK (current_user = 'reconai_migrator');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION validate_provider_deauthorization_event_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM data_source_connections AS connections
    WHERE connections.organization_id = NEW.organization_id
      AND connections.id = NEW.connection_id
      AND connections.provider = NEW.provider
      AND connections.external_account_id = NEW.external_account_id
  ) THEN
    RAISE EXCEPTION 'provider deauthorization event authority is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_deauthorization_events_validate_insert
BEFORE INSERT ON provider_deauthorization_events
FOR EACH ROW EXECUTE FUNCTION validate_provider_deauthorization_event_insert();

CREATE OR REPLACE FUNCTION reject_provider_deauthorization_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'provider deauthorization events are append-only';
END;
$$;

CREATE TRIGGER provider_deauthorization_events_reject_update_delete
BEFORE UPDATE OR DELETE ON provider_deauthorization_events
FOR EACH ROW EXECUTE FUNCTION reject_provider_deauthorization_event_mutation();

CREATE OR REPLACE FUNCTION public.reconai_resolve_stripe_deauthorization(
  p_external_account_id text
)
RETURNS TABLE (
  organization_id uuid,
  connection_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT connections.organization_id, connections.id
  FROM public.data_source_connections AS connections
  WHERE p_external_account_id ~ '^acct_[A-Za-z0-9]{1,250}$'
    AND connections.provider = 'stripe'
    AND connections.external_account_id = p_external_account_id
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.reconai_resolve_stripe_deauthorization(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT SELECT, INSERT ON provider_deauthorization_events TO reconai_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON provider_deauthorization_events FROM reconai_app;
    GRANT EXECUTE ON FUNCTION public.reconai_resolve_stripe_deauthorization(text)
      TO reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    REVOKE ALL ON provider_deauthorization_events FROM reconai_worker;
    REVOKE ALL ON FUNCTION public.reconai_resolve_stripe_deauthorization(text)
      FROM reconai_worker;
  END IF;
END
$$;
