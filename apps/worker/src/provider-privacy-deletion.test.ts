import {
  ProviderPrivacyObjectDeletionError,
  type ProviderPrivacyObjectDeletionCandidate,
  type ProviderPrivacyObjectDeletionRepository,
} from "@workspace/database";
import { ObjectIntegrityError } from "@workspace/object-storage";
import { describe, expect, it, vi } from "vitest";

import {
  deleteProviderPrivacyObject,
  executeProviderPrivacyDeletionBatch,
} from "./provider-privacy-deletion.js";

const candidate: ProviderPrivacyObjectDeletionCandidate = {
  jobId: "a3000000-0000-4000-8000-000000000001",
  organizationId: "a3000000-0000-4000-8000-000000000002",
  requestId: "a3000000-0000-4000-8000-000000000003",
  sourceEventId: "a3000000-0000-4000-8000-000000000004",
  objectKey:
    "test/organizations/a3000000-0000-4000-8000-000000000002/provider-events/event/payload.json",
  payloadSha256: "a".repeat(64),
  attempt: 1,
};

describe("provider privacy raw-object deletion", () => {
  it("binds deletion to the immutable key and checksum", async () => {
    const deleteVerified = vi.fn(async () => "deleted" as const);

    await expect(deleteProviderPrivacyObject(candidate, { deleteVerified })).resolves.toBe(
      "deleted",
    );
    expect(deleteVerified).toHaveBeenCalledWith({
      key: candidate.objectKey,
      expectedChecksumSha256: candidate.payloadSha256,
    });
  });

  it("classifies object-integrity drift without exposing object metadata", async () => {
    const deleteVerified = vi.fn(async () => {
      throw new ObjectIntegrityError();
    });

    const error = await deleteProviderPrivacyObject(candidate, {
      deleteVerified,
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ProviderPrivacyObjectDeletionError);
    expect(error).toMatchObject({ code: "PRIVACY_OBJECT_INTEGRITY_FAILED" });
  });

  it("bounds batches and reports retry/dead-letter outcomes", async () => {
    const results = [
      { kind: "completed", outcome: "deleted", requestId: candidate.requestId } as const,
      {
        kind: "failed",
        terminal: false,
        requestId: candidate.requestId,
        errorCode: "PRIVACY_OBJECT_DELETE_FAILED",
      } as const,
      {
        kind: "failed",
        terminal: true,
        requestId: candidate.requestId,
        errorCode: "PRIVACY_OBJECT_DELETE_FAILED",
      } as const,
      { kind: "none" } as const,
    ];
    const repository: ProviderPrivacyObjectDeletionRepository = {
      processNext: async () => results.shift() ?? { kind: "none" },
    };

    await expect(
      executeProviderPrivacyDeletionBatch(
        repository,
        { deleteVerified: vi.fn(async () => "deleted" as const) },
        4,
      ),
    ).resolves.toEqual({
      examined: 3,
      deleted: 1,
      alreadyMissing: 0,
      retried: 1,
      deadLettered: 1,
    });
  });
});
