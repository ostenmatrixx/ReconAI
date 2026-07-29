import { createHash } from "node:crypto";

import {
  MembershipIdSchema,
  OrganizationIdSchema,
  UserIdSchema,
  type TenantContext,
} from "@workspace/domain";
import { InMemoryImmutableObjectStore } from "@workspace/object-storage";
import { describe, expect, it } from "vitest";

import {
  ProviderPrivacyDataPackageEvidenceError,
  ProviderPrivacyDataPackageLimitError,
  ProviderPrivacyDataPackageNotFoundError,
  ProviderPrivacyDataPackageReceiptExpiredError,
  ProviderPrivacyDataPackageService,
  type ProviderPrivacyDataPackageAuthority,
  type ProviderPrivacyDataPackageReceipt,
  type ProviderPrivacyDataPackageRepository,
} from "./provider-privacy-data-package.js";

const tenant: TenantContext = {
  organizationId: OrganizationIdSchema.parse("a1000000-0000-4000-8000-000000000001"),
  membershipId: MembershipIdSchema.parse("a2000000-0000-4000-8000-000000000001"),
  actorId: UserIdSchema.parse("a3000000-0000-4000-8000-000000000001"),
  permissions: new Set(["retention:manage", "data:export"]),
};
const requestId = "a4000000-0000-4000-8000-000000000001";
const correlationId = "a5000000-0000-4000-8000-000000000001";

