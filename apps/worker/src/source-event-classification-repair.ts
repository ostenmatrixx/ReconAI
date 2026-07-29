import { randomUUID } from "node:crypto";

import { DEFAULT_CSV_LIMITS } from "@workspace/connector-csv";
import type { SourceObjectFamily } from "@workspace/connectors";
import type {
  SourceEventClassificationRepairCandidate,
  SourceEventClassificationRepairRepository,
} from "@workspace/database";
import {
  PROVIDER_WEBHOOK_MAXIMUM_BYTES,
  ProviderWebhookValidationError,
  classifyProviderSourceObjectFamilies,
} from "@workspace/ingestion";
import {
  ObjectIntegrityError,
  ObjectNotFoundError,
  ObjectReadTimeoutError,
  type ImmutableObjectStore,
} from "@workspace/object-storage";
import { z } from "zod";

const maximumBatchSize = 100;

export type SourceEventClassificationRepairErrorCode =
  | "SOURCE_OBJECT_INTEGRITY_FAILED"
  | "SOURCE_OBJECT_NOT_FOUND"
  | "SOURCE_OBJECT_READ_TIMEOUT"
  | "SOURCE_PAYLOAD_UNSUPPORTED";

export class SourceEventClassificationRepairError extends Error {
  public constructor(public readonly code: SourceEventClassificationRepairErrorCode) {
    super("source-event classification repair failed");
    this.name = "SourceEventClassificationRepairError";
  }
}

export interface SourceEventClassificationRepairBatchResult {
  readonly repairRunId: string;
  readonly examined: number;
  readonly classified: number;
  readonly alreadyClassified: number;
  readonly remainingGaps: number;
  readonly remainingRepairableGaps: number;
  readonly complete: boolean;
}

export async function executeSourceEventClassificationRepairBatch(input: {
  readonly repository: SourceEventClassificationRepairRepository;
  readonly objectStore: Pick<ImmutableObjectStore, "getVerified">;
  readonly requestedBy: string;
  readonly reason: string;
  readonly batchSize: number;
  readonly now?: () => Date;
  readonly repairRunId?: string;
}): Promise<SourceEventClassificationRepairBatchResult> {
  const batchSize = z.number().int().min(1).max(maximumBatchSize).parse(input.batchSize);
  const repairRunId = z.uuid().parse(input.repairRunId ?? randomUUID());
  const now = input.now ?? (() => new Date());
  let previousObject:
    | {
        readonly key: string;
        readonly checksumSha256: string;
        readonly body: Uint8Array;
      }
    | undefined;
  let examined = 0;
  let classified = 0;
  let alreadyClassified = 0;

  for (let index = 0; index < batchSize; index += 1) {
    const result = await input.repository.processNext(
      {
        repairRunId,
        requestedBy: input.requestedBy,
        reason: input.reason,
        repairedAt: now().toISOString(),
      },
      async (candidate) => {
        const body =
          previousObject?.key === candidate.objectKey &&
          previousObject.checksumSha256 === candidate.payloadSha256
            ? previousObject.body
            : await readVerifiedObject(input.objectStore, candidate);
        previousObject = {
          key: candidate.objectKey,
          checksumSha256: candidate.payloadSha256,
          body,
        };
        return classifyCandidate(candidate, body);
      },
    );
    if (result.kind === "none") break;
    examined += 1;
    if (result.kind === "classified") classified += 1;
    else alreadyClassified += 1;
  }

  previousObject = undefined;
  const remaining = await input.repository.countGaps();
  return {
    repairRunId,
    examined,
    classified,
    alreadyClassified,
    remainingGaps: remaining.total,
    remainingRepairableGaps: remaining.repairable,
    complete: remaining.total === 0,
  };
}

async function readVerifiedObject(
  objectStore: Pick<ImmutableObjectStore, "getVerified">,
  candidate: SourceEventClassificationRepairCandidate,
): Promise<Uint8Array> {
  try {
    return await objectStore.getVerified({
      key: candidate.objectKey,
      expectedChecksumSha256: candidate.payloadSha256,
      maximumBytes:
        candidate.source === "accounting_csv"
          ? DEFAULT_CSV_LIMITS.maximumBytes
          : PROVIDER_WEBHOOK_MAXIMUM_BYTES,
      timeoutMs: 15_000,
    });
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      throw new SourceEventClassificationRepairError("SOURCE_OBJECT_NOT_FOUND");
    }
    if (error instanceof ObjectIntegrityError) {
      throw new SourceEventClassificationRepairError("SOURCE_OBJECT_INTEGRITY_FAILED");
    }
    if (error instanceof ObjectReadTimeoutError) {
      throw new SourceEventClassificationRepairError("SOURCE_OBJECT_READ_TIMEOUT");
    }
    throw error;
  }
}

function classifyCandidate(
  candidate: SourceEventClassificationRepairCandidate,
  body: Uint8Array,
): readonly SourceObjectFamily[] {
  if (candidate.source === "accounting_csv") return ["csv_row"];
  try {
    return classifyProviderSourceObjectFamilies(candidate.source, candidate.eventType, body);
  } catch (error) {
    if (error instanceof ProviderWebhookValidationError || error instanceof z.ZodError) {
      throw new SourceEventClassificationRepairError("SOURCE_PAYLOAD_UNSUPPORTED");
    }
    throw error;
  }
}
