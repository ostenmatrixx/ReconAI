import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import type { CanonicalRecord } from "@workspace/domain";
import { syntheticIds } from "@workspace/test-support";
import { z } from "zod";

import { ENGINE_VERSION, reconcile, RULE_SET_VERSION } from "./index.js";
import {
  buildRepresentativeLoadDataset,
  digestReconciliationResult,
  REPRESENTATIVE_LOAD_SCENARIO_VERSION,
} from "./load-profile.js";

const sampleOrders = [
  "canonical",
  "reverse",
  "rotate_one_third",
  "rotate_two_thirds",
  "canonical_repeat",
] as const;
type SampleOrder = (typeof sampleOrders)[number];

const fixedPolicy = {
  version: "representative-load-policy-1",
  evaluatedAt: "2026-07-30T00:00:00.000Z",
  amountToleranceMinor: {},
  dateWindowSeconds: 86_400,
  delayedEventGraceSeconds: 3_600,
  businessTimeZone: "UTC",
} as const;

const countRecordSchema = z.record(z.string().min(1).max(100), z.number().int().min(0));
const childSampleSchema = z
  .object({
    sampleOrder: z.enum(sampleOrders),
    engineVersion: z.literal(ENGINE_VERSION),
    ruleSetVersion: z.literal(RULE_SET_VERSION),
    inputSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    policySnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    runKey: z.string().regex(/^[a-f0-9]{64}$/u),
    resultSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    counts: z
      .object({
        input: z.number().int().positive(),
        matches: z.number().int().min(0),
        exceptions: z.number().int().min(0),
        ambiguousCandidates: z.number().int().min(0),
      })
      .strict(),
    matchRuleCounts: countRecordSchema,
    exceptionTypeCounts: countRecordSchema,
    durationMs: z.number().positive(),
    rssBeforeBytes: z.number().int().positive(),
    rssAfterBytes: z.number().int().positive(),
    maxRssBytes: z.number().int().positive(),
  })
  .strict();
type ChildSample = z.infer<typeof childSampleSchema>;

const childOrder = process.env["RECONAI_LOAD_SAMPLE_ORDER"];
if (childOrder !== undefined) {
  const sampleOrder = z.enum(sampleOrders).parse(childOrder);
  process.stdout.write(`${JSON.stringify(runChildSample(sampleOrder))}\n`);
} else {
  process.stdout.write(`${JSON.stringify(runParentVerification(), null, 2)}\n`);
}

function runChildSample(sampleOrder: SampleOrder): ChildSample {
  const dataset = buildRepresentativeLoadDataset();
  const records = permute(dataset.records, sampleOrder);
  globalThis.gc?.();
  const rssBeforeBytes = process.memoryUsage().rss;
  const started = performance.now();
  const result = reconcile({
    organizationId: syntheticIds.organization,
    records,
    policy: fixedPolicy,
  });
  const durationMs = performance.now() - started;
  const rssAfterBytes = process.memoryUsage().rss;
  const maxRssBytes = process.resourceUsage().maxRSS * 1024;

  return childSampleSchema.parse({
    sampleOrder,
    engineVersion: result.engineVersion,
    ruleSetVersion: result.ruleSetVersion,
    inputSnapshotHash: result.inputSnapshotHash,
    policySnapshotHash: result.policySnapshotHash,
    runKey: result.runKey,
    resultSha256: digestReconciliationResult(result),
    counts: result.counts,
    matchRuleCounts: countBy(result.matches.map((match) => match.ruleId)),
    exceptionTypeCounts: countBy(result.exceptions.map((exception) => exception.type)),
    durationMs: round(durationMs),
    rssBeforeBytes,
    rssAfterBytes,
    maxRssBytes,
  });
}

