import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const directory = "packages/database/migrations";
if (!existsSync(directory)) {
  process.stderr.write(`Migration directory is missing: ${directory}\n`);
  process.exit(1);
}

const files = readdirSync(directory)
  .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(file))
  .sort();
const failures = [];
const prefixes = new Set();
const nonTransactionalDirective = "-- reconai:non-transactional\n";
const concurrentIndexStatement =
  /^CREATE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+"[a-z][a-z0-9_]*"\s+ON\s+"[a-z][a-z0-9_]*"\s+\([\s\S]+\)(?:\s+WHERE\s+[\s\S]+)?;\s*$/iu;

for (const file of files) {
  const prefix = file.slice(0, 4);
  if (prefixes.has(prefix)) failures.push(`${file}: duplicate migration sequence ${prefix}`);
  prefixes.add(prefix);

  const sql = readFileSync(join(directory, file), "utf8");
  if (sql.trim().length === 0) failures.push(`${file}: migration is empty`);
  if (/\bDROP\s+DATABASE\b/iu.test(sql) || /\bTRUNCATE\b(?!\s+ON\b)/iu.test(sql)) {
    failures.push(`${file}: broad destructive statement requires an approved exceptional process`);
  }
  const nonTransactional = sql.startsWith(nonTransactionalDirective);
  if (/\bCONCURRENTLY\b/iu.test(sql) && !nonTransactional) {
    failures.push(`${file}: concurrent DDL requires the non-transactional directive`);
  }
  if (nonTransactional) {
    const statement = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .trim();
    if (sql.includes("/*") || !concurrentIndexStatement.test(statement)) {
      failures.push(
        `${file}: non-transactional migrations are restricted to one named restart-safe concurrent index`,
      );
    }
    if ((sql.match(/;/gu) ?? []).length !== 1) {
      failures.push(`${file}: non-transactional migration must contain exactly one SQL statement`);
    }
  }
}

if (files.length === 0) failures.push("no numbered SQL migrations found");

if (failures.length > 0) {
  process.stderr.write(`Migration validation failed:\n${failures.join("\n")}\n`);
  process.exit(1);
}

const digest = createHash("sha256")
  .update(files.map((file) => `${file}\0${readFileSync(join(directory, file), "utf8")}`).join("\0"))
  .digest("hex");
process.stdout.write(`Validated ${files.length} migration(s); sha256=${digest}\n`);
