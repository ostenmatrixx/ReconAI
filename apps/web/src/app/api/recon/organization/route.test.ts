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
const otherOrganizationId = "00000000-0000-4000-8000-000000000002";
const membershipId = "00000000-0000-4000-8000-000000000003";
const correlationId = "00000000-0000-4000-8000-000000000004";
const subject = "synthetic-operator";
const secret = "development-only-session-secret-change-me";

describe("organization selection BFF", { concurrent: false }, () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WEB_ORIGIN", "http://localhost:3000");
    vi.stubEnv("API_ORIGIN", "http://127.0.0.1:4000");
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

  it("issues a protected subject-bound cookie only for an identity-authorized organization", async () => {
    const fetchMock = directoryFetch([organizationId]);
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(selectionRequest(organizationId));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { id: organizationId, membershipId, role: "analyst" },
    });
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain(`${organizationContextCookieName()}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Max-Age=28800");
    const cookieValue = setCookie?.match(/^[^=]+=([^;]+)/u)?.[1];
    expect(verifyOrganizationContext(cookieValue, subject, secret)).toBe(organizationId);
    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://127.0.0.1:4000/v1/organizations?limit=1&organizationId=${organizationId}`,
    );
  });

  it("does not issue a cookie for an organization outside the verified identity directory", async () => {
    vi.stubGlobal("fetch", directoryFetch([otherOrganizationId]));

    const response = await POST(selectionRequest(organizationId));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "ORGANIZATION_NOT_FOUND" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects cross-site and expired-session requests before contacting the directory", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const crossSite = await POST(selectionRequest(organizationId, "https://attacker.example.test"));
    expect(crossSite.status).toBe(403);
    expect(getToken).not.toHaveBeenCalled();

    vi.mocked(getToken).mockResolvedValue({
      sub: subject,
      apiAccessToken: "expired-access-token",
      apiAccessTokenExpiresAt: Math.floor(Date.now() / 1_000) - 1,
      apiOidcIssuer: "http://127.0.0.1:8080/realms/reconai-development",
      apiOidcSubject: subject,
      apiSessionStartedAt: Math.floor(Date.now() / 1_000) - 60,
    });
    const expired = await POST(selectionRequest(organizationId));
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ code: "SESSION_REAUTHENTICATION_REQUIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function selectionRequest(
  selectedOrganizationId: string,
  origin = "http://localhost:3000",
): NextRequest {
  return new NextRequest("http://localhost:3000/api/recon/organization", {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": origin === "http://localhost:3000" ? "same-origin" : "cross-site",
      "content-type": "application/json",
    },
    body: JSON.stringify({ organizationId: selectedOrganizationId }),
  });
}

function directoryFetch(organizationIds: readonly string[]) {
  return vi.fn<typeof fetch>(async () =>
    Response.json({
      data: organizationIds.map((id, index) => ({
        id,
        name: `Synthetic Organization ${String(index + 1)}`,
        membershipId,
        role: "analyst",
      })),
      meta: { correlationId, truncated: false, maximumItems: 100 },
    }),
  );
}

function requestUrl(value: string | URL | Request | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  return value?.url;
}
