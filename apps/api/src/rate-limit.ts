import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";

import type { RateLimitPluginOptions } from "@fastify/rate-limit";

export const API_RATE_LIMIT_MAXIMUM_REQUESTS = 120;
export const API_RATE_LIMIT_WINDOW_MS = 60_000;

export class ApiRateLimitExceededError extends Error {
  public readonly statusCode = 429;
  public readonly code = "RATE_LIMITED";

  public constructor() {
    super("request rate exceeded");
    this.name = "ApiRateLimitExceededError";
  }
}

export type ApiRateLimitConfiguration =
  | { readonly store: "local" }
  | {
      readonly store: "redis";
      readonly redis: object;
      readonly environment: string;
      readonly keySecret: string;
    };

const environmentPattern = /^[a-z0-9][a-z0-9-]{1,31}$/u;
const keySecretPattern = /^[A-Za-z0-9_-]{43,86}$/u;

export function apiRateLimitPluginOptions(
  configuration: ApiRateLimitConfiguration = { store: "local" },
): RateLimitPluginOptions {
  const distributed =
    configuration.store === "redis"
      ? distributedOptions(configuration)
      : {
          keyGenerator: (request: { readonly ip: string }) => request.ip,
        };
  return {
    max: API_RATE_LIMIT_MAXIMUM_REQUESTS,
    timeWindow: API_RATE_LIMIT_WINDOW_MS,
    continueExceeding: false,
    skipOnError: false,
    errorResponseBuilder: () => new ApiRateLimitExceededError(),
    ...distributed,
  };
}

function distributedOptions(
  configuration: Extract<ApiRateLimitConfiguration, { readonly store: "redis" }>,
): Pick<RateLimitPluginOptions, "redis" | "nameSpace" | "keyGenerator"> {
  if (!environmentPattern.test(configuration.environment)) {
    throw new Error("rate-limit environment namespace is invalid");
  }
  if (!keySecretPattern.test(configuration.keySecret)) {
    throw new Error("rate-limit key secret must encode 32–64 bytes as canonical base64url");
  }
  const key = Buffer.from(configuration.keySecret, "base64url");
  if (
    key.byteLength < 32 ||
    key.byteLength > 64 ||
    key.toString("base64url") !== configuration.keySecret
  ) {
    throw new Error("rate-limit key secret must encode 32–64 bytes as canonical base64url");
  }
  return {
    redis: configuration.redis,
    nameSpace: `reconai-${configuration.environment}-api-rate-limit-v1-`,
    keyGenerator: (request) =>
      createHmac("sha256", key)
        .update("client-ip\0", "utf8")
        .update(request.ip, "utf8")
        .digest("hex"),
  };
}
