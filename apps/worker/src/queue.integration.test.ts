import {
  connectorJobId,
  connectorQueueName,
  type ConnectorJobEnvelope,
  type DurableJobEnvelope,
} from "@workspace/connectors";
import type {
  JobExecutionBeginResult,
  JobExecutionFailureStatus,
  JobExecutionLedger,
} from "@workspace/database";
import { OrganizationIdSchema } from "@workspace/domain";
import { Job, Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildConnectorWorker } from "./worker.js";

let producerConnection: Redis | undefined;
let workerConnection: Redis | undefined;
let eventConnection: Redis | undefined;
let queue: Queue | undefined;
let queueEvents: QueueEvents | undefined;
let worker: ReturnType<typeof buildConnectorWorker> | undefined;
const loadDurableJobAuthority = vi.fn(async (data: DurableJobEnvelope) => data);
const processDurableJob = vi.fn(async () => Promise.resolve());
const beginExecution = vi.fn(async (): Promise<JobExecutionBeginResult> => ({
  outcome: "acquired",
  token: "a".repeat(43),
}));
const succeedExecution = vi.fn(async () => true);
const executionLedger: JobExecutionLedger = {
  begin: beginExecution,
  heartbeat: vi.fn(async () => true),
  succeed: succeedExecution,
  fail: vi.fn(async (): Promise<JobExecutionFailureStatus> => "retryable"),
};

describe("live Redis durable queue contract", { concurrent: false }, () => {
  beforeAll(async () => {
    const url = requiredEnvironment("REDIS_URL");
    producerConnection = redis(url);
    workerConnection = redis(url);
    eventConnection = redis(url);
    const queueName = connectorQueueName("integration");
    queue = new Queue(queueName, { connection: producerConnection });
    await queue.obliterate({ force: true });
    queueEvents = new QueueEvents(queueName, { connection: eventConnection });
    worker = buildConnectorWorker({
      redis: workerConnection,
      environment: "integration",
      executionLedger,
      loadDurableJobAuthority,
      processDurableJob,
    });
    await Promise.all([queueEvents.waitUntilReady(), worker.waitUntilReady()]);
  });

  afterAll(async () => {
    await worker?.close();
    await queueEvents?.close();
    await queue?.obliterate({ force: true });
    await queue?.close();
    await Promise.all([
      producerConnection?.quit(),
      workerConnection?.quit(),
      eventConnection?.quit(),
    ]);
  });

  it("processes a tenant-bound job and deduplicates its stable queue identity", async () => {
    const durableQueue = requiredQueue(queue);
    const events = requiredQueueEvents(queueEvents);
    const envelope: ConnectorJobEnvelope = {
      schemaVersion: 1,
      type: "csv.import.commit",
      organizationId: OrganizationIdSchema.parse("00000000-0000-4000-8000-000000000001"),
      connectionId: "00000000-0000-4000-8000-000000000002",
      importId: "00000000-0000-4000-8000-000000000003",
      correlationId: "00000000-0000-4000-8000-000000000004",
      idempotencyKey: "csv-import:integration:commit:v1",
      requestedBy: "00000000-0000-4000-8000-000000000005",
      createdAt: "2026-07-27T12:00:00.000Z",
    };
    const id = connectorJobId(envelope);
    const first = await durableQueue.add(envelope.type, envelope, {
      jobId: id,
      attempts: 3,
      backoff: { type: "custom" },
    });
    await expect(first.waitUntilFinished(events, 5000)).resolves.toBeNull();
    const duplicate = await durableQueue.add(envelope.type, envelope, { jobId: id });
    expect(duplicate.id).toBe(first.id);
    expect(loadDurableJobAuthority).toHaveBeenCalledTimes(1);
    expect(processDurableJob).toHaveBeenCalledTimes(1);
    expect(beginExecution).toHaveBeenCalledTimes(1);
    expect(succeedExecution).toHaveBeenCalledTimes(1);
  });

  it("fails an invalid capability without spending its retry budget", async () => {
    const durableQueue = requiredQueue(queue);
    const events = requiredQueueEvents(queueEvents);
    const invalid = await durableQueue.add(
      "connector.admin.execute",
      {
        schemaVersion: 1,
        type: "connector.admin.execute",
        organizationId: "00000000-0000-4000-8000-000000000001",
      },
      { jobId: "invalid-capability", attempts: 5, backoff: { type: "custom" } },
    );
    await expect(invalid.waitUntilFinished(events, 5000)).rejects.toThrow(
      "invalid durable job schema",
    );
    const stored = await Job.fromId(durableQueue, "invalid-capability");
    expect(stored?.attemptsMade).toBe(1);
  });
});

function redis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the Redis integration suite`);
  return value;
}

function requiredQueue(value: Queue | undefined): Queue {
  if (!value) throw new Error("integration queue was not initialized");
  return value;
}

function requiredQueueEvents(value: QueueEvents | undefined): QueueEvents {
  if (!value) throw new Error("integration queue events were not initialized");
  return value;
}
