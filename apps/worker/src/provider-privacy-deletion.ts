import {
  ProviderPrivacyObjectDeletionError,
  type ProviderPrivacyObjectDeletionCandidate,
  type ProviderPrivacyObjectDeletionProcessResult,
  type ProviderPrivacyObjectDeletionRepository,
} from "@workspace/database";
import { ObjectIntegrityError, type ImmutableObjectStore } from "@workspace/object-storage";
import { createLogger, safeError } from "@workspace/observability";

export interface ProviderPrivacyDeletionBatchResult {
  readonly examined: number;
  readonly deleted: number;
  readonly alreadyMissing: number;
  readonly retried: number;
  readonly deadLettered: number;
}

export async function executeProviderPrivacyDeletionBatch(
  repository: ProviderPrivacyObjectDeletionRepository,
  objectStore: Pick<ImmutableObjectStore, "deleteVerified">,
  batchSize = 25,
): Promise<ProviderPrivacyDeletionBatchResult> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new TypeError("provider privacy deletion batch size must be between 1 and 100");
  }
  const counts = {
    examined: 0,
    deleted: 0,
    alreadyMissing: 0,
    retried: 0,
    deadLettered: 0,
  };
  for (let index = 0; index < batchSize; index += 1) {
    const result = await repository.processNext((candidate) =>
      deleteProviderPrivacyObject(candidate, objectStore),
    );
    if (result.kind === "none") break;
    counts.examined += 1;
    recordResult(counts, result);
  }
  return counts;
}

export async function deleteProviderPrivacyObject(
  candidate: ProviderPrivacyObjectDeletionCandidate,
  objectStore: Pick<ImmutableObjectStore, "deleteVerified">,
): Promise<"deleted" | "already_missing"> {
  try {
    return await objectStore.deleteVerified({
      key: candidate.objectKey,
      expectedChecksumSha256: candidate.payloadSha256,
    });
  } catch (error) {
    if (error instanceof ObjectIntegrityError) {
      throw new ProviderPrivacyObjectDeletionError("PRIVACY_OBJECT_INTEGRITY_FAILED");
    }
    throw error;
  }
}

export interface RunningProviderPrivacyDeletionExecutor {
  runNow(): Promise<void>;
  close(): Promise<void>;
}

export function startProviderPrivacyDeletionExecutor(input: {
  readonly repository: ProviderPrivacyObjectDeletionRepository;
  readonly objectStore: Pick<ImmutableObjectStore, "deleteVerified">;
  readonly environment: string;
  readonly intervalMs?: number;
  readonly batchSize?: number;
}): RunningProviderPrivacyDeletionExecutor {
  const logger = createLogger("reconai-provider-privacy-deletion", input.environment);
  const intervalMs = input.intervalMs ?? 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 86_400_000) {
    throw new TypeError(
      "provider privacy deletion interval must be between one second and one day",
    );
  }
  let closed = false;
  let running: Promise<void> | undefined;
  const runNow = async () => {
    if (closed || running) return;
    running = (async () => {
      try {
        const result = await executeProviderPrivacyDeletionBatch(
          input.repository,
          input.objectStore,
          input.batchSize,
        );
        if (result.examined > 0) {
          logger.info(result, "provider privacy deletion batch completed");
        }
      } catch (error) {
        logger.error({ error: safeError(error) }, "provider privacy deletion batch failed");
      } finally {
        running = undefined;
      }
    })();
    await running;
  };
  const timer = setInterval(() => {
    void runNow();
  }, intervalMs);
  timer.unref();
  void runNow();
  return {
    runNow,
    close: async () => {
      closed = true;
      clearInterval(timer);
      await running;
    },
  };
}

function recordResult(
  counts: {
    deleted: number;
    alreadyMissing: number;
    retried: number;
    deadLettered: number;
  },
  result: Exclude<ProviderPrivacyObjectDeletionProcessResult, { readonly kind: "none" }>,
): void {
  if (result.kind === "completed") {
    if (result.outcome === "deleted") counts.deleted += 1;
    else counts.alreadyMissing += 1;
    return;
  }
  if (result.terminal) counts.deadLettered += 1;
  else counts.retried += 1;
}
