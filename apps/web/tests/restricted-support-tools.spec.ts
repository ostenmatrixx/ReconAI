import { expect, test } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";
import { encode } from "next-auth/jwt";

const organizationId = "00000000-0000-4000-8000-000000000061";
const grantId = "00000000-0000-4000-8000-000000000062";
const requestCode = "r".repeat(43);
interface SupportGrantFixture {
  readonly id: string;
  readonly supportIdentityReference: string;
  readonly capability: "diagnostics:view";
  readonly ticketReference: string;
  readonly reason: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly status: "active" | "expired" | "revoked";
  readonly revokedAt?: string;
  readonly revocationReason?: string;
}

const activeGrant: SupportGrantFixture = {
  id: grantId,
  supportIdentityReference: "abcdef123456",
  capability: "diagnostics:view",
  ticketReference: "SUP-1042",
  reason: "Investigate delayed synthetic reconciliation work",
  approvedAt: "2026-07-29T08:00:00.000Z",
  expiresAt: "2026-07-29T08:30:00.000Z",
  status: "active",
};

test.beforeEach(async ({ context, page }) => {
  const sessionToken = await encode({
    secret: "development-only-session-secret-change-me",
    maxAge: 3_600,
    token: {
      sub: "00000000-0000-4000-8000-000000000060",
      name: "Synthetic Restricted Operator",
      email: "restricted-support@example.test",
      apiOidcIssuer: "http://localhost:8080/realms/reconai-development",
      apiOidcSubject: "synthetic-restricted-support",
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
      body: JSON.stringify({
        data: {
          rawImportRetentionDays: null,
          providerEventRetentionDays: null,
          legalHoldEnabled: false,
          legalHoldReason: null,
          updatedAt: null,
        },
      }),
    });
  });
  await page.route("**/api/recon?view=privacy_requests*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [], meta: { truncated: false, maximumItems: 100 } }),
    });
  });
});

test("keeps the one-time request code in page memory and loads only approved aggregates", async ({
  page,
}) => {
  let submittedRequest: unknown;
  let diagnosticUrl = "";
  await page.route("**/api/recon/support*", async (route) => {
    if (route.request().method() === "POST") {
      submittedRequest = route.request().postDataJSON();
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            requestCode,
            requestExpiresAt: "2026-07-29T08:15:00.000Z",
          },
        }),
      });
      return;
    }
    diagnosticUrl = route.request().url();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          schemaVersion: "support-diagnostics-v1",
          generatedAt: "2026-07-29T08:05:00.000Z",
          grantExpiresAt: "2026-07-29T08:30:00.000Z",
          countsCapped: false,
          connections: {
            total: 3,
            nonHealthy: 1,
            latestSuccessfulSyncAt: "2026-07-29T07:58:00.000Z",
          },
          providerSyncs: {
            active: 1,
            failed: 2,
            latestCompletedAt: "2026-07-29T07:57:00.000Z",
          },
          reconciliations: {
            active: 2,
            failedOrPartial: 1,
            latestCompletedAt: "2026-07-29T07:55:00.000Z",
          },
          exceptions: {
            unresolved: 7,
            oldestUnresolvedAt: "2026-07-28T08:00:00.000Z",
          },
          outbox: {
            unpublished: 4,
            deadLettered: 1,
            oldestUnpublishedAt: "2026-07-29T07:50:00.000Z",
          },
        },
      }),
    });
  });

  await page.goto("/support");
  await expect(page.getByRole("heading", { name: "Restricted support console" })).toBeVisible();
  await page.getByRole("button", { name: "Create approval request" }).click();

  expect(submittedRequest).toEqual({
    action: "create_request",
    requestedDurationMinutes: 30,
  });
  await expect(page.getByLabel("One-time request code")).toHaveValue(requestCode);
  expect(
    await page.evaluate(
      (sensitiveCode) =>
        [window.localStorage, window.sessionStorage].every((storage) =>
          Array.from({ length: storage.length }, (_, index) => {
            const key = storage.key(index);
            return key ? storage.getItem(key) : null;
          })
            .filter((value): value is string => value !== null)
            .every((value) => !value.includes(sensitiveCode)),
        ),
      requestCode,
    ),
  ).toBe(true);

  await page.getByLabel("Organization ID").fill(organizationId);
  await page.getByLabel("Grant ID").fill(grantId);
  await page.getByRole("button", { name: "Load approved diagnostics" }).click();

  const diagnosticQuery = new URL(diagnosticUrl).searchParams;
  expect(Object.fromEntries(diagnosticQuery)).toEqual({ organizationId, grantId });
  await expect(page.getByRole("heading", { name: "Approved diagnostic ledger" })).toBeVisible();
  await expect(page.getByText("7", { exact: true })).toBeVisible();
  await expect(page.getByText("unresolved", { exact: true })).toBeVisible();
  await expect(page.getByText("customer@example.test")).toHaveCount(0);

  await page.getByRole("button", { name: "Clear code" }).click();
  await expect(page.getByLabel("One-time request code")).toHaveCount(0);
});

