CREATE TABLE "exception_status_events" (
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"exception_id" uuid NOT NULL,
	"previous_status" "exception_status",
	"next_status" "exception_status" NOT NULL,
	"reason_code" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exception_status_events_organization_id_run_id_exception_id_pk" PRIMARY KEY("organization_id","run_id","exception_id")
);
--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD COLUMN "operational_state_applied" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "exception_status_events" ADD CONSTRAINT "exception_status_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_status_events" ADD CONSTRAINT "exception_status_events_run_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."reconciliation_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_status_events" ADD CONSTRAINT "exception_status_events_exception_fk" FOREIGN KEY ("organization_id","exception_id") REFERENCES "public"."exceptions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exception_status_events_org_exception_idx" ON "exception_status_events" USING btree ("organization_id","exception_id","occurred_at");