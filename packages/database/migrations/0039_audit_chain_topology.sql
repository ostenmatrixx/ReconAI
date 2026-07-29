ALTER TABLE "audit_events" ADD COLUMN "hash_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM audit_events
    WHERE event_hash !~ '^[a-f0-9]{64}$'
       OR (previous_event_hash IS NOT NULL AND previous_event_hash !~ '^[a-f0-9]{64}$')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'audit chain upgrade blocked: invalid SHA-256 hash format';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM audit_events
    GROUP BY organization_id, event_hash
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'audit chain upgrade blocked: duplicate tenant event hash';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM audit_events
    WHERE previous_event_hash IS NOT NULL
    GROUP BY organization_id, previous_event_hash
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'audit chain upgrade blocked: forked tenant predecessor';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM audit_events
    WHERE event_hash = previous_event_hash
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'audit chain upgrade blocked: self-referencing event';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM audit_events
    GROUP BY organization_id
    HAVING count(*) FILTER (WHERE previous_event_hash IS NULL) <> 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'audit chain upgrade blocked: tenant must have exactly one genesis event';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM audit_events child
    LEFT JOIN audit_events parent
      ON parent.organization_id = child.organization_id
     AND parent.event_hash = child.previous_event_hash
    WHERE child.previous_event_hash IS NOT NULL
      AND parent.id IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'audit chain upgrade blocked: orphaned predecessor hash';
  END IF;

  IF EXISTS (
    WITH RECURSIVE reachable(organization_id, event_hash) AS (
      SELECT organization_id, event_hash
      FROM audit_events
      WHERE previous_event_hash IS NULL
      UNION
      SELECT child.organization_id, child.event_hash
      FROM audit_events child
      JOIN reachable parent
        ON parent.organization_id = child.organization_id
       AND parent.event_hash = child.previous_event_hash
    )
    SELECT 1
    FROM audit_events event
    LEFT JOIN reachable
      ON reachable.organization_id = event.organization_id
     AND reachable.event_hash = event.event_hash
    WHERE reachable.event_hash IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'audit chain upgrade blocked: unreachable event or disconnected cycle';
  END IF;
END
$$;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_org_event_hash_uidx" ON "audit_events" USING btree ("organization_id","event_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_org_previous_hash_uidx" ON "audit_events" USING btree ("organization_id","previous_event_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_org_genesis_uidx" ON "audit_events" USING btree ("organization_id") WHERE "audit_events"."previous_event_hash" is null;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_previous_hash_fk" FOREIGN KEY ("organization_id","previous_event_hash") REFERENCES "public"."audit_events"("organization_id","event_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_hash_format_check" CHECK ("audit_events"."event_hash" ~ '^[a-f0-9]{64}$'
        and ("audit_events"."previous_event_hash" is null or "audit_events"."previous_event_hash" ~ '^[a-f0-9]{64}$')
        and "audit_events"."event_hash" is distinct from "audit_events"."previous_event_hash");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_hash_version_check" CHECK ("audit_events"."hash_version" in (1, 2));--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.audit_events_validate_linear_append()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text, 0));

  IF EXISTS (
    SELECT 1
    FROM public.audit_events existing
    WHERE existing.organization_id = NEW.organization_id
      AND existing.id = NEW.id
      AND existing.event_hash = NEW.event_hash
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.previous_event_hash IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.audit_events existing
      WHERE existing.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'audit append rejected: tenant chain already has a genesis event';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.audit_events parent
    WHERE parent.organization_id = NEW.organization_id
      AND parent.event_hash = NEW.previous_event_hash
      AND NOT EXISTS (
        SELECT 1
        FROM public.audit_events child
        WHERE child.organization_id = parent.organization_id
          AND child.previous_event_hash = parent.event_hash
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'audit append rejected: predecessor is not the tenant chain head';
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_events_validate_linear_append ON audit_events;--> statement-breakpoint
CREATE TRIGGER audit_events_validate_linear_append
BEFORE INSERT ON audit_events
FOR EACH ROW
EXECUTE FUNCTION public.audit_events_validate_linear_append();--> statement-breakpoint
REVOKE ALL ON FUNCTION public.audit_events_validate_linear_append() FROM PUBLIC;
