import { expect, test } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";
import { encode } from "next-auth/jwt";

const invitationId = "00000000-0000-4000-8000-000000000030";
const invitationToken = "b".repeat(43);

test.beforeEach(async ({ context, page }) => {
  const sessionToken = await encode({
    secret: "development-only-session-secret-change-me",
    maxAge: 3_600,
    token: {
      sub: "00000000-0000-4000-8000-000000000004",
      name: "Synthetic Owner",
      email: "owner@example.test",
      apiOidcIssuer: "http://localhost:8080/realms/reconai-development",
      apiOidcSubject: "synthetic-owner",
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
  await page.route("**/api/recon?view=members", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            id: "00000000-0000-4000-8000-000000000003",
            userId: "00000000-0000-4000-8000-000000000004",
            email: "owner@example.test",
            role: "owner",
            status: "active",
            createdAt: "2026-07-27T12:00:00.000Z",
            updatedAt: "2026-07-27T12:00:00.000Z",
          },
        ],
      }),
    });
  });
  await page.route("**/api/recon?view=invitations", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [] }),
    });
  });
});

test("delivers a verified-email-bound invitation and keeps a one-time backup link", async ({
  page,
}) => {
  let submitted: unknown;
  await page.route("**/api/recon/actions", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      status: 201,
      body: JSON.stringify({
        data: {
          id: invitationId,
          email: "reviewer@example.test",
          role: "reviewer",
          status: "pending",
          invitedByMembershipId: "00000000-0000-4000-8000-000000000003",
          expiresAt: "2026-07-30T12:00:00.000Z",
          createdAt: "2026-07-27T12:00:00.000Z",
          updatedAt: "2026-07-27T12:00:00.000Z",
          acceptToken: invitationToken,
        },
        meta: {
          delivery: { status: "accepted", auditRecorded: true },
        },
      }),
    });
  });
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto("/dashboard/settings");
  await expect(page.getByRole("heading", { name: "Organization invitations" })).toBeVisible();
  await page.getByLabel("Verified email").fill("reviewer@example.test");
  await page.getByLabel("Initial role").selectOption("reviewer");
  await page
    .getByLabel("Reason · required and audit-visible")
    .last()
    .fill("Add an independent finance reviewer");
  await page.getByRole("button", { name: "Create invitation" }).click();

  await expect(page.getByText("Email delivery accepted. Copy this backup link now.")).toBeVisible();
  await expect(page.getByLabel("One-time invitation link")).toHaveValue(
    `http://127.0.0.1:3000/invitations/accept#token=${invitationToken}`,
  );
  expect(submitted).toMatchObject({
    action: "create_invitation",
    email: "reviewer@example.test",
    role: "reviewer",
    reason: "Add an independent finance reviewer",
  });
});

test("preserves the manual link when invitation email delivery fails", async ({ page }) => {
  await page.route("**/api/recon/actions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 201,
      body: JSON.stringify({
        data: {
          id: invitationId,
          email: "reviewer@example.test",
          role: "reviewer",
          status: "pending",
          invitedByMembershipId: "00000000-0000-4000-8000-000000000003",
          expiresAt: "2026-07-30T12:00:00.000Z",
          createdAt: "2026-07-27T12:00:00.000Z",
          updatedAt: "2026-07-27T12:00:00.000Z",
          acceptToken: invitationToken,
        },
        meta: {
          delivery: { status: "failed", auditRecorded: true },
        },
      }),
    });
  });
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto("/dashboard/settings");
  await page.getByLabel("Verified email").fill("reviewer@example.test");
  await page
    .getByLabel("Reason · required and audit-visible")
    .last()
    .fill("Add an independent finance reviewer");
  await page.getByRole("button", { name: "Create invitation" }).click();

  await expect(page.getByText("Email delivery failed. Copy this link now.")).toBeVisible();
  await expect(page.getByLabel("One-time invitation link")).toHaveValue(
    `http://127.0.0.1:3000/invitations/accept#token=${invitationToken}`,
  );
});

test("removes the fragment token before accepting tenant access", async ({ page }) => {
  let acceptedBody: unknown;
  await page.route("**/api/recon/invitations/accept", async (route) => {
    acceptedBody = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      status: 201,
      body: JSON.stringify({
        data: {
          organizationId: "00000000-0000-4000-8000-000000000001",
          invitationId,
          membershipId: "00000000-0000-4000-8000-000000000031",
          userId: "00000000-0000-4000-8000-000000000032",
          role: "reviewer",
        },
      }),
    });
  });
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto(`/invitations/accept#token=${invitationToken}`);
  await expect(page.getByRole("heading", { name: "Accept invitation" })).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:3000/invitations/accept");
  await page.getByRole("button", { name: "Accept access" }).click();
  await expect(page.getByText("Invitation accepted")).toBeVisible();
  expect(acceptedBody).toEqual({ token: invitationToken });
});

test("invitation management has no automatically detectable accessibility violations", async ({
  page,
}) => {
  await page.goto("/dashboard/settings");
  await expect(page.getByRole("heading", { name: "Organization invitations" })).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, undefined, {
    detailedReport: true,
    detailedReportOptions: { html: true },
  });
});
