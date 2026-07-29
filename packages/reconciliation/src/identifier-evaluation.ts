import {
  defaultPolicy,
  syntheticFee,
  syntheticIds,
  syntheticOrder,
  syntheticPayment,
} from "@workspace/test-support";

import { ENGINE_VERSION, RULE_SET_VERSION, reconcile } from "./index.js";

const unsafeCases = [
  ["surrounding_whitespace", " reference ", "SURROUNDING_WHITESPACE"],
  ["control_character", "reference\u0000value", "FORBIDDEN_CONTROL_CHARACTER"],
  ["line_separator", "reference\u2028value", "FORBIDDEN_LINE_SEPARATOR"],
  ["bidi_control", "reference\u202Evalue", "BIDI_CONTROL_CHARACTER"],
  ["invisible_format", "reference\u200Bvalue", "INVISIBLE_FORMAT_CHARACTER"],
  ["replacement_character", "reference\uFFFDvalue", "REPLACEMENT_CHARACTER"],
  ["unpaired_surrogate", "reference\uD800value", "UNPAIRED_SURROGATE"],
] as const;

const unsafeCaseResults = unsafeCases.map(([category, externalId, expectedIssueCode], index) => {
  const result = reconcile({
    organizationId: syntheticIds.organization,
    policy: defaultPolicy,
    records: [
      syntheticOrder(
        {
          externalId,
          financialStatus: "pending",
        },
        10_000 + index,
      ),
    ],
  });
  const exception = result.exceptions.find((item) => item.type === "malformed_identifier");
  const sourceValue = exception?.evidence.sourceValues[0]?.["value"];
  const issueCodes = exception?.evidence.normalizedValues[0]?.["issueCodes"];
  if (
    result.matches.length !== 0 ||
    result.exceptions.length !== 1 ||
    exception?.evidence.reasonCode !== "IDENTIFIER_CONTAINS_UNSAFE_FORMAT" ||
    typeof sourceValue !== "string" ||
    !sourceValue.includes("\\u") ||
    typeof issueCodes !== "string" ||
    !issueCodes.split(",").includes(expectedIssueCode)
  ) {
    throw new Error(`unsafe identifier case ${category} failed its correctness contract`);
  }
  return {
    category,
    expectedIssueCode,
    emittedType: exception.type,
    quarantineApplied: true,
    displayUnsafeCodePointsEscaped: true,
  };
});

const trimmedOrder = syntheticOrder({
  externalId: " shopify-order-100 ",
});
const trimmedRecords = [trimmedOrder, syntheticPayment(), syntheticFee()];
const trimmedResult = reconcile({
  organizationId: syntheticIds.organization,
  policy: defaultPolicy,
  records: trimmedRecords,
});
const trimmedReplay = reconcile({
  organizationId: syntheticIds.organization,
  policy: defaultPolicy,
  records: [...trimmedRecords].reverse(),
});
const trimmedExceptionTypes = trimmedResult.exceptions.map((item) => item.type).sort();
if (
  trimmedResult.matches.length !== 0 ||
  JSON.stringify(trimmedExceptionTypes) !==
    JSON.stringify(["malformed_identifier", "payment_missing_order"]) ||
  JSON.stringify(trimmedReplay) !== JSON.stringify(trimmedResult)
) {
  throw new Error("trimmed exact-link quarantine failed its correctness contract");
}

const visibleUnicodeResult = reconcile({
  organizationId: syntheticIds.organization,
  policy: defaultPolicy,
  records: [
    syntheticOrder({
      externalId: "Invoice 2026 α",
      orderReference: "注文 #42",
      customerReference: "👩‍💻 customer",
      financialStatus: "pending",
    }),
  ],
});
if (visibleUnicodeResult.matches.length !== 0 || visibleUnicodeResult.exceptions.length !== 0) {
  throw new Error("visible Unicode identifier case produced a false positive");
}

process.stdout.write(
  `${JSON.stringify(
    {
      evaluation: "reconciliation-malformed-identifier-v1",
      engineVersion: ENGINE_VERSION,
      ruleSetVersion: RULE_SET_VERSION,
      unsafeCases: unsafeCaseResults,
      trimmedExactLink: {
        matches: trimmedResult.matches.length,
        exceptionTypes: trimmedExceptionTypes,
        permutationReplayEquivalent: true,
      },
      visibleUnicode: {
        accepted: true,
        exceptions: visibleUnicodeResult.exceptions.length,
      },
      measuredAt: new Date().toISOString(),
      runtime: process.version,
      platform: `${process.platform}-${process.arch}`,
      interpretation:
        "Unsafe identifier formatting emits bounded display-safe evidence and quarantines the affected record from automatic reconciliation. Visible Unicode remains eligible. Synthetic local evidence is not a production data-quality or operator-outcome claim.",
    },
    null,
    2,
  )}\n`,
);
