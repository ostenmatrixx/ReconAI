CREATE TABLE "exception_occurrences" (
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"exception_id" uuid NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exception_occurrences_organization_id_run_id_exception_id_pk" PRIMARY KEY("organization_id","run_id","exception_id")
);
--> statement-breakpoint
CREATE TABLE "match_occurrences" (
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_occurrences_organization_id_run_id_match_id_pk" PRIMARY KEY("organization_id","run_id","match_id")
);
--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD COLUMN "policy_snapshot_hash" char(64);--> statement-breakpoint
UPDATE "reconciliation_runs"
SET "policy_snapshot_hash" = "stable_run_key"
WHERE "policy_snapshot_hash" IS NULL;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ALTER COLUMN "policy_snapshot_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "exception_occurrences" ADD CONSTRAINT "exception_occurrences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_occurrences" ADD CONSTRAINT "exception_occurrences_run_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."reconciliation_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_occurrences" ADD CONSTRAINT "exception_occurrences_exception_fk" FOREIGN KEY ("organization_id","exception_id") REFERENCES "public"."exceptions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_occurrences" ADD CONSTRAINT "match_occurrences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_occurrences" ADD CONSTRAINT "match_occurrences_run_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."reconciliation_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_occurrences" ADD CONSTRAINT "match_occurrences_match_fk" FOREIGN KEY ("organization_id","match_id") REFERENCES "public"."matches"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exception_occurrences_org_exception_idx" ON "exception_occurrences" USING btree ("organization_id","exception_id");--> statement-breakpoint
CREATE INDEX "match_occurrences_org_match_idx" ON "match_occurrences" USING btree ("organization_id","match_id");
