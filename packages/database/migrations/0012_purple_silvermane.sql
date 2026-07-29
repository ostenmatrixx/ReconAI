CREATE TABLE "canonical_field_provenance" (
	"organization_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"record_version" integer NOT NULL,
	"field_path" text NOT NULL,
	"source_event_id" uuid NOT NULL,
	"source_value_reference" text NOT NULL,
	"normalized_value" jsonb NOT NULL,
	"transformation_rule" text NOT NULL,
	"transformation_version" text NOT NULL,
	"warnings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canonical_field_provenance_organization_id_record_id_record_version_field_path_pk" PRIMARY KEY("organization_id","record_id","record_version","field_path")
);
--> statement-breakpoint
ALTER TABLE "canonical_field_provenance" ADD CONSTRAINT "canonical_field_provenance_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_field_provenance" ADD CONSTRAINT "canonical_field_provenance_record_fk" FOREIGN KEY ("organization_id","record_id","record_version") REFERENCES "public"."canonical_records"("organization_id","id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_field_provenance" ADD CONSTRAINT "canonical_field_provenance_source_event_fk" FOREIGN KEY ("organization_id","source_event_id") REFERENCES "public"."source_events"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canonical_field_provenance_org_source_idx" ON "canonical_field_provenance" USING btree ("organization_id","source_event_id");