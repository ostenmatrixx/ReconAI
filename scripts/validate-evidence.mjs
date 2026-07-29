import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDirectory = join(repositoryRoot, "artifacts");
const maximumArtifactBytes = 512 * 1024;
const maximumTotalBytes = 5 * 1024 * 1024;
const datedJsonPattern = /^[a-z0-9][a-z0-9.-]*-\d{4}-\d{2}-\d{2}\.json$/u;
const datedTranscriptPattern = /^local-verification-\d{4}-\d{2}-\d{2}\.md$/u;
const pendingEvidencePath = process.env.RECONAI_PENDING_EVIDENCE_PATH;
const pendingEvidencePattern =
  /^artifacts\/[a-z0-9][a-z0-9.-]*-verification-\d{4}-\d{2}-\d{2}\.json$/u;
const absolutePersonalPathPatterns = [
  /\/Users\/[^/\s"]+/u,
  /\/home\/[^/\s"]+/u,
  /[A-Za-z]:\\Users\\[^\\\s"]+/u,
];

async function collectMarkdownFiles(directory) {
  const paths = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      paths.push(...(await collectMarkdownFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      paths.push(path);
    }
  }

  return paths;
}

const failures = [];

if (pendingEvidencePath && !pendingEvidencePattern.test(pendingEvidencePath)) {
  failures.push(
    "RECONAI_PENDING_EVIDENCE_PATH must name one dated artifacts/*-verification-YYYY-MM-DD.json file",
  );
}

const artifactEntries = await readdir(artifactDirectory, { withFileTypes: true });
const artifactNames = new Set();
let totalBytes = 0;

for (const entry of artifactEntries) {
  if (!entry.isFile()) {
    failures.push(`artifacts/${entry.name} must be a regular file`);
    continue;
  }

  const allowed =
    entry.name === ".gitkeep" ||
    entry.name === "README.md" ||
    entry.name === "sbom.cdx.json" ||
    datedJsonPattern.test(entry.name) ||
    datedTranscriptPattern.test(entry.name);

  if (!allowed) {
    failures.push(`artifacts/${entry.name} does not follow the bounded evidence naming policy`);
    continue;
  }

  artifactNames.add(entry.name);
  const artifactPath = join(artifactDirectory, entry.name);
  const artifactStat = await stat(artifactPath);
  totalBytes += artifactStat.size;

  if (artifactStat.size > maximumArtifactBytes) {
    failures.push(
      `artifacts/${entry.name} is ${artifactStat.size} bytes; maximum is ${maximumArtifactBytes}`,
    );
  }

  if (entry.name === ".gitkeep") {
    continue;
  }

  const contents = await readFile(artifactPath, "utf8");

  for (const pattern of absolutePersonalPathPatterns) {
    if (pattern.test(contents)) {
      failures.push(`artifacts/${entry.name} contains an absolute personal home-directory path`);
      break;
    }
  }

  if (entry.name.endsWith(".json")) {
    try {
      JSON.parse(contents);
    } catch (error) {
      failures.push(
        `artifacts/${entry.name} is not valid JSON: ${
          error instanceof Error ? error.message : "unknown parse error"
        }`,
      );
    }
  }
}

if (totalBytes > maximumTotalBytes) {
  failures.push(`artifact total is ${totalBytes} bytes; maximum is ${maximumTotalBytes}`);
}

const documentationPaths = [
  join(repositoryRoot, "README.md"),
  join(repositoryRoot, "GOALS.md"),
  ...(await collectMarkdownFiles(join(repositoryRoot, "docs"))),
];
const artifactReferencePattern = /artifacts\/([A-Za-z0-9._-]+\.(?:json|md))/gu;

for (const documentationPath of documentationPaths) {
  const contents = await readFile(documentationPath, "utf8");

  for (const match of contents.matchAll(artifactReferencePattern)) {
    const artifactName = match[1];

    if (
      artifactName &&
      !artifactNames.has(artifactName) &&
      `artifacts/${artifactName}` !== pendingEvidencePath
    ) {
      failures.push(
        `${relative(repositoryRoot, documentationPath)} references missing artifacts/${artifactName}`,
      );
    }
  }
}

const publishableArtifactPaths = [...artifactNames]
  .filter((name) => name !== ".gitkeep")
  .map((name) => `artifacts/${name}`)
  .sort();
const ignoreCheck = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  input: `${publishableArtifactPaths.join("\0")}\0`,
});

if (ignoreCheck.error) {
  failures.push(`could not evaluate Git-ignore policy: ${ignoreCheck.error.message}`);
} else if (ignoreCheck.status !== 0 && ignoreCheck.status !== 1) {
  failures.push(`git check-ignore exited with status ${String(ignoreCheck.status)}`);
} else if (ignoreCheck.stdout.length > 0) {
  const ignoredPaths = ignoreCheck.stdout.split("\0").filter(Boolean);
  failures.push(`publishable evidence is Git-ignored: ${ignoredPaths.join(", ")}`);
}

if (failures.length > 0) {
  process.stderr.write(`${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Evidence validation passed: ${artifactNames.size} files, ${totalBytes} bytes, all documentation links resolve.\n`,
  );
}
