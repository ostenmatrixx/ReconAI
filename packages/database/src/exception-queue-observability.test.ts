import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { PostgresExceptionQueueObservabilityRepository } from "./exception-queue-observability.js";

describe("exception queue observability repository", () => {
  it("returns only a fixed empty or numeric nonempty observation", async () => {
    const emptySql = sqlReturning([{ queue_state: "empty", oldest_age_seconds: null }]);
    const nonemptySql = sqlReturning([{ queue_state: "nonempty", oldest_age_seconds: 12.5 }]);

    await expect(
      new PostgresExceptionQueueObservabilityRepository(emptySql.sql).observeExceptionQueue(),
    ).resolves.toEqual({ queueState: "empty" });
    await expect(
      new PostgresExceptionQueueObservabilityRepository(nonemptySql.sql).observeExceptionQueue(),
    ).resolves.toEqual({ queueState: "nonempty", oldestAgeSeconds: 12.5 });
    expect(emptySql.query).toHaveBeenCalledOnce();
    expect(nonemptySql.query).toHaveBeenCalledOnce();
  });

  it("rejects inconsistent, dynamic, non-finite, and multi-row database results", async () => {
    for (const rows of [
      [{ queue_state: "empty", oldest_age_seconds: 1 }],
      [{ queue_state: "nonempty", oldest_age_seconds: null }],
      [{ queue_state: "customer-state-secret", oldest_age_seconds: 1 }],
      [{ queue_state: "nonempty", oldest_age_seconds: Number.NaN }],
      [],
      [
        { queue_state: "empty", oldest_age_seconds: null },
        { queue_state: "empty", oldest_age_seconds: null },
      ],
    ]) {
      await expect(
        new PostgresExceptionQueueObservabilityRepository(
          sqlReturning(rows).sql,
        ).observeExceptionQueue(),
      ).rejects.toThrow();
    }
  });
});

function sqlReturning(rows: readonly unknown[]): {
  readonly sql: Sql;
  readonly query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async () => rows);
  return { sql: query as unknown as Sql, query };
}
