import type { Sql } from "postgres";
import { z } from "zod";

const providerSchema = z.enum(["shopify", "stripe"]);
const observationSchema = z.discriminatedUnion("activityState", [
  z
    .object({
      provider: providerSchema,
      activityState: z.literal("empty"),
    })
    .strict(),
  z
    .object({
      provider: providerSchema,
      activityState: z.literal("active"),
      syncStatus: z.enum(["queued", "running"]),
      oldestAgeSeconds: z.number(),
    })
    .strict(),
]);

export type ProviderActiveSyncObservation = z.infer<typeof observationSchema>;

export interface ProviderActiveSyncObservabilityRepository {
  observeProviderActiveSyncs(): Promise<readonly ProviderActiveSyncObservation[]>;
}

/**
 * Calls the fixed worker-only database authority. Exactly one Shopify and one Stripe aggregate
 * cross this boundary; tenant, connection, run, timestamp, cursor, error, and count fields do not.
 */
export class PostgresProviderActiveSyncObservabilityRepository implements ProviderActiveSyncObservabilityRepository {
  public constructor(private readonly sql: Sql) {}

  public async observeProviderActiveSyncs(): Promise<readonly ProviderActiveSyncObservation[]> {
    const rows = await this.sql`
      select provider, activity_state, sync_status, oldest_age_seconds
      from reconai_observe_provider_active_syncs()
    `;
    if (rows.length !== 2) {
      throw new Error("provider active-sync observation returned an invalid row count");
    }
    const observations = rows.map((value) => {
      const row = databaseRow(value);
      return observationSchema.parse({
        provider: row["provider"],
        activityState: row["activity_state"],
        ...(row["sync_status"] !== null && row["sync_status"] !== undefined
          ? { syncStatus: row["sync_status"] }
          : {}),
        ...(row["oldest_age_seconds"] !== null && row["oldest_age_seconds"] !== undefined
          ? { oldestAgeSeconds: row["oldest_age_seconds"] }
          : {}),
      });
    });
    if (observations[0]?.provider !== "shopify" || observations[1]?.provider !== "stripe") {
      throw new Error("provider active-sync observation returned an invalid provider set");
    }
    return observations;
  }
}

function databaseRow(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("provider active-sync observation returned an invalid row");
  }
  return value as Readonly<Record<string, unknown>>;
}
