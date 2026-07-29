import type {
  RetentionDeletionCandidate,
  RetentionDeletionProcessResult,
  RetentionDeletionRepository,
} from "@workspace/database";
import { InMemoryImmutableObjectStore, ObjectIntegrityError } from "@workspace/object-storage";
import { describe, expect, it, vi } from "vitest";

import { deleteRetentionObject, executeRetentionBatch } from "./retention-execution.js";

const candidate: RetentionDeletionCandidate = {
  jobId: "10000000-0000-4000-8000-000000000001",
  sourceKind: "raw_import",
  objectKey:
    "test/20000000-0000-4000-8000-000000000001/imports/30000000-0000-4000-8000-000000000001/payload.csv",
  payloadSha256: "a".repeat(64),
  retentionDays: 30,
  eligibleAt: "2026-06-27T00:00:00.000Z",
  attempt: 1,
};

describe("retention deletion executor", () => {
  it("bounds each batch and counts terminal, retry, and idempotent outcomes", async () => {
    const results: RetentionDeletionProcessResult[] = [
      { kind: "completed", outcome: "deleted", sourceKind: "raw_import" },
      { kind: "completed", outcome: "already_missing", sourceKind: "provider_event" },
      {
        kind: "failed",
        terminal: false,
        sourceKind: "provider_event",
        errorCode: "RETENTION_OBJECT_DELETE_FAILED",
      },
      {
        kind: "failed",
        terminal: true,
        sourceKind: "raw_import",
        errorCode: "RETENTION_OBJECT_INTEGRITY_FAILED",
      },
      { kind: "none" },
    ];
    const processNext = vi.fn(
      async (): Promise<RetentionDeletionProcessResult> => results.shift() ?? { kind: "none" },
    );
    const repository: RetentionDeletionRepository = { processNext };

    await expect(
      executeRetentionBatch(repository, new InMemoryImmutableObjectStore(), 10),
    ).resolves.toEqual({
      examined: 4,
      deleted: 1,
      alreadyMissing: 1,
      retried: 1,
      deadLettered: 1,
    });
    expect(processNext).toHaveBeenCalledTimes(5);
  });

  it("maps checksum authority failures to a bounded retention error code", async () => {
    const objectStore = {
      deleteVerified: vi.fn(async () => {
        throw new ObjectIntegrityError();
      }),
    };

    await expect(deleteRetentionObject(candidate, objectStore)).rejects.toMatchObject({
      name: "RetentionDeletionError",
      code: "RETENTION_OBJECT_INTEGRITY_FAILED",
      message: "retention object deletion failed",
    });
  });
});
