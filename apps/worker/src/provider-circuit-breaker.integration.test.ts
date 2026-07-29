import { OrganizationIdSchema } from "@workspace/domain";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RedisProviderRequestCircuit, providerCircuitKey } from "./provider-circuit-breaker.js";

const firstInput = {
  organizationId: OrganizationIdSchema.parse("63000000-0000-4000-8000-000000000001"),
  connectionId: "64000000-0000-4000-8000-000000000001",
  provider: "stripe" as const,
};
const secondInput = {
  organizationId: OrganizationIdSchema.parse("63000000-0000-4000-8000-000000000002"),
  connectionId: "64000000-0000-4000-8000-000000000002",
  provider: "stripe" as const,
};
let leaderRedis: Redis | undefined;
let followerRedis: Redis | undefined;

describe("live Redis provider request circuit", { concurrent: false }, () => {
  beforeAll(async () => {
    const redisUrl = requiredEnvironment("REDIS_URL");
    leaderRedis = circuitRedis(redisUrl);
    followerRedis = circuitRedis(redisUrl);
    await Promise.all([leaderRedis.connect(), followerRedis.connect()]);
    await Promise.all([leaderRedis.ping(), followerRedis.ping()]);
    await deleteCircuitKeys(leaderRedis);
  });

  afterAll(async () => {
    if (leaderRedis) await deleteCircuitKeys(leaderRedis);
    await Promise.all([leaderRedis?.quit(), followerRedis?.quit()]);
  });

  it("coordinates open, one half-open probe, recovery, and tenant isolation across clients", async () => {
    const firstClient = requiredRedis(leaderRedis);
    const secondClient = requiredRedis(followerRedis);
    let now = 1_000_000;
    let tokenSequence = 0;
    const token = () => (++tokenSequence).toString(16).padStart(32, "0");
    const leader = new RedisProviderRequestCircuit({
      client: firstClient,
      environment: "circuit-integration",
      failureThreshold: 3,
      openMs: 1_000,
      probeLeaseMs: 1_000,
      now: () => now,
      token,
    });
    const follower = new RedisProviderRequestCircuit({
      client: secondClient,
      environment: "circuit-integration",
      failureThreshold: 3,
      openMs: 1_000,
      probeLeaseMs: 1_000,
      now: () => now,
      token,
    });

    for (let failure = 0; failure < 3; failure += 1) {
      const acquired = await leader.acquire(firstInput);
      expect(acquired.outcome).toBe("permitted");
      if (acquired.outcome !== "permitted") throw new Error("expected a circuit permit");
      await leader.recordTransientFailure({
        ...firstInput,
        permit: acquired.permit,
        forceOpen: false,
      });
    }

    await expect(follower.acquire(firstInput)).resolves.toEqual({
      outcome: "open",
      retryAfterMs: 1_000,
    });
    await expect(follower.acquire(secondInput)).resolves.toMatchObject({
      outcome: "permitted",
      permit: { state: "closed" },
    });

    now += 1_000;
    const probe = await leader.acquire(firstInput);
    expect(probe).toMatchObject({
      outcome: "permitted",
      permit: { state: "half_open" },
    });
    await expect(follower.acquire(firstInput)).resolves.toEqual({
      outcome: "open",
      retryAfterMs: 1_000,
    });
    if (probe.outcome !== "permitted") throw new Error("expected a half-open probe");
    await leader.recordTransientFailure({
      ...firstInput,
      permit: probe.permit,
      forceOpen: false,
    });

    now += 1_000;
    const recoveryProbe = await follower.acquire(firstInput);
    if (recoveryProbe.outcome !== "permitted") throw new Error("expected a recovery probe");
    expect(recoveryProbe.permit.state).toBe("half_open");
    await follower.recordSuccess({
      ...firstInput,
      permit: recoveryProbe.permit,
    });
    await expect(leader.acquire(firstInput)).resolves.toMatchObject({
      outcome: "permitted",
      permit: { state: "closed" },
    });

    const keys = await firstClient.keys("reconai:circuit-integration:provider-circuit:v1:*");
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => !key.includes(firstInput.organizationId))).toBe(true);
    expect(keys.every((key) => !key.includes(firstInput.connectionId))).toBe(true);
    expect(
      await firstClient.pttl(providerCircuitKey("circuit-integration", secondInput)),
    ).toBeGreaterThan(0);
  });

  it("opens immediately for a bounded provider rate-limit interval", async () => {
    const client = requiredRedis(leaderRedis);
    let now = 2_000_000;
    let tokenSequence = 100;
    const circuit = new RedisProviderRequestCircuit({
      client,
      environment: "circuit-integration",
      failureThreshold: 3,
      openMs: 1_000,
      probeLeaseMs: 1_000,
      now: () => now,
      token: () => (++tokenSequence).toString(16).padStart(32, "0"),
    });
    const acquired = await circuit.acquire(firstInput);
    if (acquired.outcome !== "permitted") throw new Error("expected a circuit permit");
    await circuit.recordTransientFailure({
      ...firstInput,
      permit: acquired.permit,
      forceOpen: true,
      retryAfterMs: 120_000,
    });
    await expect(circuit.acquire(firstInput)).resolves.toEqual({
      outcome: "open",
      retryAfterMs: 120_000,
    });
    now += 120_000;
    await expect(circuit.acquire(firstInput)).resolves.toMatchObject({
      outcome: "permitted",
      permit: { state: "half_open" },
    });
  });
});

function circuitRedis(url: string): Redis {
  return new Redis(url, {
    connectTimeout: 1_000,
    commandTimeout: 1_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    lazyConnect: true,
  });
}

async function deleteCircuitKeys(redis: Redis): Promise<void> {
  const keys = await redis.keys("reconai:circuit-integration:provider-circuit:v1:*");
  if (keys.length > 0) await redis.del(...keys);
}

function requiredRedis(value: Redis | undefined): Redis {
  if (!value) throw new Error("Redis connection was not initialized");
  return value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for provider circuit integration tests`);
  return value;
}
