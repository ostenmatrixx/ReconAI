import { expect, test } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";
import { encode } from "next-auth/jwt";

const runId = "00000000-0000-4000-8000-000000000021";
const exceptionId = "00000000-0000-4000-8000-000000000041";
const run = {
  id: runId,
  stableRunKey: "a".repeat(64),
  status: "failed",
  policyVersion: "finance-close-v1",
  ruleSetVersion: "1.5.0",
  engineVersion: "0.7.0",
  inputCount: 102,
  matchCount: 12,
  exceptionCount: 1,
  errorCount: 1,
  dispatchCount: 1,
  operationalStateApplied: false,
  lastErrorCode: "SYNTHETIC_TRANSIENT_FAILURE",
  startedAt: "2026-07-27T12:00:01.000Z",
  completedAt: "2026-07-27T12:00:02.000Z",
  createdAt: "2026-07-27T12:00:00.000Z",
} as const;
const historicalRun = {
  ...run,
  id: "00000000-0000-4000-8000-000000000022",
  stableRunKey: "e".repeat(64),
  status: "succeeded",
  errorCount: 0,
  lastErrorCode: undefined,
  operationalStateApplied: false,
  createdAt: "2026-07-27T12:01:00.000Z",
} as const;
const authoritativeRun = {
  ...historicalRun,
  id: "00000000-0000-4000-8000-000000000023",
  stableRunKey: "f".repeat(64),
  operationalStateApplied: true,
  createdAt: "2026-07-27T12:02:00.000Z",
} as const;
function deterministicEvidence(reasonCode: string, result: "pass" | "fail" = "pass") {
  return {
    schemaVersion: "deterministic-evidence-view-v1",
    status: "available",
    ruleId: "refund-accounting-split",
    ruleVersion: "1.5.0",
    ruleSetVersion: "1.5.0",
    sourceRecordCount: 3,
    evidenceTruncated: false,
    comparisons: [
      {
        source: { amount: "125.00", currency: "USD" },
        normalized: { amountMinor: "12500", currency: "USD" },
      },
    ],
    toleranceMinor: "0",
    result,
    reasonCode,
    evaluatedAt: "2026-07-27T12:00:02.000Z",
    credentialReference: "credential-reference-sentinel",
  } as const;
}
const pagedMatches = Array.from({ length: 12 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${(40 + index).toString().padStart(12, "0")}`,
  ruleId: index === 0 ? "refund-accounting-split" : "order-payment",
  ruleVersion: "1.5.0",
  recordReferences:
    index === 0
      ? [
          "00000000-0000-4000-8000-000000000031",
          "00000000-0000-4000-8000-000000000032",
          "00000000-0000-4000-8000-000000000035",
        ]
      : ["00000000-0000-4000-8000-000000000031", "00000000-0000-4000-8000-000000000032"],
  recordReferencesStatus: "available",
  evidence: deterministicEvidence(
    index === 0 ? "REFUND_ACCOUNTING_SPLIT_TOTAL_MATCHED" : "ORDER_PAYMENT_TOTAL_MATCHED",
  ),
  evidenceFidelity: "exact_at_observation",
  observedAt: `2026-07-27T12:00:${(2 + index).toString().padStart(2, "0")}.000Z`,
}));
const pagedInputs = Array.from({ length: 102 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${(1000 + index).toString().padStart(12, "0")}`,
  version: 1,
  contentSha256: (index + 1).toString(16).padStart(64, "0"),
  ordinal: index,
}));

