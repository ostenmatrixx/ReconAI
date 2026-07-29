import {
  InvitationEmailSchema,
  OrganizationIdSchema,
  OrganizationNameSchema,
  AuthorizationError,
  CurrencySchema,
  RoleSchema,
  SupportAccessGrantIdSchema,
  SupportAccessRequestCodeSchema,
  authorizeTenantAction,
  requirePermission,
  type Permission,
  type SupportIdentityDigest,
  type TenantContext,
} from "@workspace/domain";
import {
  DisabledInvitationEmailProvider,
  InvitationEmailDeliveryError,
  type InvitationEmailDeliveryReceipt,
  type InvitationEmailProvider,
} from "@workspace/email";
import { DEFAULT_CSV_LIMITS, CsvImportMetadataSchema } from "@workspace/connector-csv";
import { ConnectorCredentialEnvelopeSchema } from "@workspace/connectors";
import {
  ConnectorCredentialConflictError,
  ConnectorCredentialNotFoundError,
  ProviderAuthorizationConflictError,
  ProviderAuthorizationExpiredError,
  ProviderAuthorizationNotFoundError,
  ProviderPrivacyOperationsCursorError,
  SupportAccessNotFoundError,
  type ConnectorCredentialLifecycleManager,
  type ProviderPrivacyOperationsRepository,
  type SupportAccessRepository,
} from "@workspace/database";
import {
  CsvImportConflictError,
  CsvImportDispatchError,
  CsvImportNotFoundError,
  CsvImportValidationError,
  PROVIDER_WEBHOOK_MAXIMUM_BYTES,
  ProviderWebhookAuthenticationError,
  ProviderWebhookConflictError,
  ProviderWebhookDispatchError,
  ProviderWebhookValidationError,
  ProviderPrivacyDataPackageEvidenceError,
  ProviderPrivacyDataPackageLimitError,
  ProviderPrivacyDataPackageNotFoundError,
  ProviderPrivacyDataPackageReceiptExpiredError,
  type ProviderPrivacyDataPackageService,
  type CsvImportService,
  type CsvImportReceipt,
  type CsvUpload,
  type ProviderSyncManager,
  type ShopifyPrivacyWebhookService,
  type StripeAppDeauthorizationService,
  type ProviderWebhookService,
} from "@workspace/ingestion";
import {
  activeTraceparent,
  createLogger,
  recordExceptionFinalResolution,
  recordProposalReviewDecision,
  recordReconciliationRunCreationUnavailable,
  safeError,
  startApiRequestObservation,
  startProviderWebhookIngressObservation,
  type ApiRequestObservation,
  type ProviderWebhookIngressObservation,
} from "@workspace/observability";
import { ReconciliationError } from "@workspace/reconciliation";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";

import {
  AuthenticationError,
  type IdentityVerifier,
  type MembershipDirectory,
  type OrganizationBootstrapper,
  OrganizationDirectoryCursorError,
  type VerifiedIdentity,
} from "./auth.js";
import {
  ProviderAuthorizationDisabledError,
  ProviderAuthorizationProviderError,
  type ProviderAuthorizationFlow,
} from "./provider-authorization.js";
import {
  ProviderDisconnectDisabledError,
  ProviderDisconnectProviderError,
  type ProviderDisconnectFlow,
} from "./provider-disconnect.js";
import type { ReadinessProbe } from "./readiness.js";
import {
  EXCEPTION_EXPORT_FILENAME,
  MAX_RUN_ARTIFACT_PAGE_SIZE,
  MAX_RUN_INPUT_PAGE_SIZE,
  RepositoryConflictError,
  RepositoryCursorError,
  RepositoryExportLimitError,
  RepositoryNotFoundError,
  RepositoryRunCreationUnavailableError,
  VerifiedEmailRequiredError,
  type ReconciliationRepository,
} from "./repository.js";
import {
  ApiRateLimitExceededError,
  apiRateLimitPluginOptions,
  type ApiRateLimitConfiguration,
} from "./rate-limit.js";
import {
  providerWebhookIngressSurfaceFor,
  requireRouteSecurityContract,
  type RouteSecurityContract,
} from "./route-security.js";
import type { SupportIdentityAuthorizer } from "./support-identity.js";

interface RequestAuthorizationContext {
  readonly contract: RouteSecurityContract;
  readonly identity?: VerifiedIdentity;
  readonly tenant?: TenantContext;
  readonly supportIdentityDigest?: SupportIdentityDigest;
}

declare module "fastify" {
  interface FastifyRequest {
    reconAuthorization: RequestAuthorizationContext | null;
  }
}

export interface ApiDependencies {
  readonly identityVerifier: IdentityVerifier;
  readonly memberships: MembershipDirectory;
  /** Tests may omit this unless exercising bootstrap; every runtime composition must provide it. */
  readonly organizationBootstrap?: OrganizationBootstrapper;
  readonly repository: ReconciliationRepository;
  readonly csvImports: Pick<
    CsvImportService,
    "createPreview" | "getImport" | "listImports" | "commitImport" | "rollbackImport"
  >;
  readonly providerWebhooks: Pick<ProviderWebhookService, "receiveShopify" | "receiveStripe">;
  readonly shopifyPrivacyWebhooks?: Pick<ShopifyPrivacyWebhookService, "receive">;
  readonly providerPrivacyOperations?: Pick<ProviderPrivacyOperationsRepository, "list">;
  readonly providerPrivacyDataPackages?: Pick<
    ProviderPrivacyDataPackageService,
    "prepare" | "acknowledgeReceipt"
  >;
  readonly providerDeauthorizations?: Pick<StripeAppDeauthorizationService, "receive">;
  readonly providerSyncs?: Pick<ProviderSyncManager, "start" | "list">;
  readonly connectorCredentials?: Pick<
    ConnectorCredentialLifecycleManager,
    "list" | "rotate" | "disconnect"
  >;
  readonly providerDisconnects?: Pick<ProviderDisconnectFlow, "disconnect">;
  readonly providerAuthorizations?: Pick<ProviderAuthorizationFlow, "start" | "callback">;
  /** Tests may omit support dependencies unless exercising support routes. */
  readonly supportIdentityAuthorizer?: SupportIdentityAuthorizer;
  /** Tests may omit support dependencies unless exercising support routes. */
  readonly supportAccess?: SupportAccessRepository;
  readonly invitationEmail?: InvitationEmailProvider;
  readonly webOrigin: string;
  readonly environment: string;
  readonly trustedProxies?: readonly string[];
  readonly rateLimit?: ApiRateLimitConfiguration;
  /** Tests may omit this to use their repository stub; every runtime composition must provide it. */
  readonly readiness?: ReadinessProbe;
}

export type ApiApplication = Pick<FastifyInstance, "close" | "inject" | "listen">;

const organizationParams = z.object({ organizationId: z.uuid() });
const organizationProfileUpdateSchema = z
  .object({
    name: OrganizationNameSchema,
    expectedProfileVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    reason: z
      .string()
      .trim()
      .min(3)
      .max(2000)
      .refine((value) => !containsControlCharacter(value)),
  })
  .strict();
const supportGrantParams = z.object({
  organizationId: z.uuid(),
  grantId: SupportAccessGrantIdSchema,
});
const organizationDirectoryQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    search: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((value) => !containsControlCharacter(value))
      .optional(),
    organizationId: z.uuid().optional(),
    cursor: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/u)
      .optional(),
  })
  .strict()
  .refine(
    (value) => !(value.organizationId && (value.search ?? value.cursor)),
    "exact organization lookup cannot be combined with search or cursor",
  );
const exceptionParams = organizationParams.extend({ exceptionId: z.uuid() });
const exceptionAmountMinorPattern = /^-?(0|[1-9][0-9]{0,30})$/u;
const exceptionAmountMinor = z.string().regex(exceptionAmountMinorPattern);
const exceptionFilterShape = {
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
  amountCurrency: CurrencySchema.optional(),
  minimumAmountMinor: exceptionAmountMinor.optional(),
  maximumAmountMinor: exceptionAmountMinor.optional(),
  confidence: z.enum(["high", "low", "unclassified"]).optional(),
  assignee: z.enum(["me", "assigned", "unassigned"]).optional(),
  age: z
    .enum(["under_24h", "one_to_seven_days", "seven_to_thirty_days", "over_30_days"])
    .optional(),
} as const;
const exceptionListQuery = z
  .object({
    ...exceptionFilterShape,
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,1024}$/u)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
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
      exceptionAmountMinorPattern.test(value.minimumAmountMinor) &&
      exceptionAmountMinorPattern.test(value.maximumAmountMinor) &&
      BigInt(value.minimumAmountMinor) > BigInt(value.maximumAmountMinor)
    ) {
      context.addIssue({
        code: "custom",
        message: "minimumAmountMinor cannot exceed maximumAmountMinor",
        path: ["minimumAmountMinor"],
      });
    }
  });
const exceptionExportFilter = z
  .object(exceptionFilterShape)
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
      exceptionAmountMinorPattern.test(value.minimumAmountMinor) &&
      exceptionAmountMinorPattern.test(value.maximumAmountMinor) &&
      BigInt(value.minimumAmountMinor) > BigInt(value.maximumAmountMinor)
    ) {
      context.addIssue({
        code: "custom",
        message: "minimumAmountMinor cannot exceed maximumAmountMinor",
        path: ["minimumAmountMinor"],
      });
    }
  });
