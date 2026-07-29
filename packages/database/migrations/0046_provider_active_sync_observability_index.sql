-- reconai:non-transactional
-- This expansion keeps provider-sync writes available while PostgreSQL builds the fixed
-- Shopify/Stripe oldest-active lookup used by the lease-owned telemetry monitor.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "provider_sync_runs_active_oldest_idx"
ON "provider_sync_runs" ("provider", "created_at", "id")
WHERE "status" IN ('queued', 'running');
