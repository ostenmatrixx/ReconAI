import { existsSync, readFileSync } from "node:fs";

const required = [
  "packages/domain/src/index.ts",
  "packages/connectors/src/index.ts",
  "packages/reconciliation/src/index.ts",
  "packages/config/src/index.ts",
];

const failures = required
  .filter((file) => !existsSync(file) || !/\bexport\b/u.test(readFileSync(file, "utf8")))
  .map((file) => `${file}: missing or has no exported schema/contract`);

if (failures.length > 0) {
  process.stderr.write(`Generated/contract schema validation failed:\n${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Validated ${required.length} contract entrypoints.\n`);
