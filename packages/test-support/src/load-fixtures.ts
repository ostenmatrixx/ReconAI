import { createHash } from "node:crypto";

import { parseRuntimeConfig } from "@workspace/config";
import {
  connectorJobId,
  connectorQueueName,
  type CsvImportJobEnvelope,
} from "@workspace/connectors";
import {
  PostgresCsvImportRepository,
  createDatabase,
  insertTenantAuditEvent,
  withTenantTransaction,
} from "@workspace/database";
import {
  canonicalFieldProvenance,
  serializeCanonicalRecord,
  tenantContextFromMembership,
  type CanonicalRecord,
  type CanonicalRecordJson,
} from "@workspace/domain";
import { CsvImportService } from "@workspace/ingestion";
import { S3ImmutableObjectStore, buildTenantObjectKey } from "@workspace/object-storage";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import postgres, { type JSONValue } from "postgres";

import { operatorEvidenceSyntheticRecords, syntheticIds } from "./index.js";

const connections = {
  shopify: "00000000-0000-4000-8000-000000000101",
  stripe: "00000000-0000-4000-8000-000000000102",
  accounting_csv: "00000000-0000-4000-8000-000000000103",
} as const;
const fixtureTimestamp = "2026-07-26T10:01:00.000Z";
const config = parseRuntimeConfig(process.env);
const adminUrl = requiredEnvironment("DATABASE_ADMIN_URL");
assertLocalFixtureEnvironment(config, adminUrl);

const administrator = postgres(adminUrl, { max: 1 });
const database = createDatabase(config.DATABASE_URL, 2);
const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: false,
});
const queue = new Queue<CsvImportJobEnvelope>(connectorQueueName(config.APP_ENV), {
  connection: redis,
});
const objectStore = new S3ImmutableObjectStore({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  bucket: config.S3_BUCKET,
  accessKeyId: config.S3_ACCESS_KEY_ID,
  secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
  ...(config.S3_SERVER_SIDE_ENCRYPTION
    ? { serverSideEncryption: config.S3_SERVER_SIDE_ENCRYPTION }
    : {}),
  ...(config.S3_KMS_KEY_ID ? { kmsKeyId: config.S3_KMS_KEY_ID } : {}),
});

try {
  await seedIdentityAndConnections();
  const tenant = tenantContextFromMembership({
    id: syntheticIds.membership,
    organizationId: syntheticIds.organization,
    userId: syntheticIds.user,
    role: "owner",
    status: "active",
  });
  const csvJobs: CsvImportJobEnvelope[] = [];
  const csvImports = new CsvImportService({
    environment: config.APP_ENV,
    repository: new PostgresCsvImportRepository(database.sql),
    objectStore,
    publisher: {
      publish: async (envelope) => {
        csvJobs.push(envelope);
        await queue.add(envelope.type, envelope, {
          jobId: connectorJobId(envelope),
          attempts: 6,
          backoff: { type: "custom" },
          removeOnComplete: { age: 86_400, count: 10_000 },
          removeOnFail: false,
        });
      },
    },
    now: () => new Date(fixtureTimestamp),
  });
  const csvPreview = await csvImports.createPreview(tenant, {
    filename: "synthetic-accounting-ledger.csv",
    contentType: "text/csv",
    body: Buffer.from(
      [
        "id,reference,order,amount,currency,effective_at,type",
        "accounting-500,shopify-refund-400,shopify-order-100,10.00,USD,2026-07-26T11:05:00.000Z,refund",
        "accounting-501,shopify-refund-400,shopify-order-100,15.00,USD,2026-07-26T11:06:00.000Z,refund",
      ].join("\n"),
    ),
    metadata: {
      connectionId: connections.accounting_csv,
      templateVersion: "synthetic-accounting-v1",
      mappingVersion: "synthetic-mapping-v1",
      mapping: {
        externalId: "id",
        transactionReference: "reference",
        orderReference: "order",
        amount: "amount",
        currency: "currency",
        effectiveAt: "effective_at",
        entryType: "type",
      },
    },
  });
  await csvImports.commitImport(tenant, {
    importId: csvPreview.receipt.id,
    correlationId: "00000000-0000-4000-8000-000000000201",
    reason: "Load the documented synthetic accounting fixture",
  });
  const csvJob = csvJobs[0];
  if (!csvJob) throw new Error("synthetic CSV job was not published");
  await csvImports.processImport(csvJob);

  const providerRecords = operatorEvidenceSyntheticRecords().filter(
    (record) => record.provenance.sourceSystem !== "accounting_csv",
  );
  const providerInsertCount = await persistProviderFixtures(tenant, providerRecords);
  const counts = await withTenantTransaction(database.sql, tenant, async (transaction) => {
    const rows = await transaction`
      select
        (select count(*)::integer from canonical_records
          where organization_id = ${tenant.organizationId}) as canonical,
        (select count(*)::integer from source_events
          where organization_id = ${tenant.organizationId}) as sources,
        (select count(*)::integer from canonical_field_provenance
          where organization_id = ${tenant.organizationId}) as provenance,
        (select count(*)::integer from imports
          where organization_id = ${tenant.organizationId} and status = 'succeeded') as imports
    `;
    return rows[0];
  });
  process.stdout.write(
    `Synthetic fixture persisted: ${String(counts?.["canonical"])} canonical records, ` +
      `${String(counts?.["sources"])} source events, ${String(counts?.["imports"])} completed import; ` +
      `${String(counts?.["provenance"])} field provenance entries; ` +
      `${providerInsertCount.toString()} provider records newly inserted.\n`,
  );
} finally {
  await queue.close();
  await redis.quit();
  objectStore.close();
  await database.close();
  await administrator.end({ timeout: 5 });
}

