import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  EnvironmentConnectorSecretResolver,
  type CsvImportJobEnvelope,
} from "@workspace/connectors";
import {
  MembershipIdSchema,
  OrganizationIdSchema,
  UserIdSchema,
  tenantContextFromMembership,
} from "@workspace/domain";
import {
  CsvImportService,
  ProviderWebhookService,
  type ConnectorJobPublisher,
  type ProviderWebhookJobEnvelope,
  type ProviderWebhookJobPublisher,
} from "@workspace/ingestion";
import { InMemoryImmutableObjectStore } from "@workspace/object-storage";
import {
  PostgresCsvImportRepository,
  PostgresProviderWebhookRepository,
  PostgresSourceEventClassificationRepairRepository,
  PostgresSourceEventClassificationWriterFenceRepository,
} from "@workspace/database";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeSourceEventClassificationRepairBatch } from "./source-event-classification-repair.js";

const organizationA = OrganizationIdSchema.parse(randomUUID());
const organizationB = OrganizationIdSchema.parse(randomUUID());
const userA = UserIdSchema.parse(randomUUID());
const membershipA = MembershipIdSchema.parse(randomUUID());
const shopifyConnection = randomUUID();
const csvConnection = randomUUID();
const shopDomain = `fence-${randomUUID().replaceAll("-", "")}.myshopify.com`;
const shopifySecret = "synthetic-classification-writer-fence-secret";
const tenantA = tenantContextFromMembership({
  id: membershipA,
  organizationId: organizationA,
  userId: userA,
  role: "administrator",
  status: "active",
});
const legacyBody = orderBody("legacy-fence-order");
const csvBody = Buffer.from(
  [
    "id,reference,order,amount,currency,effective_at,type",
    "fence-entry-1,fence-refund-1,fence-order-1,25.00,USD,2026-07-29T00:00:00.000Z,refund",
  ].join("\n"),
);
const csvMetadata = {
  connectionId: csvConnection,
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

let control: Sql | undefined;
let administrator: Sql | undefined;
let application: Sql | undefined;
let worker: Sql | undefined;
let maintenance: Sql | undefined;
let migrator: Sql | undefined;
let isolatedDatabaseName: string | undefined;

describe("live source-event classification writer fence", { concurrent: false }, () => {
  beforeAll(async () => {
    const adminUrl = requiredEnvironment("DATABASE_ADMIN_URL");
    const migrationUrl = requiredEnvironment("DATABASE_MIGRATION_URL");
    const applicationUrl = requiredEnvironment("DATABASE_URL");
    const workerUrl = requiredEnvironment("DATABASE_WORKER_URL");
    const maintenanceUrl = requiredEnvironment("DATABASE_MAINTENANCE_URL");
    control = postgres(adminUrl, { max: 1 });
    await ensureLocalTestRoles(control);

    isolatedDatabaseName = `reconai_writer_fence_${randomUUID().replaceAll("-", "")}`;
    await control`create database ${control(isolatedDatabaseName)}`;
    await control`
      grant connect on database ${control(isolatedDatabaseName)}
      to reconai_migrator, reconai_app, reconai_worker, reconai_maintenance
    `;

    const isolatedAdminUrl = withDatabase(adminUrl, isolatedDatabaseName);
    const isolatedMigrationUrl = withDatabase(migrationUrl, isolatedDatabaseName);
    const isolatedApplicationUrl = withDatabase(applicationUrl, isolatedDatabaseName);
    const isolatedWorkerUrl = withDatabase(workerUrl, isolatedDatabaseName);
    const isolatedMaintenanceUrl = withDatabase(maintenanceUrl, isolatedDatabaseName);
    administrator = postgres(isolatedAdminUrl, { max: 2 });
    await prepareIsolatedDatabase(administrator);
    execFileSync("pnpm", ["--filter", "@workspace/database", "db:migrate"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_MIGRATION_URL: isolatedMigrationUrl },
      stdio: "pipe",
    });
    await seedTenantAuthorities(administrator);
    application = postgres(isolatedApplicationUrl, { max: 3 });
    worker = postgres(isolatedWorkerUrl, { max: 1 });
    maintenance = postgres(isolatedMaintenanceUrl, { max: 2 });
    migrator = postgres(isolatedMigrationUrl, { max: 1 });
  });

  afterAll(async () => {
    await migrator?.end({ timeout: 5 });
    await maintenance?.end({ timeout: 5 });
    await worker?.end({ timeout: 5 });
    await application?.end({ timeout: 5 });
    await administrator?.end({ timeout: 5 });
    if (control && isolatedDatabaseName?.startsWith("reconai_writer_fence_")) {
      await control`drop database ${control(isolatedDatabaseName)} with (force)`;
    }
    await control?.end({ timeout: 5 });
  });

  it("serializes activation with old writers and admits only compatible current writers", async () => {
    const app = requiredConnection(application, "application");
    const admin = requiredConnection(administrator, "administrator");
    const maintenanceSql = requiredConnection(maintenance, "maintenance");
    const fence = new PostgresSourceEventClassificationWriterFenceRepository(maintenanceSql);
    await expect(fence.status()).resolves.toEqual({
      enabled: false,
      fenceVersion: "source-classification-writer-fence-v1",
    });

    const firstLegacyEvent = randomUUID();
    const firstLegacyKey = objectKey(firstLegacyEvent);
    await insertTenantSourceEvent(app, {
      sourceEventId: firstLegacyEvent,
      eventType: "orders/updated",
      externalEventId: `legacy-before-fence-${firstLegacyEvent}`,
      objectKey: firstLegacyKey,
      payloadSha256: sha256(legacyBody),
    });
    await expect(
      activate(fence, randomUUID(), "Initial activation must reject an unclassified legacy row"),
    ).rejects.toMatchObject({ code: "23514" });

    const repairStore = new InMemoryImmutableObjectStore();
    await put(repairStore, firstLegacyKey, legacyBody);
    await expect(
      executeSourceEventClassificationRepairBatch({
        repository: new PostgresSourceEventClassificationRepairRepository(maintenanceSql),
        objectStore: repairStore,
        requestedBy: "writer-fence-integration",
        reason: "Repair checksum-bound legacy evidence before activating the writer fence",
        batchSize: 1,
      }),
    ).resolves.toMatchObject({
      examined: 1,
      classified: 1,
      remainingGaps: 0,
      complete: true,
    });

    const inFlightEvent = randomUUID();
    const inFlightKey = objectKey(inFlightEvent);
    const writerBarrier = deferredSignal();
    const writerInserted = deferredSignal();
    const inFlightWriter = app.begin(async (transaction) => {
      await setTenant(transaction, organizationA);
      await insertSourceEvent(transaction, {
        sourceEventId: inFlightEvent,
        eventType: "orders/updated",
        externalEventId: `in-flight-before-fence-${inFlightEvent}`,
        objectKey: inFlightKey,
        payloadSha256: sha256(legacyBody),
      });
      writerInserted.resolve();
      await writerBarrier.promise;
    });
    await writerInserted.promise;
    const blockedActivation = settle(
      activate(fence, randomUUID(), "Activation waits for an in-flight legacy writer transaction"),
    );
    await waitForAdvisoryWaiter(admin);
    writerBarrier.resolve();
    await expect(inFlightWriter).resolves.toBeUndefined();
    const blockedResult = await blockedActivation;
    expect(blockedResult.ok).toBe(false);
    if (blockedResult.ok) throw new Error("blocked activation unexpectedly succeeded");
    expect(blockedResult.error).toMatchObject({ code: "23514" });

    await put(repairStore, inFlightKey, legacyBody);
    await expect(
      executeSourceEventClassificationRepairBatch({
        repository: new PostgresSourceEventClassificationRepairRepository(maintenanceSql),
        objectStore: repairStore,
        requestedBy: "writer-fence-integration",
        reason: "Repair the drained in-flight legacy writer before one-way activation",
        batchSize: 1,
      }),
    ).resolves.toMatchObject({
      classified: 1,
      remainingGaps: 0,
      complete: true,
    });

    const activationId = randomUUID();
    const activated = await activate(
      fence,
      activationId,
      "Enable the one-way classification-aware writer boundary after zero gaps",
    );
    expect(activated).toMatchObject({
      enabled: true,
      changed: true,
      activationId,
      fenceVersion: "source-classification-writer-fence-v1",
    });
    const replayedActivation = await activate(
      fence,
      randomUUID(),
      "Verify repeated activation converges on the immutable singleton authority",
    );
    expect(replayedActivation).toMatchObject({
      enabled: true,
      changed: false,
      activationId,
    });

    const rejectedLegacyEvent = randomUUID();
    await expect(
      insertTenantSourceEvent(app, {
        sourceEventId: rejectedLegacyEvent,
        eventType: "orders/updated",
        externalEventId: `legacy-after-fence-${rejectedLegacyEvent}`,
        objectKey: objectKey(rejectedLegacyEvent),
        payloadSha256: sha256(legacyBody),
      }),
    ).rejects.toMatchObject({ code: "23514" });

    const incompatibleEvent = randomUUID();
    await expect(
      app.begin(async (transaction) => {
        await setTenant(transaction, organizationA);
        await insertSourceEvent(transaction, {
          sourceEventId: incompatibleEvent,
          eventType: "orders/updated",
          externalEventId: `incompatible-after-fence-${incompatibleEvent}`,
          objectKey: objectKey(incompatibleEvent),
          payloadSha256: sha256(legacyBody),
        });
        await transaction`
          insert into source_event_object_classifications (
            organization_id, source_event_id, object_families, classifier_version
          ) values (
            ${organizationA}, ${incompatibleEvent}, ARRAY['refund_transaction']::text[],
            'source-object-family-v1'
          )
        `;
      }),
    ).rejects.toMatchObject({ code: "23514" });

    const providerPublisher = new CapturingProviderPublisher();
    const providerStore = new InMemoryImmutableObjectStore();
    const providerService = new ProviderWebhookService({
      environment: "integration",
      repository: new PostgresProviderWebhookRepository(app),
      objectStore: providerStore,
      secrets: new EnvironmentConnectorSecretResolver({
        RECONAI_CONNECTOR_SHOPIFY_FENCE_TEST: shopifySecret,
      }),
      publisher: providerPublisher,
      now: () => new Date("2026-07-29T09:00:00.000Z"),
    });
    const providerBody = orderBody("current-provider-order");
    const providerInput = {
      organizationId: organizationA,
      connectionId: shopifyConnection,
      rawBody: providerBody,
      hmac: createHmac("sha256", shopifySecret).update(providerBody).digest("base64"),
      webhookId: `fence-webhook-${randomUUID()}`,
      topic: "orders/updated",
      apiVersion: "2026-07",
      correlationId: randomUUID(),
    } as const;
    await expect(providerService.receiveShopify(providerInput)).resolves.toMatchObject({
      duplicate: false,
    });
    await expect(providerService.receiveShopify(providerInput)).resolves.toMatchObject({
      duplicate: true,
    });
    expect(providerPublisher.envelopes).toHaveLength(2);
    expect(providerPublisher.envelopes[1]).toEqual(providerPublisher.envelopes[0]);

    const csvPublisher = new CapturingCsvPublisher();
    const csvService = new CsvImportService({
      environment: "integration",
      repository: new PostgresCsvImportRepository(app),
      objectStore: new InMemoryImmutableObjectStore(),
      publisher: csvPublisher,
      now: () => new Date("2026-07-29T09:01:00.000Z"),
    });
    const preview = await csvService.createPreview(tenantA, {
      filename: "writer-fence.csv",
      contentType: "text/csv",
      body: csvBody,
      metadata: csvMetadata,
    });
    await csvService.commitImport(tenantA, {
      importId: preview.receipt.id,
      correlationId: randomUUID(),
      reason: "Verify the current atomic CSV source-classification writer under the active fence",
    });
    const csvEnvelope = csvPublisher.envelopes[0];
    if (!csvEnvelope) throw new Error("CSV writer-fence job was not published");
    await expect(csvService.processImport(csvEnvelope)).resolves.toBe("processed");
    await expect(csvService.processImport(csvEnvelope)).resolves.toBe("already_processed");

    const privacyEvent = randomUUID();
    await expect(
      insertTenantSourceEvent(app, {
        sourceEventId: privacyEvent,
        eventType: "customers/redact",
        externalEventId: `privacy-after-fence-${privacyEvent}`,
        objectKey: objectKey(privacyEvent),
        payloadSha256: sha256(Buffer.from('{"shop_id":123}')),
      }),
    ).resolves.toBeUndefined();

    const evidence = await admin`
      select
        (select count(*)::integer
          from source_event_classification_writer_fence_activations) as activations,
        (select count(*)::integer
          from source_events
          where id in (${rejectedLegacyEvent}::uuid, ${incompatibleEvent}::uuid)) as rejected_rows,
        (select count(*)::integer
          from source_event_object_classifications
          where source_event_id in (${rejectedLegacyEvent}::uuid, ${incompatibleEvent}::uuid))
          as rejected_classifications,
        (select count(*)::integer
          from source_event_object_classifications
          where source_event_id in (${firstLegacyEvent}::uuid, ${inFlightEvent}::uuid))
          as repaired_classifications,
        (select count(*)::integer
          from source_events
          where id = ${privacyEvent}::uuid) as privacy_rows,
        (select count(*)::integer
          from source_event_object_classifications
          where source_event_id = ${privacyEvent}::uuid) as privacy_classifications,
        (select count(*)::integer
          from source_events
          where source = 'accounting_csv') as csv_rows,
        (select count(*)::integer
          from source_event_object_classifications
          where object_families = ARRAY['csv_row']::text[]) as csv_classifications,
        (select count(*)::integer
          from source_event_object_classifications
          where object_families = ARRAY['order']::text[]) as order_classifications,
        (select count(*)::integer from outbox_events) as outbox_events
    `;
    expect(evidence[0]).toMatchObject({
      activations: 1,
      rejected_rows: 0,
      rejected_classifications: 0,
      repaired_classifications: 2,
      privacy_rows: 1,
      privacy_classifications: 0,
      csv_rows: 1,
      csv_classifications: 1,
      order_classifications: 3,
      outbox_events: 2,
    });

    const gapCounts = await maintenanceSql`
      select * from reconai_source_event_classification_repair_gap_counts()
    `;
    expect(gapCounts).toEqual([{ total_gaps: "0", repairable_gaps: "0" }]);

    const hidden = await app.begin(async (transaction) => {
      await setTenant(transaction, organizationB);
      return transaction`
        select
          (select count(*)::integer from source_events) as source_events,
          (select count(*)::integer
            from source_event_object_classifications) as classifications
      `;
    });
    expect(hidden).toEqual([{ source_events: 0, classifications: 0 }]);

    await expect(
      app`select * from reconai_source_event_classification_writer_fence_status()`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      requiredConnection(worker, "worker")`
        select * from reconai_activate_source_event_classification_writer_fence(
          ${randomUUID()}::uuid,
          'writer-fence-integration',
          'Worker role must never activate the global classification writer boundary',
          'ENABLE-SOURCE-CLASSIFICATION-WRITER-FENCE'
        )
      `,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      requiredConnection(migrator, "migrator")`
        select * from reconai_activate_source_event_classification_writer_fence(
          ${randomUUID()}::uuid,
          'writer-fence-integration',
          'Migration owner cannot substitute for the dedicated maintenance session',
          'ENABLE-SOURCE-CLASSIFICATION-WRITER-FENCE'
        )
      `,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      maintenanceSql`select * from source_event_classification_writer_fence_activations`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      admin`
        update source_event_classification_writer_fence_activations
        set reason = 'Attempted mutation of the immutable activation authority'
      `,
    ).rejects.toThrow(/append-only/u);
  });
});

