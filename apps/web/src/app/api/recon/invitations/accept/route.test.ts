import { getToken } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  organizationContextCookieName,
  verifyOrganizationContext,
} from "../../../../../organization-context";
import { POST } from "./route";

vi.mock("next-auth/jwt", () => ({ getToken: vi.fn() }));

const organizationId = "00000000-0000-4000-8000-000000000001";
const invitationId = "00000000-0000-4000-8000-000000000002";
const membershipId = "00000000-0000-4000-8000-000000000003";
const userId = "00000000-0000-4000-8000-000000000004";
const correlationId = "00000000-0000-4000-8000-000000000005";
const subject = "synthetic-invited-reviewer";
const secret = "development-only-session-secret-change-me";
const acceptToken = "A".repeat(43);

describe("invitation acceptance BFF", { concurrent: false }, () => {
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

  it("sets a subject-bound organization context only after validated acceptance", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          data: {
            organizationId,
            invitationId,
            membershipId,
            userId,
            role: "auditor",
          },
          meta: { correlationId },
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(acceptanceRequest());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      data: {
        organizationId,
        invitationId,
        membershipId,
        userId,
        role: "auditor",
      },
      meta: { correlationId },
    });
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain(`${organizationContextCookieName()}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Max-Age=28800");
    const cookieValue = setCookie?.match(/^[^=]+=([^;]+)/u)?.[1];
    expect(verifyOrganizationContext(cookieValue, subject, secret)).toBe(organizationId);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe("http://127.0.0.1:4000/v1/invitations/accept");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-access-token");
    expect(new Headers(init?.headers).get("cookie")).toBeNull();
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
    const requestBody = init?.body;
    if (typeof requestBody !== "string") throw new Error("expected a JSON request body");
    expect(JSON.parse(requestBody)).toEqual({ token: acceptToken });
  });

  it("does not issue context for rejected or malformed upstream acceptance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json(
          {
            code: "RESOURCE_NOT_FOUND",
            message: "internal invitation lookup details",
            correlationId,
          },
          { status: 404 },
        ),
      ),
    );
    const rejected = await POST(acceptanceRequest());
    expect(rejected.status).toBe(404);
    await expect(rejected.json()).resolves.toEqual({
      code: "RESOURCE_NOT_FOUND",
      message: "The invitation is invalid or unavailable.",
      correlationId,
    });
    expect(rejected.headers.get("set-cookie")).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json(
          {
            data: {
              organizationId: "not-a-uuid",
              invitationId,
              membershipId,
              userId,
              role: "auditor",
            },
            meta: { correlationId },
          },
          { status: 201 },
        ),
      ),
    );
    const malformed = await POST(acceptanceRequest());
    expect(malformed.status).toBe(502);
    await expect(malformed.json()).resolves.toEqual({ code: "UPSTREAM_INVALID_RESPONSE" });
    expect(malformed.headers.get("set-cookie")).toBeNull();
  });

  it("does not issue context for oversized or invalid UTF-8 success bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                organizationId,
                invitationId,
                membershipId,
                userId,
                role: "auditor",
              },
              meta: { correlationId },
            }),
            {
              status: 201,
              headers: {
                "content-type": "application/json",
                "content-length": String(64 * 1024 + 1),
              },
            },
          ),
      ),
    );
    const oversized = await POST(acceptanceRequest());
    expect(oversized.status).toBe(502);
    await expect(oversized.json()).resolves.toEqual({
      code: "UPSTREAM_UNAVAILABLE",
      message: "The invitation service is unavailable.",
    });
    expect(oversized.headers.get("set-cookie")).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(new Uint8Array([0xff]), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const invalidUtf8 = await POST(acceptanceRequest());
    expect(invalidUtf8.status).toBe(502);
    await expect(invalidUtf8.json()).resolves.toEqual({
      code: "UPSTREAM_UNAVAILABLE",
      message: "The invitation service is unavailable.",
    });
    expect(invalidUtf8.headers.get("set-cookie")).toBeNull();
  });

  it("rejects cross-site, subjectless, expired, and malformed requests before the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const crossSite = await POST(acceptanceRequest("https://attacker.example.test"));
    expect(crossSite.status).toBe(403);
    expect(getToken).not.toHaveBeenCalled();

    vi.mocked(getToken).mockResolvedValue({
      apiAccessToken: "subjectless-access-token",
      apiAccessTokenExpiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    });
    const subjectless = await POST(acceptanceRequest());
    expect(subjectless.status).toBe(401);

    vi.mocked(getToken).mockResolvedValue({
      sub: subject,
      apiAccessToken: "expired-access-token",
      apiAccessTokenExpiresAt: Math.floor(Date.now() / 1_000) - 1,
      apiOidcIssuer: "http://127.0.0.1:8080/realms/reconai-development",
      apiOidcSubject: subject,
      apiSessionStartedAt: Math.floor(Date.now() / 1_000) - 60,
    });
    const expired = await POST(acceptanceRequest());
    expect(expired.status).toBe(401);

    vi.mocked(getToken).mockResolvedValue({
      sub: subject,
      apiAccessToken: "synthetic-access-token",
      apiAccessTokenExpiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      apiOidcIssuer: "http://127.0.0.1:8080/realms/reconai-development",
      apiOidcSubject: subject,
      apiSessionStartedAt: Math.floor(Date.now() / 1_000) - 60,
    });
    const malformed = await POST(acceptanceRequest("http://localhost:3000", "short"));
    expect(malformed.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function acceptanceRequest(origin = "http://localhost:3000", token = acceptToken): NextRequest {
  return new NextRequest("http://localhost:3000/api/recon/invitations/accept", {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": origin === "http://localhost:3000" ? "same-origin" : "cross-site",
      "content-type": "application/json",
    },
    body: JSON.stringify({ token }),
  });
}

function requestUrl(value: string | URL | Request | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  return value?.url;
}