const proposalParams = organizationParams.extend({ proposalId: z.uuid() });
const importParams = organizationParams.extend({ importId: z.uuid() });
const webhookParams = organizationParams.extend({ connectionId: z.uuid() });
const providerSyncParams = organizationParams.extend({ connectionId: z.uuid() });
const connectionParams = organizationParams.extend({ connectionId: z.uuid() });
const providerAuthorizationParams = organizationParams.extend({ attemptId: z.uuid() });
const providerPrivacyRequestParams = organizationParams.extend({ requestId: z.uuid() });
const providerPrivacyPackageReceiptParams = providerPrivacyRequestParams.extend({
  packageId: z.uuid(),
});

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}
const membershipParams = organizationParams.extend({ membershipId: z.uuid() });
const invitationParams = organizationParams.extend({ invitationId: z.uuid() });
const runParams = organizationParams.extend({ runId: z.uuid() });
const shopifyWebhookHeaders = z
  .object({
    "x-shopify-hmac-sha256": z.string().min(1).max(512),
    "x-shopify-webhook-id": z.string().min(1).max(255),
    "x-shopify-topic": z.string().min(1).max(100),
    "x-shopify-api-version": z.string().min(1).max(50),
  })
  .loose();
const shopifyPrivacyWebhookHeaders = shopifyWebhookHeaders
  .extend({
    "x-shopify-shop-domain": z.string().min(1).max(255),
  })
  .loose();
const stripeWebhookHeaders = z
  .object({
    "stripe-signature": z.string().min(1).max(2048),
  })
  .loose();
const reviewPolicyFields = {
  dualApprovalEnabled: z.boolean(),
  dualApprovalThresholds: z
    .record(z.string().regex(/^[A-Z]{3}$/u), z.string().regex(/^(0|[1-9][0-9]{0,30})$/u))
    .refine((value) => Object.keys(value).length <= 50, "at most 50 currency thresholds")
    .transform((value) =>
      Object.fromEntries(
        Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en")),
      ),
    ),
  sensitiveResolutionTypes: z
    .array(z.string().regex(/^[a-z0-9_]{1,100}$/u))
    .max(50)
    .refine((value) => new Set(value).size === value.length, "resolution types must be unique")
    .transform((value) => [...value].sort((left, right) => left.localeCompare(right, "en"))),
} as const;
const retentionPolicyUpdateSchema = z
  .object({
    rawImportRetentionDays: z.number().int().min(1).max(3650).nullable(),
    providerEventRetentionDays: z.number().int().min(1).max(3650).nullable(),
    legalHoldEnabled: z.boolean(),
    legalHoldReason: z.string().trim().min(3).max(2000).nullable(),
    confirmOrganizationId: z.uuid(),
    reason: z.string().trim().min(3).max(2000),
  })
  .superRefine((value, context) => {
    if (value.legalHoldEnabled && value.legalHoldReason === null) {
      context.addIssue({
        code: "custom",
        path: ["legalHoldReason"],
        message: "a legal hold requires a reason",
      });
    }
    if (!value.legalHoldEnabled && value.legalHoldReason !== null) {
      context.addIssue({
        code: "custom",
        path: ["legalHoldReason"],
        message: "a disabled legal hold cannot retain a hold reason",
      });
    }
  });
const providerSyncStartSchema = z
  .object({
    mode: z.enum(["backfill", "gap_repair"]),
    windowStart: z.iso.datetime({ offset: true }),
    windowEnd: z.iso.datetime({ offset: true }),
    maximumPages: z.number().int().min(1).max(100),
    confirmOrganizationId: z.uuid(),
    reason: z.string().trim().min(3).max(2000),
  })
  .strict()
  .superRefine((value, context) => {
    const start = Date.parse(value.windowStart);
    const end = Date.parse(value.windowEnd);
    if (end <= start) {
      context.addIssue({
        code: "custom",
        path: ["windowEnd"],
        message: "provider sync window must end after it starts",
      });
    }
    if (end - start > 30 * 24 * 60 * 60 * 1000) {
      context.addIssue({
        code: "custom",
        path: ["windowEnd"],
        message: "provider sync window cannot exceed 30 days",
      });
    }
    if (end > Date.now() + 5 * 60 * 1000) {
      context.addIssue({
        code: "custom",
        path: ["windowEnd"],
        message: "provider sync window cannot end in the future",
      });
    }
  });
const connectorCredentialRotationSchema = z
  .object({
    purpose: z.enum(["webhook_signing", "api_read"]),
    envelope: ConnectorCredentialEnvelopeSchema,
    confirmConnectionId: z.uuid(),
    reason: z.string().trim().min(3).max(2000),
  })
  .strict();
const connectorDisconnectSchema = z
  .object({
    confirmConnectionId: z.uuid(),
    reason: z.string().trim().min(3).max(2000),
  })
  .strict();
const providerAuthorizationStartSchema = z
  .object({
    provider: z.enum(["shopify", "stripe"]),
    connectionId: z.uuid().optional(),
    requestedAccountId: z.string().trim().min(1).max(255).optional(),
  })
  .strict();
const providerAuthorizationCallbackSchema = z
  .object({
    provider: z.enum(["shopify", "stripe"]),
    query: z
      .array(z.tuple([z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u), z.string().max(4096)]))
      .min(1)
      .max(20),
  })
  .strict();
const exceptionWorkflowSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("assign_self"),
    reason: z.string().trim().min(3).max(2000),
  }),
  z.object({
    action: z.literal("defer"),
    deferredUntil: z.iso.datetime({ offset: true }),
    reason: z.string().trim().min(3).max(2000),
  }),
  z.object({
    action: z.literal("reopen"),
    reason: z.string().trim().min(3).max(2000),
  }),
]);
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date(0));
      return true;
    } catch {
      return false;
    }
  }, "businessTimeZone must be an IANA time zone");
const organizationBootstrapSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !containsControlCharacter(value)),
    businessTimeZone: timeZoneSchema,
    idempotencyKey: z.uuid(),
  })
  .strict();
const supportGrantReasonSchema = z
  .string()
  .trim()
  .min(3)
  .max(2000)
  .refine((value) => !containsControlCharacter(value));
