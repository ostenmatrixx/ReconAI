import { performance } from "node:perf_hooks";

import { asCurrency, money, type CanonicalRecord } from "@workspace/domain";
import {
  defaultPolicy,
  syntheticFee,
  syntheticIds,
  syntheticOrder,
  syntheticPayment,
} from "@workspace/test-support";

import { MAX_RECONCILIATION_RECORDS, reconcile } from "./index.js";

const requested = Number.parseInt(process.env["RECONAI_BENCHMARK_RECORDS"] ?? "99999", 10);
if (!Number.isSafeInteger(requested) || requested < 3 || requested > MAX_RECONCILIATION_RECORDS) {
  throw new Error(
    `RECONAI_BENCHMARK_RECORDS must be between 3 and ${MAX_RECONCILIATION_RECORDS.toString()}`,
  );
}

const groupCount = Math.floor(requested / 3);
const records: CanonicalRecord[] = [];
for (let index = 0; index < groupCount; index += 1) {
  const orderSequence = 1_000_000 + index;
  const paymentSequence = 2_000_000 + index;
  const feeSequence = 3_000_000 + index;
  const orderExternalId = `benchmark-order-${index.toString()}`;
  const paymentExternalId = `benchmark-payment-${index.toString()}`;
  const amount = money(10_000n + BigInt(index), asCurrency("USD"));
  records.push(
    syntheticOrder(
      {
        externalId: orderExternalId,
        orderReference: `#BENCH-${index.toString()}`,
        customerReference: `benchmark-customer-${index.toString()}`,
        amount,
      },
      orderSequence,
    ),
    syntheticPayment(
      {
        externalId: paymentExternalId,
        orderReference: orderExternalId,
        providerOrderReference: orderExternalId,
        customerReference: `benchmark-customer-${index.toString()}`,
        amount,
      },
      paymentSequence,
    ),
    syntheticFee(
      {
        paymentReference: paymentExternalId,
      },
      feeSequence,
    ),
  );
}

const memoryBefore = process.memoryUsage().rss;
const startedAt = performance.now();
const result = reconcile({
  organizationId: syntheticIds.organization,
  records,
  policy: defaultPolicy,
});
const durationMs = performance.now() - startedAt;
const memoryAfter = process.memoryUsage().rss;

if (
  result.counts.input !== records.length ||
  result.counts.matches !== groupCount ||
  result.counts.exceptions !== 0
) {
  throw new Error("benchmark reconciliation result failed correctness checks");
}

process.stdout.write(
  `${JSON.stringify(
    {
      benchmark: "reconciliation-complete-order-payment-fee-v1",
      engineVersion: result.engineVersion,
      ruleSetVersion: result.ruleSetVersion,
      inputRecords: result.counts.input,
      matches: result.counts.matches,
      exceptions: result.counts.exceptions,
      durationMs: Math.round(durationMs * 100) / 100,
      rssDeltaBytes: memoryAfter - memoryBefore,
      measuredAt: new Date().toISOString(),
      runtime: process.version,
      platform: `${process.platform}-${process.arch}`,
      note: "Single local synthetic run; not an SLO or production capacity claim.",
    },
    null,
    2,
  )}\n`,
);
