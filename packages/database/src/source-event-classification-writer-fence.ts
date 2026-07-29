import type { Sql } from "postgres";
import { z } from "zod";

const activationConfirmation = "ENABLE-SOURCE-CLASSIFICATION-WRITER-FENCE";
const requestedBySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9@._:/-]{2,99}$/u);
const reasonSchema = z
  .string()
  .min(20)
  .max(500)
  .refine((value) => !containsControlCharacter(value), {
    message: "writer fence reason contains a control character",
  });

export interface SourceEventClassificationWriterFenceStatus {
  readonly enabled: boolean;
  readonly activationId?: string;
  readonly activatedAt?: string;
  readonly fenceVersion: "source-classification-writer-fence-v1";
}

export interface SourceEventClassificationWriterFenceActivation extends SourceEventClassificationWriterFenceStatus {
  readonly changed: boolean;
}

export interface SourceEventClassificationWriterFenceRepository {
  activate(input: {
    readonly activationId: string;
    readonly requestedBy: string;
    readonly reason: string;
    readonly confirmation: typeof activationConfirmation;
  }): Promise<SourceEventClassificationWriterFenceActivation>;
  status(): Promise<SourceEventClassificationWriterFenceStatus>;
}

export class PostgresSourceEventClassificationWriterFenceRepository implements SourceEventClassificationWriterFenceRepository {
  public constructor(private readonly sql: Sql) {}

  public async activate(inputValue: {
    readonly activationId: string;
    readonly requestedBy: string;
    readonly reason: string;
    readonly confirmation: typeof activationConfirmation;
  }): Promise<SourceEventClassificationWriterFenceActivation> {
    const input = z
      .object({
        activationId: z.uuid(),
        requestedBy: requestedBySchema,
        reason: reasonSchema,
        confirmation: z.literal(activationConfirmation),
      })
      .strict()
      .parse(inputValue);
    return this.sql.begin(async (transaction) => {
      await transaction`select set_config('lock_timeout', '10000', true)`;
      await transaction`select set_config('statement_timeout', '15000', true)`;
      const rows = await transaction`
        select *
        from reconai_activate_source_event_classification_writer_fence(
          ${input.activationId}::uuid,
          ${input.requestedBy},
          ${input.reason},
          ${input.confirmation}
        )
      `;
      const row = databaseRow(rows[0]);
      return {
        enabled: true,
        changed: z.boolean().parse(row["changed"]),
        activationId: z.uuid().parse(row["activation_id"]),
        activatedAt: databaseInstant(row["activated_at"]),
        fenceVersion: "source-classification-writer-fence-v1",
      };
    });
  }

  public async status(): Promise<SourceEventClassificationWriterFenceStatus> {
    const rows = await this.sql`
      select *
      from reconai_source_event_classification_writer_fence_status()
    `;
    const row = databaseRow(rows[0]);
    const enabled = z.boolean().parse(row["enabled"]);
    const activationId = optionalUuid(row["activation_id"]);
    const activatedAt = optionalInstant(row["activated_at"]);
    if (enabled !== (activationId !== undefined && activatedAt !== undefined)) {
      throw new Error("database returned an inconsistent classification writer fence status");
    }
    return {
      enabled,
      ...(activationId ? { activationId } : {}),
      ...(activatedAt ? { activatedAt } : {}),
      fenceVersion: z.literal("source-classification-writer-fence-v1").parse(row["fence_version"]),
    };
  }
}

function databaseRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) {
    throw new Error("database returned an invalid classification writer fence row");
  }
  return value as Readonly<Record<string, unknown>>;
}

function databaseInstant(value: unknown): string {
  if (!(value instanceof Date)) {
    throw new Error("database returned an invalid classification writer fence instant");
  }
  return value.toISOString();
}

function optionalUuid(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return z.uuid().parse(value);
}

function optionalInstant(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return databaseInstant(value);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) return true;
  }
  return false;
}
