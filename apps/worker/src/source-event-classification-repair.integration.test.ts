import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  computeAuditEventHashV2,
  PostgresSourceEventClassificationRepairRepository,
  type AuditJsonValue,
} from "@workspace/database";
import { InMemoryImmutableObjectStore, type ImmutableObjectStore } from "@workspace/object-storage";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  SourceEventClassificationRepairError,
  executeSourceEventClassificationRepairBatch,
} from "./source-event-classification-repair.js";

const organizationA = randomUUID();
const organizationB = randomUUID();
const connectionA = randomUUID();
const connectionB = randomUUID();
const sourceEventA = randomUUID();
const sourceEventB = randomUUID();
const missingSourceEvent = randomUUID();
const unsupportedSourceEvent = randomUUID();
const bodyA = shopifyOrder();
const bodyB = stripeRefund();
const objectKeyA = `integration/${organizationA}/provider-events/${sourceEventA}/payload.json`;
const objectKeyB = `integration/${organizationB}/provider-events/${sourceEventB}/payload.json`;
const missingObjectKey = `integration/${organizationA}/provider-events/${missingSourceEvent}/payload.json`;
const unsupportedObjectKey = `integration/${organizationA}/provider-events/${unsupportedSourceEvent}/payload.json`;

let admin: Sql | undefined;
let application: Sql | undefined;
let worker: Sql | undefined;
let maintenanceA: Sql | undefined;
let maintenanceB: Sql | undefined;

