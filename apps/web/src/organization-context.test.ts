import { describe, expect, it, vi } from "vitest";

import {
  createAuthorizedOrganization,
  fetchAuthorizedOrganizationPage,
  fetchAuthorizedOrganizations,
  issueOrganizationContext,
  OrganizationDirectoryError,
  verifyOrganizationContext,
} from "./organization-context";

const organizationId = "00000000-0000-4000-8000-000000000001";
const subject = "provider-user-1";
const secret = "development-only-session-secret-change-me";

describe("organization context", () => {
  it("issues a subject-bound selection and rejects tampering or replay by another subject", () => {
    const cookie = issueOrganizationContext(organizationId, subject, secret);

    expect(verifyOrganizationContext(cookie, subject, secret)).toBe(organizationId);
    expect(verifyOrganizationContext(cookie, "provider-user-2", secret)).toBeUndefined();
    expect(
      verifyOrganizationContext(
        cookie.replace(organizationId, "00000000-0000-4000-8000-000000000002"),
        subject,
        secret,
      ),
    ).toBeUndefined();
    expect(verifyOrganizationContext(`${cookie}.extra`, subject, secret)).toBeUndefined();
  });

  it("loads a bounded strict organization directory without forwarding browser credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: [
          {
            id: organizationId,
            name: "Synthetic Organization",
            membershipId: "00000000-0000-4000-8000-000000000003",
            role: "analyst",
          },
        ],
        meta: {
          correlationId: "00000000-0000-4000-8000-000000000004",
          truncated: false,
          maximumItems: 100,
        },
      }),
    );

    await expect(
      fetchAuthorizedOrganizations("server-only-access-token", {
        fetch: fetchMock,
        apiOrigin: "https://api.example.test",
      }),
    ).resolves.toMatchObject({
      data: [{ id: organizationId, name: "Synthetic Organization" }],
      meta: { truncated: false, maximumItems: 100 },
    });

    const [url, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.example.test/v1/organizations");
    expect(request).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
  });

  it("forwards bounded search pagination and rejects conflicting exact lookups locally", async () => {
    const cursor = "eyJ2IjoxLCJzIjoiTm9ydGgiLCJuIjoibm9ydGgiLCJpIjoiY3Vyc29yIn0";
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: [],
        meta: {
          correlationId: "00000000-0000-4000-8000-000000000004",
          truncated: false,
          maximumItems: 100,
        },
      }),
    );

    await expect(
      fetchAuthorizedOrganizationPage(
        "server-only-access-token",
        { limit: 50, search: "North & South", cursor },
        { fetch: fetchMock, apiOrigin: "https://api.example.test" },
      ),
    ).resolves.toMatchObject({ data: [] });

    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      `https://api.example.test/v1/organizations?limit=50&search=North+%26+South&cursor=${cursor}`,
    );

    await expect(
      fetchAuthorizedOrganizationPage(
        "server-only-access-token",
        { organizationId, search: "North" },
        { fetch: fetchMock, apiOrigin: "https://api.example.test" },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("creates an organization through a fixed credential-contained API request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        {
          data: {
            id: organizationId,
            name: "Bootstrap Tenant",
            businessTimeZone: "Asia/Manila",
            membershipId: "00000000-0000-4000-8000-000000000003",
            role: "owner",
          },
          meta: {
            correlationId: "00000000-0000-4000-8000-000000000004",
            replayed: false,
          },
        },
        { status: 201 },
      ),
    );
    const input = {
      name: " Bootstrap Tenant ",
      businessTimeZone: "Asia/Manila",
      idempotencyKey: "00000000-0000-4000-8000-000000000005",
    };

    await expect(
      createAuthorizedOrganization("server-only-access-token", input, {
        fetch: fetchMock,
        apiOrigin: "https://api.example.test",
      }),
    ).resolves.toMatchObject({ data: { id: organizationId, role: "owner" } });

    const [url, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.example.test/v1/organizations");
    expect(request).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    expect(new Headers(request.headers).get("cookie")).toBeNull();
    const requestBody = request.body;
    if (typeof requestBody !== "string") throw new Error("expected a JSON request body");
    expect(JSON.parse(requestBody)).toEqual({
      name: "Bootstrap Tenant",
      businessTimeZone: "Asia/Manila",
      idempotencyKey: input.idempotencyKey,
    });

    await expect(
      createAuthorizedOrganization(
        "server-only-access-token",
        { ...input, businessTimeZone: "Not/A_Time_Zone" },
        { fetch: fetchMock, apiOrigin: "https://api.example.test" },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed and oversized upstream directories", async () => {
    const malformedFetch = vi.fn().mockResolvedValue(
      Response.json({
        data: [{ id: organizationId, name: "Missing membership and role" }],
        meta: {
          correlationId: "00000000-0000-4000-8000-000000000004",
          truncated: false,
          maximumItems: 100,
        },
      }),
    );
    await expect(
      fetchAuthorizedOrganizations("server-only-access-token", {
        fetch: malformedFetch,
        apiOrigin: "https://api.example.test",
      }),
    ).rejects.toBeInstanceOf(OrganizationDirectoryError);

    const oversizedFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ padding: "x".repeat(70_000) }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      fetchAuthorizedOrganizations("server-only-access-token", {
        fetch: oversizedFetch,
        apiOrigin: "https://api.example.test",
      }),
    ).rejects.toBeInstanceOf(OrganizationDirectoryError);
  });
});
