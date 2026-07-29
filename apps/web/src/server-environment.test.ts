import { afterEach, describe, expect, it, vi } from "vitest";

import {
  privateResponseHeaders,
  readConfiguredOrigin,
  readSessionRevocationConfiguration,
  readSessionSecret,
} from "./server-environment";

describe("web server environment", { concurrent: false }, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed when production has no strong session secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("SESSION_SECRET", "");

    expect(() => readSessionSecret()).toThrow("production session configuration");
  });

  it("allows the documented development fallback only outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", "");

    expect(readSessionSecret()).toBe("development-only-session-secret-change-me");
  });

  it("rejects non-HTTPS and non-origin production upstream configuration", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("API_ORIGIN", "http://api.internal:4000");
    expect(() => readConfiguredOrigin("API_ORIGIN", "http://127.0.0.1:4000")).toThrow(
      "must use HTTPS",
    );

    vi.stubEnv("API_ORIGIN", "https://user:password@api.example.test/private");
    expect(() => readConfiguredOrigin("API_ORIGIN", "http://127.0.0.1:4000")).toThrow(
      "without credentials or a path",
    );
  });

  it("marks authenticated BFF responses private and uncacheable", () => {
    expect(privateResponseHeaders).toEqual({
      "Cache-Control": "no-store, private",
      Pragma: "no-cache",
    });
  });

  it("requires a distributed revocation index in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("SESSION_SECRET", "synthetic-production-session-secret-over-thirty-two-characters");
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("SESSION_REVOCATION_STORE", "local");

    expect(() => readSessionRevocationConfiguration()).toThrow(
      "production session revocation must use Redis",
    );
  });

  it("parses bounded Redis revocation availability controls", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SESSION_SECRET", "synthetic-test-session-secret-over-thirty-two-characters");
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("SESSION_REVOCATION_STORE", "redis");
    vi.stubEnv("REDIS_URL", "redis://cache.example.test:6379");
    vi.stubEnv("SESSION_REVOCATION_REDIS_CONNECT_TIMEOUT_MS", "750");
    vi.stubEnv("SESSION_REVOCATION_REDIS_COMMAND_TIMEOUT_MS", "500");

    expect(readSessionRevocationConfiguration()).toMatchObject({
      store: "redis",
      environment: "test",
      redisUrl: "redis://cache.example.test:6379",
      connectTimeoutMilliseconds: 750,
      commandTimeoutMilliseconds: 500,
    });
  });
});
