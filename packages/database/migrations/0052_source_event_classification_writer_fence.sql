-- Add an opt-in, one-way database fence for source-classification-aware writers.
-- Every source-event insert takes a shared transaction advisory lock. Activation takes the
-- corresponding exclusive lock, so it waits for in-flight writers, checks zero operational
-- classification gaps, and then prevents any later operational receipt from committing without
-- one exact V1 classification in the same transaction.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_maintenance') THEN
    RAISE EXCEPTION 'reconai_maintenance role is required before migration 0052';
  END IF;
END
$$;

CREATE TABLE public.source_event_classification_writer_fence_activations (
  id uuid PRIMARY KEY,
  singleton boolean NOT NULL DEFAULT true,
  requested_by text NOT NULL,
  reason text NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  fence_version text NOT NULL DEFAULT 'source-classification-writer-fence-v1',
  CONSTRAINT source_event_classification_writer_fence_singleton_check
    CHECK (singleton),
  CONSTRAINT source_event_classification_writer_fence_singleton_unique
    UNIQUE (singleton),
  CONSTRAINT source_event_classification_writer_fence_requested_by_check
    CHECK (requested_by ~ '^[A-Za-z0-9][A-Za-z0-9@._:/-]{2,99}$'),
  CONSTRAINT source_event_classification_writer_fence_reason_check
    CHECK (
      char_length(reason) BETWEEN 20 AND 500
      AND reason !~ '[[:cntrl:]]'
    ),
  CONSTRAINT source_event_classification_writer_fence_version_check
    CHECK (fence_version = 'source-classification-writer-fence-v1')
);

-- The activation scan is cross-tenant by design, but the forced-RLS exception is usable only while
-- the migration-owned SECURITY DEFINER function is invoked from the dedicated maintenance login.
-- A direct migrator session does not satisfy session_user and normal app/worker sessions never
-- become current_user = reconai_migrator.
CREATE POLICY source_events_classification_writer_fence_activation_owner_policy
  ON public.source_events
  FOR SELECT
  TO reconai_migrator
  USING (
    current_user = 'reconai_migrator'
    AND session_user = 'reconai_maintenance'
  );

CREATE OR REPLACE FUNCTION public.reject_source_event_classification_writer_fence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'source event classification writer fence activation is append-only';
END;
$$;

CREATE TRIGGER source_event_classification_writer_fence_reject_update_delete
BEFORE UPDATE OR DELETE ON public.source_event_classification_writer_fence_activations
FOR EACH ROW EXECUTE FUNCTION public.reject_source_event_classification_writer_fence_mutation();

CREATE OR REPLACE FUNCTION public.lock_source_event_classification_writer_fence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('reconai:source-event-classification-writer-fence:v1', 0)
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER source_events_classification_writer_fence_shared_lock
BEFORE INSERT ON public.source_events
FOR EACH ROW EXECUTE FUNCTION public.lock_source_event_classification_writer_fence();

CREATE OR REPLACE FUNCTION public.require_fenced_source_event_classification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_object_families text[];
  v_classifier_version text;
