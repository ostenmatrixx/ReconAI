import { createHash } from "node:crypto";

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { FormBodyError, readBoundedUrlEncodedForm } from "../../../../bounded-form";
import { readBoundedResponseBytes } from "../../../../bounded-response";
import {
  organizationContextCookieName,
  resolveOrganizationContext,
} from "../../../../organization-context";
import {
  issueProviderAuthorizationCookie,
  providerAuthorizationCookieName,
} from "../../../../provider-authorization-cookie";
import {
  privateResponseHeaders,
  readConfiguredOrigin,
  readSessionSecret,
} from "../../../../server-environment";
import { readRequestSessionToken } from "../../../../server-session";

const uuid = z.uuid();
const startFormSchema = z
  .object({
    provider: z.enum(["shopify", "stripe"]),
    connectionId: z.union([uuid, z.literal("")]).optional(),
    requestedAccountId: z.union([z.string().trim().min(1).max(255), z.literal("")]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.provider === "shopify" && !value.connectionId && !value.requestedAccountId) {
      context.addIssue({
        code: "custom",
        path: ["requestedAccountId"],
        message: "a Shopify shop or existing connection is required",
      });
    }
  });
const startResponseSchema = z
  .object({
    data: z
      .object({
        attemptId: uuid,
        connectionId: uuid,
        provider: z.enum(["shopify", "stripe"]),
        authorizationUrl: z.url(),
        expiresAt: z.iso.datetime({ offset: true }),
        requestedAccountId: z.string().min(1).max(255).optional(),
      })
      .strict(),
    meta: z.object({ correlationId: uuid }).loose(),
  })
  .strict();
const stateSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/u);
const maximumUpstreamBytes = 32 * 1024;

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
  if (
    !token?.apiAccessToken ||
    typeof token.sub !== "string" ||
    (typeof token.apiAccessTokenExpiresAt === "number" &&
      token.apiAccessTokenExpiresAt > 0 &&
      token.apiAccessTokenExpiresAt <= Math.floor(Date.now() / 1000))
  ) {
    return NextResponse.json(
      { code: "AUTHENTICATION_REQUIRED" },
      { status: 401, headers: privateResponseHeaders },
    );
  }
  const organizationId = resolveOrganizationContext(
    request.cookies.get(organizationContextCookieName())?.value,
    token.sub,
    secret,
  );
  if (!organizationId || !uuid.safeParse(organizationId).success) {
    return NextResponse.json(
      { code: "ORGANIZATION_CONTEXT_REQUIRED" },
      { status: 409, headers: privateResponseHeaders },
    );
  }

  let form: URLSearchParams;
  try {
    form = await readBoundedUrlEncodedForm(request);
  } catch (error) {
    const failure = error instanceof FormBodyError ? error : new FormBodyError("INVALID_FORM", 400);
    return NextResponse.json(
      { code: failure.code },
      { status: failure.status, headers: privateResponseHeaders },
    );
  }
  const uniqueForm = uniqueAllowedForm(form, ["provider", "connectionId", "requestedAccountId"]);
  const parsed = uniqueForm
    ? startFormSchema.safeParse({
        provider: uniqueForm.get("provider"),
        connectionId: uniqueForm.get("connectionId") ?? undefined,
        requestedAccountId: uniqueForm.get("requestedAccountId") ?? undefined,
      })
    : { success: false as const };
  if (!parsed.success) {
    return NextResponse.json(
      { code: "INVALID_PROVIDER_AUTHORIZATION" },
      { status: 400, headers: privateResponseHeaders },
    );
  }

  const apiOrigin = readConfiguredOrigin("API_ORIGIN", "http://127.0.0.1:4000");
  let response: Response;
  try {
    response = await fetch(
      new URL(`/v1/organizations/${organizationId}/provider-authorizations`, apiOrigin),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.apiAccessToken}`,
          "content-type": "application/json",
          accept: "application/json",
          "x-request-id": crypto.randomUUID(),
        },
        body: JSON.stringify({
          provider: parsed.data.provider,
          ...(parsed.data.connectionId ? { connectionId: parsed.data.connectionId } : {}),
          ...(parsed.data.requestedAccountId
            ? { requestedAccountId: parsed.data.requestedAccountId }
            : {}),
        }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    return authorizationFailureRedirect(webOrigin);
  }
  if (response.status !== 201 || !isJson(response)) {
    return authorizationFailureRedirect(webOrigin);
  }

  let started: z.infer<typeof startResponseSchema>;
  try {
    const bytes = await readBoundedResponseBytes(response, maximumUpstreamBytes);
    started = startResponseSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    return authorizationFailureRedirect(webOrigin);
  }
  if (started.data.provider !== parsed.data.provider) {
    return authorizationFailureRedirect(webOrigin);
  }

  let authorizationUrl: URL;
  let state: string;
  try {
    authorizationUrl = validateAuthorizationUrl(started.data);
    state = stateSchema.parse(authorizationUrl.searchParams.get("state"));
  } catch {
    return authorizationFailureRedirect(webOrigin);
  }
  const expiresAt = Math.floor(Date.parse(started.data.expiresAt) / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt <= now || expiresAt - now > 15 * 60) {
    return authorizationFailureRedirect(webOrigin);
  }
  const transactionCookie = issueProviderAuthorizationCookie(
    {
      attemptId: started.data.attemptId,
      organizationId,
      provider: started.data.provider,
      stateSha256: createHash("sha256").update(state, "ascii").digest("hex"),
      expiresAt,
    },
    token.sub,
    secret,
  );
  const redirect = NextResponse.redirect(authorizationUrl, 303);
  setPrivateRedirectHeaders(redirect);
  redirect.cookies.set(providerAuthorizationCookieName(), transactionCookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.max(1, expiresAt - now),
  });
  return redirect;
}

function uniqueAllowedForm(
  form: URLSearchParams,
  allowedNames: readonly string[],
): URLSearchParams | undefined {
  const allowed = new Set(allowedNames);
  const names = new Set<string>();
  const result = new URLSearchParams();
  for (const [name, value] of form) {
    if (!allowed.has(name) || names.has(name)) return undefined;
    names.add(name);
    result.set(name, value);
  }
  return result;
}

function validateAuthorizationUrl(started: z.infer<typeof startResponseSchema>["data"]): URL {
  const url = new URL(started.authorizationUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError("provider authorization URL is invalid");
  }
  if (url.searchParams.getAll("state").length !== 1) {
    throw new TypeError("provider authorization state is invalid");
  }
  if (started.provider === "stripe") {
    if (url.origin !== "https://marketplace.stripe.com" || url.pathname !== "/oauth/v2/authorize") {
      throw new TypeError("Stripe authorization URL is invalid");
    }
  } else if (
    !started.requestedAccountId ||
    url.hostname !== started.requestedAccountId ||
    url.pathname !== "/admin/oauth/authorize"
  ) {
    throw new TypeError("Shopify authorization URL is invalid");
  }
  return url;
}

function authorizationFailureRedirect(webOrigin: string): NextResponse {
  const url = new URL("/dashboard/connectors", webOrigin);
  url.searchParams.set("authorization", "error");
  const response = NextResponse.redirect(url, 303);
  setPrivateRedirectHeaders(response);
  return response;
}

function setPrivateRedirectHeaders(response: NextResponse): void {
  response.headers.set("Cache-Control", "no-store, private");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Referrer-Policy", "no-referrer");
}

function isJson(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("application/json") === true;
}
