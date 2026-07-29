CREATE TYPE "public"."exception_status" AS ENUM('open', 'assigned', 'deferred', 'proposed', 'approved', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('invited', 'active', 'deactivated');--> statement-breakpoint
CREATE TYPE "public"."canonical_record_kind" AS ENUM('order', 'payment', 'refund', 'processing_fee', 'accounting_entry');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'partial', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."source_system" AS ENUM('shopify', 'stripe', 'accounting_csv');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"proposal_version" integer NOT NULL,
	"actor_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"correlation_id" uuid NOT NULL,
	"reason" text,
	"previous_value" jsonb,
	"new_value" jsonb,
	"version_context" jsonb NOT NULL,
	"previous_event_hash" char(64),
	"event_hash" char(64) NOT NULL,
	CONSTRAINT "audit_events_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "canonical_records" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"kind" "canonical_record_kind" NOT NULL,
	"source_event_id" uuid NOT NULL,
	"source" "source_system" NOT NULL,
	"external_object_type" text NOT NULL,
	"external_object_id" text NOT NULL,
	"source_timestamp" timestamp with time zone NOT NULL,
	"ingestion_timestamp" timestamp with time zone NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"connector_version" text NOT NULL,
	"normalizer_version" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"order_reference" text,
	"customer_reference" text,
	"normalized_data" jsonb NOT NULL,
	"content_sha256" char(64) NOT NULL,
	"is_incomplete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canonical_records_organization_id_id_version_pk" PRIMARY KEY("organization_id","id","version")
);
--> statement-breakpoint
CREATE TABLE "data_source_connections" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" "source_system" NOT NULL,
	"external_account_id" text NOT NULL,
	"status" text NOT NULL,
	"connector_version" text NOT NULL,
	"api_version" text,
	"encrypted_credential" text,
	"credential_key_version" text,
	"cursor" text,
	"last_successful_sync_at" timestamp with time zone,
	"last_verified_webhook_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_source_connections_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "exceptions" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"stable_key" char(64) NOT NULL,
	"first_run_id" uuid NOT NULL,
	"latest_run_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" "exception_status" NOT NULL,
	"severity" text NOT NULL,
	"record_references" jsonb NOT NULL,
	"amount_minor" bigint,
	"currency" char(3),
	"evidence" jsonb NOT NULL,
	"assignee_membership_id" uuid,
	"deferred_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exceptions_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"stable_key" char(64) NOT NULL,
	"rule_id" text NOT NULL,
	"rule_version" text NOT NULL,
	"record_references" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" "membership_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"business_time_zone" text DEFAULT 'UTC' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"ai_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"schema_version" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"correlation_id" uuid NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"stable_run_key" char(64) NOT NULL,
	"input_snapshot_hash" char(64) NOT NULL,
	"policy_version" text NOT NULL,
	"rule_set_version" text NOT NULL,
	"engine_version" text NOT NULL,
	"initiated_by" uuid NOT NULL,
	"status" "run_status" NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"input_count" integer DEFAULT 0 NOT NULL,
	"match_count" integer DEFAULT 0 NOT NULL,
	"exception_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_runs_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "resolution_proposals" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"exception_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"proposed_by" uuid,
	"proposal_type" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resolution_proposals_organization_id_id_version_pk" PRIMARY KEY("organization_id","id","version")
);
--> statement-breakpoint
CREATE TABLE "source_events" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid,
	"source" "source_system" NOT NULL,
	"external_event_id" text NOT NULL,
	"external_object_type" text NOT NULL,
	"external_object_id" text NOT NULL,
	"source_timestamp" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"connector_version" text NOT NULL,
	"api_version" text,
	"payload_object_key" text NOT NULL,
	"payload_sha256" char(64) NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_events_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_records" ADD CONSTRAINT "canonical_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source_connections" ADD CONSTRAINT "data_source_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_proposals" ADD CONSTRAINT "resolution_proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_events" ADD CONSTRAINT "source_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_actor_proposal_uidx" ON "approvals" USING btree ("organization_id","proposal_id","proposal_version","actor_id");--> statement-breakpoint
CREATE INDEX "audit_events_org_time_idx" ON "audit_events" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_org_resource_idx" ON "audit_events" USING btree ("organization_id","resource_type","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_source_normalizer_uidx" ON "canonical_records" USING btree ("organization_id","source_event_id","normalizer_version","kind","external_object_id");--> statement-breakpoint
CREATE INDEX "canonical_org_kind_time_idx" ON "canonical_records" USING btree ("organization_id","kind","effective_at");--> statement-breakpoint
CREATE INDEX "canonical_org_order_ref_idx" ON "canonical_records" USING btree ("organization_id","order_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_provider_account_uidx" ON "data_source_connections" USING btree ("provider","external_account_id");--> statement-breakpoint
CREATE INDEX "connections_org_status_idx" ON "data_source_connections" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "exceptions_stable_uidx" ON "exceptions" USING btree ("organization_id","stable_key");--> statement-breakpoint
CREATE INDEX "exceptions_org_queue_idx" ON "exceptions" USING btree ("organization_id","status","severity","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_stable_uidx" ON "matches" USING btree ("organization_id","stable_key");--> statement-breakpoint
CREATE INDEX "matches_org_run_idx" ON "matches" USING btree ("organization_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user_uidx" ON "memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_org_status_idx" ON "memberships" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_idempotency_uidx" ON "outbox_events" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox_events" USING btree ("published_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_runs_stable_uidx" ON "reconciliation_runs" USING btree ("organization_id","stable_run_key");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_org_created_idx" ON "reconciliation_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "resolution_proposals_org_exception_idx" ON "resolution_proposals" USING btree ("organization_id","exception_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_events_receipt_uidx" ON "source_events" USING btree ("organization_id","connection_id","source","external_event_id");--> statement-breakpoint
CREATE INDEX "source_events_org_object_idx" ON "source_events" USING btree ("organization_id","source","external_object_type","external_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_issuer_subject_uidx" ON "users" USING btree ("issuer","subject");