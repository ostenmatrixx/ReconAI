CREATE TABLE "connector_credentials" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"encrypted_envelope" jsonb NOT NULL,
	"key_version" text NOT NULL,
	"envelope_sha256" char(64) NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"rotated_from_credential_id" uuid,
	"superseded_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_credentials_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "public"."data_source_connections"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_creator_membership_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "public"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_rotated_from_fk" FOREIGN KEY ("organization_id","rotated_from_credential_id") REFERENCES "public"."connector_credentials"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_credentials_active_purpose_uidx" ON "connector_credentials" USING btree ("organization_id","connection_id","purpose") WHERE "connector_credentials"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "connector_credentials_org_envelope_uidx" ON "connector_credentials" USING btree ("organization_id","envelope_sha256");--> statement-breakpoint
CREATE INDEX "connector_credentials_org_connection_created_idx" ON "connector_credentials" USING btree ("organization_id","connection_id","created_at");--> statement-breakpoint

ALTER TABLE connector_credentials
  ADD CONSTRAINT connector_credentials_purpose_check
    CHECK (purpose IN ('webhook_signing', 'api_read')),
  ADD CONSTRAINT connector_credentials_key_version_check
    CHECK (key_version ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
  ADD CONSTRAINT connector_credentials_envelope_sha256_check
    CHECK (envelope_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT connector_credentials_status_check
    CHECK (status IN ('active', 'superseded', 'revoked')),
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
    AND length(encrypted_envelope ->> 'ciphertext') BETWEEN 22 AND 683
    AND encrypted_envelope ->> 'ciphertext' ~ '^[A-Za-z0-9_-]+$'
    AND encrypted_envelope ->> 'tag' ~ '^[A-Za-z0-9_-]{22}$'
  ),
  ADD CONSTRAINT connector_credentials_lifecycle_check CHECK (
    (
      status = 'active'
      AND superseded_at IS NULL
      AND revoked_at IS NULL
    )
    OR
    (
      status = 'superseded'
      AND superseded_at IS NOT NULL
      AND revoked_at IS NULL
    )
    OR
    (
      status = 'revoked'
      AND superseded_at IS NULL
      AND revoked_at IS NOT NULL
    )
  );

ALTER TABLE data_source_connections
  DROP CONSTRAINT connections_credential_reference_check,
  DROP CONSTRAINT connections_api_credential_reference_check,
  ADD CONSTRAINT connections_credential_reference_check CHECK (
    credential_reference IS NULL
    OR credential_reference ~
      '^(env:RECONAI_CONNECTOR_[A-Z0-9_]{1,100}|sealed:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$'
  ),
  ADD CONSTRAINT connections_api_credential_reference_check CHECK (
    api_credential_reference IS NULL
    OR api_credential_reference ~
      '^(env:RECONAI_CONNECTOR_[A-Z0-9_]{1,100}|sealed:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$'
  );

ALTER TABLE connector_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_credentials FORCE ROW LEVEL SECURITY;

CREATE POLICY connector_credentials_tenant_policy
  ON connector_credentials
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
    CREATE POLICY connector_credentials_maintenance_owner_policy
      ON connector_credentials
      FOR ALL
      TO reconai_migrator
      USING (current_user = 'reconai_migrator')
      WITH CHECK (current_user = 'reconai_migrator');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION validate_connector_credential_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM data_source_connections AS connections
    WHERE connections.organization_id = NEW.organization_id
      AND connections.id = NEW.connection_id
      AND connections.provider::text = (NEW.encrypted_envelope ->> 'provider')
  ) THEN
    RAISE EXCEPTION 'connector credential provider does not match its connection';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM memberships
    WHERE memberships.organization_id = NEW.organization_id
      AND memberships.id = NEW.created_by_membership_id
      AND memberships.status = 'active'
  ) THEN
    RAISE EXCEPTION 'connector credential creator is not an active membership';
  END IF;

  IF NEW.rotated_from_credential_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM connector_credentials AS previous
      WHERE previous.organization_id = NEW.organization_id
        AND previous.id = NEW.rotated_from_credential_id
        AND previous.connection_id = NEW.connection_id
        AND previous.purpose = NEW.purpose
        AND previous.status = 'superseded'
    )
  THEN
    RAISE EXCEPTION 'connector credential rotation predecessor is invalid';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER connector_credentials_validate_insert
