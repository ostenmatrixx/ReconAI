import { readFileSync } from "node:fs";

import {
  OPERATIONAL_ALERT_METRICS,
  validateOperationalAlertPolicy,
} from "../packages/observability/src/index.ts";
import { parse } from "yaml";

const policyPath = "infra/observability/operational-alert-policy.yaml";
const policySource = readFileSync(policyPath, "utf8");
const policy = validateOperationalAlertPolicy(parse(policySource));
const telemetrySource = readFileSync("packages/observability/src/telemetry.ts", "utf8");
const runbookSource = readFileSync("docs/operations-runbook.md", "utf8");
const failures = [];

const requiredRules = new Set([
  "durable-queue-monitor-failed",
  "durable-queue-monitor-silent",
  "durable-queue-failed-jobs",
  "durable-queue-ready-head-old",
  "durable-queue-ready-head-critically-old",
  "exception-queue-monitor-invalid-or-failed",
  "exception-queue-monitor-silent",
  "exception-queue-oldest-warning",
  "exception-queue-oldest-critical",
  "provider-active-sync-monitor-invalid-or-failed",
  "provider-active-sync-monitor-silent",
  "provider-active-sync-oldest-warning",
  "provider-active-sync-oldest-critical",
]);
for (const rule of policy.rules) requiredRules.delete(rule.id);
if (requiredRules.size > 0) {
  failures.push(`missing required rules: ${[...requiredRules].sort().join(", ")}`);
}

for (const [key, metric] of Object.entries(OPERATIONAL_ALERT_METRICS)) {
  const reference = `OPERATIONAL_ALERT_METRICS.${key}.name`;
  if (!telemetrySource.includes(reference)) {
    failures.push(`${metric.name} is not bound to ${reference} at instrument creation`);
  }
}

const runbookAnchors = markdownHeadingSlugs(runbookSource);
for (const rule of policy.rules) {
  const [, anchor] = rule.runbook.split("#", 2);
  if (!anchor || !runbookAnchors.has(anchor)) {
    failures.push(`${rule.id} references missing runbook anchor ${rule.runbook}`);
  }
  if (rule.condition.type === "absence" && rule.windowSeconds < 1_200) {
    failures.push(`${rule.id} absence window is shorter than the maximum monitor/export allowance`);
  }
}

validateEscalation("durable-queue-ready-head-old", "durable-queue-ready-head-critically-old");
validateEscalation("exception-queue-oldest-warning", "exception-queue-oldest-critical");
validateEscalation("provider-active-sync-oldest-warning", "provider-active-sync-oldest-critical");

if (failures.length > 0) {
  process.stderr.write(`Operational alert policy validation failed:\n${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `Validated ${policy.rules.length} production-disabled operational alert rules against ` +
    `${Object.keys(OPERATIONAL_ALERT_METRICS).length} low-cardinality metric contracts.\n`,
);

function validateEscalation(warningId, criticalId) {
  const warning = policy.rules.find((rule) => rule.id === warningId);
  const critical = policy.rules.find((rule) => rule.id === criticalId);
  if (!warning || !critical) return;
  if (
    warning.severity !== "warning" ||
    critical.severity !== "critical" ||
    warning.metric !== critical.metric ||
    JSON.stringify(warning.filters) !== JSON.stringify(critical.filters) ||
    JSON.stringify(warning.groupBy) !== JSON.stringify(critical.groupBy) ||
    warning.condition.type !== "threshold" ||
    critical.condition.type !== "threshold" ||
    critical.condition.value <= warning.condition.value
  ) {
    failures.push(`${warningId}/${criticalId} is not a monotonic warning-to-critical escalation`);
  }
}

function markdownHeadingSlugs(source) {
  const slugs = new Set();
  for (const match of source.matchAll(/^#{1,6}\s+(.+)$/gmu)) {
    const heading = match[1]
      .trim()
      .toLowerCase()
      .replace(/[`_*[\](){}]/gu, "")
      .replace(/[^a-z0-9 -]/gu, "")
      .replace(/\s+/gu, "-")
      .replace(/-+/gu, "-");
    slugs.add(heading);
  }
  return slugs;
}