function runParentVerification(): unknown {
  const dataset = buildRepresentativeLoadDataset();
  const samples = sampleOrders.map(runIsolatedSample);
  const baseline = samples[0];
  if (baseline === undefined) throw new Error("load verification produced no samples");

  const expectedCounts = {
    input: dataset.expected.input,
    matches: dataset.expected.matches,
    exceptions: dataset.expected.exceptions,
    ambiguousCandidates: dataset.expected.ambiguousCandidates,
  };
  for (const sample of samples) {
    assertJsonEqual(sample.counts, expectedCounts, `${sample.sampleOrder} result counts`);
    assertJsonEqual(
      sample.matchRuleCounts,
      dataset.expected.matchRuleCounts,
      `${sample.sampleOrder} match rules`,
    );
    assertJsonEqual(
      sample.exceptionTypeCounts,
      dataset.expected.exceptionTypeCounts,
      `${sample.sampleOrder} exception types`,
    );
    for (const field of [
      "engineVersion",
      "ruleSetVersion",
      "inputSnapshotHash",
      "policySnapshotHash",
      "runKey",
      "resultSha256",
    ] as const) {
      if (sample[field] !== baseline[field]) {
        throw new Error(`${sample.sampleOrder} ${field} differs from the canonical sample`);
      }
    }
  }
  if (
    dataset.moneyConservation.matchedOrderMinor !== dataset.moneyConservation.matchedPaymentMinor
  ) {
    throw new Error("matched order and payment money is not conserved");
  }
  if (
    dataset.moneyConservation.shopifyRefundMinor !== dataset.moneyConservation.stripeRefundMinor ||
    dataset.moneyConservation.shopifyRefundMinor !== dataset.moneyConservation.accountingRefundMinor
  ) {
    throw new Error("refund money is not conserved across source systems");
  }

  const durations = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
  const cpu = cpus()[0];
  const sourceFiles = ["index.ts", "load-profile.ts", "load-verification.ts"];

  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    component: "deterministic-reconciliation-representative-load",
    outcome: "local_representative_load_passed",
    productionReadinessClaim: false,
    scope: {
      customerDataUsed: false,
      providerSystemsContacted: false,
      stagingEnvironmentUsed: false,
      measuredBoundary:
        "pure in-process deterministic reconciliation only; dataset construction and persistence are excluded from duration",
    },
    source: {
      gitCommit: null,
      engineVersion: ENGINE_VERSION,
      ruleSetVersion: RULE_SET_VERSION,
      scenarioVersion: REPRESENTATIVE_LOAD_SCENARIO_VERSION,
      files: Object.fromEntries(
        sourceFiles.map((name) => [
          `packages/reconciliation/src/${name}`,
          sha256(readFileSync(new URL(name, import.meta.url))),
        ]),
      ),
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      cpuModel: cpu?.model ?? "unavailable",
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      isolation: "five sequential fresh Node child processes with explicit pre-measurement GC",
    },
    dataset: {
      totalRecords: dataset.records.length,
      distribution: dataset.distribution,
      scenarios: dataset.scenarios,
      expected: dataset.expected,
      moneyConservation: dataset.moneyConservation,
      syntheticOnly: true,
      deterministicConstruction: true,
    },
    samples,
    summary: {
      sampleCount: samples.length,
      durationMs: {
        minimum: durations[0],
        p50: percentile(durations, 50),
        p95: percentile(durations, 95),
        maximum: durations.at(-1),
      },
      maximumObservedRssBytes: Math.max(...samples.map((sample) => sample.maxRssBytes)),
      exactRepeatIdentityStable: true,
      permutationInvariant: true,
      resultDigestStable: true,
      integerMoneyConserved: true,
    },
    limitations: [
      "Five fresh-process samples are too few to establish a statistically reliable service-level percentile.",
      "The measured duration excludes API, PostgreSQL snapshot loading, outbox, Redis, worker startup, persistence, browser rendering, and network latency.",
      "The synthetic distribution is deliberately mixed but is not evidence of real merchant, provider, accounting, or exception prevalence.",
      "This is one local single-host architecture/runtime, not protected staging, multi-host contention, failure injection, sustained arrival load, or production capacity.",
      "No customer data, provider sandbox, external collector, alert delivery, deployment, or production credential was used.",
    ],
    credentialsRecorded: false,
  };
}

function runIsolatedSample(sampleOrder: SampleOrder): ChildSample {
  const execution = spawnSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", fileURLToPath(import.meta.url)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        RECONAI_LOAD_SAMPLE_ORDER: sampleOrder,
      },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    },
  );
  if (execution.error !== undefined) throw execution.error;
  if (execution.status !== 0) {
    throw new Error(
      `isolated ${sampleOrder} sample failed (${execution.status?.toString() ?? "signal"}): ${execution.stderr.trim()}`,
    );
  }
  if (execution.stderr.trim().length > 0) {
    throw new Error(`isolated ${sampleOrder} sample wrote to stderr`);
  }
  return childSampleSchema.parse(JSON.parse(execution.stdout) as unknown);
}

function permute(
  records: readonly CanonicalRecord[],
  order: SampleOrder,
): readonly CanonicalRecord[] {
  if (order === "canonical" || order === "canonical_repeat") return records;
  if (order === "reverse") return [...records].reverse();
  const offset =
    order === "rotate_one_third"
      ? Math.floor(records.length / 3)
      : Math.floor((records.length * 2) / 3);
  return [...records.slice(offset), ...records.slice(0, offset)];
}

function countBy(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function percentile(sorted: readonly number[], percentage: number): number {
  const value = sorted[Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1)];
  if (value === undefined) throw new Error("cannot calculate a percentile without samples");
  return value;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function sha256(value: NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertJsonEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} did not match the declared dataset profile`);
  }
}
