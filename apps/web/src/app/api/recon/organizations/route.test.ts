import { getToken } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  organizationContextCookieName,
  verifyOrganizationContext,
} from "../../../../organization-context";
import { POST } from "./route";

vi.mock("next-auth/jwt", () => ({ getToken: vi.fn() }));

const organizationId = "00000000-0000-4000-8000-000000000001";
const membershipId = "00000000-0000-4000-8000-000000000002";
const correlationId = "00000000-0000-4000-8000-000000000003";
const idempotencyKey = "00000000-0000-4000-8000-000000000004";
const subject = "synthetic-bootstrap-owner";
const secret = "development-only-session-secret-change-me";

describe("organization bootstrap BFF", { concurrent: false }, () => {
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

  it("creates the first organization and issues a protected selected-context cookie", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          data: {
            id: organizationId,
            name: "Bootstrap Tenant",
            businessTimeZone: "Asia/Manila",
            membershipId,
            role: "owner",
          },
          meta: { correlationId, replayed: false },
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(bootstrapRequest());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      data: { id: organizationId, name: "Bootstrap Tenant", role: "owner" },
      meta: { replayed: false },
    });
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain(`${organizationContextCookieName()}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
    const cookieValue = setCookie?.match(/^[^=]+=([^;]+)/u)?.[1];
    expect(verifyOrganizationContext(cookieValue, subject, secret)).toBe(organizationId);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe("http://127.0.0.1:4000/v1/organizations");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-access-token");
    expect(new Headers(init?.headers).get("cookie")).toBeNull();
    const requestBody = init?.body;
    if (typeof requestBody !== "string") throw new Error("expected a JSON request body");
    expect(JSON.parse(requestBody)).toEqual({
      name: "Bootstrap Tenant",
      businessTimeZone: "Asia/Manila",
      idempotencyKey,
    });
  });

  it("returns an exact upstream replay as 200 while selecting the same organization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({
          data: {
            id: organizationId,
            name: "Bootstrap Tenant",
            businessTimeZone: "Asia/Manila",
            membershipId,
            role: "owner",
          },
          meta: { correlationId, replayed: true },
        }),
      ),
    );

    const response = await POST(bootstrapRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { id: organizationId, membershipId, role: "owner" },
      meta: { replayed: true },
    });
    const cookieValue = response.headers.get("set-cookie")?.match(/^[^=]+=([^;]+)/u)?.[1];
    expect(verifyOrganizationContext(cookieValue, subject, secret)).toBe(organizationId);
  });

  it("rejects cross-site and malformed creation before contacting the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const crossSite = await POST(bootstrapRequest("https://attacker.example.test"));
    expect(crossSite.status).toBe(403);
    expect(getToken).not.toHaveBeenCalled();

    const malformed = await POST(
      new NextRequest("http://localhost:3000/api/recon/organizations", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Bootstrap Tenant",
          businessTimeZone: "Not/A_Time_Zone",
          idempotencyKey,
        }),
      }),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ code: "INVALID_ORGANIZATION_BOOTSTRAP" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("contains an ineligible identity response without issuing a cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({ code: "ORGANIZATION_BOOTSTRAP_NOT_AVAILABLE" }, { status: 409 }),
      ),
    );

    const response = await POST(bootstrapRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "ORGANIZATION_BOOTSTRAP_NOT_AVAILABLE" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

function bootstrapRequest(origin = "http://localhost:3000"): NextRequest {
  return new NextRequest("http://localhost:3000/api/recon/organizations", {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": origin === "http://localhost:3000" ? "same-origin" : "cross-site",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: " Bootstrap Tenant ",
      businessTimeZone: "Asia/Manila",
      idempotencyKey,
    }),
  });
}

function requestUrl(value: string | URL | Request | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  return value?.url;
}
