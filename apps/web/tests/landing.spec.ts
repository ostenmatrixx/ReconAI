import { expect, test } from "@playwright/test";
import { injectAxe, checkA11y } from "axe-playwright";

test("presents an honest pre-release safety boundary", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Reconciliation your finance team can actually defend.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Pre-release · Not production-ready")).toBeVisible();
  await expect(page.getByText("Synthetic interface example.")).toBeVisible();
  await expect(page.getByText("Read-only by design")).toBeVisible();
});

test("landing page has no automatically detectable accessibility violations", async ({ page }) => {
  await page.goto("/");
  await injectAxe(page);
  await checkA11y(page, undefined, {
    detailedReport: true,
    detailedReportOptions: { html: true },
  });
});