const supportTicketReferenceSchema = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .refine((value) => !containsControlCharacter(value));
export async function buildApi(dependencies: ApiDependencies): Promise<ApiApplication> {
  if (dependencies.environment !== "test" && !dependencies.readiness) {
    throw new Error("non-test API runtime requires composite readiness");
  }
  if (dependencies.environment !== "test" && !dependencies.organizationBootstrap) {
    throw new Error("non-test API runtime requires organization bootstrap");
  }
  if (
    dependencies.environment !== "test" &&
    (!dependencies.supportIdentityAuthorizer || !dependencies.supportAccess)
  ) {
    throw new Error("non-test API runtime requires the default-disabled support access boundary");
  }
  const logger = createLogger("reconai-api", dependencies.environment);
  const invitationEmail = dependencies.invitationEmail ?? new DisabledInvitationEmailProvider();
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 1024 * 1024,
    requestIdHeader: false,
    genReqId: (request) => {
      const candidate = request.headers["x-request-id"];
      return typeof candidate === "string" && requestIdPattern.test(candidate)
        ? candidate.toLowerCase()
        : crypto.randomUUID();
    },
    trustProxy:
      dependencies.trustedProxies && dependencies.trustedProxies.length > 0
        ? [...dependencies.trustedProxies]
        : false,
    ajv: { customOptions: { allErrors: false, removeAdditional: false } },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest("reconAuthorization", null);
  const requestObservations = new WeakMap<object, ApiRequestObservation>();
  const providerWebhookObservations = new WeakMap<object, ProviderWebhookIngressObservation>();
  app.addHook("onRequest", (request, _reply, done) => {
    const traceparent = singleHeader(request.headers.traceparent);
    const route = request.routeOptions.url;
    const observation = startApiRequestObservation({
      method: request.method,
      ...(route ? { route } : {}),
      ...(traceparent ? { traceparent } : {}),
    });
    requestObservations.set(request, observation);
    if (route) {
      const surface = providerWebhookIngressSurfaceFor(request.method, route);
      if (surface) {
        providerWebhookObservations.set(request, startProviderWebhookIngressObservation(surface));
      }
    }
    observation.run(done);
  });
  app.addHook("onResponse", async (request, reply) => {
    requestObservations.get(request)?.finish(reply.statusCode);
    providerWebhookObservations.get(request)?.finish(reply.statusCode);
  });
  app.addHook("onRequestAbort", (request, done) => {
    requestObservations.get(request)?.finish(undefined, true);
    providerWebhookObservations.get(request)?.finish(undefined, true);
    done();
  });
  await app.register(sensible);
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(multipart, {
    limits: {
      fieldNameSize: 100,
      fieldSize: 8192,
      fields: 1,
      fileSize: DEFAULT_CSV_LIMITS.maximumBytes,
      files: 1,
      parts: 2,
      headerPairs: 100,
    },
    throwFileSizeLimit: true,
  });
  await app.register(cors, {
    origin: dependencies.webOrigin,
    credentials: false,
    methods: ["GET", "POST", "PATCH"],
    allowedHeaders: ["authorization", "content-type", "traceparent", "x-request-id"],
    maxAge: 600,
  });
  await app.register(rateLimit, apiRateLimitPluginOptions(dependencies.rateLimit));
  app.addHook("onRoute", (routeOptions) => {
    if (!routeOptions.url) throw new Error("API route is missing its path");
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) {
      requireRouteSecurityContract(method, routeOptions.url);
    }
  });
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/v1/")) {
      void reply.header("Cache-Control", "no-store, private").header("Pragma", "no-cache");
    }
  });
  app.addHook("preHandler", async (request) => {
    const routePath = request.routeOptions.url;
    if (!routePath) throw new Error("matched API route is missing its path");
    const contract = requireRouteSecurityContract(request.method, routePath);
    if (
      contract.authentication === "public_health" ||
      contract.authentication === "provider_signature"
    ) {
      request.reconAuthorization = { contract };
      return;
    }
    const identity = await dependencies.identityVerifier.verifyAuthorizationHeader(
      request.headers.authorization,
    );
    if (contract.authentication === "support") {
      if (!dependencies.supportIdentityAuthorizer) throw new AuthorizationError();
      const supportIdentityDigest = dependencies.supportIdentityAuthorizer.authorize(identity);
      request.reconAuthorization = { contract, identity, supportIdentityDigest };
      return;
    }
    if (contract.authentication === "identity") {
      request.reconAuthorization = { contract, identity };
      return;
    }
    const organizationId = requestOrganizationId(request);
    const tenant = await dependencies.memberships.resolve(identity, organizationId);
    if (!tenant) throw new AuthorizationError();
    for (const permission of contract.permissions) {
      authorizeTenantAction(tenant, organizationId, permission);
    }
    request.reconAuthorization = { contract, identity, tenant };
  });

  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.id;
    if (error instanceof ApiRateLimitExceededError) {
      void reply.code(429).send({
        code: error.code,
        message: error.message,
        correlationId,
      });
      return;
    }
    if (error instanceof AuthenticationError) {
      void reply.code(401).send({
        code: "AUTHENTICATION_REQUIRED",
        message: "authentication required",
        correlationId,
      });
      return;
    }
    if (error instanceof AuthorizationError) {
      void reply.code(404).send({
        code: "RESOURCE_NOT_FOUND",
        message: "resource not found",
        correlationId,
      });
      return;
    }
    if (error instanceof SupportAccessNotFoundError) {
      void reply.code(404).send({
        code: "RESOURCE_NOT_FOUND",
        message: "resource not found",
        correlationId,
      });
      return;
    }
    if (error instanceof RepositoryNotFoundError) {
      void reply.code(404).send({
        code: "RESOURCE_NOT_FOUND",
        message: "resource not found",
        correlationId,
      });
      return;
    }
    if (error instanceof RepositoryConflictError) {
      void reply.code(409).send({
        code: "CONFLICT",
        message: error.message,
        correlationId,
      });
      return;
    }
    if (error instanceof RepositoryRunCreationUnavailableError) {
      recordReconciliationRunCreationUnavailable(error.reason);
      void reply.code(503).send({
        code: "RECONCILIATION_RUN_CREATION_UNAVAILABLE",
        message: error.message,
        correlationId,
      });
      return;
    }
    if (error instanceof ConnectorCredentialNotFoundError) {
      void reply.code(404).send({
        code: "RESOURCE_NOT_FOUND",
        message: "resource not found",
        correlationId,
      });
      return;
    }
    if (error instanceof ConnectorCredentialConflictError) {
      void reply.code(409).send({
        code: "CONNECTOR_CREDENTIAL_CONFLICT",
        message: error.message,
        correlationId,
      });
      return;
    }
    if (error instanceof ProviderAuthorizationNotFoundError) {
      void reply.code(404).send({
        code: "RESOURCE_NOT_FOUND",
        message: "resource not found",
        correlationId,
      });
      return;
    }
    if (error instanceof ProviderAuthorizationExpiredError) {
      void reply.code(410).send({
        code: "PROVIDER_AUTHORIZATION_EXPIRED",
        message: "provider authorization expired; start again",
        correlationId,
      });
      return;
    }
    if (error instanceof ProviderAuthorizationConflictError) {
      void reply.code(409).send({
        code: "PROVIDER_AUTHORIZATION_CONFLICT",
        message: error.message,
        correlationId,
      });
      return;
    }
    if (error instanceof ProviderAuthorizationDisabledError) {
      void reply.code(503).send({
        code: "PROVIDER_AUTHORIZATION_DISABLED",
        message: "provider authorization is not configured",
        correlationId,
      });
      return;
    }
    if (error instanceof ProviderAuthorizationProviderError) {
      const unavailable = ["rate_limited", "timeout", "provider_unavailable"].includes(error.kind);
      void reply.code(unavailable ? 503 : 400).send({
        code: unavailable ? "PROVIDER_AUTHORIZATION_UNAVAILABLE" : "PROVIDER_AUTHORIZATION_INVALID",
        message: error.message,
        correlationId,
      });
      return;
    }
    if (error instanceof ProviderDisconnectDisabledError) {
      void reply.code(503).send({
        code: "PROVIDER_DISCONNECT_DISABLED",
        message: "provider disconnect is not configured",
        correlationId,
      });
      return;
    }
    if (error instanceof ProviderDisconnectProviderError) {
      const unavailable = ["rate_limited", "timeout", "provider_unavailable"].includes(error.kind);
      void reply.code(unavailable ? 503 : 409).send({
        code: unavailable ? "PROVIDER_DISCONNECT_UNAVAILABLE" : "PROVIDER_DISCONNECT_UNCONFIRMED",
        message: "provider disconnect could not be confirmed",
        correlationId,
      });
      return;
    }
    if (
      error instanceof RepositoryCursorError ||
      error instanceof ProviderPrivacyOperationsCursorError
    ) {
      void reply.code(400).send({
        code: "INVALID_CURSOR",
        message: error.message,
        correlationId,
      });
      return;
    }
    if (error instanceof RepositoryExportLimitError) {
      void reply.code(422).send({
        code: "EXPORT_LIMIT_EXCEEDED",
        message: error.message,
        correlationId,
      });
      return;
    }
    if (error instanceof ProviderPrivacyDataPackageNotFoundError) {
      void reply.code(404).send({
        code: "RESOURCE_NOT_FOUND",
        message: "resource not found",
        correlationId,
      });
      return;
    }
    if (error instanceof ProviderPrivacyDataPackageReceiptExpiredError) {
      void reply.code(410).send({
        code: "PRIVACY_DATA_PACKAGE_RECEIPT_EXPIRED",
        message: error.message,
        correlationId,
      });
      return;
    }
    if (error instanceof ProviderPrivacyDataPackageLimitError) {
      void reply.code(422).send({
        code: "PRIVACY_DATA_PACKAGE_LIMIT_EXCEEDED",
        message: error.message,
        correlationId,
      });
      return;
    }
    if (error instanceof ProviderPrivacyDataPackageEvidenceError) {
      void reply.code(409).send({
        code: "PRIVACY_DATA_EVIDENCE_UNAVAILABLE",
        message: error.message,
        correlationId,
      });
      return;
    }
    if (error instanceof VerifiedEmailRequiredError) {
      void reply.code(403).send({
        code: "VERIFIED_EMAIL_REQUIRED",
        message: error.message,
        correlationId,
      });
      return;
    }
    if (error instanceof ReconciliationError) {
      void reply.code(422).send({
        code: "RECONCILIATION_INPUT_INVALID",
        message: error.message,
        correlationId,
      });
      return;
    }
    if (error instanceof CsvImportNotFoundError) {
      void reply.code(404).send({
        code: "RESOURCE_NOT_FOUND",
        message: "resource not found",
        correlationId,
      });
      return;
    }
    if (error instanceof CsvImportConflictError) {
      void reply.code(409).send({
        code: "IMPORT_CONFLICT",
        message: error.message,
        correlationId,
      });
      return;
    }
    if (error instanceof CsvImportValidationError) {
      void reply.code(400).send({
        code: "INVALID_CSV_IMPORT",
        message: error.message,
        correlationId,
      });
      return;
    }
    if (error instanceof CsvImportDispatchError) {
      void reply.code(503).send({
        code: "IMPORT_DISPATCH_UNAVAILABLE",
        message: error.message,
        correlationId,
      });
      return;
    }
    if (error instanceof ProviderWebhookAuthenticationError) {
      void reply.code(401).send({
        code: "WEBHOOK_AUTHENTICATION_FAILED",
        message: "provider webhook authentication failed",
        correlationId,
      });
      return;
    }
    if (error instanceof ProviderWebhookValidationError || error instanceof z.ZodError) {
      void reply.code(400).send({
        code: "INVALID_PROVIDER_WEBHOOK",
        message: "provider webhook failed validation",
        correlationId,
      });
      return;
    }
    if (error instanceof ProviderWebhookConflictError) {
      void reply.code(409).send({
        code: "PROVIDER_EVENT_CONFLICT",
        message: "provider event identity conflicts with stored evidence",
        correlationId,
      });
      return;
    }
    if (error instanceof ProviderWebhookDispatchError) {
      void reply.code(503).send({
        code: "WEBHOOK_DISPATCH_UNAVAILABLE",
        message: "provider webhook is durable but dispatch is temporarily unavailable",
        correlationId,
      });
      return;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      (error.statusCode === 400 || error.statusCode === 413 || error.statusCode === 415)
    ) {
      void reply.code(error.statusCode).send({
        code: "INVALID_CSV_IMPORT",
        message: "CSV upload did not satisfy the bounded multipart contract",
        correlationId,
      });
      return;
    }
    if (typeof error === "object" && error !== null && "validation" in error && error.validation) {
      void reply.code(400).send({
        code: "INVALID_REQUEST",
        message: "request validation failed",
        correlationId,
      });
      return;
    }
    request.log.error({ error: safeError(error), correlationId }, "request failed");
    void reply.code(500).send({
      code: "INTERNAL_ERROR",
      message: "request could not be completed",
      correlationId,
    });
  });

  app.get("/health/live", { config: { rateLimit: false } }, async () => ({ status: "ok" }));
  app.get("/health/ready", { config: { rateLimit: false } }, async (_request, reply) => {
    let healthy = false;
    try {
      healthy = dependencies.readiness
        ? await dependencies.readiness.ready()
        : await dependencies.repository.health();
    } catch {
      // Public health responses never expose dependency failures.
    }
    return healthy ? { status: "ready" } : reply.code(503).send({ status: "not_ready" });
  });

  app.get(
    "/v1/organizations",
    { schema: { querystring: organizationDirectoryQuery } },
    async (request, reply) => {
      const identity = await verifiedIdentity(request, dependencies);
      try {
        const page = await dependencies.memberships.list(identity, {
          limit: request.query.limit,
          ...(request.query.search ? { search: request.query.search } : {}),
          ...(request.query.organizationId
            ? { organizationId: OrganizationIdSchema.parse(request.query.organizationId) }
            : {}),
          ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
        });
        return {
          data: page.items,
          meta: {
            correlationId: request.id,
            truncated: page.nextCursor !== undefined,
            maximumItems: 100,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          },
        };
      } catch (error) {
        if (error instanceof OrganizationDirectoryCursorError) {
          return reply.code(400).send({
            code: "INVALID_ORGANIZATION_CURSOR",
            message: "organization directory cursor is invalid",
            correlationId: request.id,
          });
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/organizations",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { body: organizationBootstrapSchema },
    },
    async (request, reply) => {
      const identity = await verifiedIdentity(request, dependencies);
      if (!identity.emailVerified || !identity.email) {
        return reply.code(403).send({
          code: "VERIFIED_EMAIL_REQUIRED",
          message: "a provider-verified email is required",
          correlationId: request.id,
        });
      }
      if (!dependencies.organizationBootstrap) {
        return reply.code(503).send({
          code: "ORGANIZATION_BOOTSTRAP_UNAVAILABLE",
          message: "organization creation is unavailable",
          correlationId: request.id,
        });
      }

      const result = await dependencies.organizationBootstrap.bootstrap(identity, {
        name: request.body.name,
        businessTimeZone: request.body.businessTimeZone,
        idempotencyKey: request.body.idempotencyKey,
        correlationId: request.id,
      });
      if (!result.access || !result.businessTimeZone) {
        return reply.code(409).send({
          code: "ORGANIZATION_BOOTSTRAP_NOT_AVAILABLE",
          message: "organization creation is not available for this identity or request",
          correlationId: request.id,
        });
      }

      return reply.code(result.status === "created" ? 201 : 200).send({
        data: {
          ...result.access,
          businessTimeZone: result.businessTimeZone,
        },
        meta: {
          correlationId: request.id,
          replayed: result.status === "replayed",
        },
      });
    },
  );

  app.get(
    "/v1/organizations/:organizationId",
    { schema: { params: organizationParams } },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "organization:manage",
        dependencies,
      );
      const profile = await dependencies.repository.getOrganizationProfile(tenant);
      return { data: profile, meta: { correlationId: request.id } };
    },
  );

  app.patch(
    "/v1/organizations/:organizationId",
    {
      schema: {
        params: organizationParams,
        body: organizationProfileUpdateSchema,
      },
    },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "organization:manage",
        dependencies,
      );
      const profile = await dependencies.repository.updateOrganizationProfile(tenant, request.body);
      return { data: profile, meta: { correlationId: request.id } };
    },
  );

  await app.register(async (webhookApp) => {
    const routes = webhookApp.withTypeProvider<ZodTypeProvider>();
    routes.removeContentTypeParser("application/json");
    routes.addContentTypeParser(
      "application/json",
      {
        parseAs: "buffer",
        bodyLimit: PROVIDER_WEBHOOK_MAXIMUM_BYTES,
      },
      (_request, body, done) => {
        done(null, body);
      },
    );

    routes.post(
      "/v1/webhooks/shopify/organizations/:organizationId/connections/:connectionId",
      {
        schema: {
          params: webhookParams,
          headers: shopifyWebhookHeaders,
        },
      },
      async (request, reply) => {
        const durableTraceparent = activeTraceparent();
        const result = await dependencies.providerWebhooks.receiveShopify({
          organizationId: request.params.organizationId,
          connectionId: request.params.connectionId,
          rawBody: parseWebhookBody(request.body),
          hmac: request.headers["x-shopify-hmac-sha256"],
          webhookId: request.headers["x-shopify-webhook-id"],
          topic: request.headers["x-shopify-topic"],
          apiVersion: request.headers["x-shopify-api-version"],
          correlationId: request.id,
          ...(durableTraceparent ? { traceparent: durableTraceparent } : {}),
        });
        return reply.code(result.duplicate ? 200 : 202).send({
          data: result,
          meta: { correlationId: request.id },
        });
      },
    );

    if (dependencies.shopifyPrivacyWebhooks) {
      routes.post(
        "/v1/webhooks/shopify/privacy",
        {
          schema: {
            headers: shopifyPrivacyWebhookHeaders,
          },
        },
        async (request, reply) => {
          const result = await dependencies.shopifyPrivacyWebhooks?.receive({
            rawBody: parseWebhookBody(request.body),
            hmac: request.headers["x-shopify-hmac-sha256"],
            webhookId: request.headers["x-shopify-webhook-id"],
            topic: request.headers["x-shopify-topic"],
            apiVersion: request.headers["x-shopify-api-version"],
            shopDomain: request.headers["x-shopify-shop-domain"],
            correlationId: request.id,
          });
          if (!result) throw new Error("Shopify privacy webhook lifecycle is unavailable");
          return reply.code(result.duplicate ? 200 : 202).send({
            data: result,
            meta: { correlationId: request.id },
          });
        },
      );
    }

    routes.post(
      "/v1/webhooks/stripe/organizations/:organizationId/connections/:connectionId",
      {
        schema: {
          params: webhookParams,
          headers: stripeWebhookHeaders,
        },
      },
      async (request, reply) => {
        const durableTraceparent = activeTraceparent();
        const result = await dependencies.providerWebhooks.receiveStripe({
          organizationId: request.params.organizationId,
          connectionId: request.params.connectionId,
          rawBody: parseWebhookBody(request.body),
          signature: request.headers["stripe-signature"],
          correlationId: request.id,
          ...(durableTraceparent ? { traceparent: durableTraceparent } : {}),
        });
        return reply.code(result.duplicate ? 200 : 202).send({
          data: result,
          meta: { correlationId: request.id },
        });
      },
    );

    if (dependencies.providerDeauthorizations) {
      routes.post(
        "/v1/webhooks/stripe/app-deauthorizations",
        {
          schema: {
            headers: stripeWebhookHeaders,
          },
        },
        async (request, reply) => {
          const result = await dependencies.providerDeauthorizations?.receive({
            rawBody: parseWebhookBody(request.body),
            signature: request.headers["stripe-signature"],
            correlationId: request.id,
          });
          if (!result) throw new Error("Stripe app deauthorization lifecycle is unavailable");
          return reply.code(result.duplicate ? 200 : 202).send({
            data: result,
            meta: { correlationId: request.id },
          });
        },
      );
    }
  });

  app.get(
    "/v1/organizations/:organizationId/exceptions",
    {
      schema: {
        params: organizationParams,
        querystring: exceptionListQuery,
      },
    },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "financial-records:view",
        dependencies,
      );
      const options = {
        limit: request.query.limit,
        ...(request.query.status ? { status: request.query.status } : {}),
        ...(request.query.severity ? { severity: request.query.severity } : {}),
        ...(request.query.search ? { search: request.query.search } : {}),
        ...(request.query.source ? { source: request.query.source } : {}),
        ...(request.query.amountCurrency ? { amountCurrency: request.query.amountCurrency } : {}),
        ...(request.query.minimumAmountMinor
          ? { minimumAmountMinor: request.query.minimumAmountMinor }
          : {}),
        ...(request.query.maximumAmountMinor
          ? { maximumAmountMinor: request.query.maximumAmountMinor }
          : {}),
        ...(request.query.confidence ? { confidence: request.query.confidence } : {}),
        ...(request.query.assignee ? { assignee: request.query.assignee } : {}),
        ...(request.query.age ? { age: request.query.age } : {}),
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      };
      const page = await dependencies.repository.listExceptions(tenant, options);
      return {
        data: page.items,
        meta: {
          correlationId: request.id,
          filteredCount: page.filteredCount,
          canExport: tenant.permissions.has("data:export"),
          summary: page.summary,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
      };
    },
  );

  app.post(
    "/v1/organizations/:organizationId/exception-exports",
    {
      schema: {
        params: organizationParams,
        body: exceptionExportFilter,
      },
    },
    async (request, reply) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "data:export",
        dependencies,
      );
      const filters = {
        ...(request.body.status ? { status: request.body.status } : {}),
        ...(request.body.severity ? { severity: request.body.severity } : {}),
        ...(request.body.search ? { search: request.body.search } : {}),
        ...(request.body.source ? { source: request.body.source } : {}),
        ...(request.body.amountCurrency ? { amountCurrency: request.body.amountCurrency } : {}),
        ...(request.body.minimumAmountMinor
          ? { minimumAmountMinor: request.body.minimumAmountMinor }
          : {}),
        ...(request.body.maximumAmountMinor
          ? { maximumAmountMinor: request.body.maximumAmountMinor }
          : {}),
        ...(request.body.confidence ? { confidence: request.body.confidence } : {}),
        ...(request.body.assignee ? { assignee: request.body.assignee } : {}),
        ...(request.body.age ? { age: request.body.age } : {}),
      };
      const exported = await dependencies.repository.exportExceptions(tenant, filters, {
        correlationId: request.id,
      });
      const payload = Buffer.from(exported.csv, "utf8");
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${EXCEPTION_EXPORT_FILENAME}"`)
        .header("Content-Length", payload.byteLength)
        .header("X-ReconAI-Export-Id", exported.id)
        .send(payload);
    },
  );

  app.post(
    "/v1/organizations/:organizationId/imports/accounting-csv",
    {
      bodyLimit: DEFAULT_CSV_LIMITS.maximumBytes + 64 * 1024,
      schema: { params: organizationParams },
    },
    async (request, reply) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "connectors:manage",
        dependencies,
      );
      const upload = await readCsvMultipart(request);
      const result = await dependencies.csvImports.createPreview(tenant, upload);
      return reply.code(result.duplicate ? 200 : 201).send({
        data: importResponse(result.receipt),
        meta: { correlationId: request.id, duplicate: result.duplicate },
      });
    },
  );

  app.get(
    "/v1/organizations/:organizationId/imports",
    {
      schema: {
        params: organizationParams,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
    },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "connectors:manage",
        dependencies,
      );
      const receipts = await dependencies.csvImports.listImports(tenant, request.query.limit);
      return {
        data: receipts.map((receipt) => importListResponse(receipt)),
        meta: { correlationId: request.id },
      };
    },
  );

  app.get(
    "/v1/organizations/:organizationId/provider-sync-runs",
    {
      schema: {
        params: organizationParams,
        querystring: z
          .object({
            connectionId: z.uuid().optional(),
          })
          .strict(),
      },
    },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "connectors:manage",
        dependencies,
      );
      if (!dependencies.providerSyncs) throw new Error("provider sync manager is unavailable");
      const runs = await dependencies.providerSyncs.list(tenant, request.query.connectionId);
      return {
        data: runs,
        meta: { correlationId: request.id, maximumItems: 50 },
      };
    },
  );

  app.post(
    "/v1/organizations/:organizationId/connections/:connectionId/provider-sync-runs",
    {
      schema: {
        params: providerSyncParams,
        body: providerSyncStartSchema,
      },
    },
    async (request, reply) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "connectors:manage",
        dependencies,
      );
      if (request.body.confirmOrganizationId !== request.params.organizationId) {
        throw new RepositoryConflictError(
          "organization confirmation does not match the provider sync target",
        );
      }
      if (!dependencies.providerSyncs) throw new Error("provider sync manager is unavailable");
      const durableTraceparent = activeTraceparent();
      const run = await dependencies.providerSyncs.start(tenant, {
        connectionId: request.params.connectionId,
        mode: request.body.mode,
        windowStart: request.body.windowStart,
        windowEnd: request.body.windowEnd,
        maximumPages: request.body.maximumPages,
        reason: request.body.reason,
        correlationId: request.id,
        ...(durableTraceparent ? { traceparent: durableTraceparent } : {}),
      });
      return reply.code(202).send({
        data: run,
        meta: { correlationId: request.id },
      });
    },
  );

  app.get(
    "/v1/organizations/:organizationId/imports/:importId",
    { schema: { params: importParams } },
    async (request, reply) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "connectors:manage",
        dependencies,
      );
      const receipt = await dependencies.csvImports.getImport(tenant, request.params.importId);
      if (!receipt) return reply.notFound("resource not found");
      return { data: importResponse(receipt), meta: { correlationId: request.id } };
    },
  );

  app.post(
    "/v1/organizations/:organizationId/imports/:importId/commit",
    {
      schema: {
        params: importParams,
        body: z.object({ reason: z.string().trim().min(3).max(2000) }).strict(),
      },
    },
    async (request, reply) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "connectors:manage",
        dependencies,
      );
      const durableTraceparent = activeTraceparent();
      const receipt = await dependencies.csvImports.commitImport(tenant, {
        importId: request.params.importId,
        correlationId: request.id,
        reason: request.body.reason,
        ...(durableTraceparent ? { traceparent: durableTraceparent } : {}),
      });
      return reply.code(202).send({
        data: importResponse(receipt),
        meta: { correlationId: request.id },
      });
    },
  );

  app.post(
    "/v1/organizations/:organizationId/imports/:importId/rollback",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        params: importParams,
        body: z
          .object({
            confirmImportId: z.uuid(),
            reason: z.string().trim().min(3).max(2000),
          })
          .strict(),
      },
    },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "connectors:manage",
        dependencies,
      );
      const receipt = await dependencies.csvImports.rollbackImport(tenant, {
        importId: request.params.importId,
        confirmImportId: request.body.confirmImportId,
        correlationId: request.id,
        reason: request.body.reason,
      });
      return {
        data: importResponse(receipt),
        meta: { correlationId: request.id },
      };
    },
  );

  app.get(
    "/v1/organizations/:organizationId/exceptions/:exceptionId",
    { schema: { params: exceptionParams } },
    async (request, reply) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "financial-records:view",
        dependencies,
      );
      const item = await dependencies.repository.getException(tenant, request.params.exceptionId);
      if (!item) return reply.notFound("resource not found");
      return { data: item, meta: { correlationId: request.id } };
    },
  );

  app.patch(
    "/v1/organizations/:organizationId/exceptions/:exceptionId",
    {
      schema: {
        params: exceptionParams,
        body: exceptionWorkflowSchema,
      },
    },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "exceptions:review",
        dependencies,
      );
      const result = await dependencies.repository.updateExceptionWorkflow(
        tenant,
        request.params.exceptionId,
        request.body,
      );
      return { data: result, meta: { correlationId: request.id } };
    },
  );

  app.post(
    "/v1/organizations/:organizationId/exceptions/:exceptionId/notes",
    {
      schema: {
        params: exceptionParams,
        body: z.object({ body: z.string().trim().min(3).max(4000) }).strict(),
      },
    },
    async (request, reply) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "exceptions:review",
        dependencies,
      );
      const note = await dependencies.repository.addExceptionNote(
        tenant,
        request.params.exceptionId,
        request.body.body,
      );
      return reply.code(201).send({ data: note, meta: { correlationId: request.id } });
    },
  );

  app.post(
    "/v1/organizations/:organizationId/reconciliation-runs",
    {
      schema: {
        params: organizationParams,
        body: z
          .object({
            policyVersion: z.string().trim().min(1).max(50),
            evaluatedAt: z.iso.datetime({ offset: true }),
            amountToleranceMinor: z
              .record(CurrencySchema, z.string().regex(/^(0|[1-9][0-9]{0,18})$/u))
              .refine((value) => Object.keys(value).length <= 50, "at most 50 currency tolerances")
              .optional(),
            dateWindowSeconds: z
              .int()
              .min(0)
              .max(31 * 86_400),
            delayedEventGraceSeconds: z
              .int()
              .min(0)
              .max(31 * 86_400),
            businessTimeZone: timeZoneSchema,
            reason: z.string().trim().min(3).max(2000),
          })
          .strict(),
      },
    },
    async (request, reply) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "reconciliation:start",
        dependencies,
      );
      const abortController = new AbortController();
      const abortRunCreation = (): void => abortController.abort();
      const durableTraceparent = activeTraceparent();
      request.raw.once("aborted", abortRunCreation);
      const result = await (async () => {
        try {
          return await dependencies.repository.startRun(
            tenant,
            {
              version: request.body.policyVersion,
              evaluatedAt: request.body.evaluatedAt,
              amountToleranceMinor: Object.fromEntries(
                Object.entries(request.body.amountToleranceMinor ?? {}).map(
                  ([currency, amount]) => [CurrencySchema.parse(currency), BigInt(amount)],
                ),
              ),
              dateWindowSeconds: request.body.dateWindowSeconds,
              delayedEventGraceSeconds: request.body.delayedEventGraceSeconds,
              businessTimeZone: request.body.businessTimeZone,
            },
            {
              correlationId: request.id,
              reason: request.body.reason,
              signal: abortController.signal,
              ...(durableTraceparent ? { traceparent: durableTraceparent } : {}),
            },
          );
        } finally {
          request.raw.removeListener("aborted", abortRunCreation);
        }
      })();
      return reply.code(202).send({
        data: result,
        meta: { correlationId: request.id },
      });
    },
  );

  app.get(
    "/v1/organizations/:organizationId/reconciliation-runs",
    {
      schema: {
        params: organizationParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
      },
    },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "financial-records:view",
        dependencies,
      );
      const runs = await dependencies.repository.listRuns(tenant, {
        limit: request.query.limit,
      });
      return { data: runs, meta: { correlationId: request.id } };
    },
  );

  app.get(
    "/v1/organizations/:organizationId/reconciliation-runs/:runId",
    { schema: { params: runParams } },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "financial-records:view",
        dependencies,
      );
      const run = await dependencies.repository.getRun(tenant, request.params.runId);
      if (!run) throw new RepositoryNotFoundError();
      return { data: run, meta: { correlationId: request.id } };
    },
  );

  app.get(
    "/v1/organizations/:organizationId/reconciliation-runs/:runId/artifacts",
    {
      schema: {
        params: runParams,
        querystring: z
          .object({
            type: z.enum(["match", "exception"]),
            limit: z.coerce.number().int().min(1).max(MAX_RUN_ARTIFACT_PAGE_SIZE).default(25),
            cursor: z
              .string()
              .min(1)
              .max(1024)
              .regex(/^[A-Za-z0-9_-]+$/u)
              .optional(),
          })
          .strict(),
      },
    },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "financial-records:view",
        dependencies,
      );
      const page = await dependencies.repository.listRunArtifacts(tenant, request.params.runId, {
        type: request.query.type,
        limit: request.query.limit,
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      });
      if (!page) throw new RepositoryNotFoundError();
      return {
        data: { type: page.type, items: page.items },
        meta: {
          correlationId: request.id,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
      };
    },
  );

  app.get(
    "/v1/organizations/:organizationId/reconciliation-runs/:runId/inputs",
    {
      schema: {
        params: runParams,
        querystring: z
          .object({
            limit: z.coerce.number().int().min(1).max(MAX_RUN_INPUT_PAGE_SIZE).default(100),
            cursor: z
              .string()
              .min(1)
              .max(1024)
              .regex(/^[A-Za-z0-9_-]+$/u)
              .optional(),
          })
          .strict(),
      },
    },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "financial-records:view",
        dependencies,
      );
      const page = await dependencies.repository.listRunInputs(tenant, request.params.runId, {
        limit: request.query.limit,
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      });
      if (!page) throw new RepositoryNotFoundError();
      return {
        data: page.items,
        meta: {
          correlationId: request.id,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
      };
    },
  );

  app.post(
    "/v1/organizations/:organizationId/reconciliation-runs/:runId/replay",
    {
      schema: {
        params: runParams,
        body: z.object({ reason: z.string().trim().min(3).max(2000) }).strict(),
      },
    },
    async (request, reply) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "reconciliation:start",
        dependencies,
      );
      const run = await dependencies.repository.replayRun(tenant, request.params.runId, {
        correlationId: request.id,
        reason: request.body.reason,
        now: new Date().toISOString(),
      });
      return reply.code(202).send({
        data: run,
        meta: { correlationId: request.id },
      });
    },
  );

  app.post(
    "/v1/invitations/accept",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        body: z
          .object({
            token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
          })
          .strict(),
      },
    },
    async (request, reply) => {
      const identity = await verifiedIdentity(request, dependencies);
      const accepted = await dependencies.repository.acceptInvitation(
        identity,
        request.body.token,
        { correlationId: request.id },
      );
      return reply.code(201).send({
        data: accepted,
        meta: { correlationId: request.id },
      });
    },
  );

  app.post(
    "/v1/support/access-requests",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        body: z
          .object({
            requestedDurationMinutes: z.number().int().min(5).max(60),
          })
          .strict(),
      },
    },
    async (request, reply) => {
      const supportIdentityDigest = authorizeSupportRequest(request, dependencies);
      if (!dependencies.supportAccess) throw new AuthorizationError();
      const supportRequest = await dependencies.supportAccess.createRequest(
        supportIdentityDigest,
        request.body,
      );
      return reply.code(201).send({
        data: supportRequest,
        meta: { correlationId: request.id },
      });
    },
  );

  app.get(
    "/v1/support/organizations/:organizationId/diagnostics",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        params: organizationParams,
        querystring: z.object({ grantId: SupportAccessGrantIdSchema }).strict(),
      },
    },
    async (request) => {
      const supportIdentityDigest = authorizeSupportRequest(request, dependencies);
      if (!dependencies.supportAccess) throw new AuthorizationError();
      const diagnostics = await dependencies.supportAccess.diagnostics(
        OrganizationIdSchema.parse(request.params.organizationId),
        request.query.grantId,
        supportIdentityDigest,
        request.id,
      );
      return { data: diagnostics, meta: { correlationId: request.id } };
    },
  );

  app.get(
    "/v1/organizations/:organizationId/members",
    { schema: { params: organizationParams } },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "members:manage",
        dependencies,
      );
      const members = await dependencies.repository.listMembers(tenant);
      return { data: members, meta: { correlationId: request.id } };
    },
  );

  app.patch(
    "/v1/organizations/:organizationId/members/:membershipId",
    {
      schema: {
        params: membershipParams,
        body: z.object({
          role: RoleSchema,
          status: z.enum(["active", "deactivated"]),
          reason: z.string().trim().min(3).max(2000),
        }),
      },
    },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "members:manage",
        dependencies,
      );
      const member = await dependencies.repository.updateMember(
        tenant,
        request.params.membershipId,
        request.body,
      );
      return { data: member, meta: { correlationId: request.id } };
    },
  );

  app.get(
    "/v1/organizations/:organizationId/invitations",
    { schema: { params: organizationParams } },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "members:manage",
        dependencies,
      );
      const invitations = await dependencies.repository.listInvitations(tenant);
      return { data: invitations, meta: { correlationId: request.id } };
    },
  );

  app.post(
    "/v1/organizations/:organizationId/invitations",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        params: organizationParams,
        body: z
          .object({
            email: InvitationEmailSchema,
            role: RoleSchema,
            reason: z.string().trim().min(3).max(2000),
          })
          .strict(),
      },
    },
    async (request, reply) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "members:manage",
        dependencies,
      );
      const invitation = await dependencies.repository.createInvitation(tenant, request.body);
      const acceptUrl = new URL("/invitations/accept", dependencies.webOrigin);
      acceptUrl.hash = `token=${invitation.acceptToken}`;
      let delivery:
        | InvitationEmailDeliveryReceipt
        | {
            readonly status: "failed";
            readonly provider: "disabled" | "http_webhook";
            readonly errorCode: string;
          };
      try {
        delivery = await invitationEmail.deliver({
          invitationId: invitation.id,
          recipientEmail: invitation.email,
          role: invitation.role,
          expiresAt: invitation.expiresAt,
          acceptUrl: acceptUrl.toString(),
          correlationId: request.id,
        });
      } catch (error) {
        const errorCode =
          error instanceof InvitationEmailDeliveryError ? error.code : "PROVIDER_UNAVAILABLE";
        delivery = {
          status: "failed",
          provider: invitationEmail.name,
          errorCode,
        };
        logger.warn(
          {
            errorCode,
            correlationId: request.id,
            invitationId: invitation.id,
            provider: invitationEmail.name,
          },
          "invitation email delivery failed",
        );
      }
      let deliveryAuditRecorded = true;
      try {
        await dependencies.repository.recordInvitationDelivery(tenant, invitation.id, {
          status: delivery.status,
          provider: delivery.provider,
          correlationId: request.id,
          ...("providerMessageId" in delivery && delivery.providerMessageId
            ? { providerMessageId: delivery.providerMessageId }
            : {}),
          ...("errorCode" in delivery ? { errorCode: delivery.errorCode } : {}),
        });
      } catch (error) {
        deliveryAuditRecorded = false;
        logger.error(
          {
            err: safeError(error),
            correlationId: request.id,
            invitationId: invitation.id,
          },
          "invitation delivery audit could not be recorded",
        );
      }
      return reply.code(201).send({
        data: invitation,
        meta: {
          correlationId: request.id,
          delivery: {
            status: delivery.status,
            auditRecorded: deliveryAuditRecorded,
          },
        },
      });
    },
  );

  app.post(
    "/v1/organizations/:organizationId/invitations/:invitationId/revoke",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        params: invitationParams,
        body: z
          .object({
            reason: z.string().trim().min(3).max(2000),
          })
          .strict(),
      },
    },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "members:manage",
        dependencies,
      );
      const invitation = await dependencies.repository.revokeInvitation(
        tenant,
        request.params.invitationId,
        request.body,
      );
      return { data: invitation, meta: { correlationId: request.id } };
    },
  );

  app.get(
    "/v1/organizations/:organizationId/connections",
    { schema: { params: organizationParams } },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "financial-records:view",
        dependencies,
      );
      const connections = await dependencies.repository.listConnections(tenant);
      return { data: connections, meta: { correlationId: request.id } };
    },
  );

  app.post(
    "/v1/organizations/:organizationId/provider-authorizations",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        params: organizationParams,
        body: providerAuthorizationStartSchema,
      },
    },
    async (request, reply) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "connectors:manage",
        dependencies,
      );
      if (!dependencies.providerAuthorizations) {
        throw new ProviderAuthorizationDisabledError();
      }
      const started = await dependencies.providerAuthorizations.start(tenant, {
        provider: request.body.provider,
        ...(request.body.connectionId ? { connectionId: request.body.connectionId } : {}),
        ...(request.body.requestedAccountId
          ? { requestedAccountId: request.body.requestedAccountId }
          : {}),
        correlationId: request.id,
      });
      return reply.code(201).send({
        data: started,
        meta: { correlationId: request.id },
      });
    },
  );

  app.post(
    "/v1/organizations/:organizationId/provider-authorizations/:attemptId/callback",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        params: providerAuthorizationParams,
        body: providerAuthorizationCallbackSchema,
      },
    },
    async (request, reply) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "connectors:manage",
        dependencies,
      );
      if (!dependencies.providerAuthorizations) {
        throw new ProviderAuthorizationDisabledError();
      }
      const result = await dependencies.providerAuthorizations.callback(tenant, {
        attemptId: request.params.attemptId,
        provider: request.body.provider,
        query: request.body.query,
        correlationId: request.id,
      });
      return reply.code(result.replayed || result.status === "denied" ? 200 : 201).send({
        data: result,
        meta: { correlationId: request.id },
      });
    },
  );

  app.get(
    "/v1/organizations/:organizationId/connections/:connectionId/credentials",
    { schema: { params: connectionParams } },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "connectors:manage",
        dependencies,
      );
      if (!dependencies.connectorCredentials) {
        throw new Error("connector credential lifecycle is unavailable");
      }
      const credentials = await dependencies.connectorCredentials.list(
        tenant,
        request.params.connectionId,
      );
      return { data: credentials, meta: { correlationId: request.id, maximumItems: 100 } };
    },
  );

  app.post(
    "/v1/organizations/:organizationId/connections/:connectionId/credentials/rotations",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        params: connectionParams,
        body: connectorCredentialRotationSchema,
      },
    },
    async (request, reply) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "connectors:manage",
        dependencies,
      );
      if (!dependencies.connectorCredentials) {
        throw new Error("connector credential lifecycle is unavailable");
      }
      const result = await dependencies.connectorCredentials.rotate(tenant, {
        connectionId: request.params.connectionId,
        confirmConnectionId: request.body.confirmConnectionId,
        purpose: request.body.purpose,
        envelope: request.body.envelope,
        reason: request.body.reason,
        correlationId: request.id,
      });
      return reply.code(result.replayed ? 200 : 201).send({
        data: result.credential,
        meta: { correlationId: request.id, replayed: result.replayed },
      });
    },
  );

  app.post(
    "/v1/organizations/:organizationId/connections/:connectionId/disconnect",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        params: connectionParams,
        body: connectorDisconnectSchema,
      },
    },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "connectors:manage",
        dependencies,
      );
      if (!dependencies.providerDisconnects) {
        throw new ProviderDisconnectDisabledError();
      }
      const result = await dependencies.providerDisconnects.disconnect(tenant, {
        connectionId: request.params.connectionId,
        confirmConnectionId: request.body.confirmConnectionId,
        reason: request.body.reason,
        correlationId: request.id,
      });
      return { data: result, meta: { correlationId: request.id } };
    },
  );

  app.get(
    "/v1/organizations/:organizationId/audit-events",
    {
      schema: {
        params: organizationParams,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
      },
    },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "audit:view",
        dependencies,
      );
      const events = await dependencies.repository.listAuditEvents(tenant, {
        limit: request.query.limit,
      });
      return { data: events, meta: { correlationId: request.id } };
    },
  );

  app.get(
    "/v1/organizations/:organizationId/support-access-grants",
    {
      schema: {
        params: organizationParams,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
    },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "support:manage",
        dependencies,
      );
      if (!dependencies.supportAccess) throw new AuthorizationError();
      const grants = await dependencies.supportAccess.list(tenant, request.query.limit);
      return { data: grants, meta: { correlationId: request.id } };
    },
  );

  app.post(
    "/v1/organizations/:organizationId/support-access-grants",
    {
      schema: {
        params: organizationParams,
        body: z
          .object({
            requestCode: SupportAccessRequestCodeSchema,
            confirmOrganizationId: z.uuid(),
            ticketReference: supportTicketReferenceSchema,
            reason: supportGrantReasonSchema,
          })
          .strict(),
      },
    },
    async (request, reply) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "support:manage",
        dependencies,
      );
      if (
        !dependencies.supportAccess ||
        request.body.confirmOrganizationId !== request.params.organizationId
      ) {
        throw new AuthorizationError();
      }
      const grant = await dependencies.supportAccess.approve(tenant, {
        requestCode: request.body.requestCode,
        ticketReference: request.body.ticketReference,
        reason: request.body.reason,
        correlationId: request.id,
      });
      return reply.code(201).send({
        data: grant,
        meta: { correlationId: request.id },
      });
    },
  );

  app.post(
    "/v1/organizations/:organizationId/support-access-grants/:grantId/revoke",
    {
      schema: {
        params: supportGrantParams,
        body: z
          .object({
            confirmOrganizationId: z.uuid(),
            reason: supportGrantReasonSchema,
          })
          .strict(),
      },
    },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "support:manage",
        dependencies,
      );
      if (
        !dependencies.supportAccess ||
        request.body.confirmOrganizationId !== request.params.organizationId
      ) {
        throw new AuthorizationError();
      }
      const revocation = await dependencies.supportAccess.revoke(tenant, {
        grantId: request.params.grantId,
        reason: request.body.reason,
        correlationId: request.id,
      });
      return { data: revocation, meta: { correlationId: request.id } };
    },
  );

  app.get(
    "/v1/organizations/:organizationId/review-policy",
    { schema: { params: organizationParams } },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "organization:manage",
        dependencies,
      );
      const policy = await dependencies.repository.getReviewPolicy(tenant);
      return { data: policy, meta: { correlationId: request.id } };
    },
  );

  app.patch(
    "/v1/organizations/:organizationId/review-policy",
    {
      schema: {
        params: organizationParams,
        body: z.object({
          ...reviewPolicyFields,
          reason: z.string().trim().min(3).max(2000),
        }),
      },
    },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "organization:manage",
        dependencies,
      );
      const policy = await dependencies.repository.updateReviewPolicy(tenant, request.body);
      return { data: policy, meta: { correlationId: request.id } };
    },
  );

  app.get(
    "/v1/organizations/:organizationId/retention-policy",
    { schema: { params: organizationParams } },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "retention:manage",
        dependencies,
      );
      const policy = await dependencies.repository.getRetentionPolicy(tenant);
      return { data: policy, meta: { correlationId: request.id } };
    },
  );

  app.get(
    "/v1/organizations/:organizationId/provider-privacy-requests",
    {
      schema: {
        params: organizationParams,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z
            .string()
            .regex(/^[A-Za-z0-9_-]{1,1024}$/u)
            .optional(),
        }),
      },
    },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "retention:manage",
        dependencies,
      );
      if (!dependencies.providerPrivacyOperations) {
        throw new Error("provider privacy operations repository is not configured");
      }
      const page = await dependencies.providerPrivacyOperations.list(tenant, {
        limit: request.query.limit,
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      });
      return {
        data: page.items.map((item) => ({
          id: item.id,
          connectionId: item.connectionId,
          provider: item.provider,
          topic: item.topic,
          apiVersion: item.apiVersion,
          externalAccountId: item.externalAccountId,
          status: item.status,
          objectIdentifierCount: item.objectIdentifierCount,
          receivedAt: item.receivedAt,
          dueAt: item.dueAt,
          ...(item.deadlineAlert
            ? {
                deadlineAlert: {
                  stage: item.deadlineAlert.stage,
                  observedAt: item.deadlineAlert.observedAt,
                },
              }
            : {}),
          deletionProgress: {
            total: item.deletionProgress.total,
            pending: item.deletionProgress.pending,
            processing: item.deletionProgress.processing,
            retry: item.deletionProgress.retry,
            deleted: item.deletionProgress.deleted,
            alreadyMissing: item.deletionProgress.alreadyMissing,
            deadLettered: item.deletionProgress.deadLettered,
          },
        })),
        meta: {
          correlationId: request.id,
          truncated: page.truncated,
          maximumItems: 100,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
      };
    },
  );

  app.post(
    "/v1/organizations/:organizationId/provider-privacy-requests/:requestId/data-package",
    {
      schema: {
        params: providerPrivacyRequestParams,
        body: z
          .object({
            confirmed: z.literal(true),
            reason: z.string().trim().min(3).max(2000),
          })
          .strict(),
      },
    },
    async (request, reply) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "retention:manage",
        dependencies,
      );
      requirePermission(tenant, "data:export");
      if (!dependencies.providerPrivacyDataPackages) {
        throw new Error("provider privacy data package service is not configured");
      }
      const prepared = await dependencies.providerPrivacyDataPackages.prepare(tenant, {
        requestId: request.params.requestId,
        reason: request.body.reason,
        correlationId: request.id,
      });
      return reply
        .header("Content-Type", prepared.contentType)
        .header("Content-Disposition", `attachment; filename="${prepared.filename}"`)
        .header("Content-Length", prepared.body.byteLength)
        .header("Cache-Control", "private, no-store, max-age=0")
        .header("Pragma", "no-cache")
        .header("Content-Security-Policy", "sandbox")
        .header("X-Content-Type-Options", "nosniff")
        .header("X-ReconAI-Privacy-Package-Id", prepared.id)
        .header("X-ReconAI-Privacy-Package-Receipt-Token", prepared.receiptToken)
        .header("X-ReconAI-Privacy-Package-Receipt-Expires-At", prepared.receiptExpiresAt)
        .send(Buffer.from(prepared.body));
    },
  );

  app.post(
    "/v1/organizations/:organizationId/provider-privacy-requests/:requestId/data-package/:packageId/receipt",
    {
      schema: {
        params: providerPrivacyPackageReceiptParams,
        body: z
          .object({
            receiptToken: z
              .string()
              .length(43)
              .regex(/^[A-Za-z0-9_-]{43}$/u),
          })
          .strict(),
      },
    },
    async (request, reply) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "retention:manage",
        dependencies,
      );
      requirePermission(tenant, "data:export");
      if (!dependencies.providerPrivacyDataPackages) {
        throw new Error("provider privacy data package service is not configured");
      }
      const receipt = await dependencies.providerPrivacyDataPackages.acknowledgeReceipt(tenant, {
        requestId: request.params.requestId,
        packageId: request.params.packageId,
        receiptToken: request.body.receiptToken,
        correlationId: request.id,
      });
      return reply
        .code(receipt.status === "acknowledged" ? 201 : 200)
        .header("Cache-Control", "private, no-store, max-age=0")
        .send({
          data: {
            packageId: receipt.packageId,
            status: receipt.status,
            preparedAt: receipt.preparedAt,
            receiptExpiresAt: receipt.receiptExpiresAt,
            receivedAt: receipt.receivedAt,
          },
          meta: { correlationId: request.id },
        });
    },
  );

  app.patch(
    "/v1/organizations/:organizationId/retention-policy",
    {
      schema: {
        params: organizationParams,
        body: retentionPolicyUpdateSchema,
      },
    },
    async (request) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "retention:manage",
        dependencies,
      );
      if (request.body.confirmOrganizationId !== request.params.organizationId) {
        throw new RepositoryConflictError(
          "organization confirmation does not match the retention policy target",
        );
      }
      const policy = await dependencies.repository.updateRetentionPolicy(tenant, {
        rawImportRetentionDays: request.body.rawImportRetentionDays,
        providerEventRetentionDays: request.body.providerEventRetentionDays,
        legalHoldEnabled: request.body.legalHoldEnabled,
        legalHoldReason: request.body.legalHoldReason,
        reason: request.body.reason,
      });
      return { data: policy, meta: { correlationId: request.id } };
    },
  );

  app.post(
    "/v1/organizations/:organizationId/exceptions/:exceptionId/proposals",
    {
      schema: {
        params: exceptionParams,
        body: z.object({
          type: z.string().regex(/^[a-z0-9_]{1,100}$/u),
          reason: z.string().trim().min(3).max(2000),
        }),
      },
    },
    async (request, reply) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "exceptions:review",
        dependencies,
      );
      const result = await dependencies.repository.createProposal(
        tenant,
        request.params.exceptionId,
        request.body,
      );
      return reply.code(201).send({ data: result, meta: { correlationId: request.id } });
    },
  );

  app.post(
    "/v1/organizations/:organizationId/proposals/:proposalId/approvals",
    {
      schema: {
        params: proposalParams,
        body: z.object({
          decision: z.enum(["approve", "reject"]),
          reason: z.string().trim().min(3).max(2000),
        }),
      },
    },
    async (request, reply) => {
      const tenant = await authorizeRequest(
        request,
        request.params.organizationId,
        "resolutions:approve",
        dependencies,
      );
      const result = await dependencies.repository.approveProposal(
        tenant,
        request.params.proposalId,
        request.body,
      );
      recordProposalReviewDecision({
        decision: result.decision,
        status: result.status,
        proposalCreatedAt: result.proposalCreatedAt,
        decidedAt: result.decidedAt,
      });
      recordExceptionFinalResolution({
        status: result.status,
        exceptionCreatedAt: result.exceptionCreatedAt,
        resolvedAt: result.exceptionStatusChangedAt,
      });
      return reply.code(201).send({
        data: {
          id: result.id,
          decision: result.decision,
          status: result.status,
          approvalCount: result.approvalCount,
          requiredApprovals: result.requiredApprovals,
        },
        meta: { correlationId: request.id },
      });
    },
  );

  return app;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function readCsvMultipart(request: FastifyRequest): Promise<CsvUpload> {
  let file:
    | {
        readonly filename: string;
        readonly contentType: string;
        readonly body: Uint8Array;
      }
    | undefined;
  let metadataValue: unknown;
  try {
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "file" || file) {
          part.file.resume();
          throw new CsvImportValidationError("multipart upload must contain one file field");
        }
        file = {
          filename: part.filename,
          contentType: part.mimetype,
          body: await part.toBuffer(),
        };
      } else {
        if (part.fieldname !== "metadata" || metadataValue !== undefined) {
          throw new CsvImportValidationError("multipart upload contains an unknown field");
        }
        if (typeof part.value !== "string") {
          throw new CsvImportValidationError("CSV import metadata must be a JSON string");
        }
        try {
          metadataValue = JSON.parse(part.value) as unknown;
        } catch {
          throw new CsvImportValidationError("CSV import metadata is not valid JSON");
        }
      }
    }
  } catch (error) {
    if (error instanceof CsvImportValidationError) throw error;
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "FST_REQ_FILE_TOO_LARGE"
    ) {
      throw new CsvImportValidationError("CSV exceeds the configured byte limit");
    }
    throw error;
  }
  if (!file || metadataValue === undefined) {
    throw new CsvImportValidationError("multipart upload requires file and metadata fields");
  }
  const parsedMetadata = CsvImportMetadataSchema.safeParse(metadataValue);
  if (!parsedMetadata.success) {
    throw new CsvImportValidationError("CSV import metadata failed validation");
  }
  return { ...file, metadata: parsedMetadata.data };
}

