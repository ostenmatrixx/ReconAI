-- Classify immutable provider/CSV receipts into fixed product-facing source-object families.
-- Provider event topics remain unchanged in source_events.external_object_type. The classification
-- is separate because one authenticated Shopify snapshot can contain both an order and refund
-- transactions.

CREATE TABLE public.source_event_object_classifications (
  organization_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  object_families text[] NOT NULL,
  classifier_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_event_object_classifications_organization_id_source_event_id_pk
    PRIMARY KEY (organization_id, source_event_id),
  CONSTRAINT source_event_object_classifications_source_event_fk
    FOREIGN KEY (organization_id, source_event_id)
    REFERENCES public.source_events (organization_id, id),
  CONSTRAINT source_event_object_classifications_families_check
    CHECK (
      cardinality(object_families) BETWEEN 1 AND 3
      AND array_position(object_families, NULL) IS NULL
      AND (
        object_families = ARRAY['order']::text[]
        OR object_families = ARRAY['refund_transaction']::text[]
        OR object_families = ARRAY['order', 'refund_transaction']::text[]
        OR object_families = ARRAY['payment_intent']::text[]
        OR object_families = ARRAY['refund']::text[]
        OR object_families = ARRAY['balance_transaction']::text[]
        OR object_families = ARRAY['csv_row']::text[]
      )
    ),
  CONSTRAINT source_event_object_classifications_classifier_check
    CHECK (classifier_version = 'source-object-family-v1')
);

-- Existing receipts are intentionally not inferred in this schema migration. In particular, a
-- legacy Shopify orders/snapshot topic does not reveal whether its immutable payload contains
-- refund transactions. The read model reports classification_unavailable while any operational
-- receipt lacks a classification. A future bounded, object-integrity-checked repair must write the
-- same append-only classifier version; migration execution must not perform an unbounded payload
-- backfill.

ALTER TABLE public.source_event_object_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_event_object_classifications FORCE ROW LEVEL SECURITY;

CREATE POLICY source_event_object_classifications_tenant_policy
  ON public.source_event_object_classifications
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );

CREATE OR REPLACE FUNCTION public.reject_source_event_object_classification_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'source event object classifications are append-only';
END;
$$;

CREATE TRIGGER source_event_object_classifications_reject_update_delete
BEFORE UPDATE OR DELETE ON public.source_event_object_classifications
FOR EACH ROW EXECUTE FUNCTION public.reject_source_event_object_classification_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_app') THEN
    GRANT SELECT, INSERT ON public.source_event_object_classifications TO reconai_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON
      public.source_event_object_classifications
    FROM reconai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reconai_worker') THEN
    GRANT SELECT, INSERT ON public.source_event_object_classifications TO reconai_worker;
    REVOKE UPDATE, DELETE, TRUNCATE ON
      public.source_event_object_classifications
    FROM reconai_worker;
  END IF;
END
$$;
