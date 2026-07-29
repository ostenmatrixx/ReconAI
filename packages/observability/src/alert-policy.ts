import {
  OPERATIONAL_ALERT_METRICS_BY_NAME,
  type OperationalAlertMetricName,
  type OperationalMetricContract,
} from "./metric-contract.js";

export const OPERATIONAL_ALERT_POLICY_API_VERSION =
  "reconai.io/operational-alert-policy/v1" as const;

const forbiddenDimensionFragments = [
  "organization",
  "tenant",
  "customer",
  "user",
  "membership",
  "connection",
  "record",
  "event.id",
  "job.id",
  "request.id",
  "payment",
  "email",
  "token",
  "credential",
] as const;
const operationalAlertMetricsByDynamicName: Readonly<
  Record<string, OperationalMetricContract | undefined>
> = OPERATIONAL_ALERT_METRICS_BY_NAME;

export type AlertSeverity = "warning" | "critical";

export type AlertCondition =
  | {
      readonly type: "absence";
    }
  | {
      readonly type: "threshold";
      readonly reducer: "last" | "max" | "rate";
      readonly operator: "greater_than";
      readonly value: number;
    };

export interface OperationalAlertRule {
  readonly id: string;
  readonly summary: string;
  readonly severity: AlertSeverity;
  readonly metric: OperationalAlertMetricName;
  readonly filters: Readonly<Record<string, readonly string[]>>;
  readonly groupBy: readonly string[];
  readonly windowSeconds: number;
  readonly forSeconds: number;
  readonly condition: AlertCondition;
  readonly runbook: string;
}

export interface OperationalAlertPolicy {
  readonly apiVersion: typeof OPERATIONAL_ALERT_POLICY_API_VERSION;
  readonly status: "proposed";
  readonly productionEnabled: false;
  readonly scope: "leased-operational-monitor-v1";
  readonly defaults: {
    readonly evaluationIntervalSeconds: number;
    readonly thresholdNoDataState: "normal";
    readonly evaluationErrorState: "alerting";
  };
  readonly rollout: {
    readonly ownerApprovalRequired: true;
    readonly backendTranslationValidated: false;
    readonly deliveryPathValidated: false;
    readonly protectedEnvironmentExerciseValidated: false;
  };
  readonly rules: readonly OperationalAlertRule[];
}

/**
 * Validates the backend-neutral policy before a backend adapter may consume it.
 *
 * The V1 contract intentionally accepts only the checked-in low-cardinality metric vocabulary and
 * remains production-disabled until a separate owner-approved deployment decision changes both the
 * contract and its evidence.
 */