describe("live source-event classification repair", { concurrent: false }, () => {
  beforeAll(async () => {
    const adminUrl = requiredEnvironment("DATABASE_ADMIN_URL");
    const migrationUrl = requiredEnvironment("DATABASE_MIGRATION_URL");
    const applicationUrl = requiredEnvironment("DATABASE_URL");
    const workerUrl = requiredEnvironment("DATABASE_WORKER_URL");
    const maintenanceUrl = requiredEnvironment("DATABASE_MAINTENANCE_URL");
    admin = postgres(adminUrl, { max: 1 });
    await ensureLocalTestRoles(admin);
    execFileSync("pnpm", ["--filter", "@workspace/database", "db:migrate"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl },
      stdio: "pipe",
    });
    await seedTenantsAndLegacyEvents(admin);
    application = postgres(applicationUrl, { max: 1 });
    worker = postgres(workerUrl, { max: 1 });
    maintenanceA = postgres(maintenanceUrl, { max: 1 });
    maintenanceB = postgres(maintenanceUrl, { max: 1 });
  });

  afterAll(async () => {
    await maintenanceB?.end({ timeout: 5 });
    await maintenanceA?.end({ timeout: 5 });
    await worker?.end({ timeout: 5 });
    await application?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
  });

  it("repairs distinct locked candidates concurrently with exact tenant audit evidence", async () => {
    const store = new TwoReadBarrierStore();
    await put(store, objectKeyA, bodyA);
    await put(store, objectKeyB, bodyB);
    const repairRunA = randomUUID();
    const repairRunB = randomUUID();
    const [resultA, resultB] = await Promise.all([
      executeSourceEventClassificationRepairBatch({
        repository: new PostgresSourceEventClassificationRepairRepository(
          requiredConnection(maintenanceA, "maintenance A"),
        ),
        objectStore: store,
        requestedBy: "classification-repair-integration",
        reason: "Repair checksum-verified source classification during bounded rollout",
        batchSize: 1,
        repairRunId: repairRunA,
        now: () => new Date("2026-07-29T08:10:00.000Z"),
      }),
      executeSourceEventClassificationRepairBatch({
        repository: new PostgresSourceEventClassificationRepairRepository(
          requiredConnection(maintenanceB, "maintenance B"),
        ),
        objectStore: store,
        requestedBy: "classification-repair-integration",
        reason: "Repair checksum-verified source classification during bounded rollout",
        batchSize: 1,
        repairRunId: repairRunB,
        now: () => new Date("2026-07-29T08:10:01.000Z"),
      }),
    ]);
    expect(resultA.classified + resultB.classified).toBe(2);
    expect(resultA.examined + resultB.examined).toBe(2);
    expect(store.maximumConcurrentReads).toBe(2);

    const evidence = await requiredConnection(application, "application").begin(
      async (transaction) => {
        await transaction`select set_config('app.organization_id', ${organizationA}, true)`;
        const classifications = await transaction`
          select source_event_id, object_families, classifier_version
          from source_event_object_classifications
          order by source_event_id
        `;
        const audits = await transaction`
          select
            id, organization_id, actor_type, actor_id, action, resource_type, resource_id,
            occurred_at, correlation_id, reason, previous_value, new_value, version_context,
            previous_event_hash, event_hash, hash_version
          from audit_events
          where action = 'source_event.classification_repaired'
          order by resource_id
        `;
        return { classifications, audits };
      },
    );
    expect(evidence.classifications).toEqual([
      {
        source_event_id: sourceEventA,
        object_families: ["order"],
        classifier_version: "source-object-family-v1",
      },
    ]);
    expect(evidence.audits).toHaveLength(1);
    expect(evidence.audits[0]).toMatchObject({
      actor_type: "system",
      actor_id: "classification-repair-integration",
      action: "source_event.classification_repaired",
      resource_id: sourceEventA,
      new_value: {
        source: "shopify",
        eventType: "orders/updated",
        objectFamilies: ["order"],
      },
      version_context: {
        repairVersion: "source-object-family-repair-v1",
        classifierVersion: "source-object-family-v1",
      },
    });
    expect([repairRunA, repairRunB]).toContain(evidence.audits[0]?.["correlation_id"]);
    const audit = requiredAuditRow(evidence.audits[0]);
    expect(audit.hash_version).toBe(2);
    expect(audit.event_hash).toBe(
      computeAuditEventHashV2({
        id: databaseString(audit, "id"),
        organizationId: databaseString(audit, "organization_id"),
        actorType: "system",
        actorId: databaseString(audit, "actor_id"),
        action: databaseString(audit, "action"),
        resourceType: databaseString(audit, "resource_type"),
        resourceId: databaseString(audit, "resource_id"),
        occurredAt: databaseInstant(audit, "occurred_at"),
        correlationId: databaseString(audit, "correlation_id"),
        reason: databaseString(audit, "reason"),
        previousValue: null,
        newValue: requiredAuditJson(audit, "new_value"),
        versionContext: requiredAuditJson(audit, "version_context"),
        previousEventHash: null,
      }),
    );

    const hidden = await requiredConnection(application, "application").begin(
      async (transaction) => {
        await transaction`select set_config('app.organization_id', ${organizationB}, true)`;
        return transaction`
          select source_event_id
          from source_event_object_classifications
          where source_event_id = ${sourceEventA}::uuid
        `;
      },
    );
    expect(hidden).toHaveLength(0);

    await expect(
      requiredConnection(application, "application")`
        select * from reconai_claim_source_event_classification_repair_candidate()
      `,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      requiredConnection(worker, "worker")`
        select * from reconai_source_event_classification_repair_gap_counts()
      `,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      requiredConnection(maintenanceA, "maintenance A")`
        select * from source_events
      `,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      requiredConnection(maintenanceA, "maintenance A")`
        insert into source_event_object_classifications (
          organization_id, source_event_id, object_families, classifier_version
        ) values (
          ${organizationA}, ${randomUUID()}::uuid, ARRAY['order']::text[],
          'source-object-family-v1'
        )
      `,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      requiredConnection(maintenanceA, "maintenance A")`
        select * from audit_events
      `,
    ).rejects.toMatchObject({ code: "42501" });

    const role = await requiredConnection(admin, "administrator")`
      select rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls
      from pg_roles
      where rolname = 'reconai_maintenance'
    `;
    expect(role).toEqual([
      {
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolbypassrls: false,
      },
    ]);
  });

  it("rolls back integrity failures, replays safely, and leaves unsupported gaps visible", async () => {
    await insertLegacyEvent(requiredConnection(admin, "administrator"), {
      organizationId: organizationA,
      connectionId: connectionA,
      sourceEventId: missingSourceEvent,
      source: "shopify",
      eventType: "orders/updated",
      externalEventId: `legacy-missing-${missingSourceEvent}`,
      objectKey: missingObjectKey,
      payloadSha256: sha256(bodyA),
    });
    const repository = new PostgresSourceEventClassificationRepairRepository(
      requiredConnection(maintenanceA, "maintenance A"),
    );
    await expect(
      executeSourceEventClassificationRepairBatch({
        repository,
        objectStore: new InMemoryImmutableObjectStore(),
        requestedBy: "classification-repair-integration",
        reason: "Verify missing legacy object stops classification repair atomically",
        batchSize: 1,
      }),
    ).rejects.toBeInstanceOf(SourceEventClassificationRepairError);
    expect(await classificationCount(missingSourceEvent)).toBe(0);
    expect(await repairAuditCount(missingSourceEvent)).toBe(0);

    const recoveredStore = new InMemoryImmutableObjectStore();
    await put(recoveredStore, missingObjectKey, bodyA);
    await expect(
      recoveredStore.getVerified({
        key: missingObjectKey,
        expectedChecksumSha256: sha256(bodyA),
        maximumBytes: 1024 * 1024,
      }),
    ).resolves.toHaveLength(bodyA.byteLength);
    const recovered = await executeSourceEventClassificationRepairBatch({
      repository,
      objectStore: recoveredStore,
      requestedBy: "classification-repair-integration",
      reason: "Retry exact missing-object classification after integrity recovery",
      batchSize: 1,
    });
    expect(recovered).toMatchObject({
      classified: 1,
      remainingGaps: 0,
      remainingRepairableGaps: 0,
      complete: true,
    });
    const replay = await executeSourceEventClassificationRepairBatch({
      repository,
      objectStore: recoveredStore,
      requestedBy: "classification-repair-integration",
      reason: "Verify exact classification repair replay is idempotent",
      batchSize: 10,
    });
    expect(replay).toMatchObject({
      examined: 0,
      classified: 0,
      alreadyClassified: 0,
      remainingGaps: 0,
      complete: true,
    });
    expect(await classificationCount(missingSourceEvent)).toBe(1);
    expect(await repairAuditCount(missingSourceEvent)).toBe(1);

    await insertLegacyEvent(requiredConnection(admin, "administrator"), {
      organizationId: organizationA,
      connectionId: connectionA,
      sourceEventId: unsupportedSourceEvent,
      source: "shopify",
      eventType: "orders/legacy",
      externalEventId: `legacy-unsupported-${unsupportedSourceEvent}`,
      objectKey: unsupportedObjectKey,
      payloadSha256: sha256(bodyA),
    });
    const blocked = await executeSourceEventClassificationRepairBatch({
      repository,
      objectStore: recoveredStore,
      requestedBy: "classification-repair-integration",
      reason: "Confirm unsupported source topics remain fail-closed for review",
      batchSize: 10,
    });
    expect(blocked).toMatchObject({
      examined: 0,
      classified: 0,
      remainingGaps: 1,
      remainingRepairableGaps: 0,
      complete: false,
    });
  });
});

