import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import postgres from "postgres";

const url = process.env["DATABASE_MIGRATION_URL"];
if (!url) throw new Error("DATABASE_MIGRATION_URL is required");

const sql = postgres(url, { max: 1, onnotice: () => undefined });
const directory = resolve(import.meta.dirname, "../migrations");
const migrationLockNamespace = 1_382_330_945;
const migrationLockKey = 1;
const nonTransactionalDirective = "-- reconai:non-transactional\n";
const concurrentIndexStatement =
  /^CREATE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+"([a-z][a-z0-9_]*)"\s+ON\s+"[a-z][a-z0-9_]*"\s+\([\s\S]+\)(?:\s+WHERE\s+[\s\S]+)?;\s*$/iu;
let migrationLockHeld = false;

function concurrentIndexName(contents: string): string {
  const statement = contents
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim();
  const match = concurrentIndexStatement.exec(statement);
  if ((contents.match(/;/gu) ?? []).length !== 1 || contents.includes("/*") || !match?.[1]) {
    throw new Error(
      "non-transactional migrations are restricted to one named CREATE INDEX CONCURRENTLY IF NOT EXISTS statement",
    );
  }
  return match[1];
}

try {
  await sql`
    create table if not exists reconai_schema_migrations (
      version text primary key,
      checksum_sha256 char(64) not null,
      applied_at timestamptz not null default now()
    )
  `;
  await sql`select pg_advisory_lock(${migrationLockNamespace}, ${migrationLockKey})`;
  migrationLockHeld = true;
  const files = (await readdir(directory))
    .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(file))
    .sort();
  for (const file of files) {
    const contents = await readFile(resolve(directory, file), "utf8");
    const checksum = createHash("sha256").update(contents).digest("hex");
    const applied =
      await sql`select checksum_sha256 from reconai_schema_migrations where version = ${file}`;
    if (applied.length > 0) {
      const storedChecksum: unknown = applied[0]?.["checksum_sha256"];
      if (typeof storedChecksum !== "string" || storedChecksum.trim() !== checksum) {
        throw new Error(`applied migration checksum mismatch: ${file}`);
      }
      continue;
    }
    if (contents.startsWith(nonTransactionalDirective)) {
      const indexName = concurrentIndexName(contents);
      await sql.unsafe(contents);
      const indexState = await sql`
        select index_metadata.indisvalid, index_metadata.indisready
        from pg_catalog.pg_class as index_relation
        inner join pg_catalog.pg_namespace as index_namespace
          on index_namespace.oid = index_relation.relnamespace
        inner join pg_catalog.pg_index as index_metadata
          on index_metadata.indexrelid = index_relation.oid
        where index_namespace.nspname = 'public'
          and index_relation.relname = ${indexName}
      `;
      const [state] = indexState;
      if (
        indexState.length !== 1 ||
        state?.["indisvalid"] !== true ||
        state["indisready"] !== true
      ) {
        throw new Error(
          `concurrent index is not ready and valid; migration remains unapplied: ${file}`,
        );
      }
      await sql`
        insert into reconai_schema_migrations (version, checksum_sha256)
        values (${file}, ${checksum})
      `;
    } else {
      await sql.begin(async (transaction) => {
        await transaction.unsafe(contents);
        await transaction`
          insert into reconai_schema_migrations (version, checksum_sha256)
          values (${file}, ${checksum})
        `;
      });
    }
    process.stdout.write(`Applied ${file}\n`);
  }
} finally {
  if (migrationLockHeld) {
    await sql`select pg_advisory_unlock(${migrationLockNamespace}, ${migrationLockKey})`;
  }
  await sql.end({ timeout: 5 });
}
