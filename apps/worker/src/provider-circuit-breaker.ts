import { createHash, randomBytes } from "node:crypto";

import { OrganizationIdSchema } from "@workspace/domain";
import type {
  ProviderRequestCircuit,
  ProviderRequestCircuitAcquireResult,
  ProviderRequestCircuitInput,
  ProviderRequestCircuitPermit,
} from "@workspace/ingestion";
import {
  recordProviderCircuitDecision,
  recordProviderCircuitTransition,
} from "@workspace/observability";
import type { Redis } from "ioredis";
import { z } from "zod";

const maximumRetryAfterMs = 15 * 60 * 1_000;
const minimumStateTtlMs = 24 * 60 * 60 * 1_000;

const inputSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    connectionId: z.uuid(),
    provider: z.enum(["shopify", "stripe"]),
  })
  .strict();

const optionsSchema = z
  .object({
    environment: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/u),
    failureThreshold: z.number().int().min(1).max(20),
    openMs: z.number().int().min(1_000).max(maximumRetryAfterMs),
    probeLeaseMs: z.number().int().min(1_000).max(60_000),
  })
  .strict()
  .refine((value) => value.probeLeaseMs <= value.openMs, {
    message: "provider circuit probe lease must not exceed the open interval",
  });

const acquireResultSchema = z.tuple([
  z.coerce.number().int().min(0).max(1),
  z.coerce.number().int().min(0).max(maximumRetryAfterMs),
  z.coerce.number().int().min(1).max(4),
]);
const mutationResultSchema = z.coerce.number().int().min(0).max(3);

export const providerCircuitAcquireScript = `
local failures = tonumber(redis.call('HGET', KEYS[1], 'failures') or '0')
local opened_at = tonumber(redis.call('HGET', KEYS[1], 'opened_at_ms') or '0')
local open_for = tonumber(redis.call('HGET', KEYS[1], 'open_for_ms') or ARGV[2])
local now = tonumber(ARGV[1])
local threshold = tonumber(ARGV[3])
local probe_expires = tonumber(redis.call('HGET', KEYS[1], 'probe_expires_at_ms') or '0')

if failures >= threshold and opened_at > 0 then
  local available_at = opened_at + open_for
  if now < available_at then
    return {0, available_at - now, 3}
  end
  if probe_expires > now then
    return {0, probe_expires - now, 4}
  end
  redis.call(
    'HSET',
    KEYS[1],
    'latest_token', ARGV[6],
    'probe_expires_at_ms', now + tonumber(ARGV[4])
  )
  redis.call('PEXPIRE', KEYS[1], ARGV[5])
  return {1, 0, 2}
end

redis.call('HSET', KEYS[1], 'latest_token', ARGV[6])
redis.call('HDEL', KEYS[1], 'probe_expires_at_ms')
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return {1, 0, 1}
`;

export const providerCircuitSuccessScript = `
if redis.call('HGET', KEYS[1], 'latest_token') ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
return 1
`;

export const providerCircuitFailureScript = `
if redis.call('HGET', KEYS[1], 'latest_token') ~= ARGV[1] then
  return 0
end

local threshold = tonumber(ARGV[3])
local previous_failures = tonumber(redis.call('HGET', KEYS[1], 'failures') or '0')
local was_open = previous_failures >= threshold
local failures = previous_failures + 1
if tonumber(ARGV[5]) == 1 and failures < threshold then
  failures = threshold
end

redis.call(
  'HSET',
  KEYS[1],
  'failures', failures,
  'open_for_ms', ARGV[4]
)
redis.call('HDEL', KEYS[1], 'latest_token', 'probe_expires_at_ms')

local result = 1
if failures >= threshold then
  redis.call('HSET', KEYS[1], 'opened_at_ms', ARGV[2])
  result = was_open and 3 or 2
end
redis.call('PEXPIRE', KEYS[1], ARGV[6])
return result
`;

interface RedisCircuitClient {
  eval(
    script: string,
    numberOfKeys: number,
    key: string,
    ...arguments_: readonly (string | number)[]
  ): Promise<unknown>;
}

export interface RedisProviderRequestCircuitOptions {
  readonly client: Pick<Redis, "eval"> | RedisCircuitClient;
  readonly environment: string;
  readonly failureThreshold: number;
  readonly openMs: number;
  readonly probeLeaseMs: number;
  readonly now?: () => number;
  readonly token?: () => string;
}

/**
 * A distributed, connection-scoped circuit around read-only provider page requests.
 *
 * Redis keys contain only environment, fixed provider, and a SHA-256 digest of tenant/connection
 * authority. Lua scripts keep open/probe transitions atomic across worker replicas. Redis failure
 * fails request admission closed; it never bypasses the circuit and contacts a provider.
 */
export class RedisProviderRequestCircuit implements ProviderRequestCircuit {
  readonly #client: RedisCircuitClient;
  readonly #environment: string;
  readonly #failureThreshold: number;
  readonly #openMs: number;
  readonly #probeLeaseMs: number;
  readonly #stateTtlMs: number;
  readonly #now: () => number;
  readonly #token: () => string;

