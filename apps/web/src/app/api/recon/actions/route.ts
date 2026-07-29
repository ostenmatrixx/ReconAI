import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { readBoundedJson, RequestBodyError } from "../../../../bounded-json";
import { readBoundedResponseBytes } from "../../../../bounded-response";
import {
  organizationContextCookieName,
  resolveOrganizationContext,
} from "../../../../organization-context";
import {
  privateResponseHeaders,
  readConfiguredOrigin,
  readSessionSecret,
} from "../../../../server-environment";
import { readRequestSessionToken } from "../../../../server-session";
import { readAllowlistedApiError, type ApiErrorPolicy } from "../../../../upstream-api-error";

const uuid = z.uuid();
const maximumUpstreamJsonBytes = 1024 * 1024;
const actionErrorPolicy = {
  AUTHENTICATION_REQUIRED: {
    status: 401,
    message: "Sign in again to complete this action.",
  },
  RESOURCE_NOT_FOUND: {
    status: 404,
    message: "The requested action is unavailable.",
  },
  CONFLICT: {
    status: 409,
    message: "The action conflicts with the current state. Refresh and try again.",
  },
  RECONCILIATION_RUN_CREATION_UNAVAILABLE: {
    status: 503,
    message: "The run request is temporarily unavailable. Try again shortly.",
  },
  CONNECTOR_CREDENTIAL_CONFLICT: {
    status: 409,
    message: "The credential rotation conflicts with the current connection state.",
  },
  PROVIDER_DISCONNECT_DISABLED: {
    status: 503,
    message: "Provider disconnect is not configured.",
  },
  PROVIDER_DISCONNECT_UNAVAILABLE: {
    status: 503,
    message: "The provider disconnect could not be confirmed. Try again shortly.",
  },
  PROVIDER_DISCONNECT_UNCONFIRMED: {
    status: 409,
    message: "The provider disconnect could not be confirmed.",
  },
  RECONCILIATION_INPUT_INVALID: {
    status: 422,
    message: "The reconciliation request is invalid.",
  },
  IMPORT_CONFLICT: {
    status: 409,
    message: "The import action conflicts with the current import state.",
  },
  RATE_LIMITED: {
    status: 429,
    message: "Too many action requests. Try again shortly.",
  },
} as const satisfies ApiErrorPolicy;
const noControlCharacters = (value: string): boolean =>
  Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 31 && (codePoint < 127 || codePoint > 159);
  });
const supportText = (maximum: number) =>
  z.string().trim().min(3).max(maximum).refine(noControlCharacters);
const sealedCredentialEnvelope = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal("A256GCM"),
    keyVersion: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/u),
    organizationId: uuid,
    connectionId: uuid,
    provider: z.enum(["shopify", "stripe"]),
    purpose: z.enum(["webhook_signing", "api_read"]),
    iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]{22,5462}$/u),
    tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  })
  .strict();
const ActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_proposal"),
    exceptionId: uuid,
    type: z.string().regex(/^[a-z0-9_]{1,100}$/u),
    reason: z.string().trim().min(3).max(2000),
  }),
  z.object({
    action: z.literal("decide_proposal"),
    proposalId: uuid,
    decision: z.enum(["approve", "reject"]),
    reason: z.string().trim().min(3).max(2000),
  }),
  z.object({
    action: z.literal("update_member"),
    membershipId: uuid,
    role: z.enum(["owner", "administrator", "analyst", "reviewer", "auditor"]),
    status: z.enum(["active", "deactivated"]),
    reason: z.string().trim().min(3).max(2000),
  }),
  z.object({
    action: z.literal("create_invitation"),
    email: z.preprocess(
      (value) => (typeof value === "string" ? value.trim() : value),
      z.email().max(320),
    ),
    role: z.enum(["owner", "administrator", "analyst", "reviewer", "auditor"]),
    reason: z.string().trim().min(3).max(2000),
  }),
  z.object({
    action: z.literal("revoke_invitation"),
    invitationId: uuid,
    reason: z.string().trim().min(3).max(2000),
  }),
  z.object({
    action: z.literal("rollback_import"),
    importId: uuid,
    confirmImportId: uuid,
    reason: z.string().trim().min(3).max(2000),
  }),
  z
    .object({
      action: z.literal("update_organization_profile"),
      name: z.string().trim().min(1).max(200).refine(noControlCharacters),
      expectedProfileVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      reason: z.string().trim().min(3).max(2000).refine(noControlCharacters),
    })
    .strict(),
  z.object({
    action: z.literal("update_review_policy"),
    dualApprovalEnabled: z.boolean(),
    dualApprovalThresholds: z
      .record(z.string().regex(/^[A-Z]{3}$/u), z.string().regex(/^(0|[1-9][0-9]{0,30})$/u))
      .refine((value) => Object.keys(value).length <= 50),
    sensitiveResolutionTypes: z
      .array(z.string().regex(/^[a-z0-9_]{1,100}$/u))
      .max(50)
      .refine((value) => new Set(value).size === value.length),
    reason: z.string().trim().min(3).max(2000),
  }),
  z.object({
    action: z.literal("update_retention_policy"),
    rawImportRetentionDays: z.number().int().min(1).max(3650).nullable(),
    providerEventRetentionDays: z.number().int().min(1).max(3650).nullable(),
    legalHoldEnabled: z.boolean(),
    legalHoldReason: z.string().trim().min(3).max(2000).nullable(),
    confirmed: z.literal(true),
    reason: z.string().trim().min(3).max(2000),
  }),
  z.object({
    action: z.literal("approve_support_access"),
    requestCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    ticketReference: supportText(200),
    reason: supportText(2000),
    confirmed: z.literal(true),
  }),
  z.object({
    action: z.literal("revoke_support_access"),
    grantId: uuid,
    reason: supportText(2000),
    confirmed: z.literal(true),
  }),
  z.object({
    action: z.literal("start_provider_sync"),
    connectionId: uuid,
    mode: z.enum(["backfill", "gap_repair"]),
    windowStart: z.iso.datetime({ offset: true }),
    windowEnd: z.iso.datetime({ offset: true }),
    maximumPages: z.number().int().min(1).max(100),
    confirmed: z.literal(true),
    reason: z.string().trim().min(3).max(2000),
  }),
  z.object({
    action: z.literal("rotate_connector_credential"),
    connectionId: uuid,
    purpose: z.enum(["webhook_signing", "api_read"]),
    envelope: sealedCredentialEnvelope,
    confirmed: z.literal(true),
    reason: z.string().trim().min(3).max(2000),
  }),
  z.object({
    action: z.literal("disconnect_connector"),
    connectionId: uuid,
    confirmConnectionId: uuid,
    reason: z.string().trim().min(3).max(2000),
  }),
  z.object({
    action: z.literal("add_note"),
    exceptionId: uuid,
    body: z.string().trim().min(3).max(4000),
  }),
  z.object({
    action: z.literal("update_exception"),
    exceptionId: uuid,
    workflowAction: z.enum(["assign_self", "defer", "reopen"]),
    deferredUntil: z.iso.datetime({ offset: true }).optional(),
    reason: z.string().trim().min(3).max(2000),
  }),
  z.object({
    action: z.literal("start_run"),
    policyVersion: z.string().trim().min(1).max(50),
    evaluatedAt: z.iso.datetime({ offset: true }),
    amountToleranceMinor: z
      .record(z.string().regex(/^[A-Z]{3}$/u), z.string().regex(/^(0|[1-9][0-9]{0,18})$/u))
      .refine((value) => Object.keys(value).length <= 50),
    dateWindowSeconds: z
      .number()
      .int()
      .min(0)
      .max(31 * 86_400),
    delayedEventGraceSeconds: z
      .number()
      .int()
      .min(0)
      .max(31 * 86_400),
    businessTimeZone: z.string().trim().min(1).max(100),
    reason: z.string().trim().min(3).max(2000),
  }),
  z.object({
    action: z.literal("replay_run"),
    runId: uuid,
    reason: z.string().trim().min(3).max(2000),
  }),
]);
type ActionName = z.infer<typeof ActionSchema>["action"];
const actionSuccessStatuses = {
  create_proposal: [201],
  decide_proposal: [201],
  update_member: [200],
  create_invitation: [201],
  revoke_invitation: [200],
  rollback_import: [200],
  update_organization_profile: [200],
  update_review_policy: [200],
  update_retention_policy: [200],
  approve_support_access: [201],
  revoke_support_access: [200],
  start_provider_sync: [202],
  rotate_connector_credential: [200, 201],
  disconnect_connector: [200],
  add_note: [201],
  update_exception: [200],
  start_run: [202],
  replay_run: [202],
} as const satisfies Readonly<Record<ActionName, readonly number[]>>;
const acceptedMutationResponseSchema = z.object({
  data: z.record(z.string(), z.unknown()),
});
const invitationActionResponseSchema = z.object({
  data: z.object({
    acceptToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  }),
  meta: z.object({
    delivery: z.object({
      status: z.enum(["accepted", "not_configured", "failed"]),
      auditRecorded: z.boolean(),
    }),
  }),
});
const rollbackActionResponseSchema = z.object({
  data: z.object({
    status: z.literal("rolled_back"),
    supersededRecordCount: z.number().int().nonnegative(),
  }),
});
const organizationProfileActionResponseSchema = z.object({
  data: z.object({
    name: z.string().min(1).max(200),
    businessTimeZone: z.string().min(1).max(100),
    profileVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    updatedAt: z.iso.datetime({ offset: true }),
  }),
});
const reviewPolicyActionResponseSchema = z.object({
  data: z.object({
    dualApprovalEnabled: z.boolean(),
    dualApprovalThresholds: z
      .record(z.string().regex(/^[A-Z]{3}$/u), z.string().regex(/^(0|[1-9][0-9]{0,30})$/u))
      .refine((value) => Object.keys(value).length <= 50),
    sensitiveResolutionTypes: z
      .array(z.string().regex(/^[a-z0-9_]{1,100}$/u))
      .max(50)
      .refine((value) => new Set(value).size === value.length),
    updatedAt: z.iso.datetime({ offset: true }),
  }),
});
const retentionPolicyActionResponseSchema = z.object({
  data: z.object({
    rawImportRetentionDays: z.number().int().min(1).max(3650).nullable(),
    providerEventRetentionDays: z.number().int().min(1).max(3650).nullable(),
    legalHoldEnabled: z.boolean(),
    legalHoldReason: z.string().min(3).max(2000).nullable(),
    updatedAt: z.iso.datetime({ offset: true }).nullable(),
  }),
});
const providerSyncActionResponseSchema = z.object({
  data: z.object({
    provider: z.enum(["shopify", "stripe"]),
  }),
});
const credentialRotationActionResponseSchema = z.object({
  data: z.object({
    id: uuid,
    keyVersion: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/u),
  }),
});
const stripeProviderActionUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.origin === "https://dashboard.stripe.com" &&
      /^\/settings\/apps\/[A-Za-z0-9._-]{3,255}$/u.test(url.pathname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  });
