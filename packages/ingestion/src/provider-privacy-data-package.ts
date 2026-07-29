import { createHash, randomBytes, randomUUID } from "node:crypto";

import { requirePermission, type TenantContext } from "@workspace/domain";
import {
  ObjectIntegrityError,
  ObjectNotFoundError,
  type ImmutableObjectStore,
} from "@workspace/object-storage";
import { z } from "zod";

export const PROVIDER_PRIVACY_DATA_PACKAGE_MAXIMUM_RECORDS = 100;
export const PROVIDER_PRIVACY_DATA_PACKAGE_MAXIMUM_OBJECT_BYTES = 1024 * 1024;
export const PROVIDER_PRIVACY_DATA_PACKAGE_MAXIMUM_BYTES = 5 * 1024 * 1024;
export const PROVIDER_PRIVACY_DATA_PACKAGE_FILENAME = "reconai-shopify-customer-data-evidence.json";
export const PROVIDER_PRIVACY_DATA_PACKAGE_RECEIPT_TTL_MS = 10 * 60 * 1000;

const sourceSchema = z.enum(["shopify", "stripe"]);
const timestampSchema = z.iso.datetime({ offset: true });
const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const receiptTokenSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/u);
const dataPackageRequestSchema = z
  .object({
    requestId: z.uuid(),
    reason: z.string().trim().min(3).max(2000),
    correlationId: z.uuid(),
  })
  .strict();
const dataPackageReceiptRequestSchema = z
  .object({
    requestId: z.uuid(),
    packageId: z.uuid(),
    receiptToken: receiptTokenSchema,
    correlationId: z.uuid(),
  })
  .strict();

export interface ProviderPrivacyDataPackageSourceRecord {
  readonly sourceEventId: string;
  readonly source: z.infer<typeof sourceSchema>;
  readonly eventType: string;
  readonly externalEventId: string;
  readonly externalObjectId: string;
  readonly sourceTimestamp: string;
  readonly receivedAt: string;
  readonly connectorVersion: string;
  readonly apiVersion?: string;
  readonly objectKey: string;
  readonly payloadSha256: string;
  readonly canonicalRecords: readonly unknown[];
}

export interface ProviderPrivacyDataPackageAuthority {
  readonly requestId: string;
  readonly shopDomain: string;
  readonly customerId: string;
  readonly externalRequestId: string;
  readonly orderIds: readonly string[];
  readonly receivedAt: string;
  readonly dueAt: string;
  readonly apiVersion: string;
  readonly sourceRecords: readonly ProviderPrivacyDataPackageSourceRecord[];
  readonly truncated: boolean;
}

export interface ProviderPrivacyDataPackageRepository {
  loadAuthority(
    tenant: TenantContext,
    requestId: string,
    maximumRecords: number,
  ): Promise<ProviderPrivacyDataPackageAuthority | undefined>;
  recordPreparation(
    tenant: TenantContext,
    input: {
      readonly requestId: string;
      readonly packageId: string;
      readonly reason: string;
      readonly correlationId: string;
      readonly preparedAt: string;
      readonly sourceRecordCount: number;
      readonly canonicalRecordCount: number;
      readonly byteCount: number;
      readonly sourceCounts: Readonly<Record<z.infer<typeof sourceSchema>, number>>;
      readonly contentSha256: string;
      readonly receiptTokenSha256: string;
      readonly receiptExpiresAt: string;
    },
  ): Promise<boolean>;
  acknowledgeReceipt(
    tenant: TenantContext,
    input: {
      readonly requestId: string;
      readonly packageId: string;
      readonly receiptId: string;
      readonly receiptTokenSha256: string;
      readonly correlationId: string;
      readonly receivedAt: string;
    },
  ): Promise<ProviderPrivacyDataPackageReceipt | undefined>;
}

export interface PreparedProviderPrivacyDataPackage {
  readonly id: string;
  readonly filename: typeof PROVIDER_PRIVACY_DATA_PACKAGE_FILENAME;
  readonly contentType: "application/json; charset=utf-8";
  readonly body: Uint8Array;
  readonly receiptToken: string;
  readonly receiptExpiresAt: string;
}

interface ProviderPrivacyDataPackageReceiptBase {
  readonly packageId: string;
  readonly contentSha256: string;
  readonly byteCount: number;
  readonly preparedAt: string;
  readonly receiptExpiresAt: string;
}

export type ProviderPrivacyDataPackageReceipt =
  | (ProviderPrivacyDataPackageReceiptBase & {
      readonly status: "acknowledged" | "already_acknowledged";
      readonly receivedAt: string;
    })
  | (ProviderPrivacyDataPackageReceiptBase & {
      readonly status: "expired";
    });

export class ProviderPrivacyDataPackageNotFoundError extends Error {
  public constructor() {
    super("provider privacy data request was not found");
    this.name = "ProviderPrivacyDataPackageNotFoundError";
  }
}

