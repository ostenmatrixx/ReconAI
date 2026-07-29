import { getToken } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  issueOrganizationContext,
  organizationContextCookieName,
} from "../../../organization-context";
import { GET } from "./route";

vi.mock("next-auth/jwt", () => ({ getToken: vi.fn() }));

const organizationId = "00000000-0000-4000-8000-000000000001";
const subject = "synthetic-privacy-administrator";
const secret = "development-only-session-secret-change-me";

describe("tenant read BFF", { concurrent: false }, () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
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

  it("routes and minimizes the selected organization profile", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        data: {
          name: "North Operations",
          businessTimeZone: "America/New_York",
          profileVersion: 7,
          updatedAt: "2026-07-30T12:00:00.000Z",
          internalPolicyState: "must-not-reach-the-browser",
        },
        meta: { correlationId: crypto.randomUUID() },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const cookie = issueOrganizationContext(organizationId, subject, secret);

    const response = await GET(
      new NextRequest("http://localhost:3000/api/recon?view=organization_profile", {
        headers: { cookie: `${organizationContextCookieName()}=${cookie}` },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        name: "North Operations",
        businessTimeZone: "America/New_York",
        profileVersion: 7,
        updatedAt: "2026-07-30T12:00:00.000Z",
      },
    });
    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
  });

  it("routes a fixed, bounded privacy request read through signed organization context", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        data: [],
        meta: {
          correlationId: "00000000-0000-4000-8000-000000000010",
          truncated: false,
          maximumItems: 100,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(privacyRequest());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}/provider-privacy-requests?limit=50`,
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer synthetic-access-token");
    expect(headers.get("cookie")).toBeNull();
    expect(init).toMatchObject({ cache: "no-store" });
  });

  it("routes only a fixed-size support grant list through signed organization context", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ data: [], meta: { correlationId: crypto.randomUUID() } }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              id: "00000000-0000-4000-8000-000000000071",
              supportIdentityReference: "abcdef123456",
              capability: "diagnostics:view",
              ticketReference: "SUP-1042",
              reason: "Investigate the synthetic incident",
              approvedAt: "2026-07-29T11:00:00.000Z",
              expiresAt: "2026-07-29T11:30:00.000Z",
              status: "active",
              customerEmail: "must-not-reach-browser@example.test",
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const cookie = issueOrganizationContext(organizationId, subject, secret);

    const response = await GET(
      new NextRequest("http://localhost:3000/api/recon?view=support_access_grants", {
        headers: { cookie: `${organizationContextCookieName()}=${cookie}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}/support-access-grants?limit=50`,
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer synthetic-access-token");
    expect(headers.get("cookie")).toBeNull();

    const expanded = await GET(
      new NextRequest("http://localhost:3000/api/recon?view=support_access_grants", {
        headers: { cookie: `${organizationContextCookieName()}=${cookie}` },
      }),
    );
    expect(expanded.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects missing signed organization context before contacting the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new NextRequest("http://localhost:3000/api/recon?view=privacy_requests"),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "ORGANIZATION_CONTEXT_REQUIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards only a bounded cursor and rejects malformed cursor input", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [], meta: { truncated: false, maximumItems: 100 } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const paged = await GET(privacyRequest("tenant_cursor"));
    expect(paged.status).toBe(200);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}/provider-privacy-requests?limit=50&cursor=tenant_cursor`,
    );

    const invalid = await GET(privacyRequest("tenant_cursor!"));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ code: "INVALID_PRIVACY_REQUEST_CURSOR" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards bounded run evidence and rejects oversized upstream JSON", async () => {
    const runId = "00000000-0000-4000-8000-000000000021";
    const runBody = {
      data: {
        id: runId,
        stableRunKey: "synthetic-stable-run-key",
        status: "succeeded",
        policyVersion: "finance-v1",
        ruleSetVersion: "rules-v1",
        engineVersion: "engine-v1",
        inputCount: 0,
        matchCount: 1,
        exceptionCount: 0,
        errorCount: 0,
        dispatchCount: 1,
        operationalStateApplied: true,
        createdAt: "2026-07-29T10:00:00.000Z",
        inputSnapshotHash: "a".repeat(64),
        policySnapshotHash: "b".repeat(64),
        policySnapshot: { version: "finance-v1" },
        initiatedBy: "00000000-0000-4000-8000-000000000011",
        inputRecords: [],
        inputRecordsTruncated: false,
        matches: [
          {
            id: "00000000-0000-4000-8000-000000000022",
            ruleId: "refund-accounting",
            ruleVersion: "1.0.0",
            recordReferences: [],
            recordReferencesStatus: "available",
            evidence: {
              schemaVersion: "deterministic-evidence-view-v1",
              status: "available",
              ruleId: "refund-accounting",
              ruleVersion: "1.0.0",
              ruleSetVersion: "1.0.0",
              sourceRecordCount: 0,
              evidenceTruncated: false,
              comparisons: [],
              result: "pass",
              reasonCode: "REFUND_ACCOUNTING_ENTRY_MATCHED",
              evaluatedAt: "2026-07-29T10:00:01.000Z",
            },
            evidenceFidelity: "exact_at_observation",
            observedAt: "2026-07-29T10:00:01.000Z",
            encryptedCredentialReference: "must-not-reach-the-browser",
          },
        ],
        matchesTruncated: false,
        exceptions: [],
        exceptionsTruncated: false,
        workerDiagnostic: "must-not-reach-the-browser",
      },
      meta: { correlationId: "00000000-0000-4000-8000-000000000010" },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(runBody))
      .mockResolvedValueOnce(
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": String(5 * 1024 * 1024 + 1),
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const cookie = issueOrganizationContext(organizationId, subject, secret);
    const request = new NextRequest(`http://localhost:3000/api/recon?view=run&id=${runId}`, {
      headers: { cookie: `${organizationContextCookieName()}=${cookie}` },
    });

    const response = await GET(request);

    expect(response.status).toBe(200);
    const clientBody: unknown = await response.json();
    expect(clientBody).toMatchObject({
      data: {
        id: runId,
        status: "succeeded",
        matches: [
          {
            ruleId: "refund-accounting",
            evidence: { reasonCode: "REFUND_ACCOUNTING_ENTRY_MATCHED" },
          },
        ],
        exceptions: [],
      },
    });
    expect(JSON.stringify(clientBody)).not.toContain("encryptedCredentialReference");
    expect(JSON.stringify(clientBody)).not.toContain("workerDiagnostic");
    expect(clientBody).not.toHaveProperty("meta");
    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}/reconciliation-runs/${runId}`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });

    const oversized = await GET(request);
    expect(oversized.status).toBe(502);
    await expect(oversized.json()).resolves.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("forwards only fixed-size run-artifact pages and validates cursor/type locally", async () => {
    const runId = "00000000-0000-4000-8000-000000000021";
    const cursor = "tenant_artifact_cursor";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        data: { type: "match", items: [] },
        meta: { nextCursor: "next_tenant_artifact_cursor" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const cookie = issueOrganizationContext(organizationId, subject, secret);
    const valid = new NextRequest(
      `http://localhost:3000/api/recon?view=run_artifacts&id=${runId}&type=match&cursor=${cursor}`,
      { headers: { cookie: `${organizationContextCookieName()}=${cookie}` } },
    );

    const response = await GET(valid);

    expect(response.status).toBe(200);
    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}/reconciliation-runs/${runId}/artifacts?type=match&limit=25&cursor=${cursor}`,
    );

    const invalidType = await GET(
      new NextRequest(`http://localhost:3000/api/recon?view=run_artifacts&id=${runId}&type=all`, {
        headers: { cookie: `${organizationContextCookieName()}=${cookie}` },
      }),
    );
    expect(invalidType.status).toBe(400);
    await expect(invalidType.json()).resolves.toEqual({
      code: "INVALID_RUN_ARTIFACT_QUERY",
    });
    const invalidCursor = await GET(
      new NextRequest(
        `http://localhost:3000/api/recon?view=run_artifacts&id=${runId}&type=exception&cursor=not%2Bbase64`,
        { headers: { cookie: `${organizationContextCookieName()}=${cookie}` } },
      ),
    );
    expect(invalidCursor.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards only fixed-size pinned-input pages and validates the cursor locally", async () => {
    const runId = "00000000-0000-4000-8000-000000000021";
    const cursor = "tenant_input_cursor";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        data: [],
        meta: { nextCursor: "next_tenant_input_cursor" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const cookie = issueOrganizationContext(organizationId, subject, secret);
    const valid = new NextRequest(
      `http://localhost:3000/api/recon?view=run_inputs&id=${runId}&cursor=${cursor}`,
      { headers: { cookie: `${organizationContextCookieName()}=${cookie}` } },
    );

    const response = await GET(valid);

    expect(response.status).toBe(200);
    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}/reconciliation-runs/${runId}/inputs?limit=100&cursor=${cursor}`,
    );

    const invalidCursor = await GET(
      new NextRequest(
        `http://localhost:3000/api/recon?view=run_inputs&id=${runId}&cursor=not%2Bbase64`,
        { headers: { cookie: `${organizationContextCookieName()}=${cookie}` } },
      ),
    );
    expect(invalidCursor.status).toBe(400);
    await expect(invalidCursor.json()).resolves.toEqual({
      code: "INVALID_RUN_INPUT_CURSOR",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards bounded queue filters and rejects invalid amount authority locally", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        data: [],
        meta: {
          correlationId: crypto.randomUUID(),
          filteredCount: 0,
          canExport: true,
          summary: { open: 0, high: 0, awaitingApproval: 0, decided: 0 },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const cookie = issueOrganizationContext(organizationId, subject, secret);
    const request = new NextRequest(
      "http://localhost:3000/api/recon?view=summary&status=open&severity=high" +
        "&search=payment_without_order&source=stripe&amountCurrency=USD" +
        "&minimumAmountMinor=10000&maximumAmountMinor=20000&confidence=high" +
        "&assignee=unassigned&age=one_to_seven_days&cursor=tenant_cursor",
      { headers: { cookie: `${organizationContextCookieName()}=${cookie}` } },
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}/exceptions?` +
        "limit=50&status=open&severity=high&search=payment_without_order&source=stripe" +
        "&amountCurrency=USD&minimumAmountMinor=10000&maximumAmountMinor=20000" +
        "&confidence=high&assignee=unassigned&age=one_to_seven_days&cursor=tenant_cursor",
    );

    const invalid = await GET(
      new NextRequest("http://localhost:3000/api/recon?view=summary&minimumAmountMinor=10000", {
        headers: { cookie: `${organizationContextCookieName()}=${cookie}` },
      }),
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ code: "INVALID_QUEUE_FILTER" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("emits only fixed allowlisted read errors and rejects expanded error contracts", async () => {
    const correlationId = "00000000-0000-4000-8000-000000000010";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            code: "RESOURCE_NOT_FOUND",
            message: "postgres table and tenant diagnostics must remain internal",
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
            accessToken: "must-not-reach-the-browser",
          },
          { status: 404 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const cookie = issueOrganizationContext(organizationId, subject, secret);
    const request = new NextRequest(
      "http://localhost:3000/api/recon?view=exception&id=00000000-0000-4000-8000-000000000021",
      { headers: { cookie: `${organizationContextCookieName()}=${cookie}` } },
    );

    const allowed = await GET(request);
    expect(allowed.status).toBe(404);
    await expect(allowed.json()).resolves.toEqual({
      code: "RESOURCE_NOT_FOUND",
      message: "The requested information is unavailable.",
      correlationId,
    });

    const expanded = await GET(request);
    expect(expanded.status).toBe(502);
    const serialized = JSON.stringify(await expanded.json());
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("must-not-reach-the-browser");
  });

  it("rejects an unexpected successful read status before releasing a body", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          data: [],
          meta: { correlationId: crypto.randomUUID(), truncated: false, maximumItems: 100 },
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(privacyRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("pages the identity directory and verifies a selected organization outside the page", async () => {
    const selectedOrganizationId = "00000000-0000-4000-8000-000000000002";
    const cursor = "eyJ2IjoxLCJzIjoiTm9ydGgiLCJuIjoibm9ydGgiLCJpIjoiY3Vyc29yIn0";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              id: organizationId,
              name: "North One",
              membershipId: "00000000-0000-4000-8000-000000000011",
              role: "analyst",
            },
          ],
          meta: {
            correlationId: "00000000-0000-4000-8000-000000000012",
            truncated: true,
            maximumItems: 100,
            nextCursor: cursor,
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              id: selectedOrganizationId,
              name: "Selected Beyond Page",
              membershipId: "00000000-0000-4000-8000-000000000013",
              role: "reviewer",
            },
          ],
          meta: {
            correlationId: "00000000-0000-4000-8000-000000000014",
            truncated: false,
            maximumItems: 100,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const selection = issueOrganizationContext(selectedOrganizationId, subject, secret);
    const request = new NextRequest(
      `http://localhost:3000/api/recon?view=organizations&search=North&cursor=${cursor}`,
      {
        headers: {
          cookie: `${organizationContextCookieName()}=${selection}`,
        },
      },
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    const responseBody: unknown = await response.json();
    expect(responseBody).toMatchObject({
      data: {
        organizations: [{ id: organizationId, name: "North One" }],
        selectedOrganizationId,
        selectedOrganization: { id: selectedOrganizationId, name: "Selected Beyond Page" },
      },
      meta: { nextCursor: cursor },
    });
    expect(JSON.stringify(responseBody)).not.toContain("membershipId");
    expect(JSON.stringify(responseBody)).not.toContain("correlationId");
    expect(JSON.stringify(responseBody)).not.toContain("maximumItems");
    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://127.0.0.1:4000/v1/organizations?limit=50&search=North&cursor=${cursor}`,
    );
    expect(requestUrl(fetchMock.mock.calls[1]?.[0])).toBe(
      `http://127.0.0.1:4000/v1/organizations?limit=1&organizationId=${selectedOrganizationId}`,
    );
  });

  it("rejects an oversized organization search before contacting the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = new NextRequest(
      `http://localhost:3000/api/recon?view=organizations&search=${"x".repeat(101)}`,
    );

    const response = await GET(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_ORGANIZATION_DIRECTORY_QUERY" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function privacyRequest(cursor?: string): NextRequest {
  const cookie = issueOrganizationContext(organizationId, subject, secret);
  const url = new URL("http://localhost:3000/api/recon");
  url.searchParams.set("view", "privacy_requests");
  if (cursor) url.searchParams.set("cursor", cursor);
  return new NextRequest(url, {
    headers: { cookie: `${organizationContextCookieName()}=${cookie}` },
  });
}

function requestUrl(value: string | URL | Request | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  return value?.url;
}
