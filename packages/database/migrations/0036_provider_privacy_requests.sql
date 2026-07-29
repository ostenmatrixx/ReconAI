CREATE TABLE "provider_privacy_requests" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" "source_system" NOT NULL,
	"external_event_id" text NOT NULL,
	"topic" text NOT NULL,
	"api_version" text NOT NULL,
	"external_shop_id" text NOT NULL,
	"external_account_id" text NOT NULL,
	"external_subject_id" text,
	"external_request_id" text,
	"external_object_ids" jsonb NOT NULL,
	"payload_sha256" char(64) NOT NULL,
	"status" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_privacy_requests_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "provider_privacy_requests" ADD CONSTRAINT "provider_privacy_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_privacy_requests" ADD CONSTRAINT "provider_privacy_requests_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "public"."data_source_connections"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_privacy_requests_provider_event_uidx" ON "provider_privacy_requests" USING btree ("provider","external_event_id");--> statement-breakpoint
CREATE INDEX "provider_privacy_requests_org_connection_due_idx" ON "provider_privacy_requests" USING btree ("organization_id","connection_id","due_at");

CREATE OR REPLACE FUNCTION public.reconai_is_bounded_shopify_identifier_array(p_value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  v_identifier text;
BEGIN
  IF jsonb_typeof(p_value) <> 'array' OR jsonb_array_length(p_value) > 10000 THEN
    RETURN false;
  END IF;
  FOR v_identifier IN SELECT value FROM jsonb_array_elements_text(p_value)
  LOOP
    IF v_identifier !~ '^[0-9]{1,40}$' THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN (
    SELECT count(*) = count(DISTINCT value)
    FROM jsonb_array_elements_text(p_value)
  );
END;
$$;

ALTER TABLE provider_privacy_requests
  ADD CONSTRAINT provider_privacy_requests_provider_check CHECK (provider = 'shopify'),
  ADD CONSTRAINT provider_privacy_requests_event_check CHECK (
    external_event_id ~ '^[A-Za-z0-9._:/-]{1,255}$'
  ),
  ADD CONSTRAINT provider_privacy_requests_topic_check CHECK (
    topic IN ('customers/data_request', 'customers/redact', 'shop/redact')
  ),
  ADD CONSTRAINT provider_privacy_requests_api_version_check CHECK (
    api_version ~ '^[0-9]{4}-(01|04|07|10)$'
  ),
  ADD CONSTRAINT provider_privacy_requests_shop_id_check CHECK (
    external_shop_id ~ '^[0-9]{1,40}$'
  ),
  ADD CONSTRAINT provider_privacy_requests_account_check CHECK (
    external_account_id
      ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$'
  ),
  ADD CONSTRAINT provider_privacy_requests_subject_check CHECK (
    external_subject_id IS NULL OR external_subject_id ~ '^[0-9]{1,40}$'
  ),
  ADD CONSTRAINT provider_privacy_requests_request_id_check CHECK (
    external_request_id IS NULL OR external_request_id ~ '^[0-9]{1,40}$'
  ),
  ADD CONSTRAINT provider_privacy_requests_objects_check CHECK (
    reconai_is_bounded_shopify_identifier_array(external_object_ids)
  ),
  ADD CONSTRAINT provider_privacy_requests_topic_identity_check CHECK (
    (
      topic = 'customers/data_request'
      AND external_subject_id IS NOT NULL
      AND external_request_id IS NOT NULL
    )
    OR
    (
      topic = 'customers/redact'
      AND external_subject_id IS NOT NULL
      AND external_request_id IS NULL
    )
    OR
    (
      topic = 'shop/redact'
      AND external_subject_id IS NULL
      AND external_request_id IS NULL
      AND jsonb_array_length(external_object_ids) = 0
    )
  ),
  ADD CONSTRAINT provider_privacy_requests_payload_check CHECK (
    payload_sha256 ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT provider_privacy_requests_status_check CHECK (
    status = 'action_required'
  ),
  ADD CONSTRAINT provider_privacy_requests_deadline_check CHECK (
    due_at = received_at + interval '30 days'
    AND created_at >= received_at - interval '5 minutes'
  );

ALTER TABLE provider_privacy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_privacy_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_privacy_requests_tenant_policy
  ON provider_privacy_requests
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
    CREATE POLICY connections_shopify_privacy_migrator_policy
      ON data_source_connections
      FOR SELECT
      TO reconai_migrator
      USING (
        current_user = 'reconai_migrator'
        AND provider = 'shopify'
      );

    CREATE POLICY provider_privacy_requests_migrator_policy
      ON provider_privacy_requests
      FOR ALL
      TO reconai_migrator
      USING (current_user = 'reconai_migrator')
      WITH CHECK (current_user = 'reconai_migrator');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.validate_provider_privacy_request_insert()
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
    RAISE EXCEPTION 'provider privacy request authority is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_privacy_requests_validate_insert
BEFORE INSERT ON provider_privacy_requests
FOR EACH ROW EXECUTE FUNCTION public.validate_provider_privacy_request_insert();

CREATE OR REPLACE FUNCTION public.reject_provider_privacy_request_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'provider privacy requests are append-only';
END;
$$;

CREATE TRIGGER provider_privacy_requests_reject_update_delete
BEFORE UPDATE OR DELETE ON provider_privacy_requests
FOR EACH ROW EXECUTE FUNCTION public.reject_provider_privacy_request_mutation();

CREATE OR REPLACE FUNCTION public.reconai_resolve_shopify_privacy_request(
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
  WHERE p_external_account_id
      ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$'
    AND connections.provider = 'shopify'
    AND connections.external_account_id = p_external_account_id
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.reconai_resolve_shopify_privacy_request(text) FROM PUBLIC;

-- New Shopify canonical records must not copy the email field delivered in order webhooks into
-- immutable reconciliation evidence. Historical rows are not rewritten by this additive migration;
-- an upgrade that contains legacy customer_reference values remains a visible privacy action.
CREATE OR REPLACE FUNCTION public.reject_new_shopify_customer_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source = 'shopify'
    AND (
      NEW.customer_reference IS NOT NULL
      OR NEW.normalized_data ? 'customerReference'
    )
  THEN
    RAISE EXCEPTION 'Shopify customer references are not permitted in canonical records';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER canonical_records_reject_new_shopify_customer_reference
BEFORE INSERT ON canonical_records
FOR EACH ROW EXECUTE FUNCTION public.reject_new_shopify_customer_reference();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT SELECT, INSERT ON provider_privacy_requests TO reconai_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON provider_privacy_requests FROM reconai_app;
    GRANT EXECUTE ON FUNCTION public.reconai_resolve_shopify_privacy_request(text)
      TO reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    REVOKE ALL ON provider_privacy_requests FROM reconai_worker;
    REVOKE ALL ON FUNCTION public.reconai_resolve_shopify_privacy_request(text)
      FROM reconai_worker;
  END IF;
END
$$;