class CapturingProviderPublisher implements ProviderWebhookJobPublisher {
  public readonly envelopes: ProviderWebhookJobEnvelope[] = [];

  public async publish(envelope: ProviderWebhookJobEnvelope): Promise<void> {
    this.envelopes.push(envelope);
  }
}

class CapturingCsvPublisher implements ConnectorJobPublisher {
  public readonly envelopes: CsvImportJobEnvelope[] = [];

  public async publish(envelope: CsvImportJobEnvelope): Promise<void> {
    this.envelopes.push(envelope);
  }
}

async function activate(
  repository: PostgresSourceEventClassificationWriterFenceRepository,
  activationId: string,
  reason: string,
) {
  return repository.activate({
    activationId,
    requestedBy: "writer-fence-integration",
    reason,
    confirmation: "ENABLE-SOURCE-CLASSIFICATION-WRITER-FENCE",
  });
}

async function insertTenantSourceEvent(sql: Sql, input: SourceEventInput): Promise<void> {
  await sql.begin(async (transaction) => {
    await setTenant(transaction, organizationA);
    await insertSourceEvent(transaction, input);
  });
}

async function insertSourceEvent(sql: TransactionSql, input: SourceEventInput): Promise<void> {
  await sql`
    insert into source_events (
      id, organization_id, connection_id, source, external_event_id, external_object_type,
      external_object_id, source_timestamp, received_at, connector_version, api_version,
      payload_object_key, payload_sha256, status
    ) values (
      ${input.sourceEventId}, ${organizationA}, ${shopifyConnection}, 'shopify',
      ${input.externalEventId}, ${input.eventType}, ${`external-${input.sourceEventId}`},
      '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:01.000Z', '1.0.0', '2026-07',
      ${input.objectKey}, ${input.payloadSha256}, 'processed'
    )
  `;
}