export class ProviderPrivacyDataPackageLimitError extends Error {
  public constructor(
    message = "provider privacy data package exceeds the bounded export contract",
  ) {
    super(message);
    this.name = "ProviderPrivacyDataPackageLimitError";
  }
}

export class ProviderPrivacyDataPackageEvidenceError extends Error {
  public constructor() {
    super("provider privacy evidence could not be verified");
    this.name = "ProviderPrivacyDataPackageEvidenceError";
  }
}

export class ProviderPrivacyDataPackageReceiptExpiredError extends Error {
  public constructor() {
    super("provider privacy data package browser-receipt authority expired");
    this.name = "ProviderPrivacyDataPackageReceiptExpiredError";
  }
}

export interface ProviderPrivacyDataPackageServiceOptions {
  readonly repository: ProviderPrivacyDataPackageRepository;
  readonly objectStore: ImmutableObjectStore;
  readonly now?: () => Date;
}

/**
 * Prepares a bounded snapshot of the raw and normalized evidence ReconAI can link to a Shopify
 * customer data request. The result is an operator aid, not proof of legal-request fulfillment.
 */
export class ProviderPrivacyDataPackageService {
  readonly #now: () => Date;

  public constructor(private readonly options: ProviderPrivacyDataPackageServiceOptions) {
    this.#now = options.now ?? (() => new Date());
  }

  public async prepare(
    tenant: TenantContext,
    inputValue: {
      readonly requestId: string;
      readonly reason: string;
      readonly correlationId: string;
    },
  ): Promise<PreparedProviderPrivacyDataPackage> {
    requirePermission(tenant, "retention:manage");
    requirePermission(tenant, "data:export");
    const input = dataPackageRequestSchema.parse(inputValue);
    const authority = await this.options.repository.loadAuthority(
      tenant,
      input.requestId,
      PROVIDER_PRIVACY_DATA_PACKAGE_MAXIMUM_RECORDS,
    );
    if (!authority) throw new ProviderPrivacyDataPackageNotFoundError();
    validateAuthority(authority);
    if (
      authority.truncated ||
      authority.sourceRecords.length > PROVIDER_PRIVACY_DATA_PACKAGE_MAXIMUM_RECORDS
    ) {
      throw new ProviderPrivacyDataPackageLimitError(
        `provider privacy data package exceeds ${String(PROVIDER_PRIVACY_DATA_PACKAGE_MAXIMUM_RECORDS)} source records`,
      );
    }

    const preparedAt = this.#now().toISOString();
    const records: unknown[] = [];
    let cumulativeRawBytes = 0;
    const sourceCounts: Record<z.infer<typeof sourceSchema>, number> = {
      shopify: 0,
      stripe: 0,
    };
    let canonicalRecordCount = 0;

    for (const [index, record] of authority.sourceRecords.entries()) {
      let body: Uint8Array;
      try {
        body = await this.options.objectStore.getVerified({
          key: record.objectKey,
          expectedChecksumSha256: record.payloadSha256,
          maximumBytes: PROVIDER_PRIVACY_DATA_PACKAGE_MAXIMUM_OBJECT_BYTES,
        });
      } catch (error) {
        if (error instanceof ObjectIntegrityError || error instanceof ObjectNotFoundError) {
          throw new ProviderPrivacyDataPackageEvidenceError();
        }
        throw error;
      }
      cumulativeRawBytes += body.byteLength;
      if (cumulativeRawBytes > PROVIDER_PRIVACY_DATA_PACKAGE_MAXIMUM_BYTES) {
        throw new ProviderPrivacyDataPackageLimitError();
      }
      let rawPayload: unknown;
      try {
        rawPayload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
      } catch {
        throw new ProviderPrivacyDataPackageEvidenceError();
      }
      if (typeof rawPayload !== "object" || rawPayload === null || Array.isArray(rawPayload)) {
        throw new ProviderPrivacyDataPackageEvidenceError();
      }
      sourceCounts[record.source] += 1;
      canonicalRecordCount += record.canonicalRecords.length;
      records.push({
        recordNumber: index + 1,
        source: record.source,
        eventType: record.eventType,
        externalEventId: record.externalEventId,
        externalObjectId: record.externalObjectId,
        sourceTimestamp: record.sourceTimestamp,
        receivedAt: record.receivedAt,
        connectorVersion: record.connectorVersion,
        ...(record.apiVersion ? { apiVersion: record.apiVersion } : {}),
        rawPayload,
        canonicalRecords: record.canonicalRecords,
      });
    }

    const packageId = randomUUID();
    const packageDocument = {
      schemaVersion: 1,
      packageId,
      preparedAt,
      purpose: "merchant_review_for_shopify_customers_data_request",
      scope: {
        description:
          "Raw provider payloads and normalized records held by ReconAI and linked to the Shopify order identifiers in this request.",
        completeWithinDeclaredScope: true,
        limitations: [
          "This package is not proof that the merchant has fulfilled the privacy request.",
          "The merchant must review this package and combine it with relevant data held outside ReconAI.",
          "Audit, operational, tombstone, backup, and merchant-controlled systems are outside this package.",
          "Preparing this package does not transmit it to Shopify, the merchant, or the customer.",
        ],
      },
      request: {
        provider: "shopify",
        topic: "customers/data_request",
        shopDomain: authority.shopDomain,
        customerId: authority.customerId,
        externalRequestId: authority.externalRequestId,
        orderIds: authority.orderIds,
        apiVersion: authority.apiVersion,
        receivedAt: authority.receivedAt,
        dueAt: authority.dueAt,
      },
      summary: {
        sourceRecordCount: records.length,
        canonicalRecordCount,
        sourceCounts,
      },
      records,
    };
    const body = Buffer.from(JSON.stringify(packageDocument, null, 2), "utf8");
    if (body.byteLength === 0 || body.byteLength > PROVIDER_PRIVACY_DATA_PACKAGE_MAXIMUM_BYTES) {
      throw new ProviderPrivacyDataPackageLimitError();
    }
    const receiptToken = randomBytes(32).toString("base64url");
    const receiptTokenSha256 = sha256(receiptToken);
    const contentSha256 = sha256(body);
    const receiptExpiresAt = new Date(
      Date.parse(preparedAt) + PROVIDER_PRIVACY_DATA_PACKAGE_RECEIPT_TTL_MS,
    ).toISOString();

    const recorded = await this.options.repository.recordPreparation(tenant, {
      requestId: authority.requestId,
      packageId,
      reason: input.reason,
      correlationId: input.correlationId,
      preparedAt,
      sourceRecordCount: records.length,
      canonicalRecordCount,
      byteCount: body.byteLength,
      sourceCounts,
      contentSha256,
      receiptTokenSha256,
      receiptExpiresAt,
    });
    if (!recorded) throw new ProviderPrivacyDataPackageNotFoundError();
    return {
      id: packageId,
      filename: PROVIDER_PRIVACY_DATA_PACKAGE_FILENAME,
      contentType: "application/json; charset=utf-8",
      body,
      receiptToken,
      receiptExpiresAt,
    };
  }

