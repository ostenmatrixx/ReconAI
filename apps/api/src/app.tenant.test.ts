import {
  MembershipIdSchema,
  OrganizationIdSchema,
  SupportAccessGrantIdSchema,
  SupportAccessRequestCodeSchema,
  SupportIdentityDigestSchema,
  UserIdSchema,
  tenantContextFromMembership,
  type TenantContext,
} from "@workspace/domain";
import type { InvitationEmailProvider } from "@workspace/email";
import {
  ProviderPrivacyDataPackageEvidenceError,
  ProviderPrivacyDataPackageLimitError,
  ProviderPrivacyDataPackageReceiptExpiredError,
  type CsvImportReceipt,
  type CsvUpload,
  type ProviderPrivacyDataPackageService,
  type ProviderSyncManager,
} from "@workspace/ingestion";
import {
  ProviderPrivacyOperationsCursorError,
  type ConnectorCredentialLifecycleManager,
  type ProviderPrivacyOperationsRepository,
  type SupportAccessRepository,
} from "@workspace/database";
import { describe, expect, it, vi } from "vitest";

import { buildApi, type ApiDependencies } from "./app.js";
import {
  AuthenticationError,
  type IdentityVerifier,
  type MembershipDirectory,
  type OrganizationBootstrapper,
  OrganizationDirectoryCursorError,
  type VerifiedIdentity,
} from "./auth.js";
import type { ProviderAuthorizationFlow } from "./provider-authorization.js";
import type { ProviderDisconnectFlow } from "./provider-disconnect.js";
import {
  RepositoryCursorError,
  RepositoryExportLimitError,
  RepositoryRunCreationUnavailableError,
  type DeterministicEvidenceView,
  type ReconciliationRepository,
} from "./repository.js";

const organizationId = OrganizationIdSchema.parse("00000000-0000-4000-8000-000000000001");
const otherOrganizationId = OrganizationIdSchema.parse("00000000-0000-4000-8000-000000000002");
const tenant = tenantContextFromMembership({
  id: MembershipIdSchema.parse("00000000-0000-4000-8000-000000000003"),
  organizationId,
  userId: UserIdSchema.parse("00000000-0000-4000-8000-000000000004"),
  role: "analyst",
  status: "active",
});
const administratorTenant = tenantContextFromMembership({
  id: MembershipIdSchema.parse("00000000-0000-4000-8000-000000000005"),
  organizationId,
  userId: UserIdSchema.parse("00000000-0000-4000-8000-000000000006"),
  role: "administrator",
  status: "active",
});
const reviewerTenant = tenantContextFromMembership({
  id: MembershipIdSchema.parse("00000000-0000-4000-8000-000000000007"),
  organizationId,
  userId: UserIdSchema.parse("00000000-0000-4000-8000-000000000008"),
  role: "reviewer",
  status: "active",
});
const ownerTenant = tenantContextFromMembership({
  id: MembershipIdSchema.parse("00000000-0000-4000-8000-000000000009"),
  organizationId,
  userId: UserIdSchema.parse("00000000-0000-4000-8000-000000000010"),
  role: "owner",
  status: "active",
});
const auditorTenant = tenantContextFromMembership({
  id: MembershipIdSchema.parse("00000000-0000-4000-8000-000000000011"),
  organizationId,
  userId: UserIdSchema.parse("00000000-0000-4000-8000-000000000012"),
  role: "auditor",
  status: "active",
});

const identityVerifier: IdentityVerifier = {
  verifyAuthorizationHeader: async () => ({
    issuer: "https://issuer.test",
    subject: "user",
    emailVerified: false,
  }),
};
const memberships: MembershipDirectory = {
  list: async () => ({
    items: [
      {
        id: organizationId,
        name: "Synthetic Organization",
        membershipId: MembershipIdSchema.parse("00000000-0000-4000-8000-000000000003"),
        role: "analyst",
      },
    ],
  }),
  resolve: async (_identity, requested) => (requested === organizationId ? tenant : undefined),
};