BEGIN
  IF NEW.source = 'shopify'
    AND NEW.external_object_type IN (
      'customers/data_request',
      'customers/redact',
      'shop/redact'
    )
  THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.source_event_classification_writer_fence_activations
    WHERE singleton
  ) THEN
    RETURN NEW;
  END IF;

  SELECT classifications.object_families, classifications.classifier_version
  INTO v_object_families, v_classifier_version
  FROM public.source_event_object_classifications AS classifications
  WHERE classifications.organization_id = NEW.organization_id
    AND classifications.source_event_id = NEW.id;

  IF v_classifier_version IS DISTINCT FROM 'source-object-family-v1' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'source event classification writer fence rejected an unclassified receipt';
  END IF;

  IF NOT (
    (
      NEW.source = 'accounting_csv'
      AND v_object_families = ARRAY['csv_row']::text[]
    )
    OR (
      NEW.source = 'shopify'
      AND (
        (
          NEW.external_object_type IN ('orders/create', 'orders/updated')
          AND v_object_families = ARRAY['order']::text[]
        )
        OR (
          NEW.external_object_type = 'refunds/create'
          AND v_object_families = ARRAY['refund_transaction']::text[]
        )
        OR (
          NEW.external_object_type = 'orders/snapshot'
          AND v_object_families IN (
            ARRAY['order']::text[],
            ARRAY['order', 'refund_transaction']::text[]
          )
        )
      )
    )
    OR (
      NEW.source = 'stripe'
      AND (
        (
          NEW.external_object_type IN (
            'payment_intent.amount_capturable_updated',
            'payment_intent.canceled',
            'payment_intent.payment_failed',
            'payment_intent.processing',
            'payment_intent.succeeded'
          )
          AND v_object_families = ARRAY['payment_intent']::text[]
        )
        OR (
          NEW.external_object_type IN ('refund.created', 'refund.failed', 'refund.updated')
          AND v_object_families = ARRAY['refund']::text[]
        )
        OR (
          NEW.external_object_type = 'balance_transaction.snapshot'
          AND v_object_families = ARRAY['balance_transaction']::text[]
        )
      )
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'source event classification writer fence rejected incompatible evidence';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER source_events_require_classification_when_fenced
AFTER INSERT ON public.source_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.require_fenced_source_event_classification();

CREATE OR REPLACE FUNCTION public.reconai_activate_source_event_classification_writer_fence(
  p_activation_id uuid,
  p_requested_by text,
  p_reason text,
  p_confirmation text
)
RETURNS TABLE (
  changed boolean,
  activation_id uuid,
  activated_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_existing public.source_event_classification_writer_fence_activations%ROWTYPE;
BEGIN
  IF session_user <> 'reconai_maintenance' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'source event classification writer fence activation requires maintenance';
  END IF;

  IF p_confirmation IS DISTINCT FROM 'ENABLE-SOURCE-CLASSIFICATION-WRITER-FENCE'
    OR p_activation_id IS NULL
    OR p_requested_by !~ '^[A-Za-z0-9][A-Za-z0-9@._:/-]{2,99}$'
    OR char_length(p_reason) NOT BETWEEN 20 AND 500
    OR p_reason ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION 'source event classification writer fence activation input is invalid';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('reconai:source-event-classification-writer-fence:v1', 0)
  );

  SELECT *
  INTO v_existing
  FROM public.source_event_classification_writer_fence_activations
  WHERE singleton;

  IF FOUND THEN
    RETURN QUERY SELECT false, v_existing.id, v_existing.activated_at;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.source_events AS events
    WHERE (
        events.source IN ('stripe', 'accounting_csv')
        OR (
          events.source = 'shopify'
          AND events.external_object_type NOT IN (
            'customers/data_request',
            'customers/redact',
            'shop/redact'
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.source_event_object_classifications AS classifications
        WHERE classifications.organization_id = events.organization_id
          AND classifications.source_event_id = events.id
          AND classifications.classifier_version = 'source-object-family-v1'
          AND (
            (
              events.source = 'accounting_csv'
              AND classifications.object_families = ARRAY['csv_row']::text[]
            )
            OR (
              events.source = 'shopify'
              AND (
                (
                  events.external_object_type IN ('orders/create', 'orders/updated')
                  AND classifications.object_families = ARRAY['order']::text[]
                )
                OR (
                  events.external_object_type = 'refunds/create'
                  AND classifications.object_families = ARRAY['refund_transaction']::text[]
                )
                OR (
                  events.external_object_type = 'orders/snapshot'
                  AND classifications.object_families IN (
                    ARRAY['order']::text[],
                    ARRAY['order', 'refund_transaction']::text[]
                  )
                )
              )
            )
            OR (
              events.source = 'stripe'
              AND (
                (
                  events.external_object_type IN (
                    'payment_intent.amount_capturable_updated',
                    'payment_intent.canceled',
                    'payment_intent.payment_failed',
                    'payment_intent.processing',
                    'payment_intent.succeeded'
                  )
                  AND classifications.object_families = ARRAY['payment_intent']::text[]
                )
                OR (
                  events.external_object_type IN (
                    'refund.created',
                    'refund.failed',
                    'refund.updated'
                  )
                  AND classifications.object_families = ARRAY['refund']::text[]
                )
                OR (
                  events.external_object_type = 'balance_transaction.snapshot'
                  AND classifications.object_families = ARRAY['balance_transaction']::text[]
                )
              )
            )
          )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'source event classification writer fence activation requires zero compatible gaps';
  END IF;

  INSERT INTO public.source_event_classification_writer_fence_activations (
    id,
    requested_by,
    reason
  ) VALUES (
    p_activation_id,
    p_requested_by,
    p_reason
  )
  RETURNING
    true,
    source_event_classification_writer_fence_activations.id,
    source_event_classification_writer_fence_activations.activated_at
  INTO changed, activation_id, activated_at;

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.reconai_source_event_classification_writer_fence_status()
RETURNS TABLE (
  enabled boolean,
  activation_id uuid,
  activated_at timestamptz,
  fence_version text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT
    activations.id IS NOT NULL,
    activations.id,
    activations.activated_at,
    coalesce(
      activations.fence_version,
      'source-classification-writer-fence-v1'
    )
  FROM (SELECT true) AS singleton
  LEFT JOIN public.source_event_classification_writer_fence_activations AS activations
    ON activations.singleton
$$;

REVOKE ALL ON public.source_event_classification_writer_fence_activations FROM PUBLIC;
REVOKE ALL ON public.source_event_classification_writer_fence_activations
FROM reconai_app, reconai_worker, reconai_maintenance;

REVOKE ALL ON FUNCTION
  public.reject_source_event_classification_writer_fence_mutation()
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.lock_source_event_classification_writer_fence()
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.require_fenced_source_event_classification()
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.reconai_activate_source_event_classification_writer_fence(uuid, text, text, text)
FROM PUBLIC, reconai_app, reconai_worker;
REVOKE ALL ON FUNCTION
  public.reconai_source_event_classification_writer_fence_status()
FROM PUBLIC, reconai_app, reconai_worker;

GRANT EXECUTE ON FUNCTION
  public.reconai_activate_source_event_classification_writer_fence(uuid, text, text, text)
TO reconai_maintenance;
GRANT EXECUTE ON FUNCTION
  public.reconai_source_event_classification_writer_fence_status()
TO reconai_maintenance;
