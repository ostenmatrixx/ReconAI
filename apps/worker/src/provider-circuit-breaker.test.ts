import { OrganizationIdSchema } from "@workspace/domain";
import { describe, expect, it, vi } from "vitest";

import {
  RedisProviderRequestCircuit,
  providerCircuitAcquireScript,
  providerCircuitFailureScript,
  providerCircuitKey,
  providerCircuitSuccessScript,
} from "./provider-circuit-breaker.js";

const input = {
  organizationId: OrganizationIdSchema.parse("61000000-0000-4000-8000-000000000001"),
  connectionId: "62000000-0000-4000-8000-000000000001",
  provider: "stripe" as const,
};
const permitToken = "a".repeat(32);

describe("distributed provider request circuit", () => {
  it("uses a tenant/connection-scoped pseudonymous key", () => {
    const key = providerCircuitKey("production", input);
    expect(key).toMatch(/^reconai:production:provider-circuit:v1:stripe:[0-9a-f]{64}$/u);
    expect(key).not.toContain(input.organizationId);
    expect(key).not.toContain(input.connectionId);
    expect(providerCircuitKey("production", input)).toBe(key);
    expect(
      providerCircuitKey("production", {
        ...input,
        connectionId: "62000000-0000-4000-8000-000000000002",
      }),
    ).not.toBe(key);
  });

  it("admits closed and half-open requests and returns bounded open decisions", async () => {
    const eval_ = vi
      .fn()
      .mockResolvedValueOnce([1, 0, 1])
      .mockResolvedValueOnce([1, 0, 2])
      .mockResolvedValueOnce([0, 60_000, 3])
      .mockResolvedValueOnce([0, 15_000, 4]);
    const circuit = new RedisProviderRequestCircuit({
      client: { eval: eval_ },
      environment: "production",
      failureThreshold: 3,
      openMs: 60_000,
      probeLeaseMs: 15_000,
      now: () => 1_000_000,
      token: () => permitToken,
    });

    await expect(circuit.acquire(input)).resolves.toEqual({
      outcome: "permitted",
      permit: { state: "closed", token: permitToken },
    });
    await expect(circuit.acquire(input)).resolves.toEqual({
      outcome: "permitted",
      permit: { state: "half_open", token: permitToken },
    });
    await expect(circuit.acquire(input)).resolves.toEqual({
      outcome: "open",
      retryAfterMs: 60_000,
    });
    await expect(circuit.acquire(input)).resolves.toEqual({
      outcome: "open",
      retryAfterMs: 15_000,
    });
    expect(eval_).toHaveBeenCalledTimes(4);
    expect(eval_.mock.calls[0]?.[0]).toBe(providerCircuitAcquireScript);
    expect(eval_.mock.calls[0]?.[1]).toBe(1);
    expect(String(eval_.mock.calls[0]?.[2])).not.toContain(input.organizationId);
  });

  it("applies only current permits and bounds a provider retry-after interval", async () => {
    const eval_ = vi
      .fn()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    const circuit = new RedisProviderRequestCircuit({
      client: { eval: eval_ },
      environment: "production",
      failureThreshold: 3,
      openMs: 60_000,
      probeLeaseMs: 15_000,
      now: () => 1_000_000,
      token: () => permitToken,
    });

    await expect(
      circuit.recordTransientFailure({
        ...input,
        permit: { state: "closed", token: permitToken },
        forceOpen: true,
        retryAfterMs: 3_600_000,
      }),
    ).resolves.toBeUndefined();
    expect(eval_.mock.calls[0]?.[0]).toBe(providerCircuitFailureScript);
    expect(eval_.mock.calls[0]?.[6]).toBe(900_000);

    await expect(
      circuit.recordSuccess({
        ...input,
        permit: { state: "half_open", token: permitToken },
      }),
    ).resolves.toBeUndefined();
    await expect(
      circuit.recordSuccess({
        ...input,
        permit: { state: "half_open", token: permitToken },
      }),
    ).resolves.toBeUndefined();
    expect(eval_.mock.calls[1]?.[0]).toBe(providerCircuitSuccessScript);
  });

  it("fails closed on Redis or malformed-script results and rejects unsafe configuration", async () => {
    const unavailable = new RedisProviderRequestCircuit({
      client: {
        eval: vi.fn(async () => {
          throw new Error("synthetic Redis outage");
        }),
      },
      environment: "production",
      failureThreshold: 3,
      openMs: 60_000,
      probeLeaseMs: 15_000,
      token: () => permitToken,
    });
    await expect(unavailable.acquire(input)).rejects.toThrow("synthetic Redis outage");

    const malformed = new RedisProviderRequestCircuit({
      client: { eval: vi.fn(async () => [1, 0, 4]) },
      environment: "production",
      failureThreshold: 3,
      openMs: 60_000,
      probeLeaseMs: 15_000,
      token: () => permitToken,
    });
    await expect(malformed.acquire(input)).rejects.toThrow("invalid result");

    expect(
      () =>
        new RedisProviderRequestCircuit({
          client: { eval: vi.fn() },
          environment: "production",
          failureThreshold: 0,
          openMs: 60_000,
          probeLeaseMs: 15_000,
        }),
    ).toThrow();
    expect(
      () =>
        new RedisProviderRequestCircuit({
          client: { eval: vi.fn() },
          environment: "production",
          failureThreshold: 3,
          openMs: 10_000,
          probeLeaseMs: 15_000,
        }),
    ).toThrow("must not exceed");
  });
});