interface SourceEventInput {
  readonly sourceEventId: string;
  readonly eventType: string;
  readonly externalEventId: string;
  readonly objectKey: string;
  readonly payloadSha256: string;
}

async function setTenant(sql: TransactionSql, organizationId: string): Promise<void> {
  await sql`select set_config('app.organization_id', ${organizationId}, true)`;
}

async function waitForAdvisoryWaiter(sql: Sql): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await sql`
      select count(*)::integer as waiting
      from pg_locks
      where locktype = 'advisory'
        and not granted
    `;
    if (Number(rows[0]?.["waiting"]) > 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("classification writer-fence activation did not wait for the in-flight writer");
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

function orderBody(externalId: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: 123,
      name: `#${externalId}`,
      processed_at: "2026-07-29T00:00:00.000Z",
      financial_status: "paid",
      current_total_price_set: {
        shop_money: { amount: "10.00", currency_code: "USD" },
      },
    }),
  );
}

function objectKey(sourceEventId: string): string {
  return `integration/${organizationA}/provider-events/${sourceEventId}/payload.json`;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function deferredSignal(): {
  readonly promise: Promise<undefined>;
  readonly resolve: () => void;
} {
  let resolvePromise: ((value: undefined) => void) | undefined;
  const promise = new Promise<undefined>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(): void {
      if (!resolvePromise) throw new Error("deferred promise was not initialized");
      resolvePromise(undefined);
    },
  };
}

