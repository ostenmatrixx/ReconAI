import { once } from "node:events";
import { createServer } from "node:http";

import { durableQueueName } from "@workspace/connectors";
import { startObservability, type ObservabilityRuntime } from "@workspace/observability";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  durableQueueMonitorLeaseKey,
  durableQueueMonitorLeaseTtlMs,
  observeDurableQueueOnce,
} from "./queue-observability.js";

const environment = "telemetry-integration";
const queueName = durableQueueName(environment);
const now = new Date("2026-07-29T00:10:00.000Z");
const payloadSentinel = "customer-payload-secret-sentinel";
const tenantSentinel = "tenant-identifier-secret-sentinel";
let runtime: ObservabilityRuntime | undefined;
let producerRedis: Redis | undefined;
let leaderRedis: Redis | undefined;
let followerRedis: Redis | undefined;
let producerQueue: Queue | undefined;
let leaderQueue: Queue | undefined;
let followerQueue: Queue | undefined;
let closeCaptureServer: (() => Promise<void>) | undefined;

afterAll(async () => {
  const leaseKey = durableQueueMonitorLeaseKey(queueName);
  await leaderRedis?.del(leaseKey);
  await producerQueue?.obliterate({ force: true });
  await Promise.all([producerQueue?.close(), leaderQueue?.close(), followerQueue?.close()]);
  await Promise.all([producerRedis?.quit(), leaderRedis?.quit(), followerRedis?.quit()]);
  await runtime?.shutdown();
  await closeCaptureServer?.();
});

describe("authenticated Redis durable queue telemetry", { concurrent: false }, () => {
  it("exports one bounded leader snapshot while a second replica remains read-free", async () => {
    const exports: Buffer[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.url === "/v1/metrics") exports.push(Buffer.concat(chunks));
        response.writeHead(200, { "content-type": "application/x-protobuf" });
        response.end();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("capture server has no TCP port");
    closeCaptureServer = async () => {
      server.close();
      await once(server, "close");
    };
    runtime = startObservability({
      endpoint: `http://127.0.0.1:${String(address.port)}`,
      environment,
      production: false,
      serviceName: "reconai-queue-telemetry-integration",
      traceSampleRatio: 0,
      metricExportIntervalMs: 1_000,
      exportTimeoutMs: 500,
      metricTemporality: "delta",
    });

    const redisUrl = requiredEnvironment("REDIS_URL");
    producerRedis = monitorRedis(redisUrl);
    leaderRedis = monitorRedis(redisUrl);
    followerRedis = monitorRedis(redisUrl);
    producerQueue = new Queue(queueName, { connection: producerRedis });
    leaderQueue = new Queue(queueName, { connection: leaderRedis });
    followerQueue = new Queue(queueName, { connection: followerRedis });
    await producerQueue.obliterate({ force: true });

    const jobData = { organizationId: tenantSentinel, payload: payloadSentinel };
    await producerQueue.add("waiting-observation", jobData, {
      jobId: "waiting-observation",
      timestamp: now.getTime() - 120_000,
    });
    await producerQueue.add("prioritized-observation", jobData, {
      jobId: "prioritized-observation",
      priority: 1,
      timestamp: now.getTime() - 30_000,
    });
    await producerQueue.add("delayed-observation", jobData, {
      jobId: "delayed-observation",
      delay: 600_000,
      timestamp: now.getTime() - 300_000,
    });

    const leaseKey = durableQueueMonitorLeaseKey(queueName);
    const leaseTtlMs = durableQueueMonitorLeaseTtlMs(15_000);
    const leader = await observeDurableQueueOnce({
      inspector: leaderQueue,
      leaseStore: leaderRedis,
      leaseKey,
      leaseToken: "integration-leader-token",
      leaseTtlMs,
      now,
    });
    await runtime.forceFlush();
    const serialized = Buffer.concat(exports).toString("latin1");
    expect(serialized).toContain("reconai.queue.jobs");
    expect(serialized).toContain("reconai.queue.ready_head.maximum_age");
    expect(serialized).toContain("reconai.queue.monitor.polls");
    expect(serialized).toContain("succeeded");
    expect(serialized).not.toContain(payloadSentinel);
    expect(serialized).not.toContain(tenantSentinel);
    expect(serialized).not.toContain("integration-leader-token");
    expect(serialized).not.toContain(leaseKey);

    const exportCursor = exports.length;
    const followerCounts = vi.spyOn(followerQueue, "getJobCounts");
    const followerJobs = vi.spyOn(followerQueue, "getJobs");
    const follower = await observeDurableQueueOnce({
      inspector: followerQueue,
      leaseStore: followerRedis,
      leaseKey,
      leaseToken: "integration-follower-token",
      leaseTtlMs,
      now,
    });

    expect(leader).toEqual({
      outcome: "recorded",
      snapshot: {
        counts: {
          waiting: 1,
          paused: 0,
          active: 0,
          delayed: 1,
          prioritized: 1,
          "waiting-children": 0,
          failed: 0,
        },
        readyHeadMaximumAgeSeconds: 120,
      },
    });
    expect(follower).toEqual({ outcome: "not_leader" });
    expect(followerCounts).not.toHaveBeenCalled();
    expect(followerJobs).not.toHaveBeenCalled();
    expect(await leaderRedis.pttl(leaseKey)).toBeGreaterThan(0);
    expect(await leaderRedis.keys(`${queueName}:observability:*`)).toEqual([leaseKey]);
    await runtime.forceFlush();
    const followerSerialized = Buffer.concat(exports.slice(exportCursor)).toString("latin1");
    expect(followerSerialized).not.toContain("reconai.queue.jobs");
    expect(followerSerialized).not.toContain("reconai.queue.ready_head.maximum_age");
  });
});

function monitorRedis(url: string): Redis {
  return new Redis(url, {
    connectTimeout: 1_000,
    commandTimeout: 1_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the Redis integration suite`);
  return value;
}
