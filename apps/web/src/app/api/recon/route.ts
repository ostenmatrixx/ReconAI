import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  fetchAuthorizedOrganizationPage,
  organizationContextCookieName,
  OrganizationDirectoryError,
  resolveOrganizationContext,
} from "../../../organization-context";
import { readBoundedResponseBytes } from "../../../bounded-response";
import {
  privateResponseHeaders,
  readConfiguredOrigin,
  readSessionSecret,
} from "../../../server-environment";
import { readRequestSessionToken } from "../../../server-session";
import { minimizeTenantReadResponse, tenantReadViewSchema } from "../../../tenant-read-response";
import { readAllowlistedApiError, type ApiErrorPolicy } from "../../../upstream-api-error";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const exceptionStatusPattern = /^(open|assigned|deferred|proposed|approved|rejected|superseded)$/u;
const exceptionSeverityPattern = /^(high|medium|low)$/u;
const exceptionSearchPattern = /^[A-Za-z0-9 _-]{1,100}$/u;
const exceptionSourcePattern = /^(shopify|stripe|accounting_csv|unclassified)$/u;
const exceptionCurrencyPattern = /^[A-Z]{3}$/u;
const exceptionAmountMinorPattern = /^-?(0|[1-9][0-9]{0,30})$/u;
const exceptionConfidencePattern = /^(high|low|unclassified)$/u;
const exceptionAssigneePattern = /^(me|assigned|unassigned)$/u;
const exceptionAgePattern = /^(under_24h|one_to_seven_days|seven_to_thirty_days|over_30_days)$/u;
const cursorPattern = /^[A-Za-z0-9_-]{1,1024}$/u;
const maximumUpstreamJsonBytes = 5 * 1024 * 1024;
const readErrorPolicy = {
  AUTHENTICATION_REQUIRED: {
    status: 401,
    message: "Sign in again to load this information.",
  },
  RESOURCE_NOT_FOUND: {
    status: 404,
    message: "The requested information is unavailable.",
  },
  INVALID_CURSOR: {
    status: 400,
    message: "This page cursor is no longer valid. Reload the view.",
  },
  RATE_LIMITED: {
    status: 429,
    message: "Too many read requests. Try again shortly.",
  },
} as const satisfies ApiErrorPolicy;
const supportGrantListResponseSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            id: z.uuid(),
            supportIdentityReference: z.string().regex(/^[a-f0-9]{12}$/u),
            capability: z.literal("diagnostics:view"),
            ticketReference: z.string().min(3).max(200),
            reason: z.string().min(3).max(2000),
            approvedAt: z.iso.datetime({ offset: true }),
            expiresAt: z.iso.datetime({ offset: true }),
            status: z.enum(["active", "expired", "revoked"]),
            revokedAt: z.iso.datetime({ offset: true }).optional(),
            revocationReason: z.string().min(3).max(2000).optional(),
          })
          .strict(),
      )
      .max(50),
    meta: z.unknown().optional(),
  })
  .strict()
  .transform(({ data }) => ({ data }));