class TwoReadBarrierStore extends InMemoryImmutableObjectStore {
  public maximumConcurrentReads = 0;
  #activeReads = 0;
  #arrivals = 0;
  #release: (() => void) | undefined;
  readonly #barrier = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  public override async getVerified(
    input: Parameters<ImmutableObjectStore["getVerified"]>[0],
  ): ReturnType<ImmutableObjectStore["getVerified"]> {
    this.#activeReads += 1;
    this.maximumConcurrentReads = Math.max(this.maximumConcurrentReads, this.#activeReads);
    this.#arrivals += 1;
    if (this.#arrivals === 2) this.#release?.();
    await this.#barrier;
    try {
      return await super.getVerified(input);
    } finally {
      this.#activeReads -= 1;
    }
  }
}

async function seedTenantsAndLegacyEvents(sql: Sql): Promise<void> {
  const userA = randomUUID();
  const userB = randomUUID();
  await sql`
    insert into organizations (id, name) values
      (${organizationA}, 'Classification Repair Tenant A'),
      (${organizationB}, 'Classification Repair Tenant B')
  `;
  await sql`
    insert into users (id, issuer, subject, email) values
      (${userA}, 'https://issuer.example.test', ${`repair-${userA}`}, 'repair-a@example.test'),
      (${userB}, 'https://issuer.example.test', ${`repair-${userB}`}, 'repair-b@example.test')
  `;
  await sql`
    insert into memberships (id, organization_id, user_id, role, status) values
      (${randomUUID()}, ${organizationA}, ${userA}, 'administrator', 'active'),
      (${randomUUID()}, ${organizationB}, ${userB}, 'administrator', 'active')
  `;
  await sql`
    insert into data_source_connections (
      id, organization_id, provider, external_account_id, status, connector_version
    ) values
      (
        ${connectionA}, ${organizationA}, 'shopify',
        ${`repair-${connectionA}.myshopify.com`}, 'healthy', '1.0.0'
      ),
      (
        ${connectionB}, ${organizationB}, 'stripe',
        ${`acct_${connectionB.replaceAll("-", "")}`}, 'healthy', '1.0.0'
      )
  `;
  await insertLegacyEvent(sql, {
    organizationId: organizationA,
    connectionId: connectionA,
    sourceEventId: sourceEventA,
    source: "shopify",
    eventType: "orders/updated",
    externalEventId: `legacy-${sourceEventA}`,
    objectKey: objectKeyA,
    payloadSha256: sha256(bodyA),
  });
  await insertLegacyEvent(sql, {
    organizationId: organizationB,
    connectionId: connectionB,
    sourceEventId: sourceEventB,
    source: "stripe",
    eventType: "refund.updated",
    externalEventId: `legacy-${sourceEventB}`,
    objectKey: objectKeyB,
    payloadSha256: sha256(bodyB),
  });
}

async function insertLegacyEvent(
  sql: Sql,
  input: {
    readonly organizationId: string;
    readonly connectionId: string;
    readonly sourceEventId: string;
    readonly source: "shopify" | "stripe";
    readonly eventType: string;
    readonly externalEventId: string;
    readonly objectKey: string;
    readonly payloadSha256: string;
  },
): Promise<void> {
  await sql`
    insert into source_events (
      id, organization_id, connection_id, source, external_event_id, external_object_type,
      external_object_id, source_timestamp, received_at, connector_version,
      payload_object_key, payload_sha256, status
    ) values (
      ${input.sourceEventId},
      ${input.organizationId},
      ${input.connectionId},
      ${input.source},
      ${input.externalEventId},
      ${input.eventType},
      ${`external-${input.sourceEventId}`},
      '2026-07-29T00:00:00.000Z',
      '2026-07-29T00:00:01.000Z',
      '1.0.0',
      ${input.objectKey},
      ${input.payloadSha256},
      'processed'
    )
  `;
}

async function classificationCount(sourceEventId: string): Promise<number> {
  const rows = await requiredConnection(admin, "administrator")`
    select count(*)::integer as count
    from source_event_object_classifications
    where source_event_id = ${sourceEventId}::uuid
  `;
  return Number(rows[0]?.["count"]);
}

async function repairAuditCount(sourceEventId: string): Promise<number> {
  const rows = await requiredConnection(admin, "administrator")`
    select count(*)::integer as count
    from audit_events
    where resource_id = ${sourceEventId}
      and action = 'source_event.classification_repaired'
  `;
  return Number(rows[0]?.["count"]);
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

function shopifyOrder(): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      id: 123,
      name: "#R123",
      processed_at: "2026-07-29T00:00:00.000Z",
      financial_status: "paid",
      current_total_price_set: {
        shop_money: { amount: "10.00", currency_code: "USD" },
      },
    }),
  );
}

