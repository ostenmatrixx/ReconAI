ALTER TABLE "organizations" ADD COLUMN "dual_approval_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "dual_approval_thresholds" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "sensitive_resolution_types" jsonb DEFAULT '["write_off","manual_override","document_external_payment"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "resolution_proposals" ADD COLUMN "required_approvals" integer DEFAULT 1 NOT NULL;