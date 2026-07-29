import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { readBoundedJson, RequestBodyError } from "../../../../../bounded-json";
import { readBoundedResponseBytes } from "../../../../../bounded-response";
import {
  organizationContextCookieName,
  resolveOrganizationContext,
} from "../../../../../organization-context";
import {
  privateResponseHeaders,
  readConfiguredOrigin,
  readSessionSecret,
} from "../../../../../server-environment";
import { readRequestSessionToken } from "../../../../../server-session";
import { readAllowlistedApiError, type ApiErrorPolicy } from "../../../../../upstream-api-error";

const MAXIMUM_PACKAGE_BYTES = 5 * 1024 * 1024;
const MAXIMUM_RECEIPT_BYTES = 64 * 1024;
const PACKAGE_FILENAME = "reconai-shopify-customer-data-evidence.json";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const receiptTokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const privacyDataPackageErrorPolicy = {
  AUTHENTICATION_REQUIRED: {
    status: 401,
    message: "Sign in again to prepare the privacy evidence package.",
  },
  RESOURCE_NOT_FOUND: {
    status: 404,
    message: "The privacy evidence package is unavailable.",
  },
  PRIVACY_DATA_PACKAGE_RECEIPT_EXPIRED: {
    status: 410,
    message: "The privacy evidence package receipt expired. Prepare a new package.",
  },
  PRIVACY_DATA_PACKAGE_LIMIT_EXCEEDED: {
    status: 422,
    message: "The privacy evidence package exceeds the bounded export limit.",
  },
  PRIVACY_DATA_EVIDENCE_UNAVAILABLE: {
    status: 409,
    message: "Complete privacy evidence is unavailable; no package was produced.",
  },
  RATE_LIMITED: {
    status: 429,
    message: "Too many privacy package requests. Try again shortly.",
  },
} as const satisfies ApiErrorPolicy;
const PrivacyDataPackagePreparationRequestSchema = z
  .object({
    requestId: z.uuid(),
    confirmed: z.literal(true),
    reason: z.string().trim().min(3).max(2000),
  })
  .strict();
const PrivacyDataPackageReceiptRequestSchema = z
  .object({
    action: z.literal("acknowledge_browser_receipt"),
    requestId: z.uuid(),
    packageId: z.uuid(),
    receiptToken: z.string().regex(receiptTokenPattern),
  })
  .strict();
const PrivacyDataPackageRequestSchema = z.union([
  PrivacyDataPackagePreparationRequestSchema,
  PrivacyDataPackageReceiptRequestSchema,
]);
const PrivacyDataPackageResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    packageId: z.uuid(),
    preparedAt: z.iso.datetime({ offset: true }),
    purpose: z.literal("merchant_review_for_shopify_customers_data_request"),
    scope: z
      .object({
        completeWithinDeclaredScope: z.literal(true),
        limitations: z.array(z.string().min(1)).min(1),
      })
      .loose(),
    request: z.object({ topic: z.literal("customers/data_request") }).loose(),
    records: z.array(z.unknown()),
  })
  .loose();
