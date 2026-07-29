import { getToken } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  issueOrganizationContext,
  organizationContextCookieName,
} from "../../../../../organization-context";
import { POST } from "./route";

vi.mock("next-auth/jwt", () => ({ getToken: vi.fn() }));

const organizationId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000041";
const packageId = "00000000-0000-4000-8000-000000000053";
const correlationId = "00000000-0000-4000-8000-000000000054";
const subject = "synthetic-privacy-administrator";
const secret = "development-only-session-secret-change-me";
const receiptToken = "a".repeat(43);
const preparedAt = "2026-07-29T03:00:00.000Z";
const receiptExpiresAt = "2026-07-29T03:10:00.000Z";

describe("privacy data package BFF", { concurrent: false }, () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WEB_ORIGIN", "http://localhost:3000");
    vi.stubEnv("API_ORIGIN", "http://127.0.0.1:4000");
    vi.stubEnv("SESSION_SECRET", secret);
    vi.mocked(getToken).mockResolvedValue({
      sub: subject,
      apiAccessToken: "synthetic-access-token",
      apiAccessTokenExpiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      apiOidcIssuer: "http://127.0.0.1:8080/realms/reconai-development",
      apiOidcSubject: subject,
      apiSessionStartedAt: Math.floor(Date.now() / 1_000) - 60,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("forwards bounded preparation and exposes exact package receipt authority as no-store headers", async () => {
    const document = {
      schemaVersion: 1,
      packageId,
      preparedAt,
      purpose: "merchant_review_for_shopify_customers_data_request",
      scope: {
        completeWithinDeclaredScope: true,
        limitations: ["Merchant review and controlled delivery remain required."],
      },
      request: { topic: "customers/data_request" },
      records: [],
    };
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(document), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-reconai-privacy-package-id": packageId,
            "x-reconai-privacy-package-receipt-token": receiptToken,
            "x-reconai-privacy-package-receipt-expires-at": receiptExpiresAt,
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      privacyRequest({
        requestId,
        confirmed: true,
        reason: "Prepare evidence for controlled merchant review",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("x-reconai-privacy-package-id")).toBe(packageId);
    expect(response.headers.get("x-reconai-privacy-package-receipt-token")).toBe(receiptToken);
    expect(response.headers.get("x-reconai-privacy-package-receipt-expires-at")).toBe(
      receiptExpiresAt,
    );
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}/provider-privacy-requests/${requestId}/data-package`,
    );
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
    expect(init && typeof init.body === "string" ? JSON.parse(init.body) : undefined).toEqual({
      confirmed: true,
      reason: "Prepare evidence for controlled merchant review",
    });
  });

  it("forwards only the digest-authority bearer token and validates the receipt identity", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          data: {
            packageId,
            status: "acknowledged",
            preparedAt,
            receiptExpiresAt,
            receivedAt: "2026-07-29T03:05:00.000Z",
          },
          meta: { correlationId },
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      privacyRequest({
        action: "acknowledge_browser_receipt",
        requestId,
        packageId,
        receiptToken,
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      data: { packageId, status: "acknowledged" },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}/provider-privacy-requests/${requestId}/data-package/${packageId}/receipt`,
    );
    expect(init && typeof init.body === "string" ? JSON.parse(init.body) : undefined).toEqual({
      receiptToken,
    });
  });

  it("allowlists receipt errors and replaces internal diagnostics with a fixed message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json(
          {
            code: "PRIVACY_DATA_PACKAGE_RECEIPT_EXPIRED",
            message: "internal receipt digest and storage diagnostics",
            correlationId,
          },
          { status: 410 },
        ),
      ),
    );

    const response = await POST(
      privacyRequest({
        action: "acknowledge_browser_receipt",
        requestId,
        packageId,
        receiptToken,
      }),
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      code: "PRIVACY_DATA_PACKAGE_RECEIPT_EXPIRED",
      message: "The privacy evidence package receipt expired. Prepare a new package.",
      correlationId,
    });
  });

  it("rejects cross-site requests and fails closed on malformed upstream authority", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            packageId,
            preparedAt,
            purpose: "merchant_review_for_shopify_customers_data_request",
            scope: { completeWithinDeclaredScope: true, limitations: ["Bounded scope."] },
            request: { topic: "customers/data_request" },
            records: [],
          }),
          {
            headers: {
              "content-type": "application/json",
              "x-reconai-privacy-package-id": packageId,
            },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const crossSite = await POST(
      privacyRequest(
        {
          requestId,
          confirmed: true,
          reason: "Attempt cross-site package preparation",
        },
        "https://attacker.example.test",
      ),
    );
    expect(crossSite.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();

    const malformed = await POST(
      privacyRequest({
        requestId,
        confirmed: true,
        reason: "Prepare evidence for controlled merchant review",
      }),
    );
    expect(malformed.status).toBe(502);
    expect(await malformed.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });
});

function privacyRequest(body: unknown, origin = "http://localhost:3000"): NextRequest {
  const context = issueOrganizationContext(organizationId, subject, secret);
  return new NextRequest("http://localhost:3000/api/recon/exports/privacy-data-package", {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": origin === "http://localhost:3000" ? "same-origin" : "cross-site",
      "content-type": "application/json",
      cookie: `${organizationContextCookieName()}=${context}`,
    },
    body: JSON.stringify(body),
  });
}

function requestUrl(value: RequestInfo | URL | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.href;
  return value?.url;
}
