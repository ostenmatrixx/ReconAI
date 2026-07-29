import { randomBytes } from "node:crypto";

import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RedisSessionRevocationStore } from "./session-revocation";

const issuer = "https://identity.example.test/realms/reconai";
const keySecret = "synthetic-session-secret-material-over-thirty-two-characters";
const subject = "synthetic-subject-1";
const sessionId = "synthetic-session-1";
const jwtId = "synthetic-logout-token-1";

let firstStore: RedisSessionRevocationStore | undefined;
let secondStore: RedisSessionRevocationStore | undefined;
let inspectionRedis: Redis | undefined;
let namespace = "";

describe("live distributed OIDC session revocation", { concurrent: false }, () => {
  beforeAll(async () => {
    const redisUrl = requiredEnvironment("REDIS_URL");
    const environment = `sr-${randomBytes(4).toString("hex")}`;
    namespace = `reconai-${environment}-web-session-revocation-v1`;
    const configuration = {
      store: "redis",
      environment,
      keySecret,
      redisUrl,
      connectTimeoutMilliseconds: 1_000,
      commandTimeoutMilliseconds: 1_000,
    } as const;

    inspectionRedis = redis(redisUrl);
    await inspectionRedis.connect();
    await inspectionRedis.ping();
    firstStore = new RedisSessionRevocationStore(configuration);
    secondStore = new RedisSessionRevocationStore(configuration);
  });

  afterAll(async () => {
    firstStore?.disconnect();
    secondStore?.disconnect();
    if (inspectionRedis?.status === "ready") {
      const keys = await keysForNamespace(inspectionRedis, namespace);
      if (keys.length > 0) await inspectionRedis.unlink(...keys);
      await inspectionRedis.quit();
    } else {
      inspectionRedis?.disconnect();
    }
  });

  it("shares revocation and replay state across separate Redis clients without raw identifiers", async () => {
    const first = requiredStore(firstStore);
    const second = requiredStore(secondStore);
    const issuedAt = Math.floor(Date.now() / 1_000);
    const event = { issuer, subject, sessionId, issuedAt, jwtId } as const;

    await expect(first.recordLogout(event)).resolves.toBe("recorded");
    await expect(
      second.isRevoked({
        issuer,
        subject,
        sessionId,
        startedAt: issuedAt - 1,
      }),
    ).resolves.toBe(true);
    await expect(
      second.isRevoked({
        issuer,
        subject,
        sessionId: "synthetic-session-2",
        startedAt: issuedAt - 1,
      }),
    ).resolves.toBe(false);
    await expect(second.recordLogout(event)).resolves.toBe("replayed");

    const redisClient = requiredRedis(inspectionRedis);
    const keys = await keysForNamespace(redisClient, namespace);
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).toMatch(new RegExp(`^${namespace}:(replay|sid):[a-f0-9]{64}$`, "u"));
      expect(key).not.toContain(subject);
      expect(key).not.toContain(sessionId);
      expect(key).not.toContain(jwtId);
      expect(await redisClient.ttl(key)).toBeGreaterThan(0);
    }
  });
});

function redis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
    commandTimeout: 1_000,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    lazyConnect: true,
    connectionName: "reconai-session-revocation-integration-inspection",
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the session-revocation integration suite`);
  return value;
}

function requiredStore(
  value: RedisSessionRevocationStore | undefined,
): RedisSessionRevocationStore {
  if (!value) throw new Error("session-revocation integration store is unavailable");
  return value;
}

function requiredRedis(value: Redis | undefined): Redis {
  if (!value) throw new Error("session-revocation integration Redis client is unavailable");
  return value;
}

async function keysForNamespace(redisClient: Redis, prefix: string): Promise<readonly string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, page] = await redisClient.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100);
    cursor = nextCursor;
    keys.push(...page);
    if (keys.length > 10) {
      throw new Error(
        "session-revocation integration namespace contained an unexpected number of keys",
      );
    }
  } while (cursor !== "0");
  return keys.sort((left, right) => left.localeCompare(right, "en"));
}
