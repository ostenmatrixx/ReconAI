import { getToken } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  issueOrganizationContext,
  organizationContextCookieName,
} from "../../../../organization-context";
import { POST } from "./route";

vi.mock("next-auth/jwt", () => ({ getToken: vi.fn() }));

const organizationId = "00000000-0000-4000-8000-000000000001";
const subject = "synthetic-retention-administrator";
const secret = "development-only-session-secret-change-me";

describe("retention policy BFF action", { concurrent: false }, () => {
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

  it("routes a versioned organization profile update and minimizes its response", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        data: {
          name: "North Operations",
          businessTimeZone: "America/New_York",
          profileVersion: 8,
          updatedAt: "2026-07-30T12:01:00.000Z",
          internalAuditHead: "must-not-reach-the-browser",
        },
        meta: { correlationId: crypto.randomUUID() },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      actionRequest({
        action: "update_organization_profile",
        name: "  North Operations  ",
        expectedProfileVersion: 7,
        reason: "Adopt the approved operating name",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        name: "North Operations",
        businessTimeZone: "America/New_York",
        profileVersion: 8,
        updatedAt: "2026-07-30T12:01:00.000Z",
      },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe(`http://127.0.0.1:4000/v1/organizations/${organizationId}`);
    expect(init).toMatchObject({ method: "PATCH", credentials: "omit", redirect: "error" });
    expect(init && typeof init.body === "string" ? JSON.parse(init.body) : undefined).toEqual({
      name: "North Operations",
      expectedProfileVersion: 7,
      reason: "Adopt the approved operating name",
    });
  });

  it("rejects malformed or expanded organization profile updates before mutation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const base = {
      action: "update_organization_profile",
      expectedProfileVersion: 7,
      reason: "Adopt the approved operating name",
    };

    expect((await POST(actionRequest({ ...base, name: "North\nOperations" }))).status).toBe(400);
    expect(
      (
        await POST(
          actionRequest({
            ...base,
            name: "North Operations",
            expectedProfileVersion: 0,
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(
          actionRequest({
            ...base,
            name: "North Operations",
            aiEnabled: true,
          }),
        )
      ).status,
    ).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("injects the signed organization context and strips the browser-only confirmation", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        data: {
          rawImportRetentionDays: 30,
          providerEventRetentionDays: 90,
          legalHoldEnabled: false,
          legalHoldReason: null,
          updatedAt: "2026-07-27T12:00:00.000Z",
          internalPolicyVersion: "must-not-reach-the-browser",
        },
        diagnostic: "must-not-reach-the-browser",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      actionRequest({
        action: "update_retention_policy",
        rawImportRetentionDays: 30,
        providerEventRetentionDays: 90,
        legalHoldEnabled: false,
        legalHoldReason: null,
        confirmed: true,
        reason: "Apply the approved synthetic retention schedule",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        rawImportRetentionDays: 30,
        providerEventRetentionDays: 90,
        legalHoldEnabled: false,
        legalHoldReason: null,
        updatedAt: "2026-07-27T12:00:00.000Z",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}/retention-policy`,
    );
    expect(init).toMatchObject({ method: "PATCH", credentials: "omit", redirect: "error" });
    const submitted =
      init && typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    expect(submitted).toEqual({
      rawImportRetentionDays: 30,
      providerEventRetentionDays: 90,
      legalHoldEnabled: false,
      legalHoldReason: null,
      confirmOrganizationId: organizationId,
      reason: "Apply the approved synthetic retention schedule",
    });
  });

  it("rejects missing confirmation and cross-site requests before upstream mutation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const unconfirmed = await POST(
      actionRequest({
        action: "update_retention_policy",
        rawImportRetentionDays: 30,
        providerEventRetentionDays: null,
        legalHoldEnabled: false,
        legalHoldReason: null,
        confirmed: false,
        reason: "Attempt an unconfirmed policy change",
      }),
    );
    expect(unconfirmed.status).toBe(400);

    const crossSite = await POST(
      actionRequest(
        {
          action: "update_retention_policy",
          rawImportRetentionDays: 30,
          providerEventRetentionDays: null,
          legalHoldEnabled: false,
          legalHoldReason: null,
          confirmed: true,
          reason: "Attempt a cross-site policy change",
        },
        "https://attacker.example.test",
      ),
    );
    expect(crossSite.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("injects tenant authority when an owner approves and revokes restricted support access", async () => {
    const grantId = "00000000-0000-4000-8000-000000000071";
    const requestCode = "a".repeat(43);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            data: {
              id: grantId,
              status: "active",
            },
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ data: { outcome: "revoked", grant: { id: grantId } } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const approved = await POST(
      actionRequest({
        action: "approve_support_access",
        requestCode,
        ticketReference: "SUP-1042",
        reason: "Approve bounded diagnostics for the open support incident",
        confirmed: true,
      }),
    );
    expect(approved.status).toBe(201);
    await expect(approved.json()).resolves.toEqual({ data: { accepted: true } });
    const [approveUrl, approveInit] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(approveUrl)).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}/support-access-grants`,
    );
    const approveBody =
      approveInit && typeof approveInit.body === "string"
        ? (JSON.parse(approveInit.body) as unknown)
        : undefined;
    expect(approveBody).toEqual({
      requestCode,
      confirmOrganizationId: organizationId,
      ticketReference: "SUP-1042",
      reason: "Approve bounded diagnostics for the open support incident",
    });

    const revoked = await POST(
      actionRequest({
        action: "revoke_support_access",
        grantId,
        reason: "The approved diagnostic investigation is complete",
        confirmed: true,
      }),
    );
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({ data: { accepted: true } });
    const [revokeUrl, revokeInit] = fetchMock.mock.calls[1] ?? [];
    expect(requestUrl(revokeUrl)).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}/support-access-grants/${grantId}/revoke`,
    );
    const revokeBody =
      revokeInit && typeof revokeInit.body === "string"
        ? (JSON.parse(revokeInit.body) as unknown)
        : undefined;
    expect(revokeBody).toEqual({
      confirmOrganizationId: organizationId,
      reason: "The approved diagnostic investigation is complete",
    });
  });

  it("rejects unconfirmed or malformed support grants before upstream mutation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const unconfirmed = await POST(
      actionRequest({
        action: "approve_support_access",
        requestCode: "a".repeat(43),
        ticketReference: "SUP-1042",
        reason: "Attempt an unconfirmed support grant",
        confirmed: false,
      }),
    );
    expect(unconfirmed.status).toBe(400);

    const controlCharacter = await POST(
      actionRequest({
        action: "approve_support_access",
        requestCode: "a".repeat(43),
        ticketReference: "SUP-\n1042",
        reason: "Attempt a malformed support grant",
        confirmed: true,
      }),
    );
    expect(controlCharacter.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on an oversized support-action response", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": String(1024 * 1024 + 1),
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      actionRequest({
        action: "approve_support_access",
        requestCode: "a".repeat(43),
        ticketReference: "SUP-1042",
        reason: "Approve bounded diagnostics for the synthetic incident",
        confirmed: true,
      }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("injects organization authority into a bounded provider sync request", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          data: {
            provider: "stripe",
            status: "queued",
            apiCredentialReference: "must-not-reach-the-browser",
          },
        },
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const connectionId = "00000000-0000-4000-8000-000000000032";

    const response = await POST(
      actionRequest({
        action: "start_provider_sync",
        connectionId,
        mode: "gap_repair",
        windowStart: "2026-07-26T00:00:00.000Z",
        windowEnd: "2026-07-27T00:00:00.000Z",
        maximumPages: 5,
        confirmed: true,
        reason: "Repair the approved bounded Stripe event gap",
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ data: { provider: "stripe" } });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}/connections/${connectionId}/provider-sync-runs`,
    );
    const submitted =
      init && typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    expect(submitted).toEqual({
      mode: "gap_repair",
      windowStart: "2026-07-26T00:00:00.000Z",
      windowEnd: "2026-07-27T00:00:00.000Z",
      maximumPages: 5,
      confirmOrganizationId: organizationId,
      reason: "Repair the approved bounded Stripe event gap",
    });
  });

  it("forwards only a context-matched sealed credential envelope", async () => {
    const credentialId = "00000000-0000-4000-8000-000000000035";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          data: {
            id: credentialId,
            keyVersion: "v1",
            status: "active",
            encryptedReference: "must-not-reach-the-browser",
          },
          internalKeyContext: "must-not-reach-the-browser",
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const connectionId = "00000000-0000-4000-8000-000000000032";
    const envelope = {
      schemaVersion: 1,
      algorithm: "A256GCM",
      keyVersion: "v1",
      organizationId,
      connectionId,
      provider: "stripe",
      purpose: "api_read",
      iv: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      tag: "AAAAAAAAAAAAAAAAAAAAAA",
    } as const;
    const response = await POST(
      actionRequest({
        action: "rotate_connector_credential",
        connectionId,
        purpose: "api_read",
        envelope,
        confirmed: true,
        reason: "Rotate the tenant-bound provider read credential",
      }),
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      data: { id: credentialId, keyVersion: "v1" },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}/connections/${connectionId}/credentials/rotations`,
    );
    const submitted =
      init && typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    expect(submitted).toEqual({
      purpose: "api_read",
      envelope,
      confirmConnectionId: connectionId,
      reason: "Rotate the tenant-bound provider read credential",
    });

    const rejected = await POST(
      actionRequest({
        action: "rotate_connector_credential",
        connectionId,
        purpose: "api_read",
        envelope: { ...envelope, organizationId: "00000000-0000-4000-8000-000000000099" },
        confirmed: true,
        reason: "Attempt to move ciphertext across tenant authority",
      }),
    );
    expect(rejected.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards exact connection confirmation for disconnect", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        data: {
          status: "disconnected",
          revoked: 2,
          providerConfirmation: "confirmed",
          revokedCredentialReferences: ["must-not-reach-the-browser"],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const connectionId = "00000000-0000-4000-8000-000000000032";
    const response = await POST(
      actionRequest({
        action: "disconnect_connector",
        connectionId,
        confirmConnectionId: connectionId,
        reason: "Revoke all ReconAI access to this provider",
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        status: "disconnected",
        revoked: 2,
        providerConfirmation: "confirmed",
      },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe(
      `http://127.0.0.1:4000/v1/organizations/${organizationId}/connections/${connectionId}/disconnect`,
    );
    const submitted =
      init && typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    expect(submitted).toEqual({
      confirmConnectionId: connectionId,
      reason: "Revoke all ReconAI access to this provider",
    });
  });

  it("minimizes invitation, rollback, review-policy, run-start, and acknowledgement responses", async () => {
    const invitationToken = "b".repeat(43);
    const runId = "00000000-0000-4000-8000-000000000021";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            data: {
              acceptToken: invitationToken,
              email: "reviewer@example.test",
              invitedByMembershipId: "must-not-reach-the-browser",
            },
            meta: {
              correlationId: "00000000-0000-4000-8000-000000000092",
              delivery: { status: "accepted", auditRecorded: true, provider: "http_webhook" },
            },
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            status: "rolled_back",
            supersededRecordCount: 3,
            objectKey: "must-not-reach-the-browser",
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            dualApprovalEnabled: true,
            dualApprovalThresholds: { USD: "150000" },
            sensitiveResolutionTypes: ["write_off"],
            updatedAt: "2026-07-27T12:05:00.000Z",
            internalRevision: "must-not-reach-the-browser",
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            data: {
              id: runId,
              status: "queued",
              inputSnapshotHash: "must-not-reach-the-browser",
            },
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ data: { id: runId, dispatchCount: 2 } }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            data: {
              id: "00000000-0000-4000-8000-000000000041",
              reason: "must-not-reach-the-browser",
            },
          },
          { status: 201 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const invitation = await POST(
      actionRequest({
        action: "create_invitation",
        email: "reviewer@example.test",
        role: "reviewer",
        reason: "Add an independent finance reviewer",
      }),
    );
    expect(invitation.status).toBe(201);
    await expect(invitation.json()).resolves.toEqual({
      data: { acceptToken: invitationToken },
      meta: { delivery: { status: "accepted", auditRecorded: true } },
    });

    const rollback = await POST(
      actionRequest({
        action: "rollback_import",
        importId: "00000000-0000-4000-8000-000000000031",
        confirmImportId: "00000000-0000-4000-8000-000000000031",
        reason: "Supersede the incorrect accounting import",
      }),
    );
    expect(rollback.status).toBe(200);
    await expect(rollback.json()).resolves.toEqual({
      data: { status: "rolled_back", supersededRecordCount: 3 },
    });

    const reviewPolicy = await POST(
      actionRequest({
        action: "update_review_policy",
        dualApprovalEnabled: true,
        dualApprovalThresholds: { USD: "150000" },
        sensitiveResolutionTypes: ["write_off"],
        reason: "Require independent approval for material resolutions",
      }),
    );
    expect(reviewPolicy.status).toBe(200);
    await expect(reviewPolicy.json()).resolves.toEqual({
      data: {
        dualApprovalEnabled: true,
        dualApprovalThresholds: { USD: "150000" },
        sensitiveResolutionTypes: ["write_off"],
        updatedAt: "2026-07-27T12:05:00.000Z",
      },
    });

    const run = await POST(
      actionRequest({
        action: "start_run",
        policyVersion: "2026-07-27",
        evaluatedAt: "2026-07-27T12:00:00.000Z",
        amountToleranceMinor: { USD: "0" },
        dateWindowSeconds: 86_400,
        delayedEventGraceSeconds: 86_400,
        businessTimeZone: "UTC",
        reason: "Run the bounded deterministic policy",
      }),
    );
    expect(run.status).toBe(202);
    await expect(run.json()).resolves.toEqual({ data: { id: runId, status: "queued" } });

    const replay = await POST(
      actionRequest({
        action: "replay_run",
        runId,
        reason: "Replay the same immutable input authority",
      }),
    );
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toEqual({ data: { accepted: true } });

    const proposal = await POST(
      actionRequest({
        action: "create_proposal",
        exceptionId: "00000000-0000-4000-8000-000000000022",
        type: "manual_review",
        reason: "Propose a deterministic resolution for review",
      }),
    );
    expect(proposal.status).toBe(201);
    await expect(proposal.json()).resolves.toEqual({ data: { accepted: true } });
  });

  it("allowlists fixed API errors and rejects expanded diagnostics", async () => {
    const correlationId = "00000000-0000-4000-8000-000000000093";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            code: "CONFLICT",
            message: "internal membership and audit diagnostics",
            correlationId,
          },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            code: "CONFLICT",
            message: "internal membership and audit diagnostics",
            correlationId,
            accessToken: "must-not-reach-the-browser",
          },
          { status: 409 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const requestBody = {
      action: "update_member",
      membershipId: "00000000-0000-4000-8000-000000000003",
      role: "reviewer",
      status: "active",
      reason: "Apply least-privilege reviewer access",
    };

    const approvedError = await POST(actionRequest(requestBody));
    expect(approvedError.status).toBe(409);
    await expect(approvedError.json()).resolves.toEqual({
      code: "CONFLICT",
      message: "The action conflicts with the current state. Refresh and try again.",
      correlationId,
    });

    const expandedError = await POST(actionRequest(requestBody));
    expect(expandedError.status).toBe(502);
    const expandedBody: unknown = await expandedError.json();
    expect(expandedBody).toEqual({
      code: "UPSTREAM_UNAVAILABLE",
      message: "The reconciliation API is unavailable.",
    });
    expect(JSON.stringify(expandedBody)).not.toContain("accessToken");
  });

  it("fails closed on unexpected success status and an unsafe provider action URL", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: { provider: "stripe" } }, { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            status: "provider_action_required",
            providerActionUrl: "https://attacker.example.test/settings/apps/reconai",
            providerConfirmation: "pending",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const unexpectedStatus = await POST(
      actionRequest({
        action: "start_provider_sync",
        connectionId: "00000000-0000-4000-8000-000000000032",
        mode: "gap_repair",
        windowStart: "2026-07-26T00:00:00.000Z",
        windowEnd: "2026-07-27T00:00:00.000Z",
        maximumPages: 5,
        confirmed: true,
        reason: "Repair the approved bounded Stripe event gap",
      }),
    );
    expect(unexpectedStatus.status).toBe(502);

    const unsafeProviderUrl = await POST(
      actionRequest({
        action: "disconnect_connector",
        connectionId: "00000000-0000-4000-8000-000000000032",
        confirmConnectionId: "00000000-0000-4000-8000-000000000032",
        reason: "Revoke all ReconAI access to this provider",
      }),
    );
    expect(unsafeProviderUrl.status).toBe(502);
    await expect(unsafeProviderUrl.json()).resolves.toEqual({
      code: "UPSTREAM_UNAVAILABLE",
      message: "The reconciliation API is unavailable.",
    });
  });
});

function requestUrl(value: RequestInfo | URL | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.href;
  return value?.url;
}

function actionRequest(body: unknown, origin = "http://localhost:3000"): NextRequest {
  const context = issueOrganizationContext(organizationId, subject, secret);
  return new NextRequest("http://localhost:3000/api/recon/actions", {
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