  public async acknowledgeReceipt(
    tenant: TenantContext,
    inputValue: {
      readonly requestId: string;
      readonly packageId: string;
      readonly receiptToken: string;
      readonly correlationId: string;
    },
  ): Promise<Exclude<ProviderPrivacyDataPackageReceipt, { readonly status: "expired" }>> {
    requirePermission(tenant, "retention:manage");
    requirePermission(tenant, "data:export");
    const input = dataPackageReceiptRequestSchema.parse(inputValue);
    const receivedAt = this.#now().toISOString();
    const receipt = await this.options.repository.acknowledgeReceipt(tenant, {
      requestId: input.requestId,
      packageId: input.packageId,
      receiptId: randomUUID(),
      receiptTokenSha256: sha256(input.receiptToken),
      correlationId: input.correlationId,
      receivedAt,
    });
    if (!receipt) throw new ProviderPrivacyDataPackageNotFoundError();
    if (receipt.status === "expired") {
      throw new ProviderPrivacyDataPackageReceiptExpiredError();
    }
    return receipt;
  }
}

function validateAuthority(
  authority: ProviderPrivacyDataPackageAuthority,
): asserts authority is ProviderPrivacyDataPackageAuthority {
  z.object({
    requestId: z.uuid(),
    shopDomain: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/u),
    customerId: z.string().regex(/^[0-9]{1,40}$/u),
    externalRequestId: z.string().regex(/^[0-9]{1,40}$/u),
    orderIds: z.array(z.string().regex(/^[0-9]{1,40}$/u)).max(10_000),
    receivedAt: timestampSchema,
    dueAt: timestampSchema,
    apiVersion: z.string().regex(/^\d{4}-(?:01|04|07|10)$/u),
    sourceRecords: z.array(
      z.object({
        sourceEventId: z.uuid(),
        source: sourceSchema,
        eventType: z.string().min(1).max(100),
        externalEventId: z.string().min(1).max(255),
        externalObjectId: z.string().min(1).max(255),
        sourceTimestamp: timestampSchema,
        receivedAt: timestampSchema,
        connectorVersion: z.string().min(1).max(100),
        apiVersion: z.string().min(1).max(50).optional(),
        objectKey: z.string().min(1).max(1024),
        payloadSha256: checksumSchema,
        canonicalRecords: z.array(z.unknown()),
      }),
    ),
    truncated: z.boolean(),
  })
    .strict()
    .parse(authority);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
