import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { EnvironmentConnectorSecretResolver } from "@workspace/connectors";
import {
  MembershipIdSchema,
  OrganizationIdSchema,
  UserIdSchema,
  tenantContextFromMembership,
} from "@workspace/domain";
import {
  ProviderWebhookService,
  ProviderPrivacyDataPackageNotFoundError,
  ProviderPrivacyDataPackageService,
  ShopifyPrivacyWebhookService,
  type ProviderWebhookJobEnvelope,
  type ProviderWebhookJobPublisher,
} from "@workspace/ingestion";
import { InMemoryImmutableObjectStore } from "@workspace/object-storage";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresShopifyPrivacyRequestRepository } from "./provider-privacy.js";
import { PostgresProviderPrivacyDeadlineAlertRepository } from "./provider-privacy-deadline-alerts.js";
import { PostgresProviderPrivacyDataPackageRepository } from "./provider-privacy-data-package.js";
import { PostgresProviderPrivacyObjectDeletionRepository } from "./provider-privacy-deletion.js";
import { PostgresProviderPrivacyOperationsRepository } from "./provider-privacy-operations.js";
import { PostgresProviderWebhookRepository } from "./provider-webhooks.js";

const organizationId = OrganizationIdSchema.parse(randomUUID());
const otherOrganizationId = OrganizationIdSchema.parse(randomUUID());
const connectionId = randomUUID();
const stripeConnectionId = randomUUID();
const operatorTenant = tenantContextFromMembership({
  id: MembershipIdSchema.parse(randomUUID()),
  organizationId,
  userId: UserIdSchema.parse(randomUUID()),
  role: "administrator",
  status: "active",
});
const otherOperatorTenant = tenantContextFromMembership({
  id: MembershipIdSchema.parse(randomUUID()),
  organizationId: otherOrganizationId,
  userId: UserIdSchema.parse(randomUUID()),
  role: "administrator",
  status: "active",
});
const secret = "synthetic-shopify-integration-secret";
const shopDomain = `reconai-${randomUUID().replaceAll("-", "")}.myshopify.com`;
const privacyWebhookId = `webhook-privacy-${randomUUID().replaceAll("-", "")}`;
const privacyDataRequestWebhookId = `webhook-privacy-data-${randomUUID().replaceAll("-", "")}`;
const traceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
let administrator: Sql | undefined;
let application: Sql | undefined;
let worker: Sql | undefined;