describe("API tenant boundary", () => {
  it("rejects non-test startup without composite readiness", async () => {
    await expect(
      buildApi({
        identityVerifier,
        memberships,
        repository: repositoryStub(async () => emptyExceptionPage()),
        csvImports: csvImportStub(),
        providerWebhooks: providerWebhookStub(),
        webOrigin: "http://localhost:3000",
        environment: "development",
      }),
    ).rejects.toThrow("requires composite readiness");
  });

  it("rejects non-test startup without the organization bootstrap boundary", async () => {
    await expect(
      buildApi({
        identityVerifier,
        memberships,
        repository: repositoryStub(async () => emptyExceptionPage()),
        csvImports: csvImportStub(),
        providerWebhooks: providerWebhookStub(),
        readiness: { ready: async () => true },
        webOrigin: "http://localhost:3000",
        environment: "development",
      }),
    ).rejects.toThrow("requires organization bootstrap");
  });

  it("keeps readiness failure opaque and liveness independent", async () => {
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      readiness: {
        ready: async () => {
          throw new Error("synthetic object endpoint and credential detail");
        },
      },
      webOrigin: "http://localhost:3000",
      environment: "test",
    });

    const readiness = await app.inject({ method: "GET", url: "/health/ready" });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toEqual({ status: "not_ready" });
    const liveness = await app.inject({ method: "GET", url: "/health/live" });
    expect(liveness.statusCode).toBe(200);
    expect(liveness.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("keeps liveness independent from the request limiter", async () => {
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });

    for (let index = 0; index < 125; index += 1) {
      const response = await app.inject({ method: "GET", url: "/health/live" });
      expect(response.statusCode).toBe(200);
    }
    for (let index = 0; index < 120; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/organizations",
        headers: { authorization: "Bearer synthetic-unit-test-token-value" },
      });
      expect(response.statusCode).toBe(200);
    }
    const exceeded = await app.inject({
      method: "GET",
      url: "/v1/organizations",
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(exceeded.statusCode).toBe(429);
    const exceededBody: unknown = exceeded.json();
    expect(exceededBody).toMatchObject({
      code: "RATE_LIMITED",
      message: "request rate exceeded",
    });
    if (!isRecord(exceededBody) || typeof exceededBody["correlationId"] !== "string") {
      throw new Error("expected a rate-limit response correlation ID");
    }
    expect(exceededBody["correlationId"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    await app.close();
  });

  it("lists only the organizations resolved from the verified identity", async () => {
    const list = vi.fn(
      (identity: VerifiedIdentity, options: Parameters<MembershipDirectory["list"]>[1]) =>
        memberships.list(identity, options),
    );
    const app = await buildApi({
      identityVerifier,
      memberships: { ...memberships, list },
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/organizations",
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [
        {
          id: organizationId,
          name: "Synthetic Organization",
          membershipId: "00000000-0000-4000-8000-000000000003",
          role: "analyst",
        },
      ],
      meta: { truncated: false },
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(expect.any(Object), { limit: 50 });
    await app.close();
  });

  it("creates a verified identity first organization and marks exact retries as replayed", async () => {
    let bootstrapInvocation = 0;
    const bootstrap = vi.fn<OrganizationBootstrapper["bootstrap"]>(async (_identity, request) => {
      bootstrapInvocation += 1;
      return {
        status: bootstrapInvocation === 1 ? "created" : "replayed",
        access: {
          id: organizationId,
          name: request.name,
          membershipId: MembershipIdSchema.parse("00000000-0000-4000-8000-000000000003"),
          role: "owner",
        },
        businessTimeZone: request.businessTimeZone,
      };
    });
    const verifiedIdentity: IdentityVerifier = {
      verifyAuthorizationHeader: async () => ({
        issuer: "https://issuer.test",
        subject: "bootstrap-owner",
        email: "bootstrap-owner@example.test",
        emailVerified: true,
      }),
    };
    const app = await buildApi({
      identityVerifier: verifiedIdentity,
      memberships,
      organizationBootstrap: { bootstrap },
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const request = (idempotencyKey: string) => ({
      method: "POST" as const,
      url: "/v1/organizations",
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
      payload: {
        name: "  Bootstrap Tenant  ",
        businessTimeZone: "Asia/Manila",
        idempotencyKey,
      },
    });

    const created = await app.inject(request("00000000-0000-4000-8000-000000000001"));
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      data: {
        id: organizationId,
        name: "Bootstrap Tenant",
        role: "owner",
        businessTimeZone: "Asia/Manila",
      },
      meta: { replayed: false },
    });
    expect(bootstrap).toHaveBeenLastCalledWith(
      expect.objectContaining({ emailVerified: true }),
      expect.objectContaining({
        name: "Bootstrap Tenant",
        businessTimeZone: "Asia/Manila",
      }),
    );

    const replayed = await app.inject(request("00000000-0000-4000-8000-000000000001"));
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toMatchObject({ meta: { replayed: true } });
    await app.close();
  });

  it("rejects unverified, ineligible, and malformed organization bootstrap requests", async () => {
    const bootstrap = vi.fn<OrganizationBootstrapper["bootstrap"]>(async () => ({
      status: "not_eligible",
    }));
    const unverifiedApp = await buildApi({
      identityVerifier,
      memberships,
      organizationBootstrap: { bootstrap },
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const payload = {
      name: "Bootstrap Tenant",
      businessTimeZone: "Asia/Manila",
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
    };

    const unverified = await unverifiedApp.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
      payload,
    });
    expect(unverified.statusCode).toBe(403);
    expect(unverified.json()).toMatchObject({ code: "VERIFIED_EMAIL_REQUIRED" });
    expect(bootstrap).not.toHaveBeenCalled();
    await unverifiedApp.close();

    const verifiedApp = await buildApi({
      identityVerifier: {
        verifyAuthorizationHeader: async () => ({
          issuer: "https://issuer.test",
          subject: "bootstrap-owner",
          email: "bootstrap-owner@example.test",
          emailVerified: true,
        }),
      },
      memberships,
      organizationBootstrap: { bootstrap },
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const ineligible = await verifiedApp.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
      payload,
    });
    expect(ineligible.statusCode).toBe(409);
    expect(ineligible.json()).toMatchObject({ code: "ORGANIZATION_BOOTSTRAP_NOT_AVAILABLE" });

    const invalidTimeZone = await verifiedApp.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
      payload: { ...payload, businessTimeZone: "Not/A_Time_Zone" },
    });
    expect(invalidTimeZone.statusCode).toBe(400);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    await verifiedApp.close();
  });

  it("forwards bounded organization search and returns an opaque next cursor", async () => {
    const list = vi.fn<MembershipDirectory["list"]>(async (_identity, options) => {
      expect(options).toEqual({
        limit: 100,
        search: "North %",
        cursor: "opaque_cursor",
      });
      const page = await memberships.list(_identity, { limit: 1 });
      const first = page.items[0];
      if (!first) throw new Error("expected a synthetic organization");
      return {
        items: Array.from({ length: 100 }, () => first),
        nextCursor: "next_opaque_cursor",
      };
    });
    const app = await buildApi({
      identityVerifier,
      memberships: { ...memberships, list },
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/organizations?limit=100&search=%20North%20%25%20&cursor=opaque_cursor",
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });

    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(body).toMatchObject({
      meta: {
        truncated: true,
        maximumItems: 100,
        nextCursor: "next_opaque_cursor",
      },
    });
    if (!isRecord(body) || !Array.isArray(body["data"])) {
      throw new Error("expected an organization directory response");
    }
    expect(body["data"]).toHaveLength(100);
    expect(list).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("contains malformed organization cursors and rejects conflicting exact lookups", async () => {
    const list = vi.fn<MembershipDirectory["list"]>(async () => {
      throw new OrganizationDirectoryCursorError();
    });
    const app = await buildApi({
      identityVerifier,
      memberships: { ...memberships, list },
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });

    const invalidCursor = await app.inject({
      method: "GET",
      url: "/v1/organizations?cursor=syntactically_valid",
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json()).toMatchObject({
      code: "INVALID_ORGANIZATION_CURSOR",
      message: "organization directory cursor is invalid",
    });

    const conflictingLookup = await app.inject({
      method: "GET",
      url: `/v1/organizations?organizationId=${organizationId}&search=North`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(conflictingLookup.statusCode).toBe(400);
    expect(list).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("does not call a repository for a foreign organization route", async () => {
    const listExceptions = vi.fn(async () => emptyExceptionPage());
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(listExceptions),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/organizations/${otherOrganizationId}/exceptions`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      message: "resource not found",
    });
    expect(listExceptions).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps missing authentication distinct from concealed tenant authorization", async () => {
    const verifyAuthorizationHeader = vi.fn(async (header: string | undefined) => {
      if (!header) throw new AuthenticationError();
      return {
        issuer: "https://issuer.test",
        subject: "user",
        emailVerified: false,
      };
    });
    const resolve = vi.fn((identity: VerifiedIdentity, requested: typeof organizationId) =>
      memberships.resolve(identity, requested),
    );
    const listExceptions = vi.fn(async () => emptyExceptionPage());
    const app = await buildApi({
      identityVerifier: { verifyAuthorizationHeader },
      memberships: { ...memberships, resolve },
      repository: repositoryStub(listExceptions),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });

    const unauthenticated = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/exceptions`,
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });

    const foreign = await app.inject({
      method: "GET",
      url: `/v1/organizations/${otherOrganizationId}/exceptions`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    const authorized = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/exceptions`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(authorized.statusCode).toBe(200);
    expect(verifyAuthorizationHeader).toHaveBeenCalledTimes(3);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(listExceptions).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("passes a server-resolved tenant context to an authorized repository call", async () => {
    const listExceptions = vi.fn(async () => emptyExceptionPage());
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(listExceptions),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/exceptions`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "x-request-id": "attacker-controlled-log-value",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(response.headers["pragma"]).toBe("no-cache");
    expect(response.body).not.toContain("attacker-controlled-log-value");
    expect(response.body).toMatch(
      /"correlationId":"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"/u,
    );
    expect(response.json()).toMatchObject({ meta: { canExport: false } });
    expect(listExceptions).toHaveBeenCalledWith(tenant, { limit: 50 });
    await app.close();
  });

  it("passes bounded queue filters to the repository and returns pagination metadata", async () => {
    const listExceptions = vi.fn(async () => ({
      ...emptyExceptionPage(),
      filteredCount: 12,
      nextCursor: "opaque_cursor",
    }));
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(listExceptions),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "GET",
      url:
        `/v1/organizations/${organizationId}/exceptions?status=open&severity=high` +
        "&search=payment_without_order&source=stripe&amountCurrency=USD" +
        "&minimumAmountMinor=10000&maximumAmountMinor=20000&confidence=high" +
        "&assignee=unassigned&age=one_to_seven_days&cursor=opaque_cursor&limit=25",
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });

    expect(response.statusCode).toBe(200);
    expect(listExceptions).toHaveBeenCalledWith(tenant, {
      status: "open",
      severity: "high",
      search: "payment_without_order",
      source: "stripe",
      amountCurrency: "USD",
      minimumAmountMinor: "10000",
      maximumAmountMinor: "20000",
      confidence: "high",
      assignee: "unassigned",
      age: "one_to_seven_days",
      cursor: "opaque_cursor",
      limit: 25,
    });
    expect(response.json()).toMatchObject({
      data: [],
      meta: { filteredCount: 12, nextCursor: "opaque_cursor" },
    });
    await app.close();
  });

  it("rejects currency-free or inverted queue amount ranges before repository access", async () => {
    const listExceptions = vi.fn(async () => emptyExceptionPage());
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(listExceptions),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });

    const missingCurrency = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/exceptions?minimumAmountMinor=1`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    const inverted = await app.inject({
      method: "GET",
      url:
        `/v1/organizations/${organizationId}/exceptions?amountCurrency=USD` +
        "&minimumAmountMinor=2&maximumAmountMinor=1",
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    const malformed = await app.inject({
      method: "GET",
      url:
        `/v1/organizations/${organizationId}/exceptions?amountCurrency=USD` +
        "&minimumAmountMinor=not-an-integer&maximumAmountMinor=1",
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });

    expect(missingCurrency.statusCode).toBe(400);
    expect(inverted.statusCode).toBe(400);
    expect(malformed.statusCode).toBe(400);
    expect(listExceptions).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps a filter-bound cursor rejection to a safe client error", async () => {
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => {
        throw new RepositoryCursorError();
      }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/exceptions?cursor=opaque_cursor`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_CURSOR" });
    await app.close();
  });

  it("returns a non-empty fixed-name CSV through the export-authorized tenant context", async () => {
    const exportId = "00000000-0000-4000-8000-000000000050";
    const csv = '\uFEFF"exception_id","type"\r\n"example","manual_review_required"\r\n';
    const exportExceptions = vi.fn<ReconciliationRepository["exportExceptions"]>(async () => ({
      id: exportId,
      csv,
      rowCount: 1,
    }));
    const app = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage(), { exportExceptions }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/exception-exports`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
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
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="reconai-exception-queue.csv"',
    );
    expect(response.headers["content-length"]).toBe(Buffer.byteLength(csv, "utf8").toString());
    expect(response.headers["x-reconai-export-id"]).toBe(exportId);
    expect(Buffer.byteLength(response.rawPayload)).toBeGreaterThan(0);
    expect(response.body).toBe(csv);
    expect(exportExceptions).toHaveBeenCalledOnce();
    const exportCall = exportExceptions.mock.calls[0];
    if (!exportCall) throw new Error("expected the export repository call");
    expect(exportCall[0]).toBe(administratorTenant);
    expect(exportCall[1]).toEqual({
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
    });
    expect(exportCall[2].correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    await app.close();
  });

  it("does not invoke exception export without the explicit data-export permission", async () => {
    const exportExceptions = vi.fn<ReconciliationRepository["exportExceptions"]>();
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage(), { exportExceptions }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/exception-exports`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(exportExceptions).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps an over-limit exception export to a narrow-filter response", async () => {
    const exportExceptions = vi.fn<ReconciliationRepository["exportExceptions"]>(async () => {
      throw new RepositoryExportLimitError();
    });
    const app = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage(), { exportExceptions }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/exception-exports`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {},
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('"code":"EXPORT_LIMIT_EXCEEDED"');
    expect(response.body).toContain("narrow the filters");
    await app.close();
  });

  it("accepts a bounded multipart CSV contract only after server authorization", async () => {
    const createPreview = vi.fn(async (_tenant: TenantContext, _upload: CsvUpload) => ({
      receipt: csvReceipt(),
      duplicate: false,
    }));
    const app = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub({ createPreview }),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const boundary = "reconai-test-boundary";
    const response = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/imports/accounting-csv`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartCsv(boundary),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      data: { status: "previewed", rowCount: 1, invalidRowCount: 0 },
      meta: { duplicate: false },
    });
    const call = createPreview.mock.calls[0];
    expect(call?.[0]).toBe(administratorTenant);
    expect(call?.[1]).toMatchObject({ filename: "ledger.csv", contentType: "text/csv" });
    expect(call?.[1].metadata.templateVersion).toBe("accounting-v1");
    await app.close();
  });

  it("commits an authorized CSV import without copying raw caller trace context", async () => {
    const queued = {
      ...csvReceipt(),
      status: "queued" as const,
      committedAt: "2026-07-27T12:01:00.000Z",
    };
    const commitImport = vi.fn<ApiDependencies["csvImports"]["commitImport"]>(async () => queued);
    const app = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub({ commitImport }),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/imports/${queued.id}/commit`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      },
      payload: { reason: "Commit the approved accounting close file" },
    });

    expect(response.statusCode).toBe(202);
    expect(commitImport).toHaveBeenCalledOnce();
    expect(commitImport.mock.calls[0]?.[0]).toBe(administratorTenant);
    expect(commitImport.mock.calls[0]?.[1]).toMatchObject({
      importId: queued.id,
      reason: "Commit the approved accounting close file",
    });
    expect(commitImport.mock.calls[0]?.[1].traceparent).toBeUndefined();
    await app.close();
  });

  it("lists imports and requires an exact rollback confirmation in an authorized tenant", async () => {
    const succeeded = {
      ...csvReceipt(),
      status: "succeeded" as const,
      committedAt: "2026-07-27T12:01:00.000Z",
      completedAt: "2026-07-27T12:02:00.000Z",
    };
    const rolledBack = {
      ...succeeded,
      status: "rolled_back" as const,
      rolledBackAt: "2026-07-27T12:03:00.000Z",
      supersededRecordCount: 1,
    };
    const listImports = vi.fn(async () => [succeeded]);
    const rollbackImport = vi.fn<ApiDependencies["csvImports"]["rollbackImport"]>(
      async () => rolledBack,
    );
    const app = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub({ listImports, rollbackImport }),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });

    const listResponse = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/imports?limit=25`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listImports).toHaveBeenCalledWith(administratorTenant, 25);
    expect(listResponse.json()).toMatchObject({ data: [{ status: "succeeded" }] });

    const rollbackResponse = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/imports/${succeeded.id}/rollback`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        confirmImportId: succeeded.id,
        reason: "Exclude the duplicate close file from future reconciliation runs",
      },
    });
    expect(rollbackResponse.statusCode).toBe(200);
    expect(rollbackImport).toHaveBeenCalledOnce();
    expect(rollbackImport.mock.calls[0]?.[0]).toBe(administratorTenant);
    expect(rollbackImport.mock.calls[0]?.[1]).toMatchObject({
      importId: succeeded.id,
      confirmImportId: succeeded.id,
      reason: "Exclude the duplicate close file from future reconciliation runs",
    });
    expect(rollbackImport.mock.calls[0]?.[1].correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/u);
    expect(rollbackResponse.json()).toMatchObject({
      data: { status: "rolled_back", supersededRecordCount: 1 },
    });
    await app.close();
  });

  it("hides import rollback from a member without connector management permission", async () => {
    const rollbackImport = vi.fn<ApiDependencies["csvImports"]["rollbackImport"]>(async () => ({
      ...csvReceipt(),
      status: "rolled_back" as const,
      rolledBackAt: "2026-07-27T12:03:00.000Z",
      supersededRecordCount: 1,
    }));
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub({ rollbackImport }),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/imports/${csvReceipt().id}/rollback`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        confirmImportId: csvReceipt().id,
        reason: "Attempt unauthorized import rollback",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(rollbackImport).not.toHaveBeenCalled();
    await app.close();
  });

  it("passes the exact bounded raw body to provider webhook authentication", async () => {
    const receiveShopify = vi.fn(
      async (_input: Parameters<ApiDependencies["providerWebhooks"]["receiveShopify"]>[0]) => ({
        duplicate: false,
        eventId: "webhook-1",
        status: "queued" as const,
      }),
    );
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub({ receiveShopify }),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const rawBody = '{"id":123, "exactWhitespace":true}';
    const response = await app.inject({
      method: "POST",
      url: `/v1/webhooks/shopify/organizations/${organizationId}/connections/00000000-0000-4000-8000-000000000007`,
      headers: {
        "content-type": "application/json",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        "x-shopify-hmac-sha256": "synthetic-signature",
        "x-shopify-webhook-id": "webhook-1",
        "x-shopify-topic": "orders/updated",
        "x-shopify-api-version": "2026-07",
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(202);
    const call = receiveShopify.mock.calls[0]?.[0];
    expect(Buffer.from(call?.rawBody ?? []).toString("utf8")).toBe(rawBody);
    expect(call).toMatchObject({
      organizationId,
      webhookId: "webhook-1",
      topic: "orders/updated",
      apiVersion: "2026-07",
    });
    expect(call?.traceparent).toBeUndefined();
    await app.close();
  });

  it("passes exact raw bytes and app-level Shopify identity headers to the privacy boundary", async () => {
    const receive = vi.fn<NonNullable<ApiDependencies["shopifyPrivacyWebhooks"]>["receive"]>(
      async () => ({
        duplicate: false,
        eventId: "privacy-webhook-1",
        status: "accepted" as const,
      }),
    );
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      shopifyPrivacyWebhooks: { receive },
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const rawBody =
      '{"shop_id":954889, "shop_domain":"reconai-test.myshopify.com", "exactWhitespace":true}';
    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/shopify/privacy",
      headers: {
        "content-type": "application/json",
        "x-shopify-hmac-sha256": "synthetic-signature",
        "x-shopify-webhook-id": "privacy-webhook-1",
        "x-shopify-topic": "shop/redact",
        "x-shopify-api-version": "2026-07",
        "x-shopify-shop-domain": "reconai-test.myshopify.com",
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(202);
    const call = receive.mock.calls[0]?.[0];
    expect(Buffer.from(call?.rawBody ?? []).toString("utf8")).toBe(rawBody);
    expect(call).toMatchObject({
      webhookId: "privacy-webhook-1",
      topic: "shop/redact",
      apiVersion: "2026-07",
      shopDomain: "reconai-test.myshopify.com",
    });
    expect(call).not.toHaveProperty("organizationId");
    expect(call).not.toHaveProperty("connectionId");
    await app.close();
  });

  it("passes the exact raw body to the app-level Stripe deauthorization verifier", async () => {
    const receive = vi.fn<NonNullable<ApiDependencies["providerDeauthorizations"]>["receive"]>(
      async () => ({
        duplicate: false,
        eventId: "evt_AppDeauthorized123",
        status: "accepted" as const,
      }),
    );
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      providerDeauthorizations: { receive },
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const rawBody = '{"id":"evt_AppDeauthorized123", "exactWhitespace":true}';
    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe/app-deauthorizations",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1785196800,v1=synthetic",
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(202);
    const call = receive.mock.calls[0]?.[0];
    expect(Buffer.from(call?.rawBody ?? []).toString("utf8")).toBe(rawBody);
    expect(call?.signature).toBe("t=1785196800,v1=synthetic");
    await app.close();
  });

  it("requires current organization-management authority for versioned profile reads and updates", async () => {
    const getOrganizationProfile = vi.fn<ReconciliationRepository["getOrganizationProfile"]>(
      async () => ({
        name: "Synthetic Organization",
        businessTimeZone: "UTC",
        profileVersion: 4,
        updatedAt: "2026-07-30T00:00:00.000Z",
      }),
    );
    const updateOrganizationProfile = vi.fn<ReconciliationRepository["updateOrganizationProfile"]>(
      async (_tenant, input) => ({
        name: input.name,
        businessTimeZone: "UTC",
        profileVersion: input.expectedProfileVersion + 1,
        updatedAt: "2026-07-30T00:01:00.000Z",
      }),
    );
    const app = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage(), {
        getOrganizationProfile,
        updateOrganizationProfile,
      }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });

    const read = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      data: {
        name: "Synthetic Organization",
        profileVersion: 4,
      },
    });
    expect(getOrganizationProfile).toHaveBeenCalledWith(administratorTenant);

    const update = await app.inject({
      method: "PATCH",
      url: `/v1/organizations/${organizationId}`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        name: "Renamed Organization",
        expectedProfileVersion: 4,
        reason: "Align the organization name with current operations",
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({
      data: {
        name: "Renamed Organization",
        profileVersion: 5,
      },
    });
    expect(updateOrganizationProfile).toHaveBeenCalledWith(administratorTenant, {
      name: "Renamed Organization",
      expectedProfileVersion: 4,
      reason: "Align the organization name with current operations",
    });
    await app.close();
  });

  it("rejects unauthorized, malformed, and expanded organization profile mutations", async () => {
    const updateOrganizationProfile =
      vi.fn<ReconciliationRepository["updateOrganizationProfile"]>();
    const unauthorizedApp = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage(), {
        updateOrganizationProfile,
      }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const unauthorized = await unauthorizedApp.inject({
      method: "PATCH",
      url: `/v1/organizations/${organizationId}`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        name: "Unauthorized Rename",
        expectedProfileVersion: 1,
        reason: "An analyst must not rename the organization",
      },
    });
    expect(unauthorized.statusCode).toBe(404);
    await unauthorizedApp.close();

    const authorizedApp = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage(), {
        updateOrganizationProfile,
      }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    for (const payload of [
      {
        name: "Invalid\nName",
        expectedProfileVersion: 1,
        reason: "Reject control characters in names",
      },
      {
        name: "Expanded Shape",
        expectedProfileVersion: 1,
        reason: "Reject unexpected profile authority",
        aiEnabled: true,
      },
      {
        name: "Missing Version",
        reason: "Reject mutation without concurrency authority",
      },
    ]) {
      const response = await authorizedApp.inject({
        method: "PATCH",
        url: `/v1/organizations/${organizationId}`,
        headers: {
          authorization: "Bearer synthetic-unit-test-token-value",
          "content-type": "application/json",
        },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(updateOrganizationProfile).not.toHaveBeenCalled();
    await authorizedApp.close();
  });

  it("requires organization management permission to update review policy", async () => {
    const updateReviewPolicy = vi.fn<ReconciliationRepository["updateReviewPolicy"]>(
      async (_tenant, input) => ({
        dualApprovalEnabled: input.dualApprovalEnabled,
        dualApprovalThresholds: input.dualApprovalThresholds,
        sensitiveResolutionTypes: input.sensitiveResolutionTypes,
        updatedAt: "2026-07-27T12:00:00.000Z",
      }),
    );
    const app = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage(), { updateReviewPolicy }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/organizations/${organizationId}/review-policy`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        dualApprovalEnabled: true,
        dualApprovalThresholds: { USD: "100000" },
        sensitiveResolutionTypes: ["write_off"],
        reason: "Raise the documented review threshold",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateReviewPolicy).toHaveBeenCalledWith(
      administratorTenant,
      expect.objectContaining({ dualApprovalThresholds: { USD: "100000" } }),
    );
    await app.close();
  });

  it("rejects unauthorized or duplicate review-policy input before repository mutation", async () => {
    const updateReviewPolicy = vi.fn<ReconciliationRepository["updateReviewPolicy"]>();
    const unauthorizedApp = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage(), { updateReviewPolicy }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const unauthorized = await unauthorizedApp.inject({
      method: "PATCH",
      url: `/v1/organizations/${organizationId}/review-policy`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        dualApprovalEnabled: true,
        dualApprovalThresholds: { USD: "100000" },
        sensitiveResolutionTypes: ["write_off"],
        reason: "Attempt an unauthorized policy change",
      },
    });
    expect(unauthorized.statusCode).toBe(404);
    expect(updateReviewPolicy).not.toHaveBeenCalled();
    await unauthorizedApp.close();

    const authorizedApp = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage(), { updateReviewPolicy }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const invalid = await authorizedApp.inject({
      method: "PATCH",
      url: `/v1/organizations/${organizationId}/review-policy`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        dualApprovalEnabled: true,
        dualApprovalThresholds: { USD: "100000" },
        sensitiveResolutionTypes: ["write_off", "write_off"],
        reason: "Attempt a duplicate sensitive policy",
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(updateReviewPolicy).not.toHaveBeenCalled();
    await authorizedApp.close();
  });

  it("uses retention permission, exact organization confirmation, and bounded policy input", async () => {
    const getRetentionPolicy = vi.fn<ReconciliationRepository["getRetentionPolicy"]>(async () => ({
      rawImportRetentionDays: null,
      providerEventRetentionDays: null,
      legalHoldEnabled: false,
      legalHoldReason: null,
      updatedAt: null,
    }));
    const updateRetentionPolicy = vi.fn<ReconciliationRepository["updateRetentionPolicy"]>(
      async (_tenant, input) => ({
        rawImportRetentionDays: input.rawImportRetentionDays,
        providerEventRetentionDays: input.providerEventRetentionDays,
        legalHoldEnabled: input.legalHoldEnabled,
        legalHoldReason: input.legalHoldReason,
        updatedAt: "2026-07-27T12:00:00.000Z",
      }),
    );
    const app = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage(), {
        getRetentionPolicy,
        updateRetentionPolicy,
      }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });

    const current = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/retention-policy`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      data: {
        rawImportRetentionDays: null,
        providerEventRetentionDays: null,
        legalHoldEnabled: false,
      },
    });

    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/organizations/${organizationId}/retention-policy`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        rawImportRetentionDays: 30,
        providerEventRetentionDays: 90,
        legalHoldEnabled: true,
        legalHoldReason: "Preserve evidence for a documented investigation",
        confirmOrganizationId: organizationId,
        reason: "Apply the approved retention schedule and legal hold",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updateRetentionPolicy).toHaveBeenCalledWith(administratorTenant, {
      rawImportRetentionDays: 30,
      providerEventRetentionDays: 90,
      legalHoldEnabled: true,
      legalHoldReason: "Preserve evidence for a documented investigation",
      reason: "Apply the approved retention schedule and legal hold",
    });

    const mismatch = await app.inject({
      method: "PATCH",
      url: `/v1/organizations/${organizationId}/retention-policy`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        rawImportRetentionDays: 30,
        providerEventRetentionDays: 90,
        legalHoldEnabled: false,
        legalHoldReason: null,
        confirmOrganizationId: otherOrganizationId,
        reason: "Attempt a mismatched organization confirmation",
      },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(updateRetentionPolicy).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rejects retention access or inconsistent legal-hold input before mutation", async () => {
    const updateRetentionPolicy = vi.fn<ReconciliationRepository["updateRetentionPolicy"]>();
    const unauthorizedApp = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage(), { updateRetentionPolicy }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const unauthorized = await unauthorizedApp.inject({
      method: "PATCH",
      url: `/v1/organizations/${organizationId}/retention-policy`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        rawImportRetentionDays: 30,
        providerEventRetentionDays: null,
        legalHoldEnabled: false,
        legalHoldReason: null,
        confirmOrganizationId: organizationId,
        reason: "Attempt an unauthorized retention policy change",
      },
    });
    expect(unauthorized.statusCode).toBe(404);
    await unauthorizedApp.close();

    const authorizedApp = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage(), { updateRetentionPolicy }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const invalid = await authorizedApp.inject({
      method: "PATCH",
      url: `/v1/organizations/${organizationId}/retention-policy`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        rawImportRetentionDays: 0,
        providerEventRetentionDays: null,
        legalHoldEnabled: true,
        legalHoldReason: null,
        confirmOrganizationId: organizationId,
        reason: "Attempt an invalid retention policy",
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(updateRetentionPolicy).not.toHaveBeenCalled();
    await authorizedApp.close();
  });

  it("lists only minimized privacy operations for a server-authorized administrator", async () => {
    const itemWithForbiddenRepositoryFields = {
      id: "00000000-0000-4000-8000-000000000041",
      connectionId: "00000000-0000-4000-8000-000000000042",
      provider: "shopify" as const,
      topic: "customers/redact" as const,
      apiVersion: "2026-07",
      externalAccountId: "synthetic-shop.myshopify.com",
      status: "action_required" as const,
      objectIdentifierCount: 2,
      receivedAt: "2026-07-28T01:00:00.000Z",
      dueAt: "2026-08-27T01:00:00.000Z",
      deadlineAlert: {
        stage: "due_7_days" as const,
        observedAt: "2026-08-20T01:00:00.000Z",
      },
      deletionProgress: {
        total: 2,
        pending: 1,
        processing: 0,
        retry: 0,
        deleted: 1,
        alreadyMissing: 0,
        deadLettered: 0,
      },
      customerId: "must-not-cross-the-api-boundary",
      externalObjectIds: ["must-not-cross-the-api-boundary"],
      payloadSha256: "must-not-cross-the-api-boundary",
      objectKey: "must-not-cross-the-api-boundary",
    };
    const list = vi.fn<ProviderPrivacyOperationsRepository["list"]>(async () => ({
      items: [itemWithForbiddenRepositoryFields],
      truncated: true,
      nextCursor: "tenant_cursor",
    }));
    const app = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      providerPrivacyOperations: { list },
      webOrigin: "http://localhost:3000",
      environment: "test",
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/provider-privacy-requests?limit=25`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [
        {
          provider: "shopify",
          topic: "customers/redact",
          objectIdentifierCount: 2,
          deadlineAlert: {
            stage: "due_7_days",
            observedAt: "2026-08-20T01:00:00.000Z",
          },
          deletionProgress: { total: 2, pending: 1, deleted: 1 },
        },
      ],
      meta: { truncated: true, maximumItems: 100, nextCursor: "tenant_cursor" },
    });
    expect(response.body).not.toContain("customerId");
    expect(response.body).not.toContain("externalObjectIds");
    expect(response.body).not.toContain("payloadSha256");
    expect(response.body).not.toContain("objectKey");
    expect(response.body).not.toContain("must-not-cross-the-api-boundary");
    expect(list).toHaveBeenCalledWith(administratorTenant, { limit: 25 });

    const nextPage = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/provider-privacy-requests?limit=25&cursor=tenant_cursor`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(nextPage.statusCode).toBe(200);
    expect(list).toHaveBeenLastCalledWith(administratorTenant, {
      limit: 25,
      cursor: "tenant_cursor",
    });
    await app.close();
  });

  it("conceals privacy operations from unauthorized and foreign tenant requests", async () => {
    const list = vi.fn<ProviderPrivacyOperationsRepository["list"]>(async () => ({
      items: [],
      truncated: false,
    }));
    const analystApp = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      providerPrivacyOperations: { list },
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const unauthorized = await analystApp.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/provider-privacy-requests`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(unauthorized.statusCode).toBe(404);
    expect(list).not.toHaveBeenCalled();
    await analystApp.close();

    const administratorApp = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      providerPrivacyOperations: { list },
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const foreign = await administratorApp.inject({
      method: "GET",
      url: `/v1/organizations/${otherOrganizationId}/provider-privacy-requests`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(foreign.statusCode).toBe(404);
    expect(list).not.toHaveBeenCalled();

    const unbounded = await administratorApp.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/provider-privacy-requests?limit=101`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(unbounded.statusCode).toBe(400);
    expect(list).not.toHaveBeenCalled();

    list.mockRejectedValueOnce(new ProviderPrivacyOperationsCursorError());
    const wrongTenantCursor = await administratorApp.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/provider-privacy-requests?cursor=tenant_cursor`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(wrongTenantCursor.statusCode).toBe(400);
    expect(wrongTenantCursor.json()).toMatchObject({ code: "INVALID_CURSOR" });
    await administratorApp.close();
  });

  it("prepares a bounded privacy evidence package through the dual-authorized tenant context", async () => {
    const packageId = "00000000-0000-4000-8000-000000000051";
    const requestId = "00000000-0000-4000-8000-000000000052";
    const body = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        packageId,
        request: { topic: "customers/data_request" },
      }),
      "utf8",
    );
    const prepare = vi.fn<ProviderPrivacyDataPackageService["prepare"]>(async () => ({
      id: packageId,
      filename: "reconai-shopify-customer-data-evidence.json",
      contentType: "application/json; charset=utf-8",
      body,
      receiptToken: "a".repeat(43),
      receiptExpiresAt: "2026-07-28T03:10:00.000Z",
    }));
    const acknowledgeReceipt = vi.fn<ProviderPrivacyDataPackageService["acknowledgeReceipt"]>();
    const app = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      providerPrivacyDataPackages: { prepare, acknowledgeReceipt },
      webOrigin: "http://localhost:3000",
      environment: "test",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/provider-privacy-requests/${requestId}/data-package`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        confirmed: true,
        reason: "Prepare evidence for controlled merchant review",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="reconai-shopify-customer-data-evidence.json"',
    );
    expect(response.headers["content-security-policy"]).toBe("sandbox");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-reconai-privacy-package-id"]).toBe(packageId);
    expect(response.headers["x-reconai-privacy-package-receipt-token"]).toBe("a".repeat(43));
    expect(response.headers["x-reconai-privacy-package-receipt-expires-at"]).toBe(
      "2026-07-28T03:10:00.000Z",
    );
    expect(response.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(response.rawPayload.byteLength).toBeGreaterThan(0);
    expect(response.json()).toMatchObject({ schemaVersion: 1, packageId });
    expect(prepare).toHaveBeenCalledOnce();
    const preparationCall = prepare.mock.calls[0];
    if (!preparationCall) throw new Error("expected a privacy package preparation call");
    expect(preparationCall[0]).toBe(administratorTenant);
    expect(preparationCall[1]).toMatchObject({
      requestId,
      reason: "Prepare evidence for controlled merchant review",
    });
    expect(preparationCall[1].correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    await app.close();
  });

  it("conceals privacy package preparation and maps fail-closed package errors", async () => {
    const requestId = "00000000-0000-4000-8000-000000000052";
    const prepare = vi.fn<ProviderPrivacyDataPackageService["prepare"]>();
    const acknowledgeReceipt = vi.fn<ProviderPrivacyDataPackageService["acknowledgeReceipt"]>();
    const analystApp = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      providerPrivacyDataPackages: { prepare, acknowledgeReceipt },
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const unauthorized = await analystApp.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/provider-privacy-requests/${requestId}/data-package`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: { confirmed: true, reason: "Attempt unauthorized export" },
    });
    expect(unauthorized.statusCode).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
    await analystApp.close();

    const administratorApp = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      providerPrivacyDataPackages: { prepare, acknowledgeReceipt },
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const missingConfirmation = await administratorApp.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/provider-privacy-requests/${requestId}/data-package`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: { confirmed: false, reason: "Prepare controlled response" },
    });
    expect(missingConfirmation.statusCode).toBe(400);
    expect(prepare).not.toHaveBeenCalled();

    prepare.mockRejectedValueOnce(new ProviderPrivacyDataPackageLimitError());
    const overLimit = await administratorApp.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/provider-privacy-requests/${requestId}/data-package`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: { confirmed: true, reason: "Prepare controlled response" },
    });
    expect(overLimit.statusCode).toBe(422);
    expect(overLimit.json()).toMatchObject({ code: "PRIVACY_DATA_PACKAGE_LIMIT_EXCEEDED" });

    prepare.mockRejectedValueOnce(new ProviderPrivacyDataPackageEvidenceError());
    const evidenceUnavailable = await administratorApp.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/provider-privacy-requests/${requestId}/data-package`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: { confirmed: true, reason: "Prepare controlled response" },
    });
    expect(evidenceUnavailable.statusCode).toBe(409);
    expect(evidenceUnavailable.json()).toMatchObject({
      code: "PRIVACY_DATA_EVIDENCE_UNAVAILABLE",
    });

    const foreign = await administratorApp.inject({
      method: "POST",
      url: `/v1/organizations/${otherOrganizationId}/provider-privacy-requests/${requestId}/data-package`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: { confirmed: true, reason: "Attempt foreign export" },
    });
    expect(foreign.statusCode).toBe(404);
    expect(prepare).toHaveBeenCalledTimes(2);
    await administratorApp.close();
  });

  it("records an idempotent tenant-authorized browser receipt and expires unused authority", async () => {
    const requestId = "00000000-0000-4000-8000-000000000052";
    const packageId = "00000000-0000-4000-8000-000000000053";
    const receiptToken = "a".repeat(43);
    const receipt = {
      packageId,
      contentSha256: "b".repeat(64),
      byteCount: 512,
      preparedAt: "2026-07-28T03:00:00.000Z",
      receiptExpiresAt: "2026-07-28T03:10:00.000Z",
      receivedAt: "2026-07-28T03:05:00.000Z",
    } as const;
    const prepare = vi.fn<ProviderPrivacyDataPackageService["prepare"]>();
    const acknowledgeReceipt = vi
      .fn<ProviderPrivacyDataPackageService["acknowledgeReceipt"]>()
      .mockResolvedValueOnce({ ...receipt, status: "acknowledged" })
      .mockResolvedValueOnce({ ...receipt, status: "already_acknowledged" })
      .mockRejectedValueOnce(new ProviderPrivacyDataPackageReceiptExpiredError());
    const app = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      providerPrivacyDataPackages: { prepare, acknowledgeReceipt },
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const url = `/v1/organizations/${organizationId}/provider-privacy-requests/${requestId}/data-package/${packageId}/receipt`;
    const request = {
      method: "POST" as const,
      url,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: { receiptToken },
    };

    const first = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(first.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(first.json()).toMatchObject({
      data: {
        packageId,
        status: "acknowledged",
        receivedAt: receipt.receivedAt,
      },
    });
    const repeat = await app.inject(request);
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toMatchObject({
      data: { packageId, status: "already_acknowledged" },
    });
    const receiptCall = acknowledgeReceipt.mock.calls[0];
    if (!receiptCall) throw new Error("expected a privacy package receipt call");
    expect(receiptCall[0]).toBe(administratorTenant);
    expect(receiptCall[1]).toMatchObject({ requestId, packageId, receiptToken });

    const expired = await app.inject(request);
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toMatchObject({
      code: "PRIVACY_DATA_PACKAGE_RECEIPT_EXPIRED",
    });
    const invalid = await app.inject({ ...request, payload: { receiptToken: "short" } });
    expect(invalid.statusCode).toBe(400);
    const foreign = await app.inject({
      ...request,
      url: `/v1/organizations/${otherOrganizationId}/provider-privacy-requests/${requestId}/data-package/${packageId}/receipt`,
    });
    expect(foreign.statusCode).toBe(404);
    expect(acknowledgeReceipt).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it("uses a server-authorized administrator context for membership lifecycle changes", async () => {
    const updateMember = vi.fn<ReconciliationRepository["updateMember"]>(
      async (_tenant, membershipId, input) => ({
        id: membershipId,
        userId: "00000000-0000-4000-8000-000000000009",
        role: input.role,
        status: input.status,
        createdAt: "2026-07-27T12:00:00.000Z",
        updatedAt: "2026-07-27T12:01:00.000Z",
      }),
    );
    const app = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage(), { updateMember }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const membershipId = "00000000-0000-4000-8000-000000000008";
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/organizations/${organizationId}/members/${membershipId}`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        role: "reviewer",
        status: "active",
        reason: "Move review duties to the finance control role",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateMember).toHaveBeenCalledWith(
      administratorTenant,
      membershipId,
      expect.objectContaining({ role: "reviewer", status: "active" }),
    );
    await app.close();
  });

  it("creates a bounded invitation through the authorized member-management context", async () => {
    const acceptToken = "a".repeat(43);
    const createInvitation = vi.fn<ReconciliationRepository["createInvitation"]>(
      async (_tenant, input) => ({
        id: "00000000-0000-4000-8000-000000000030",
        email: input.email,
        role: input.role,
        status: "pending",
        invitedByMembershipId: administratorTenant.membershipId,
        expiresAt: "2026-07-30T12:00:00.000Z",
        createdAt: "2026-07-27T12:00:00.000Z",
        updatedAt: "2026-07-27T12:00:00.000Z",
        acceptToken,
      }),
    );
    const recordInvitationDelivery = vi.fn<ReconciliationRepository["recordInvitationDelivery"]>(
      async () => undefined,
    );
    const deliver = vi.fn<InvitationEmailProvider["deliver"]>(async () => ({
      status: "accepted",
      provider: "http_webhook",
      providerMessageId: "message-123",
    }));
    const app = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage(), {
        createInvitation,
        recordInvitationDelivery,
      }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      invitationEmail: { name: "http_webhook", deliver },
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/invitations`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        email: " Reviewer@Example.Test ",
        role: "reviewer",
        reason: "Add the independent finance reviewer",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(createInvitation).toHaveBeenCalledWith(
      administratorTenant,
      expect.objectContaining({
        email: "reviewer@example.test",
        role: "reviewer",
      }),
    );
    expect(response.json()).toMatchObject({
      data: { status: "pending", acceptToken },
      meta: { delivery: { status: "accepted", auditRecorded: true } },
    });
    expect(deliver).toHaveBeenCalledOnce();
    const deliveryCall = deliver.mock.calls[0];
    if (!deliveryCall) throw new Error("expected an invitation delivery request");
    expect(deliveryCall[0]).toMatchObject({
      invitationId: "00000000-0000-4000-8000-000000000030",
      recipientEmail: "reviewer@example.test",
      role: "reviewer",
      acceptUrl: `http://localhost:3000/invitations/accept#token=${acceptToken}`,
    });
    expect(recordInvitationDelivery).toHaveBeenCalledOnce();
    const deliveryAudit = recordInvitationDelivery.mock.calls[0];
    if (!deliveryAudit) throw new Error("expected an invitation delivery audit");
    expect(deliveryAudit[0]).toBe(administratorTenant);
    expect(deliveryAudit[1]).toBe("00000000-0000-4000-8000-000000000030");
    expect(deliveryAudit[2]).toMatchObject({
      status: "accepted",
      provider: "http_webhook",
      providerMessageId: "message-123",
    });
    expect(JSON.stringify(deliveryAudit[2])).not.toContain(acceptToken);
    await app.close();
  });

  it("returns the one-time fallback link when invitation email delivery fails", async () => {
    const acceptToken = "c".repeat(43);
    const createInvitation = vi.fn<ReconciliationRepository["createInvitation"]>(
      async (_tenant, input) => ({
        id: "00000000-0000-4000-8000-000000000033",
        email: input.email,
        role: input.role,
        status: "pending",
        invitedByMembershipId: administratorTenant.membershipId,
        expiresAt: "2026-07-30T12:00:00.000Z",
        createdAt: "2026-07-27T12:00:00.000Z",
        updatedAt: "2026-07-27T12:00:00.000Z",
        acceptToken,
      }),
    );
    const recordInvitationDelivery = vi.fn<ReconciliationRepository["recordInvitationDelivery"]>(
      async () => undefined,
    );
    const app = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage(), {
        createInvitation,
        recordInvitationDelivery,
      }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      invitationEmail: {
        name: "http_webhook",
        deliver: async () => {
          throw new Error("synthetic delivery failure");
        },
      },
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/invitations`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        email: "reviewer@example.test",
        role: "reviewer",
        reason: "Add the independent finance reviewer",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      data: { acceptToken },
      meta: { delivery: { status: "failed", auditRecorded: true } },
    });
    expect(recordInvitationDelivery).toHaveBeenCalledWith(
      administratorTenant,
      "00000000-0000-4000-8000-000000000033",
      expect.objectContaining({
        status: "failed",
        provider: "http_webhook",
        errorCode: "PROVIDER_UNAVAILABLE",
      }),
    );
    await app.close();
  });

  it("accepts an invitation from verified identity without requiring an existing membership", async () => {
    const acceptedIdentity = {
      issuer: "https://issuer.test",
      subject: "new-user",
      email: "reviewer@example.test",
      emailVerified: true,
    };
    const acceptInvitation = vi.fn<ReconciliationRepository["acceptInvitation"]>(
      async (_identity, _token) => ({
        organizationId,
        invitationId: "00000000-0000-4000-8000-000000000030",
        membershipId: "00000000-0000-4000-8000-000000000031",
        userId: "00000000-0000-4000-8000-000000000032",
        role: "reviewer",
      }),
    );
    const resolve = vi.fn<MembershipDirectory["resolve"]>();
    const app = await buildApi({
      identityVerifier: {
        verifyAuthorizationHeader: async () => acceptedIdentity,
      },
      memberships: { ...memberships, resolve },
      repository: repositoryStub(async () => emptyExceptionPage(), { acceptInvitation }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const token = "b".repeat(43);
    const response = await app.inject({
      method: "POST",
      url: "/v1/invitations/accept",
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: { token },
    });

    expect(response.statusCode).toBe(201);
    expect(resolve).not.toHaveBeenCalled();
    const acceptanceCall = acceptInvitation.mock.calls[0];
    expect(acceptanceCall?.[0]).toEqual(acceptedIdentity);
    expect(acceptanceCall?.[1]).toBe(token);
    expect(acceptanceCall?.[2].correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    await app.close();
  });

  it("allows a financial operator to read tenant-scoped connector health", async () => {
    const listConnections = vi.fn<ReconciliationRepository["listConnections"]>(async () => [
      {
        id: "71000000-0000-4000-8000-000000000001",
        provider: "shopify",
        externalAccountId: "synthetic-shop.myshopify.com",
        status: "healthy",
        connectorVersion: "test-1",
        syncEnabled: true,
        retryCount: 0,
        deadLetterCount: 0,
        objectWatermarks: [
          {
            objectType: "order",
            observationState: "observed",
            latestSourceAt: "2026-07-29T00:01:00.000Z",
            latestReceivedAt: "2026-07-29T00:02:00.000Z",
          },
          { objectType: "refund_transaction", observationState: "never_observed" },
        ],
        updatedAt: "2026-07-29T00:02:00.000Z",
      },
    ]);
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage(), { listConnections }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/connections`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });

    expect(response.statusCode).toBe(200);
    expect(listConnections).toHaveBeenCalledWith(tenant);
    expect(response.json()).toMatchObject({
      data: [
        {
          provider: "shopify",
          objectWatermarks: [
            {
              objectType: "order",
              observationState: "observed",
              latestSourceAt: "2026-07-29T00:01:00.000Z",
              latestReceivedAt: "2026-07-29T00:02:00.000Z",
            },
            { objectType: "refund_transaction", observationState: "never_observed" },
          ],
        },
      ],
    });
    await app.close();
  });

  it("uses audit permission and tenant context for the bounded organization history", async () => {
    const listAuditEvents = vi.fn<ReconciliationRepository["listAuditEvents"]>(async () => []);
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage(), { listAuditEvents }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/audit-events?limit=25`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });

    expect(response.statusCode).toBe(200);
    expect(listAuditEvents).toHaveBeenCalledWith(tenant, { limit: 25 });
    await app.close();
  });

  it("uses the authorized reviewer context for exception workflow changes", async () => {
    const updateExceptionWorkflow = vi.fn<ReconciliationRepository["updateExceptionWorkflow"]>(
      async (_tenant, exceptionId) => ({
        id: exceptionId,
        status: "assigned",
        assigneeMembershipId: tenant.membershipId,
      }),
    );
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage(), { updateExceptionWorkflow }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const exceptionId = "00000000-0000-4000-8000-000000000009";
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/organizations/${organizationId}/exceptions/${exceptionId}`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        action: "assign_self",
        reason: "I am investigating the underlying payment evidence",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateExceptionWorkflow).toHaveBeenCalledWith(tenant, exceptionId, {
      action: "assign_self",
      reason: "I am investigating the underlying payment evidence",
    });
    await app.close();
  });

  it("creates immutable proposal revisions only through exception-review authority", async () => {
    const exceptionId = "00000000-0000-4000-8000-000000000013";
    const proposalId = "00000000-0000-4000-8000-000000000014";
    const priorProposalId = "00000000-0000-4000-8000-000000000015";
    const createProposal = vi.fn<ReconciliationRepository["createProposal"]>(async () => ({
      id: proposalId,
      version: 2,
      revisedFrom: {
        id: priorProposalId,
        version: 1,
        approvalCount: 1,
      },
    }));
    const repository = repositoryStub(async () => emptyExceptionPage(), { createProposal });
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository,
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const request = {
      method: "POST" as const,
      url: `/v1/organizations/${organizationId}/exceptions/${exceptionId}/proposals`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        type: "investigate_source_record",
        reason: "Revise the proposal after reviewing stronger source evidence",
      },
    };

    const response = await app.inject(request);

    expect(response.statusCode).toBe(201);
    expect(createProposal).toHaveBeenCalledWith(tenant, exceptionId, request.payload);
    expect(response.json()).toMatchObject({
      data: {
        id: proposalId,
        version: 2,
        revisedFrom: {
          id: priorProposalId,
          version: 1,
          approvalCount: 1,
        },
      },
    });
    await app.close();

    const deniedApp = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? auditorTenant : undefined,
      },
      repository,
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const denied = await deniedApp.inject(request);
    expect(denied.statusCode).toBe(404);
    expect(createProposal).toHaveBeenCalledTimes(1);
    await deniedApp.close();
  });

  it("records final approval timing without exposing internal timestamps", async () => {
    const proposalId = "00000000-0000-4000-8000-000000000011";
    const approvalId = "00000000-0000-4000-8000-000000000012";
    const approveProposal = vi.fn<ReconciliationRepository["approveProposal"]>(async () => ({
      id: approvalId,
      decision: "approve",
      status: "approved",
      approvalCount: 2,
      requiredApprovals: 2,
      proposalCreatedAt: "2026-07-29T00:00:00.000Z",
      decidedAt: "2026-07-29T00:00:10.000Z",
      exceptionCreatedAt: "2026-07-28T00:00:00.000Z",
      exceptionStatusChangedAt: "2026-07-29T00:00:10.000Z",
    }));
    const app = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? reviewerTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage(), { approveProposal }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/proposals/${proposalId}/approvals`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        decision: "approve",
        reason: "Independent reviewer confirms the evidence",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(approveProposal).toHaveBeenCalledWith(reviewerTenant, proposalId, {
      decision: "approve",
      reason: "Independent reviewer confirms the evidence",
    });
    const responseBody: unknown = response.json();
    expect(responseBody).toMatchObject({
      data: {
        id: approvalId,
        decision: "approve",
        status: "approved",
        approvalCount: 2,
        requiredApprovals: 2,
      },
    });
    if (
      !isRecord(responseBody) ||
      !isRecord(responseBody["meta"]) ||
      typeof responseBody["meta"]["correlationId"] !== "string"
    ) {
      throw new Error("expected a proposal-decision response correlation ID");
    }
    expect(responseBody["meta"]["correlationId"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(response.body).not.toContain("proposalCreatedAt");
    expect(response.body).not.toContain("decidedAt");
    expect(response.body).not.toContain("exceptionCreatedAt");
    expect(response.body).not.toContain("exceptionStatusChangedAt");
    await app.close();
  });

  it("records bounded append-only notes through the authorized reviewer context", async () => {
    const addExceptionNote = vi.fn<ReconciliationRepository["addExceptionNote"]>(
      async (_tenant, _exceptionId, body) => ({
        id: "00000000-0000-4000-8000-000000000010",
        authorMembershipId: tenant.membershipId,
        body,
        createdAt: "2026-07-27T12:00:00.000Z",
      }),
    );
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage(), { addExceptionNote }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const exceptionId = "00000000-0000-4000-8000-000000000009";
    const response = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/exceptions/${exceptionId}/notes`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: { body: "Stripe evidence verified against the immutable payload." },
    });

    expect(response.statusCode).toBe(201);
    expect(addExceptionNote).toHaveBeenCalledWith(
      tenant,
      exceptionId,
      "Stripe evidence verified against the immutable payload.",
    );
    await app.close();
  });

  it("lists only tenant-authorized reconciliation run summaries", async () => {
    const listRuns = vi.fn<ReconciliationRepository["listRuns"]>(async () => []);
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage(), { listRuns }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/reconciliation-runs?limit=25`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });

    expect(response.statusCode).toBe(200);
    expect(listRuns).toHaveBeenCalledWith(tenant, { limit: 25 });
    await app.close();
  });

  it("returns bounded run occurrence evidence through tenant authorization", async () => {
    const runId = "00000000-0000-4000-8000-000000000021";
    const exceptionId = "00000000-0000-4000-8000-000000000041";
    const getRun = vi.fn<ReconciliationRepository["getRun"]>(async () => ({
      ...runReceipt("finance-v1"),
      status: "succeeded",
      matchCount: 1,
      exceptionCount: 1,
      operationalStateApplied: true,
      inputSnapshotHash: "b".repeat(64),
      policySnapshotHash: "c".repeat(64),
      policySnapshot: { version: "finance-v1" },
      initiatedBy: tenant.actorId,
      inputRecords: [],
      inputRecordsTruncated: false,
      matches: [
        {
          id: "00000000-0000-4000-8000-000000000040",
          ruleId: "refund-accounting",
          ruleVersion: "1.4.0",
          recordReferences: [],
          recordReferencesStatus: "available",
          evidence: deterministicEvidence("REFUND_ACCOUNTING_ENTRY_MATCHED"),
          evidenceFidelity: "exact_at_observation",
          observedAt: "2026-07-27T12:00:02.000Z",
        },
      ],
      matchesTruncated: false,
      exceptions: [
        {
          id: exceptionId,
          type: "duplicate_processing_fee",
          observedStatus: "open",
          currentStatus: "open",
          severity: "high",
          recordReferences: [],
          recordReferencesStatus: "available",
          evidence: deterministicEvidence("DUPLICATE_SOURCE_EXTERNAL_IDENTIFIER", "fail"),
          evidenceFidelity: "exact_at_observation",
          observedAt: "2026-07-27T12:00:02.000Z",
        },
      ],
      exceptionsTruncated: false,
    }));
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage(), { getRun }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/reconciliation-runs/${runId}`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });

    expect(response.statusCode).toBe(200);
    expect(getRun).toHaveBeenCalledWith(tenant, runId);
    expect(response.json()).toMatchObject({
      data: {
        id: runId,
        matches: [
          {
            ruleId: "refund-accounting",
            evidenceFidelity: "exact_at_observation",
            evidence: { reasonCode: "REFUND_ACCOUNTING_ENTRY_MATCHED" },
          },
        ],
        exceptions: [
          {
            id: exceptionId,
            type: "duplicate_processing_fee",
            evidenceFidelity: "exact_at_observation",
          },
        ],
      },
    });
    await app.close();
  });

  it("pages immutable run artifacts without trusting a client tenant or cursor", async () => {
    const runId = "00000000-0000-4000-8000-000000000021";
    const cursor = "opaque_cursor";
    const nextCursor = "next_opaque_cursor";
    const listRunArtifacts = vi.fn<ReconciliationRepository["listRunArtifacts"]>(async () => ({
      type: "match",
      items: [
        {
          id: "00000000-0000-4000-8000-000000000040",
          ruleId: "refund-accounting-split",
          ruleVersion: "1.5.0",
          recordReferences: [
            "00000000-0000-4000-8000-000000000031",
            "00000000-0000-4000-8000-000000000032",
            "00000000-0000-4000-8000-000000000033",
          ],
          recordReferencesStatus: "available",
          evidence: deterministicEvidence("REFUND_ACCOUNTING_SPLIT_TOTAL_MATCHED"),
          evidenceFidelity: "exact_at_observation",
          observedAt: "2026-07-29T00:00:02.000Z",
        },
      ],
      nextCursor,
    }));
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage(), { listRunArtifacts }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/reconciliation-runs/${runId}/artifacts?type=match&limit=25&cursor=${cursor}`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });

    expect(response.statusCode).toBe(200);
    expect(listRunArtifacts).toHaveBeenCalledWith(tenant, runId, {
      type: "match",
      limit: 25,
      cursor,
    });
    expect(response.json()).toMatchObject({
      data: {
        type: "match",
        items: [
          {
            ruleId: "refund-accounting-split",
            evidenceFidelity: "exact_at_observation",
            evidence: { reasonCode: "REFUND_ACCOUNTING_SPLIT_TOTAL_MATCHED" },
          },
        ],
      },
      meta: { nextCursor },
    });

    const foreign = await app.inject({
      method: "GET",
      url: `/v1/organizations/${otherOrganizationId}/reconciliation-runs/${runId}/artifacts?type=match`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(listRunArtifacts).toHaveBeenCalledTimes(1);

    const malformed = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/reconciliation-runs/${runId}/artifacts?type=match&cursor=not%2Bbase64`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(listRunArtifacts).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("pages immutable pinned run inputs without trusting a client tenant or cursor", async () => {
    const runId = "00000000-0000-4000-8000-000000000021";
    const cursor = "opaque_input_cursor";
    const nextCursor = "next_opaque_input_cursor";
    const listRunInputs = vi.fn<ReconciliationRepository["listRunInputs"]>(async () => ({
      items: [
        {
          id: "00000000-0000-4000-8000-000000000031",
          version: 3,
          contentSha256: "a".repeat(64),
          ordinal: 100,
        },
      ],
      nextCursor,
    }));
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage(), { listRunInputs }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/reconciliation-runs/${runId}/inputs?limit=100&cursor=${cursor}`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });

    expect(response.statusCode).toBe(200);
    expect(listRunInputs).toHaveBeenCalledWith(tenant, runId, {
      limit: 100,
      cursor,
    });
    expect(response.json()).toMatchObject({
      data: [
        {
          version: 3,
          contentSha256: "a".repeat(64),
          ordinal: 100,
        },
      ],
      meta: { nextCursor },
    });

    const foreign = await app.inject({
      method: "GET",
      url: `/v1/organizations/${otherOrganizationId}/reconciliation-runs/${runId}/inputs`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(listRunInputs).toHaveBeenCalledTimes(1);

    const malformed = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/reconciliation-runs/${runId}/inputs?cursor=not%2Bbase64`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(listRunInputs).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("pins a bounded policy through the authorized run request", async () => {
    const startRun = vi.fn<ReconciliationRepository["startRun"]>(async (_tenant, policy) =>
      runReceipt(policy.version),
    );
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage(), { startRun }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/reconciliation-runs`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      },
      payload: {
        policyVersion: "finance-v1",
        evaluatedAt: "2026-07-27T12:00:00.000Z",
        amountToleranceMinor: { USD: "25" },
        dateWindowSeconds: 86_400,
        delayedEventGraceSeconds: 3_600,
        businessTimeZone: "Asia/Manila",
        reason: "Run the daily authorized close reconciliation",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(startRun).toHaveBeenCalledWith(
      tenant,
      expect.objectContaining({
        version: "finance-v1",
        amountToleranceMinor: { USD: 25n },
        businessTimeZone: "Asia/Manila",
      }),
      expect.objectContaining({
        reason: "Run the daily authorized close reconciliation",
      }),
    );
    const startRequest = startRun.mock.calls[0]?.[2];
    expect(startRequest?.signal).toBeInstanceOf(AbortSignal);
    expect(startRequest?.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(startRequest?.traceparent).toBeUndefined();
    await app.close();
  });

  it("returns a sanitized retryable response when run authority creation is interrupted", async () => {
    const startRun = vi.fn<ReconciliationRepository["startRun"]>(async () => {
      throw new RepositoryRunCreationUnavailableError("admission_saturated");
    });
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage(), { startRun }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/reconciliation-runs`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        policyVersion: "finance-v1",
        evaluatedAt: "2026-07-27T12:00:00.000Z",
        amountToleranceMinor: { USD: "25" },
        dateWindowSeconds: 86_400,
        delayedEventGraceSeconds: 3_600,
        businessTimeZone: "Asia/Manila",
        reason: "Run the daily authorized close reconciliation",
      },
    });

    expect(response.statusCode).toBe(503);
    const responseBody = response.json<unknown>();
    expect(responseBody).toMatchObject({
      code: "RECONCILIATION_RUN_CREATION_UNAVAILABLE",
      message: "reconciliation run creation was interrupted; retry safely",
    });
    expect(isRecord(responseBody) && typeof responseBody["correlationId"]).toBe("string");
    expect(response.body).not.toContain("transaction timeout");
    expect(response.body).not.toContain("25P04");
    expect(response.body).not.toContain("admission_saturated");
    await app.close();
  });

  it("replays a failed run only through authorized tenant context", async () => {
    const replayRun = vi.fn<ReconciliationRepository["replayRun"]>(async (_tenant, _runId) => ({
      ...runReceipt("finance-v1"),
      dispatchCount: 2,
    }));
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage(), { replayRun }),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const runId = "00000000-0000-4000-8000-000000000021";
    const response = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/reconciliation-runs/${runId}/replay`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: { reason: "Retry after the documented transient database interruption" },
    });

    expect(response.statusCode).toBe(202);
    expect(replayRun).toHaveBeenCalledWith(
      tenant,
      runId,
      expect.objectContaining({
        reason: "Retry after the documented transient database interruption",
      }),
    );
    await app.close();
  });

  it("starts and lists only bounded provider sync runs through connector administration", async () => {
    const syncRun = {
      id: "00000000-0000-4000-8000-000000000031",
      organizationId,
      connectionId: "00000000-0000-4000-8000-000000000032",
      provider: "stripe" as const,
      mode: "gap_repair" as const,
      windowStart: "2026-07-26T00:00:00.000Z",
      windowEnd: "2026-07-27T00:00:00.000Z",
      status: "queued" as const,
      pageCount: 0,
      itemCount: 0,
      duplicateCount: 0,
      maximumPages: 5,
      failedAttempts: 0,
      requesterType: "user" as const,
      createdAt: "2026-07-27T12:00:00.000Z",
    };
    const start = vi.fn<ProviderSyncManager["start"]>(async () => syncRun);
    const list = vi.fn<ProviderSyncManager["list"]>(async () => [syncRun]);
    const app = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      providerSyncs: { start, list },
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const connectionId = syncRun.connectionId;
    const startResponse = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/connections/${connectionId}/provider-sync-runs`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      },
      payload: {
        mode: "gap_repair",
        windowStart: syncRun.windowStart,
        windowEnd: syncRun.windowEnd,
        maximumPages: 5,
        confirmOrganizationId: organizationId,
        reason: "Repair the bounded Stripe event gap after an outage",
      },
    });

    expect(startResponse.statusCode).toBe(202);
    expect(start).toHaveBeenCalledWith(
      administratorTenant,
      expect.objectContaining({
        connectionId,
        mode: "gap_repair",
        maximumPages: 5,
      }),
    );
    expect(start.mock.calls[0]?.[1].traceparent).toBeUndefined();
    const listResponse = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/provider-sync-runs?connectionId=${connectionId}`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(listResponse.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(administratorTenant, connectionId);

    const conflictResponse = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/connections/${connectionId}/provider-sync-runs`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        mode: "gap_repair",
        windowStart: syncRun.windowStart,
        windowEnd: syncRun.windowEnd,
        maximumPages: 5,
        confirmOrganizationId: otherOrganizationId,
        reason: "Repair the bounded Stripe event gap after an outage",
      },
    });
    expect(conflictResponse.statusCode).toBe(409);
    expect(start).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("limits sealed credential rotation, metadata, and disconnect to connector administrators", async () => {
    const connectionId = "00000000-0000-4000-8000-000000000032";
    const credential = {
      id: "00000000-0000-4000-8000-000000000033",
      connectionId,
      purpose: "api_read" as const,
      status: "active" as const,
      keyVersion: "v1",
      createdByMembershipId: administratorTenant.membershipId,
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    };
    const list = vi.fn<ConnectorCredentialLifecycleManager["list"]>(async () => [credential]);
    const rotate = vi.fn<ConnectorCredentialLifecycleManager["rotate"]>(async () => ({
      credential,
      replayed: false,
    }));
    const localDisconnect = vi.fn<ConnectorCredentialLifecycleManager["disconnect"]>(async () => ({
      connectionId,
      status: "disconnected",
      revoked: 1,
    }));
    const disconnect = vi.fn<ProviderDisconnectFlow["disconnect"]>(async () => ({
      connectionId,
      provider: "stripe",
      status: "disconnected",
      revoked: 1,
      providerConfirmation: "confirmed",
      replayed: false,
    }));
    const connectorCredentials = { list, rotate, disconnect: localDisconnect };
    const adminApp = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      connectorCredentials,
      providerDisconnects: { disconnect },
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
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
    const rotateResponse = await adminApp.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/connections/${connectionId}/credentials/rotations`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        purpose: "api_read",
        envelope,
        confirmConnectionId: connectionId,
        reason: "Rotate the bounded read credential under the active encryption key",
      },
    });
    expect(rotateResponse.statusCode).toBe(201);
    expect(rotate).toHaveBeenCalledWith(
      administratorTenant,
      expect.objectContaining({
        connectionId,
        purpose: "api_read",
        envelope,
      }),
    );
    const listResponse = await adminApp.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/connections/${connectionId}/credentials`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.body).not.toContain("encryptedEnvelope");
    const disconnectResponse = await adminApp.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/connections/${connectionId}/disconnect`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        confirmConnectionId: connectionId,
        reason: "Revoke ReconAI provider access at the operator's request",
      },
    });
    expect(disconnectResponse.statusCode).toBe(200);
    expect(disconnect).toHaveBeenCalledWith(
      administratorTenant,
      expect.objectContaining({ connectionId, confirmConnectionId: connectionId }),
    );
    await adminApp.close();

    const analystList = vi.fn<ConnectorCredentialLifecycleManager["list"]>(async () => []);
    const analystApp = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      connectorCredentials: {
        list: analystList,
        rotate,
        disconnect: localDisconnect,
      },
      providerDisconnects: { disconnect },
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const denied = await analystApp.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/connections/${connectionId}/credentials`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(denied.statusCode).toBe(404);
    expect(analystList).not.toHaveBeenCalled();
    await analystApp.close();
  });

  it("keeps provider authorization start and callback behind connector administration", async () => {
    const attemptId = "00000000-0000-4000-8000-000000000034";
    const connectionId = "00000000-0000-4000-8000-000000000035";
    const state = "A".repeat(43);
    const start = vi.fn<ProviderAuthorizationFlow["start"]>(async () => ({
      attemptId,
      connectionId,
      provider: "stripe",
      authorizationUrl: `https://marketplace.stripe.com/oauth/v2/authorize?state=${state}`,
      expiresAt: "2026-07-28T01:10:00.000Z",
    }));
    const callback = vi.fn<ProviderAuthorizationFlow["callback"]>(async () => ({
      attemptId,
      connectionId,
      provider: "stripe",
      status: "succeeded",
      replayed: false,
      externalAccountId: "acct_synthetic",
    }));
    const providerAuthorizations = { start, callback };
    const adminApp = await buildApi({
      identityVerifier,
      memberships: {
        ...memberships,
        resolve: async (_identity, requested) =>
          requested === organizationId ? administratorTenant : undefined,
      },
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      providerAuthorizations,
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const startResponse = await adminApp.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/provider-authorizations`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: { provider: "stripe" },
    });
    expect(startResponse.statusCode).toBe(201);
    expect(start).toHaveBeenCalledWith(
      administratorTenant,
      expect.objectContaining({ provider: "stripe" }),
    );
    const query = [
      ["code", "synthetic-authorization-code"],
      ["state", state],
    ] as const;
    const callbackResponse = await adminApp.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/provider-authorizations/${attemptId}/callback`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: { provider: "stripe", query },
    });
    expect(callbackResponse.statusCode).toBe(201);
    expect(callback).toHaveBeenCalledWith(
      administratorTenant,
      expect.objectContaining({ attemptId, provider: "stripe", query }),
    );
    await adminApp.close();

    const analystStart = vi.fn<ProviderAuthorizationFlow["start"]>(async () => ({
      attemptId,
      connectionId,
      provider: "stripe",
      authorizationUrl: `https://marketplace.stripe.com/oauth/v2/authorize?state=${state}`,
      expiresAt: "2026-07-28T01:10:00.000Z",
    }));
    const analystApp = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      providerAuthorizations: { start: analystStart, callback },
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const denied = await analystApp.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/provider-authorizations`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: { provider: "stripe" },
    });
    expect(denied.statusCode).toBe(404);
    expect(analystStart).not.toHaveBeenCalled();
    await analystApp.close();
  });

  it("keeps support request and diagnostic routes closed without platform identity authority", async () => {
    const createRequest = vi.fn<SupportAccessRepository["createRequest"]>(async () => ({
      requestCode: SupportAccessRequestCodeSchema.parse("a".repeat(43)),
      requestExpiresAt: "2026-07-29T01:15:00.000Z",
    }));
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      supportAccess: supportAccessStub({ createRequest }),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/support/access-requests",
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: { requestedDurationMinutes: 30 },
    });
    expect(response.statusCode).toBe(404);
    expect(createRequest).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires platform support identity for an unbound request and exact active grant diagnostics", async () => {
    const supportIdentityDigest = SupportIdentityDigestSchema.parse("a".repeat(64));
    const grantId = SupportAccessGrantIdSchema.parse("00000000-0000-4000-8000-000000000040");
    const createRequest = vi.fn<SupportAccessRepository["createRequest"]>(async () => ({
      requestCode: SupportAccessRequestCodeSchema.parse("b".repeat(43)),
      requestExpiresAt: "2026-07-29T01:15:00.000Z",
    }));
    const diagnostics = vi.fn<SupportAccessRepository["diagnostics"]>(async () => ({
      schemaVersion: "support-diagnostics-v1",
      generatedAt: "2026-07-29T01:05:00.000Z",
      grantExpiresAt: "2026-07-29T01:35:00.000Z",
      countsCapped: false,
      connections: { total: 2, nonHealthy: 1 },
      providerSyncs: { active: 1, failed: 0 },
      reconciliations: { active: 0, failedOrPartial: 0 },
      exceptions: { unresolved: 3 },
      outbox: { unpublished: 1, deadLettered: 0 },
    }));
    const app = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      supportIdentityAuthorizer: { authorize: () => supportIdentityDigest },
      supportAccess: supportAccessStub({ createRequest, diagnostics }),
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const created = await app.inject({
      method: "POST",
      url: "/v1/support/access-requests",
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: { requestedDurationMinutes: 30 },
    });
    expect(created.statusCode).toBe(201);
    expect(createRequest).toHaveBeenCalledWith(supportIdentityDigest, {
      requestedDurationMinutes: 30,
    });

    const observed = await app.inject({
      method: "GET",
      url: `/v1/support/organizations/${organizationId}/diagnostics?grantId=${grantId}`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(observed.statusCode).toBe(200);
    expect(diagnostics).toHaveBeenCalledWith(
      organizationId,
      grantId,
      supportIdentityDigest,
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
    );
    expect(observed.body).not.toContain("externalAccountId");
    expect(observed.body).not.toContain("amountMinor");
    await app.close();
  });

  it("lets only an owner approve, list, and revoke an exactly confirmed support grant", async () => {
    const grantId = SupportAccessGrantIdSchema.parse("00000000-0000-4000-8000-000000000041");
    const requestCode = SupportAccessRequestCodeSchema.parse("c".repeat(43));
    const grant = {
      id: grantId,
      supportIdentityReference: "a".repeat(12),
      capability: "diagnostics:view",
      ticketReference: "SUP-1042",
      reason: "Investigate delayed provider synchronization",
      approvedAt: "2026-07-29T01:00:00.000Z",
      expiresAt: "2026-07-29T01:30:00.000Z",
      status: "active",
    } as const;
    const approve = vi.fn<SupportAccessRepository["approve"]>(async () => grant);
    const list = vi.fn<SupportAccessRepository["list"]>(async () => [grant]);
    const revoke = vi.fn<SupportAccessRepository["revoke"]>(async () => ({
      outcome: "revoked",
      grant: {
        id: grantId,
        supportIdentityReference: "a".repeat(12),
        capability: "diagnostics:view",
        ticketReference: "SUP-1042",
        expiresAt: grant.expiresAt,
        revokedAt: "2026-07-29T01:10:00.000Z",
      },
    }));
    const supportAccess = supportAccessStub({ approve, list, revoke });
    const ownerMemberships: MembershipDirectory = {
      ...memberships,
      resolve: async (_identity, requested) =>
        requested === organizationId ? ownerTenant : undefined,
    };
    const ownerApp = await buildApi({
      identityVerifier,
      memberships: ownerMemberships,
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      supportAccess,
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const approved = await ownerApp.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/support-access-grants`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        requestCode,
        confirmOrganizationId: organizationId,
        ticketReference: "SUP-1042",
        reason: grant.reason,
      },
    });
    expect(approved.statusCode).toBe(201);
    expect(approve).toHaveBeenCalledWith(
      ownerTenant,
      expect.objectContaining({
        requestCode,
        ticketReference: "SUP-1042",
        reason: grant.reason,
      }),
    );
    const listed = await ownerApp.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/support-access-grants?limit=20`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(listed.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(ownerTenant, 20);
    const revoked = await ownerApp.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/support-access-grants/${grantId}/revoke`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        confirmOrganizationId: organizationId,
        reason: "Customer owner ended the support session",
      },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoke).toHaveBeenCalledWith(
      ownerTenant,
      expect.objectContaining({ grantId, reason: "Customer owner ended the support session" }),
    );

    const mismatched = await ownerApp.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/support-access-grants`,
      headers: {
        authorization: "Bearer synthetic-unit-test-token-value",
        "content-type": "application/json",
      },
      payload: {
        requestCode,
        confirmOrganizationId: otherOrganizationId,
        ticketReference: "SUP-1042",
        reason: grant.reason,
      },
    });
    expect(mismatched.statusCode).toBe(404);
    await ownerApp.close();

    const analystApp = await buildApi({
      identityVerifier,
      memberships,
      repository: repositoryStub(async () => emptyExceptionPage()),
      csvImports: csvImportStub(),
      providerWebhooks: providerWebhookStub(),
      supportAccess,
      webOrigin: "http://localhost:3000",
      environment: "test",
    });
    const denied = await analystApp.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/support-access-grants`,
      headers: { authorization: "Bearer synthetic-unit-test-token-value" },
    });
    expect(denied.statusCode).toBe(404);
    await analystApp.close();
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function emptyExceptionPage() {
  return {
    items: [],
    filteredCount: 0,
    summary: { open: 0, high: 0, awaitingApproval: 0, decided: 0 },
  } as const;
}

