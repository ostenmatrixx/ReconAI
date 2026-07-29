CREATE TYPE "public"."import_status" AS ENUM('previewed', 'validation_failed', 'queued', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"source" "source_system" DEFAULT 'accounting_csv' NOT NULL,
	"object_key" text NOT NULL,
	"payload_sha256" char(64) NOT NULL,
	"byte_count" integer NOT NULL,
	"content_type" text NOT NULL,
	"original_filename" text NOT NULL,
	"template_version" text NOT NULL,
	"mapping_version" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"status" "import_status" NOT NULL,
	"idempotency_key" char(64) NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"valid_row_count" integer DEFAULT 0 NOT NULL,
	"invalid_row_count" integer DEFAULT 0 NOT NULL,
	"preview_rows" jsonb NOT NULL,
	"preview_errors" jsonb NOT NULL,
	"errors_truncated" boolean DEFAULT false NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imports_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "source_events" ADD COLUMN "import_id" uuid;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "public"."data_source_connections"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "imports_idempotency_uidx" ON "imports" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "imports_org_status_idx" ON "imports" USING btree ("organization_id","status","created_at");--> statement-breakpoint
ALTER TABLE "source_events" ADD CONSTRAINT "source_events_import_fk" FOREIGN KEY ("organization_id","import_id") REFERENCES "public"."imports"("organization_id","id") ON DELETE no action ON UPDATE no action;