export interface ReadinessCheck {
  readonly name: string;
  check(signal: AbortSignal): Promise<boolean>;
}

export interface ReadinessProbe {
  ready(): Promise<boolean>;
}

export interface ReadinessEvaluation {
  readonly ready: boolean;
  readonly failedChecks: readonly string[];
  readonly timedOut: boolean;
}

export interface CompositeReadinessOptions {
  readonly timeoutMs: number;
  readonly cacheMs?: number;
  readonly now?: () => number;
  readonly onEvaluation?: (evaluation: ReadinessEvaluation) => void;
}

/**
 * Runs required dependency checks concurrently behind one bounded, cached, single-flight probe.
 * Check names are operational metadata and are never returned by the public health route.
 */
export function createCompositeReadinessProbe(
  checks: readonly ReadinessCheck[],
  options: CompositeReadinessOptions,
): ReadinessProbe {
  if (checks.length === 0) throw new TypeError("readiness requires at least one dependency check");
  const names = checks.map((check) => check.name);
  if (names.some((name) => !/^[a-z][a-z0-9_]{0,63}$/u.test(name))) {
    throw new TypeError("readiness check names must use bounded snake_case");
  }
  if (new Set(names).size !== names.length) {
    throw new TypeError("readiness check names must be unique");
  }
  validateDuration(options.timeoutMs, "readiness timeout", 10, 5_000);
  const cacheMs = options.cacheMs ?? 1_000;
  validateDuration(cacheMs, "readiness cache", 0, 10_000);
  const now = options.now ?? performance.now.bind(performance);
  let cached: { readonly value: boolean; readonly expiresAt: number } | undefined;
  let inFlight: Promise<boolean> | undefined;

  return {
    ready: async () => {
      const currentTime = now();
      if (cached && currentTime < cached.expiresAt) return cached.value;
      if (inFlight) return inFlight;

      const evaluation = evaluateReadiness(checks, options.timeoutMs).then((result) => {
        cached = { value: result.ready, expiresAt: now() + cacheMs };
        try {
          options.onEvaluation?.(result);
        } catch {
          // Observability callbacks must never change admission state.
        }
        return result.ready;
      });
      inFlight = evaluation;
      try {
        return await evaluation;
      } finally {
        if (inFlight === evaluation) inFlight = undefined;
      }
    },
  };
}

async function evaluateReadiness(
  checks: readonly ReadinessCheck[],
  timeoutMs: number,
): Promise<ReadinessEvaluation> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ReadinessEvaluation>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        ready: false,
        failedChecks: ["probe_timeout"],
        timedOut: true,
      });
    }, timeoutMs);
  });
  const checksComplete = Promise.all(
    checks.map(async (check) => {
      try {
        return {
          name: check.name,
          healthy: !controller.signal.aborted && (await check.check(controller.signal)),
        };
      } catch {
        return { name: check.name, healthy: false };
      }
    }),
  ).then((results): ReadinessEvaluation => {
    const failedChecks = results.filter((result) => !result.healthy).map((result) => result.name);
    return {
      ready: failedChecks.length === 0,
      failedChecks,
      timedOut: false,
    };
  });

  try {
    return await Promise.race([checksComplete, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateDuration(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(
      `${name} must be an integer from ${String(minimum)} to ${String(maximum)} milliseconds`,
    );
  }
}
