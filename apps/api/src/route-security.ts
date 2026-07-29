import type { Permission } from "@workspace/domain";
import type { ProviderWebhookIngressSurface } from "@workspace/observability";

export type RouteSecurityContract =
  | {
      readonly method: "GET";
      readonly path: `/health/${string}`;
      readonly authentication: "public_health";
      readonly stateChanging: false;
    }
  | {
      readonly method: "GET" | "POST";
      readonly path: `/v1/${string}`;
      readonly authentication: "identity";
      readonly stateChanging: boolean;
    }
  | {
      readonly method: "GET" | "POST";
      readonly path: `/v1/support/${string}`;
      readonly authentication: "support";
      readonly stateChanging: boolean;
    }
  | {
      readonly method: "POST";
      readonly path: `/v1/webhooks/${string}`;
      readonly authentication: "provider_signature";
      readonly stateChanging: true;
      readonly verifier:
        | "shopify_app_hmac"
        | "shopify_connection_hmac"
        | "stripe_app_signature"
        | "stripe_connection_signature";
    }
  | {
      readonly method: "GET" | "POST" | "PATCH";
      readonly path: `/v1/organizations/:organizationId${string}`;
      readonly authentication: "tenant";
      readonly permissions: readonly [Permission, ...Permission[]];
      readonly stateChanging: boolean;
    };

/**
 * Complete authorization inventory for the HTTP boundary.
 *
 * Registration fails closed when a route is absent from this manifest. Tenant contracts are also
 * enforced in a global pre-handler; handler-level checks remain as defense in depth.
 */