function repositoryStub(
  listExceptions: ReconciliationRepository["listExceptions"],
  overrides: Partial<ReconciliationRepository> = {},
): ReconciliationRepository {
  return {
    health: async () => true,
    listExceptions,
    exportExceptions: async () => {
      throw new Error("not used");
    },
    getException: async () => undefined,
    addExceptionNote: async () => {
      throw new Error("not used");
    },
    updateExceptionWorkflow: async () => {
      throw new Error("not used");
    },
    listRuns: async () => {
      throw new Error("not used");
    },
    getRun: async () => undefined,
    listRunArtifacts: async () => undefined,
    listRunInputs: async () => undefined,
    startRun: async () => {
      throw new Error("not used");
    },
    replayRun: async () => {
      throw new Error("not used");
    },
    createProposal: async () => {
      throw new Error("not used");
    },
    approveProposal: async () => {
      throw new Error("not used");
    },
    getOrganizationProfile: async () => {
      throw new Error("not used");
    },
    updateOrganizationProfile: async () => {
      throw new Error("not used");
    },
    getReviewPolicy: async () => {
      throw new Error("not used");
    },
    updateReviewPolicy: async () => {
      throw new Error("not used");
    },
    getRetentionPolicy: async () => {
      throw new Error("not used");
    },
    updateRetentionPolicy: async () => {
      throw new Error("not used");
    },
    listMembers: async () => {
      throw new Error("not used");
    },
    updateMember: async () => {
      throw new Error("not used");
    },
    listInvitations: async () => {
      throw new Error("not used");
    },
    createInvitation: async () => {
      throw new Error("not used");
    },
    recordInvitationDelivery: async () => undefined,
    revokeInvitation: async () => {
      throw new Error("not used");
    },
    acceptInvitation: async () => {
      throw new Error("not used");
    },
    listConnections: async () => {
      throw new Error("not used");
    },
    listAuditEvents: async () => {
      throw new Error("not used");
    },
    ...overrides,
  };
}

