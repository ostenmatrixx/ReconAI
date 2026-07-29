const developmentSessionSecret = "development-only-session-secret-change-me";
const environmentPattern = /^[a-z0-9][a-z0-9-]{1,31}$/u;

export type SessionRevocationConfiguration =
  | {
      readonly store: "local";
      readonly environment: string;
      readonly keySecret: string;
    }
  | {
      readonly store: "redis";
      readonly environment: string;
      readonly keySecret: string;
      readonly redisUrl: string;
      readonly connectTimeoutMilliseconds: number;
      readonly commandTimeoutMilliseconds: number;
    };

export const privateResponseHeaders = {
  "Cache-Control": "no-store, private",
  Pragma: "no-cache",
} as const;

export function readSessionSecret(options: { allowProductionBuild?: boolean } = {}): string {
  const value = process.env["SESSION_SECRET"];
  const isProductionBuild =
    options.allowProductionBuild === true && process.env["NEXT_PHASE"] === "phase-production-build";

  if (
    process.env.NODE_ENV === "production" &&
    !isProductionBuild &&
    (!value || value.length < 32 || value === developmentSessionSecret)
  ) {
    throw new Error("production session configuration is missing or local-only");
  }

  return value && value.length > 0 ? value : developmentSessionSecret;
}

export function readConfiguredOrigin(
  name: "API_ORIGIN" | "NEXTAUTH_URL" | "WEB_ORIGIN",
  developmentFallback: string,
): string {
  const value = process.env[name] ?? developmentFallback;
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an HTTP(S) origin without credentials or a path`);
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in production`);
  }
  return url.origin;
}

export function readSessionRevocationConfiguration(
  options: { allowProductionBuild?: boolean } = {},
): SessionRevocationConfiguration {
  const isProductionBuild =
    options.allowProductionBuild === true && process.env["NEXT_PHASE"] === "phase-production-build";
  const store = process.env["SESSION_REVOCATION_STORE"] ?? "local";
  if (store !== "local" && store !== "redis") {
    throw new Error("SESSION_REVOCATION_STORE must be local or redis");
  }
  if (process.env.NODE_ENV === "production" && !isProductionBuild && store !== "redis") {
    throw new Error("production session revocation must use Redis");
  }

  const environment = process.env["APP_ENV"] ?? "development";
  if (!environmentPattern.test(environment)) {
    throw new Error("APP_ENV is invalid for the session-revocation namespace");
  }
  const keySecret = readSessionSecret(options);
  if (store === "local") return { store, environment, keySecret };

  const redisUrl = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";
  const parsedRedisUrl = new URL(redisUrl);
  if (parsedRedisUrl.protocol !== "redis:" || parsedRedisUrl.hash) {
    throw new Error("REDIS_URL must be a Redis URL without a fragment");
  }
  return {
    store,
    environment,
    keySecret,
    redisUrl,
    connectTimeoutMilliseconds: boundedIntegerEnvironment(
      "SESSION_REVOCATION_REDIS_CONNECT_TIMEOUT_MS",
      1000,
      100,
      5000,
    ),
    commandTimeoutMilliseconds: boundedIntegerEnvironment(
      "SESSION_REVOCATION_REDIS_COMMAND_TIMEOUT_MS",
      1000,
      50,
      5000,
    ),
  };
}

function boundedIntegerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) {
    throw new Error(`${name} must be a bounded integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${String(minimum)} and ${String(maximum)}`);
  }
  return value;
}
