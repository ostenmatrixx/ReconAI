import { createHash } from "node:crypto";

import { getToken } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  issueOrganizationContext,
  organizationContextCookieName,
} from "../../../../../../organization-context";
import {
  issueProviderAuthorizationCookie,
  providerAuthorizationCookieName,
} from "../../../../../../provider-authorization-cookie";
import { GET } from "./route";

vi.mock("next-auth/jwt", () => ({ getToken: vi.fn() }));

const organizationId = "00000000-0000-4000-8000-000000000081";
const attemptId = "00000000-0000-4000-8000-000000000082";
const connectionId = "00000000-0000-4000-8000-000000000083";
const subject = "synthetic-provider-administrator";
const secret = "development-only-session-secret-change-me";
const state = "B".repeat(43);

describe("provider authorization callback BFF", { concurrent: false }, () => {
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

  it("forwards a state-bound code only server-to-server and clears the one-time cookie", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          data: {
            attemptId,
            connectionId,
            provider: "stripe",
            status: "succeeded",
            replayed: false,
            externalAccountId: "acct_synthetic",
          },
          meta: { correlationId: "00000000-0000-4000-8000-000000000084" },
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(callbackRequest(state), {
      params: Promise.resolve({ provider: "stripe" }),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/dashboard/connectors?authorization=success",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.cookies.get(providerAuthorizationCookieName())).toMatchObject({
      value: "",
      maxAge: 0,
      path: "/",
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}/provider-authorizations/${attemptId}/callback`,
    );
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
    const body =
      init && typeof init.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    expect(body).toEqual({
      provider: "stripe",
      query: [
        ["code", "synthetic-authorization-code"],
        ["state", state],
      ],
    });
  });

  it("rejects a state mismatch before forwarding the authorization code", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(callbackRequest("C".repeat(43)), {
      params: Promise.resolve({ provider: "stripe" }),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/dashboard/connectors?authorization=error",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.cookies.get(providerAuthorizationCookieName())?.maxAge).toBe(0);
  });
});

function callbackRequest(callbackState: string): NextRequest {
  const organizationContext = issueOrganizationContext(organizationId, subject, secret);
  const providerContext = issueProviderAuthorizationCookie(
    {
      attemptId,
      organizationId,
      provider: "stripe",
      stateSha256: createHash("sha256").update(state, "ascii").digest("hex"),
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    },
    subject,
    secret,
  );
  const url = new URL("http://localhost:3000/api/recon/provider-authorizations/callback/stripe");
  url.searchParams.append("code", "synthetic-authorization-code");
  url.searchParams.append("state", callbackState);
  return new NextRequest(url, {
    headers: {
      cookie: [
        `${organizationContextCookieName()}=${organizationContext}`,
        `${providerAuthorizationCookieName()}=${providerContext}`,
      ].join("; "),
    },
  });
}

function requestUrl(value: RequestInfo | URL | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.href;
  return value?.url;
}