function csvImportStub(
  overrides: Partial<ApiDependencies["csvImports"]> = {},
): ApiDependencies["csvImports"] {
  return {
    createPreview: async () => {
      throw new Error("not used");
    },
    getImport: async () => undefined,
    listImports: async () => [],
    commitImport: async () => {
      throw new Error("not used");
    },
    rollbackImport: async () => {
      throw new Error("not used");
    },
    ...overrides,
  };
}

function providerWebhookStub(
  overrides: Partial<ApiDependencies["providerWebhooks"]> = {},
): ApiDependencies["providerWebhooks"] {
  return {
    receiveShopify: async () => {
      throw new Error("not used");
    },
    receiveStripe: async () => {
      throw new Error("not used");
    },
    ...overrides,
  };
}

function supportAccessStub(
  overrides: Partial<SupportAccessRepository> = {},
): SupportAccessRepository {
  return {
    createRequest: async () => {
      throw new Error("not used");
    },
    approve: async () => {
      throw new Error("not used");
    },
    list: async () => {
      throw new Error("not used");
    },
    revoke: async () => {
      throw new Error("not used");
    },
    diagnostics: async () => {
      throw new Error("not used");
    },
    ...overrides,
  };
}

function runReceipt(policyVersion: string) {
  return {
    id: "00000000-0000-4000-8000-000000000021",
    stableRunKey: "a".repeat(64),
    status: "queued" as const,
    policyVersion,
    ruleSetVersion: "1.4.0",
    engineVersion: "0.6.0",
    inputCount: 3,
    matchCount: 0,
    exceptionCount: 0,
    errorCount: 0,
    dispatchCount: 1,
    operationalStateApplied: false,
    createdAt: "2026-07-27T12:00:00.000Z",
  };
}

