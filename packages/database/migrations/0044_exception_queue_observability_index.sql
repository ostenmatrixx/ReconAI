-- reconai:non-transactional
-- This restart-safe expansion avoids blocking exception writes while PostgreSQL builds the
-- environment-wide oldest-unresolved lookup used by the lease-owned telemetry monitor.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "exceptions_unresolved_oldest_idx"
ON "exceptions" ("created_at", "id")
WHERE "status" IN ('open', 'assigned', 'deferred', 'proposed', 'rejected');
