import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { stagedPathPolicyError, stagedTextPolicyErrors } from "./staged-file-policy.mjs";

const output = execFileSync(
  "git",
  ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
  { encoding: "utf8" },
);
const paths = output.split("\0").filter(Boolean);
const failures = [];

for (const path of paths) {
  const pathError = stagedPathPolicyError(path);
  if (pathError) failures.push(`${path}: ${pathError}`);

  try {
    const content = readFileSync(path, "utf8");
    for (const contentError of stagedTextPolicyErrors(content)) {
      failures.push(`${path}: ${contentError}`);
    }
  } catch {
    // Binary and deleted files are checked by path; the dedicated scanner handles text secrets.
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Commit blocked by repository safety policy:\n${failures.map((item) => `- ${item}`).join("\n")}\n`,
  );
  process.exit(1);
}
