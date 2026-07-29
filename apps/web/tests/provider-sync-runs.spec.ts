import { expect, test } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";
import { encode } from "next-auth/jwt";

const connectionId = "00000000-0000-4000-8000-000000000032";
const shopifyConnectionId = "00000000-0000-4000-8000-000000000033";
const runId = "00000000-0000-4000-8000-000000000031";
const scheduledRunId = "00000000-0000-4000-8000-000000000034";

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
            id: connectionId,
            provider: "stripe",
            externalAccountId: "acct_recovery_test",
            status: "healthy",
            connectorVersion: "1.1.0",
            apiVersion: "2025-06-30.basil",
            syncEnabled: true,
            retryCount: 0,
            deadLetterCount: 0,
            objectWatermarks: [
              {
                objectType: "payment_intent",
                observationState: "observed",
                latestSourceAt: "2026-07-27T11:58:00.000Z",
                latestReceivedAt: "2026-07-27T12:00:00.000Z",
              },
              { objectType: "refund", observationState: "never_observed" },
              { objectType: "balance_transaction", observationState: "never_observed" },
            ],
            updatedAt: "2026-07-27T12:02:00.000Z",
          },
          {
            id: shopifyConnectionId,
            provider: "shopify",
            externalAccountId: "recovery-test.myshopify.com",
            status: "healthy",
            connectorVersion: "1.0.0",
            apiVersion: "2026-07",
            syncEnabled: true,
            retryCount: 0,
            deadLetterCount: 0,
            objectWatermarks: [
              {
                objectType: "order",
                observationState: "observed",
                latestSourceAt: "2026-07-27T11:57:00.000Z",
                latestReceivedAt: "2026-07-27T11:59:00.000Z",
              },
              { objectType: "refund_transaction", observationState: "never_observed" },
            ],
            updatedAt: "2026-07-27T12:02:00.000Z",
          },
        ],
      }),
    });
  });
  await page.route("**/api/recon?view=imports", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });
  await page.route("**/api/recon?view=connector_credentials&connectionId=*", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });
});

test("queues an explicitly bounded Shopify recovery window", async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  let queued = false;
  await page.route("**/api/recon?view=provider_sync_runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          ...(queued
            ? [
                {
                  id: runId,
                  connectionId: shopifyConnectionId,
                  provider: "shopify",
                  mode: "gap_repair",
                  windowStart: "2026-07-26T00:00:00.000Z",
                  windowEnd: "2026-07-27T00:00:00.000Z",
                  status: "queued",
                  pageCount: 0,
                  itemCount: 0,
                  duplicateCount: 0,
                  maximumPages: 5,
                  failedAttempts: 0,
                  requesterType: "user",
                  createdAt: "2026-07-27T12:05:00.000Z",
                },
              ]
            : []),
          {
            id: scheduledRunId,
            connectionId: shopifyConnectionId,
            provider: "shopify",
            mode: "gap_repair",
            windowStart: "2026-07-26T00:00:00.000Z",
            windowEnd: "2026-07-27T00:00:00.000Z",
            status: "succeeded",
            pageCount: 1,
            itemCount: 2,
            duplicateCount: 1,
            maximumPages: 5,
            failedAttempts: 0,
            requesterType: "system",
            createdAt: "2026-07-27T11:45:00.000Z",
          },
        ],
      }),
    });
  });
  await page.route("**/api/recon/actions", async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    queued = true;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: runId,
          connectionId: shopifyConnectionId,
          provider: "shopify",
          mode: "gap_repair",
          status: "queued",
        },
      }),
    });
  });

  await page.goto("/dashboard/connectors");
  await expect(page.getByRole("heading", { name: "Provider recovery sync" })).toBeVisible();
  await expect(page.getByText("Payment intent", { exact: true })).toBeVisible();
  await expect(page.getByText("Refund transaction", { exact: true })).toBeVisible();
  await expect(
    page.locator(".source-watermarks").getByText("Never observed", { exact: true }),
  ).toHaveCount(3);
  await expect(page.getByText("Automatic repair")).toBeVisible();
  await page
    .getByLabel("Provider connection")
    .selectOption({ label: "Shopify · recovery-test.myshopify.com" });
  await page
    .getByLabel("Reason · required and audit-visible", { exact: true })
    .fill("Repair the approved bounded Shopify order gap");
  await expect(page.getByRole("button", { name: "Queue bounded sync" })).toBeDisabled();
  await page
    .getByLabel(
      "I confirm this read-only request is limited to the selected provider account, time window, supported record families, and page ceiling.",
    )
    .check();
  await page.getByRole("button", { name: "Queue bounded sync" }).click();

  await expect(
    page.getByText("Bounded Shopify recovery sync queued with durable tenant authority."),
  ).toBeVisible();
  expect(submitted).toMatchObject({
    action: "start_provider_sync",
    connectionId: shopifyConnectionId,
    mode: "gap_repair",
    maximumPages: 5,
    confirmed: true,
    reason: "Repair the approved bounded Shopify order gap",
  });
  expect(submitted?.["windowStart"]).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  expect(submitted?.["windowEnd"]).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
});

