import { expect, test } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";
import { encode } from "next-auth/jwt";

const organizationId = "00000000-0000-4000-8000-000000000001";
const initialProfile = {
  name: "Acme Operations",
  businessTimeZone: "America/New_York",
  profileVersion: 3,
  updatedAt: "2026-07-30T12:00:00.000Z",
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
      apiAccessTokenExpiresAt: Math.floor(Date.now() / 1_000) + 3_600,
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
  await page.route("**/api/recon?view=organizations", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          organizations: [
            {
              id: organizationId,
              name: initialProfile.name,
              role: "administrator",
            },
          ],
          selectedOrganizationId: organizationId,
          selectedOrganization: {
            id: organizationId,
            name: initialProfile.name,
            role: "administrator",
          },
        },
        meta: {},
      }),
    });
  });
  await page.route("**/api/recon?view=organization_profile", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: initialProfile }),
    });
  });
  await page.route("**/api/recon?view=members", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [] }),
    });
  });
  await page.route("**/api/recon?view=invitations", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [] }),
    });
  });
});

test("updates the versioned name after explicit confirmation and refreshes the switcher", async ({
  page,
}) => {
  let submitted: unknown;
  await page.route("**/api/recon/actions", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          name: "North Operations",
          businessTimeZone: initialProfile.businessTimeZone,
          profileVersion: 4,
          updatedAt: "2026-07-30T12:05:00.000Z",
        },
      }),
    });
  });

  await page.goto("/dashboard/settings");
  await expect(page.getByRole("heading", { name: "Organization settings" })).toBeVisible();
  await expect(page.getByLabel("Business time zone · read only")).toHaveValue(
    initialProfile.businessTimeZone,
  );
  await page.getByLabel("Organization name", { exact: true }).fill("North Operations");
  await page
    .getByLabel("Organization name change reason · required and audit-visible")
    .fill("Adopt the approved operating name");
  page.once("dialog", async (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Save organization name" }).click();

  await expect(
    page.getByText("Organization name updated and recorded in the audit history."),
  ).toBeVisible();
  await expect(page.locator(".org-switcher strong")).toHaveText("North Operations");
  await expect(page.getByText("Version 4 · Updated")).toBeVisible();
  expect(submitted).toEqual({
    action: "update_organization_profile",
    name: "North Operations",
    expectedProfileVersion: 3,
    reason: "Adopt the approved operating name",
  });
});

test("reloads current profile authority after a stale version conflict", async ({ page }) => {
  await page.unroute("**/api/recon?view=organization_profile");
  let readCount = 0;
  await page.route("**/api/recon?view=organization_profile", async (route) => {
    readCount += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data:
          readCount === 1
            ? initialProfile
            : {
                ...initialProfile,
                name: "Concurrent Operations",
                profileVersion: 4,
                updatedAt: "2026-07-30T12:04:00.000Z",
              },
      }),
    });
  });
  await page.route("**/api/recon/actions", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        code: "CONFLICT",
        message: "The action conflicts with the current state. Refresh and try again.",
      }),
    });
  });

  await page.goto("/dashboard/settings");
  await page.getByLabel("Organization name", { exact: true }).fill("North Operations");
  await page
    .getByLabel("Organization name change reason · required and audit-visible")
    .fill("Adopt the approved operating name");
  page.once("dialog", async (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Save organization name" }).click();

  await expect(page.getByText(/Another administrator changed this profile/u)).toBeVisible();
  await expect(page.getByLabel("Organization name", { exact: true })).toHaveValue(
    "Concurrent Operations",
  );
  await expect(page.getByText("Version 4 · Updated")).toBeVisible();
  expect(readCount).toBe(2);
});

test("organization profile settings have no detectable accessibility violations", async ({
  page,
}) => {
  await page.goto("/dashboard/settings");
  await expect(page.getByRole("heading", { name: "Organization settings" })).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, undefined, {
    detailedReport: true,
    detailedReportOptions: { html: true },
  });
});
