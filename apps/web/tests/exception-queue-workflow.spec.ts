import { readFile, stat } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";
import { encode } from "next-auth/jwt";

const exceptionId = "00000000-0000-4000-8000-000000000040";
const membershipId = "00000000-0000-4000-8000-000000000003";
const proposalId = "00000000-0000-4000-8000-000000000041";
const revisedProposalId = "00000000-0000-4000-8000-000000000047";

test.beforeEach(async ({ context }) => {
  const sessionToken = await encode({
    secret: "development-only-session-secret-change-me",
    maxAge: 3_600,
    token: {
      sub: "00000000-0000-4000-8000-000000000004",
      name: "Synthetic Reviewer",
      email: "reviewer@example.test",
      apiOidcIssuer: "http://localhost:8080/realms/reconai-development",
      apiOidcSubject: "synthetic-reviewer",
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
});

test("applies server filters and follows the opaque queue cursor", async ({ page }) => {
  const requestedQueries: URLSearchParams[] = [];
  await page.route("**/api/recon?*", async (route) => {
    const requestUrl = new URL(route.request().url());
    requestedQueries.push(requestUrl.searchParams);
    const secondPage = requestUrl.searchParams.get("cursor") === "page_2_cursor";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: secondPage
          ? [exceptionItem(51)]
          : Array.from({ length: 50 }, (_, index) => exceptionItem(index + 1)),
        meta: {
          filteredCount: 51,
          summary: { open: 51, high: 51, awaitingApproval: 2, decided: 8 },
          ...(secondPage ? {} : { nextCursor: "page_2_cursor" }),
        },
      }),
    });
  });

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Exception queue" })).toBeVisible();
  await page.getByLabel("Exact exception ID or type").fill("payment_without_order");
  await page.getByLabel("Status").selectOption("open");
  await page.getByLabel("Severity").selectOption("high");
  await page.getByLabel("Source").selectOption("stripe");
  await page.getByLabel("Confidence").selectOption("high");
  await page.getByLabel("Assignee").selectOption("unassigned");
  await page.getByLabel("Age · server UTC").selectOption("one_to_seven_days");
  await page.getByLabel("Amount currency").fill("USD");
  await page.getByLabel("Minimum minor units").fill("10000");
  await page.getByLabel("Maximum minor units").fill("20000");
  await page.getByRole("button", { name: "Apply filters" }).click();

  await expect(page.getByText("Showing 1–50 of 51")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(50);
  expect(
    requestedQueries.some(
      (query) =>
        query.get("view") === "summary" &&
        query.get("search") === "payment_without_order" &&
        query.get("status") === "open" &&
        query.get("severity") === "high" &&
        query.get("source") === "stripe" &&
        query.get("confidence") === "high" &&
        query.get("assignee") === "unassigned" &&
        query.get("age") === "one_to_seven_days" &&
        query.get("amountCurrency") === "USD" &&
        query.get("minimumAmountMinor") === "10000" &&
        query.get("maximumAmountMinor") === "20000",
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByText("Showing 51–51 of 51")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  expect(requestedQueries.at(-1)?.get("cursor")).toBe("page_2_cursor");

  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(page.getByText("Showing 1–50 of 51")).toBeVisible();
});

test("downloads the exact filtered queue only after a non-empty CSV is prepared", async ({
  page,
}) => {
  const exportRequests: unknown[] = [];
  const exportedCsv =
    '\uFEFF"exception_id","type","status","severity","sources","confidence","assignee","amount_minor","currency","created_at","updated_at"\r\n' +
    `"${exceptionId}","payment_without_order","open","high","stripe","high","unassigned","12500","USD","2026-07-27T12:00:00.000Z","2026-07-27T12:01:00.000Z"\r\n`;
  await page.route("**/api/recon?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [exceptionItem(40)],
        meta: {
          filteredCount: 1,
          canExport: true,
          summary: { open: 1, high: 1, awaitingApproval: 0, decided: 0 },
        },
      }),
    });
  });
  await page.route("**/api/recon/exports/exceptions", async (route) => {
    exportRequests.push(route.request().postDataJSON());
    await route.fulfill({
      body: exportedCsv,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="reconai-exception-queue.csv"',
        "content-length": Buffer.byteLength(exportedCsv, "utf8").toString(),
      },
      status: 200,
    });
  });

  await page.goto("/dashboard");
  await page.getByLabel("Exact exception ID or type").fill("payment_without_order");
  await page.getByLabel("Status").selectOption("open");
  await page.getByLabel("Severity").selectOption("high");
  await page.getByLabel("Source").selectOption("stripe");
  await page.getByLabel("Confidence").selectOption("high");
  await page.getByLabel("Assignee").selectOption("unassigned");
  await page.getByLabel("Age · server UTC").selectOption("one_to_seven_days");
  await page.getByLabel("Amount currency").fill("USD");
  await page.getByLabel("Minimum minor units").fill("10000");
  await page.getByLabel("Maximum minor units").fill("20000");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("Showing 1–1 of 1")).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export filtered CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("reconai-exception-queue.csv");
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  if (!downloadedPath) throw new Error("browser did not expose the downloaded CSV path");
  expect((await stat(downloadedPath)).size).toBe(Buffer.byteLength(exportedCsv, "utf8"));
  expect((await readFile(downloadedPath, "utf8")).startsWith("\uFEFF")).toBe(true);
  await expect(page.getByText(/Downloaded 1 rows · [1-9][0-9]* bytes/u)).toBeVisible();
  expect(exportRequests).toEqual([
    {
      status: "open",
      severity: "high",
      search: "payment_without_order",
      source: "stripe",
      amountCurrency: "USD",
      minimumAmountMinor: "10000",
      maximumAmountMinor: "20000",
      confidence: "high",
      assignee: "unassigned",
      age: "one_to_seven_days",
    },
  ]);
});

