import { expect, test } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";
import { encode } from "next-auth/jwt";

const organizationA = "00000000-0000-4000-8000-000000000001";
const organizationB = "00000000-0000-4000-8000-000000000002";

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
              id: organizationA,
              name: "Acme Operations",
              membershipId: "00000000-0000-4000-8000-000000000003",
              role: "analyst",
            },
            {
              id: organizationB,
              name: "Northwind Finance",
              membershipId: "00000000-0000-4000-8000-000000000005",
              role: "reviewer",
            },
          ],
          selectedOrganizationId: organizationA,
        },
        meta: {
          correlationId: "00000000-0000-4000-8000-000000000006",
          truncated: false,
        },
      }),
    });
  });
  await page.route("**/api/recon?view=summary", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [],
        meta: {
          filteredCount: 0,
          canExport: false,
          summary: { open: 0, high: 0, awaitingApproval: 0, decided: 0 },
        },
      }),
    });
  });
});

test("switches only to an organization returned by the verified membership directory", async ({
  page,
}) => {
  let submitted: unknown;
  await page.route("**/api/recon/organization", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: organizationB,
          name: "Northwind Finance",
          membershipId: "00000000-0000-4000-8000-000000000005",
          role: "reviewer",
        },
      }),
    });
  });

  await page.goto("/dashboard");
  await expect(page.locator(".org-switcher strong")).toHaveText("Acme Operations");
  const switchButton = page.getByRole("button", { name: "Switch" });
  await expect(switchButton).toBeDisabled();
  await page.getByLabel("Organization", { exact: true }).selectOption(organizationB);
  await expect(switchButton).toBeEnabled();
  await switchButton.click();

  await expect.poll(() => submitted).toEqual({ organizationId: organizationB });
  await expect(page).toHaveURL("http://127.0.0.1:3000/dashboard");
});

test("organization selection has no automatically detectable accessibility violations", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await expect(page.getByLabel("Organization", { exact: true })).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, undefined, {
    detailedReport: true,
    detailedReportOptions: { html: true },
  });
});

test("caps accumulated memberships at 500 and selects membership 501 through exact search", async ({
  page,
}) => {
  const memberships = Array.from({ length: 501 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
    name: `Scale Tenant ${index.toString().padStart(3, "0")}`,
    role: "reviewer",
  }));
  const target = memberships[500];
  if (!target) throw new Error("target organization fixture was not created");
  let submitted: unknown;

  await page.unroute("**/api/recon?view=organizations");
  await page.route("**/api/recon?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("view") !== "organizations") {
      await route.fallback();
      return;
    }
    const search = url.searchParams.get("search");
    const cursor = url.searchParams.get("cursor");
    const pageNumber = cursor ? Number(cursor.replace("page-", "")) : 0;
    const organizations =
      search === target.name ? [target] : memberships.slice(pageNumber * 50, pageNumber * 50 + 50);
    const nextCursor =
      !search && (pageNumber + 1) * 50 < memberships.length
        ? `page-${(pageNumber + 1).toString()}`
        : undefined;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: { organizations },
        meta: {
          correlationId: "00000000-0000-4000-8000-000000000006",
          truncated: nextCursor !== undefined,
          ...(nextCursor ? { nextCursor } : {}),
        },
      }),
    });
  });
  await page.route("**/api/recon/organization", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: target }),
    });
  });

  await page.goto("/dashboard");
  const selector = page.getByLabel("Organization", { exact: true });
  await expect(selector.locator("option")).toHaveCount(50);
  for (let expectedCount = 100; expectedCount <= 500; expectedCount += 50) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await expect(selector.locator("option")).toHaveCount(expectedCount);
  }
  await expect(page.getByRole("button", { name: "More", exact: true })).toHaveCount(0);
  await expect(page.getByText("Refine search to see additional memberships.")).toBeVisible();
  await expect(selector.locator(`option[value="${target.id}"]`)).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Search organizations" }).fill(target.name);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(selector.locator("option")).toHaveCount(1);
  await expect(selector).toHaveValue(target.id);
  await expect(page.getByText("Refine search to see additional memberships.")).toHaveCount(0);
  await page.getByRole("button", { name: "Switch", exact: true }).click();

  await expect.poll(() => submitted).toEqual({ organizationId: target.id });
});

test("deduplicates a membership renamed across a mutable page boundary", async ({ page }) => {
  await page.unroute("**/api/recon?view=organizations");
  await page.route("**/api/recon?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("view") !== "organizations") {
      await route.fallback();
      return;
    }
    const secondPage = url.searchParams.get("cursor") === "next_page";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          organizations: secondPage
            ? [
                {
                  id: organizationA,
                  name: "Aardvark After Rename",
                  role: "analyst",
                },
                {
                  id: organizationB,
                  name: "Northwind Finance",
                  role: "reviewer",
                },
              ]
            : [
                {
                  id: organizationA,
                  name: "Zulu Before Rename",
                  role: "analyst",
                },
              ],
          selectedOrganizationId: organizationA,
          selectedOrganization: {
            id: organizationA,
            name: secondPage ? "Aardvark After Rename" : "Zulu Before Rename",
            role: "analyst",
          },
        },
        meta: {
          correlationId: "00000000-0000-4000-8000-000000000006",
          truncated: !secondPage,
          ...(!secondPage ? { nextCursor: "next_page" } : {}),
        },
      }),
    });
  });

  await page.goto("/dashboard");
  const selector = page.getByLabel("Organization", { exact: true });
  await expect(selector.locator("option")).toHaveCount(1);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(selector.locator("option")).toHaveCount(2);
  await expect(selector.locator(`option[value="${organizationA}"]`)).toHaveText(
    "Aardvark After Rename · analyst",
  );
  await expect(selector.locator(`option[value="${organizationB}"]`)).toHaveText(
    "Northwind Finance · reviewer",
  );
});
