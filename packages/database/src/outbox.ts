import { OrganizationIdSchema, type OrganizationId } from "@workspace/domain";
import type { Sql } from "postgres";
import { z } from "zod";

export interface PendingOutboxEvent {
  readonly organizationId: OrganizationId;
  readonly eventType: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly attempts: number;
}

export interface OutboxRelayRepository {
  loadPending(limit: number): Promise<readonly PendingOutboxEvent[]>;
  markPublished(
    organizationId: OrganizationId,
    idempotencyKey: string,
    publishedAt: string,
  ): Promise<boolean>;
  markFailed(
    organizationId: OrganizationId,
    idempotencyKey: string,
    errorCode: string,
    nextAttemptAt: string,
    maximumAttempts: number,
  ): Promise<boolean>;
}

export class PostgresOutboxRelayRepository implements OutboxRelayRepository {
  public constructor(private readonly sql: Sql) {}

  public async loadPending(limit: number): Promise<readonly PendingOutboxEvent[]> {
    const boundedLimit = z.number().int().min(1).max(500).parse(limit);
    const rows = await this.sql`select * from reconai_pending_outbox(${boundedLimit})`;
    return rows.map((value): PendingOutboxEvent => {
      const row = databaseRow(value);
      return {
        organizationId: OrganizationIdSchema.parse(row["organization_id"]),
        eventType: z.string().min(1).max(100).parse(row["event_type"]),
        idempotencyKey: z.string().min(1).max(500).parse(row["idempotency_key"]),
        payload: row["payload"],
        attempts: databaseNonnegativeInteger(row["attempts"], "outbox.attempts"),
      };
    });
  }

  public async markPublished(
    organizationId: OrganizationId,
    idempotencyKey: string,
    publishedAt: string,
  ): Promise<boolean> {
    const rows = await this.sql`
      select reconai_mark_outbox_published(
        ${organizationId},
        ${z.string().min(1).max(500).parse(idempotencyKey)},
        ${z.iso.datetime({ offset: true }).parse(publishedAt)}
      ) as changed
    `;
    return databaseBoolean(rows[0]?.["changed"], "outbox published result");
  }

  public async markFailed(
    organizationId: OrganizationId,
    idempotencyKey: string,
    errorCode: string,
    nextAttemptAt: string,
    maximumAttempts: number,
  ): Promise<boolean> {
    const rows = await this.sql`
      select reconai_mark_outbox_failed(
        ${organizationId},
        ${z.string().min(1).max(500).parse(idempotencyKey)},
        ${z
          .string()
          .regex(/^[A-Z0-9_]{1,100}$/u)
          .parse(errorCode)},
        ${z.iso.datetime({ offset: true }).parse(nextAttemptAt)},
        ${z.number().int().min(1).max(100).parse(maximumAttempts)}
      ) as changed
    `;
    return databaseBoolean(rows[0]?.["changed"], "outbox failure result");
  }
}

function databaseRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("database returned an invalid outbox row");
  }
  return value as Record<string, unknown>;
}

function databaseNonnegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`database returned an invalid ${field}`);
  }
  return parsed;
}

function databaseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`database returned an invalid ${field}`);
  return value;
}
