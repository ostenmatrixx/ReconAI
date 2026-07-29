import {
  DurableJobEnvelopeSchema,
  durableJobId,
  durableQueueName,
  retryDelayMs,
  type DurableJobEnvelope,
} from "@workspace/connectors";
import type { JobExecutionLedger } from "@workspace/database";
import {
  createLogger,
  safeError,
  startDurableJobObservation,
  type DurableJobOutcome,
} from "@workspace/observability";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";

const executionLeaseSeconds = 3600;
const executionHeartbeatIntervalMs = 60_000;

export interface WorkerDependencies {
  readonly redis: Redis;
  readonly environment: string;
  readonly executionLedger: JobExecutionLedger;
  /**
   * Returns the exact tenant-bound outbox payload. Queue-supplied trace context is not trusted
   * until this authority matches the complete canonical envelope identity.
   */
  readonly loadDurableJobAuthority: (data: DurableJobEnvelope) => Promise<unknown>;
  readonly processDurableJob: (data: unknown) => Promise<void>;
}

export function buildConnectorWorker(dependencies: WorkerDependencies): Worker {
  const logger = createLogger("reconai-worker", dependencies.environment);
  const worker = new Worker(
    durableQueueName(dependencies.environment),
    async (job: Job) => {
      let envelope: DurableJobEnvelope;
      try {
        envelope = await authorizeQueuedDurableJob({
          data: job.data,
          jobId: job.id,
          loadAuthority: dependencies.loadDurableJobAuthority,
        });
      } catch (error) {
        const parsed = DurableJobEnvelopeSchema.safeParse(job.data);
        const rejectedObservation = startDurableJobObservation({
          jobType: parsed.success ? parsed.data.type : "invalid",
          attempt: job.attemptsMade + 1,
        });
        return rejectedObservation.run(() => {
          rejectedObservation.finish(
            error instanceof UnrecoverableError ? "rejected" : "failed_retryable",
          );
          throw error;
        });
      }
      const observation = startDurableJobObservation({
        jobType: envelope.type,
        attempt: job.attemptsMade + 1,
        ...(envelope.traceContext
          ? { trustedParentTraceparent: envelope.traceContext.traceparent }
          : {}),
      });
      let outcome: DurableJobOutcome | undefined;
      const maximumAttempts = validatedMaximumAttempts(job.opts.attempts);
      return observation.run(async () => {
        try {
          const expectedJobId = durableJobId(envelope);
          const execution = await dependencies.executionLedger.begin({
            envelope,
            queueName: durableQueueName(dependencies.environment),
            jobId: expectedJobId,
            maximumAttempts,
            leaseSeconds: executionLeaseSeconds,
          });
          if (execution.outcome !== "acquired") {
            switch (execution.outcome) {
              case "already_succeeded":
                outcome = "skipped";
                logger.info(
                  {
                    jobId: job.id,
                    type: envelope.type,
                    correlationId: envelope.correlationId,
                  },
                  "skipped durable job whose execution already succeeded",
                );
                return;
              case "dead_lettered":
                outcome = "dead_lettered";
                throw new UnrecoverableError("durable job execution is already dead-lettered");
              case "busy":
                outcome = "busy";
                throw new Error("durable job execution lease is still active");
            }
          }

          const leaseHeartbeat = startExecutionLeaseHeartbeat(dependencies.executionLedger, {
            organizationId: envelope.organizationId,
            idempotencyKey: envelope.idempotencyKey,
            token: execution.token,
            leaseSeconds: executionLeaseSeconds,
          });
          try {
            await dependencies.processDurableJob(envelope);
            await leaseHeartbeat.stop();
            const succeeded = await dependencies.executionLedger.succeed({
              organizationId: envelope.organizationId,
              idempotencyKey: envelope.idempotencyKey,
              token: execution.token,
            });
            if (!succeeded)
              throw new Error("durable job execution lease was lost before completion");
          } catch (error) {
            try {
              await leaseHeartbeat.stop();
            } catch (heartbeatError) {
              logger.error(
                {
                  jobId: job.id,
                  correlationId: envelope.correlationId,
                  error: safeError(heartbeatError),
                },
                "durable job execution heartbeat failed",
              );
            }
            try {
              await dependencies.executionLedger.fail({
                organizationId: envelope.organizationId,
                idempotencyKey: envelope.idempotencyKey,
                token: execution.token,
                errorCode:
                  error instanceof UnrecoverableError
                    ? "JOB_HANDLER_TERMINAL"
                    : "JOB_HANDLER_RETRYABLE",
                terminal:
                  error instanceof UnrecoverableError || job.attemptsMade + 1 >= maximumAttempts,
              });
            } catch (ledgerError) {
              logger.error(
                {
                  jobId: job.id,
                  correlationId: envelope.correlationId,
                  error: safeError(ledgerError),
                },
                "durable job execution failure state could not be recorded",
              );
            }
            throw error;
          }
          outcome = "succeeded";
          logger.info(
            {
              jobId: job.id,
              type: envelope.type,
              correlationId: envelope.correlationId,
              attempt: job.attemptsMade + 1,
            },
            "durable job completed",
          );
        } catch (error) {
          outcome ??=
            error instanceof UnrecoverableError || job.attemptsMade + 1 >= maximumAttempts
              ? "failed_terminal"
              : "failed_retryable";
          throw error;
        } finally {
          observation.finish(outcome ?? "failed_retryable");
        }
      });
    },
    {
      connection: dependencies.redis,
      concurrency: 5,
      lockDuration: 30_000,
      maxStalledCount: 1,
      limiter: { max: 20, duration: 1_000 },
      settings: {
        backoffStrategy: (attempt, _type, error) => durableJobRetryDelayMs(attempt, error),
      },
    },
  );

  worker.on("failed", (job, error) => {
    const parsedJob = DurableJobEnvelopeSchema.safeParse(job?.data);
    logger.error(
      {
        jobId: job?.id,
        correlationId: parsedJob.success ? parsedJob.data.correlationId : undefined,
        attempt: job?.attemptsMade,
        error: safeError(error),
      },
      "durable job failed",
    );
  });

  return worker;
}