function importResponse(receipt: CsvImportReceipt | undefined) {
  if (!receipt) throw new CsvImportNotFoundError();
  return {
    id: receipt.id,
    connectionId: receipt.connectionId,
    status: receipt.status,
    checksumSha256: receipt.payloadSha256,
    byteCount: receipt.byteCount,
    filename: receipt.originalFilename,
    templateVersion: receipt.templateVersion,
    mappingVersion: receipt.mappingVersion,
    rowCount: receipt.rowCount,
    validRowCount: receipt.validRowCount,
    invalidRowCount: receipt.invalidRowCount,
    previewRows: receipt.previewRows,
    previewErrors: receipt.previewErrors,
    errorsTruncated: receipt.errorsTruncated,
    uploadedAt: receipt.uploadedAt,
    ...(receipt.committedAt ? { committedAt: receipt.committedAt } : {}),
    ...(receipt.completedAt ? { completedAt: receipt.completedAt } : {}),
    ...(receipt.rolledBackAt ? { rolledBackAt: receipt.rolledBackAt } : {}),
    ...(receipt.supersededRecordCount !== undefined
      ? { supersededRecordCount: receipt.supersededRecordCount }
      : {}),
    ...(receipt.lastErrorCode ? { lastErrorCode: receipt.lastErrorCode } : {}),
  };
}

