import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export const canonicalRepositoryUrl = "https://github.com/ostenmatrixx/ReconAI.git";
export const temporaryClonePrefix = "reconai-literal-clone.";

const evidencePathPattern =
  /^artifacts\/literal-remote-clone-verification-\d{4}-\d{2}-\d{2}\.json$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const conservativeRefPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

function readSingleOption(arguments_, name, { required = false } = {}) {
  const indexes = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === name) indexes.push(index);
  }

  if (indexes.length > 1) {
    throw new Error(`${name} may be provided only once`);
  }

  if (indexes.length === 0) {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }

  const value = arguments_[indexes[0] + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

export function validateLiteralCloneRepository(value) {
  if (value !== canonicalRepositoryUrl) {
    throw new Error(
      `--repository must be the reviewed canonical public remote ${canonicalRepositoryUrl}`,
    );
  }

  return value;
}

export function validateLiteralCloneRef(value) {
  if (
    !conservativeRefPattern.test(value) ||
    value.startsWith("-") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.split("/").some((part) => part === "." || part.length === 0)
  ) {
    throw new Error("--ref must be a conservative, non-option Git branch name");
  }

  return value;
}

export function validateExpectedCommit(value) {
  if (!commitPattern.test(value)) {
    throw new Error("--expected-commit must be one full lowercase 40-character Git commit ID");
  }

  return value;
}

export function resolveLiteralCloneEvidenceOutput(repositoryRoot, value) {
  if (!evidencePathPattern.test(value)) {
    throw new Error(
      "--evidence-output must match artifacts/literal-remote-clone-verification-YYYY-MM-DD.json",
    );
  }

  const outputPath = resolve(repositoryRoot, value);
  const relativeOutputPath = relative(repositoryRoot, outputPath);

  if (
    isAbsolute(relativeOutputPath) ||
    relativeOutputPath.startsWith(`..${sep}`) ||
    relativeOutputPath === ".."
  ) {
    throw new Error("--evidence-output must remain inside the repository");
  }

  return { outputPath, relativeOutputPath };
}

export function parseLiteralCloneArguments(arguments_, repositoryRoot) {
  const normalizedArguments = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const knownOptions = new Set(["--repository", "--ref", "--expected-commit", "--evidence-output"]);

  for (let index = 0; index < normalizedArguments.length; index += 2) {
    const option = normalizedArguments[index];

    if (!option || !knownOptions.has(option)) {
      throw new Error(`unknown or positional argument: ${option ?? "<missing>"}`);
    }

    if (index + 1 >= normalizedArguments.length) {
      throw new Error(`${option} requires a value`);
    }
  }

  const repository = validateLiteralCloneRepository(
    readSingleOption(normalizedArguments, "--repository") ?? canonicalRepositoryUrl,
  );
  const ref = validateLiteralCloneRef(
    readSingleOption(normalizedArguments, "--ref", { required: true }),
  );
  const expectedCommit = validateExpectedCommit(
    readSingleOption(normalizedArguments, "--expected-commit", { required: true }),
  );
  const evidenceValue = readSingleOption(normalizedArguments, "--evidence-output");

  return {
    repository,
    ref,
    expectedCommit,
    evidenceOutput: evidenceValue
      ? resolveLiteralCloneEvidenceOutput(repositoryRoot, evidenceValue)
      : undefined,
  };
}

export function assertSafeTemporaryClonePath(path, temporaryDirectory) {
  const relativePath = relative(temporaryDirectory, path);
  const name = basename(path);

  if (
    !isAbsolute(path) ||
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    relativePath.includes(sep) ||
    !name.startsWith(temporaryClonePrefix) ||
    name.length <= temporaryClonePrefix.length
  ) {
    throw new Error(`refusing to remove unexpected temporary clone path: ${path}`);
  }
}

export function expectedNextDevelopmentTypeContents(originalContents) {
  const productionReference = 'import "./.next/types/routes.d.ts";';
  const developmentReference = 'import "./.next/dev/types/routes.d.ts";';
  const firstIndex = originalContents.indexOf(productionReference);

  if (
    firstIndex === -1 ||
    originalContents.indexOf(productionReference, firstIndex + productionReference.length) !== -1 ||
    originalContents.includes(developmentReference)
  ) {
    throw new Error("tracked Next.js type manifest does not have the reviewed production form");
  }

  return originalContents.replace(productionReference, developmentReference);
}
