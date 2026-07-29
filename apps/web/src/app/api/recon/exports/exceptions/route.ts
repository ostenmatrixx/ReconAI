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

const MAXIMUM_EXPORT_BYTES = 5 * 1024 * 1024;
const EXPORT_FILENAME = "reconai-exception-queue.csv";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const amountMinorPattern = /^-?(0|[1-9][0-9]{0,30})$/u;
const exceptionExportErrorPolicy = {
  AUTHENTICATION_REQUIRED: {
    status: 401,
    message: "Sign in again to prepare this export.",
  },
  RESOURCE_NOT_FOUND: {
    status: 404,
    message: "The exception export is unavailable.",
  },
  EXPORT_LIMIT_EXCEEDED: {
    status: 422,
    message: "The exception export is too large. Narrow the filters and try again.",
  },
  RATE_LIMITED: {
    status: 429,
    message: "Too many export requests. Try again shortly.",
  },
} as const satisfies ApiErrorPolicy;
const ExceptionExportSchema = z
  .object({
    status: z
      .enum(["open", "assigned", "deferred", "proposed", "approved", "rejected", "superseded"])
      .optional(),
    severity: z.enum(["high", "medium", "low"]).optional(),
    search: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9 _-]+$/u)
      .optional(),
    source: z.enum(["shopify", "stripe", "accounting_csv", "unclassified"]).optional(),
    amountCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .optional(),
    minimumAmountMinor: z.string().regex(amountMinorPattern).optional(),
    maximumAmountMinor: z.string().regex(amountMinorPattern).optional(),
    confidence: z.enum(["high", "low", "unclassified"]).optional(),
    assignee: z.enum(["me", "assigned", "unassigned"]).optional(),
    age: z
      .enum(["under_24h", "one_to_seven_days", "seven_to_thirty_days", "over_30_days"])
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.minimumAmountMinor || value.maximumAmountMinor) && !value.amountCurrency) {
      context.addIssue({
        code: "custom",
        message: "amountCurrency is required when an amount bound is present",
        path: ["amountCurrency"],
      });
    }
    if (
      value.minimumAmountMinor &&
      value.maximumAmountMinor &&
      amountMinorPattern.test(value.minimumAmountMinor) &&
      amountMinorPattern.test(value.maximumAmountMinor) &&
      BigInt(value.minimumAmountMinor) > BigInt(value.maximumAmountMinor)
    ) {
      context.addIssue({
        code: "custom",
        message: "minimumAmountMinor cannot exceed maximumAmountMinor",
        path: ["minimumAmountMinor"],
      });
    }
  });

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
  const parsed = ExceptionExportSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { code: "INVALID_EXPORT_FILTER" },
      { status: 400, headers: privateResponseHeaders },
    );
  }

  const apiOrigin = readConfiguredOrigin("API_ORIGIN", "http://127.0.0.1:4000");
  try {
    const response = await fetch(
      new URL(`/v1/organizations/${organizationId}/exception-exports`, apiOrigin),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.apiAccessToken}`,
          "content-type": "application/json",
          accept: "text/csv, application/json",
          "x-request-id": crypto.randomUUID(),
        },
        body: JSON.stringify(parsed.data),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      const body = await readAllowlistedApiError(response, exceptionExportErrorPolicy);
      return NextResponse.json(body, {
        status: response.status,
        headers: privateResponseHeaders,
      });
    }
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/csv")) {
      throw new Error("upstream returned a non-CSV export");
    }

    const bytes = await readBoundedResponseBytes(response, MAXIMUM_EXPORT_BYTES);
    if (bytes.byteLength === 0) throw new Error("upstream returned an empty export");

    const headers = new Headers(privateResponseHeaders);
    headers.set("Content-Type", "text/csv; charset=utf-8");
    headers.set("Content-Disposition", `attachment; filename="${EXPORT_FILENAME}"`);
    headers.set("Content-Length", bytes.byteLength.toString());
    headers.set("Content-Security-Policy", "sandbox");
    headers.set("X-Content-Type-Options", "nosniff");
    const exportId = response.headers.get("x-reconai-export-id");
    if (exportId && uuidPattern.test(exportId)) {
      headers.set("X-ReconAI-Export-Id", exportId);
    }
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    return new NextResponse(new Blob([body], { type: "text/csv; charset=utf-8" }), {
      status: 200,
      headers,
    });
  } catch {
    return NextResponse.json(
      { code: "UPSTREAM_UNAVAILABLE", message: "The exception export could not be prepared." },
      { status: 502, headers: privateResponseHeaders },
    );
  }
}
