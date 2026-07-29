import { getToken } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";

vi.mock("next-auth/jwt", () => ({ getToken: vi.fn() }));

const organizationId = "00000000-0000-4000-8000-000000000001";
const grantId = "00000000-0000-4000-8000-000000000002";

describe("restricted support BFF", { concurrent: false }, () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WEB_ORIGIN", "http://localhost:3000");
    vi.stubEnv("API_ORIGIN", "http://127.0.0.1:4000");
    vi.mocked(getToken).mockResolvedValue({
      sub: "synthetic-support-operator",
      apiAccessToken: "synthetic-support-access-token",
      apiAccessTokenExpiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      apiOidcIssuer: "http://127.0.0.1:8080/realms/reconai-development",
      apiOidcSubject: "synthetic-support-operator",
      apiSessionStartedAt: Math.floor(Date.now() / 1_000) - 60,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("creates an organization-blind request without forwarding browser cookies", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          data: {
            requestCode: "a".repeat(43),
            requestExpiresAt: "2026-07-29T11:00:00.000Z",
          },
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      supportActionRequest({
        action: "create_request",
        requestedDurationMinutes: 30,
      }),
    );

    expect(response.status).toBe(201);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe("http://127.0.0.1:4000/v1/support/access-requests");
    expect(init).toMatchObject({
      method: "POST",
      body: '{"requestedDurationMinutes":30}',
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer synthetic-support-access-token");
    expect(headers.get("cookie")).toBeNull();
  });

  it("rejects cross-site, malformed, and unauthenticated request creation locally", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const crossSite = await POST(
      supportActionRequest(
        { action: "create_request", requestedDurationMinutes: 30 },
        "https://attacker.example.test",
      ),
    );
    expect(crossSite.status).toBe(403);

    const malformed = await POST(
      supportActionRequest({
        action: "create_request",
        requestedDurationMinutes: 61,
        organizationId,
      }),
    );
    expect(malformed.status).toBe(400);

    vi.mocked(getToken).mockResolvedValue(null);
    const unauthenticated = await POST(
      supportActionRequest({ action: "create_request", requestedDurationMinutes: 30 }),
    );
    expect(unauthenticated.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads one exact organization and grant without a tenant cookie or directory call", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        data: {
          schemaVersion: "support-diagnostics-v1",
          generatedAt: "2026-07-29T11:00:00.000Z",
          grantExpiresAt: "2026-07-29T11:30:00.000Z",
          countsCapped: false,
          connections: { total: 2, nonHealthy: 1 },
          providerSyncs: { active: 1, failed: 0 },
          reconciliations: { active: 1, failedOrPartial: 0 },
          exceptions: { unresolved: 3 },
          outbox: { unpublished: 0, deadLettered: 0 },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new NextRequest(
        `http://localhost:3000/api/recon/support?organizationId=${organizationId}&grantId=${grantId}`,
        { headers: { cookie: "reconai.organization-context=must-not-be-forwarded" } },
      ),
    );

    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe(
      `http://127.0.0.1:4000/v1/support/organizations/${organizationId}/diagnostics?grantId=${grantId}`,
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(init).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    await expect(response.json()).resolves.toEqual({
      data: {
        schemaVersion: "support-diagnostics-v1",
        generatedAt: "2026-07-29T11:00:00.000Z",
        grantExpiresAt: "2026-07-29T11:30:00.000Z",
        countsCapped: false,
        connections: { total: 2, nonHealthy: 1 },
        providerSyncs: { active: 1, failed: 0 },
        reconciliations: { active: 1, failedOrPartial: 0 },
        exceptions: { unresolved: 3 },
        outbox: { unpublished: 0, deadLettered: 0 },
      },
    });
  });

  it("rejects malformed authority and expanded or oversized diagnostic JSON", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: {
            schemaVersion: "support-diagnostics-v1",
            generatedAt: "2026-07-29T11:00:00.000Z",
            grantExpiresAt: "2026-07-29T11:30:00.000Z",
            countsCapped: false,
            connections: { total: 2, nonHealthy: 1 },
            providerSyncs: { active: 1, failed: 0 },
            reconciliations: { active: 1, failedOrPartial: 0 },
            exceptions: { unresolved: 3 },
            outbox: { unpublished: 0, deadLettered: 0 },
            customerEmail: "must-not-reach-browser@example.test",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": String(64 * 1024 + 1),
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const malformed = await GET(
      new NextRequest(
        `http://localhost:3000/api/recon/support?organizationId=not-a-uuid&grantId=${grantId}`,
      ),
    );
    expect(malformed.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const expanded = await GET(
      new NextRequest(
        `http://localhost:3000/api/recon/support?organizationId=${organizationId}&grantId=${grantId}`,
      ),
    );
    expect(expanded.status).toBe(502);

    const oversized = await GET(
      new NextRequest(
        `http://localhost:3000/api/recon/support?organizationId=${organizationId}&grantId=${grantId}`,
      ),
    );
    expect(oversized.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("emits only fixed allowlisted support errors and rejects expanded error contracts", async () => {
    const correlationId = "00000000-0000-4000-8000-000000000010";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            code: "RESOURCE_NOT_FOUND",
            message: "support identity and grant diagnostics must remain internal",
            correlationId,
          },
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            code: "RESOURCE_NOT_FOUND",
            message: "resource not found",
            correlationId,
            supportIdentityDigest: "must-not-reach-the-browser",
          },
          { status: 404 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const request = new NextRequest(
      `http://localhost:3000/api/recon/support?organizationId=${organizationId}&grantId=${grantId}`,
    );

    const allowed = await GET(request);
    expect(allowed.status).toBe(404);
    await expect(allowed.json()).resolves.toEqual({
      code: "RESOURCE_NOT_FOUND",
      message: "Restricted support access is unavailable.",
      correlationId,
    });

    const expanded = await GET(request);
    expect(expanded.status).toBe(502);
    const serialized = JSON.stringify(await expanded.json());
    expect(serialized).not.toContain("supportIdentityDigest");
    expect(serialized).not.toContain("must-not-reach-the-browser");
  });

  it("rejects successful support responses with action-inconsistent statuses", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            data: {
              requestCode: "a".repeat(43),
              requestExpiresAt: "2026-07-29T11:00:00.000Z",
            },
          },
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            data: {
              schemaVersion: "support-diagnostics-v1",
              generatedAt: "2026-07-29T11:00:00.000Z",
              grantExpiresAt: "2026-07-29T11:30:00.000Z",
              countsCapped: false,
              connections: { total: 0, nonHealthy: 0 },
              providerSyncs: { active: 0, failed: 0 },
              reconciliations: { active: 0, failedOrPartial: 0 },
              exceptions: { unresolved: 0 },
              outbox: { unpublished: 0, deadLettered: 0 },
            },
          },
          { status: 201 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const creation = await POST(
      supportActionRequest({ action: "create_request", requestedDurationMinutes: 30 }),
    );
    expect(creation.status).toBe(502);

    const diagnostics = await GET(
      new NextRequest(
        `http://localhost:3000/api/recon/support?organizationId=${organizationId}&grantId=${grantId}`,
      ),
    );
    expect(diagnostics.status).toBe(502);
  });
});

function supportActionRequest(body: unknown, origin = "http://localhost:3000"): NextRequest {
  return new NextRequest("http://localhost:3000/api/recon/support", {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": origin === "http://localhost:3000" ? "same-origin" : "cross-site",
      "content-type": "application/json",
      cookie: "reconai.session-token=synthetic-session",
    },
    body: JSON.stringify(body),
  });
}

function requestUrl(value: RequestInfo | URL | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.href;
  return value?.url;
}