export function validateOperationalAlertPolicy(value: unknown): OperationalAlertPolicy {
  const root = objectAt(value, "policy");
  exactKeys(
    root,
    ["apiVersion", "status", "productionEnabled", "scope", "defaults", "rollout", "rules"],
    "policy",
  );
  literal(root.apiVersion, OPERATIONAL_ALERT_POLICY_API_VERSION, "policy.apiVersion");
  literal(root.status, "proposed", "policy.status");
  literal(root.productionEnabled, false, "policy.productionEnabled");
  literal(root.scope, "leased-operational-monitor-v1", "policy.scope");

  const defaults = objectAt(root.defaults, "policy.defaults");
  exactKeys(
    defaults,
    ["evaluationIntervalSeconds", "thresholdNoDataState", "evaluationErrorState"],
    "policy.defaults",
  );
  integerBetween(defaults.evaluationIntervalSeconds, 15, 300, "evaluationIntervalSeconds");
  literal(defaults.thresholdNoDataState, "normal", "policy.defaults.thresholdNoDataState");
  literal(defaults.evaluationErrorState, "alerting", "policy.defaults.evaluationErrorState");

  const rollout = objectAt(root.rollout, "policy.rollout");
  exactKeys(
    rollout,
    [
      "ownerApprovalRequired",
      "backendTranslationValidated",
      "deliveryPathValidated",
      "protectedEnvironmentExerciseValidated",
    ],
    "policy.rollout",
  );
  literal(rollout.ownerApprovalRequired, true, "policy.rollout.ownerApprovalRequired");
  literal(rollout.backendTranslationValidated, false, "policy.rollout.backendTranslationValidated");
  literal(rollout.deliveryPathValidated, false, "policy.rollout.deliveryPathValidated");
  literal(
    rollout.protectedEnvironmentExerciseValidated,
    false,
    "policy.rollout.protectedEnvironmentExerciseValidated",
  );

  if (!Array.isArray(root.rules) || root.rules.length < 1 || root.rules.length > 50) {
    throw new TypeError("policy.rules must contain between 1 and 50 rules");
  }
  const ids = new Set<string>();
  const rules = root.rules.map((rule, index) => {
    const parsed = validateRule(rule, index);
    if (ids.has(parsed.id)) throw new TypeError(`policy.rules has duplicate id ${parsed.id}`);
    ids.add(parsed.id);
    return parsed;
  });

  return {
    apiVersion: OPERATIONAL_ALERT_POLICY_API_VERSION,
    status: "proposed",
    productionEnabled: false,
    scope: "leased-operational-monitor-v1",
    defaults: {
      evaluationIntervalSeconds: defaults.evaluationIntervalSeconds as number,
      thresholdNoDataState: "normal",
      evaluationErrorState: "alerting",
    },
    rollout: {
      ownerApprovalRequired: true,
      backendTranslationValidated: false,
      deliveryPathValidated: false,
      protectedEnvironmentExerciseValidated: false,
    },
    rules,
  };
}

function validateRule(value: unknown, index: number): OperationalAlertRule {
  const path = `policy.rules[${String(index)}]`;
  const rule = objectAt(value, path);
  exactKeys(
    rule,
    [
      "id",
      "summary",
      "severity",
      "metric",
      "filters",
      "groupBy",
      "windowSeconds",
      "forSeconds",
      "condition",
      "runbook",
    ],
    path,
  );
  const id = stringMatching(rule.id, /^[a-z][a-z0-9-]{4,79}$/u, `${path}.id`);
  const summary = boundedString(rule.summary, 10, 180, `${path}.summary`);
  const severity = oneOf(rule.severity, ["warning", "critical"] as const, `${path}.severity`);
  const metricName = stringMatching(rule.metric, /^reconai\.[a-z0-9_.]+$/u, `${path}.metric`);
  const metricContract = operationalAlertMetricsByDynamicName[metricName];
  if (!metricContract) throw new TypeError(`${path}.metric is not an alertable metric`);
  const metric = metricName as OperationalAlertMetricName;
  const filters = validateFilters(rule.filters, metricContract, path);
  const groupBy = validateGroupBy(rule.groupBy, metricContract, path);
  const windowSeconds = integerBetween(rule.windowSeconds, 60, 86_400, `${path}.windowSeconds`);
  const forSeconds = integerBetween(rule.forSeconds, 0, 86_400, `${path}.forSeconds`);
  const condition = validateCondition(rule.condition, metricContract, path);
  const runbook = stringMatching(
    rule.runbook,
    /^docs\/operations-runbook\.md#[a-z0-9-]+$/u,
    `${path}.runbook`,
  );

  return {
    id,
    summary,
    severity,
    metric,
    filters,
    groupBy,
    windowSeconds,
    forSeconds,
    condition,
    runbook,
  };
}

