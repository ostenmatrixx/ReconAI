import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { PostgresProviderActiveSyncObservabilityRepository } from "./provider-active-sync-observability.js";

describe("provider active-sync observability repository", () => {
  it("returns exactly one fixed observation for each provider", async () => {
    const database = sqlReturning([
      {
        provider: "shopify",
        activity_state: "active",
        sync_status: "queued",
        oldest_age_seconds: 12.5,
      },
      {
        provider: "stripe",
        activity_state: "empty",
        sync_status: null,
        oldest_age_seconds: null,
      },
    ]);

    await expect(
      new PostgresProviderActiveSyncObservabilityRepository(
        database.sql,
      ).observeProviderActiveSyncs(),
    ).resolves.toEqual([
      {
        provider: "shopify",
        activityState: "active",
        syncStatus: "queued",
        oldestAgeSeconds: 12.5,
      },
      { provider: "stripe", activityState: "empty" },
    ]);
    expect(database.query).toHaveBeenCalledOnce();
  });

  it("rejects missing, duplicate, reversed, inconsistent, dynamic, and non-finite results", async () => {
    const validEmpty = {
      provider: "stripe",
      activity_state: "empty",
      sync_status: null,
      oldest_age_seconds: null,
    };
    for (const rows of [
      [],
      [validEmpty],
      [validEmpty, validEmpty],
      [
        validEmpty,
        {
          provider: "shopify",
          activity_state: "empty",
          sync_status: null,
          oldest_age_seconds: null,
        },
      ],
      [
        {
          provider: "shopify",
          activity_state: "empty",
          sync_status: "queued",
          oldest_age_seconds: null,
        },
        validEmpty,
      ],
      [
        {
          provider: "shopify",
          activity_state: "active",
          sync_status: "completed",
          oldest_age_seconds: 1,
        },
        validEmpty,
      ],
      [
        {
          provider: "shopify-secret",
          activity_state: "active",
          sync_status: "running",
          oldest_age_seconds: 1,
        },
        validEmpty,
      ],
      [
        {
          provider: "shopify",
          activity_state: "active",
          sync_status: "running",
          oldest_age_seconds: Number.NaN,
        },
        validEmpty,
      ],
    ]) {
      await expect(
        new PostgresProviderActiveSyncObservabilityRepository(
          sqlReturning(rows).sql,
        ).observeProviderActiveSyncs(),
      ).rejects.toThrow();
    }
  });
});

function sqlReturning(rows: readonly unknown[]): {
  readonly sql: Sql;
  readonly query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async () => rows);
  return {
    sql: Object.assign(query, { begin: vi.fn() }) as unknown as Sql,
    query,
  };
}