function importListResponse(receipt: CsvImportReceipt) {
  return {
    id: receipt.id,
    connectionId: receipt.connectionId,
    status: receipt.status,
    filename: receipt.originalFilename,
    templateVersion: receipt.templateVersion,
    mappingVersion: receipt.mappingVersion,
    rowCount: receipt.rowCount,
    validRowCount: receipt.validRowCount,
    invalidRowCount: receipt.invalidRowCount,
    uploadedAt: receipt.uploadedAt,
    ...(receipt.committedAt ? { committedAt: receipt.committedAt } : {}),
    ...(receipt.completedAt ? { completedAt: receipt.completedAt } : {}),
    ...(receipt.rolledBackAt ? { rolledBackAt: receipt.rolledBackAt } : {}),
    ...(receipt.supersededRecordCount !== undefined
      ? { supersededRecordCount: receipt.supersededRecordCount }
      : {}),
    ...(receipt.lastErrorCode ? { lastErrorCode: receipt.lastErrorCode } : {}),
  };
}

function parseWebhookBody(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new ProviderWebhookValidationError("provider webhook body must be raw bytes");
  }
  return value;
}

async function authorizeRequest(
  request: FastifyRequest,
  organizationIdValue: string,
  permission: Permission,
  dependencies: ApiDependencies,
): Promise<TenantContext> {
  const organizationId = OrganizationIdSchema.parse(organizationIdValue);
  const authorized = request.reconAuthorization?.tenant;
  if (authorized) {
    authorizeTenantAction(authorized, organizationId, permission);
    return authorized;
  }
  const identity = await dependencies.identityVerifier.verifyAuthorizationHeader(
    request.headers.authorization,
  );
  const tenant = await dependencies.memberships.resolve(identity, organizationId);
  if (!tenant) throw new AuthorizationError();
  authorizeTenantAction(tenant, organizationId, permission);
  return tenant;
}

