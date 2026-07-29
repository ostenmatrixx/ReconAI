import { expect, test } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";
import { encode } from "next-auth/jwt";

const initialPolicy = {
  dualApprovalEnabled: true,
  dualApprovalThresholds: { USD: "100000" },
  sensitiveResolutionTypes: ["manual_override", "write_off"],
  updatedAt: "2026-07-27T12:00:00.000Z",
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
  await page.route("**/api/recon?view=review_policy", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: initialPolicy }),
    });
  });
});

test("updates bounded dual-approval policy only after reason and explicit confirmation", async ({
  page,
}) => {
  let submitted: unknown;
  await page.route("**/api/recon/actions", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          dualApprovalEnabled: true,
          dualApprovalThresholds: { EUR: "250000", USD: "150000" },
          sensitiveResolutionTypes: ["manual_override", "write_off"],
          updatedAt: "2026-07-27T12:05:00.000Z",
        },
      }),
    });
  });

  await page.goto("/dashboard/rules");
  await expect(page.getByRole("heading", { name: "Rules & tolerances" })).toBeVisible();
  await page.getByLabel("Amount in minor units for USD").fill("150000");
  await page.getByRole("button", { name: "Add threshold" }).click();
  const newThreshold = page.locator(".threshold-row").last();
  await newThreshold.getByLabel(/Currency for threshold/u).fill("eur");
  await newThreshold.getByLabel("Amount in minor units for EUR").fill("250000");
  await page
    .getByLabel("Reason · required and audit-visible")
    .fill("Raise independent review requirements for the quarter close");
  await expect(page.getByRole("button", { name: "Save review policy" })).toBeDisabled();
  await page
    .getByLabel("I confirm this changes the independent approval requirement for future proposals.")
    .check();
  await page.getByRole("button", { name: "Save review policy" }).click();

  await expect(
    page.getByText("Review policy updated and recorded in the audit history."),
  ).toBeVisible();
  expect(submitted).toEqual({
    action: "update_review_policy",
    dualApprovalEnabled: true,
    dualApprovalThresholds: { EUR: "250000", USD: "150000" },
    sensitiveResolutionTypes: ["manual_override", "write_off"],
    reason: "Raise independent review requirements for the quarter close",
  });
});

test("review policy settings have no detectable accessibility violations", async ({ page }) => {
  await page.goto("/dashboard/rules");
  await expect(page.getByRole("heading", { name: "Rules & tolerances" })).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, undefined, {
    detailedReport: true,
    detailedReportOptions: { html: true },
  });
});
