import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

import {
  continuousIntegrationSecurityBoundaryErrors,
  containerInstallBoundaryErrors,
  containerRuntimeToolchainBoundaryErrors,
  nodeActiveLtsSecurityPatchError,
  redisSecurityPatchError,
  releaseCandidateScannerBoundaryErrors,
  serviceRuntimeParserBoundaryErrors,
} from "./container-integrity-policy.mjs";

const digestPinnedImagePattern =
  /^(?:(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*):[A-Za-z0-9_][A-Za-z0-9._-]*@sha256:[0-9a-f]{64}$/u;
const actionCommitPattern =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/u;
const approvedImageRepositories = new Set([
  "docker/dockerfile",
  "node",
  "postgres",
  "quay.io/keycloak/keycloak",
  "quay.io/minio/mc",
  "quay.io/minio/minio",
  "redis",
]);
const dockerfiles = ["apps/api/Dockerfile", "apps/worker/Dockerfile", "apps/web/Dockerfile"];
const serviceEntrypoints = [
  { file: "apps/api/src/main.ts", service: "api" },
  { file: "apps/worker/src/main.ts", service: "worker" },
];
const workflowDirectory = ".github/workflows";
const workflowFiles = readdirSync(workflowDirectory)
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .map((file) => join(workflowDirectory, file))
  .sort();
const failures = [];
let composeImageCount = 0;
let workflowImageCount = 0;
let actionCount = 0;

for (const file of dockerfiles) {
  validateDockerfile(file);
}
for (const { file, service } of serviceEntrypoints) {
  const source = readFileSync(file, "utf8");
  for (const error of serviceRuntimeParserBoundaryErrors(source, service)) {
    failures.push(`${file}: ${error}`);
  }
}

const compose = parse(readFileSync("compose.yaml", "utf8"));
for (const [serviceName, service] of Object.entries(compose.services ?? {})) {
  if (typeof service?.image !== "string") {
    failures.push(`compose.yaml: service ${serviceName} must declare an immutable image`);
    continue;
  }
  composeImageCount += 1;
  validateImage(service.image, `compose.yaml: service ${serviceName}`);
}

for (const file of workflowFiles) {
  const source = readFileSync(file, "utf8");
  const workflow = parse(source);
  visitWorkflow(workflow, file);
  validateDockerCommands(workflow, file);
}

validateReleaseCandidateWorkflow();
validateContinuousIntegrationWorkflow();

if (failures.length > 0) {
  process.stderr.write(`Container integrity validation failed:\n${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `Validated ${dockerfiles.length} Dockerfiles, ${composeImageCount} Compose images, ` +
    `${workflowImageCount} workflow images, ${actionCount} action pins, ` +
    `${serviceEntrypoints.length} service configuration boundaries, and the ` +
    "ordinary CI runtime/scanner plus non-publishing release-candidate controls.\n",
);

function validateDockerfile(file) {
  const source = readFileSync(file, "utf8");
  const lines = source.split(/\r?\n/u);
  for (const error of containerInstallBoundaryErrors(source)) {
    failures.push(`${file}: ${error}`);
  }
  for (const error of containerRuntimeToolchainBoundaryErrors(source)) {
    failures.push(`${file}: ${error}`);
  }
  const syntaxMatch = /^# syntax=(\S+)$/u.exec(lines[0] ?? "");
  if (!syntaxMatch) {
    failures.push(`${file}: first line must pin the Dockerfile frontend`);
  } else {
    validateImage(syntaxMatch[1], `${file}: Dockerfile frontend`);
  }

  const localStages = new Set();
  for (const [index, line] of lines.entries()) {
    const fromMatch = /^FROM(?:\s+--platform=\S+)?\s+(\S+)(?:\s+AS\s+([A-Za-z0-9_.-]+))?$/iu.exec(
      line,
    );
    if (!fromMatch) continue;

    const image = fromMatch[1];
    if (image !== "scratch" && !localStages.has(image)) {
      validateImage(image, `${file}:${index + 1}`);
    }
    if (fromMatch[2]) localStages.add(fromMatch[2]);
  }
}

function visitWorkflow(value, file, path = []) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      visitWorkflow(item, file, [...path, String(index)]);
    }
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    const location = `${file}: ${childPath.join(".")}`;
    if (key === "uses" && typeof child === "string") {
      actionCount += 1;
      if (child.startsWith("docker://")) {
        workflowImageCount += 1;
        validateImage(child.slice("docker://".length), location);
      } else if (!child.startsWith("./") && !actionCommitPattern.test(child)) {
        failures.push(`${location} must pin the external action to a full commit SHA`);
      }
    }
    if (key === "image" && typeof child === "string") {
      workflowImageCount += 1;
      validateImage(child, location);
    }
    if (key === "node-version") {
      if (typeof child !== "string") {
        failures.push(`${location} must use an explicit Node Active LTS patch`);
      } else {
        const error = nodeActiveLtsSecurityPatchError(`${child}-bookworm-slim`);
        if (error !== undefined) failures.push(`${location} ${error}`);
      }
    }
    visitWorkflow(child, file, childPath);
  }
}

function validateDockerCommands(value, file, path = []) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      validateDockerCommands(item, file, [...path, String(index)]);
    }
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (key === "run" && typeof child === "string") {
      const collapsed = child.replace(/\\\r?\n/gu, " ");
      const commands = collapsed.matchAll(
        /\bdocker\s+(?:image\s+)?(?:run|pull|create)\s+([^\n;]+)/gu,
      );
      for (const command of commands) {
        const imageCandidates = command[1].match(
          /(?<![A-Za-z0-9._/-])[a-z][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9._-]*(?:@sha256:[0-9a-f]{64})?/gu,
        );
        if (!imageCandidates || imageCandidates.length === 0) {
          failures.push(
            `${file}: ${childPath.join(".")} has a Docker command without a detectable image`,
          );
          continue;
        }
        for (const image of imageCandidates) {
          workflowImageCount += 1;
          validateImage(image, `${file}: ${childPath.join(".")} Docker command`);
        }
      }
    }
    validateDockerCommands(child, file, childPath);
  }
}

function validateReleaseCandidateWorkflow() {
  const file = join(workflowDirectory, "release-candidate.yml");
  const source = readFileSync(file, "utf8");
  const workflow = parse(source);
  for (const error of releaseCandidateScannerBoundaryErrors(source)) {
    failures.push(`${file}: ${error}`);
  }
  const triggers = Object.keys(workflow.on ?? {});
  if (triggers.length !== 1 || triggers[0] !== "workflow_dispatch") {
    failures.push(`${file}: only workflow_dispatch may trigger release-candidate construction`);
  }

  const forbidden = [
    [/\bpackages:\s*write\b/u, "must not grant package publication permission"],
    [/\bdeployments:\s*write\b/u, "must not grant deployment permission"],
    [/\bcontents:\s*write\b/u, "must not grant repository write permission"],
    [/\bpush-to-registry:\s*true\b/u, "must not push attestations to a registry"],
    [/\bpush:\s*true\b/u, "must not push container images"],
    [/docker\/login-action@/u, "must not authenticate to a container registry"],
    [/\bgh\s+release\b/u, "must not create a GitHub release"],
  ];
  for (const [pattern, message] of forbidden) {
    if (pattern.test(source)) failures.push(`${file}: ${message}`);
  }

  const required = [
    [
      /github\.ref == 'refs\/heads\/main'/u,
      "must restrict candidate construction to the main branch",
    ],
    [
      /inputs\.confirmation\s*==\s*'BUILD-NON-PUBLISHING-CANDIDATE'/u,
      "must retain an explicit non-publishing confirmation",
    ],
    [/\bid-token:\s*write\b/u, "must grant OIDC only for keyless attestation"],
    [/\battestations:\s*write\b/u, "must grant attestation persistence"],
    [/\bartifact-metadata:\s*write\b/u, "must grant artifact metadata persistence"],
    [/\boutputs:\s*type=oci,/u, "must export an OCI archive rather than publish an image"],
    [/\bOCI_LAYOUT:\s*\$\{\{ runner\.temp \}\}/u, "must extract OCI scan input outside artifacts"],
    [/\btar -xf "\$\{OCI_ARCHIVE\}" -C "\$\{OCI_LAYOUT\}"/u, "must extract the OCI layout"],
    [
      /\binput:\s*\$\{\{ env\.OCI_LAYOUT \}\}/u,
      "must scan the extracted OCI layout rather than treating its archive as Docker save output",
    ],
    [/\bprovenance:\s*mode=max\b/u, "must generate maximum BuildKit provenance"],
    [/\bsbom:\s*true\b/u, "must generate the BuildKit SBOM attestation"],
    [/\bformat:\s*cyclonedx\b/u, "must generate a portable CycloneDX image SBOM"],
    [/\bseverity:\s*CRITICAL,HIGH\b/u, "must gate on High/Critical image vulnerabilities"],
    [/\bsha256sum\b/u, "must generate a SHA-256 checksum manifest"],
    [/\bsubject-checksums:/u, "must sign provenance over the checksum subjects"],
    [/\bsbom-path:/u, "must sign the image SBOM relationship"],
  ];
  for (const [pattern, message] of required) {
    if (!pattern.test(source)) failures.push(`${file}: ${message}`);
  }
}

function validateContinuousIntegrationWorkflow() {
  const file = join(workflowDirectory, "ci.yml");
  const source = readFileSync(file, "utf8");
  for (const error of continuousIntegrationSecurityBoundaryErrors(source)) {
    failures.push(`${file}: ${error}`);
  }
}

function validateImage(image, location) {
  if (!digestPinnedImagePattern.test(image)) {
    failures.push(
      `${location} must use a human-readable tag plus a lowercase immutable sha256 digest`,
    );
    return;
  }

  const tagSeparator = image.slice(0, image.indexOf("@")).lastIndexOf(":");
  const repository = image.slice(0, tagSeparator);
  if (!approvedImageRepositories.has(repository)) {
    failures.push(`${location} uses unreviewed container repository ${repository}`);
  }
  validateMinimumSecurityPatch(image, repository, tagSeparator, location);
}

function validateMinimumSecurityPatch(image, repository, tagSeparator, location) {
  const tag = image.slice(tagSeparator + 1, image.indexOf("@"));
  const error =
    repository === "redis"
      ? redisSecurityPatchError(tag)
      : repository === "node"
        ? nodeActiveLtsSecurityPatchError(tag)
        : undefined;
  if (error) failures.push(`${location} ${error}`);
}
