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
const exportId = "00000000-0000-4000-8000-000000000050";
const csv = '\uFEFF"exception_id","type"\r\n"example","manual_review_required"\r\n';
const subject = "synthetic-operator";
const secret = "development-only-session-secret-change-me";

describe("exception export BFF", { concurrent: false }, () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WEB_ORIGIN", "http://localhost:3000");
    vi.stubEnv("API_ORIGIN", "http://127.0.0.1:4000");
    vi.mocked(getToken).mockResolvedValue({
      sub: subject,
      apiAccessToken: "synthetic-access-token",
      apiAccessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3_600,
      apiOidcIssuer: "http://127.0.0.1:8080/realms/reconai-development",
      apiOidcSubject: subject,
      apiSessionStartedAt: Math.floor(Date.now() / 1000) - 60,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("buffers and verifies the CSV before returning fixed download headers", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-length": Buffer.byteLength(csv, "utf8").toString(),
          "content-disposition": 'attachment; filename="attacker-controlled.csv"',
          "x-reconai-export-id": exportId,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      exportRequest({
        status: "open",
        severity: "high",
        search: "manual review-required",
        source: "shopify",
        amountCurrency: "USD",
        minimumAmountMinor: "200000",
        maximumAmountMinor: "300000",
        confidence: "low",
        assignee: "unassigned",
        age: "under_24h",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="reconai-exception-queue.csv"',
    );
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-reconai-export-id")).toBe(exportId);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    const responseBytes = new Uint8Array(await response.arrayBuffer());
    expect(responseBytes.slice(0, 3)).toEqual(Uint8Array.from([0xef, 0xbb, 0xbf]));
    expect(responseBytes.byteLength).toBe(Buffer.byteLength(csv, "utf8"));
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected an upstream export request");
    const requestedUrl =
      typeof call[0] === "string" ? call[0] : call[0] instanceof URL ? call[0].href : call[0].url;
    expect(requestedUrl).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}/exception-exports`,
    );
    expect(call[1]?.body).toBe(
      JSON.stringify({
        status: "open",
        severity: "high",
        search: "manual review-required",
        source: "shopify",
        amountCurrency: "USD",
        minimumAmountMinor: "200000",
        maximumAmountMinor: "300000",
        confidence: "low",
        assignee: "unassigned",
        age: "under_24h",
      }),
    );
    expect(call[1]).toMatchObject({ credentials: "omit", redirect: "error" });
  });

  it("rejects currency-free and inverted integer amount bounds before API access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const missingCurrency = await POST(exportRequest({ minimumAmountMinor: "1" }));
    const inverted = await POST(
      exportRequest({
        amountCurrency: "USD",
        minimumAmountMinor: "2",
        maximumAmountMinor: "1",
      }),
    );
    const malformed = await POST(
      exportRequest({
        amountCurrency: "USD",
        minimumAmountMinor: "not-an-integer",
        maximumAmountMinor: "1",
      }),
    );

    expect(missingCurrency.status).toBe(400);
    expect(inverted.status).toBe(400);
    expect(malformed.status).toBe(400);
    await expect(missingCurrency.json()).resolves.toEqual({ code: "INVALID_EXPORT_FILTER" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replaces an approved API error message with a fixed browser-safe response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            code: "EXPORT_LIMIT_EXCEEDED",
            message: "repository row count and internal filter diagnostics",
            correlationId: "00000000-0000-4000-8000-000000000091",
          },
          { status: 422 },
        ),
      ),
    );

    const response = await POST(exportRequest({}));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      code: "EXPORT_LIMIT_EXCEEDED",
      message: "The exception export is too large. Narrow the filters and try again.",
      correlationId: "00000000-0000-4000-8000-000000000091",
    });
  });

  it("rejects a cross-site export before reading the session or contacting the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = exportRequest({}, "https://attacker.example.test");

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "CSRF_ORIGIN_REJECTED" });
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed before emitting a download when the upstream payload is oversized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("small", {
          status: 200,
          headers: {
            "content-type": "text/csv",
            "content-length": (6 * 1024 * 1024).toString(),
          },
        });
      }),
    );

    const response = await POST(exportRequest({}));

    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      message: "The exception export could not be prepared.",
    });
  });
});

function exportRequest(
  body: Readonly<Record<string, unknown>>,
  origin = "http://localhost:3000",
): NextRequest {
  return new NextRequest("http://localhost:3000/api/recon/exports/exceptions", {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": origin === "http://localhost:3000" ? "same-origin" : "cross-site",
      "content-type": "application/json",
      cookie: `${organizationContextCookieName()}=${issueOrganizationContext(
        organizationId,
        subject,
        secret,
      )}`,
    },
    body: JSON.stringify(body),
  });
}
