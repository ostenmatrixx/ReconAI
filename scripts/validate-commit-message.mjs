import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  process.stderr.write("Commit message file was not provided.\n");
  process.exit(1);
}

const message = readFileSync(file, "utf8").trim();
const firstLine = message.split(/\r?\n/u)[0] ?? "";
const conventional =
  /^(?:feat|fix|docs|refactor|perf|test|build|ci|chore|revert|security)(?:\([a-z0-9][a-z0-9-]*\))?!?: [a-z0-9][^\r\n]{0,88}$/u;

if (
  message.startsWith("Merge ") ||
  message.startsWith("Revert ") ||
  message.startsWith("fixup! ") ||
  message.startsWith("squash! ")
) {
  process.exit(0);
}

if (!conventional.test(firstLine) || firstLine.endsWith(".")) {
  process.stderr.write(
    [
      "Commit message must use Conventional Commits and an imperative lowercase summary.",
      "Example: feat(reconciliation): detect missing processing fees",
      "Allowed types: feat, fix, docs, refactor, perf, test, build, ci, chore, revert, security",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
