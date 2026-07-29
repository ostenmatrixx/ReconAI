import type { Sql } from "postgres";
import { z } from "zod";

const observationSchema = z.discriminatedUnion("queueState", [
  z.object({ queueState: z.literal("empty") }).strict(),
  z
    .object({
      queueState: z.literal("nonempty"),
      oldestAgeSeconds: z.number(),
    })
    .strict(),
]);

export type ExceptionQueueObservation = z.infer<typeof observationSchema>;

export interface ExceptionQueueObservabilityRepository {
  observeExceptionQueue(): Promise<ExceptionQueueObservation>;
}

/**
 * Calls the fixed worker-only database authority. No tenant, exception, timestamp, severity, type,
 * money, or other customer field crosses this repository boundary.
 */
export class PostgresExceptionQueueObservabilityRepository implements ExceptionQueueObservabilityRepository {
  public constructor(private readonly sql: Sql) {}

  public async observeExceptionQueue(): Promise<ExceptionQueueObservation> {
    const rows = await this.sql`
      select queue_state, oldest_age_seconds
      from reconai_observe_exception_queue()
    `;
    if (rows.length !== 1) {
      throw new Error("exception queue observation returned an invalid row count");
    }
    const row = databaseRow(rows[0]);
    return observationSchema.parse({
      queueState: row["queue_state"],
      ...(row["oldest_age_seconds"] !== null && row["oldest_age_seconds"] !== undefined
        ? { oldestAgeSeconds: row["oldest_age_seconds"] }
        : {}),
    });
  }
}

function databaseRow(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("exception queue observation returned an invalid row");
  }
  return value as Readonly<Record<string, unknown>>;
}