test("uses a uniform unavailable state for rejected diagnostic authority", async ({ page }) => {
  await page.route("**/api/recon/support*", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ code: "SUPPORT_ACCESS_NOT_FOUND" }),
    });
  });
  await page.goto("/support");
  await page.getByLabel("Organization ID").fill(organizationId);
  await page.getByLabel("Grant ID").fill(grantId);
  await page.getByRole("button", { name: "Load approved diagnostics" }).click();

  await expect(
    page.getByText(
      "Diagnostics are unavailable. Verify the approved identifiers and grant state in the authenticated support ticket.",
    ),
  ).toBeVisible();
  await expect(page.getByText(/revoked|expired|foreign/iu)).toHaveCount(0);
});

test("tenant owner approval and revocation send explicit confirmation and clear the request code", async ({
  page,
}) => {
  let grants: readonly SupportGrantFixture[] = [];
  const submittedActions: unknown[] = [];
  await page.route("**/api/recon?view=support_access_grants", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: grants }),
    });
  });
  await page.route("**/api/recon/actions", async (route) => {
    const submitted = route.request().postDataJSON() as { readonly action?: string };
    submittedActions.push(submitted);
    if (submitted.action === "approve_support_access") {
      grants = [activeGrant];
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ data: activeGrant }),
      });
      return;
    }
    grants = [
      {
        ...activeGrant,
        status: "revoked",
        revokedAt: "2026-07-29T08:10:00.000Z",
        revocationReason: "The synthetic investigation is complete",
      },
    ];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: { outcome: "revoked", grant: grants[0] } }),
    });
  });

  await page.goto("/dashboard/security");
  await expect(page.getByRole("heading", { name: "Restricted support access" })).toBeVisible();
  await page.getByLabel("One-time request code").fill(requestCode);
  await page.getByLabel("Support ticket reference").fill("SUP-1042");
  await page
    .getByLabel("Approval reason · audit-visible")
    .fill("Investigate delayed synthetic reconciliation work");
  await page
    .getByLabel(
      "I confirm this request belongs to the currently selected organization and may expose bounded operational aggregates for at most 60 minutes.",
    )
    .check();
  await page.getByRole("button", { name: "Approve restricted access" }).click();

  await expect(
    page.getByText("Restricted diagnostic access approved and recorded in audit history."),
  ).toBeVisible();
  await expect(page.getByLabel("One-time request code")).toHaveValue("");
  expect(submittedActions[0]).toEqual({
    action: "approve_support_access",
    requestCode,
    ticketReference: "SUP-1042",
    reason: "Investigate delayed synthetic reconciliation work",
    confirmed: true,
  });

  await expect(page.getByText("Support identity abcdef123456")).toBeVisible();
  await page
    .getByLabel("Revocation reason · audit-visible")
    .fill("The synthetic investigation is complete");
  await page.getByLabel("I confirm this grant must no longer authorize diagnostics.").check();
  await page.getByRole("button", { name: "Revoke access" }).click();

  expect(submittedActions[1]).toEqual({
    action: "revoke_support_access",
    grantId,
    reason: "The synthetic investigation is complete",
    confirmed: true,
  });
  await expect(
    page.getByText("Restricted diagnostic access revoked and recorded in audit history."),
  ).toBeVisible();
});

test("restricted support tools have no detectable accessibility violations", async ({ page }) => {
  await page.route("**/api/recon/support*", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ code: "SUPPORT_ACCESS_NOT_FOUND" }),
    });
  });
  await page.goto("/support");
  await expect(page.getByRole("heading", { name: "Restricted support console" })).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, undefined, {
    detailedReport: true,
    detailedReportOptions: { html: true },
  });

  await page.route("**/api/recon?view=support_access_grants", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [activeGrant] }),
    });
  });
  await page.goto("/dashboard/security");
  await expect(page.getByRole("heading", { name: "Restricted support access" })).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, undefined, {
    detailedReport: true,
    detailedReportOptions: { html: true },
  });
});
