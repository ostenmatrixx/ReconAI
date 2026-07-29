import { performance } from "node:perf_hooks";

import { type CanonicalRecord, type OrderRecord, type PaymentRecord } from "@workspace/domain";
import {
  defaultPolicy,
  syntheticIds,
  syntheticOrder,
  syntheticPayment,
} from "@workspace/test-support";

import {
  ENGINE_VERSION,
  MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD,
  RULE_SET_VERSION,
  reconcile,
} from "./index.js";

interface CollisionFixture {
  readonly order: OrderRecord;
  readonly payments: readonly PaymentRecord[];
  readonly strongestPayment: PaymentRecord;
}

function collisionFixture(count: number, sequenceOffset: number): CollisionFixture {
  const order = syntheticOrder(
    {
      externalId: `collision-order-${count.toString()}`,
      orderReference: `#COLLISION-${count.toString()}`,
      customerReference: "target-customer",
    },
    sequenceOffset,
  );
  const payments = Array.from({ length: count }, (_, index) =>
    syntheticPayment(
      {
        orderReference: `unrelated-order-${count.toString()}-${index.toString()}`,
        providerOrderReference: `unrelated-order-${count.toString()}-${index.toString()}`,
        customerReference: index === count - 1 ? "target-customer" : "unrelated-customer",
        effectiveAt: index === count - 1 ? order.effectiveAt : "2026-07-20T10:00:00.000Z",
      },
      sequenceOffset + 1 + index,
    ),
  );
  const strongestPayment = payments.at(-1);
  if (!strongestPayment) throw new Error("collision fixture requires at least one payment");
  return { order, payments, strongestPayment };
}

function runCollisionCase(count: number, sequenceOffset: number) {
  const fixture = collisionFixture(count, sequenceOffset);
  const records: readonly CanonicalRecord[] = [fixture.order, ...fixture.payments];
  const startedAt = performance.now();
  const result = reconcile({
    organizationId: syntheticIds.organization,
    policy: defaultPolicy,
    records,
  });
  const durationMs = performance.now() - startedAt;
  const replay = reconcile({
    organizationId: syntheticIds.organization,
    policy: defaultPolicy,
    records: [...records].reverse(),
  });
  const orderException = result.exceptions.find((item) =>
    item.recordIds.includes(fixture.order.id),
  );
  if (!orderException?.evidence.candidateSearch) {
    throw new Error("collision case did not produce candidate-search evidence");
  }
  const strongestCandidateSelected = result.ambiguousCandidates.some((item) =>
    item.recordIds.includes(fixture.strongestPayment.id),
  );
  const complete = count <= MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD;
  if (
    orderException.evidence.candidateSearch.complete !== complete ||
    (complete && !strongestCandidateSelected) ||
    (!complete &&
      (result.ambiguousCandidates.length !== 0 ||
        orderException.type !== "ambiguous_identity" ||
        orderException.evidence.reasonCode !== "ORDER_PAYMENT_CANDIDATE_SET_EXCEEDS_LIMIT")) ||
    JSON.stringify(replay) !== JSON.stringify(result)
  ) {
    throw new Error(`collision case ${count.toString()} failed its correctness contract`);
  }
  return {
    eligiblePayments: count,
    durationMs: Math.round(durationMs * 100) / 100,
    candidateSearch: orderException.evidence.candidateSearch,
    orderExceptionType: orderException.type,
    orderReasonCode: orderException.evidence.reasonCode,
    emittedCandidates: result.ambiguousCandidates.length,
    strongestCandidateSelected,
    permutationReplayEquivalent: true,
  };
}

const cases = [
  runCollisionCase(MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD, 100_000),
  runCollisionCase(MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD + 1, 200_000),
  runCollisionCase(10_000, 300_000),
];

process.stdout.write(
  `${JSON.stringify(
    {
      evaluation: "reconciliation-ambiguous-payment-collision-v1",
      engineVersion: ENGINE_VERSION,
      ruleSetVersion: RULE_SET_VERSION,
      evaluationLimit: MAX_AMBIGUOUS_CANDIDATES_EVALUATED_PER_RECORD,
      cases,
      measuredAt: new Date().toISOString(),
      runtime: process.version,
      platform: `${process.platform}-${process.arch}`,
      interpretation:
        "Complete candidate sets at or below the limit are fully ranked. Larger sets fail closed as explicit ambiguity without a partial shortlist. Synthetic local timing is regression evidence, not an SLO or production-capacity claim.",
    },
    null,
    2,
  )}\n`,
);
