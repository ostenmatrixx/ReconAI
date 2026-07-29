import { getToken } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  issueOrganizationContext,
  organizationContextCookieName,
} from "../../../../organization-context";
import {
  providerAuthorizationCookieName,
  verifyProviderAuthorizationCookie,
} from "../../../../provider-authorization-cookie";
import { POST } from "./route";

vi.mock("next-auth/jwt", () => ({ getToken: vi.fn() }));

const organizationId = "00000000-0000-4000-8000-000000000071";
const attemptId = "00000000-0000-4000-8000-000000000072";
const connectionId = "00000000-0000-4000-8000-000000000073";
const subject = "synthetic-provider-administrator";
const secret = "development-only-session-secret-change-me";
const state = "A".repeat(43);

describe("provider authorization start BFF", { concurrent: false }, () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WEB_ORIGIN", "http://localhost:3000");
    vi.stubEnv("API_ORIGIN", "http://127.0.0.1:4000");
    vi.stubEnv("SESSION_SECRET", secret);
    vi.mocked(getToken).mockResolvedValue({
      sub: subject,
      apiAccessToken: "synthetic-access-token",
      apiAccessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
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

  it("starts through the API, signs an HttpOnly transaction, and redirects to a fixed provider", async () => {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          data: {
            attemptId,
            connectionId,
            provider: "stripe",
            authorizationUrl: `https://marketplace.stripe.com/oauth/v2/authorize?client_id=stripe-client-id&state=${state}`,
            expiresAt,
          },
          meta: { correlationId: "00000000-0000-4000-8000-000000000074" },
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(startRequest("provider=stripe"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain(
      "https://marketplace.stripe.com/oauth/v2/authorize",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const transactionCookie = response.cookies.get(providerAuthorizationCookieName());
    expect(transactionCookie).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    expect(
      verifyProviderAuthorizationCookie(transactionCookie?.value, subject, secret),
    ).toMatchObject({
      attemptId,
      organizationId,
      provider: "stripe",
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}/provider-authorizations`,
    );
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
    expect(init && typeof init.body === "string" ? JSON.parse(init.body) : undefined).toEqual({
      provider: "stripe",
    });
  });

  it("rejects cross-site and duplicate form fields before contacting the API", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const crossSite = await POST(startRequest("provider=stripe", "https://attacker.example.test"));
    expect(crossSite.status).toBe(403);
    const duplicate = await POST(startRequest("provider=stripe&provider=shopify"));
    expect(duplicate.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an upstream open redirect and emits no transaction cookie", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          data: {
            attemptId,
            connectionId,
            provider: "stripe",
            authorizationUrl: `https://attacker.example.test/oauth?state=${state}`,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          },
          meta: { correlationId: "00000000-0000-4000-8000-000000000075" },
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(startRequest("provider=stripe"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/dashboard/connectors?authorization=error",
    );
    expect(response.cookies.get(providerAuthorizationCookieName())).toBeUndefined();
  });
});

function startRequest(body: string, origin = "http://localhost:3000"): NextRequest {
  const context = issueOrganizationContext(organizationId, subject, secret);
  return new NextRequest("http://localhost:3000/api/recon/provider-authorizations", {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": origin === "http://localhost:3000" ? "same-origin" : "cross-site",
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${organizationContextCookieName()}=${context}`,
    },
    body,
  });
}

function requestUrl(value: RequestInfo | URL | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.href;
  return value?.url;
}