function authorizeSupportRequest(
  request: FastifyRequest,
  dependencies: ApiDependencies,
): SupportIdentityDigest {
  const identity = request.reconAuthorization?.identity;
  const authorizedDigest = request.reconAuthorization?.supportIdentityDigest;
  if (!identity || !authorizedDigest || !dependencies.supportIdentityAuthorizer) {
    throw new AuthorizationError();
  }
  const checkedDigest = dependencies.supportIdentityAuthorizer.authorize(identity);
  if (checkedDigest !== authorizedDigest) throw new AuthorizationError();
  return checkedDigest;
}

async function verifiedIdentity(
  request: FastifyRequest,
  dependencies: ApiDependencies,
): Promise<VerifiedIdentity> {
  const identity = request.reconAuthorization?.identity;
  return (
    identity ??
    dependencies.identityVerifier.verifyAuthorizationHeader(request.headers.authorization)
  );
}

function requestOrganizationId(request: FastifyRequest): TenantContext["organizationId"] {
  const params = request.params;
  if (
    typeof params !== "object" ||
    params === null ||
    !("organizationId" in params) ||
    typeof params.organizationId !== "string"
  ) {
    throw new Error("tenant route is missing its organization parameter");
  }
  return OrganizationIdSchema.parse(params.organizationId);
}
