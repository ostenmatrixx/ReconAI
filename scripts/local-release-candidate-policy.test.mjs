import { describe, expect, it } from "vitest";

import {
  parseReviewedTrivyVersion,
  summarizeCycloneDx,
  summarizeTrivyVulnerabilityReport,
} from "./local-release-candidate-policy.mjs";

describe("local release candidate evidence policy", () => {
  it("accepts only the reviewed scanner version", () => {
    expect(parseReviewedTrivyVersion("Version: 0.72.0\n")).toBe("0.72.0");
    expect(() => parseReviewedTrivyVersion("Version: 0.69.4\n")).toThrow(/0\.72\.0/u);
    expect(() => parseReviewedTrivyVersion("latest\n")).toThrow(/Version field/u);
  });

  it("summarizes an empty High/Critical image result", () => {
    expect(
      summarizeTrivyVulnerabilityReport({
        SchemaVersion: 2,
        ArtifactType: "container_image",
        Results: [
          {
            Target: "bookworm",
            Vulnerabilities: null,
          },
          {
            Target: "package-lock",
            Vulnerabilities: [],
          },
        ],
      }),
    ).toEqual({
      schemaVersion: 2,
      artifactType: "container_image",
      resultCount: 2,
      highCount: 0,
      criticalCount: 0,
      fixedFindingCount: 0,
    });
  });

  it("retains fixed High and Critical findings for a fail-closed gate", () => {
    expect(
      summarizeTrivyVulnerabilityReport({
        SchemaVersion: 2,
        ArtifactType: "container_image",
        Results: [
          {
            Target: "bookworm",
            Vulnerabilities: [
              {
                VulnerabilityID: "CVE-SYNTHETIC-HIGH",
                Severity: "HIGH",
                FixedVersion: "1.2.3",
              },
              {
                VulnerabilityID: "CVE-SYNTHETIC-CRITICAL",
                Severity: "CRITICAL",
                FixedVersion: "4.5.6",
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      highCount: 1,
      criticalCount: 1,
      fixedFindingCount: 2,
    });
  });

  it("rejects malformed or non-image scanner output", () => {
    expect(() => summarizeTrivyVulnerabilityReport({})).toThrow(/schema version/u);
    expect(() =>
      summarizeTrivyVulnerabilityReport({
        SchemaVersion: 2,
        ArtifactType: "filesystem",
        Results: [{ Target: "source" }],
      }),
    ).toThrow(/container_image/u);
    expect(() =>
      summarizeTrivyVulnerabilityReport({
        SchemaVersion: 2,
        ArtifactType: "container_image",
        Results: [],
      }),
    ).toThrow(/at least one/u);
  });

  it("requires a populated CycloneDX component and dependency graph", () => {
    expect(
      summarizeCycloneDx({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        components: [{ type: "library", name: "synthetic" }],
        dependencies: [{ ref: "synthetic", dependsOn: [] }],
        vulnerabilities: [],
      }),
    ).toEqual({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      componentCount: 1,
      dependencyCount: 1,
      vulnerabilityCount: 0,
    });
    expect(() =>
      summarizeCycloneDx({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        components: [],
        dependencies: [],
      }),
    ).toThrow(/components/u);
  });
});
