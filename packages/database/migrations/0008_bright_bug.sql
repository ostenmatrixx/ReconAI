ALTER TABLE "data_source_connections" ADD COLUMN "credential_reference" text;--> statement-breakpoint
ALTER TABLE "source_events" ADD COLUMN "last_error_code" text;