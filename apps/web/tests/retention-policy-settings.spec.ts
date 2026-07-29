import { stat } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";
import { encode } from "next-auth/jwt";

const initialPolicy = {
  rawImportRetentionDays: null,
  providerEventRetentionDays: 90,
  legalHoldEnabled: false,
  legalHoldReason: null,
  updatedAt: null,
} as const;

test.beforeEach(async ({ context, page }) => {
  const sessionToken = await encode({
    secret: "development-only-session-secret-change-me",
    maxAge: 3_600,
    token: {
      sub: "00000000-0000-4000-8000-000000000004",
      name: "Synthetic Administrator",
      email: "administrator@example.test",
      apiOidcIssuer: "http://localhost:8080/realms/reconai-development",
      apiOidcSubject: "synthetic-administrator",
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
  await page.route("**/api/recon?view=retention_policy", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: initialPolicy }),
    });
  });
  await page.route("**/api/recon?view=privacy_requests*", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (cursor) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: "00000000-0000-4000-8000-000000000044",
              connectionId: "00000000-0000-4000-8000-000000000042",
              provider: "shopify",
              topic: "shop/redact",
              apiVersion: "2026-07",
              externalAccountId: "second-shop.myshopify.com",
              status: "action_required",
              objectIdentifierCount: 0,
              receivedAt: "2026-07-28T03:00:00.000Z",
              dueAt: "2026-08-27T03:00:00.000Z",
              deadlineAlert: {
                stage: "overdue",
                observedAt: "2026-08-27T03:15:00.000Z",
              },
              deletionProgress: {
                total: 1,
                pending: 0,
                processing: 0,
                retry: 0,
                deleted: 0,
                alreadyMissing: 0,
                deadLettered: 1,
              },
            },
          ],
          meta: { truncated: false, maximumItems: 100 },
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            id: "00000000-0000-4000-8000-000000000041",
            connectionId: "00000000-0000-4000-8000-000000000042",
            provider: "shopify",
            topic: "customers/data_request",
            apiVersion: "2026-07",
            externalAccountId: "synthetic-shop.myshopify.com",
            status: "action_required",
            objectIdentifierCount: 2,
            receivedAt: "2026-07-28T01:00:00.000Z",
            dueAt: "2026-08-27T01:00:00.000Z",
            deletionProgress: {
              total: 0,
              pending: 0,
              processing: 0,
              retry: 0,
              deleted: 0,
              alreadyMissing: 0,
              deadLettered: 0,
            },
          },
          {
            id: "00000000-0000-4000-8000-000000000043",
            connectionId: "00000000-0000-4000-8000-000000000042",
            provider: "shopify",
            topic: "customers/redact",
            apiVersion: "2026-07",
            externalAccountId: "synthetic-shop.myshopify.com",
            status: "action_required",
            objectIdentifierCount: 2,
            receivedAt: "2026-07-28T02:00:00.000Z",
            dueAt: "2026-08-27T02:00:00.000Z",
            deadlineAlert: {
              stage: "due_24_hours",
              observedAt: "2026-08-26T02:15:00.000Z",
            },
            deletionProgress: {
              total: 2,
              pending: 0,
              processing: 0,
              retry: 1,
              deleted: 1,
              alreadyMissing: 0,
              deadLettered: 0,
            },
          },
        ],
        meta: {
          truncated: true,
          maximumItems: 100,
          nextCursor: "tenant_cursor",
        },
      }),
    });
  });
});

test("updates retention only after reason, legal-hold evidence, and confirmation", async ({
  page,
}) => {
  let submitted: unknown;
  await page.route("**/api/recon/actions", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          rawImportRetentionDays: 30,
          providerEventRetentionDays: 90,
          legalHoldEnabled: true,
          legalHoldReason: "Preserve evidence for the synthetic investigation",
          updatedAt: "2026-07-27T12:05:00.000Z",
        },
      }),
    });
  });

  await page.goto("/dashboard/security");
  await expect(page.getByRole("heading", { name: "Security & retention" })).toBeVisible();
  await expect(page.getByText("Not configured")).toBeVisible();
  await page.getByLabel("Raw accounting import · days").fill("30");
  await page.getByLabel("Enable legal hold").check();
  await page
    .getByLabel("Legal-hold reason · required")
    .fill("Preserve evidence for the synthetic investigation");
  await page
    .getByLabel("Change reason · required and audit-visible")
    .fill("Apply the approved synthetic lifecycle controls");
  await expect(page.getByRole("button", { name: "Save retention policy" })).toBeDisabled();
  await page
    .getByLabel(
      "I confirm these durations may permanently delete eligible raw objects and that the legal-hold state is correct.",
    )
    .check();
  await page.getByRole("button", { name: "Save retention policy" }).click();

  await expect(
    page.getByText("Retention policy updated and recorded in the audit history."),
  ).toBeVisible();
  expect(submitted).toEqual({
    action: "update_retention_policy",
    rawImportRetentionDays: 30,
    providerEventRetentionDays: 90,
    legalHoldEnabled: true,
    legalHoldReason: "Preserve evidence for the synthetic investigation",
    confirmed: true,
    reason: "Apply the approved synthetic lifecycle controls",
  });
});

test("retention policy settings have no detectable accessibility violations", async ({ page }) => {
  await page.goto("/dashboard/security");
  await expect(page.getByRole("heading", { name: "Security & retention" })).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, undefined, {
    detailedReport: true,
    detailedReportOptions: { html: true },
  });
});

