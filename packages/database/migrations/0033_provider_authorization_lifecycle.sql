CREATE TABLE "provider_authorization_attempts" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" "source_system" NOT NULL,
	"state_sha256" char(64) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_account_id" text,
	"requested_by_membership_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_authorization_attempts_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "provider_authorization_attempts" ADD CONSTRAINT "provider_authorization_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_authorization_attempts" ADD CONSTRAINT "provider_authorization_attempts_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "public"."data_source_connections"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_authorization_attempts" ADD CONSTRAINT "provider_authorization_attempts_requester_membership_fk" FOREIGN KEY ("organization_id","requested_by_membership_id") REFERENCES "public"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_authorization_attempts_state_uidx" ON "provider_authorization_attempts" USING btree ("state_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_authorization_attempts_active_connection_uidx" ON "provider_authorization_attempts" USING btree ("organization_id","connection_id") WHERE "provider_authorization_attempts"."status" in ('pending', 'exchanging');--> statement-breakpoint
CREATE INDEX "provider_authorization_attempts_org_created_idx" ON "provider_authorization_attempts" USING btree ("organization_id","created_at");

ALTER TABLE connector_credentials
  DROP CONSTRAINT connector_credentials_envelope_check,
  ADD CONSTRAINT connector_credentials_envelope_check CHECK (
    jsonb_typeof(encrypted_envelope) = 'object'
    AND encrypted_envelope = jsonb_build_object(
      'schemaVersion', 1,
      'algorithm', 'A256GCM',
      'keyVersion', encrypted_envelope ->> 'keyVersion',
      'organizationId', encrypted_envelope ->> 'organizationId',
      'connectionId', encrypted_envelope ->> 'connectionId',
      'provider', encrypted_envelope ->> 'provider',
      'purpose', encrypted_envelope ->> 'purpose',
      'iv', encrypted_envelope ->> 'iv',
      'ciphertext', encrypted_envelope ->> 'ciphertext',
      'tag', encrypted_envelope ->> 'tag'
    )
    AND encrypted_envelope ->> 'keyVersion' = key_version
    AND encrypted_envelope ->> 'organizationId' = organization_id::text
    AND encrypted_envelope ->> 'connectionId' = connection_id::text
    AND encrypted_envelope ->> 'purpose' = purpose
    AND encrypted_envelope ->> 'provider' IN ('shopify', 'stripe')
    AND encrypted_envelope ->> 'iv' ~ '^[A-Za-z0-9_-]{16}$'
    AND length(encrypted_envelope ->> 'ciphertext') BETWEEN 22 AND 5462
    AND encrypted_envelope ->> 'ciphertext' ~ '^[A-Za-z0-9_-]+$'
    AND encrypted_envelope ->> 'tag' ~ '^[A-Za-z0-9_-]{22}$'
  );

ALTER TABLE provider_authorization_attempts
  ADD CONSTRAINT provider_authorization_attempts_provider_check
    CHECK (provider IN ('shopify', 'stripe')),
  ADD CONSTRAINT provider_authorization_attempts_state_check
    CHECK (state_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT provider_authorization_attempts_status_check
    CHECK (status IN ('pending', 'exchanging', 'succeeded', 'denied', 'failed', 'expired')),
  ADD CONSTRAINT provider_authorization_attempts_account_check CHECK (
    (
      provider = 'shopify'
      AND requested_account_id ~
        '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$'
    )
    OR
    (
      provider = 'stripe'
      AND (
        requested_account_id IS NULL
        OR requested_account_id ~ '^acct_[A-Za-z0-9]{1,250}$'
      )
    )
  ),
  ADD CONSTRAINT provider_authorization_attempts_error_code_check CHECK (
    error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{1,99}$'
  ),
  ADD CONSTRAINT provider_authorization_attempts_expiry_check CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '15 minutes'
  ),
  ADD CONSTRAINT provider_authorization_attempts_lifecycle_check CHECK (
    (
      status = 'pending'
      AND claimed_at IS NULL
      AND completed_at IS NULL
      AND error_code IS NULL
    )
    OR
    (
      status = 'exchanging'
      AND claimed_at IS NOT NULL
      AND completed_at IS NULL
      AND error_code IS NULL
    )
    OR
    (
      status = 'succeeded'
      AND claimed_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND error_code IS NULL
    )
    OR
    (
      status IN ('denied', 'failed', 'expired')
      AND completed_at IS NOT NULL
      AND error_code IS NOT NULL
    )
  );

ALTER TABLE provider_authorization_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_authorization_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_authorization_attempts_tenant_policy
  ON provider_authorization_attempts
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
    CREATE POLICY provider_authorization_attempts_maintenance_owner_policy
      ON provider_authorization_attempts
      FOR ALL
      TO reconai_migrator
      USING (current_user = 'reconai_migrator')
      WITH CHECK (current_user = 'reconai_migrator');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION validate_provider_authorization_attempt_insert()
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
      AND (
        NEW.provider = 'stripe'
        OR connections.external_account_id = NEW.requested_account_id
      )
  ) THEN
    RAISE EXCEPTION 'provider authorization connection authority is invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM memberships
    WHERE memberships.organization_id = NEW.organization_id
      AND memberships.id = NEW.requested_by_membership_id
      AND memberships.status = 'active'
  ) THEN
    RAISE EXCEPTION 'provider authorization requester is not an active membership';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_authorization_attempts_validate_insert
BEFORE INSERT ON provider_authorization_attempts
FOR EACH ROW EXECUTE FUNCTION validate_provider_authorization_attempt_insert();

CREATE OR REPLACE FUNCTION protect_provider_authorization_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    OLD.id,
    OLD.organization_id,
    OLD.connection_id,
    OLD.provider,
    OLD.state_sha256,
    OLD.requested_account_id,
    OLD.requested_by_membership_id,
    OLD.expires_at,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id,
    NEW.organization_id,
    NEW.connection_id,
    NEW.provider,
    NEW.state_sha256,
    NEW.requested_account_id,
    NEW.requested_by_membership_id,
    NEW.expires_at,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'provider authorization authority is immutable';
  END IF;

  IF OLD.status <> 'pending'
    AND NOT (OLD.status = 'exchanging' AND NEW.status IN ('succeeded', 'failed'))
  THEN
    RAISE EXCEPTION 'provider authorization attempt is terminal or already claimed';
  END IF;

  IF OLD.status = 'pending'
    AND NEW.status NOT IN ('exchanging', 'denied', 'failed', 'expired')
  THEN
    RAISE EXCEPTION 'provider authorization transition is invalid';
  END IF;

  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'provider authorization timestamp moved backwards';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_authorization_attempts_protect_authority
BEFORE UPDATE ON provider_authorization_attempts
FOR EACH ROW EXECUTE FUNCTION protect_provider_authorization_attempt();

CREATE OR REPLACE FUNCTION reject_provider_authorization_attempt_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'provider authorization evidence is append-only';
END;
$$;

CREATE TRIGGER provider_authorization_attempts_reject_delete
BEFORE DELETE ON provider_authorization_attempts
FOR EACH ROW EXECUTE FUNCTION reject_provider_authorization_attempt_delete();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT SELECT, INSERT, UPDATE ON provider_authorization_attempts TO reconai_app;
    REVOKE DELETE, TRUNCATE ON provider_authorization_attempts FROM reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE
      ON provider_authorization_attempts FROM reconai_worker;
  END IF;
END
$$;
