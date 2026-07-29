import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";

import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { API_RATE_LIMIT_MAXIMUM_REQUESTS, apiRateLimitPluginOptions } from "./rate-limit.js";

const keySecret = "c3ludGhldGljLXJhdGUtbGltaXQta2V5LW1hdGVyaWFsLTAwMDE";

describe("distributed API rate limiting", () => {
  it("shares one environment-scoped budget across API replicas without storing a raw IP", async () => {
    const redis = new SharedRedisRateLimitDouble();
    let handled = 0;
    const first = await limitedApp(redis, () => {
      handled += 1;
    });
    const second = await limitedApp(redis, () => {
      handled += 1;
    });

    for (let index = 0; index < API_RATE_LIMIT_MAXIMUM_REQUESTS; index += 1) {
      const app = index % 2 === 0 ? first : second;
      const response = await app.inject({ method: "GET", url: "/limited" });
      expect(response.statusCode).toBe(200);
    }
    const exceeded = await second.inject({ method: "GET", url: "/limited" });

    expect(exceeded.statusCode).toBe(429);
    expect(exceeded.json()).toMatchObject({
      code: "RATE_LIMITED",
      message: "request rate exceeded",
    });
    expect(handled).toBe(API_RATE_LIMIT_MAXIMUM_REQUESTS);
    expect(redis.storedKeys()).toHaveLength(1);
    expect(redis.storedKeys()[0]).toMatch(/^reconai-test-api-rate-limit-v1-[a-f0-9]{64}$/u);
    expect(redis.storedKeys()[0]).not.toContain("127.0.0.1");

    await first.close();
    await second.close();
  });

  it("fails closed without invoking a route when the shared store is unavailable", async () => {
    const redis = new SharedRedisRateLimitDouble();
    redis.fail = true;
    let handled = false;
    const app = await limitedApp(redis, () => {
      handled = true;
    });

    const response = await app.inject({ method: "GET", url: "/limited" });

    expect(response.statusCode).toBe(500);
    expect(handled).toBe(false);
    await app.close();
  });

  it("uses forwarding data only when the connected proxy is explicitly trusted", async () => {
    const untrustedRedis = new SharedRedisRateLimitDouble();
    const untrusted = await limitedApp(untrustedRedis, () => undefined, ["10.0.0.0/8"]);
    await untrusted.inject({
      method: "GET",
      url: "/limited",
      remoteAddress: "198.51.100.20",
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    expect(untrustedRedis.storedKeys()).toEqual([rateLimitKeyForAddress("198.51.100.20")]);
    await untrusted.close();

    const trustedRedis = new SharedRedisRateLimitDouble();
    const trusted = await limitedApp(trustedRedis, () => undefined, ["10.0.0.0/8"]);
    await trusted.inject({
      method: "GET",
      url: "/limited",
      remoteAddress: "10.1.2.3",
      headers: { "x-forwarded-for": "203.0.113.99, 198.51.100.30" },
    });
    expect(trustedRedis.storedKeys()).toEqual([rateLimitKeyForAddress("198.51.100.30")]);
    await trusted.close();
  });

  it("rejects invalid namespace and key material before registering routes", () => {
    const redis = new SharedRedisRateLimitDouble();
    expect(() =>
      apiRateLimitPluginOptions({
        store: "redis",
        redis,
        environment: "INVALID",
        keySecret,
      }),
    ).toThrow("namespace");
    expect(() =>
      apiRateLimitPluginOptions({
        store: "redis",
        redis,
        environment: "test",
        keySecret: "short",
      }),
    ).toThrow("key secret");
  });
});

async function limitedApp(
  redis: SharedRedisRateLimitDouble,
  onHandled: () => void,
  trustedProxies: readonly string[] = [],
) {
  const app = Fastify({
    logger: false,
    trustProxy: trustedProxies.length > 0 ? [...trustedProxies] : false,
  });
  await app.register(
    rateLimit,
    apiRateLimitPluginOptions({
      store: "redis",
      redis,
      environment: "test",
      keySecret,
    }),
  );
  app.get("/limited", async () => {
    onHandled();
    return { status: "ok" };
  });
  return app;
}

function rateLimitKeyForAddress(address: string): string {
  return `reconai-test-api-rate-limit-v1-${createHmac("sha256", Buffer.from(keySecret, "base64url"))
    .update("client-ip\0", "utf8")
    .update(address, "utf8")
    .digest("hex")}`;
}

type RateLimitCallback = (
  error: Error | null,
  result: readonly [current: number, ttl: number] | null,
) => void;

class SharedRedisRateLimitDouble {
  public fail = false;
  public rateLimit:
    | ((
        key: string,
        timeWindow: number,
        maximum: number,
        continueExceeding: boolean,
        exponentialBackoff: boolean,
        callback: RateLimitCallback,
      ) => void)
    | undefined;
  public rateLimitRead: ((key: string, callback: RateLimitCallback) => void) | undefined;
  readonly #entries = new Map<string, { count: number; expiresAt: number }>();

  public defineCommand(name: string): void {
    if (name === "rateLimit") {
      this.rateLimit = (key, timeWindow, _maximum, _continue, _backoff, callback) => {
        if (this.fail) {
          callback(new Error("synthetic shared rate-limit store failure"), null);
          return;
        }
        const now = Date.now();
        const existing = this.#entries.get(key);
        const entry =
          existing && existing.expiresAt > now
            ? existing
            : { count: 0, expiresAt: now + timeWindow };
        entry.count += 1;
        this.#entries.set(key, entry);
        callback(null, [entry.count, entry.expiresAt - now]);
      };
      return;
    }
    if (name === "rateLimitRead") {
      this.rateLimitRead = (key, callback) => {
        const entry = this.#entries.get(key);
        callback(null, entry ? [entry.count, Math.max(0, entry.expiresAt - Date.now())] : [0, -2]);
      };
    }
  }

  public storedKeys(): readonly string[] {
    return [...this.#entries.keys()].sort((left, right) => left.localeCompare(right, "en"));
  }
}