test("shows minimized Shopify privacy deadlines and raw deletion progress", async ({ page }) => {
  await page.goto("/dashboard/security");

  await expect(page.getByRole("heading", { name: "Shopify privacy requests" })).toBeVisible();
  await expect(page.getByText("Raw object erasure only")).toBeVisible();
  await expect(page.getByText("Merchant data package required")).toBeVisible();
  await expect(page.getByText("1/2 raw objects complete")).toBeVisible();
  await expect(page.getByText(/1 retry · 0 dead-lettered/u)).toBeVisible();
  await expect(page.getByText("synthetic-shop.myshopify.com").first()).toBeVisible();
  await expect(page.getByText("Customer data request")).toBeVisible();
  await expect(page.getByText("Customer redaction")).toBeVisible();
  await expect(page.getByText(/24-hour escalation recorded/u)).toBeVisible();
  await page.getByRole("button", { name: "Load more privacy requests" }).click();
  await expect(page.getByText("Shop redaction")).toBeVisible();
  await expect(page.getByText("second-shop.myshopify.com")).toBeVisible();
  await expect(page.getByText(/1 dead-lettered/u)).toBeVisible();
  await expect(page.getByText(/Overdue escalation recorded/u)).toBeVisible();
  await expect(page.getByText("must-not-be-persisted@example.test")).toHaveCount(0);
});

test("requires confirmation and downloads a non-empty scoped privacy evidence package", async ({
  page,
}) => {
  const submitted: unknown[] = [];
  const packageId = "00000000-0000-4000-8000-000000000053";
  const receiptToken = "a".repeat(43);
  await page.route("**/api/recon/exports/privacy-data-package", async (route) => {
    const body = route.request().postDataJSON() as {
      readonly action?: string;
    };
    submitted.push(body);
    if (body.action === "acknowledge_browser_receipt") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            packageId,
            status: "acknowledged",
            preparedAt: "2026-07-29T03:00:00.000Z",
            receiptExpiresAt: "2026-07-29T03:10:00.000Z",
            receivedAt: "2026-07-29T03:05:00.000Z",
          },
          meta: { correlationId: "00000000-0000-4000-8000-000000000054" },
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      headers: {
        "content-disposition": 'attachment; filename="reconai-shopify-customer-data-evidence.json"',
        "x-reconai-privacy-package-id": packageId,
        "x-reconai-privacy-package-receipt-token": receiptToken,
        "x-reconai-privacy-package-receipt-expires-at": "2026-07-29T03:10:00.000Z",
      },
      body: JSON.stringify({
        schemaVersion: 1,
        packageId,
        scope: {
          completeWithinDeclaredScope: true,
          limitations: ["Merchant review and controlled delivery remain required."],
        },
        records: [],
      }),
    });
  });

  await page.goto("/dashboard/security");
  await page.getByRole("button", { name: "Prepare evidence package" }).click();
  const submit = page.getByRole("button", { name: "Prepare and download" });
  await expect(submit).toBeDisabled();
  await page
    .getByLabel("Preparation reason")
    .fill("Prepare evidence for controlled merchant review");
  await expect(submit).toBeDisabled();
  await page
    .getByLabel(
      "I understand this is a scoped evidence package, not proof of request fulfillment or delivery.",
    )
    .check();

  const [download] = await Promise.all([page.waitForEvent("download"), submit.click()]);
  expect(download.suggestedFilename()).toBe("reconai-shopify-customer-data-evidence.json");
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("expected a completed privacy evidence download");
  expect((await stat(downloadPath)).size).toBeGreaterThan(0);
  await expect(
    page.getByText(
      "Evidence package browser receipt audit-recorded. Review it before controlled merchant delivery; this does not prove fulfillment.",
    ),
  ).toBeVisible();
  expect(submitted).toEqual([
    {
      requestId: "00000000-0000-4000-8000-000000000041",
      confirmed: true,
      reason: "Prepare evidence for controlled merchant review",
    },
    {
      action: "acknowledge_browser_receipt",
      requestId: "00000000-0000-4000-8000-000000000041",
      packageId,
      receiptToken,
    },
  ]);
});

test("fails closed before download when the browser receipt cannot be recorded", async ({
  page,
}) => {
  let downloadStarted = false;
  page.on("download", () => {
    downloadStarted = true;
  });
  const packageId = "00000000-0000-4000-8000-000000000053";
  await page.route("**/api/recon/exports/privacy-data-package", async (route) => {
    const body = route.request().postDataJSON() as { readonly action?: string };
    if (body.action === "acknowledge_browser_receipt") {
      await route.fulfill({
        status: 410,
        contentType: "application/json",
        body: JSON.stringify({ code: "PRIVACY_DATA_PACKAGE_RECEIPT_EXPIRED" }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      headers: {
        "x-reconai-privacy-package-id": packageId,
        "x-reconai-privacy-package-receipt-token": "a".repeat(43),
        "x-reconai-privacy-package-receipt-expires-at": "2026-07-29T03:10:00.000Z",
      },
      body: JSON.stringify({ schemaVersion: 1, packageId, records: [] }),
    });
  });

  await page.goto("/dashboard/security");
  await page.getByRole("button", { name: "Prepare evidence package" }).click();
  await page
    .getByLabel("Preparation reason")
    .fill("Prepare evidence for controlled merchant review");
  await page
    .getByLabel(
      "I understand this is a scoped evidence package, not proof of request fulfillment or delivery.",
    )
    .check();
  await page.getByRole("button", { name: "Prepare and download" }).click();

  await expect(
    page.getByText(
      "The evidence package was not downloaded because browser receipt could not be recorded.",
    ),
  ).toBeVisible();
  expect(downloadStarted).toBe(false);
});
