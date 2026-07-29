import { createHash, timingSafeEqual } from "node:crypto";

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { readBoundedResponseBytes } from "../../../../../../bounded-response";
import {
  organizationContextCookieName,
  resolveOrganizationContext,
} from "../../../../../../organization-context";
import {
  providerAuthorizationCookieName,
  verifyProviderAuthorizationCookie,
} from "../../../../../../provider-authorization-cookie";
import { readConfiguredOrigin, readSessionSecret } from "../../../../../../server-environment";
import { readRequestSessionToken } from "../../../../../../server-session";

const providerSchema = z.enum(["shopify", "stripe"]);
const callbackResponseSchema = z
  .object({
    data: z
      .object({
        attemptId: z.uuid(),
        connectionId: z.uuid().optional(),
        provider: providerSchema,
        status: z.enum(["succeeded", "denied"]),
        replayed: z.boolean(),
        externalAccountId: z.string().min(1).max(255).optional(),
      })
      .strict(),
    meta: z.object({ correlationId: z.uuid() }).loose(),
  })
  .strict();
const callbackNamePattern = /^[a-z][a-z0-9_]{0,63}$/u;
const statePattern = /^[A-Za-z0-9_-]{43}$/u;
const maximumUpstreamBytes = 32 * 1024;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
) {
  const webOrigin = readConfiguredOrigin("WEB_ORIGIN", "http://localhost:3000");
  const parsedProvider = providerSchema.safeParse((await context.params).provider);
  if (!parsedProvider.success) return callbackRedirect(webOrigin, "error");

  const secret = readSessionSecret();
  const token = await readRequestSessionToken(request);
  if (
    !token?.apiAccessToken ||
    typeof token.sub !== "string" ||
    (typeof token.apiAccessTokenExpiresAt === "number" &&
      token.apiAccessTokenExpiresAt > 0 &&
      token.apiAccessTokenExpiresAt <= Math.floor(Date.now() / 1000))
  ) {
    return callbackRedirect(webOrigin, "reauthentication_required", true);
  }
  const transaction = verifyProviderAuthorizationCookie(
    request.cookies.get(providerAuthorizationCookieName())?.value,
    token.sub,
    secret,
  );
  if (transaction?.provider !== parsedProvider.data) {
    return callbackRedirect(webOrigin, "error", true);
  }
  const organizationId = resolveOrganizationContext(
    request.cookies.get(organizationContextCookieName())?.value,
    token.sub,
    secret,
  );
  if (organizationId !== transaction.organizationId) {
    return callbackRedirect(webOrigin, "error", true);
  }

  const entries = [...request.nextUrl.searchParams.entries()];
  if (
    entries.length < 1 ||
    entries.length > 20 ||
    entries.some(([name, value]) => !callbackNamePattern.test(name) || value.length > 4096)
  ) {
    return callbackRedirect(webOrigin, "error", true);
  }
  const states = entries.filter(([name]) => name === "state");
  const state = states.length === 1 ? states[0]?.[1] : undefined;
  if (!state || !statePattern.test(state) || !stateDigestMatches(state, transaction.stateSha256)) {
    return callbackRedirect(webOrigin, "error", true);
  }

  const apiOrigin = readConfiguredOrigin("API_ORIGIN", "http://127.0.0.1:4000");
  let response: Response;
  try {
    response = await fetch(
      new URL(
        `/v1/organizations/${transaction.organizationId}/provider-authorizations/${transaction.attemptId}/callback`,
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
        body: JSON.stringify({ provider: transaction.provider, query: entries }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    return callbackRedirect(webOrigin, "error", true);
  }
  if (![200, 201].includes(response.status) || !isJson(response)) {
    return callbackRedirect(webOrigin, "error", true);
  }

  let completed: z.infer<typeof callbackResponseSchema>;
  try {
    const bytes = await readBoundedResponseBytes(response, maximumUpstreamBytes);
    completed = callbackResponseSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    return callbackRedirect(webOrigin, "error", true);
  }
  if (
    completed.data.attemptId !== transaction.attemptId ||
    completed.data.provider !== transaction.provider
  ) {
    return callbackRedirect(webOrigin, "error", true);
  }
  return callbackRedirect(
    webOrigin,
    completed.data.status === "succeeded" ? "success" : "denied",
    true,
  );
}

function callbackRedirect(
  webOrigin: string,
  status: "success" | "denied" | "error" | "reauthentication_required",
  clearCookie = false,
): NextResponse {
  const url = new URL("/dashboard/connectors", webOrigin);
  url.searchParams.set("authorization", status);
  const response = NextResponse.redirect(url, 303);
  response.headers.set("Cache-Control", "no-store, private");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Referrer-Policy", "no-referrer");
  if (clearCookie) {
    response.cookies.set(providerAuthorizationCookieName(), "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
      expires: new Date(0),
    });
  }
  return response;
}

function stateDigestMatches(state: string, expectedDigest: string): boolean {
  const digest = createHash("sha256").update(state, "ascii").digest();
  const expected = Buffer.from(expectedDigest, "hex");
  return digest.byteLength === expected.byteLength && timingSafeEqual(digest, expected);
}

function isJson(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("application/json") === true;
}