describe("live durable provider webhook ingestion", { concurrent: false }, () => {
  beforeAll(async () => {
    const adminUrl = requiredEnvironment("DATABASE_ADMIN_URL");
    const migrationUrl = requiredEnvironment("DATABASE_MIGRATION_URL");
    const applicationUrl = requiredEnvironment("DATABASE_URL");
    const workerUrl = requiredEnvironment("DATABASE_WORKER_URL");
    const admin = postgres(adminUrl, { max: 1 });
    administrator = admin;
    await ensureLocalTestRoles(admin);
    execFileSync("pnpm", ["--filter", "@workspace/database", "db:migrate"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl },
      stdio: "pipe",
    });
    await seedProviderTenant(admin);
    application = postgres(applicationUrl, { max: 1 });
    worker = postgres(workerUrl, { max: 1 });
  });

  afterAll(async () => {
    await worker?.end({ timeout: 5 });
    await application?.end({ timeout: 5 });
    await administrator?.end({ timeout: 5 });
  });

  it("persists each authenticated event once and keeps newer provider state authoritative", async () => {
    const database = requiredConnection(application);
    const publisher = new CapturingPublisher();
    const objectStore = new InMemoryImmutableObjectStore();
    let receivedAt = new Date("2026-07-27T12:00:00.000Z");
    const service = new ProviderWebhookService({
      environment: "integration",
      repository: new PostgresProviderWebhookRepository(database),
      objectStore,
      secrets: new EnvironmentConnectorSecretResolver({
        RECONAI_CONNECTOR_SHOPIFY_INTEGRATION: secret,
      }),
      publisher,
      now: () => receivedAt,
    });

    const newer = orderPayload("paid", "125.00", "2026-07-27T10:00:00.000Z");
    const newerInput = {
      ...shopifyInput(newer, "webhook-newer", randomUUID()),
      traceparent,
    };
    await expect(service.receiveShopify(newerInput)).resolves.toMatchObject({ duplicate: false });
    await expect(service.receiveShopify(newerInput)).resolves.toMatchObject({ duplicate: true });
    const newerEnvelope = publisher.envelopes[0];
    if (!newerEnvelope) throw new Error("newer provider job was not published");
    expect(newerEnvelope.traceContext).toEqual({ schemaVersion: 1, traceparent });
    await expect(service.processWebhook(newerEnvelope)).resolves.toBe("processed");
    await expect(service.processWebhook(newerEnvelope)).resolves.toBe("already_processed");

    receivedAt = new Date("2026-07-27T12:01:00.000Z");
    const older = orderPayload("pending", "100.00", "2026-07-26T10:00:00.000Z");
    await expect(
      service.receiveShopify(shopifyInput(older, "webhook-older", randomUUID())),
    ).resolves.toMatchObject({ duplicate: false });
    const olderEnvelope = publisher.envelopes.at(-1);
    if (!olderEnvelope) throw new Error("older provider job was not published");
    await expect(service.processWebhook(olderEnvelope)).resolves.toBe("processed");

    receivedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const privacyService = new ShopifyPrivacyWebhookService(
      new PostgresShopifyPrivacyRequestRepository(database),
      secret,
      "2026-07",
      () => receivedAt,
    );
    const privacy = Buffer.from(
      JSON.stringify({
        shop_id: 123,
        shop_domain: shopDomain,
        orders_to_redact: [123],
        customer: { id: 456, email: "must-not-be-persisted@example.test" },
      }),
    );
    const privacyInput = {
      rawBody: privacy,
      hmac: createHmac("sha256", secret).update(privacy).digest("base64"),
      webhookId: privacyWebhookId,
      topic: "customers/redact",
      apiVersion: "2026-07",
      shopDomain,
      correlationId: randomUUID(),
    };
    await expect(privacyService.receive(privacyInput)).resolves.toMatchObject({ duplicate: false });
    await expect(privacyService.receive(privacyInput)).resolves.toMatchObject({ duplicate: true });

    const evidence = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
      const counts = await transaction`
        select
          (select count(*)::integer from source_events) as sources,
          (select count(*)::integer from canonical_records) as canonical,
          (select count(*)::integer
            from source_event_object_classifications) as classifications,
          (select count(*)::integer from canonical_field_provenance) as provenance,
          (select count(*)::integer from outbox_events) as outbox,
          (select count(*)::integer from audit_events
            where resource_type = 'source_event') as audits,
          (select count(*)::integer from source_events
            where status = 'privacy_pending') as privacy_pending,
          (select count(*)::integer from provider_privacy_requests) as privacy_requests,
          (select count(*)::integer
            from provider_privacy_object_deletion_jobs) as privacy_object_jobs
      `;
      const classifications = await transaction`
        select object_families, classifier_version
        from source_event_object_classifications
        order by source_event_id
      `;
      const versions = await transaction`
        select version, source_timestamp
        from canonical_records
        order by version
      `;
      const latest = await transaction`
        select distinct on (id) normalized_data
        from canonical_records
        order by id, source_timestamp desc, version desc
      `;
      const connection = await transaction`
        select status from data_source_connections where id = ${connectionId}::uuid
      `;
      const privacyRequest = await transaction`
        select topic, external_object_ids, payload_sha256, status, due_at, received_at
        from provider_privacy_requests
      `;
      return { counts, classifications, versions, latest, connection, privacyRequest };
    });
    expect(evidence.counts[0]).toMatchObject({
      sources: 2,
      canonical: 2,
      classifications: 2,
      provenance: 12,
      outbox: 2,
      audits: 4,
      privacy_pending: 0,
      privacy_requests: 1,
      privacy_object_jobs: 2,
    });
    expect(evidence.classifications).toEqual([
      {
        object_families: ["order"],
        classifier_version: "source-object-family-v1",
      },
      {
        object_families: ["order"],
        classifier_version: "source-object-family-v1",
      },
    ]);
    expect(evidence.versions.map((row) => Number(row["version"]))).toEqual([1, 2]);
    expect(evidence.latest[0]?.["normalized_data"]).toMatchObject({
      financialStatus: "paid",
      amount: { minor: "12500", currency: "USD" },
    });
    expect(evidence.connection[0]?.["status"]).toBe("action_required");
    expect(evidence.privacyRequest[0]).toMatchObject({
      topic: "customers/redact",
      external_object_ids: ["123"],
      status: "action_required",
    });
    expect(databaseString(evidence.privacyRequest[0], "payload_sha256")).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      new Date(evidence.privacyRequest[0]?.["due_at"] as string | Date).getTime() -
        new Date(evidence.privacyRequest[0]?.["received_at"] as string | Date).getTime(),
    ).toBe(30 * 24 * 60 * 60 * 1000);

    const privacyOperations = new PostgresProviderPrivacyOperationsRepository(database);
    const pendingOperations = await privacyOperations.list(operatorTenant, { limit: 50 });
    expect(pendingOperations).toMatchObject({
      truncated: false,
      items: [
        {
          provider: "shopify",
          topic: "customers/redact",
          externalAccountId: shopDomain,
          status: "action_required",
          objectIdentifierCount: 1,
          deletionProgress: {
            total: 2,
            pending: 2,
            processing: 0,
            retry: 0,
            deleted: 0,
            alreadyMissing: 0,
            deadLettered: 0,
          },
        },
      ],
    });
    expect(JSON.stringify(pendingOperations)).not.toContain("must-not-be-persisted@example.test");
    expect(JSON.stringify(pendingOperations)).not.toContain("payloadSha256");
    expect(JSON.stringify(pendingOperations)).not.toContain("objectKey");
    await expect(privacyOperations.list(otherOperatorTenant, { limit: 50 })).resolves.toEqual({
      items: [],
      truncated: false,
    });

    const hidden = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${otherOrganizationId}, true)`;
      const sources = await transaction`select id from source_events`;
      const privacyRequests = await transaction`select id from provider_privacy_requests`;
      const privacyObjectJobs =
        await transaction`select id from provider_privacy_object_deletion_jobs`;
      return { sources, privacyRequests, privacyObjectJobs };
    });
    expect(hidden.sources).toHaveLength(0);
    expect(hidden.privacyRequests).toHaveLength(0);
    expect(hidden.privacyObjectJobs).toHaveLength(0);

    const workerDatabase = requiredConnection(worker);
    await expect(
      database`select * from reconai_claim_provider_privacy_object_deletion(${randomUUID()}::uuid)`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      database`
        select * from reconai_due_provider_privacy_deadline_alerts(
          statement_timestamp(),
          100
        )
      `,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      workerDatabase`select * from provider_privacy_object_deletion_jobs`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      workerDatabase`select * from provider_privacy_request_deadline_alerts`,
    ).rejects.toMatchObject({ code: "42501" });

    const privacyDeadlineAlerts = new PostgresProviderPrivacyDeadlineAlertRepository(
      workerDatabase,
    );
    const alertObservedAt = new Date().toISOString();
    await expect(
      privacyDeadlineAlerts.scanDueDeadlineAlerts({
        now: alertObservedAt,
        batchSize: 100,
      }),
    ).resolves.toMatchObject({
      examined: 1,
      created: 1,
      skipped: 0,
      due7Days: 0,
      due24Hours: 0,
      overdue: 1,
    });
    await expect(
      privacyDeadlineAlerts.scanDueDeadlineAlerts({
        now: new Date().toISOString(),
        batchSize: 100,
      }),
    ).resolves.toEqual({
      examined: 0,
      created: 0,
      skipped: 0,
      due7Days: 0,
      due24Hours: 0,
      overdue: 0,
    });
    await expect(privacyOperations.list(operatorTenant, { limit: 50 })).resolves.toMatchObject({
      items: [
        {
          deadlineAlert: {
            stage: "overdue",
            observedAt: alertObservedAt,
          },
        },
      ],
    });
    await expect(privacyOperations.list(otherOperatorTenant, { limit: 50 })).resolves.toEqual({
      items: [],
      truncated: false,
    });
    const deadlineEvidence = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
      return transaction`
        select
          (select count(*)::integer
            from provider_privacy_request_deadline_alerts) as alerts,
          (select count(*)::integer
            from audit_events
            where action = 'provider_privacy.deadline_alerted') as audits
      `;
    });
    expect(deadlineEvidence[0]).toMatchObject({ alerts: 1, audits: 1 });

    const privacyDeletion = new PostgresProviderPrivacyObjectDeletionRepository(workerDatabase);
    await expect(privacyDeletion.processNext(async () => "deleted")).resolves.toMatchObject({
      kind: "completed",
      outcome: "deleted",
    });
    await expect(privacyDeletion.processNext(async () => "already_missing")).resolves.toMatchObject(
      {
        kind: "completed",
        outcome: "already_missing",
      },
    );
    await expect(privacyDeletion.processNext(async () => "deleted")).resolves.toEqual({
      kind: "none",
    });
    await expect(privacyOperations.list(operatorTenant, { limit: 50 })).resolves.toMatchObject({
      items: [
        {
          deletionProgress: {
            total: 2,
            pending: 0,
            processing: 0,
            retry: 0,
            deleted: 1,
            alreadyMissing: 1,
            deadLettered: 0,
          },
        },
      ],
    });

    const tombstones = await requiredConnection(administrator)`
      select outcome, payload_sha256
      from provider_privacy_object_deletion_tombstones
      where organization_id = ${organizationId}
      order by outcome
    `;
    expect(tombstones).toHaveLength(2);
    expect(tombstones.map((row) => databaseString(row, "outcome"))).toEqual([
      "already_missing",
      "deleted",
    ]);
    expect(
      tombstones.every((row) => /^[a-f0-9]{64}$/u.test(databaseString(row, "payload_sha256"))),
    ).toBe(true);
    await expect(
      requiredConnection(administrator)`
        update provider_privacy_object_deletion_tombstones
        set outcome = 'deleted'
        where organization_id = ${organizationId}
      `,
    ).rejects.toMatchObject({ code: "P0001" });

    receivedAt = new Date("2026-07-28T03:00:00.000Z");
    const dataRequestBody = Buffer.from(
      JSON.stringify({
        shop_id: 123,
        shop_domain: shopDomain,
        orders_requested: [123],
        customer: { id: 456, email: "package-subject@example.test" },
        data_request: { id: 9999 },
      }),
    );
    await expect(
      privacyService.receive({
        rawBody: dataRequestBody,
        hmac: createHmac("sha256", secret).update(dataRequestBody).digest("base64"),
        webhookId: privacyDataRequestWebhookId,
        topic: "customers/data_request",
        apiVersion: "2026-07",
        shopDomain,
        correlationId: randomUUID(),
      }),
    ).resolves.toMatchObject({ duplicate: false });
    const dataRequestRows = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
      return transaction`
        select id
        from provider_privacy_requests
        where organization_id = ${organizationId}
          and topic = 'customers/data_request'
      `;
    });
    const dataRequestId = databaseString(dataRequestRows[0], "id");
    const packagePreparedAt = new Date();
    const packageService = new ProviderPrivacyDataPackageService({
      repository: new PostgresProviderPrivacyDataPackageRepository(database),
      objectStore,
      now: () => packagePreparedAt,
    });
    const prepared = await packageService.prepare(operatorTenant, {
      requestId: dataRequestId,
      reason: "Prepare complete linked evidence for controlled merchant review",
      correlationId: randomUUID(),
    });
    const packageDocument = JSON.parse(Buffer.from(prepared.body).toString("utf8")) as {
      readonly request: { readonly customerId: string; readonly orderIds: readonly string[] };
      readonly summary: {
        readonly sourceRecordCount: number;
        readonly canonicalRecordCount: number;
      };
      readonly records: readonly unknown[];
    };
    expect(packageDocument.request).toMatchObject({
      customerId: "456",
      orderIds: ["123"],
    });
    expect(packageDocument.summary).toMatchObject({
      sourceRecordCount: 2,
      canonicalRecordCount: 2,
    });
    expect(packageDocument.records).toHaveLength(2);
    expect(JSON.stringify(packageDocument)).not.toContain("payload_object_key");
    await expect(
      packageService.acknowledgeReceipt(operatorTenant, {
        requestId: dataRequestId,
        packageId: prepared.id,
        receiptToken: prepared.receiptToken,
        correlationId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      packageId: prepared.id,
      status: "acknowledged",
      receivedAt: packagePreparedAt.toISOString(),
    });
    await expect(
      packageService.acknowledgeReceipt(operatorTenant, {
        requestId: dataRequestId,
        packageId: prepared.id,
        receiptToken: prepared.receiptToken,
        correlationId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      packageId: prepared.id,
      status: "already_acknowledged",
      receivedAt: packagePreparedAt.toISOString(),
    });
    await expect(
      packageService.prepare(otherOperatorTenant, {
        requestId: dataRequestId,
        reason: "Attempt cross-tenant privacy export",
        correlationId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ProviderPrivacyDataPackageNotFoundError);
    await expect(
      packageService.acknowledgeReceipt(otherOperatorTenant, {
        requestId: dataRequestId,
        packageId: prepared.id,
        receiptToken: prepared.receiptToken,
        correlationId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ProviderPrivacyDataPackageNotFoundError);
    const packageAudit = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
      return transaction`
        select action, new_value
        from audit_events
        where organization_id = ${organizationId}
          and action in (
            'provider_privacy.data_package_prepared',
            'provider_privacy.data_package_received_by_browser'
          )
        order by occurred_at, id
      `;
    });
    expect(packageAudit).toHaveLength(2);
    const preparationAudit = packageAudit.find(
      (row) => row["action"] === "provider_privacy.data_package_prepared",
    );
    const receiptAudit = packageAudit.find(
      (row) => row["action"] === "provider_privacy.data_package_received_by_browser",
    );
    expect(preparationAudit?.["new_value"]).toMatchObject({
      schemaVersion: 1,
      sourceRecordCount: 2,
      canonicalRecordCount: 2,
      deliveryStatus: "not_delivered",
      browserReceiptStatus: "pending",
    });
    expect(receiptAudit).toMatchObject({
      action: "provider_privacy.data_package_received_by_browser",
      new_value: {
        packageId: prepared.id,
        browserReceiptStatus: "verified",
        deliveryStatus: "not_delivered",
      },
    });
    expect(JSON.stringify(packageAudit)).not.toContain("package-subject@example.test");
    expect(JSON.stringify(packageAudit)).not.toContain('"456"');
    expect(JSON.stringify(packageAudit)).not.toContain('"123"');
    expect(JSON.stringify(packageAudit)).not.toContain(prepared.receiptToken);
    const receiptTokenSha256 = createHash("sha256").update(prepared.receiptToken).digest("hex");
    expect(JSON.stringify(packageAudit)).not.toContain(receiptTokenSha256);

    const packageRows = await requiredConnection(administrator)`
      select
        packages.content_sha256,
        packages.byte_count,
        packages.receipt_token_sha256,
        count(receipts.id)::integer as receipt_count
      from provider_privacy_data_packages as packages
      left join provider_privacy_data_package_receipts as receipts
        on receipts.organization_id = packages.organization_id
       and receipts.package_id = packages.id
      where packages.organization_id = ${organizationId}
        and packages.id = ${prepared.id}::uuid
      group by
        packages.organization_id,
        packages.id,
        packages.content_sha256,
        packages.byte_count,
        packages.receipt_token_sha256
    `;
    expect(packageRows).toHaveLength(1);
    expect(databaseString(packageRows[0], "content_sha256").trim()).toBe(
      createHash("sha256").update(prepared.body).digest("hex"),
    );
    expect(packageRows[0]?.["byte_count"]).toBe(prepared.body.byteLength);
    expect(databaseString(packageRows[0], "receipt_token_sha256").trim()).toBe(receiptTokenSha256);
    expect(JSON.stringify(packageRows)).not.toContain(prepared.receiptToken);
    await expect(
      database`select receipt_token_sha256 from provider_privacy_data_packages`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      requiredConnection(worker)`select * from provider_privacy_data_package_receipts`,
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("persists and tenant-isolates a minimized Stripe balance-transaction fee", async () => {
    const database = requiredConnection(application);
    const publisher = new CapturingPublisher();
    const service = new ProviderWebhookService({
      environment: "integration",
      repository: new PostgresProviderWebhookRepository(database),
      objectStore: new InMemoryImmutableObjectStore(),
      secrets: new EnvironmentConnectorSecretResolver({}),
      publisher,
      now: () => new Date("2026-07-29T04:00:00.000Z"),
    });
    const snapshot = {
      schemaVersion: 1,
      object: "reconai.stripe_balance_transaction_snapshot",
      apiVersion: "2025-01-01",
      balanceTransaction: {
        id: "txn_integrationfee1",
        object: "balance_transaction",
        amount: 12_500,
        available_on: 1_785_192_000,
        created: 1_785_105_600,
        currency: "usd",
        fee: 393,
        fee_details: [
          {
            amount: 393,
            application: null,
            currency: "usd",
            description: "Stripe processing fee",
            type: "stripe_fee",
          },
        ],
        net: 12_107,
        reporting_category: "charge",
        source: {
          id: "ch_integrationfee1",
          object: "charge",
          payment_intent: "pi_integrationfee1",
        },
        status: "available",
        type: "charge",
      },
    } as const;
    const rawBody = Buffer.from(JSON.stringify(snapshot));
    const input = {
      organizationId,
      connectionId: stripeConnectionId,
      provider: "stripe",
      eventType: "balance_transaction.snapshot",
      externalEventId: snapshot.balanceTransaction.id,
      externalObjectId: snapshot.balanceTransaction.id,
      sourceTimestamp: new Date(snapshot.balanceTransaction.created * 1000).toISOString(),
      apiVersion: snapshot.apiVersion,
      rawBody,
      correlationId: randomUUID(),
    } as const;

    await expect(service.receiveSyncItem(input)).resolves.toMatchObject({ duplicate: false });
    await expect(service.receiveSyncItem(input)).resolves.toMatchObject({ duplicate: true });
    expect(publisher.envelopes).toHaveLength(1);
    const envelope = publisher.envelopes[0];
    if (!envelope) throw new Error("Stripe balance-transaction job was not published");
    await expect(service.processWebhook(envelope)).resolves.toBe("processed");
    await expect(service.processWebhook(envelope)).resolves.toBe("already_processed");

    const evidence = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
      return transaction`
        select
          source_events.external_event_id,
          source_events.status,
          source_event_object_classifications.object_families,
          canonical_records.kind,
          canonical_records.amount_minor::text as amount_minor,
          canonical_records.currency,
          canonical_records.normalized_data,
          canonical_records.is_incomplete
        from source_events
        join source_event_object_classifications
          on source_event_object_classifications.organization_id =
            source_events.organization_id
          and source_event_object_classifications.source_event_id = source_events.id
        join canonical_records
          on canonical_records.organization_id = source_events.organization_id
          and canonical_records.source_event_id = source_events.id
        where source_events.organization_id = ${organizationId}
          and source_events.connection_id = ${stripeConnectionId}::uuid
      `;
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      external_event_id: "txn_integrationfee1",
      status: "processed",
      object_families: ["balance_transaction"],
      kind: "processing_fee",
      amount_minor: "393",
      currency: "USD",
      is_incomplete: false,
      normalized_data: {
        externalId: "txn_integrationfee1",
        paymentReference: "pi_integrationfee1",
        provenance: {
          externalObjectType: "balance_transaction",
          connectorVersion: "1.1.0",
          normalizerVersion: "1.1.0",
        },
      },
    });

    const hidden = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${otherOrganizationId}, true)`;
      return transaction`
        select id
        from source_events
        where connection_id = ${stripeConnectionId}::uuid
      `;
    });
    expect(hidden).toHaveLength(0);
  });
});

