import {
  MembershipIdSchema,
  OrganizationIdSchema,
  UserIdSchema,
  tenantContextFromMembership,
} from "@workspace/domain";
import {
  InMemoryImmutableObjectStore,
  ObjectIntegrityError,
  type ImmutableObjectStore,
} from "@workspace/object-storage";
import { describe, expect, it } from "vitest";

import {
  CsvImportConflictError,
  CsvImportService,
  CsvImportTerminalError,
  CsvImportValidationError,
  type ConnectorJobPublisher,
  type CsvImportDraft,
  type CsvImportReceipt,
  type CsvImportRepository,
  type ProcessedCsvRow,
} from "./index.js";
import type { CsvImportJobEnvelope } from "@workspace/connectors";

const organizationId = OrganizationIdSchema.parse("00000000-0000-4000-8000-000000000001");
const tenant = tenantContextFromMembership({
  id: MembershipIdSchema.parse("00000000-0000-4000-8000-000000000002"),
  organizationId,
  userId: UserIdSchema.parse("00000000-0000-4000-8000-000000000003"),
  role: "administrator",
  status: "active",
});
const body = Buffer.from(
  [
    "id,reference,order,amount,currency,effective_at,type",
    "entry-1,refund-1,order-1,25.00,USD,2026-07-27T00:00:00.000Z,refund",
  ].join("\n"),
);
const metadata = {
  connectionId: "00000000-0000-4000-8000-000000000004",
  templateVersion: "accounting-v1",
  mappingVersion: "mapping-v1",
  mapping: {
    externalId: "id",
    transactionReference: "reference",
    orderReference: "order",
    amount: "amount",
    currency: "currency",
    effectiveAt: "effective_at",
    entryType: "type",
  },
} as const;
const traceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";

