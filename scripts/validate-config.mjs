import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const candidates = process.argv.slice(2);
const files =
  candidates.length > 0
    ? candidates
    : [
        "package.json",
        "pnpm-workspace.yaml",
        "lefthook.yml",
        ".secretlintrc.json",
        ".prettierrc.json",
        ".planning/config.json",
      ];

const failures = [];
for (const file of files) {
  if (!/\.(?:json|ya?ml)$/u.test(file)) continue;
  try {
    const text = readFileSync(resolve(file), "utf8");
    const value = file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
    if (value === null || typeof value !== "object") {
      failures.push(`${file}: expected an object or array at the document root`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown parse failure";
    failures.push(`${file}: ${message}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`Configuration validation failed:\n${failures.join("\n")}\n`);
  process.exit(1);
}