test("shows an export error without creating a zero-byte download", async ({ page }) => {
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  await page.route("**/api/recon?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [exceptionItem(40)],
        meta: {
          filteredCount: 1,
          canExport: true,
          summary: { open: 1, high: 1, awaitingApproval: 0, decided: 0 },
        },
      }),
    });
  });
  await page.route("**/api/recon/exports/exceptions", async (route) => {
    await route.fulfill({
      body: "",
      headers: { "content-type": "text/csv; charset=utf-8" },
      status: 200,
    });
  });

  await page.goto("/dashboard");
  await expect(page.getByText("Showing 1–1 of 1")).toBeVisible();
  await page.getByRole("button", { name: "Export filtered CSV" }).click();

  await expect(page.getByText("The export response was empty.")).toBeVisible();
  expect(downloadCount).toBe(0);
});

test("exception queue export controls have no automatically detectable accessibility violations", async ({
  page,
}) => {
  await page.route("**/api/recon?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [exceptionItem(40)],
        meta: {
          filteredCount: 1,
          canExport: false,
          summary: { open: 1, high: 1, awaitingApproval: 0, decided: 0 },
        },
      }),
    });
  });

  await page.goto("/dashboard");
  await expect(page.getByText("Export requires the data-export permission.")).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, undefined, {
    detailedReport: true,
    detailedReportOptions: { html: true },
  });
});

