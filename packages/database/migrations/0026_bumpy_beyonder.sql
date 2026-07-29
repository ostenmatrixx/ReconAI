ALTER TYPE "public"."import_status" ADD VALUE 'rolled_back';--> statement-breakpoint
CREATE TABLE "canonical_record_supersessions" (
	"organization_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"record_version" integer NOT NULL,
	"source_import_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"correlation_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"superseded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canonical_record_supersessions_organization_id_record_id_record_version_pk" PRIMARY KEY("organization_id","record_id","record_version")
);
--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "rolled_back_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "superseded_record_count" integer;--> statement-breakpoint
ALTER TABLE "canonical_record_supersessions" ADD CONSTRAINT "canonical_record_supersessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_record_supersessions" ADD CONSTRAINT "canonical_record_supersessions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_record_supersessions" ADD CONSTRAINT "canonical_record_supersessions_record_fk" FOREIGN KEY ("organization_id","record_id","record_version") REFERENCES "public"."canonical_records"("organization_id","id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_record_supersessions" ADD CONSTRAINT "canonical_record_supersessions_import_fk" FOREIGN KEY ("organization_id","source_import_id") REFERENCES "public"."imports"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canonical_record_supersessions_org_import_idx" ON "canonical_record_supersessions" USING btree ("organization_id","source_import_id");

-- A rollback appends tenant-scoped supersession evidence. It never mutates source or canonical rows.
ALTER TABLE canonical_record_supersessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE canonical_record_supersessions FORCE ROW LEVEL SECURITY;

CREATE POLICY canonical_record_supersessions_tenant_policy
  ON canonical_record_supersessions
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

ALTER TABLE canonical_record_supersessions
  ADD CONSTRAINT canonical_record_supersessions_version_check CHECK (record_version > 0),
  ADD CONSTRAINT canonical_record_supersessions_reason_check
    CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 2000);

ALTER TABLE imports
  ADD CONSTRAINT imports_rollback_state_check CHECK (
    (
      status::text = 'rolled_back'
      AND rolled_back_at IS NOT NULL
      AND superseded_record_count IS NOT NULL
      AND superseded_record_count >= 0
    )
    OR
    (
      status::text <> 'rolled_back'
      AND rolled_back_at IS NULL
      AND superseded_record_count IS NULL
    )
  );

CREATE OR REPLACE FUNCTION reject_canonical_record_supersession_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'canonical record supersessions are append-only';
END;
$$;

CREATE TRIGGER canonical_record_supersessions_reject_update_delete
BEFORE UPDATE OR DELETE ON canonical_record_supersessions
FOR EACH ROW EXECUTE FUNCTION reject_canonical_record_supersession_mutation();

CREATE OR REPLACE FUNCTION enforce_import_rollback_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status::text = 'rolled_back' THEN
    RAISE EXCEPTION 'a rolled-back import is terminal';
  END IF;

  IF NEW.status::text = 'rolled_back' AND OLD.status::text <> 'succeeded' THEN
    RAISE EXCEPTION 'only a succeeded import can be rolled back';
  END IF;

  IF NEW.status::text <> 'rolled_back' AND (
    NEW.rolled_back_at IS NOT NULL OR NEW.superseded_record_count IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'import rollback metadata requires rolled-back status';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER imports_enforce_rollback_transition
BEFORE UPDATE ON imports
FOR EACH ROW EXECUTE FUNCTION enforce_import_rollback_transition();

CREATE OR REPLACE FUNCTION reject_canonical_insert_for_rolled_back_import()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_import_status text;
BEGIN
  SELECT imports.status::text
  INTO source_import_status
  FROM source_events
  JOIN imports
    ON imports.organization_id = source_events.organization_id
   AND imports.id = source_events.import_id
  WHERE source_events.organization_id = NEW.organization_id
    AND source_events.id = NEW.source_event_id
  FOR SHARE OF imports;

  IF source_import_status = 'rolled_back' THEN
    RAISE EXCEPTION 'a rolled-back import cannot create new canonical versions';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER canonical_records_reject_rolled_back_import_insert
BEFORE INSERT ON canonical_records
FOR EACH ROW EXECUTE FUNCTION reject_canonical_insert_for_rolled_back_import();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT SELECT, INSERT ON canonical_record_supersessions TO reconai_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON canonical_record_supersessions FROM reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    GRANT SELECT ON canonical_record_supersessions TO reconai_worker;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON canonical_record_supersessions
      FROM reconai_worker;
  END IF;
END
$$;
