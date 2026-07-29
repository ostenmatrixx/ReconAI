import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { validateOperationalAlertPolicy } from "../packages/observability/src/alert-policy.ts";

const validPolicy = () =>
  parse(readFileSync("infra/observability/operational-alert-policy.yaml", "utf8"));

describe("operational alert policy", () => {
  it("accepts the checked-in production-disabled low-cardinality policy", () => {
    const result = validateOperationalAlertPolicy(validPolicy());

    expect(result.productionEnabled).toBe(false);
    expect(result.defaults).toEqual({
      evaluationIntervalSeconds: 60,
      thresholdNoDataState: "normal",
      evaluationErrorState: "alerting",
    });
    expect(result.rollout).toEqual({
      ownerApprovalRequired: true,
      backendTranslationValidated: false,
      deliveryPathValidated: false,
      protectedEnvironmentExerciseValidated: false,
    });
    expect(result.rules).toHaveLength(13);
    expect(new Set(result.rules.map((rule) => rule.id)).size).toBe(13);
  });

  it("rejects production enablement without a replacement reviewed contract", () => {
    const policy = validPolicy();
    policy.productionEnabled = true;

    expect(() => validateOperationalAlertPolicy(policy)).toThrow(
      /productionEnabled must be false/u,
    );
  });

  it("rejects treating legitimately absent threshold gauges as an alert", () => {
    const policy = validPolicy();
    policy.defaults.thresholdNoDataState = "alerting";

    expect(() => validateOperationalAlertPolicy(policy)).toThrow(
      /thresholdNoDataState must be normal/u,
    );
  });

  it("rejects high-cardinality and unsupported metric dimensions", () => {
    const policy = validPolicy();
    policy.rules[0].filters = { "reconai.organization.id": ["organization-secret"] };

    expect(() => validateOperationalAlertPolicy(policy)).toThrow(/forbidden high-cardinality/u);
  });

  it("rejects dynamic values outside the complete attribute vocabulary", () => {
    const policy = validPolicy();
    policy.rules[0].filters = { "reconai.outcome": ["customer-controlled-outcome"] };

    expect(() => validateOperationalAlertPolicy(policy)).toThrow(/unsupported value/u);
  });

  it("rejects gauge-rate and counter-last reducer mismatches", () => {
    const gaugePolicy = validPolicy();
    gaugePolicy.rules[2].condition.reducer = "rate";
    expect(() => validateOperationalAlertPolicy(gaugePolicy)).toThrow(
      /cannot use rate for an observable gauge/u,
    );

    const counterPolicy = validPolicy();
    counterPolicy.rules[0].condition.reducer = "last";
    expect(() => validateOperationalAlertPolicy(counterPolicy)).toThrow(
      /must use rate for a counter/u,
    );
  });

  it("rejects unknown fields and duplicate rule identities", () => {
    const unknownFieldPolicy = validPolicy();
    unknownFieldPolicy.unreviewedBackendExpression = "sum(customer_id)";
    expect(() => validateOperationalAlertPolicy(unknownFieldPolicy)).toThrow(
      /must contain exactly/u,
    );

    const duplicatePolicy = validPolicy();
    duplicatePolicy.rules[1].id = duplicatePolicy.rules[0].id;
    expect(() => validateOperationalAlertPolicy(duplicatePolicy)).toThrow(/duplicate id/u);
  });
});