const disconnectActionResponseSchema = z.object({
  data: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("disconnected"),
      revoked: z.number().int().nonnegative(),
      providerConfirmation: z.enum(["confirmed", "not_recorded"]),
    }),
    z.object({
      status: z.literal("provider_action_required"),
      providerActionUrl: stripeProviderActionUrlSchema,
      providerConfirmation: z.literal("pending"),
    }),
  ]),
});
const runStartActionResponseSchema = z.object({
  data: z.object({
    id: uuid,
    status: z.enum(["queued", "running", "partial", "succeeded", "failed", "cancelled"]),
  }),
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
  const organization = uuid.safeParse(organizationId);
  if (!organization.success) {
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
  const parsed = ActionSchema.safeParse(raw);
  if (
    !parsed.success ||
    (parsed.data.action === "update_exception" &&
      parsed.data.workflowAction === "defer" &&
      !parsed.data.deferredUntil) ||
    (parsed.data.action === "update_retention_policy" &&
      parsed.data.legalHoldEnabled !== (parsed.data.legalHoldReason !== null)) ||
    (parsed.data.action === "start_provider_sync" &&
      !validProviderSyncWindow(parsed.data.windowStart, parsed.data.windowEnd)) ||
    (parsed.data.action === "rotate_connector_credential" &&
      (parsed.data.envelope.organizationId !== organization.data ||
        parsed.data.envelope.connectionId !== parsed.data.connectionId ||
        parsed.data.envelope.purpose !== parsed.data.purpose))
  ) {
    return NextResponse.json(
      { code: "INVALID_ACTION" },
      { status: 400, headers: privateResponseHeaders },
    );
  }

  let endpoint: string;
  let method: "POST" | "PATCH";
  let body: Readonly<Record<string, unknown>>;
  if (parsed.data.action === "create_proposal") {
    endpoint = `/v1/organizations/${organization.data}/exceptions/${parsed.data.exceptionId}/proposals`;
    method = "POST";
    body = { type: parsed.data.type, reason: parsed.data.reason };
  } else if (parsed.data.action === "decide_proposal") {
    endpoint = `/v1/organizations/${organization.data}/proposals/${parsed.data.proposalId}/approvals`;
    method = "POST";
    body = { decision: parsed.data.decision, reason: parsed.data.reason };
  } else if (parsed.data.action === "update_member") {
    endpoint = `/v1/organizations/${organization.data}/members/${parsed.data.membershipId}`;
    method = "PATCH";
    body = {
      role: parsed.data.role,
      status: parsed.data.status,
      reason: parsed.data.reason,
    };
  } else if (parsed.data.action === "create_invitation") {
    endpoint = `/v1/organizations/${organization.data}/invitations`;
    method = "POST";
    body = {
      email: parsed.data.email,
      role: parsed.data.role,
      reason: parsed.data.reason,
    };
  } else if (parsed.data.action === "revoke_invitation") {
    endpoint = `/v1/organizations/${organization.data}/invitations/${parsed.data.invitationId}/revoke`;
    method = "POST";
    body = { reason: parsed.data.reason };
  } else if (parsed.data.action === "rollback_import") {
    endpoint = `/v1/organizations/${organization.data}/imports/${parsed.data.importId}/rollback`;
    method = "POST";
    body = {
      confirmImportId: parsed.data.confirmImportId,
      reason: parsed.data.reason,
    };
  } else if (parsed.data.action === "update_organization_profile") {
    endpoint = `/v1/organizations/${organization.data}`;
    method = "PATCH";
    body = {
      name: parsed.data.name,
      expectedProfileVersion: parsed.data.expectedProfileVersion,
      reason: parsed.data.reason,
    };
  } else if (parsed.data.action === "update_review_policy") {
    endpoint = `/v1/organizations/${organization.data}/review-policy`;
    method = "PATCH";
    body = {
      dualApprovalEnabled: parsed.data.dualApprovalEnabled,
      dualApprovalThresholds: parsed.data.dualApprovalThresholds,
      sensitiveResolutionTypes: parsed.data.sensitiveResolutionTypes,
      reason: parsed.data.reason,
    };
  } else if (parsed.data.action === "update_retention_policy") {
    endpoint = `/v1/organizations/${organization.data}/retention-policy`;
    method = "PATCH";
    body = {
      rawImportRetentionDays: parsed.data.rawImportRetentionDays,
      providerEventRetentionDays: parsed.data.providerEventRetentionDays,
      legalHoldEnabled: parsed.data.legalHoldEnabled,
      legalHoldReason: parsed.data.legalHoldReason,
      confirmOrganizationId: organization.data,
      reason: parsed.data.reason,
    };
  } else if (parsed.data.action === "approve_support_access") {
    endpoint = `/v1/organizations/${organization.data}/support-access-grants`;
    method = "POST";
    body = {
      requestCode: parsed.data.requestCode,
      confirmOrganizationId: organization.data,
      ticketReference: parsed.data.ticketReference,
      reason: parsed.data.reason,
    };
  } else if (parsed.data.action === "revoke_support_access") {
    endpoint = `/v1/organizations/${organization.data}/support-access-grants/${parsed.data.grantId}/revoke`;
    method = "POST";
    body = {
      confirmOrganizationId: organization.data,
      reason: parsed.data.reason,
    };
  } else if (parsed.data.action === "start_provider_sync") {
    endpoint = `/v1/organizations/${organization.data}/connections/${parsed.data.connectionId}/provider-sync-runs`;
    method = "POST";
    body = {
      mode: parsed.data.mode,
      windowStart: parsed.data.windowStart,
      windowEnd: parsed.data.windowEnd,
      maximumPages: parsed.data.maximumPages,
      confirmOrganizationId: organization.data,
      reason: parsed.data.reason,
    };
  } else if (parsed.data.action === "rotate_connector_credential") {
    endpoint = `/v1/organizations/${organization.data}/connections/${parsed.data.connectionId}/credentials/rotations`;
    method = "POST";
    body = {
      purpose: parsed.data.purpose,
      envelope: parsed.data.envelope,
      confirmConnectionId: parsed.data.connectionId,
      reason: parsed.data.reason,
    };
  } else if (parsed.data.action === "disconnect_connector") {
    endpoint = `/v1/organizations/${organization.data}/connections/${parsed.data.connectionId}/disconnect`;
    method = "POST";
    body = {
      confirmConnectionId: parsed.data.confirmConnectionId,
      reason: parsed.data.reason,
    };
  } else if (parsed.data.action === "add_note") {
    endpoint = `/v1/organizations/${organization.data}/exceptions/${parsed.data.exceptionId}/notes`;
    method = "POST";
    body = { body: parsed.data.body };
  } else if (parsed.data.action === "start_run") {
    endpoint = `/v1/organizations/${organization.data}/reconciliation-runs`;
    method = "POST";
    body = {
      policyVersion: parsed.data.policyVersion,
      evaluatedAt: parsed.data.evaluatedAt,
      amountToleranceMinor: parsed.data.amountToleranceMinor,
      dateWindowSeconds: parsed.data.dateWindowSeconds,
      delayedEventGraceSeconds: parsed.data.delayedEventGraceSeconds,
      businessTimeZone: parsed.data.businessTimeZone,
      reason: parsed.data.reason,
    };
  } else if (parsed.data.action === "replay_run") {
    endpoint = `/v1/organizations/${organization.data}/reconciliation-runs/${parsed.data.runId}/replay`;
    method = "POST";
    body = { reason: parsed.data.reason };
  } else {
    endpoint = `/v1/organizations/${organization.data}/exceptions/${parsed.data.exceptionId}`;
    method = "PATCH";
    body =
      parsed.data.workflowAction === "defer"
        ? {
            action: parsed.data.workflowAction,
            deferredUntil: parsed.data.deferredUntil ?? "",
            reason: parsed.data.reason,
          }
        : {
            action: parsed.data.workflowAction,
            reason: parsed.data.reason,
          };
  }
  const apiOrigin = readConfiguredOrigin("API_ORIGIN", "http://127.0.0.1:4000");
  try {
    const response = await fetch(new URL(endpoint, apiOrigin), {
      method,
      headers: {
        authorization: `Bearer ${token.apiAccessToken}`,
        "content-type": "application/json",
        accept: "application/json",
        "x-request-id": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const clientError = await readAllowlistedApiError(response, actionErrorPolicy);
      return NextResponse.json(clientError, {
        status: response.status,
        headers: privateResponseHeaders,
      });
    }
    const responseBody = await safeJsonResponse(response);
    const clientResponseBody = minimizeActionResponse(
      parsed.data.action,
      response.status,
      responseBody,
    );
    return NextResponse.json(clientResponseBody, {
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

function minimizeActionResponse(action: ActionName, status: number, body: unknown): unknown {
  if (!(actionSuccessStatuses[action] as readonly number[]).includes(status)) {
    throw new Error("upstream returned an unexpected action status");
  }

  if (action === "create_invitation") {
    const parsed = invitationActionResponseSchema.parse(body);
    return {
      data: { acceptToken: parsed.data.acceptToken },
      meta: { delivery: parsed.meta.delivery },
    };
  }
  if (action === "rollback_import") {
    const parsed = rollbackActionResponseSchema.parse(body);
    return {
      data: {
        status: parsed.data.status,
        supersededRecordCount: parsed.data.supersededRecordCount,
      },
    };
  }
  if (action === "update_organization_profile") {
    const parsed = organizationProfileActionResponseSchema.parse(body);
    return { data: parsed.data };
  }
  if (action === "update_review_policy") {
    const parsed = reviewPolicyActionResponseSchema.parse(body);
    return { data: parsed.data };
  }
  if (action === "update_retention_policy") {
    const parsed = retentionPolicyActionResponseSchema.parse(body);
    return { data: parsed.data };
  }
  if (action === "start_provider_sync") {
    const parsed = providerSyncActionResponseSchema.parse(body);
    return { data: { provider: parsed.data.provider } };
  }
  if (action === "rotate_connector_credential") {
    const parsed = credentialRotationActionResponseSchema.parse(body);
    return {
      data: {
        id: parsed.data.id,
        keyVersion: parsed.data.keyVersion,
      },
    };
  }
  if (action === "disconnect_connector") {
    const parsed = disconnectActionResponseSchema.parse(body);
    return { data: parsed.data };
  }
  if (action === "start_run") {
    const parsed = runStartActionResponseSchema.parse(body);
    return {
      data: {
        id: parsed.data.id,
        status: parsed.data.status,
      },
    };
  }

  acceptedMutationResponseSchema.parse(body);
  return { data: { accepted: true } };
}

function validProviderSyncWindow(windowStart: string, windowEnd: string): boolean {
  const start = Date.parse(windowStart);
  const end = Date.parse(windowEnd);
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start &&
    end - start <= 30 * 24 * 60 * 60 * 1000 &&
    end <= Date.now() + 5 * 60 * 1000
  );
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
