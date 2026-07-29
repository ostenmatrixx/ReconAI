const exactTrivyVersion = "0.72.0";
const supportedSeverities = new Set(["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);

/**
 * @param {string} output
 * @returns {string}
 */
export function parseReviewedTrivyVersion(output) {
  const match = /^Version:\s*v?([0-9]+\.[0-9]+\.[0-9]+)\s*$/mu.exec(output);
  if (!match?.[1]) {
    throw new Error("Trivy version output did not contain one semantic Version field");
  }
  if (match[1] !== exactTrivyVersion) {
    throw new Error(`Trivy ${exactTrivyVersion} is required; received ${match[1]}`);
  }
  return match[1];
}

/**
 * @param {unknown} value
 * @returns {{
 *   schemaVersion: number;
 *   artifactType: string;
 *   resultCount: number;
 *   highCount: number;
 *   criticalCount: number;
 *   fixedFindingCount: number;
 * }}
 */
export function summarizeTrivyVulnerabilityReport(value) {
  if (!isRecord(value)) {
    throw new Error("Trivy vulnerability report must be an object");
  }
  const schemaVersion = requiredPositiveInteger(value["SchemaVersion"], "Trivy schema version");
  const artifactType = requiredString(value["ArtifactType"], "Trivy artifact type");
  if (artifactType !== "container_image") {
    throw new Error(`Trivy artifact type must be container_image; received ${artifactType}`);
  }
  const results = value["Results"];
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error("Trivy vulnerability report must contain at least one scan result");
  }

  let highCount = 0;
  let criticalCount = 0;
  let fixedFindingCount = 0;
  for (const [resultIndex, result] of results.entries()) {
    if (!isRecord(result)) {
      throw new Error(`Trivy result ${resultIndex} must be an object`);
    }
    requiredString(result["Target"], `Trivy result ${resultIndex} target`);
    const vulnerabilities = result["Vulnerabilities"];
    if (vulnerabilities === undefined || vulnerabilities === null) continue;
    if (!Array.isArray(vulnerabilities)) {
      throw new Error(`Trivy result ${resultIndex} vulnerabilities must be an array`);
    }
    for (const [findingIndex, finding] of vulnerabilities.entries()) {
      if (!isRecord(finding)) {
        throw new Error(`Trivy finding ${resultIndex}:${findingIndex} must be an object`);
      }
      requiredString(
        finding["VulnerabilityID"],
        `Trivy finding ${resultIndex}:${findingIndex} identifier`,
      );
      const severity = requiredString(
        finding["Severity"],
        `Trivy finding ${resultIndex}:${findingIndex} severity`,
      ).toUpperCase();
      if (!supportedSeverities.has(severity)) {
        throw new Error(`Trivy finding ${resultIndex}:${findingIndex} has unknown severity`);
      }
      if (severity === "HIGH") highCount += 1;
      if (severity === "CRITICAL") criticalCount += 1;
      if (typeof finding["FixedVersion"] === "string" && finding["FixedVersion"].length > 0) {
        fixedFindingCount += 1;
      }
    }
  }

  return {
    schemaVersion,
    artifactType,
    resultCount: results.length,
    highCount,
    criticalCount,
    fixedFindingCount,
  };
}

/**
 * @param {unknown} value
 * @returns {{
 *   bomFormat: "CycloneDX";
 *   specVersion: string;
 *   componentCount: number;
 *   dependencyCount: number;
 *   vulnerabilityCount: number;
 * }}
 */
export function summarizeCycloneDx(value) {
  if (!isRecord(value) || value["bomFormat"] !== "CycloneDX") {
    throw new Error("image SBOM must be a CycloneDX object");
  }
  const specVersion = requiredString(value["specVersion"], "CycloneDX spec version");
  const components = value["components"];
  const dependencies = value["dependencies"];
  const vulnerabilities = value["vulnerabilities"];
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error("CycloneDX image SBOM must contain components");
  }
  if (!Array.isArray(dependencies)) {
    throw new Error("CycloneDX image SBOM must contain a dependency array");
  }
  if (vulnerabilities !== undefined && !Array.isArray(vulnerabilities)) {
    throw new Error("CycloneDX vulnerabilities must be an array when present");
  }
  for (const [index, component] of components.entries()) {
    if (!isRecord(component)) {
      throw new Error(`CycloneDX component ${index} must be an object`);
    }
    requiredString(component["type"], `CycloneDX component ${index} type`);
    requiredString(component["name"], `CycloneDX component ${index} name`);
  }

  return {
    bomFormat: "CycloneDX",
    specVersion,
    componentCount: components.length,
    dependencyCount: dependencies.length,
    vulnerabilityCount: Array.isArray(vulnerabilities) ? vulnerabilities.length : 0,
  };
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
