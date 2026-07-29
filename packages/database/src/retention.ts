import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { z } from "zod";

export interface RetentionDeletionCandidate {
  readonly jobId: string;
  readonly sourceKind: "raw_import" | "provider_event";
  readonly objectKey: string;
  readonly payloadSha256: string;
  readonly retentionDays: number;
  readonly eligibleAt: string;
  readonly attempt: number;
}

export type RetentionDeletionOutcome = "deleted" | "already_missing";

export type RetentionDeletionProcessResult =
  | { readonly kind: "none" }
  | {
      readonly kind: "completed";
      readonly outcome: RetentionDeletionOutcome;
      readonly sourceKind: RetentionDeletionCandidate["sourceKind"];
    }
  | {
      readonly kind: "failed";
      readonly terminal: boolean;
      readonly sourceKind: RetentionDeletionCandidate["sourceKind"];
      readonly errorCode: string;
    };

export interface RetentionDeletionRepository {
  processNext(
    deleteObject: (candidate: RetentionDeletionCandidate) => Promise<RetentionDeletionOutcome>,
  ): Promise<RetentionDeletionProcessResult>;
}

export class RetentionDeletionError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    if (!errorCodeSchema.safeParse(code).success) {
      throw new TypeError("retention deletion error code is invalid");
    }
    super("retention object deletion failed");
    this.name = "RetentionDeletionError";
    this.code = code;
  }
}

export class PostgresRetentionDeletionRepository implements RetentionDeletionRepository {
  public constructor(private readonly sql: Sql) {}

  public async processNext(
    deleteObject: (candidate: RetentionDeletionCandidate) => Promise<RetentionDeletionOutcome>,
  ): Promise<RetentionDeletionProcessResult> {
    return this.sql.begin(async (transaction) => {
      const claimed = await transaction`
        select *
        from reconai_claim_retention_candidate(${randomUUID()}::uuid)
      `;
      const row = claimed[0] ? databaseRow(claimed[0]) : undefined;
      if (!row) return { kind: "none" };
      const candidate = retentionCandidateSchema.parse({
        jobId: row["job_id"],
        sourceKind: row["source_kind"],
        objectKey: row["object_key"],
        payloadSha256: row["payload_sha256"],
        retentionDays: row["retention_days"],
        eligibleAt: timestampValue(row["eligible_at"]),
        attempt: row["attempt"],
      });

      let outcome: RetentionDeletionOutcome;
      try {
        outcome = retentionOutcomeSchema.parse(await deleteObject(candidate));
      } catch (error) {
        const errorCode =
          error instanceof RetentionDeletionError ? error.code : "RETENTION_OBJECT_DELETE_FAILED";
        const failed = await transaction`
          select reconai_fail_retention_candidate(
            ${candidate.jobId}::uuid,
            ${errorCode}
          ) as status
        `;
        const failedRow = failed[0] ? databaseRow(failed[0]) : undefined;
        const status = failureStatusSchema.parse(failedRow?.["status"]);
        if (status === "not_found") {
          throw new Error("retention deletion claim was lost before failure recording", {
            cause: error,
          });
        }
        return {
          kind: "failed",
          terminal: status === "dead_lettered",
          sourceKind: candidate.sourceKind,
          errorCode,
        };
      }

      const finalized = await transaction`
        select reconai_finalize_retention_candidate(
          ${candidate.jobId}::uuid,
          ${randomUUID()}::uuid,
          ${outcome}
        ) as finalized
      `;
      const finalizedRow = finalized[0] ? databaseRow(finalized[0]) : undefined;
      if (finalizedRow?.["finalized"] !== true) {
        throw new Error("retention deletion claim was lost before finalization");
      }
      return { kind: "completed", outcome, sourceKind: candidate.sourceKind };
    });
  }
}

const errorCodeSchema = z.string().regex(/^[A-Z0-9_]{1,100}$/u);
const retentionOutcomeSchema = z.enum(["deleted", "already_missing"]);
const failureStatusSchema = z.enum(["retry", "dead_lettered", "not_found"]);
const retentionCandidateSchema = z.object({
  jobId: z.uuid(),
  sourceKind: z.enum(["raw_import", "provider_event"]),
  objectKey: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[a-z0-9][a-z0-9._/-]{0,1023}$/u),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  retentionDays: z.coerce.number().int().min(1).max(3650),
  eligibleAt: z.iso.datetime({ offset: true }),
  attempt: z.coerce.number().int().min(1).max(10),
});

function timestampValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new Error("database returned an invalid retention timestamp");
}

function databaseRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("database returned an invalid retention row");
  }
  return value as Record<string, unknown>;
}
