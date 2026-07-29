CREATE TABLE "exception_notes" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"exception_id" uuid NOT NULL,
	"author_membership_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exception_notes_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "exception_notes" ADD CONSTRAINT "exception_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_notes" ADD CONSTRAINT "exception_notes_exception_fk" FOREIGN KEY ("organization_id","exception_id") REFERENCES "public"."exceptions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_notes" ADD CONSTRAINT "exception_notes_author_membership_fk" FOREIGN KEY ("organization_id","author_membership_id") REFERENCES "public"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exception_notes_org_exception_idx" ON "exception_notes" USING btree ("organization_id","exception_id","created_at");