test("records a permanent note, workflow assignment, and dual-control approval", async ({
  page,
}) => {
  const submittedActions: unknown[] = [];
  const detail = exceptionDetail();
  await page.route("**/api/recon?view=exception&id=*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: detail }),
    });
  });
  await page.route("**/api/recon/actions", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    submittedActions.push(body);
    if (body["action"] === "add_note") {
      detail.notes = [
        {
          id: "00000000-0000-4000-8000-000000000042",
          authorMembershipId: membershipId,
          authorEmail: "reviewer@example.test",
          body: body["body"],
          createdAt: "2026-07-27T12:05:00.000Z",
        },
      ];
    } else if (body["action"] === "update_exception") {
      detail.status = "assigned";
      detail.assigneeMembershipId = membershipId;
    } else if (body["action"] === "decide_proposal") {
      detail.status = "approved";
      detail.latestProposal.status = "approved";
      detail.latestProposal.approvalCount = 2;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: { recorded: true } }),
      status: body["action"] === "add_note" ? 201 : 200,
    });
  });
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto(`/dashboard/exceptions/${exceptionId}`);
  await expect(page.getByRole("heading", { name: "Payment without order" })).toBeVisible();

  await page
    .getByLabel("Add note Permanent · 4,000 characters maximum")
    .fill("Verified the immutable payment source record and settlement timestamp.");
  await page.getByRole("button", { name: "Add permanent note" }).click();
  await expect(
    page.getByText("Verified the immutable payment source record and settlement timestamp."),
  ).toBeVisible();

  await page
    .getByLabel("Workflow reason")
    .fill("Taking ownership for the period-close investigation.");
  await page.getByRole("button", { name: "Assign to me" }).click();
  await expect(page.getByText(membershipId)).toBeVisible();

  await page
    .getByLabel("Reason Required · audit visible")
    .fill("Independent review confirms the proposed evidence-backed outcome.");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("2/2 approvals")).toBeVisible();
  await expect(page.getByText("Approved", { exact: true })).toHaveCount(2);

  expect(submittedActions).toEqual([
    {
      action: "add_note",
      exceptionId,
      body: "Verified the immutable payment source record and settlement timestamp.",
    },
    {
      action: "update_exception",
      exceptionId,
      workflowAction: "assign_self",
      reason: "Taking ownership for the period-close investigation.",
    },
    {
      action: "decide_proposal",
      proposalId,
      decision: "approve",
      reason: "Independent review confirms the proposed evidence-backed outcome.",
    },
  ]);
});

test("revises only the proposer's pending version and resets approval authority", async ({
  page,
}) => {
  const submittedActions: unknown[] = [];
  const detail = exceptionDetail();
  detail.latestProposal.canRevise = true;
  await page.route("**/api/recon?view=exception&id=*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: detail }),
    });
  });
  await page.route("**/api/recon/actions", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    submittedActions.push(body);
    detail.latestProposal = {
      id: revisedProposalId,
      version: 2,
      type: String(body["type"]),
      reason: String(body["reason"]),
      status: "pending",
      proposedBy: "00000000-0000-4000-8000-000000000045",
      canRevise: true,
      approvalCount: 0,
      requiredApprovals: 2,
      createdAt: "2026-07-27T12:06:00.000Z",
    };
    detail.timeline.push({
      id: "00000000-0000-4000-8000-000000000048",
      action: "resolution.revised",
      resourceType: "resolution_proposal",
      resourceId: revisedProposalId,
      actorType: "user",
      actorId: "00000000-0000-4000-8000-000000000045",
      reason: String(body["reason"]),
      occurredAt: "2026-07-27T12:06:00.000Z",
    });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: { accepted: true } }),
      status: 201,
    });
  });
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto(`/dashboard/exceptions/${exceptionId}`);
  await expect(page.getByRole("button", { name: "Revise proposal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await page.getByLabel("Resolution type ReconAI-only proposal").selectOption("write_off");
  await page
    .getByLabel("Reason Required · audit visible")
    .fill("Replace the pending version after stronger immutable evidence was reviewed.");
  await page.getByRole("button", { name: "Revise proposal" }).click();

  await expect(page.getByText("Proposal v2")).toBeVisible();
  await expect(page.locator(".proposal strong")).toHaveText("Write off");
  await expect(
    page.getByText("Replace the pending version after stronger immutable evidence was reviewed.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("0/2 approvals")).toBeVisible();
  expect(submittedActions).toEqual([
    {
      action: "create_proposal",
      exceptionId,
      type: "write_off",
      reason: "Replace the pending version after stronger immutable evidence was reviewed.",
    },
  ]);
});

test("shows an immutable automatic supersession in the investigation timeline", async ({
  page,
}) => {
  const detail = exceptionDetail();
  detail.status = "superseded";
  detail.latestProposal.status = "superseded";
  detail.timeline.push({
    id: "status:00000000-0000-4000-8000-000000000046",
    action: "exception.status.superseded",
    resourceType: "exception",
    resourceId: exceptionId,
    actorType: "worker",
    actorId: "reconciliation-worker",
    reason: "not observed in authoritative run",
    occurredAt: "2026-07-27T12:10:00.000Z",
  });
  await page.route("**/api/recon?view=exception&id=*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: detail }),
    });
  });

  await page.goto(`/dashboard/exceptions/${exceptionId}`);
  await expect(page.getByText("Superseded", { exact: true })).toHaveCount(2);
  await expect(
    page.getByText("Workflow controls are locked after proposal or terminal resolution."),
  ).toBeVisible();
  await expect(page.getByText(/not observed in authoritative run/u)).toBeVisible();
});