test.beforeEach(async ({ context, page }) => {
  const sessionToken = await encode({
    secret: "development-only-session-secret-change-me",
    maxAge: 3_600,
    token: {
      sub: "00000000-0000-4000-8000-000000000004",
      name: "Synthetic Operator",
      email: "operator@example.test",
      apiOidcIssuer: "http://localhost:8080/realms/reconai-development",
      apiOidcSubject: "synthetic-operator",
      apiSessionStartedAt: Math.floor(Date.now() / 1_000),
      apiAccessToken: "synthetic-browser-access-token",
      apiAccessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3_600,
    },
  });
  await context.addCookies([
    {
      name: "reconai.session-token",
      value: sessionToken,
      url: "http://127.0.0.1:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.route("**/api/recon?view=runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [authoritativeRun, historicalRun, run],
        meta: { correlationId: crypto.randomUUID() },
      }),
    });
  });
  await page.route(`**/api/recon?view=run&id=${runId}`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          ...run,
          inputSnapshotHash: "b".repeat(64),
          policySnapshotHash: "c".repeat(64),
          policySnapshot: {
            version: "finance-close-v1",
            evaluatedAt: "2026-07-27T12:00:00.000Z",
            amountToleranceMinor: { USD: "0" },
            dateWindowSeconds: 86400,
            delayedEventGraceSeconds: 3600,
            businessTimeZone: "UTC",
          },
          initiatedBy: "00000000-0000-4000-8000-000000000004",
          inputRecords: pagedInputs.slice(0, 100),
          inputRecordsTruncated: true,
          matches: [
            {
              id: "00000000-0000-4000-8000-000000000040",
              ruleId: "refund-accounting-split",
              ruleVersion: "1.5.0",
              recordReferences: [
                "00000000-0000-4000-8000-000000000031",
                "00000000-0000-4000-8000-000000000032",
                "00000000-0000-4000-8000-000000000035",
              ],
              recordReferencesStatus: "available",
              evidence: deterministicEvidence("REFUND_ACCOUNTING_SPLIT_TOTAL_MATCHED"),
              evidenceFidelity: "exact_at_observation",
              observedAt: "2026-07-27T12:00:02.000Z",
            },
          ],
          matchesTruncated: true,
          exceptions: [
            {
              id: exceptionId,
              type: "duplicate_processing_fee",
              observedStatus: "open",
              currentStatus: "open",
              severity: "high",
              recordReferences: [
                "00000000-0000-4000-8000-000000000033",
                "00000000-0000-4000-8000-000000000034",
              ],
              recordReferencesStatus: "available",
              evidence: deterministicEvidence("DUPLICATE_SOURCE_EXTERNAL_IDENTIFIER", "fail"),
              evidenceFidelity: "exact_at_observation",
              observedAt: "2026-07-27T12:00:02.000Z",
            },
          ],
          exceptionsTruncated: false,
        },
        meta: { correlationId: crypto.randomUUID() },
      }),
    });
  });
  await page.route("**/api/recon?view=run_artifacts**", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    const items = cursor ? pagedMatches.slice(10) : pagedMatches.slice(0, 10);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: { type: "match", items },
        meta: {
          correlationId: crypto.randomUUID(),
          ...(cursor ? {} : { nextCursor: "next_match_cursor" }),
        },
      }),
    });
  });
  await page.route("**/api/recon?view=run_inputs**", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    const items = cursor ? pagedInputs.slice(100) : pagedInputs.slice(0, 100);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: items,
        meta: {
          correlationId: crypto.randomUUID(),
          ...(cursor ? {} : { nextCursor: "next_input_cursor" }),
        },
      }),
    });
  });
});