async function settle<T>(
  promise: Promise<T>,
): Promise<
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
> {
  try {
    return { ok: true, value: await promise };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}

async function ensureLocalTestRoles(sql: Sql): Promise<void> {
  const existing = await sql`
    select rolname from pg_roles
    where rolname in (
      'reconai_migrator',
      'reconai_app',
      'reconai_worker',
      'reconai_maintenance'
    )
  `;
  const roleNames = new Set(Array.from(existing, (row: unknown) => databaseString(row, "rolname")));
  const definitions: Readonly<Record<string, string>> = {
    reconai_migrator:
      "create role reconai_migrator login password 'local-migrator-only' nosuperuser nocreatedb nocreaterole noinherit",
    reconai_app:
      "create role reconai_app login password 'local-app-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
    reconai_worker:
      "create role reconai_worker login password 'local-worker-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
    reconai_maintenance:
      "create role reconai_maintenance login password 'local-maintenance-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
  };
  for (const [name, definition] of Object.entries(definitions)) {
    if (!roleNames.has(name)) await sql.unsafe(definition);
  }
}

async function prepareIsolatedDatabase(sql: Sql): Promise<void> {
  await sql.unsafe("grant create, usage on schema public to reconai_migrator");
  await sql.unsafe(
    "grant usage on schema public to reconai_app, reconai_worker, reconai_maintenance",
  );
  await sql.unsafe(`
    alter default privileges for role reconai_migrator in schema public
    grant select, insert, update, delete on tables to reconai_app
  `);
  await sql.unsafe(`
    alter default privileges for role reconai_migrator in schema public
    grant select, insert, update, delete on tables to reconai_worker
  `);
}

async function seedTenantAuthorities(sql: Sql): Promise<void> {
  const otherUser = randomUUID();
  await sql`
    insert into organizations (id, name) values
      (${organizationA}, 'Writer Fence Tenant A'),
      (${organizationB}, 'Writer Fence Tenant B')
  `;
  await sql`
    insert into users (id, issuer, subject, email) values
      (
        ${userA}, 'https://issuer.example.test', ${`writer-fence-${userA}`},
        'writer-fence-a@example.test'
      ),
      (
        ${otherUser}, 'https://issuer.example.test', ${`writer-fence-${otherUser}`},
        'writer-fence-b@example.test'
      )
  `;
  await sql`
    insert into memberships (id, organization_id, user_id, role, status) values
      (${membershipA}, ${organizationA}, ${userA}, 'administrator', 'active'),
      (${randomUUID()}, ${organizationB}, ${otherUser}, 'administrator', 'active')
  `;
  await sql`
    insert into data_source_connections (
      id, organization_id, provider, external_account_id, status, connector_version,
      api_version, credential_reference, credential_key_version
    ) values
      (
        ${shopifyConnection}, ${organizationA}, 'shopify', ${shopDomain},
        'healthy', '1.0.0', '2026-07',
        'env:RECONAI_CONNECTOR_SHOPIFY_FENCE_TEST', 'env-v1'
      ),
      (
        ${csvConnection}, ${organizationA}, 'accounting_csv',
        ${`writer-fence-csv-${csvConnection}`}, 'healthy', '1.0.0',
        null, null, null
      )
  `;
}

function withDatabase(value: string, databaseName: string): string {
  const url = new URL(value);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for writer-fence integration`);
  return value;
}

function requiredConnection(value: Sql | undefined, name: string): Sql {
  if (!value) throw new Error(`${name} database connection was not initialized`);
  return value;
}

function databaseString(row: unknown, field: string): string {
  if (typeof row !== "object" || row === null) throw new Error(`invalid ${field} row`);
  const value = (row as Readonly<Record<string, unknown>>)[field];
  if (typeof value !== "string") throw new Error(`invalid ${field} value`);
  return value;
}
