-- reconai:non-transactional
-- This expansion keeps ingestion writes available while PostgreSQL builds the tenant/connection
-- lookup used by the authorized fixed-family source-watermark view.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "source_events_org_connection_object_watermark_idx"
ON "source_events" ("organization_id", "connection_id", "external_object_type", "source_timestamp" DESC, "received_at" DESC);