describe("provider privacy data package", () => {
  it("assembles verified raw and normalized evidence and audits only package metadata", async () => {
    const store = new InMemoryImmutableObjectStore();
    const raw = Buffer.from(
      JSON.stringify({
        id: 299938,
        email: "customer@example.test",
        total_price: "125.00",
      }),
    );
    await put(store, "test/tenant/provider-events/source-1/payload.json", raw);
    const repository = new MemoryDataPackageRepository(
      authority([
        sourceRecord("test/tenant/provider-events/source-1/payload.json", raw, {
          kind: "order",
          externalId: "299938",
          amount: { minor: "12500", currency: "USD" },
        }),
      ]),
    );
    const service = new ProviderPrivacyDataPackageService({
      repository,
      objectStore: store,
      now: () => new Date("2026-07-28T03:00:00.000Z"),
    });

    const prepared = await service.prepare(tenant, {
      requestId,
      reason: "Prepare evidence for controlled merchant review",
      correlationId,
    });
    const document = JSON.parse(Buffer.from(prepared.body).toString("utf8")) as Record<
      string,
      unknown
    >;

    expect(prepared.filename).toBe("reconai-shopify-customer-data-evidence.json");
    expect(prepared.receiptToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(prepared.receiptExpiresAt).toBe("2026-07-28T03:10:00.000Z");
    expect(document).toMatchObject({
      schemaVersion: 1,
      preparedAt: "2026-07-28T03:00:00.000Z",
      purpose: "merchant_review_for_shopify_customers_data_request",
      request: {
        topic: "customers/data_request",
        shopDomain: "reconai-test.myshopify.com",
        customerId: "191167",
        externalRequestId: "9999",
        orderIds: ["299938"],
      },
      summary: {
        sourceRecordCount: 1,
        canonicalRecordCount: 1,
        sourceCounts: { shopify: 1, stripe: 0 },
      },
      records: [
        {
          source: "shopify",
          externalObjectId: "299938",
          rawPayload: {
            id: 299938,
            email: "customer@example.test",
            total_price: "125.00",
          },
        },
      ],
    });
    expect(JSON.stringify(document)).not.toContain("payload.json");
    expect(JSON.stringify(document)).not.toContain(sha256(raw));
    expect(repository.preparations).toEqual([
      expect.objectContaining({
        requestId,
        correlationId,
        sourceRecordCount: 1,
        canonicalRecordCount: 1,
        sourceCounts: { shopify: 1, stripe: 0 },
        contentSha256: sha256(prepared.body),
        receiptTokenSha256: sha256(Buffer.from(prepared.receiptToken, "utf8")),
        receiptExpiresAt: "2026-07-28T03:10:00.000Z",
      }),
    ]);
    expect(JSON.stringify(repository.preparations)).not.toContain(prepared.receiptToken);
    expect(JSON.stringify(repository.preparations)).not.toContain("customer@example.test");
    expect(JSON.stringify(repository.preparations)).not.toContain("299938");
  });

  it("acknowledges browser receipt with only a token digest crossing the repository boundary", async () => {
    const repository = new MemoryDataPackageRepository(authority([]));
    const service = new ProviderPrivacyDataPackageService({
      repository,
      objectStore: new InMemoryImmutableObjectStore(),
      now: () => new Date("2026-07-28T03:05:00.000Z"),
    });
    const receiptToken = "a".repeat(43);
    repository.receiptResult = {
      status: "acknowledged",
      packageId: "a7000000-0000-4000-8000-000000000001",
      contentSha256: "b".repeat(64),
      byteCount: 100,
      preparedAt: "2026-07-28T03:00:00.000Z",
      receiptExpiresAt: "2026-07-28T03:10:00.000Z",
      receivedAt: "2026-07-28T03:05:00.000Z",
    };

    await expect(
      service.acknowledgeReceipt(tenant, {
        requestId,
        packageId: repository.receiptResult.packageId,
        receiptToken,
        correlationId,
      }),
    ).resolves.toMatchObject({
      status: "acknowledged",
      receivedAt: "2026-07-28T03:05:00.000Z",
    });
    expect(repository.receiptCalls).toEqual([
      expect.objectContaining({
        requestId,
        packageId: repository.receiptResult.packageId,
        receiptTokenSha256: sha256(Buffer.from(receiptToken, "utf8")),
        receivedAt: "2026-07-28T03:05:00.000Z",
      }),
    ]);
    expect(JSON.stringify(repository.receiptCalls)).not.toContain(receiptToken);
  });

  it("conceals unknown receipt authorities and distinguishes an expired first receipt", async () => {
    const repository = new MemoryDataPackageRepository(authority([]));
    const service = new ProviderPrivacyDataPackageService({
      repository,
      objectStore: new InMemoryImmutableObjectStore(),
      now: () => new Date("2026-07-28T03:11:00.000Z"),
    });
    const input = {
      requestId,
      packageId: "a7000000-0000-4000-8000-000000000001",
      receiptToken: "a".repeat(43),
      correlationId,
    };

    await expect(service.acknowledgeReceipt(tenant, input)).rejects.toBeInstanceOf(
      ProviderPrivacyDataPackageNotFoundError,
    );
    repository.receiptResult = {
      status: "expired",
      packageId: input.packageId,
      contentSha256: "b".repeat(64),
      byteCount: 100,
      preparedAt: "2026-07-28T03:00:00.000Z",
      receiptExpiresAt: "2026-07-28T03:10:00.000Z",
    };
    await expect(service.acknowledgeReceipt(tenant, input)).rejects.toBeInstanceOf(
      ProviderPrivacyDataPackageReceiptExpiredError,
    );
  });

  it("fails the whole package when evidence is absent or fails verification", async () => {
    const repository = new MemoryDataPackageRepository(
      authority([
        {
          ...sourceRecord(
            "test/tenant/provider-events/missing/payload.json",
            Buffer.from("{}"),
            {},
          ),
          payloadSha256: "f".repeat(64),
        },
      ]),
    );
    const service = new ProviderPrivacyDataPackageService({
      repository,
      objectStore: new InMemoryImmutableObjectStore(),
    });

    await expect(
      service.prepare(tenant, {
        requestId,
        reason: "Prepare controlled response",
        correlationId,
      }),
    ).rejects.toBeInstanceOf(ProviderPrivacyDataPackageEvidenceError);
    expect(repository.preparations).toHaveLength(0);
  });

  it("rejects a truncated repository result without reading or auditing a partial package", async () => {
    const repository = new MemoryDataPackageRepository({ ...authority([]), truncated: true });
    const service = new ProviderPrivacyDataPackageService({
      repository,
      objectStore: new InMemoryImmutableObjectStore(),
    });

    await expect(
      service.prepare(tenant, {
        requestId,
        reason: "Prepare controlled response",
        correlationId,
      }),
    ).rejects.toBeInstanceOf(ProviderPrivacyDataPackageLimitError);
    expect(repository.preparations).toHaveLength(0);
  });

  it("rejects a package over five MiB without emitting an audit event", async () => {
    const store = new InMemoryImmutableObjectStore();
    const records = [];
    for (let index = 0; index < 6; index += 1) {
      const body = Buffer.from(JSON.stringify({ index, evidence: "x".repeat(900 * 1024) }), "utf8");
      const key = `test/tenant/provider-events/large-${index.toString()}/payload.json`;
      await put(store, key, body);
      records.push(sourceRecord(key, body, {}));
    }
    const repository = new MemoryDataPackageRepository(authority(records));
    const service = new ProviderPrivacyDataPackageService({ repository, objectStore: store });

    await expect(
      service.prepare(tenant, {
        requestId,
        reason: "Prepare controlled response",
        correlationId,
      }),
    ).rejects.toBeInstanceOf(ProviderPrivacyDataPackageLimitError);
    expect(repository.preparations).toHaveLength(0);
  });

  it("requires both privacy-management and export permission at the service boundary", async () => {
    const repository = new MemoryDataPackageRepository(authority([]));
    const service = new ProviderPrivacyDataPackageService({
      repository,
      objectStore: new InMemoryImmutableObjectStore(),
    });

    await expect(
      service.prepare(
        { ...tenant, permissions: new Set(["retention:manage"]) },
        {
          requestId,
          reason: "Prepare controlled response",
          correlationId,
        },
      ),
    ).rejects.toMatchObject({ name: "AuthorizationError" });
    expect(repository.loadCount).toBe(0);
    await expect(
      service.acknowledgeReceipt(
        { ...tenant, permissions: new Set(["retention:manage"]) },
        {
          requestId,
          packageId: "a7000000-0000-4000-8000-000000000001",
          receiptToken: "a".repeat(43),
          correlationId,
        },
      ),
    ).rejects.toMatchObject({ name: "AuthorizationError" });
    expect(repository.receiptCalls).toHaveLength(0);
  });
});

class MemoryDataPackageRepository implements ProviderPrivacyDataPackageRepository {
  public readonly preparations: Parameters<
    ProviderPrivacyDataPackageRepository["recordPreparation"]
  >[1][] = [];
  public readonly receiptCalls: Parameters<
    ProviderPrivacyDataPackageRepository["acknowledgeReceipt"]
  >[1][] = [];
  public receiptResult: ProviderPrivacyDataPackageReceipt | undefined;
  public loadCount = 0;

  public constructor(private readonly value: ProviderPrivacyDataPackageAuthority | undefined) {}

  public async loadAuthority(): Promise<ProviderPrivacyDataPackageAuthority | undefined> {
    this.loadCount += 1;
    return this.value;
  }

  public async recordPreparation(
    _tenant: TenantContext,
    input: Parameters<ProviderPrivacyDataPackageRepository["recordPreparation"]>[1],
  ): Promise<boolean> {
    this.preparations.push(input);
    return true;
  }

  public async acknowledgeReceipt(
    _tenant: TenantContext,
    input: Parameters<ProviderPrivacyDataPackageRepository["acknowledgeReceipt"]>[1],
  ): Promise<ProviderPrivacyDataPackageReceipt | undefined> {
    this.receiptCalls.push(input);
    return this.receiptResult;
  }
}

function authority(
  sourceRecords: ProviderPrivacyDataPackageAuthority["sourceRecords"],
): ProviderPrivacyDataPackageAuthority {
  return {
    requestId,
    shopDomain: "reconai-test.myshopify.com",
    customerId: "191167",
    externalRequestId: "9999",
    orderIds: ["299938"],
    receivedAt: "2026-07-28T00:00:00.000Z",
    dueAt: "2026-08-27T00:00:00.000Z",
    apiVersion: "2026-07",
    sourceRecords,
    truncated: false,
  };
}

function sourceRecord(
  objectKey: string,
  body: Uint8Array,
  canonicalRecord: unknown,
): ProviderPrivacyDataPackageAuthority["sourceRecords"][number] {
  return {
    sourceEventId: "a6000000-0000-4000-8000-000000000001",
    source: "shopify",
    eventType: "orders/updated",
    externalEventId: "shopify-webhook-1",
    externalObjectId: "299938",
    sourceTimestamp: "2026-07-27T00:00:00.000Z",
    receivedAt: "2026-07-27T00:00:01.000Z",
    connectorVersion: "shopify-connector-v1",
    apiVersion: "2026-07",
    objectKey,
    payloadSha256: sha256(body),
    canonicalRecords: [canonicalRecord],
  };
}

async function put(
  store: InMemoryImmutableObjectStore,
  key: string,
  body: Uint8Array,
): Promise<void> {
  await store.putImmutable({
    key,
    body,
    contentType: "application/json",
    checksumSha256: sha256(body),
  });
}

function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}