function orderPayload(
  financialStatus: "paid" | "pending",
  amount: string,
  processedAt: string,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: 123,
      name: "#R123",
      processed_at: processedAt,
      financial_status: financialStatus,
      current_total_price_set: {
        shop_money: { amount, currency_code: "USD" },
      },
    }),
  );
}

function shopifyInput(rawBody: Buffer, webhookId: string, correlationId: string) {
  return {
    organizationId,
    connectionId,
    rawBody,
    hmac: createHmac("sha256", secret).update(rawBody).digest("base64"),
    webhookId,
    topic: "orders/updated",
    apiVersion: "2026-07",
    correlationId,
  };
}

class CapturingPublisher implements ProviderWebhookJobPublisher {
  public readonly envelopes: ProviderWebhookJobEnvelope[] = [];

  public async publish(envelope: ProviderWebhookJobEnvelope): Promise<void> {
    this.envelopes.push(envelope);
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the PostgreSQL integration suite`);
  return value;
}

function requiredConnection(value: Sql | undefined): Sql {
  if (!value) throw new Error("application database connection was not initialized");
  return value;
}

function databaseString(row: unknown, field: string): string {
  if (typeof row !== "object" || row === null) throw new Error("database returned an invalid row");
  const value = (row as Readonly<Record<string, unknown>>)[field];
  if (typeof value !== "string") throw new Error(`database returned an invalid ${field}`);
  return value;
}

async function ensureLocalTestRoles(sql: Sql): Promise<void> {
  const existing = await sql`
    select rolname from pg_roles
    where rolname in ('reconai_migrator', 'reconai_app', 'reconai_worker')
  `;
  const names = new Set(
    Array.from(existing, (row: unknown) => {
      if (typeof row !== "object" || row === null) throw new Error("invalid role row");
      const value = (row as Record<string, unknown>)["rolname"];
      if (typeof value !== "string") throw new Error("invalid role name");
      return value;
    }),
  );
  if (!names.has("reconai_migrator")) {
    await sql.unsafe(
      "create role reconai_migrator login password 'local-migrator-only' nosuperuser nocreatedb nocreaterole noinherit",
    );
  }
  if (!names.has("reconai_app")) {
    await sql.unsafe(
      "create role reconai_app login password 'local-app-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
    );
  }
  if (!names.has("reconai_worker")) {
    await sql.unsafe(
      "create role reconai_worker login password 'local-worker-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
    );
  }
  await sql.unsafe(
    "grant connect on database reconai to reconai_migrator, reconai_app, reconai_worker",
  );
  await sql.unsafe("grant create, usage on schema public to reconai_migrator");
  await sql.unsafe("grant usage on schema public to reconai_app, reconai_worker");
  await sql.unsafe(`
    alter default privileges for role reconai_migrator in schema public
    grant select, insert, update, delete on tables to reconai_app
  `);
  await sql.unsafe(`
    alter default privileges for role reconai_migrator in schema public
    grant select, insert, update, delete on tables to reconai_worker
  `);
}

async function seedProviderTenant(sql: Sql): Promise<void> {
  await sql`
    insert into organizations (id, name) values
      (${organizationId}, 'Provider Integration Tenant'),
      (${otherOrganizationId}, 'Other Provider Integration Tenant')
  `;
  await sql`
    insert into users (id, issuer, subject, email) values
      (
        ${operatorTenant.actorId},
        'https://issuer.example.test',
        ${`provider-${operatorTenant.actorId}`},
        'provider@example.test'
      ),
      (
        ${otherOperatorTenant.actorId},
        'https://issuer.example.test',
        ${`provider-${otherOperatorTenant.actorId}`},
        'other-provider@example.test'
      )
  `;
  await sql`
    insert into memberships (id, organization_id, user_id, role, status) values
      (
        ${operatorTenant.membershipId},
        ${organizationId},
        ${operatorTenant.actorId},
        'administrator',
        'active'
      ),
      (
        ${otherOperatorTenant.membershipId},
        ${otherOrganizationId},
        ${otherOperatorTenant.actorId},
        'administrator',
        'active'
      )
  `;
  await sql`
    insert into data_source_connections (
      id, organization_id, provider, external_account_id, status, connector_version,
      api_version, credential_reference, credential_key_version
    ) values
      (
        ${connectionId}, ${organizationId}, 'shopify', ${shopDomain},
        'healthy', '1.0.0', '2026-07', 'env:RECONAI_CONNECTOR_SHOPIFY_INTEGRATION', 'env-v1'
      ),
      (
        ${stripeConnectionId}, ${organizationId}, 'stripe', 'acct_integration',
        'healthy', '1.1.0', '2025-01-01',
        'env:RECONAI_CONNECTOR_STRIPE_INTEGRATION', 'env-v1'
      )
  `;
}