describe("CSV ingestion orchestration", () => {
  it("reuses upload/commit identities and processes canonical rows once", async () => {
    const repository = new MemoryRepository();
    const publisher = new MemoryPublisher();
    const service = new CsvImportService({
      environment: "test",
      repository,
      objectStore: new InMemoryImmutableObjectStore(),
      publisher,
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });

    const first = await service.createPreview(tenant, {
      filename: "ledger.csv",
      contentType: "text/csv",
      body,
      metadata,
    });
    const duplicate = await service.createPreview(tenant, {
      filename: "ledger.csv",
      contentType: "text/csv",
      body,
      metadata,
    });
    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.receipt.id).toBe(first.receipt.id);

    const committed = await service.commitImport(tenant, {
      importId: first.receipt.id,
      correlationId: "00000000-0000-4000-8000-000000000005",
      reason: "Import the approved accounting close file",
      traceparent,
    });
    expect(committed.status).toBe("queued");
    expect(publisher.envelopes).toHaveLength(1);
    const envelope = publisher.envelopes[0];
    if (!envelope) throw new Error("publisher did not receive the job");
    expect(envelope.traceContext).toEqual({ schemaVersion: 1, traceparent });
    await expect(service.processImport(envelope)).resolves.toBe("processed");
    await expect(service.processImport(envelope)).resolves.toBe("already_processed");
    expect(repository.completedRows).toHaveLength(1);
    expect(repository.completedRows[0]?.record.amount.minor).toBe(2500n);
  });

  it("does not queue a preview with financial validation errors", async () => {
    const repository = new MemoryRepository();
    const service = new CsvImportService({
      environment: "test",
      repository,
      objectStore: new InMemoryImmutableObjectStore(),
      publisher: new MemoryPublisher(),
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });
    const preview = await service.createPreview(tenant, {
      filename: "ledger.csv",
      contentType: "text/csv",
      body: Buffer.from(
        [
          "id,reference,order,amount,currency,effective_at,type",
          "entry-1,refund-1,order-1,not-money,USD,2026-07-27T00:00:00.000Z,refund",
        ].join("\n"),
      ),
      metadata,
    });
    expect(preview.receipt.status).toBe("validation_failed");
    await expect(
      service.commitImport(tenant, {
        importId: preview.receipt.id,
        correlationId: "00000000-0000-4000-8000-000000000005",
        reason: "Attempt an invalid import",
      }),
    ).rejects.toBeInstanceOf(CsvImportConflictError);
  });

  it("rejects active or ambiguously typed uploads before storage", async () => {
    const service = new CsvImportService({
      environment: "test",
      repository: new MemoryRepository(),
      objectStore: new InMemoryImmutableObjectStore(),
      publisher: new MemoryPublisher(),
    });
    await expect(
      service.createPreview(tenant, {
        filename: "../ledger.csv",
        contentType: "text/csv",
        body,
        metadata,
      }),
    ).rejects.toThrow("safe .csv");
    await expect(
      service.createPreview(tenant, {
        filename: "ledger.csv",
        contentType: "text/html",
        body,
        metadata,
      }),
    ).rejects.toThrow("content type");
  });

  it("records a terminal failure when the committed object cannot be verified", async () => {
    const repository = new MemoryRepository();
    const publisher = new MemoryPublisher();
    const service = new CsvImportService({
      environment: "test",
      repository,
      objectStore: new FailingReadStore(),
      publisher,
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });
    const preview = await service.createPreview(tenant, {
      filename: "ledger.csv",
      contentType: "text/csv",
      body,
      metadata,
    });
    await service.commitImport(tenant, {
      importId: preview.receipt.id,
      correlationId: "00000000-0000-4000-8000-000000000005",
      reason: "Import the approved accounting close file",
    });
    const envelope = publisher.envelopes[0];
    if (!envelope) throw new Error("publisher did not receive the job");
    await expect(service.processImport(envelope)).rejects.toBeInstanceOf(CsvImportTerminalError);
    await expect(repository.getImport(tenant, preview.receipt.id)).resolves.toMatchObject({
      status: "failed",
      lastErrorCode: "IMPORT_OBJECT_INVALID",
    });
  });

  it("requires exact confirmation and makes a completed rollback idempotent", async () => {
    const repository = new MemoryRepository();
    const publisher = new MemoryPublisher();
    const service = new CsvImportService({
      environment: "test",
      repository,
      objectStore: new InMemoryImmutableObjectStore(),
      publisher,
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });
    const preview = await service.createPreview(tenant, {
      filename: "ledger.csv",
      contentType: "text/csv",
      body,
      metadata,
    });
    await service.commitImport(tenant, {
      importId: preview.receipt.id,
      correlationId: "00000000-0000-4000-8000-000000000005",
      reason: "Import the approved accounting close file",
    });
    const envelope = publisher.envelopes[0];
    if (!envelope) throw new Error("publisher did not receive the job");
    await service.processImport(envelope);

    await expect(
      service.rollbackImport(tenant, {
        importId: preview.receipt.id,
        confirmImportId: "00000000-0000-4000-8000-000000000099",
        correlationId: "00000000-0000-4000-8000-000000000006",
        reason: "Remove the duplicated close file from future runs",
      }),
    ).rejects.toBeInstanceOf(CsvImportValidationError);

    const first = await service.rollbackImport(tenant, {
      importId: preview.receipt.id,
      confirmImportId: preview.receipt.id,
      correlationId: "00000000-0000-4000-8000-000000000006",
      reason: "Remove the duplicated close file from future runs",
    });
    const repeated = await service.rollbackImport(tenant, {
      importId: preview.receipt.id,
      confirmImportId: preview.receipt.id,
      correlationId: "00000000-0000-4000-8000-000000000007",
      reason: "Remove the duplicated close file from future runs",
    });
    expect(first).toMatchObject({ status: "rolled_back", supersededRecordCount: 1 });
    expect(repeated).toEqual(first);
    await expect(service.listImports(tenant)).resolves.toHaveLength(1);
  });
});

class MemoryPublisher implements ConnectorJobPublisher {
  public readonly envelopes: CsvImportJobEnvelope[] = [];

  public async publish(envelope: CsvImportJobEnvelope): Promise<void> {
    this.envelopes.push(envelope);
  }
}

class MemoryRepository implements CsvImportRepository {
  readonly #receipts = new Map<string, CsvImportReceipt>();
  public completedRows: readonly ProcessedCsvRow[] = [];

  public async assertAccountingConnection(): Promise<void> {
    await Promise.resolve();
  }

  public async savePreview(
    _tenant: Parameters<CsvImportRepository["savePreview"]>[0],
    draft: CsvImportDraft,
  ): Promise<{ readonly receipt: CsvImportReceipt; readonly inserted: boolean }> {
    const existing = this.#receipts.get(draft.id);
    if (existing) return { receipt: existing, inserted: false };
    this.#receipts.set(draft.id, draft);
    return { receipt: draft, inserted: true };
  }

