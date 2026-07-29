import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = [".github", "apps", "config", "docs", "infra", "packages", "scripts"];
const generatedDirectories = new Set([
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

async function collectSourceFiles(directory) {
  const paths = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!generatedDirectories.has(entry.name)) {
        paths.push(...(await collectSourceFiles(path)));
      }
    } else if (
      entry.isFile() &&
      entry.name !== ".DS_Store" &&
      entry.name !== ".env" &&
      !entry.name.startsWith(".env.") &&
      !entry.name.endsWith(".log") &&
      !entry.name.endsWith(".tsbuildinfo")
    ) {
      paths.push(relative(repositoryRoot, path));
    }
  }

  return paths;
}

const sourcePaths = [];

for (const sourceRoot of sourceRoots) {
  sourcePaths.push(...(await collectSourceFiles(join(repositoryRoot, sourceRoot))));
}

sourcePaths.sort();
const ignoreCheck = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  input: `${sourcePaths.join("\0")}\0`,
});

if (ignoreCheck.error) {
  throw ignoreCheck.error;
}

if (ignoreCheck.status !== 0 && ignoreCheck.status !== 1) {
  throw new Error(`git check-ignore exited with status ${String(ignoreCheck.status)}`);
}

const ignoredSourcePaths = ignoreCheck.stdout.split("\0").filter(Boolean);

if (ignoredSourcePaths.length > 0) {
  process.stderr.write(
    `${ignoredSourcePaths
      .map((path) => `- publishable source is Git-ignored: ${path}`)
      .join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Source-boundary validation passed: ${sourcePaths.length} files across ${sourceRoots.length} roots.\n`,
  );
}
