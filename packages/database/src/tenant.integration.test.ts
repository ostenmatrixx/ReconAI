import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { insertTenantAuditEvent } from "./audit.js";

const organizationA = "10000000-0000-4000-8000-000000000001";
const organizationB = "10000000-0000-4000-8000-000000000002";
const organizationC = "10000000-0000-4000-8000-000000000003";
const userA = "20000000-0000-4000-8000-000000000001";
const userB = "20000000-0000-4000-8000-000000000002";
const userC = "20000000-0000-4000-8000-000000000003";
const membershipA = "30000000-0000-4000-8000-000000000001";
const membershipB = "30000000-0000-4000-8000-000000000002";
const membershipAInB = "30000000-0000-4000-8000-000000000003";
const membershipC = "30000000-0000-4000-8000-000000000004";
const connectionA = "40000000-0000-4000-8000-000000000001";
const connectionCsvA = "40000000-0000-4000-8000-000000000003";
const importA = "45000000-0000-4000-8000-000000000001";
const auditA = "50000000-0000-4000-8000-000000000001";

let admin: Sql | undefined;
let application: Sql | undefined;

describe("live PostgreSQL tenant controls", { concurrent: false }, () => {
  beforeAll(async () => {
    const adminUrl = requiredEnvironment("DATABASE_ADMIN_URL");
    const migrationUrl = requiredEnvironment("DATABASE_MIGRATION_URL");
    const applicationUrl = requiredEnvironment("DATABASE_URL");

    const adminConnection = postgres(adminUrl, { max: 1 });
    admin = adminConnection;
    await ensureLocalTestRoles(adminConnection);
    execFileSync("pnpm", ["--filter", "@workspace/database", "db:migrate"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl },
      stdio: "pipe",
    });
    await seedTenants(adminConnection);
    application = postgres(applicationUrl, { max: 4 });
  });

  afterAll(async () => {
    await application?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
  });

  it("shows only the selected organization and its member identities", async () => {
    const database = requiredConnection(application, "application");
    const result = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationA}, true)`;
      const organizations = await transaction`select id from organizations order by id`;
      const users = await transaction`select id, email from users order by id`;
      return { organizations, users };
    });

    expect(Array.from(result.organizations, (row: unknown) => databaseString(row, "id"))).toEqual([
      organizationA,
    ]);
    expect(Array.from(result.users, (row: unknown) => databaseString(row, "id"))).toEqual([userA]);
    expect(Array.from(result.users, (row: unknown) => databaseString(row, "email"))).toEqual([
      "operator-a@example.test",
    ]);
  });

  it("paginates and searches active organizations for only the verified external identity", async () => {
    const database = requiredConnection(application, "application");
    const firstPage = await database`
      select organization_id, organization_name, organization_sort_name, membership_id, membership_role
      from reconai_list_active_organization_page(
        'https://issuer.example.test',
        'operator-a',
        null,
        null,
        null,
        null,
        1
      )
    `;
    expect(firstPage).toHaveLength(1);
    expect(databaseString(firstPage[0], "organization_id")).toBe(organizationA);
    const secondPage = await database`
      select organization_id, organization_name, organization_sort_name, membership_id, membership_role
      from reconai_list_active_organization_page(
        'https://issuer.example.test',
        'operator-a',
        null,
        null,
        ${databaseString(firstPage[0], "organization_sort_name")},
        ${databaseString(firstPage[0], "organization_id")}::uuid,
        2
      )
    `;
    expect(
      Array.from([...firstPage, ...secondPage], (row: unknown) => ({
        organizationId: databaseString(row, "organization_id"),
        organizationName: databaseString(row, "organization_name"),
        membershipId: databaseString(row, "membership_id"),
        role: databaseString(row, "membership_role"),
      })),
    ).toEqual([
      {
        organizationId: organizationA,
        organizationName: "Integration Tenant A",
        membershipId: membershipA,
        role: "analyst",
      },
      {
        organizationId: organizationB,
        organizationName: "Integration Tenant B",
        membershipId: membershipAInB,
        role: "reviewer",
      },
    ]);

    const literalSearch = await database`
      select organization_id
      from reconai_list_active_organization_page(
        'https://issuer.example.test',
        'operator-a',
        'Tenant B',
        null,
        null,
        null,
        101
      )
    `;
    expect(literalSearch).toHaveLength(1);
    expect(databaseString(literalSearch[0], "organization_id")).toBe(organizationB);

    const escapedWildcards = await database`
      select organization_id
      from reconai_list_active_organization_page(
        'https://issuer.example.test',
        'operator-a',
        '%_',
        null,
        null,
        null,
        101
      )
    `;
    expect(escapedWildcards).toHaveLength(0);

    const exact = await database`
      select organization_id
      from reconai_list_active_organization_page(
        'https://issuer.example.test',
        'operator-a',
        null,
        ${organizationB}::uuid,
        null,
        null,
        2
      )
    `;
    expect(exact).toHaveLength(1);
    expect(databaseString(exact[0], "organization_id")).toBe(organizationB);

    const crossIdentityExact = await database`
      select organization_id
      from reconai_list_active_organization_page(
        'https://issuer.example.test',
        'operator-b',
        null,
        ${organizationA}::uuid,
        null,
        null,
        2
      )
    `;
    expect(crossIdentityExact).toHaveLength(0);

    const unknown = await database`
      select organization_id
      from reconai_list_active_organization_page(
        'https://issuer.example.test',
        'unknown-operator',
        null,
        null,
        null,
        null,
        101
      )
    `;
    expect(unknown).toHaveLength(0);
  });

  it("keeps exact authority current while rename and membership changes make browsing non-snapshot", async () => {
    const database = requiredConnection(application, "application");
    const adminDatabase = requiredConnection(admin, "admin");
    const firstPage = await database`
      select organization_id, organization_sort_name
      from reconai_list_active_organization_page(
        'https://issuer.example.test',
        'operator-a',
        null,
        null,
        null,
        null,
        1
      )
    `;
    expect(firstPage).toHaveLength(1);
    expect(databaseString(firstPage[0], "organization_id")).toBe(organizationA);
    const afterName = databaseString(firstPage[0], "organization_sort_name");

    try {
      await adminDatabase`
        update organizations
        set name = 'Aardvark Concurrent Tenant', updated_at = now()
        where id = ${organizationB}
      `;
      const pageAfterRename = await database`
        select organization_id
        from reconai_list_active_organization_page(
          'https://issuer.example.test',
          'operator-a',
          null,
          null,
          ${afterName},
          ${organizationA}::uuid,
          2
        )
      `;
      expect(pageAfterRename).toHaveLength(0);
      const exactAfterRename = await database`
        select organization_id, organization_name
        from reconai_list_active_organization_page(
          'https://issuer.example.test',
          'operator-a',
          null,
          ${organizationB}::uuid,
          null,
          null,
          2
        )
      `;
      expect(exactAfterRename).toHaveLength(1);
      expect(databaseString(exactAfterRename[0], "organization_id")).toBe(organizationB);
      expect(databaseString(exactAfterRename[0], "organization_name")).toBe(
        "Aardvark Concurrent Tenant",
      );
    } finally {
      await adminDatabase`
        update organizations
        set name = 'Integration Tenant B', updated_at = now()
        where id = ${organizationB}
      `;
    }

    try {
      await adminDatabase`
        update memberships
        set status = 'deactivated', updated_at = now()
        where id = ${membershipAInB}
      `;
      const pageAfterDeactivation = await database`
        select organization_id
        from reconai_list_active_organization_page(
          'https://issuer.example.test',
          'operator-a',
          null,
          null,
          ${afterName},
          ${organizationA}::uuid,
          2
        )
      `;
      expect(pageAfterDeactivation).toHaveLength(0);
      const exactAfterDeactivation = await database`
        select organization_id
        from reconai_list_active_organization_page(
          'https://issuer.example.test',
          'operator-a',
          null,
          ${organizationB}::uuid,
          null,
          null,
          2
        )
      `;
      expect(exactAfterDeactivation).toHaveLength(0);
    } finally {
      await adminDatabase`
        update memberships
        set status = 'active', updated_at = now()
        where id = ${membershipAInB}
      `;
    }

    const exactAfterReactivation = await database`
      select organization_id, membership_role
      from reconai_list_active_organization_page(
        'https://issuer.example.test',
        'operator-a',
        null,
        ${organizationB}::uuid,
        null,
        null,
        2
      )
    `;
    expect(exactAfterReactivation).toHaveLength(1);
    expect(databaseString(exactAfterReactivation[0], "organization_id")).toBe(organizationB);
    expect(databaseString(exactAfterReactivation[0], "membership_role")).toBe("reviewer");
  });

  it("atomically bootstraps only a verified identity first owner membership with replay safety", async () => {
    const database = requiredConnection(application, "application");
    const invalidTimeZone = await database`
      select bootstrap_status
      from reconai_bootstrap_first_organization(
        'https://issuer.example.test',
        'invalid-time-zone-owner',
        'invalid-time-zone-owner@example.test',
        '10000000-0000-4000-8000-000000000094',
        '30000000-0000-4000-8000-000000000094',
        '35000000-0000-4000-8000-000000000094',
        '35000000-0000-4000-8000-000000000093',
        ${"c".repeat(64)},
        'Invalid Time Zone Tenant',
        'Not/A_Time_Zone',
        '20000000-0000-4000-8000-000000000094'
      )
    `;
    expect(invalidTimeZone).toEqual([{ bootstrap_status: "invalid" }]);

    const requestId = "35000000-0000-4000-8000-000000000001";
    const idempotencyKey = "35000000-0000-4000-8000-000000000002";
    const inputHash = "d".repeat(64);
    const created = await database`
      select *
      from reconai_bootstrap_first_organization(
        'https://issuer.example.test',
        'bootstrap-owner',
        'bootstrap-owner@example.test',
        ${organizationC}::uuid,
        ${membershipC}::uuid,
        ${requestId}::uuid,
        ${idempotencyKey}::uuid,
        ${inputHash},
        'Bootstrap Tenant',
        'Asia/Manila',
        ${userC}::uuid
      )
    `;
    expect(created).toMatchObject([
      {
        bootstrap_status: "created",
        organization_id: organizationC,
        organization_name: "Bootstrap Tenant",
        business_time_zone: "Asia/Manila",
        membership_id: membershipC,
        user_id: userC,
        membership_role: "owner",
      },
    ]);

    const replayed = await database`
      select *
      from reconai_bootstrap_first_organization(
        'https://issuer.example.test',
        'bootstrap-owner',
        'bootstrap-owner@example.test',
        '10000000-0000-4000-8000-000000000099',
        '30000000-0000-4000-8000-000000000099',
        '35000000-0000-4000-8000-000000000099',
        ${idempotencyKey}::uuid,
        ${inputHash},
        'Bootstrap Tenant',
        'Asia/Manila',
        '20000000-0000-4000-8000-000000000099'
      )
    `;
    expect(replayed).toMatchObject([
      {
        bootstrap_status: "replayed",
        organization_id: organizationC,
        membership_id: membershipC,
        user_id: userC,
        membership_role: "owner",
      },
    ]);

    const conflictingReplay = await database`
      select bootstrap_status
      from reconai_bootstrap_first_organization(
        'https://issuer.example.test',
        'bootstrap-owner',
        'bootstrap-owner@example.test',
        '10000000-0000-4000-8000-000000000098',
        '30000000-0000-4000-8000-000000000098',
        '35000000-0000-4000-8000-000000000098',
        ${idempotencyKey}::uuid,
        ${"e".repeat(64)},
        'Changed Tenant',
        'UTC',
        '20000000-0000-4000-8000-000000000098'
      )
    `;
    expect(conflictingReplay).toEqual([{ bootstrap_status: "idempotency_conflict" }]);

    const secondOrganization = await database`
      select bootstrap_status
      from reconai_bootstrap_first_organization(
        'https://issuer.example.test',
        'bootstrap-owner',
        'bootstrap-owner@example.test',
        '10000000-0000-4000-8000-000000000097',
        '30000000-0000-4000-8000-000000000097',
        '35000000-0000-4000-8000-000000000097',
        '35000000-0000-4000-8000-000000000096',
        ${inputHash},
        'Second Tenant',
        'UTC',
        '20000000-0000-4000-8000-000000000097'
      )
    `;
    expect(secondOrganization).toEqual([{ bootstrap_status: "not_eligible" }]);

    await expect(database`select * from organization_bootstrap_requests`).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("serializes concurrent exact bootstrap retries into one organization", async () => {
    const database = requiredConnection(application, "application");
    const inputHash = "b".repeat(64);
    const idempotencyKey = "35000000-0000-4000-8000-000000000092";
    const first = database`
      select *
      from reconai_bootstrap_first_organization(
        'https://issuer.example.test',
        'concurrent-bootstrap-owner',
        'concurrent-bootstrap-owner@example.test',
        '10000000-0000-4000-8000-000000000091',
        '30000000-0000-4000-8000-000000000091',
        '35000000-0000-4000-8000-000000000091',
        ${idempotencyKey}::uuid,
        ${inputHash},
        'Concurrent Bootstrap Tenant',
        'UTC',
        '20000000-0000-4000-8000-000000000091'
      )
    `;
    const second = database`
      select *
      from reconai_bootstrap_first_organization(
        'https://issuer.example.test',
        'concurrent-bootstrap-owner',
        'concurrent-bootstrap-owner@example.test',
        '10000000-0000-4000-8000-000000000090',
        '30000000-0000-4000-8000-000000000090',
        '35000000-0000-4000-8000-000000000090',
        ${idempotencyKey}::uuid,
        ${inputHash},
        'Concurrent Bootstrap Tenant',
        'UTC',
        '20000000-0000-4000-8000-000000000090'
      )
    `;

    const outcomes = await Promise.all([first, second]);
    expect(
      outcomes
        .map((rows) => databaseString(rows[0], "bootstrap_status"))
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(["created", "replayed"]);
    const organizationIds = outcomes.map((rows) => databaseString(rows[0], "organization_id"));
    const membershipIds = outcomes.map((rows) => databaseString(rows[0], "membership_id"));
    const userIds = outcomes.map((rows) => databaseString(rows[0], "user_id"));
    expect(new Set(organizationIds).size).toBe(1);
    expect(new Set(membershipIds).size).toBe(1);
    expect(new Set(userIds).size).toBe(1);
    expect([
      "10000000-0000-4000-8000-000000000090",
      "10000000-0000-4000-8000-000000000091",
    ]).toContain(organizationIds[0]);
  });

  it("allows same-tenant writes and rejects a forged organization", async () => {
    const database = requiredConnection(application, "application");
    await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationA}, true)`;
      await transaction`
        insert into data_source_connections (
          id, organization_id, provider, external_account_id, status, connector_version
        ) values (
          ${connectionA}, ${organizationA}, 'shopify', 'integration-account-a', 'healthy', '1.0.0'
        )
        on conflict (organization_id, id) do nothing
      `;
      await transaction`
        insert into data_source_connections (
          id, organization_id, provider, external_account_id, status, connector_version
        ) values (
          ${connectionCsvA}, ${organizationA}, 'accounting_csv',
          'integration-ledger-a', 'healthy', '1.0.0'
        )
        on conflict (organization_id, id) do nothing
      `;
      await transaction`
        insert into imports (
          id, organization_id, connection_id, source, object_key, payload_sha256, byte_count,
          content_type, original_filename, template_version, mapping_version, mapping, status,
          idempotency_key, row_count, valid_row_count, invalid_row_count, preview_rows,
          preview_errors, uploaded_by, uploaded_at
        ) values (
          ${importA}, ${organizationA}, ${connectionCsvA}, 'accounting_csv',
          'test/10000000-0000-4000-8000-000000000001/imports/45000000-0000-4000-8000-000000000001/payload.csv',
          ${"b".repeat(64)}, 128, 'text/csv', 'ledger.csv', 'template-v1', 'mapping-v1',
          ${transaction.json({
            externalId: "id",
            transactionReference: "reference",
            amount: "amount",
            currency: "currency",
            effectiveAt: "effective_at",
            entryType: "type",
          })},
          'previewed', ${"c".repeat(64)}, 1, 1, 0, '[]'::jsonb, '[]'::jsonb,
          ${userA}, now()
        )
        on conflict (organization_id, id) do nothing
      `;
    });

    await expect(
      database.begin(async (transaction) => {
        await transaction`select set_config('app.organization_id', ${organizationA}, true)`;
        await transaction`
          insert into data_source_connections (
            id, organization_id, provider, external_account_id, status, connector_version
          ) values (
            '40000000-0000-4000-8000-000000000002',
            ${organizationB},
            'stripe',
            'forged-cross-tenant-account',
            'healthy',
            '1.0.0'
          )
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("hides import receipts across tenants and requires accounting events to reference one", async () => {
    const database = requiredConnection(application, "application");
    const hidden = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationB}, true)`;
      return transaction`select id from imports where id = ${importA}::uuid`;
    });
    expect(hidden).toHaveLength(0);

    const administrator = requiredConnection(admin, "admin");
    await expect(
      administrator`
        insert into source_events (
          id, organization_id, connection_id, source, external_event_id, external_object_type,
          external_object_id, source_timestamp, received_at, connector_version,
          payload_object_key, payload_sha256, status
        ) values (
          '60000000-0000-4000-8000-000000000002',
          ${organizationA},
          ${connectionCsvA},
          'accounting_csv',
          'csv-without-import',
          'csv_row',
          'entry-1',
          now(),
          now(),
          '1.0.0',
          'synthetic/csv-without-import',
          ${"0".repeat(64)},
          'received'
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects cross-tenant relational references independently of RLS", async () => {
    const database = requiredConnection(admin, "admin");
    await expect(
      database`
        insert into source_events (
          id, organization_id, connection_id, source, external_event_id, external_object_type,
          external_object_id, source_timestamp, received_at, connector_version,
          payload_object_key, payload_sha256, status
        ) values (
          '60000000-0000-4000-8000-000000000001',
          ${organizationB},
          ${connectionA},
          'shopify',
          'cross-tenant-event',
          'order',
          'order-1',
          now(),
          now(),
          '1.0.0',
          'synthetic/cross-tenant-event',
          ${"0".repeat(64)},
          'received'
        )
      `,
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("appends late and same-time audit events to the topological head", async () => {
    const database = requiredConnection(application, "application");
    const firstCorrelationId = randomUUID();
    const secondCorrelationId = randomUUID();
    const lateOccurredAt = "2000-01-01T00:00:00.000Z";

    await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationA}, true)`;
      await insertTenantAuditEvent(transaction, {
        organizationId: organizationA,
        actorType: "user",
        actorId: userA,
        action: "integration.audit_late_first",
        resourceType: "organization",
        resourceId: organizationA,
        correlationId: firstCorrelationId,
        reason: "verify late audit topology",
        newValue: { sequence: 1 },
        versionContext: { hashVersion: 2 },
        occurredAt: lateOccurredAt,
      });
      await insertTenantAuditEvent(transaction, {
        organizationId: organizationA,
        actorType: "user",
        actorId: userA,
        action: "integration.audit_late_second",
        resourceType: "organization",
        resourceId: organizationA,
        correlationId: secondCorrelationId,
        reason: "verify same-time audit topology",
        newValue: { sequence: 2 },
        versionContext: { hashVersion: 2 },
        occurredAt: lateOccurredAt,
      });
    });

    const rows = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationA}, true)`;
      return transaction`
        select correlation_id, previous_event_hash, event_hash, hash_version, occurred_at
        from audit_events
        where correlation_id in (${firstCorrelationId}, ${secondCorrelationId})
      `;
    });
    const first = requiredRowByCorrelation(rows, firstCorrelationId);
    const second = requiredRowByCorrelation(rows, secondCorrelationId);
    expect(databaseString(second, "previous_event_hash")).toBe(databaseString(first, "event_hash"));
    expect(databaseNumber(first, "hash_version")).toBe(2);
    expect(databaseNumber(second, "hash_version")).toBe(2);
    expect(databaseInstant(first, "occurred_at")).toBe(lateOccurredAt);
    expect(databaseInstant(second, "occurred_at")).toBe(lateOccurredAt);
  });

  it("serializes concurrent audit writers into one tenant chain", async () => {
    const database = requiredConnection(application, "application");
    const correlationIds = [randomUUID(), randomUUID()] as const;

    await Promise.all(
      correlationIds.map((correlationId, index) =>
        database.begin(async (transaction) => {
          await transaction`select set_config('app.organization_id', ${organizationA}, true)`;
          await insertTenantAuditEvent(transaction, {
            organizationId: organizationA,
            actorType: "worker",
            actorId: `integration-worker-${String(index + 1)}`,
            action: "integration.audit_concurrent",
            resourceType: "organization",
            resourceId: organizationA,
            correlationId,
            reason: "verify advisory-lock serialization",
            newValue: { writer: index + 1 },
            versionContext: { hashVersion: 2 },
          });
        }),
      ),
    );

    const result = await database.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationA}, true)`;
      const rows = await transaction`
        select correlation_id, previous_event_hash, event_hash
        from audit_events
        where correlation_id in (${correlationIds[0]}, ${correlationIds[1]})
      `;
      const heads = await transaction`
        select candidate.event_hash
        from audit_events candidate
        where candidate.organization_id = ${organizationA}
          and not exists (
            select 1
            from audit_events child
            where child.organization_id = candidate.organization_id
              and child.previous_event_hash = candidate.event_hash
          )
      `;
      return { heads, rows };
    });
    const left = requiredRowByCorrelation(result.rows, correlationIds[0]);
    const right = requiredRowByCorrelation(result.rows, correlationIds[1]);
    const linked =
      databaseString(left, "previous_event_hash") === databaseString(right, "event_hash") ||
      databaseString(right, "previous_event_hash") === databaseString(left, "event_hash");
    expect(linked).toBe(true);
    expect(result.heads).toHaveLength(1);
  });

  it("rejects forks, orphans, duplicate genesis, self-links, and cross-tenant predecessors", async () => {
    const database = requiredConnection(admin, "admin");
    const usedParent = await database`
      select parent.event_hash
      from audit_events parent
      join audit_events child
        on child.organization_id = parent.organization_id
       and child.previous_event_hash = parent.event_hash
      where parent.organization_id = ${organizationA}
      limit 1
    `;
    const parentHash = databaseString(usedParent[0], "event_hash");

    await expect(
      insertRawAuditEvent(database, {
        organizationId: organizationA,
        previousHash: parentHash,
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertRawAuditEvent(database, {
        organizationId: organizationA,
        previousHash: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertRawAuditEvent(database, {
        organizationId: organizationA,
        previousHash: null,
      }),
    ).rejects.toMatchObject({ code: "23514" });

    const selfHash = "c".repeat(64);
    await expect(
      insertRawAuditEvent(database, {
        organizationId: organizationA,
        previousHash: selfHash,
        eventHash: selfHash,
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertRawAuditEvent(database, {
        organizationId: organizationB,
        previousHash: parentHash,
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(insertRawAuditCycle(database, organizationA)).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("prevents audit mutation even for the database owner path", async () => {
    const database = requiredConnection(admin, "admin");
    await expect(
      database`update audit_events set reason = 'tampered' where organization_id = ${organizationA}`,
    ).rejects.toMatchObject({ code: "P0001" });
  });
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required; start the documented PostgreSQL integration environment`);
  }
  return value;
}

async function ensureLocalTestRoles(sql: Sql): Promise<void> {
  const existing = await sql`
    select rolname from pg_roles
    where rolname in ('reconai_migrator', 'reconai_app', 'reconai_worker')
  `;
  const roleNames = new Set(Array.from(existing, (row: unknown) => databaseString(row, "rolname")));
  if (!roleNames.has("reconai_migrator")) {
    await sql.unsafe(
      "create role reconai_migrator login password 'local-migrator-only' nosuperuser nocreatedb nocreaterole noinherit",
    );
  }
  if (!roleNames.has("reconai_app")) {
    await sql.unsafe(
      "create role reconai_app login password 'local-app-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
    );
  }
  if (!roleNames.has("reconai_worker")) {
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
  await sql.unsafe(`
    alter default privileges for role reconai_migrator in schema public
    grant usage, select on sequences to reconai_app
  `);
}

function requiredConnection(value: Sql | undefined, name: string): Sql {
  if (!value) throw new Error(`${name} database connection was not initialized`);
  return value;
}

function databaseString(row: unknown, field: string): string {
  if (typeof row !== "object" || row === null) throw new Error(`database row missing ${field}`);
  const value = (row as Record<string, unknown>)[field];
  if (typeof value !== "string") throw new Error(`database field ${field} was not a string`);
  return value;
}

function databaseNumber(row: unknown, field: string): number {
  if (typeof row !== "object" || row === null) throw new Error(`database row missing ${field}`);
  const value = (row as Record<string, unknown>)[field];
  if (typeof value !== "number") throw new Error(`database field ${field} was not a number`);
  return value;
}

function databaseInstant(row: unknown, field: string): string {
  if (typeof row !== "object" || row === null) throw new Error(`database row missing ${field}`);
  const value = (row as Record<string, unknown>)[field];
  if (!(value instanceof Date)) throw new Error(`database field ${field} was not an instant`);
  return value.toISOString();
}

function requiredRowByCorrelation(rows: readonly unknown[], correlationId: string): unknown {
  const row = rows.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as Record<string, unknown>)["correlation_id"] === correlationId,
  );
  if (!row) throw new Error(`audit row ${correlationId} was not found`);
  return row;
}

interface RawAuditEventInput {
  readonly organizationId: string;
  readonly previousHash: string | null;
  readonly eventHash?: string;
}

async function insertRawAuditEvent(sql: Sql, input: RawAuditEventInput): Promise<void> {
  const eventHash = input.eventHash ?? randomUUID().replaceAll("-", "").padEnd(64, "0");
  await sql`
    insert into audit_events (
      id, organization_id, actor_type, actor_id, action, resource_type, resource_id,
      occurred_at, correlation_id, reason, version_context, previous_event_hash, event_hash,
      hash_version
    ) values (
      ${randomUUID()}, ${input.organizationId}, 'system', 'integration-constraint-test',
      'integration.audit_constraint', 'organization', ${input.organizationId}, now(),
      ${randomUUID()}, 'verify audit topology constraints', '{}'::jsonb, ${input.previousHash},
      ${eventHash}, 1
    )
  `;
}

async function insertRawAuditCycle(sql: Sql, organizationId: string): Promise<void> {
  const leftHash = "d".repeat(64);
  const rightHash = "e".repeat(64);
  await sql`
    insert into audit_events (
      id, organization_id, actor_type, actor_id, action, resource_type, resource_id,
      occurred_at, correlation_id, reason, version_context, previous_event_hash, event_hash,
      hash_version
    ) values (
      ${randomUUID()}, ${organizationId}, 'system', 'integration-cycle-left',
      'integration.audit_cycle', 'organization', ${organizationId}, now(),
      ${randomUUID()}, 'verify multi-row cycle rejection', '{}'::jsonb, ${rightHash}, ${leftHash}, 1
    ), (
      ${randomUUID()}, ${organizationId}, 'system', 'integration-cycle-right',
      'integration.audit_cycle', 'organization', ${organizationId}, now(),
      ${randomUUID()}, 'verify multi-row cycle rejection', '{}'::jsonb, ${leftHash}, ${rightHash}, 1
    )
  `;
}

async function seedTenants(sql: Sql): Promise<void> {
  await sql`
    insert into organizations (id, name) values
      (${organizationA}, 'Integration Tenant A'),
      (${organizationB}, 'Integration Tenant B')
    on conflict (id) do nothing
  `;
  await sql`
    insert into users (id, issuer, subject, email) values
      (${userA}, 'https://issuer.example.test', 'operator-a', 'operator-a@example.test'),
      (${userB}, 'https://issuer.example.test', 'operator-b', 'operator-b@example.test')
    on conflict (id) do nothing
  `;
  await sql`
    insert into memberships (id, organization_id, user_id, role, status) values
      (${membershipA}, ${organizationA}, ${userA}, 'analyst', 'active'),
      (${membershipAInB}, ${organizationB}, ${userA}, 'reviewer', 'active'),
      (${membershipB}, ${organizationB}, ${userB}, 'analyst', 'active')
    on conflict (organization_id, id) do nothing
  `;
  await sql`
    insert into audit_events (
      id, organization_id, actor_type, actor_id, action, resource_type, resource_id,
      occurred_at, correlation_id, reason, version_context, event_hash
    ) values (
      ${auditA},
      ${organizationA},
      'user',
      ${userA},
      'integration.seeded',
      'organization',
      ${organizationA},
      now(),
      '70000000-0000-4000-8000-000000000001',
      'synthetic integration fixture',
      '{}'::jsonb,
      ${"a".repeat(64)}
    )
    on conflict (organization_id, id) do nothing
  `;
}