  public async getImport(
    _tenant: Parameters<CsvImportRepository["getImport"]>[0],
    importId: string,
  ): Promise<CsvImportReceipt | undefined> {
    return this.#receipts.get(importId);
  }

  public async listImports(): Promise<readonly CsvImportReceipt[]> {
    return [...this.#receipts.values()];
  }

  public async queueImport(
    tenantValue: Parameters<CsvImportRepository["queueImport"]>[0],
    input: Parameters<CsvImportRepository["queueImport"]>[1],
  ): Promise<{ readonly receipt: CsvImportReceipt; readonly envelope: CsvImportJobEnvelope }> {
    const receipt = this.#receipts.get(input.importId);
    if (!receipt) throw new Error("not found");
    if (receipt.status === "validation_failed") {
      throw new CsvImportConflictError("CSV import has validation errors");
    }
    const queued: CsvImportReceipt = { ...receipt, status: "queued", committedAt: input.now };
    this.#receipts.set(receipt.id, queued);
    return {
      receipt: queued,
      envelope: {
        schemaVersion: 1,
        type: "csv.import.commit",
        organizationId: tenantValue.organizationId,
        connectionId: receipt.connectionId,
        importId: receipt.id,
        correlationId: input.correlationId,
        idempotencyKey: `csv-import:${receipt.id}:commit:v1`,
        requestedBy: tenantValue.actorId,
        createdAt: input.now,
        ...(input.traceContext ? { traceContext: input.traceContext } : {}),
      },
    };
  }

  public async markOutboxPublished(): Promise<void> {
    await Promise.resolve();
  }

  public async loadForProcessing(
    _organizationId: Parameters<CsvImportRepository["loadForProcessing"]>[0],
    importId: string,
  ): Promise<CsvImportReceipt | undefined> {
    return this.#receipts.get(importId);
  }

  public async completeImport(
    envelope: CsvImportJobEnvelope,
    rows: readonly ProcessedCsvRow[],
    completedAt: string,
  ): Promise<"processed" | "already_processed"> {
    const receipt = this.#receipts.get(envelope.importId);
    if (!receipt) throw new Error("not found");
    if (receipt.status === "succeeded") return "already_processed";
    this.completedRows = rows;
    this.#receipts.set(receipt.id, { ...receipt, status: "succeeded", completedAt });
    return "processed";
  }

  public async markImportFailed(envelope: CsvImportJobEnvelope, errorCode: string): Promise<void> {
    const receipt = this.#receipts.get(envelope.importId);
    if (receipt) {
      this.#receipts.set(receipt.id, {
        ...receipt,
        status: "failed",
        lastErrorCode: errorCode,
      });
    }
  }

  public async rollbackImport(
    _tenant: Parameters<CsvImportRepository["rollbackImport"]>[0],
    input: Parameters<CsvImportRepository["rollbackImport"]>[1],
  ): Promise<CsvImportReceipt> {
    const receipt = this.#receipts.get(input.importId);
    if (!receipt) throw new Error("not found");
    if (receipt.status === "rolled_back") return receipt;
    if (receipt.status !== "succeeded") {
      throw new CsvImportConflictError("only a succeeded CSV import can be rolled back");
    }
    const rolledBack: CsvImportReceipt = {
      ...receipt,
      status: "rolled_back",
      rolledBackAt: input.now,
      supersededRecordCount: this.completedRows.length,
    };
    this.#receipts.set(receipt.id, rolledBack);
    return rolledBack;
  }
}

class FailingReadStore implements ImmutableObjectStore {
  readonly #delegate = new InMemoryImmutableObjectStore();

  public async putImmutable(
    input: Parameters<ImmutableObjectStore["putImmutable"]>[0],
  ): ReturnType<ImmutableObjectStore["putImmutable"]> {
    return this.#delegate.putImmutable(input);
  }

  public async getVerified(): ReturnType<ImmutableObjectStore["getVerified"]> {
    throw new ObjectIntegrityError();
  }

  public deleteVerified(
    input: Parameters<ImmutableObjectStore["deleteVerified"]>[0],
  ): ReturnType<ImmutableObjectStore["deleteVerified"]> {
    return this.#delegate.deleteVerified(input);
  }
}
