import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { z } from "zod";

export interface ProviderPrivacyObjectDeletionCandidate {
  readonly jobId: string;
  readonly organizationId: string;
  readonly requestId: string;
  readonly sourceEventId: string;
  readonly objectKey: string;
  readonly payloadSha256: string;
  readonly attempt: number;
}

export type ProviderPrivacyObjectDeletionOutcome = "deleted" | "already_missing";

export type ProviderPrivacyObjectDeletionProcessResult =
  | { readonly kind: "none" }
  | {
      readonly kind: "completed";
      readonly outcome: ProviderPrivacyObjectDeletionOutcome;
      readonly requestId: string;
    }
  | {
      readonly kind: "failed";
      readonly terminal: boolean;
      readonly requestId: string;
      readonly errorCode: string;
    };

export interface ProviderPrivacyObjectDeletionRepository {
  processNext(
    deleteObject: (
      candidate: ProviderPrivacyObjectDeletionCandidate,
    ) => Promise<ProviderPrivacyObjectDeletionOutcome>,
  ): Promise<ProviderPrivacyObjectDeletionProcessResult>;
}

export class ProviderPrivacyObjectDeletionError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    if (!errorCodeSchema.safeParse(code).success) {
      throw new TypeError("provider privacy object deletion error code is invalid");
    }
    super("provider privacy object deletion failed");
    this.name = "ProviderPrivacyObjectDeletionError";
    this.code = code;
  }
}

export class PostgresProviderPrivacyObjectDeletionRepository implements ProviderPrivacyObjectDeletionRepository {
  public constructor(private readonly sql: Sql) {}

  public async processNext(
    deleteObject: (
      candidate: ProviderPrivacyObjectDeletionCandidate,
    ) => Promise<ProviderPrivacyObjectDeletionOutcome>,
  ): Promise<ProviderPrivacyObjectDeletionProcessResult> {
    return this.sql.begin(async (transaction) => {
      const claimed = await transaction`
        select *
        from reconai_claim_provider_privacy_object_deletion(${randomUUID()}::uuid)
      `;
      const row = claimed[0] ? databaseRow(claimed[0]) : undefined;
      if (!row) return { kind: "none" };
      const candidate = candidateSchema.parse({
        jobId: row["job_id"],
        organizationId: row["organization_id"],
        requestId: row["request_id"],
        sourceEventId: row["source_event_id"],
        objectKey: row["object_key"],
        payloadSha256: row["payload_sha256"],
        attempt: row["attempt"],
      });

      let outcome: ProviderPrivacyObjectDeletionOutcome;
      try {
        outcome = outcomeSchema.parse(await deleteObject(candidate));
      } catch (error) {
        const errorCode =
          error instanceof ProviderPrivacyObjectDeletionError
            ? error.code
            : "PRIVACY_OBJECT_DELETE_FAILED";
        const failed = await transaction`
          select reconai_fail_provider_privacy_object_deletion(
            ${candidate.organizationId}::uuid,
            ${candidate.jobId}::uuid,
            ${errorCode}
          ) as status
        `;
        const failedRow = failed[0] ? databaseRow(failed[0]) : undefined;
        const status = failureStatusSchema.parse(failedRow?.["status"]);
        if (status === "not_found") {
          throw new Error("provider privacy deletion claim was lost before failure recording", {
            cause: error,
          });
        }
        return {
          kind: "failed",
          terminal: status === "dead_lettered",
          requestId: candidate.requestId,
          errorCode,
        };
      }

      const finalized = await transaction`
        select reconai_finalize_provider_privacy_object_deletion(
          ${candidate.organizationId}::uuid,
          ${candidate.jobId}::uuid,
          ${randomUUID()}::uuid,
          ${outcome}
        ) as finalized
      `;
      const finalizedRow = finalized[0] ? databaseRow(finalized[0]) : undefined;
      if (finalizedRow?.["finalized"] !== true) {
        throw new Error("provider privacy deletion claim was lost before finalization");
      }
      return {
        kind: "completed",
        outcome,
        requestId: candidate.requestId,
      };
    });
  }
}

const errorCodeSchema = z.string().regex(/^[A-Z0-9_]{1,100}$/u);
const outcomeSchema = z.enum(["deleted", "already_missing"]);
const failureStatusSchema = z.enum(["retry", "dead_lettered", "not_found"]);
const candidateSchema = z.object({
  jobId: z.uuid(),
  organizationId: z.uuid(),
  requestId: z.uuid(),
  sourceEventId: z.uuid(),
  objectKey: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[a-z0-9][a-z0-9._/-]{0,1023}$/u),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  attempt: z.coerce.number().int().min(1).max(10),
});

function databaseRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("database returned an invalid provider privacy deletion row");
  }
  return value as Record<string, unknown>;
}