export async function authorizeQueuedDurableJob(input: {
  readonly data: unknown;
  readonly jobId: string | undefined;
  readonly loadAuthority: (envelope: DurableJobEnvelope) => Promise<unknown>;
}): Promise<DurableJobEnvelope> {
  const parsed = DurableJobEnvelopeSchema.safeParse(input.data);
  if (!parsed.success) {
    throw new UnrecoverableError("invalid durable job schema");
  }
  const expectedJobId = durableJobId(parsed.data);
  if (input.jobId !== expectedJobId) {
    throw new UnrecoverableError("durable job identity does not match its envelope");
  }

  const authorized = DurableJobEnvelopeSchema.safeParse(await input.loadAuthority(parsed.data));
  if (!authorized.success) {
    throw new UnrecoverableError("durable outbox authority has an invalid schema");
  }
  if (durableJobId(authorized.data) !== expectedJobId) {
    throw new UnrecoverableError("durable job does not match its tenant-bound outbox authority");
  }
  return authorized.data;
}

export function durableJobRetryDelayMs(attempt: number, error: unknown): number {
  const exponentialDelayMs = retryDelayMs(attempt);
  if (!error || typeof error !== "object") return exponentialDelayMs;
  const retryAfterMs = "retryAfterMs" in error ? error.retryAfterMs : undefined;
  if (typeof retryAfterMs !== "number" || !Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1) {
    return exponentialDelayMs;
  }
  return Math.min(15 * 60 * 1_000, Math.max(exponentialDelayMs, retryAfterMs));
}

interface ExecutionLeaseHeartbeat {
  stop(): Promise<void>;
}

function startExecutionLeaseHeartbeat(
  ledger: JobExecutionLedger,
  input: {
    readonly organizationId: DurableJobEnvelope["organizationId"];
    readonly idempotencyKey: string;
    readonly token: string;
    readonly leaseSeconds: number;
  },
): ExecutionLeaseHeartbeat {
  let stopped = false;
  let heartbeatError: unknown;
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending.then(async () => {
      if (stopped || heartbeatError !== undefined) return;
      try {
        const renewed = await ledger.heartbeat(input);
        if (!renewed) heartbeatError = new Error("durable job execution lease was lost");
      } catch (error) {
        heartbeatError = error;
      }
    });
  }, executionHeartbeatIntervalMs);
  timer.unref();

  return {
    stop: async () => {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
      await pending;
      if (heartbeatError !== undefined) {
        throw heartbeatError instanceof Error
          ? heartbeatError
          : new Error("durable job execution heartbeat failed", { cause: heartbeatError });
      }
    },
  };
}

function validatedMaximumAttempts(value: number | undefined): number {
  const attempts = value ?? 1;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 100) {
    throw new UnrecoverableError("durable job retry budget is invalid");
  }
  return attempts;
}