test("shows fail-closed candidate overflow evidence without implying a shortlist", async ({
  page,
}) => {
  const detail = exceptionDetail();
  detail.type = "ambiguous_identity";
  Object.assign(detail, {
    evidence: {
      schemaVersion: "deterministic-evidence-view-v1",
      status: "available",
      ruleId: "order-payment-candidate-overflow",
      ruleVersion: "1.5.0",
      ruleSetVersion: "1.5.0",
      sourceRecordCount: 1,
      evidenceTruncated: false,
      comparisons: [],
      result: "ambiguous",
      reasonCode: "ORDER_PAYMENT_CANDIDATE_SET_EXCEEDS_LIMIT",
      evaluatedAt: "2026-07-27T12:00:00.000Z",
      candidateSearch: {
        eligibleCount: 501,
        evaluatedCount: 0,
        emittedCount: 0,
        evaluationLimit: 500,
        complete: false,
      },
    },
  });
  await page.route("**/api/recon?view=exception&id=*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: detail }),
    });
  });

  await page.goto(`/dashboard/exceptions/${exceptionId}`);
  await expect(page.getByRole("heading", { name: "Ambiguous identity" })).toBeVisible();
  await expect(page.getByText("Candidate ranking withheld")).toBeVisible();
  await expect(
    page.getByText(/501 eligible payments exceed the 500 record evaluation limit/u),
  ).toBeVisible();
  await expect(page.getByText("ORDER_PAYMENT_CANDIDATE_SET_EXCEEDS_LIMIT")).toBeVisible();
  await expect(page.getByText(/501 eligible · 0 evaluated · 0 emitted · withheld/u)).toBeVisible();
});

test("shows typed comparisons and field lineage without exposing internal references", async ({
  page,
}) => {
  const detail = exceptionDetail();
  await page.route("**/api/recon?view=exception&id=*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: detail }),
    });
  });

  await page.goto(`/dashboard/exceptions/${exceptionId}`);
  await expect(
    page.getByRole("heading", { name: "Source and normalized comparisons" }),
  ).toBeVisible();
  const comparisonTable = page.locator(".evidence-comparison-table");
  await expect(comparisonTable.getByText("125.00", { exact: true })).toBeVisible();
  await expect(comparisonTable.getByText("12500", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Field lineage" })).toBeVisible();
  await expect(page.getByText("stripe_payment_v1 v1")).toBeVisible();
  await expect(page.getByText("credential-reference-sentinel")).toHaveCount(0);
});

test("shows a fixed unavailable state instead of malformed evidence fields", async ({ page }) => {
  const detail = exceptionDetail();
  Object.assign(detail, {
    evidence: {
      schemaVersion: "deterministic-evidence-view-v1",
      status: "unavailable",
      reasonCode: "EVIDENCE_UNSUPPORTED_OR_MALFORMED",
    },
  });
  await page.route("**/api/recon?view=exception&id=*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: detail }),
    });
  });

  await page.goto(`/dashboard/exceptions/${exceptionId}`);
  await expect(page.getByText("Deterministic evidence unavailable")).toBeVisible();
  await expect(page.getByText(/No unvalidated fields were shown/u)).toBeVisible();
});