  public constructor(options: RedisProviderRequestCircuitOptions) {
    const parsed = optionsSchema.parse({
      environment: options.environment,
      failureThreshold: options.failureThreshold,
      openMs: options.openMs,
      probeLeaseMs: options.probeLeaseMs,
    });
    this.#client = options.client;
    this.#environment = parsed.environment;
    this.#failureThreshold = parsed.failureThreshold;
    this.#openMs = parsed.openMs;
    this.#probeLeaseMs = parsed.probeLeaseMs;
    this.#stateTtlMs = Math.max(minimumStateTtlMs, parsed.openMs * 10, parsed.probeLeaseMs * 10);
    this.#now = options.now ?? (() => Date.now());
    this.#token = options.token ?? (() => randomBytes(24).toString("base64url"));
  }

  public async acquire(
    input: ProviderRequestCircuitInput,
  ): Promise<ProviderRequestCircuitAcquireResult> {
    const parsed = inputSchema.parse(input);
    const token = z
      .string()
      .regex(/^[A-Za-z0-9_-]{32}$/u)
      .parse(this.#token());
    let rawResult: unknown;
    try {
      rawResult = await this.#client.eval(
        providerCircuitAcquireScript,
        1,
        providerCircuitKey(this.#environment, parsed),
        validatedNow(this.#now()),
        this.#openMs,
        this.#failureThreshold,
        this.#probeLeaseMs,
        this.#stateTtlMs,
        token,
      );
    } catch (error) {
      recordProviderCircuitDecision(parsed.provider, "failed");
      throw error;
    }
    const [permitted, retryAfterMs, state] = acquireResultSchema.parse(rawResult);
    if (permitted === 1 && (state === 1 || state === 2)) {
      const permit = {
        state: state === 1 ? "closed" : "half_open",
        token,
      } satisfies ProviderRequestCircuitPermit;
      recordProviderCircuitDecision(parsed.provider, permit.state);
      return { outcome: "permitted", permit };
    }
    if (permitted === 0 && (state === 3 || state === 4) && retryAfterMs > 0) {
      recordProviderCircuitDecision(parsed.provider, state === 3 ? "open" : "probe_busy");
      return { outcome: "open", retryAfterMs };
    }
    recordProviderCircuitDecision(parsed.provider, "invalid");
    throw new Error("provider circuit acquire returned an invalid result");
  }

  public async recordSuccess(
    input: ProviderRequestCircuitInput & {
      readonly permit: ProviderRequestCircuitPermit;
    },
  ): Promise<void> {
    const parsed = inputSchema.parse({
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      provider: input.provider,
    });
    const permit = permitSchema(input.permit);
    let rawResult: unknown;
    try {
      rawResult = await this.#client.eval(
        providerCircuitSuccessScript,
        1,
        providerCircuitKey(this.#environment, parsed),
        permit.token,
      );
    } catch (error) {
      recordProviderCircuitTransition(parsed.provider, "failed");
      throw error;
    }
    const applied = mutationResultSchema.parse(rawResult);
    if (applied === 0) {
      recordProviderCircuitTransition(parsed.provider, "stale");
      return;
    }
    if (applied !== 1) {
      recordProviderCircuitTransition(parsed.provider, "invalid");
      throw new Error("provider circuit success returned an invalid result");
    }
    if (permit.state === "half_open") {
      recordProviderCircuitTransition(parsed.provider, "closed");
    }
  }

  public async recordTransientFailure(
    input: ProviderRequestCircuitInput & {
      readonly permit: ProviderRequestCircuitPermit;
      readonly forceOpen: boolean;
      readonly retryAfterMs?: number;
    },
  ): Promise<void> {
    const parsed = inputSchema.parse({
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      provider: input.provider,
    });
    const permit = permitSchema(input.permit);
    const requestedOpenMs = boundedOpenMs(input.retryAfterMs, this.#openMs);
    let rawResult: unknown;
    try {
      rawResult = await this.#client.eval(
        providerCircuitFailureScript,
        1,
        providerCircuitKey(this.#environment, parsed),
        permit.token,
        validatedNow(this.#now()),
        this.#failureThreshold,
        requestedOpenMs,
        input.forceOpen ? 1 : 0,
        this.#stateTtlMs,
      );
    } catch (error) {
      recordProviderCircuitTransition(parsed.provider, "failed");
      throw error;
    }
    const result = mutationResultSchema.parse(rawResult);
    const outcome =
      result === 0
        ? "stale"
        : result === 1
          ? "failure_counted"
          : result === 2
            ? "opened"
            : "reopened";
    recordProviderCircuitTransition(parsed.provider, outcome);
  }
}

export function providerCircuitKey(
  environment: string,
  input: ProviderRequestCircuitInput,
): string {
  const parsedEnvironment = z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,31}$/u)
    .parse(environment);
  const parsed = inputSchema.parse(input);
  const digest = createHash("sha256")
    .update(["provider-request-circuit-v1", parsed.organizationId, parsed.connectionId].join("\0"))
    .digest("hex");
  return `reconai:${parsedEnvironment}:provider-circuit:v1:${parsed.provider}:${digest}`;
}

function permitSchema(value: ProviderRequestCircuitPermit): ProviderRequestCircuitPermit {
  return z
    .object({
      state: z.enum(["closed", "half_open"]),
      token: z.string().regex(/^[A-Za-z0-9_-]{32}$/u),
    })
    .strict()
    .parse(value);
}

function validatedNow(value: number): number {
  return z.number().int().min(0).max(8_640_000_000_000_000).parse(value);
}

function boundedOpenMs(retryAfterMs: number | undefined, defaultOpenMs: number): number {
  if (retryAfterMs === undefined || !Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1) {
    return defaultOpenMs;
  }
  return Math.min(maximumRetryAfterMs, Math.max(defaultOpenMs, retryAfterMs));
}