export const routeSecurityContracts = [
  {
    method: "GET",
    path: "/health/live",
    authentication: "public_health",
    stateChanging: false,
  },
  {
    method: "GET",
    path: "/health/ready",
    authentication: "public_health",
    stateChanging: false,
  },
  {
    method: "GET",
    path: "/v1/organizations",
    authentication: "identity",
    stateChanging: false,
  },
  {
    method: "POST",
    path: "/v1/organizations",
    authentication: "identity",
    stateChanging: true,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId",
    authentication: "tenant",
    permissions: ["organization:manage"],
    stateChanging: false,
  },
  {
    method: "PATCH",
    path: "/v1/organizations/:organizationId",
    authentication: "tenant",
    permissions: ["organization:manage"],
    stateChanging: true,
  },
  {
    method: "POST",
    path: "/v1/invitations/accept",
    authentication: "identity",
    stateChanging: true,
  },
  {
    method: "POST",
    path: "/v1/support/access-requests",
    authentication: "support",
    stateChanging: true,
  },
  {
    method: "GET",
    path: "/v1/support/organizations/:organizationId/diagnostics",
    authentication: "support",
    stateChanging: false,
  },
  {
    method: "POST",
    path: "/v1/webhooks/shopify/organizations/:organizationId/connections/:connectionId",
    authentication: "provider_signature",
    verifier: "shopify_connection_hmac",
    stateChanging: true,
  },
  {
    method: "POST",
    path: "/v1/webhooks/shopify/privacy",
    authentication: "provider_signature",
    verifier: "shopify_app_hmac",
    stateChanging: true,
  },
  {
    method: "POST",
    path: "/v1/webhooks/stripe/organizations/:organizationId/connections/:connectionId",
    authentication: "provider_signature",
    verifier: "stripe_connection_signature",
    stateChanging: true,
  },
  {
    method: "POST",
    path: "/v1/webhooks/stripe/app-deauthorizations",
    authentication: "provider_signature",
    verifier: "stripe_app_signature",
    stateChanging: true,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId/exceptions",
    authentication: "tenant",
    permissions: ["financial-records:view"],
    stateChanging: false,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/exception-exports",
    authentication: "tenant",
    permissions: ["data:export"],
    stateChanging: true,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/imports/accounting-csv",
    authentication: "tenant",
    permissions: ["connectors:manage"],
    stateChanging: true,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId/imports",
    authentication: "tenant",
    permissions: ["connectors:manage"],
    stateChanging: false,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId/provider-sync-runs",
    authentication: "tenant",
    permissions: ["connectors:manage"],
    stateChanging: false,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/connections/:connectionId/provider-sync-runs",
    authentication: "tenant",
    permissions: ["connectors:manage"],
    stateChanging: true,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId/imports/:importId",
    authentication: "tenant",
    permissions: ["connectors:manage"],
    stateChanging: false,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/imports/:importId/commit",
    authentication: "tenant",
    permissions: ["connectors:manage"],
    stateChanging: true,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/imports/:importId/rollback",
    authentication: "tenant",
    permissions: ["connectors:manage"],
    stateChanging: true,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId/exceptions/:exceptionId",
    authentication: "tenant",
    permissions: ["financial-records:view"],
    stateChanging: false,
  },
  {
    method: "PATCH",
    path: "/v1/organizations/:organizationId/exceptions/:exceptionId",
    authentication: "tenant",
    permissions: ["exceptions:review"],
    stateChanging: true,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/exceptions/:exceptionId/notes",
    authentication: "tenant",
    permissions: ["exceptions:review"],
    stateChanging: true,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/reconciliation-runs",
    authentication: "tenant",
    permissions: ["reconciliation:start"],
    stateChanging: true,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId/reconciliation-runs",
    authentication: "tenant",
    permissions: ["financial-records:view"],
    stateChanging: false,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId/reconciliation-runs/:runId",
    authentication: "tenant",
    permissions: ["financial-records:view"],
    stateChanging: false,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId/reconciliation-runs/:runId/artifacts",
    authentication: "tenant",
    permissions: ["financial-records:view"],
    stateChanging: false,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId/reconciliation-runs/:runId/inputs",
    authentication: "tenant",
    permissions: ["financial-records:view"],
    stateChanging: false,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/reconciliation-runs/:runId/replay",
    authentication: "tenant",
    permissions: ["reconciliation:start"],
    stateChanging: true,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId/members",
    authentication: "tenant",
    permissions: ["members:manage"],
    stateChanging: false,
  },
  {
    method: "PATCH",
    path: "/v1/organizations/:organizationId/members/:membershipId",
    authentication: "tenant",
    permissions: ["members:manage"],
    stateChanging: true,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId/invitations",
    authentication: "tenant",
    permissions: ["members:manage"],
    stateChanging: false,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/invitations",
    authentication: "tenant",
    permissions: ["members:manage"],
    stateChanging: true,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/invitations/:invitationId/revoke",
    authentication: "tenant",
    permissions: ["members:manage"],
    stateChanging: true,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId/connections",
    authentication: "tenant",
    permissions: ["financial-records:view"],
    stateChanging: false,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/provider-authorizations",
    authentication: "tenant",
    permissions: ["connectors:manage"],
    stateChanging: true,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/provider-authorizations/:attemptId/callback",
    authentication: "tenant",
    permissions: ["connectors:manage"],
    stateChanging: true,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId/connections/:connectionId/credentials",
    authentication: "tenant",
    permissions: ["connectors:manage"],
    stateChanging: false,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/connections/:connectionId/credentials/rotations",
    authentication: "tenant",
    permissions: ["connectors:manage"],
    stateChanging: true,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/connections/:connectionId/disconnect",
    authentication: "tenant",
    permissions: ["connectors:manage"],
    stateChanging: true,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId/audit-events",
    authentication: "tenant",
    permissions: ["audit:view"],
    stateChanging: false,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId/support-access-grants",
    authentication: "tenant",
    permissions: ["support:manage"],
    stateChanging: false,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/support-access-grants",
    authentication: "tenant",
    permissions: ["support:manage"],
    stateChanging: true,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/support-access-grants/:grantId/revoke",
    authentication: "tenant",
    permissions: ["support:manage"],
    stateChanging: true,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId/review-policy",
    authentication: "tenant",
    permissions: ["organization:manage"],
    stateChanging: false,
  },
  {
    method: "PATCH",
    path: "/v1/organizations/:organizationId/review-policy",
    authentication: "tenant",
    permissions: ["organization:manage"],
    stateChanging: true,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId/retention-policy",
    authentication: "tenant",
    permissions: ["retention:manage"],
    stateChanging: false,
  },
  {
    method: "GET",
    path: "/v1/organizations/:organizationId/provider-privacy-requests",
    authentication: "tenant",
    permissions: ["retention:manage"],
    stateChanging: false,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/provider-privacy-requests/:requestId/data-package",
    authentication: "tenant",
    permissions: ["retention:manage", "data:export"],
    stateChanging: true,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/provider-privacy-requests/:requestId/data-package/:packageId/receipt",
    authentication: "tenant",
    permissions: ["retention:manage", "data:export"],
    stateChanging: true,
  },
  {
    method: "PATCH",
    path: "/v1/organizations/:organizationId/retention-policy",
    authentication: "tenant",
    permissions: ["retention:manage"],
    stateChanging: true,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/exceptions/:exceptionId/proposals",
    authentication: "tenant",
    permissions: ["exceptions:review"],
    stateChanging: true,
  },
  {
    method: "POST",
    path: "/v1/organizations/:organizationId/proposals/:proposalId/approvals",
    authentication: "tenant",
    permissions: ["resolutions:approve"],
    stateChanging: true,
  },
] as const satisfies readonly RouteSecurityContract[];

const contractsByRoute = new Map<string, RouteSecurityContract>();
for (const contract of routeSecurityContracts) {
  const key = routeKey(contract.method, contract.path);
  if (contractsByRoute.has(key)) {
    throw new Error(`duplicate API route security contract: ${key}`);
  }
  contractsByRoute.set(key, contract);
}

export function routeSecurityContractFor(
  methodValue: string,
  path: string,
): RouteSecurityContract | undefined {
  const method = methodValue.toUpperCase() === "HEAD" ? "GET" : methodValue.toUpperCase();
  return contractsByRoute.get(routeKey(method, path));
}

export function requireRouteSecurityContract(method: string, path: string): RouteSecurityContract {
  const contract = routeSecurityContractFor(method, path);
  if (!contract) {
    throw new Error(`API route has no security contract: ${routeKey(method, path)}`);
  }
  return contract;
}

export function providerWebhookIngressSurfaceFor(
  method: string,
  path: string,
): ProviderWebhookIngressSurface | undefined {
  const contract = routeSecurityContractFor(method, path);
  if (contract?.authentication !== "provider_signature") return undefined;
  switch (contract.verifier) {
    case "shopify_connection_hmac":
      return "shopify_connection";
    case "shopify_app_hmac":
      return "shopify_privacy";
    case "stripe_connection_signature":
      return "stripe_connection";
    case "stripe_app_signature":
      return "stripe_deauthorization";
  }
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}
