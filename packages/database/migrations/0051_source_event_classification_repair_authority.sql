-- Add a fixed maintenance-only authority for bounded repair of pre-classifier source receipts.
-- The functions expose one immutable candidate at a time, keep a source-row lock across verified
-- object inspection, and accept only exact V1 provider/family shapes. They never inspect payload
-- bytes, infer a Shopify snapshot from its topic, or bypass the caller's object-integrity check.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_maintenance') THEN
    RAISE EXCEPTION 'reconai_maintenance role is required before migration 0051';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_migrator') THEN
    CREATE POLICY source_events_classification_repair_owner_policy
      ON public.source_events
      FOR UPDATE
      TO reconai_migrator
      USING (current_user = 'reconai_migrator');

    CREATE POLICY source_event_object_classifications_repair_owner_policy
      ON public.source_event_object_classifications
      FOR SELECT
      TO reconai_migrator
      USING (current_user = 'reconai_migrator');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.reconai_claim_source_event_classification_repair_candidate()
RETURNS TABLE (
  organization_id uuid,
  source_event_id uuid,
  connection_id uuid,
  source text,
  event_type text,
  payload_object_key text,
  payload_sha256 text
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT
    source_events.organization_id,
    source_events.id,
    source_events.connection_id,
    source_events.source::text,
    source_events.external_object_type,
    source_events.payload_object_key,
    source_events.payload_sha256::text
  FROM public.source_events
  WHERE NOT EXISTS (
      SELECT 1
      FROM public.source_event_object_classifications AS classifications
      WHERE classifications.organization_id = source_events.organization_id
        AND classifications.source_event_id = source_events.id
    )
    AND (
      source_events.source = 'accounting_csv'
      OR (
        source_events.source = 'shopify'
        AND source_events.external_object_type IN (
          'orders/create',
          'orders/updated',
          'orders/snapshot',
          'refunds/create'
        )
      )
      OR (
        source_events.source = 'stripe'
        AND source_events.external_object_type IN (
          'payment_intent.amount_capturable_updated',
          'payment_intent.canceled',
          'payment_intent.payment_failed',
          'payment_intent.processing',
          'payment_intent.succeeded',
          'refund.created',
          'refund.failed',
          'refund.updated',
          'balance_transaction.snapshot'
        )
      )
    )
  ORDER BY
    source_events.payload_object_key,
    source_events.received_at,
    source_events.id
  LIMIT 1
  FOR UPDATE OF source_events SKIP LOCKED
$$;

CREATE OR REPLACE FUNCTION public.reconai_source_event_classification_repair_gap_counts()
RETURNS TABLE (
  total_gaps bigint,
  repairable_gaps bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT
    count(*) FILTER (
      WHERE
        source_events.source IN ('stripe', 'accounting_csv')
        OR (
          source_events.source = 'shopify'
          AND source_events.external_object_type NOT IN (
            'customers/data_request',
            'customers/redact',
            'shop/redact'
          )
        )
    ) AS total_gaps,
    count(*) FILTER (
      WHERE
        source_events.source = 'accounting_csv'
        OR (
          source_events.source = 'shopify'
          AND source_events.external_object_type IN (
            'orders/create',
            'orders/updated',
            'orders/snapshot',
            'refunds/create'
          )
        )
        OR (
          source_events.source = 'stripe'
          AND source_events.external_object_type IN (
            'payment_intent.amount_capturable_updated',
            'payment_intent.canceled',
            'payment_intent.payment_failed',
            'payment_intent.processing',
            'payment_intent.succeeded',
            'refund.created',
            'refund.failed',
            'refund.updated',
            'balance_transaction.snapshot'
          )
        )
    ) AS repairable_gaps
  FROM public.source_events
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.source_event_object_classifications AS classifications
    WHERE classifications.organization_id = source_events.organization_id
      AND classifications.source_event_id = source_events.id
  )
$$;

CREATE OR REPLACE FUNCTION public.reconai_prepare_source_event_classification_repair_audit(
  p_organization_id uuid,
  p_source_event_id uuid,
  p_connection_id uuid,
  p_source text,
  p_event_type text,
  p_payload_object_key text,
  p_payload_sha256 text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_head_count integer;
  v_previous_event_hash text;
BEGIN
  PERFORM 1
  FROM public.source_events
  WHERE organization_id = p_organization_id
    AND id = p_source_event_id
    AND connection_id = p_connection_id
    AND source::text = p_source
    AND external_object_type = p_event_type
    AND payload_object_key = p_payload_object_key
    AND payload_sha256::text = p_payload_sha256
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'source event classification repair authority changed';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text, 0));

  SELECT count(*)::integer, min(head.event_hash)
  INTO v_head_count, v_previous_event_hash
  FROM (
    SELECT candidate.event_hash
    FROM public.audit_events AS candidate
    WHERE candidate.organization_id = p_organization_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.audit_events AS child
        WHERE child.organization_id = candidate.organization_id
          AND child.previous_event_hash = candidate.event_hash
      )
    ORDER BY candidate.event_hash
    LIMIT 2
  ) AS head;

  IF v_head_count > 1 THEN
    RAISE EXCEPTION 'source event classification repair audit chain has multiple heads';
  END IF;

  IF v_head_count = 0 AND EXISTS (
    SELECT 1
    FROM public.audit_events
    WHERE organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'source event classification repair audit chain has no head';
  END IF;

  RETURN v_previous_event_hash;
END;
$$;

CREATE OR REPLACE FUNCTION public.reconai_record_source_event_classification_repair(
  p_organization_id uuid,
  p_source_event_id uuid,
  p_connection_id uuid,
  p_source text,
  p_event_type text,
  p_payload_object_key text,
  p_payload_sha256 text,
  p_object_families text[],
  p_audit_id uuid,
  p_repair_run_id uuid,
  p_requested_by text,
  p_reason text,
  p_repaired_at timestamptz,
  p_previous_event_hash text,
  p_event_hash text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_existing_families text[];
  v_inserted boolean;
BEGIN
  PERFORM 1
  FROM public.source_events
  WHERE organization_id = p_organization_id
    AND id = p_source_event_id
    AND connection_id = p_connection_id
    AND source::text = p_source
    AND external_object_type = p_event_type
    AND payload_object_key = p_payload_object_key
    AND payload_sha256::text = p_payload_sha256
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'source event classification repair authority changed';
  END IF;

  IF NOT (
    (
      p_source = 'accounting_csv'
      AND p_object_families = ARRAY['csv_row']::text[]
    )
    OR (
      p_source = 'shopify'
      AND (
        (
          p_event_type IN ('orders/create', 'orders/updated')
          AND p_object_families = ARRAY['order']::text[]
        )
        OR (
          p_event_type = 'refunds/create'
          AND p_object_families = ARRAY['refund_transaction']::text[]
        )
        OR (
          p_event_type = 'orders/snapshot'
          AND p_object_families IN (
            ARRAY['order']::text[],
            ARRAY['order', 'refund_transaction']::text[]
          )
        )
      )
    )
    OR (
      p_source = 'stripe'
      AND (
        (
          p_event_type IN (
            'payment_intent.amount_capturable_updated',
            'payment_intent.canceled',
            'payment_intent.payment_failed',
            'payment_intent.processing',
            'payment_intent.succeeded'
          )
          AND p_object_families = ARRAY['payment_intent']::text[]
        )
        OR (
          p_event_type IN ('refund.created', 'refund.failed', 'refund.updated')
          AND p_object_families = ARRAY['refund']::text[]
        )
        OR (
          p_event_type = 'balance_transaction.snapshot'
          AND p_object_families = ARRAY['balance_transaction']::text[]
        )
      )
    )
  ) THEN
    RAISE EXCEPTION 'source event classification repair family is incompatible';
  END IF;

  IF p_requested_by !~ '^[A-Za-z0-9][A-Za-z0-9@._:/-]{2,99}$'
    OR char_length(p_reason) NOT BETWEEN 20 AND 500
    OR p_reason ~ '[[:cntrl:]]'
    OR (p_previous_event_hash IS NOT NULL AND p_previous_event_hash !~ '^[a-f0-9]{64}$')
    OR p_event_hash !~ '^[a-f0-9]{64}$'
    OR p_event_hash IS NOT DISTINCT FROM p_previous_event_hash
  THEN
    RAISE EXCEPTION 'source event classification repair audit input is invalid';
  END IF;

  INSERT INTO public.source_event_object_classifications (
    organization_id,
    source_event_id,
    object_families,
    classifier_version
  ) VALUES (
    p_organization_id,
    p_source_event_id,
    p_object_families,
    'source-object-family-v1'
  )
  ON CONFLICT (organization_id, source_event_id) DO NOTHING
  RETURNING true INTO v_inserted;

  IF coalesce(v_inserted, false) THEN
    INSERT INTO public.audit_events (
      id,
      organization_id,
      actor_type,
      actor_id,
      action,
      resource_type,
      resource_id,
      occurred_at,
      correlation_id,
      reason,
      previous_value,
      new_value,
      version_context,
      previous_event_hash,
      event_hash,
      hash_version
    ) VALUES (
      p_audit_id,
      p_organization_id,
      'system',
      p_requested_by,
      'source_event.classification_repaired',
      'source_event',
      p_source_event_id::text,
      p_repaired_at,
      p_repair_run_id,
      p_reason,
      NULL,
      jsonb_build_object(
        'source', p_source,
        'eventType', p_event_type,
        'objectFamilies', to_jsonb(p_object_families)
      ),
      jsonb_build_object(
        'repairVersion', 'source-object-family-repair-v1',
        'classifierVersion', 'source-object-family-v1'
      ),
      p_previous_event_hash,
      p_event_hash,
      2
    );
    RETURN true;
  END IF;

  SELECT object_families
  INTO v_existing_families
  FROM public.source_event_object_classifications
  WHERE organization_id = p_organization_id
    AND source_event_id = p_source_event_id
    AND classifier_version = 'source-object-family-v1';

  IF v_existing_families IS DISTINCT FROM p_object_families THEN
    RAISE EXCEPTION 'source event classification repair conflicts with immutable evidence';
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION
  public.reconai_claim_source_event_classification_repair_candidate()
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.reconai_source_event_classification_repair_gap_counts()
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.reconai_prepare_source_event_classification_repair_audit(
    uuid, uuid, uuid, text, text, text, text
  )
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.reconai_record_source_event_classification_repair(
    uuid, uuid, uuid, text, text, text, text, text[],
    uuid, uuid, text, text, timestamptz, text, text
  )
FROM PUBLIC;

REVOKE ALL ON
  public.source_events,
  public.source_event_object_classifications,
  public.audit_events
FROM reconai_maintenance;

REVOKE ALL ON FUNCTION
  public.reconai_claim_source_event_classification_repair_candidate()
FROM reconai_app, reconai_worker;
REVOKE ALL ON FUNCTION
  public.reconai_source_event_classification_repair_gap_counts()
FROM reconai_app, reconai_worker;
REVOKE ALL ON FUNCTION
  public.reconai_prepare_source_event_classification_repair_audit(
    uuid, uuid, uuid, text, text, text, text
  )
FROM reconai_app, reconai_worker;
REVOKE ALL ON FUNCTION
  public.reconai_record_source_event_classification_repair(
    uuid, uuid, uuid, text, text, text, text, text[],
    uuid, uuid, text, text, timestamptz, text, text
  )
FROM reconai_app, reconai_worker;

GRANT EXECUTE ON FUNCTION
  public.reconai_claim_source_event_classification_repair_candidate()
TO reconai_maintenance;
GRANT EXECUTE ON FUNCTION
  public.reconai_source_event_classification_repair_gap_counts()
TO reconai_maintenance;
GRANT EXECUTE ON FUNCTION
  public.reconai_prepare_source_event_classification_repair_audit(
    uuid, uuid, uuid, text, text, text, text
  )
TO reconai_maintenance;
GRANT EXECUTE ON FUNCTION
  public.reconai_record_source_event_classification_repair(
    uuid, uuid, uuid, text, text, text, text, text[],
    uuid, uuid, text, text, timestamptz, text, text
  )
TO reconai_maintenance;