test("bounded provider sync controls have no detectable accessibility violations", async ({
  page,
}) => {
  await page.route("**/api/recon?view=provider_sync_runs", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });
  await page.goto("/dashboard/connectors");
  await expect(page.getByRole("heading", { name: "Provider recovery sync" })).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, undefined, {
    detailedReport: true,
    detailedReportOptions: { html: true },
  });
});

test("fails connector health closed when source-watermark evidence is malformed", async ({
  page,
}) => {
  await page.unroute("**/api/recon?view=connections");
  await page.route("**/api/recon?view=connections", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            id: connectionId,
            provider: "stripe",
            externalAccountId: "acct_recovery_test",
            status: "healthy",
            connectorVersion: "1.1.0",
            syncEnabled: true,
            retryCount: 0,
            deadLetterCount: 0,
            objectWatermarks: [
              {
                objectType: "order",
                observationState: "never_observed",
              },
            ],
            updatedAt: "2026-07-27T12:02:00.000Z",
          },
        ],
      }),
    });
  });

  await page.goto("/dashboard/connectors");
  await expect(page.getByRole("alert").getByText("Connector health unavailable")).toBeVisible();
  await expect(page.getByText("acct_recovery_test", { exact: true })).toHaveCount(0);
});

test("shows a rolling-write classification gap without inventing family freshness", async ({
  page,
}) => {
  await page.unroute("**/api/recon?view=connections");
  await page.route("**/api/recon?view=connections", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            id: connectionId,
            provider: "stripe",
            externalAccountId: "acct_recovery_test",
            status: "healthy",
            connectorVersion: "1.1.0",
            syncEnabled: true,
            retryCount: 0,
            deadLetterCount: 0,
            objectWatermarks: [
              {
                objectType: "payment_intent",
                observationState: "classification_unavailable",
              },
              {
                objectType: "refund",
                observationState: "classification_unavailable",
              },
              {
                objectType: "balance_transaction",
                observationState: "classification_unavailable",
              },
            ],
            updatedAt: "2026-07-27T12:02:00.000Z",
          },
        ],
      }),
    });
  });

  await page.goto("/dashboard/connectors");
  await expect(page.getByText("acct_recovery_test", { exact: true })).toBeVisible();
  await expect(
    page.locator(".source-watermarks").getByText("Classification unavailable", { exact: true }),
  ).toHaveCount(3);
  await expect(
    page.locator(".source-watermarks").getByText("Never observed", { exact: true }),
  ).toHaveCount(0);
});

test("rotates sealed credential metadata and requires provider-aware disconnect confirmation", async ({
  page,
}) => {
  const credentialId = "00000000-0000-4000-8000-000000000035";
  const submissions: unknown[] = [];
  await page.route("**/api/recon/actions", async (route) => {
    const submitted: unknown = route.request().postDataJSON() as unknown;
    submissions.push(submitted);
    if (
      typeof submitted === "object" &&
      submitted !== null &&
      "action" in submitted &&
      submitted["action"] === "disconnect_connector"
    ) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            status: "provider_action_required",
            provider: "stripe",
            providerActionUrl: "https://dashboard.stripe.com/settings/apps/com.reconai.synthetic",
            providerConfirmation: "pending",
            replayed: false,
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: credentialId,
          connectionId,
          purpose: "api_read",
          status: "active",
          keyVersion: "v1",
          createdAt: "2026-07-28T00:00:00.000Z",
        },
      }),
    });
  });
  await page.route("**/api/recon?view=provider_sync_runs", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });
  const envelope = {
    schemaVersion: 1,
    algorithm: "A256GCM",
    keyVersion: "v1",
    organizationId: "00000000-0000-4000-8000-000000000001",
    connectionId,
    provider: "stripe",
    purpose: "api_read",
    iv: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
    tag: "AAAAAAAAAAAAAAAAAAAAAA",
  };

  await page.goto("/dashboard/connectors");
  await page.getByLabel("Sealed envelope JSON").fill(JSON.stringify(envelope));
  await page
    .getByLabel("Credential change reason · required and audit-visible")
    .fill("Rotate the encrypted Stripe read credential");
  await page.getByLabel(/I confirm this envelope was sealed for connection/u).check();
  await page.getByRole("button", { name: "Install or rotate" }).click();
  await expect(page.getByText(`Credential ${credentialId} is active under key v1.`)).toBeVisible();

  await page.getByText("Disconnect provider", { exact: true }).click();
  await page.getByLabel("Disconnect audit reason").fill("Revoke ReconAI provider access");
  await expect(page.getByRole("button", { name: "Request provider disconnect" })).toBeDisabled();
  await page.getByLabel("Type the exact connection ID").fill(connectionId);
  await page.getByRole("button", { name: "Request provider disconnect" }).click();
  await expect(
    page.getByText(
      "ReconAI read access is stopped. Uninstall the app in Stripe to confirm provider revocation.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open Stripe app settings to uninstall" }),
  ).toHaveAttribute("href", "https://dashboard.stripe.com/settings/apps/com.reconai.synthetic");

  expect(submissions).toEqual([
    {
      action: "rotate_connector_credential",
      connectionId,
      purpose: "api_read",
      envelope,
      confirmed: true,
      reason: "Rotate the encrypted Stripe read credential",
    },
    {
      action: "disconnect_connector",
      connectionId,
      confirmConnectionId: connectionId,
      reason: "Revoke ReconAI provider access",
    },
  ]);
});
