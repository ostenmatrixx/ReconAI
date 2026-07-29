import { describe, expect, it, vi } from "vitest";

import { createCompositeReadinessProbe } from "./readiness.js";

describe("composite API readiness", () => {
  it("requires every dependency and contains thrown failures", async () => {
    const evaluations: unknown[] = [];
    const probe = createCompositeReadinessProbe(
      [
        { name: "postgresql", check: async () => true },
        { name: "redis", check: async () => false },
        {
          name: "object_storage",
          check: async () => {
            throw new Error("synthetic sensitive dependency detail");
          },
        },
      ],
      {
        timeoutMs: 100,
        cacheMs: 0,
        onEvaluation: (evaluation) => evaluations.push(evaluation),
      },
    );

    await expect(probe.ready()).resolves.toBe(false);
    expect(evaluations).toEqual([
      {
        ready: false,
        failedChecks: ["redis", "object_storage"],
        timedOut: false,
      },
    ]);
  });

  it("bounds a stalled check and aborts its work", async () => {
    let observedAbort = false;
    const probe = createCompositeReadinessProbe(
      [
        {
          name: "postgresql",
          check: async (signal) =>
            new Promise<boolean>((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  observedAbort = true;
                  resolve(false);
                },
                { once: true },
              );
            }),
        },
      ],
      { timeoutMs: 20, cacheMs: 0 },
    );

    await expect(probe.ready()).resolves.toBe(false);
    expect(observedAbort).toBe(true);
  });

  it("recovers after the bounded cache expires", async () => {
    let now = 1;
    let healthy = false;
    const check = vi.fn(async () => healthy);
    const probe = createCompositeReadinessProbe([{ name: "postgresql", check }], {
      timeoutMs: 100,
      cacheMs: 100,
      now: () => now,
    });

    await expect(probe.ready()).resolves.toBe(false);
    healthy = true;
    await expect(probe.ready()).resolves.toBe(false);
    expect(check).toHaveBeenCalledTimes(1);

    now = 102;
    await expect(probe.ready()).resolves.toBe(true);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("shares one dependency evaluation across concurrent callers", async () => {
    let resolveCheck: ((value: boolean) => void) | undefined;
    const check = vi.fn(
      async () =>
        new Promise<boolean>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const probe = createCompositeReadinessProbe([{ name: "postgresql", check }], {
      timeoutMs: 100,
      cacheMs: 0,
    });

    const first = probe.ready();
    const second = probe.ready();
    await Promise.resolve();
    expect(check).toHaveBeenCalledTimes(1);
    resolveCheck?.(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it("rejects empty, duplicate, or unbounded probe definitions", () => {
    expect(() => createCompositeReadinessProbe([], { timeoutMs: 100 })).toThrow();
    expect(() =>
      createCompositeReadinessProbe(
        [
          { name: "redis", check: async () => true },
          { name: "redis", check: async () => true },
        ],
        { timeoutMs: 100 },
      ),
    ).toThrow("unique");
    expect(() =>
      createCompositeReadinessProbe([{ name: "redis", check: async () => true }], {
        timeoutMs: 5_001,
      }),
    ).toThrow("readiness timeout");
  });
});