export async function GET(request: NextRequest) {
  const secret = readSessionSecret();
  const token = await readRequestSessionToken(request);
  if (!token?.apiAccessToken || typeof token.sub !== "string") {
    return NextResponse.json(
      { code: "AUTHENTICATION_REQUIRED" },
      { status: 401, headers: privateResponseHeaders },
    );
  }
  if (
    typeof token.apiAccessTokenExpiresAt === "number" &&
    token.apiAccessTokenExpiresAt > 0 &&
    token.apiAccessTokenExpiresAt <= Math.floor(Date.now() / 1000)
  ) {
    return NextResponse.json(
      { code: "SESSION_REAUTHENTICATION_REQUIRED" },
      { status: 401, headers: privateResponseHeaders },
    );
  }

  const view = request.nextUrl.searchParams.get("view") ?? "summary";
  if (view === "organizations") {
    try {
      const search = request.nextUrl.searchParams.get("search") ?? undefined;
      const cursor = request.nextUrl.searchParams.get("cursor") ?? undefined;
      const directory = await fetchAuthorizedOrganizationPage(token.apiAccessToken, {
        limit: 50,
        ...(search ? { search } : {}),
        ...(cursor ? { cursor } : {}),
      });
      const candidate = resolveOrganizationContext(
        request.cookies.get(organizationContextCookieName())?.value,
        token.sub,
        secret,
      );
      let selectedOrganization = directory.data.find(({ id }) => id === candidate);
      if (candidate && !selectedOrganization) {
        const exact = await fetchAuthorizedOrganizationPage(token.apiAccessToken, {
          limit: 1,
          organizationId: candidate,
        });
        selectedOrganization = exact.data.find(({ id }) => id === candidate);
      }
      const organizations = directory.data.map(({ id, name, role }) => ({ id, name, role }));
      const selected = selectedOrganization
        ? {
            id: selectedOrganization.id,
            name: selectedOrganization.name,
            role: selectedOrganization.role,
          }
        : undefined;
      return NextResponse.json(
        {
          data: {
            organizations,
            ...(selected
              ? {
                  selectedOrganizationId: selected.id,
                  selectedOrganization: selected,
                }
              : {}),
          },
          meta: {
            ...(directory.meta.nextCursor ? { nextCursor: directory.meta.nextCursor } : {}),
          },
        },
        { status: 200, headers: privateResponseHeaders },
      );
    } catch (error) {
      if (error instanceof OrganizationDirectoryError && error.status === 400) {
        return NextResponse.json(
          { code: "INVALID_ORGANIZATION_DIRECTORY_QUERY" },
          { status: 400, headers: privateResponseHeaders },
        );
      }
      const status =
        error instanceof OrganizationDirectoryError && error.status === 401 ? 401 : 502;
      return NextResponse.json(
        { code: status === 401 ? "AUTHENTICATION_REQUIRED" : "UPSTREAM_UNAVAILABLE" },
        { status, headers: privateResponseHeaders },
      );
    }
  }

  const organizationId = resolveOrganizationContext(
    request.cookies.get(organizationContextCookieName())?.value,
    token.sub,
    secret,
  );
  if (!organizationId || !uuidPattern.test(organizationId)) {
    return NextResponse.json(
      {
        code: "ORGANIZATION_CONTEXT_REQUIRED",
        message: "No authorized organization context has been selected.",
      },
      { status: 409, headers: privateResponseHeaders },
    );
  }

  const apiOrigin = readConfiguredOrigin("API_ORIGIN", "http://127.0.0.1:4000");
  const resourceId = request.nextUrl.searchParams.get("id");
  let endpoint: string;
  if (view === "exception") {
    if (!resourceId || !uuidPattern.test(resourceId)) {
      return NextResponse.json(
        { code: "INVALID_EXCEPTION_ID" },
        { status: 400, headers: privateResponseHeaders },
      );
    }
    endpoint = `/v1/organizations/${organizationId}/exceptions/${resourceId}`;
  } else if (view === "connections") {
    endpoint = `/v1/organizations/${organizationId}/connections`;
  } else if (view === "connector_credentials") {
    const connectionId = request.nextUrl.searchParams.get("connectionId");
    if (!connectionId || !uuidPattern.test(connectionId)) {
      return NextResponse.json(
        { code: "INVALID_CONNECTION_ID" },
        { status: 400, headers: privateResponseHeaders },
      );
    }
    endpoint = `/v1/organizations/${organizationId}/connections/${connectionId}/credentials`;
  } else if (view === "members") {
    endpoint = `/v1/organizations/${organizationId}/members`;
  } else if (view === "invitations") {
    endpoint = `/v1/organizations/${organizationId}/invitations`;
  } else if (view === "imports") {
    endpoint = `/v1/organizations/${organizationId}/imports?limit=50`;
  } else if (view === "organization_profile") {
    endpoint = `/v1/organizations/${organizationId}`;
  } else if (view === "review_policy") {
    endpoint = `/v1/organizations/${organizationId}/review-policy`;
  } else if (view === "retention_policy") {
    endpoint = `/v1/organizations/${organizationId}/retention-policy`;
  } else if (view === "support_access_grants") {
    endpoint = `/v1/organizations/${organizationId}/support-access-grants?limit=50`;
  } else if (view === "privacy_requests") {
    const privacyCursor = request.nextUrl.searchParams.get("cursor");
    if (privacyCursor && !cursorPattern.test(privacyCursor)) {
      return NextResponse.json(
        { code: "INVALID_PRIVACY_REQUEST_CURSOR" },
        { status: 400, headers: privateResponseHeaders },
      );
    }
    const privacyQuery = new URLSearchParams({ limit: "50" });
    if (privacyCursor) privacyQuery.set("cursor", privacyCursor);
    endpoint = `/v1/organizations/${organizationId}/provider-privacy-requests?${privacyQuery.toString()}`;
  } else if (view === "provider_sync_runs") {
    const connectionId = request.nextUrl.searchParams.get("connectionId");
    if (connectionId && !uuidPattern.test(connectionId)) {
      return NextResponse.json(
        { code: "INVALID_CONNECTION_ID" },
        { status: 400, headers: privateResponseHeaders },
      );
    }
    endpoint = `/v1/organizations/${organizationId}/provider-sync-runs${
      connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ""
    }`;
  } else if (view === "audit") {
    endpoint = `/v1/organizations/${organizationId}/audit-events?limit=100`;
  } else if (view === "runs") {
    endpoint = `/v1/organizations/${organizationId}/reconciliation-runs?limit=50`;
  } else if (view === "run") {
    if (!resourceId || !uuidPattern.test(resourceId)) {
      return NextResponse.json(
        { code: "INVALID_RUN_ID" },
        { status: 400, headers: privateResponseHeaders },
      );
    }
    endpoint = `/v1/organizations/${organizationId}/reconciliation-runs/${resourceId}`;
  } else if (view === "run_artifacts") {
    const artifactType = request.nextUrl.searchParams.get("type");
    const artifactCursor = request.nextUrl.searchParams.get("cursor");
    if (!resourceId || !uuidPattern.test(resourceId)) {
      return NextResponse.json(
        { code: "INVALID_RUN_ID" },
        { status: 400, headers: privateResponseHeaders },
      );
    }
    if (
      !artifactType ||
      !/^(match|exception)$/u.test(artifactType) ||
      (artifactCursor && !cursorPattern.test(artifactCursor))
    ) {
      return NextResponse.json(
        { code: "INVALID_RUN_ARTIFACT_QUERY" },
        { status: 400, headers: privateResponseHeaders },
      );
    }
    const artifactQuery = new URLSearchParams({ type: artifactType, limit: "25" });
    if (artifactCursor) artifactQuery.set("cursor", artifactCursor);
    endpoint =
      `/v1/organizations/${organizationId}/reconciliation-runs/${resourceId}/artifacts?` +
      artifactQuery.toString();
  } else if (view === "run_inputs") {
    const inputCursor = request.nextUrl.searchParams.get("cursor");
    if (!resourceId || !uuidPattern.test(resourceId)) {
      return NextResponse.json(
        { code: "INVALID_RUN_ID" },
        { status: 400, headers: privateResponseHeaders },
      );
    }
    if (inputCursor && !cursorPattern.test(inputCursor)) {
      return NextResponse.json(
        { code: "INVALID_RUN_INPUT_CURSOR" },
        { status: 400, headers: privateResponseHeaders },
      );
    }
    const inputQuery = new URLSearchParams({ limit: "100" });
    if (inputCursor) inputQuery.set("cursor", inputCursor);
    endpoint =
      `/v1/organizations/${organizationId}/reconciliation-runs/${resourceId}/inputs?` +
      inputQuery.toString();
  } else if (view !== "summary") {
    return NextResponse.json(
      { code: "INVALID_VIEW" },
      { status: 400, headers: privateResponseHeaders },
    );
  } else {
    const queueQuery = new URLSearchParams({ limit: "50" });
    const status = request.nextUrl.searchParams.get("status");
    const severity = request.nextUrl.searchParams.get("severity");
    const search = request.nextUrl.searchParams.get("search")?.trim();
    const source = request.nextUrl.searchParams.get("source");
    const amountCurrency = request.nextUrl.searchParams.get("amountCurrency");
    const minimumAmountMinor = request.nextUrl.searchParams.get("minimumAmountMinor");
    const maximumAmountMinor = request.nextUrl.searchParams.get("maximumAmountMinor");
    const confidence = request.nextUrl.searchParams.get("confidence");
    const assignee = request.nextUrl.searchParams.get("assignee");
    const age = request.nextUrl.searchParams.get("age");
    const cursor = request.nextUrl.searchParams.get("cursor");
    if (
      (status && !exceptionStatusPattern.test(status)) ||
      (severity && !exceptionSeverityPattern.test(severity)) ||
      (search && !exceptionSearchPattern.test(search)) ||
      (source && !exceptionSourcePattern.test(source)) ||
      (amountCurrency && !exceptionCurrencyPattern.test(amountCurrency)) ||
      (minimumAmountMinor && !exceptionAmountMinorPattern.test(minimumAmountMinor)) ||
      (maximumAmountMinor && !exceptionAmountMinorPattern.test(maximumAmountMinor)) ||
      ((minimumAmountMinor || maximumAmountMinor) && !amountCurrency) ||
      (minimumAmountMinor &&
        maximumAmountMinor &&
        BigInt(minimumAmountMinor) > BigInt(maximumAmountMinor)) ||
      (confidence && !exceptionConfidencePattern.test(confidence)) ||
      (assignee && !exceptionAssigneePattern.test(assignee)) ||
      (age && !exceptionAgePattern.test(age)) ||
      (cursor && !cursorPattern.test(cursor))
    ) {
      return NextResponse.json(
        { code: "INVALID_QUEUE_FILTER" },
        { status: 400, headers: privateResponseHeaders },
      );
    }
    if (status) queueQuery.set("status", status);
    if (severity) queueQuery.set("severity", severity);
    if (search) queueQuery.set("search", search);
    if (source) queueQuery.set("source", source);
    if (amountCurrency) queueQuery.set("amountCurrency", amountCurrency);
    if (minimumAmountMinor) queueQuery.set("minimumAmountMinor", minimumAmountMinor);
    if (maximumAmountMinor) queueQuery.set("maximumAmountMinor", maximumAmountMinor);
    if (confidence) queueQuery.set("confidence", confidence);
    if (assignee) queueQuery.set("assignee", assignee);
    if (age) queueQuery.set("age", age);
    if (cursor) queueQuery.set("cursor", cursor);
    endpoint = `/v1/organizations/${organizationId}/exceptions?${queueQuery.toString()}`;
  }

  try {
    const response = await fetch(new URL(endpoint, apiOrigin), {
      headers: {
        authorization: `Bearer ${token.apiAccessToken}`,
        accept: "application/json",
        "x-request-id": crypto.randomUUID(),
      },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      const clientError = await readAllowlistedApiError(response, readErrorPolicy);
      return NextResponse.json(clientError, {
        status: response.status,
        headers: privateResponseHeaders,
      });
    }
    if (response.status !== 200) throw new Error("upstream returned an unexpected read status");
    const responseBody = await safeJsonResponse(response);
    if (view === "support_access_grants") {
      const parsed = supportGrantListResponseSchema.safeParse(responseBody);
      if (!parsed.success) throw new Error("upstream returned an invalid support grant list");
      return NextResponse.json(parsed.data, {
        status: response.status,
        headers: privateResponseHeaders,
      });
    }
    const readView = tenantReadViewSchema.parse(view);
    const clientResponse = minimizeTenantReadResponse(readView, responseBody);
    return NextResponse.json(clientResponse, {
      status: response.status,
      headers: privateResponseHeaders,
    });
  } catch {
    return NextResponse.json(
      { code: "UPSTREAM_UNAVAILABLE", message: "The reconciliation API is unavailable." },
      { status: 502, headers: privateResponseHeaders },
    );
  }
}

async function safeJsonResponse(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("upstream returned a non-JSON response");
  }
  const bytes = await readBoundedResponseBytes(response, maximumUpstreamJsonBytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("upstream returned invalid JSON");
  }
}
