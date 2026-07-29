CREATE TABLE "reconciliation_run_inputs" (
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"record_version" integer NOT NULL,
	"content_sha256" char(64) NOT NULL,
	"ordinal" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_run_inputs_organization_id_run_id_record_id_record_version_pk" PRIMARY KEY("organization_id","run_id","record_id","record_version")
);
--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD COLUMN "policy_snapshot" jsonb;--> statement-breakpoint
UPDATE "reconciliation_runs"
SET "policy_snapshot" = jsonb_build_object(
  'version', "policy_version",
  'migrationState', 'legacy_snapshot_unavailable'
);--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ALTER COLUMN "policy_snapshot" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD COLUMN "dispatch_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "reconciliation_run_inputs" ADD CONSTRAINT "reconciliation_run_inputs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_run_inputs" ADD CONSTRAINT "reconciliation_run_inputs_run_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."reconciliation_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_run_inputs" ADD CONSTRAINT "reconciliation_run_inputs_record_fk" FOREIGN KEY ("organization_id","record_id","record_version") REFERENCES "public"."canonical_records"("organization_id","id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_run_inputs_org_run_ordinal_uidx" ON "reconciliation_run_inputs" USING btree ("organization_id","run_id","ordinal");--> statement-breakpoint
CREATE INDEX "reconciliation_run_inputs_org_record_idx" ON "reconciliation_run_inputs" USING btree ("organization_id","record_id","record_version");