const PrivacyDataPackageReceiptResponseSchema = z
  .object({
    data: z
      .object({
        packageId: z.uuid(),
        status: z.enum(["acknowledged", "already_acknowledged"]),
        preparedAt: z.iso.datetime({ offset: true }),
        receiptExpiresAt: z.iso.datetime({ offset: true }),
        receivedAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
    meta: z.object({ correlationId: z.uuid() }).loose(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const webOrigin = readConfiguredOrigin("WEB_ORIGIN", "http://localhost:3000");
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin !== webOrigin || (fetchSite && fetchSite !== "same-origin")) {
    return NextResponse.json(
      { code: "CSRF_ORIGIN_REJECTED" },
      { status: 403, headers: privateResponseHeaders },
    );
  }

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

  const organizationId = resolveOrganizationContext(
    request.cookies.get(organizationContextCookieName())?.value,
    token.sub,
    secret,
  );
  if (!organizationId || !uuidPattern.test(organizationId)) {
    return NextResponse.json(
      { code: "ORGANIZATION_CONTEXT_REQUIRED" },
      { status: 409, headers: privateResponseHeaders },
    );
  }

  let raw: unknown;
  try {
    raw = await readBoundedJson(request);
  } catch (error) {
    const failure =
      error instanceof RequestBodyError ? error : new RequestBodyError("INVALID_JSON", 400);
    return NextResponse.json(
      { code: failure.code },
      { status: failure.status, headers: privateResponseHeaders },
    );
  }
  const parsed = PrivacyDataPackageRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { code: "INVALID_PRIVACY_DATA_PACKAGE_REQUEST" },
      { status: 400, headers: privateResponseHeaders },
    );
  }

  const apiOrigin = readConfiguredOrigin("API_ORIGIN", "http://127.0.0.1:4000");
  try {
    if ("action" in parsed.data) {
      const response = await fetch(
        new URL(
          `/v1/organizations/${organizationId}/provider-privacy-requests/${parsed.data.requestId}/data-package/${parsed.data.packageId}/receipt`,
          apiOrigin,
        ),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token.apiAccessToken}`,
            "content-type": "application/json",
            accept: "application/json",
            "x-request-id": crypto.randomUUID(),
          },
          body: JSON.stringify({ receiptToken: parsed.data.receiptToken }),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        const body = await readAllowlistedApiError(response, privacyDataPackageErrorPolicy);
        return NextResponse.json(body, {
          status: response.status,
          headers: privateResponseHeaders,
        });
      }
      if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
        throw new Error("upstream returned a non-JSON privacy package receipt");
      }
      const receiptBytes = await readBoundedResponseBytes(response, MAXIMUM_RECEIPT_BYTES);
      const receipt = PrivacyDataPackageReceiptResponseSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes)) as unknown,
      );
      if (receipt.data.packageId !== parsed.data.packageId) {
        throw new Error("upstream privacy package receipt identity is invalid");
      }
      if (
        (receipt.data.status === "acknowledged" && response.status !== 201) ||
        (receipt.data.status === "already_acknowledged" && response.status !== 200)
      ) {
        throw new Error("upstream privacy package receipt status is invalid");
      }
      return NextResponse.json(receipt, {
        status: response.status,
        headers: privateResponseHeaders,
      });
    }

    const response = await fetch(
      new URL(
        `/v1/organizations/${organizationId}/provider-privacy-requests/${parsed.data.requestId}/data-package`,
        apiOrigin,
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.apiAccessToken}`,
          "content-type": "application/json",
          accept: "application/json",
          "x-request-id": crypto.randomUUID(),
        },
        body: JSON.stringify({
          confirmed: parsed.data.confirmed,
          reason: parsed.data.reason,
        }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      const body = await readAllowlistedApiError(response, privacyDataPackageErrorPolicy);
      return NextResponse.json(body, {
        status: response.status,
        headers: privateResponseHeaders,
      });
    }
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      throw new Error("upstream returned a non-JSON privacy data package");
    }
    const bytes = await readBoundedResponseBytes(response, MAXIMUM_PACKAGE_BYTES);
    if (bytes.byteLength === 0) throw new Error("upstream returned an empty privacy data package");
    const document = PrivacyDataPackageResponseSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    );

    const headers = new Headers(privateResponseHeaders);
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Content-Disposition", `attachment; filename="${PACKAGE_FILENAME}"`);
    headers.set("Content-Length", bytes.byteLength.toString());
    headers.set("Content-Security-Policy", "sandbox");
    headers.set("X-Content-Type-Options", "nosniff");
    const packageId = response.headers.get("x-reconai-privacy-package-id");
    if (!packageId || !uuidPattern.test(packageId) || packageId !== document.packageId) {
      throw new Error("upstream privacy package identity is invalid");
    }
    const receiptToken = response.headers.get("x-reconai-privacy-package-receipt-token");
    const receiptExpiresAt = response.headers.get("x-reconai-privacy-package-receipt-expires-at");
    if (
      !receiptToken ||
      !receiptTokenPattern.test(receiptToken) ||
      !receiptExpiresAt ||
      !z.iso.datetime({ offset: true }).safeParse(receiptExpiresAt).success ||
      Date.parse(receiptExpiresAt) - Date.parse(document.preparedAt) !== 10 * 60 * 1000
    ) {
      throw new Error("upstream privacy package receipt authority is invalid");
    }
    headers.set("X-ReconAI-Privacy-Package-Id", packageId);
    headers.set("X-ReconAI-Privacy-Package-Receipt-Token", receiptToken);
    headers.set("X-ReconAI-Privacy-Package-Receipt-Expires-At", receiptExpiresAt);
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    return new NextResponse(new Blob([body], { type: "application/json; charset=utf-8" }), {
      status: 200,
      headers,
    });
  } catch {
    return NextResponse.json(
      {
        code: "UPSTREAM_UNAVAILABLE",
        message: "The privacy evidence package could not be prepared.",
      },
      { status: 502, headers: privateResponseHeaders },
    );
  }
}
