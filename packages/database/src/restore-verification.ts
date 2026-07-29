import { createHash } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";

const publicSchema = "public";
const tableNamePattern = /^[a-z0-9_]+$/u;

export interface RestoreTableSnapshot {
  readonly name: string;
  readonly rows: number;
  readonly sha256: string;
}

export interface RestoreSnapshotCounts {
  readonly tables: number;
  readonly rows: number;
  readonly columns: number;
  readonly constraints: number;
  readonly policies: number;
  readonly indexes: number;
  readonly triggers: number;
  readonly functions: number;
  readonly rlsEnabled: number;
  readonly rlsForced: number;
  readonly grants: number;
}

export interface RestoreSnapshotDigests {
  readonly tableData: string;
  readonly columns: string;
  readonly constraints: string;
  readonly policies: string;
  readonly indexes: string;
  readonly triggers: string;
  readonly functions: string;
  readonly rls: string;
  readonly grants: string;
}

export interface DatabaseRestoreSnapshot {
  readonly serverVersion: string;
  readonly systemIdentifier: string;
  readonly dataChecksums: "on" | "off";
  readonly tables: readonly RestoreTableSnapshot[];
  readonly counts: RestoreSnapshotCounts;
  readonly digests: RestoreSnapshotDigests;
}

export interface RestoreSnapshotComparison {
  readonly matches: boolean;
  readonly mismatches: readonly string[];
}

/**
 * Captures a metadata-only logical fingerprint from one serializable, read-only, deferrable
 * snapshot. Table contents are streamed through SHA-256 and are never returned to the caller.
 *
 * This intentionally scans every public table. Run it only against an approved isolated source
 * snapshot and restored copy with capacity/time bounds appropriate to their size.
 */
export async function captureDatabaseRestoreSnapshot(sql: Sql): Promise<DatabaseRestoreSnapshot> {
  return sql.begin("isolation level serializable read only deferrable", async (transaction) =>
    captureSnapshotInTransaction(transaction),
  );
}

export function compareDatabaseRestoreSnapshots(
  source: DatabaseRestoreSnapshot,
  restored: DatabaseRestoreSnapshot,
): RestoreSnapshotComparison {
  const mismatches: string[] = [];
  if (source.systemIdentifier === restored.systemIdentifier) {
    mismatches.push("restored cluster must have a different PostgreSQL system identifier");
  }
  if (source.serverVersion !== restored.serverVersion) {
    mismatches.push("PostgreSQL server versions differ");
  }
  if (restored.dataChecksums !== "on") {
    mismatches.push("restored cluster data checksums are not enabled");
  }
  compareRecord("counts", source.counts, restored.counts, mismatches);
  compareRecord("digests", source.digests, restored.digests, mismatches);
  if (JSON.stringify(source.tables) !== JSON.stringify(restored.tables)) {
    mismatches.push("public table row counts or content digests differ");
  }
  return { matches: mismatches.length === 0, mismatches };
}