async function seedIdentityAndConnections(): Promise<void> {
  await administrator`
    insert into organizations (id, name, business_time_zone) values (
      ${syntheticIds.organization}, 'Synthetic Reconciliation Company', 'UTC'
    ), (
      ${syntheticIds.otherOrganization}, 'Foreign Synthetic Company', 'UTC'
    )
    on conflict (id) do update
      set name = excluded.name, business_time_zone = excluded.business_time_zone
  `;
  await administrator`
    insert into users (id, issuer, subject, email, status) values (
      ${syntheticIds.user}, ${config.OIDC_ISSUER}, ${syntheticIds.user},
      'owner@example.test', 'active'
    ), (
      ${syntheticIds.otherUser}, ${config.OIDC_ISSUER}, ${syntheticIds.otherUser},
      'foreign-owner@example.test', 'active'
    )
    on conflict (id) do update
      set issuer = excluded.issuer, subject = excluded.subject,
          email = excluded.email, status = excluded.status
  `;
  await administrator`
    insert into memberships (id, organization_id, user_id, role, status) values (
      ${syntheticIds.membership}, ${syntheticIds.organization}, ${syntheticIds.user},
      'owner', 'active'
    ), (
      ${syntheticIds.otherMembership}, ${syntheticIds.otherOrganization},
      ${syntheticIds.otherUser}, 'owner', 'active'
    )
    on conflict (organization_id, id) do update
      set role = excluded.role, status = excluded.status
  `;
  await administrator`
    insert into data_source_connections (
      id, organization_id, provider, external_account_id, status, connector_version,
      api_version, credential_reference, credential_key_version
    ) values
      (${connections.shopify}, ${syntheticIds.organization}, 'shopify',
       'synthetic-shopify-development', 'healthy', 'test-1', '2026-07',
       'env:RECONAI_CONNECTOR_SHOPIFY_DEVELOPMENT', 'env-v1'),
      (${connections.stripe}, ${syntheticIds.organization}, 'stripe',
       'synthetic-stripe-development', 'healthy', 'test-1', '2026-06-30',
       'env:RECONAI_CONNECTOR_STRIPE_DEVELOPMENT', 'env-v1'),
      (${connections.accounting_csv}, ${syntheticIds.organization}, 'accounting_csv',
       'synthetic-accounting-development', 'healthy', '1.0.0', null, null, null)
    on conflict (organization_id, id) do update
      set status = excluded.status, connector_version = excluded.connector_version,
          api_version = excluded.api_version,
          credential_reference = excluded.credential_reference,
          credential_key_version = excluded.credential_key_version
  `;
}

