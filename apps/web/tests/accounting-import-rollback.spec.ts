import { expect, test } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";
import { encode } from "next-auth/jwt";

const importId = "00000000-0000-4000-8000-000000000071";
const succeededImport = {
  id: importId,
  connectionId: "00000000-0000-4000-8000-000000000072",
  status: "succeeded",
  checksumSha256: "a".repeat(64),
  byteCount: 512,
  filename: "july-close.csv",
  templateVersion: "accounting-v1",
  mappingVersion: "mapping-v1",
  rowCount: 3,
  validRowCount: 3,
  invalidRowCount: 0,
  previewRows: [],
  previewErrors: [],
  errorsTruncated: false,
  uploadedAt: "2026-07-27T12:00:00.000Z",
  committedAt: "2026-07-27T12:01:00.000Z",
  completedAt: "2026-07-27T12:02:00.000Z",
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
  await page.route("**/api/recon?view=connections", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            id: succeededImport.connectionId,
            provider: "accounting_csv",
            externalAccountId: "finance-close-ledger",
            status: "healthy",
            connectorVersion: "1.0.0",
            syncEnabled: false,
            retryCount: 0,
            deadLetterCount: 0,
            objectWatermarks: [
              {
                objectType: "csv_row",
                observationState: "observed",
                latestSourceAt: "2026-07-27T12:01:00.000Z",
                latestReceivedAt: "2026-07-27T12:02:00.000Z",
              },
            ],
            updatedAt: "2026-07-27T12:02:00.000Z",
          },
        ],
      }),
    });
  });
  await page.route("**/api/recon?view=provider_sync_runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [] }),
    });
  });
});

test("requires exact confirmation and shows retained-evidence rollback outcome", async ({
  page,
}) => {
  let rolledBack = false;
  let submitted: unknown;
  await page.route("**/api/recon?view=imports", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          rolledBack
            ? {
                ...succeededImport,
                status: "rolled_back",
                rolledBackAt: "2026-07-27T12:03:00.000Z",
                supersededRecordCount: 3,
              }
            : succeededImport,
        ],
      }),
    });
  });
  await page.route("**/api/recon/actions", async (route) => {
    submitted = route.request().postDataJSON();
    rolledBack = true;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          ...succeededImport,
          status: "rolled_back",
          rolledBackAt: "2026-07-27T12:03:00.000Z",
          supersededRecordCount: 3,
        },
      }),
    });
  });

  await page.goto("/dashboard/connectors");
  await expect(page.getByRole("heading", { name: "Recent CSV imports" })).toBeVisible();
  await expect(page.getByText("CSV row", { exact: true })).toBeVisible();
  await expect(page.getByText(/Source Jul 27, 2026/u)).toBeVisible();
  await page.getByText("Roll back", { exact: true }).click();
  await page.getByLabel("Reason").fill("Exclude the duplicate close file from future runs");
  await expect(page.getByRole("button", { name: "Confirm rollback" })).toBeDisabled();
  await page.getByLabel("Confirm import ID").fill(importId);
  await page.getByRole("button", { name: "Confirm rollback" }).click();

  await expect(page.getByText("3 canonical records superseded")).toBeVisible();
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
  expect(submitted).toEqual({
    action: "rollback_import",
    importId,
    confirmImportId: importId,
    reason: "Exclude the duplicate close file from future runs",
  });
});

test("accounting import rollback controls have no detectable accessibility violations", async ({
  page,
}) => {
  await page.route("**/api/recon?view=imports", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [succeededImport] }),
    });
  });
  await page.goto("/dashboard/connectors");
  await expect(page.getByRole("heading", { name: "Recent CSV imports" })).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, undefined, {
    detailedReport: true,
    detailedReportOptions: { html: true },
  });
});