BEFORE INSERT ON connector_credentials
FOR EACH ROW EXECUTE FUNCTION validate_connector_credential_insert();

CREATE OR REPLACE FUNCTION protect_connector_credential()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    OLD.id,
    OLD.organization_id,
    OLD.connection_id,
    OLD.purpose,
    OLD.encrypted_envelope,
    OLD.key_version,
    OLD.envelope_sha256,
    OLD.created_by_membership_id,
    OLD.rotated_from_credential_id,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id,
    NEW.organization_id,
    NEW.connection_id,
    NEW.purpose,
    NEW.encrypted_envelope,
    NEW.key_version,
    NEW.envelope_sha256,
    NEW.created_by_membership_id,
    NEW.rotated_from_credential_id,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'connector credential authority and ciphertext are immutable';
  END IF;

  IF OLD.status <> 'active'
    OR NEW.status NOT IN ('superseded', 'revoked')
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'connector credential lifecycle transition is invalid';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER connector_credentials_protect_authority
BEFORE UPDATE ON connector_credentials
FOR EACH ROW EXECUTE FUNCTION protect_connector_credential();

CREATE OR REPLACE FUNCTION validate_sealed_connection_references()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.credential_reference ~ '^sealed:'
    AND NOT EXISTS (
      SELECT 1
      FROM connector_credentials
      WHERE organization_id = NEW.organization_id
        AND id = substring(NEW.credential_reference FROM 8)::uuid
        AND connection_id = NEW.id
        AND purpose = 'webhook_signing'
        AND status = 'active'
    )
  THEN
    RAISE EXCEPTION 'sealed webhook credential reference is not active for this connection';
  END IF;

  IF NEW.api_credential_reference ~ '^sealed:'
    AND NOT EXISTS (
      SELECT 1
      FROM connector_credentials
      WHERE organization_id = NEW.organization_id
        AND id = substring(NEW.api_credential_reference FROM 8)::uuid
        AND connection_id = NEW.id
        AND purpose = 'api_read'
        AND status = 'active'
    )
  THEN
    RAISE EXCEPTION 'sealed API credential reference is not active for this connection';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER connections_validate_sealed_credential_references
BEFORE INSERT OR UPDATE OF credential_reference, api_credential_reference
ON data_source_connections
FOR EACH ROW EXECUTE FUNCTION validate_sealed_connection_references();

CREATE OR REPLACE FUNCTION reject_referenced_connector_credential_retirement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'active'
    AND EXISTS (
      SELECT 1
      FROM data_source_connections
      WHERE organization_id = NEW.organization_id
        AND id = NEW.connection_id
        AND (
          credential_reference = 'sealed:' || NEW.id::text
          OR api_credential_reference = 'sealed:' || NEW.id::text
        )
    )
  THEN
    RAISE EXCEPTION 'retired connector credential remains referenced by its connection';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER connector_credentials_reject_referenced_retirement
AFTER UPDATE OF status ON connector_credentials
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION reject_referenced_connector_credential_retirement();

CREATE OR REPLACE FUNCTION reject_connector_credential_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'connector credential evidence is append-only';
END;
$$;

CREATE TRIGGER connector_credentials_reject_delete
BEFORE DELETE ON connector_credentials
FOR EACH ROW EXECUTE FUNCTION reject_connector_credential_delete();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT SELECT, INSERT, UPDATE ON connector_credentials TO reconai_app;
    REVOKE DELETE, TRUNCATE ON connector_credentials FROM reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    GRANT SELECT ON connector_credentials TO reconai_worker;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON connector_credentials FROM reconai_worker;
  END IF;
END
$$;