function deterministicEvidence(
  reasonCode: string,
  result: "pass" | "fail" = "pass",
): DeterministicEvidenceView {
  return {
    schemaVersion: "deterministic-evidence-view-v1",
    status: "available",
    ruleId: "synthetic-rule",
    ruleVersion: "1.5.0",
    ruleSetVersion: "1.5.0",
    sourceRecordCount: 0,
    evidenceTruncated: false,
    comparisons: [],
    result,
    reasonCode,
    evaluatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function csvReceipt(): CsvImportReceipt {
  return {
    id: "00000000-0000-4000-8000-000000000007",
    organizationId,
    connectionId: "00000000-0000-4000-8000-000000000008",
    status: "previewed",
    objectKey:
      "test/00000000-0000-4000-8000-000000000001/imports/00000000-0000-4000-8000-000000000007/payload.csv",
    payloadSha256: "a".repeat(64),
    byteCount: 128,
    contentType: "text/csv",
    originalFilename: "ledger.csv",
    templateVersion: "accounting-v1",
    mappingVersion: "mapping-v1",
    mapping: {
      externalId: "id",
      transactionReference: "reference",
      orderReference: "order",
      amount: "amount",
      currency: "currency",
      effectiveAt: "effective_at",
      entryType: "type",
    },
    idempotencyKey: "b".repeat(64),
    rowCount: 1,
    validRowCount: 1,
    invalidRowCount: 0,
    previewRows: [{ id: "entry-1" }],
    previewErrors: [],
    errorsTruncated: false,
    uploadedBy: administratorTenant.actorId,
    uploadedAt: "2026-07-27T12:00:00.000Z",
  };
}

function multipartCsv(boundary: string): Buffer {
  const metadata = JSON.stringify({
    connectionId: "00000000-0000-4000-8000-000000000008",
    templateVersion: "accounting-v1",
    mappingVersion: "mapping-v1",
    mapping: {
      externalId: "id",
      transactionReference: "reference",
      orderReference: "order",
      amount: "amount",
      currency: "currency",
      effectiveAt: "effective_at",
      entryType: "type",
    },
  });
  const csv = [
    "id,reference,order,amount,currency,effective_at,type",
    "entry-1,refund-1,order-1,25.00,USD,2026-07-27T00:00:00.000Z,refund",
  ].join("\n");
  return Buffer.from(
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="metadata"',
      "",
      metadata,
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="ledger.csv"',
      "Content-Type: text/csv",
      "",
      csv,
      `--${boundary}--`,
      "",
    ].join("\r\n"),
  );
}
