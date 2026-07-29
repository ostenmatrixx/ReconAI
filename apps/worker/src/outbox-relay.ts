import {
  DurableJobEnvelopeSchema,
  retryDelayMs,
  type DurableJobEnvelope,
} from "@workspace/connectors";
import type { OutboxRelayRepository, PendingOutboxEvent } from "@workspace/database";
import {
  createLogger,
  safeError,
  startOutboxRelayBatchObservation,
} from "@workspace/observability";

export interface OutboxPublisher {
  publish(envelope: DurableJobEnvelope): Promise<void>;
}

export interface OutboxRelayResult {
  readonly examined: number;
  readonly published: number;
  readonly retried: number;
  readonly deadLettered: number;
}

export async function relayOutboxBatch(
  repository: OutboxRelayRepository,
  publisher: OutboxPublisher,
  now = new Date(),
  batchSize = 100,
): Promise<OutboxRelayResult> {
  const pending = await repository.loadPending(batchSize);
  let published = 0;
  let retried = 0;
  let deadLettered = 0;
  for (const event of pending) {
    const parsed = DurableJobEnvelopeSchema.safeParse(event.payload);
    if (!parsed.success || !matchesOutboxAuthority(event, parsed.data)) {
      await repository.markFailed(
        event.organizationId,
        event.idempotencyKey,
        "OUTBOX_SCHEMA_INVALID",
        now.toISOString(),
        1,
      );
      deadLettered += 1;
      continue;
    }
    try {
      await publisher.publish(parsed.data);
      await repository.markPublished(event.organizationId, event.idempotencyKey, now.toISOString());
      published += 1;
    } catch {
      const attempt = event.attempts + 1;
      const maximumAttempts = 6;
      const nextAttemptAt = new Date(now.getTime() + retryDelayMs(attempt)).toISOString();
      await repository.markFailed(
        event.organizationId,
        event.idempotencyKey,
        "QUEUE_DISPATCH_FAILED",
        nextAttemptAt,
        maximumAttempts,
      );
      if (attempt >= maximumAttempts) deadLettered += 1;
      else retried += 1;
    }
  }
  return { examined: pending.length, published, retried, deadLettered };
}

export interface RunningOutboxRelay {
  runNow(): Promise<void>;
  close(): Promise<void>;
}

export function startOutboxRelay(input: {
  readonly repository: OutboxRelayRepository;
  readonly publisher: OutboxPublisher;
  readonly environment: string;
  readonly intervalMs?: number;
}): RunningOutboxRelay {
  const logger = createLogger("reconai-outbox-relay", input.environment);
  const intervalMs = input.intervalMs ?? 2_000;
  let closed = false;
  let running: Promise<void> | undefined;
  const runNow = async () => {
    if (closed || running) return;
    running = (async () => {
      const observation = startOutboxRelayBatchObservation();
      try {
        const result = await relayOutboxBatch(input.repository, input.publisher);
        observation.finish("succeeded", result);
        if (result.examined > 0) {
          logger.info(result, "outbox relay batch completed");
        }
      } catch (error) {
        observation.finish("failed");
        logger.error({ error: safeError(error) }, "outbox relay batch failed");
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

function matchesOutboxAuthority(event: PendingOutboxEvent, envelope: DurableJobEnvelope): boolean {
  return (
    event.organizationId === envelope.organizationId &&
    event.eventType === envelope.type &&
    event.idempotencyKey === envelope.idempotencyKey
  );
}