async function captureSnapshotInTransaction(sql: TransactionSql): Promise<DatabaseRestoreSnapshot> {
  const tableRows = await sql<{ readonly table_name: string }[]>`
    select table_name
    from information_schema.tables
    where table_schema = ${publicSchema}
      and table_type = 'BASE TABLE'
    order by table_name
  `;
  const tables: RestoreTableSnapshot[] = [];
  for (const row of tableRows) {
    if (!tableNamePattern.test(row.table_name)) {
      throw new Error("restore snapshot encountered an unsafe public table name");
    }
    tables.push(await captureTable(sql, row.table_name));
  }

  const columns = await sql`
    select
      table_name,
      column_name,
      ordinal_position,
      data_type,
      udt_name,
      is_nullable,
      column_default
    from information_schema.columns
    where table_schema = ${publicSchema}
    order by table_name, ordinal_position
  `;
  const constraints = await sql`
    select
      conname,
      contype,
      conrelid::regclass::text as relation,
      pg_get_constraintdef(oid, true) as definition
    from pg_constraint
    where connamespace = ${publicSchema}::regnamespace
    order by relation, conname
  `;
  const policies = await sql`
    select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    from pg_policies
    where schemaname = ${publicSchema}
    order by tablename, policyname
  `;
  const indexes = await sql`
    select tablename, indexname, indexdef
    from pg_indexes
    where schemaname = ${publicSchema}
    order by tablename, indexname
  `;
  const triggers = await sql`
    select
      relations.relname as table_name,
      triggers.tgname,
      pg_get_triggerdef(triggers.oid, true) as definition
    from pg_trigger triggers
    join pg_class relations on relations.oid = triggers.tgrelid
    join pg_namespace namespaces on namespaces.oid = relations.relnamespace
    where namespaces.nspname = ${publicSchema}
      and not triggers.tgisinternal
    order by relations.relname, triggers.tgname
  `;
  const functions = await sql`
    select
      functions.proname,
      pg_get_function_identity_arguments(functions.oid) as arguments,
      pg_get_functiondef(functions.oid) as definition
    from pg_proc functions
    join pg_namespace namespaces on namespaces.oid = functions.pronamespace
    where namespaces.nspname = ${publicSchema}
    order by functions.proname, arguments
  `;
  const rls = await sql<
    {
      readonly relname: string;
      readonly relrowsecurity: boolean;
      readonly relforcerowsecurity: boolean;
    }[]
  >`
    select relname, relrowsecurity, relforcerowsecurity
    from pg_class
    where relnamespace = ${publicSchema}::regnamespace
      and relkind = 'r'
    order by relname
  `;
  const grants = await sql`
    select grantee, table_name, privilege_type, is_grantable
    from information_schema.role_table_grants
    where table_schema = ${publicSchema}
      and grantee in ('reconai_app', 'reconai_worker', 'reconai_migrator')
    order by grantee, table_name, privilege_type
  `;
  const version = requiredStringRow(await sql`show server_version`, "server_version");
  const systemIdentifier = requiredStringRow(
    await sql`select system_identifier::text from pg_control_system()`,
    "system_identifier",
  );
  const dataChecksums = requiredChecksumSetting(
    requiredStringRow(await sql`show data_checksums`, "data_checksums"),
  );

  return {
    serverVersion: version,
    systemIdentifier,
    dataChecksums,
    tables,
    counts: {
      tables: tables.length,
      rows: tables.reduce((sum, table) => sum + table.rows, 0),
      columns: columns.length,
      constraints: constraints.length,
      policies: policies.length,
      indexes: indexes.length,
      triggers: triggers.length,
      functions: functions.length,
      rlsEnabled: rls.filter((row) => row.relrowsecurity).length,
      rlsForced: rls.filter((row) => row.relforcerowsecurity).length,
      grants: grants.length,
    },
    digests: {
      tableData: digestStrings(tables.map((table) => JSON.stringify(table))),
      columns: digestRows(columns),
      constraints: digestRows(constraints),
      policies: digestRows(policies),
      indexes: digestRows(indexes),
      triggers: digestRows(triggers),
      functions: digestRows(functions),
      rls: digestRows(rls),
      grants: digestRows(grants),
    },
  };
}

async function captureTable(sql: TransactionSql, tableName: string): Promise<RestoreTableSnapshot> {
  const digest = createHash("sha256");
  let rows = 0;
  const query = sql.unsafe<{ readonly value: string }[]>(
    `select row_to_json(row_data)::text as value
       from (select * from public."${tableName}") row_data
      order by row_to_json(row_data)::text collate "C"`,
  );
  for await (const batch of query.cursor(500)) {
    for (const row of batch) {
      if (rows > 0) digest.update("\n");
      digest.update(row.value);
      rows += 1;
    }
  }
  return { name: tableName, rows, sha256: digest.digest("hex") };
}

function digestRows(rows: readonly Readonly<Record<string, unknown>>[]): string {
  return digestStrings(rows.map((row) => JSON.stringify(row)));
}

function digestStrings(values: readonly string[]): string {
  return createHash("sha256").update(values.join("\n")).digest("hex");
}

function requiredStringRow(rows: readonly unknown[], field: string): string {
  const row = rows[0];
  if (typeof row !== "object" || row === null) {
    throw new Error(`restore snapshot did not return ${field}`);
  }
  const value = (row as Readonly<Record<string, unknown>>)[field];
  if (typeof value !== "string") throw new Error(`restore snapshot ${field} was not text`);
  return value;
}

function requiredChecksumSetting(value: string): "on" | "off" {
  if (value === "on" || value === "off") return value;
  throw new Error("restore snapshot returned an unexpected data_checksums setting");
}

function compareRecord<T extends object>(
  label: string,
  source: T,
  restored: T,
  mismatches: string[],
): void {
  for (const key of Object.keys(source)) {
    const typedKey = key as keyof T;
    if (source[typedKey] !== restored[typedKey]) mismatches.push(`${label}.${key} differs`);
  }
}