async function persistProviderFixtures(
  tenant: ReturnType<typeof tenantContextFromMembership>,
  records: readonly CanonicalRecord[],
): Promise<number> {
  const prepared: PreparedProviderFixture[] = [];
  for (const record of records) {
    const serialized = serializeCanonicalRecord(record);
    const rawBody = Buffer.from(JSON.stringify(serialized));
    const payloadSha256 = createHash("sha256").update(rawBody).digest("hex");
    const payloadObjectKey = buildTenantObjectKey(
      config.APP_ENV,
      tenant.organizationId,
      "provider-events",
      record.provenance.sourceEventId,
      "payload.json",
    );
    await objectStore.putImmutable({
      key: payloadObjectKey,
      body: rawBody,
      contentType: "application/json",
      checksumSha256: payloadSha256,
      metadata: { fixture: "synthetic" },
    });
    prepared.push({ record, serialized, payloadSha256, payloadObjectKey });
  }

  return withTenantTransaction(database.sql, tenant, async (transaction) => {
    let insertedCount = 0;
    for (const item of prepared) {
      const record = item.record;
      const sourceInsert = await transaction`
        insert into source_events (
          id, organization_id, connection_id, source, external_event_id, external_object_type,
          external_object_id, source_timestamp, received_at, connector_version,
          payload_object_key, payload_sha256, status
        ) values (
          ${record.provenance.sourceEventId}, ${tenant.organizationId},
          ${connections[record.provenance.sourceSystem]}, ${record.provenance.sourceSystem},
          ${`fixture:${record.provenance.sourceEventId}`}, ${record.provenance.externalObjectType},
          ${record.provenance.externalObjectId}, ${record.provenance.sourceTimestamp},
          ${record.provenance.ingestionTimestamp}, ${record.provenance.connectorVersion},
          ${item.payloadObjectKey}, ${item.payloadSha256}, 'processed'
        )
        on conflict (organization_id, connection_id, source, external_event_id) do nothing
        returning id
      `;
      const contentSha256 = createHash("sha256")
        .update(stableStringify(item.serialized))
        .digest("hex");
      const canonicalInsert = await transaction`
        insert into canonical_records (
          id, organization_id, version, kind, source_event_id, source,
          external_object_type, external_object_id, source_timestamp, ingestion_timestamp,
          effective_at, connector_version, normalizer_version, amount_minor, currency,
          order_reference, customer_reference, normalized_data, content_sha256, is_incomplete
        ) values (
          ${record.id}, ${tenant.organizationId}, ${record.version}, ${record.kind},
          ${record.provenance.sourceEventId}, ${record.provenance.sourceSystem},
          ${record.provenance.externalObjectType}, ${record.provenance.externalObjectId},
          ${record.provenance.sourceTimestamp}, ${record.provenance.ingestionTimestamp},
          ${record.effectiveAt}, ${record.provenance.connectorVersion},
          ${record.provenance.normalizerVersion}, ${record.amount.minor.toString()},
          ${record.amount.currency}, ${record.orderReference ?? null},
          ${record.customerReference ?? null},
          ${transaction.json(toJsonValue(item.serialized))}, ${contentSha256},
          ${(record.incompleteReasons?.length ?? 0) > 0}
        )
        on conflict (
          organization_id, source_event_id, normalizer_version, kind, external_object_id
        ) do nothing
        returning id
      `;
      if (sourceInsert.length !== canonicalInsert.length) {
        throw new Error("synthetic provider fixture persistence became inconsistent");
      }
      const fieldValues = canonicalFieldProvenance(record).map((entry) => ({
        organization_id: tenant.organizationId,
        record_id: record.id,
        record_version: record.version,
        field_path: entry.fieldPath,
        source_event_id: entry.sourceEventId,
        source_value_reference: entry.sourceValueReference,
        normalized_value: transaction.json(entry.normalizedValue as JSONValue),
        transformation_rule: entry.transformationRule,
        transformation_version: entry.transformationVersion,
        warnings: transaction.json(toJsonValue(entry.warnings)),
      }));
      await transaction`
        insert into canonical_field_provenance ${transaction(
          fieldValues,
          "organization_id",
          "record_id",
          "record_version",
          "field_path",
          "source_event_id",
          "source_value_reference",
          "normalized_value",
          "transformation_rule",
          "transformation_version",
          "warnings",
        )}
        on conflict (organization_id, record_id, record_version, field_path) do nothing
      `;
      insertedCount += canonicalInsert.length;
    }
    if (insertedCount > 0) {
      await insertTenantAuditEvent(transaction, {
        organizationId: tenant.organizationId,
        actorType: "system",
        actorId: "development-fixture-loader",
        action: "fixtures.provider_records.loaded",
        resourceType: "organization",
        resourceId: tenant.organizationId,
        correlationId: "00000000-0000-4000-8000-000000000202",
        reason: "Load documented synthetic provider fixtures",
        newValue: { insertedCount },
        versionContext: { fixtureVersion: "1" },
        occurredAt: fixtureTimestamp,
      });
    }
    return insertedCount;
  });
}

interface PreparedProviderFixture {
  readonly record: CanonicalRecord;
  readonly serialized: CanonicalRecordJson;
  readonly payloadSha256: string;
  readonly payloadObjectKey: string;
}

function assertLocalFixtureEnvironment(
  runtime: ReturnType<typeof parseRuntimeConfig>,
  databaseAdminUrl: string,
): void {
  if (runtime.NODE_ENV === "production" || runtime.APP_ENV === "production") {
    throw new Error("synthetic fixture loading is disabled in production");
  }
  for (const value of [
    runtime.DATABASE_URL,
    databaseAdminUrl,
    runtime.REDIS_URL,
    runtime.S3_ENDPOINT,
  ]) {
    const hostname = new URL(value).hostname;
    if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
      throw new Error("synthetic fixture loading requires loopback infrastructure");
    }
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for fixture loading`);
  return value;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      return item;
    }),
  ) as JSONValue;
}