test("shows honest immutable run evidence and recovery controls", async ({ page }) => {
  await page.goto("/dashboard/runs");
  await expect(page.getByRole("heading", { name: "Reconciliation runs" })).toBeVisible();
  await expect(page.getByText("SYNTHETIC_TRANSIENT_FAILURE")).toBeVisible();
  await expect(page.getByText("Live queue", { exact: true })).toBeVisible();
  await expect(page.getByText("Historical only", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Inspect run ${runId}` }).click();
  await expect(page.getByRole("heading", { name: "Run detail" })).toBeVisible();
  await expect(page.getByText("Input snapshot SHA-256")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recovery replay" })).toBeVisible();
  await page.getByText("View evidence", { exact: true }).first().click();
  const matchArtifacts = page.getByLabel("Matches observed in this run");
  await expect(matchArtifacts.getByText("Source representation", { exact: true })).toBeVisible();
  await expect(matchArtifacts.getByText("125.00", { exact: true })).toBeVisible();
  await expect(matchArtifacts.getByText("12500", { exact: true })).toBeVisible();
  await expect(page.getByText("credential-reference-sentinel")).toHaveCount(0);
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByRole("heading", { name: "Pin a new run" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm and queue" })).toBeDisabled();
});

test("run history has no automatically detectable accessibility violations", async ({ page }) => {
  await page.goto("/dashboard/runs");
  await expect(page.getByRole("heading", { name: "Reconciliation runs" })).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, undefined, {
    detailedReport: true,
    detailedReportOptions: { html: true },
  });
});

test("shows exact per-run match and exception evidence accessibly", async ({ page }) => {
  await page.goto("/dashboard/runs");
  await page.getByRole("button", { name: `Inspect run ${runId}` }).click();

  await expect(
    page.getByRole("heading", { name: "Observed deterministic artifacts" }),
  ).toBeVisible();
  await expect(
    page.getByText("REFUND_ACCOUNTING_SPLIT_TOTAL_MATCHED", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Matches observed in this run" })
      .getByRole("cell", { name: "3", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("DUPLICATE_SOURCE_EXTERNAL_IDENTIFIER", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Exact at observation")).toHaveCount(2);
  await expect(page.getByRole("link", { name: "Duplicate processing fee" })).toHaveAttribute(
    "href",
    `/dashboard/exceptions/${exceptionId}`,
  );
  await injectAxe(page);
  await checkA11y(page, '[aria-label="Selected run evidence"]', {
    detailedReport: true,
    detailedReportOptions: { html: true },
  });
});

test("pages every immutable match artifact without duplicating the preview", async ({ page }) => {
  await page.goto("/dashboard/runs");
  await page.getByRole("button", { name: `Inspect run ${runId}` }).click();

  const matches = page.getByRole("region", { name: "Matches observed in this run" });
  await expect(matches.getByRole("button", { name: "Browse all matches" })).toBeVisible();
  await matches.getByRole("button", { name: "Browse all matches" }).click();
  await expect(matches.getByRole("button", { name: "Load more matches" })).toBeVisible();
  await expect(matches.getByRole("row")).toHaveCount(11);
  await matches.getByRole("button", { name: "Load more matches" }).click();

  await expect(
    matches.getByText("All 12 matches for this run are loaded.", { exact: true }),
  ).toBeVisible();
  await expect(matches.getByRole("row")).toHaveCount(13);
  await expect(
    matches.getByText("REFUND_ACCOUNTING_SPLIT_TOTAL_MATCHED", { exact: true }),
  ).toHaveCount(1);
  await expect(matches.getByRole("button", { name: /matches/u })).toHaveCount(0);
});

test("pages every pinned input version without duplicating the preview", async ({ page }) => {
  await page.goto("/dashboard/runs");
  await page.getByRole("button", { name: `Inspect run ${runId}` }).click();

  const inputs = page.getByRole("region", { name: "Pinned record versions" });
  await expect(inputs.getByRole("button", { name: "Browse all pinned inputs" })).toBeVisible();
  await inputs.getByRole("button", { name: "Browse all pinned inputs" }).click();
  await expect(inputs.getByRole("button", { name: "Load more pinned inputs" })).toBeVisible();
  await expect(inputs.getByRole("row")).toHaveCount(101);
  await inputs.getByRole("button", { name: "Load more pinned inputs" }).click();

  await expect(
    inputs.getByText("All 102 pinned inputs are loaded.", { exact: true }),
  ).toBeVisible();
  await expect(inputs.getByRole("row")).toHaveCount(103);
  await expect(inputs.getByText(pagedInputs[0]?.id ?? "", { exact: true })).toHaveCount(1);
  await expect(inputs.getByRole("button", { name: /pinned inputs/u })).toHaveCount(0);
});

test("contains the bounded artifact ledger at a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard/runs");
  await page.getByRole("button", { name: `Inspect run ${runId}` }).click();

  await expect(
    page.getByRole("heading", { name: "Observed deterministic artifacts" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        bodyOverflow: document.body.scrollWidth - document.documentElement.clientWidth,
        documentOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
      })),
    )
    .toEqual({
      bodyOverflow: 0,
      documentOverflow: 0,
    });
});
