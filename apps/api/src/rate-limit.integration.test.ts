import { randomBytes } from "node:crypto";

import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_RATE_LIMIT_MAXIMUM_REQUESTS, apiRateLimitPluginOptions } from "./rate-limit.js";

const keySecret = "c3ludGhldGljLXJhdGUtbGltaXQta2V5LW1hdGVyaWFsLTAwMDE";

let firstRedis: Redis | undefined;
let secondRedis: Redis | undefined;
let firstApp: FastifyInstance | undefined;
let secondApp: FastifyInstance | undefined;
let namespace = "";

describe("live distributed API rate limiting", { concurrent: false }, () => {
  beforeAll(async () => {
    const url = requiredEnvironment("REDIS_URL");
    const environment = `rl-${randomBytes(4).toString("hex")}`;
    namespace = `reconai-${environment}-api-rate-limit-v1-`;
    firstRedis = redis(url, "first");
    secondRedis = redis(url, "second");
    await Promise.all([firstRedis.connect(), secondRedis.connect()]);
    await Promise.all([firstRedis.ping(), secondRedis.ping()]);
    firstApp = await limitedApp(firstRedis, environment);
    secondApp = await limitedApp(secondRedis, environment);
  });

  afterAll(async () => {
    if (firstApp) await firstApp.close();
    if (secondApp) await secondApp.close();
    if (firstRedis) {
      const keys = await keysForNamespace(firstRedis, namespace);
      if (keys.length > 0) await firstRedis.unlink(...keys);
    }
    if (firstRedis) await firstRedis.quit();
    if (secondRedis) await secondRedis.quit();
  });

  it("atomically enforces one shared budget across separate Redis clients", async () => {
    const first = requiredApp(firstApp);
    const second = requiredApp(secondApp);
    const responses = await Promise.all(
      Array.from({ length: API_RATE_LIMIT_MAXIMUM_REQUESTS + 1 }, (_, index) =>
        (index % 2 === 0 ? first : second).inject({ method: "GET", url: "/limited" }),
      ),
    );

    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(
      API_RATE_LIMIT_MAXIMUM_REQUESTS,
    );
    expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(1);
    const keys = await keysForNamespace(requiredRedis(firstRedis), namespace);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^${namespace}[a-f0-9]{64}$`, "u"));
    expect(keys[0]).not.toContain("127.0.0.1");
    expect(await requiredRedis(firstRedis).pttl(requiredKey(keys[0]))).toBeGreaterThan(0);
  });
});

async function limitedApp(redisClient: Redis, environment: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: false });
  await app.register(
    rateLimit,
    apiRateLimitPluginOptions({
      store: "redis",
      redis: redisClient,
      environment,
      keySecret,
    }),
  );
  app.get("/limited", async () => ({ status: "ok" }));
  return app;
}

function redis(url: string, suffix: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1000,
    commandTimeout: 1000,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    lazyConnect: true,
    connectionName: `reconai-rate-limit-integration-${suffix}`,
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the Redis rate-limit integration suite`);
  return value;
}

function requiredApp(value: FastifyInstance | undefined): FastifyInstance {
  if (!value) throw new Error("rate-limit integration app is unavailable");
  return value;
}

function requiredRedis(value: Redis | undefined): Redis {
  if (!value) throw new Error("rate-limit integration Redis client is unavailable");
  return value;
}

function requiredKey(value: string | undefined): string {
  if (!value) throw new Error("rate-limit integration key is unavailable");
  return value;
}

async function keysForNamespace(redisClient: Redis, prefix: string): Promise<readonly string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, page] = await redisClient.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100);
    cursor = nextCursor;
    keys.push(...page);
    if (keys.length > 10) {
      throw new Error("rate-limit integration namespace contained an unexpected number of keys");
    }
  } while (cursor !== "0");
  return keys.sort((left, right) => left.localeCompare(right, "en"));
}