test("exception investigation has no automatically detectable accessibility violations", async ({
  page,
}) => {
  const detail = exceptionDetail();
  await page.route("**/api/recon?view=exception&id=*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: detail }),
    });
  });

  await page.goto(`/dashboard/exceptions/${exceptionId}`);
  await expect(page.getByRole("heading", { name: "Payment without order" })).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, undefined, {
    detailedReport: true,
    detailedReportOptions: { html: true },
  });
});

function exceptionItem(sequence: number) {
  return {
    id: `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    type: "payment_without_order",
    status: "open",
    severity: "high",
    sources: ["stripe"],
    confidence: "high",
    assignee: "unassigned",
    amountMinor: "12500",
    currency: "USD",
    createdAt: "2026-07-27T12:00:00.000Z",
  };
}

function exceptionDetail() {
  return {
    id: exceptionId,
    type: "payment_without_order",
    status: "open",
    severity: "high",
    sources: ["stripe"],
    confidence: "high",
    assignee: "unassigned",
    amountMinor: "12500",
    currency: "USD",
    createdAt: "2026-07-27T12:00:00.000Z",
    updatedAt: "2026-07-27T12:00:00.000Z",
    assigneeMembershipId: undefined as string | undefined,
    recordReferences: ["00000000-0000-4000-8000-000000000043"],
    recordReferencesStatus: "available",
    evidence: {
      schemaVersion: "deterministic-evidence-view-v1",
      status: "available",
      ruleId: "payment-without-order",
      ruleVersion: "1.5.0",
      ruleSetVersion: "1.5.0",
      sourceRecordCount: 1,
      evidenceTruncated: false,
      comparisons: [
        {
          source: { amount: "125.00", currency: "USD" },
          normalized: { amountMinor: "12500", currency: "USD" },
        },
      ],
      toleranceMinor: "0",
      result: "fail",
      reasonCode: "PAYMENT_WITHOUT_ORDER",
      evaluatedAt: "2026-07-27T12:00:00.000Z",
    },
    sourceRecords: [
      {
        id: "00000000-0000-4000-8000-000000000043",
        version: 1,
        kind: "payment",
        source: "stripe",
        sourceTimestamp: "2026-07-27T11:59:00.000Z",
        normalizedData: {
          kind: "payment",
          externalId: "pay_123",
          effectiveAt: "2026-07-27T11:59:00.000Z",
          amountMinor: "12500",
          currency: "USD",
          paymentStatus: "succeeded",
        },
        contentSha256: "a".repeat(64),
        fieldProvenanceStatus: "available",
        fieldProvenance: [
          {
            fieldPath: "amountMinor",
            normalizedValue: "12500",
            transformationRule: "stripe_payment_v1",
            transformationVersion: "1",
            warnings: [],
          },
        ],
      },
    ],
    notes: [] as Record<string, unknown>[],
    timeline: [
      {
        id: "00000000-0000-4000-8000-000000000044",
        action: "resolution.proposed",
        resourceType: "resolution_proposal",
        resourceId: proposalId,
        actorType: "user",
        actorId: "00000000-0000-4000-8000-000000000045",
        reason: "Evidence indicates an unmatched payment.",
        occurredAt: "2026-07-27T12:01:00.000Z",
      },
    ],
    timelineTruncated: false,
    latestProposal: {
      id: proposalId,
      version: 1,
      type: "investigate_source_record",
      reason: "Evidence indicates an unmatched payment.",
      status: "pending",
      proposedBy: "00000000-0000-4000-8000-000000000045",
      canRevise: false,
      approvalCount: 1,
      requiredApprovals: 2,
      createdAt: "2026-07-27T12:01:00.000Z",
    },
  };
}