function stripeRefund(): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      id: "evt_repair_live",
      object: "event",
      created: 1785283200,
      api_version: "2025-06-30.basil",
      type: "refund.updated",
      data: {
        object: {
          id: "re_repair_live",
          object: "refund",
          amount: 100,
          currency: "usd",
          created: 1785283200,
          payment_intent: "pi_repair_live",
          status: "succeeded",
        },
      },
    }),
  );
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
  const names = new Set(Array.from(existing, (row: unknown) => databaseString(row, "rolname")));
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
    if (!names.has(name)) await sql.unsafe(definition);
  }
  await sql.unsafe(`
    grant connect on database reconai
    to reconai_migrator, reconai_app, reconai_worker, reconai_maintenance
  `);
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

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for classification repair integration`);
  return value;
}

function requiredConnection(value: Sql | undefined, name: string): Sql {
  if (!value) throw new Error(`${name} connection was not initialized`);
  return value;
}

function databaseString(row: unknown, field: string): string {
  if (typeof row !== "object" || row === null) throw new Error(`invalid ${field} row`);
  const value = (row as Readonly<Record<string, unknown>>)[field];
  if (typeof value !== "string") throw new Error(`invalid ${field} value`);
  return value;
}

function requiredAuditRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) throw new Error("invalid audit row");
  return value as Readonly<Record<string, unknown>>;
}

function requiredAuditJson(row: Readonly<Record<string, unknown>>, field: string): AuditJsonValue {
  const value = row[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${field} value`);
  }
  return value as AuditJsonValue;
}

function databaseInstant(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field];
  if (!(value instanceof Date)) throw new Error(`invalid ${field} value`);
  return value.toISOString();
}