function validateFilters(
  value: unknown,
  metric: OperationalMetricContract,
  path: string,
): Readonly<Record<string, readonly string[]>> {
  const filters = objectAt(value, `${path}.filters`);
  const result: Record<string, readonly string[]> = {};
  for (const [attribute, rawValues] of Object.entries(filters)) {
    validateDimension(attribute, `${path}.filters`);
    const allowedValues = metric.attributes[attribute];
    if (!allowedValues) {
      throw new TypeError(`${path}.filters uses unsupported attribute ${attribute}`);
    }
    if (!Array.isArray(rawValues) || rawValues.length < 1) {
      throw new TypeError(`${path}.filters.${attribute} must be a non-empty array`);
    }
    const values = rawValues.map((item, index) =>
      boundedString(item, 1, 64, `${path}.filters.${attribute}[${String(index)}]`),
    );
    if (new Set(values).size !== values.length) {
      throw new TypeError(`${path}.filters.${attribute} contains a duplicate value`);
    }
    for (const item of values) {
      if (!allowedValues.includes(item)) {
        throw new TypeError(`${path}.filters.${attribute} has unsupported value ${item}`);
      }
    }
    result[attribute] = values;
  }
  return result;
}

function validateGroupBy(
  value: unknown,
  metric: OperationalMetricContract,
  path: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length > 2) {
    throw new TypeError(`${path}.groupBy must be an array with at most two attributes`);
  }
  const groupBy = value.map((item, index) => {
    const attribute = boundedString(item, 1, 80, `${path}.groupBy[${String(index)}]`);
    validateDimension(attribute, `${path}.groupBy`);
    if (!metric.attributes[attribute]) {
      throw new TypeError(`${path}.groupBy uses unsupported attribute ${attribute}`);
    }
    return attribute;
  });
  if (new Set(groupBy).size !== groupBy.length) {
    throw new TypeError(`${path}.groupBy contains a duplicate attribute`);
  }
  return groupBy;
}

function validateCondition(
  value: unknown,
  metric: OperationalMetricContract,
  path: string,
): AlertCondition {
  const condition = objectAt(value, `${path}.condition`);
  if (condition.type === "absence") {
    exactKeys(condition, ["type"], `${path}.condition`);
    return { type: "absence" };
  }
  literal(condition.type, "threshold", `${path}.condition.type`);
  exactKeys(condition, ["type", "reducer", "operator", "value"], `${path}.condition`);
  const reducer = oneOf(
    condition.reducer,
    ["last", "max", "rate"] as const,
    `${path}.condition.reducer`,
  );
  if (metric.instrument === "counter" && reducer !== "rate") {
    throw new TypeError(`${path}.condition must use rate for a counter`);
  }
  if (metric.instrument === "observable_gauge" && reducer === "rate") {
    throw new TypeError(`${path}.condition cannot use rate for an observable gauge`);
  }
  literal(condition.operator, "greater_than", `${path}.condition.operator`);
  const threshold = finiteNonnegative(condition.value, `${path}.condition.value`);
  return { type: "threshold", reducer, operator: "greater_than", value: threshold };
}

function validateDimension(attribute: string, path: string): void {
  const normalized = attribute.toLowerCase();
  if (forbiddenDimensionFragments.some((fragment) => normalized.includes(fragment))) {
    throw new TypeError(`${path} contains forbidden high-cardinality dimension ${attribute}`);
  }
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${path} must contain exactly: ${wanted.join(", ")}`);
  }
}

function literal<const T extends string | boolean>(
  value: unknown,
  expected: T,
  path: string,
): asserts value is T {
  if (value !== expected) throw new TypeError(`${path} must be ${String(expected)}`);
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`${path} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function boundedString(value: unknown, minimum: number, maximum: number, path: string): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    throw new TypeError(
      `${path} must be a trimmed string between ${String(minimum)} and ${String(maximum)} chars`,
    );
  }
  return value;
}

function stringMatching(value: unknown, pattern: RegExp, path: string): string {
  const result = boundedString(value, 1, 200, path);
  if (!pattern.test(result)) throw new TypeError(`${path} has an invalid format`);
  return result;
}

function integerBetween(value: unknown, minimum: number, maximum: number, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(
      `${path} must be an integer between ${String(minimum)} and ${String(maximum)}`,
    );
  }
  return value;
}

function finiteNonnegative(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${path} must be a finite non-negative number`);
  }
  return value;
}
