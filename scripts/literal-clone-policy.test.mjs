import { describe, expect, it } from "vitest";

import {
  assertSafeTemporaryClonePath,
  canonicalRepositoryUrl,
  expectedNextDevelopmentTypeContents,
  parseLiteralCloneArguments,
  resolveLiteralCloneEvidenceOutput,
  validateExpectedCommit,
  validateLiteralCloneRef,
  validateLiteralCloneRepository,
} from "./literal-clone-policy.mjs";

const commit = "0123456789abcdef0123456789abcdef01234567";
const repositoryRoot = "/workspace/reconai";

describe("literal remote-clone verification policy", () => {
  it("accepts the canonical remote, conservative branch, full commit, and dated evidence path", () => {
    expect(
      parseLiteralCloneArguments(
        [
          "--repository",
          canonicalRepositoryUrl,
          "--ref",
          "codex/foundation-literal-clone",
          "--expected-commit",
          commit,
          "--evidence-output",
          "artifacts/literal-remote-clone-verification-2026-07-30.json",
        ],
        repositoryRoot,
      ),
    ).toEqual({
      repository: canonicalRepositoryUrl,
      ref: "codex/foundation-literal-clone",
      expectedCommit: commit,
      evidenceOutput: {
        outputPath:
          "/workspace/reconai/artifacts/literal-remote-clone-verification-2026-07-30.json",
        relativeOutputPath: "artifacts/literal-remote-clone-verification-2026-07-30.json",
      },
    });
  });

  it("defaults only the canonical remote and requires the revision boundary", () => {
    expect(
      parseLiteralCloneArguments(
        ["--", "--ref", "main", "--expected-commit", commit],
        repositoryRoot,
      ),
    ).toMatchObject({
      repository: canonicalRepositoryUrl,
      ref: "main",
      expectedCommit: commit,
    });
    expect(() => parseLiteralCloneArguments([], repositoryRoot)).toThrow(/--ref is required/u);
    expect(() =>
      parseLiteralCloneArguments(
        ["--ref", "main", "--expected-commit", commit, "--unexpected", "value"],
        repositoryRoot,
      ),
    ).toThrow(/unknown/u);
  });

  it("rejects alternate, credential-bearing, and non-HTTPS remotes", () => {
    for (const repository of [
      "https://github.com/example/ReconAI.git",
      "https://token@github.com/ostenmatrixx/ReconAI.git",
      "git@github.com:ostenmatrixx/ReconAI.git",
      "http://github.com/ostenmatrixx/ReconAI.git",
    ]) {
      expect(() => validateLiteralCloneRepository(repository)).toThrow(/canonical public remote/u);
    }
  });

  it("rejects option-like, ambiguous, and non-full revision values", () => {
    for (const ref of ["--upload-pack=malicious", "feature..branch", "feature//branch", "a@{b}"]) {
      expect(() => validateLiteralCloneRef(ref)).toThrow(/branch name/u);
    }

    expect(() => validateExpectedCommit("01234567")).toThrow(/full lowercase/u);
    expect(() => validateExpectedCommit(commit.toUpperCase())).toThrow(/full lowercase/u);
  });

  it("restricts evidence to the append-only literal-clone artifact name", () => {
    expect(() => resolveLiteralCloneEvidenceOutput(repositoryRoot, "../outside.json")).toThrow(
      /must match/u,
    );
    expect(() =>
      resolveLiteralCloneEvidenceOutput(
        repositoryRoot,
        "artifacts/other-verification-2026-07-30.json",
      ),
    ).toThrow(/must match/u);
  });

  it("allows cleanup only for one direct mkdtemp-style child", () => {
    expect(() =>
      assertSafeTemporaryClonePath("/private/tmp/reconai-literal-clone.ABC123", "/private/tmp"),
    ).not.toThrow();
    expect(() =>
      assertSafeTemporaryClonePath("/private/tmp/reconai-literal-clone.", "/private/tmp"),
    ).toThrow(/refusing/u);
    expect(() =>
      assertSafeTemporaryClonePath(
        "/private/tmp/reconai-literal-clone.ABC123/repository",
        "/private/tmp",
      ),
    ).toThrow(/refusing/u);
    expect(() =>
      assertSafeTemporaryClonePath("/workspace/reconai-literal-clone.ABC123", "/private/tmp"),
    ).toThrow(/refusing/u);
  });

  it("permits only Next.js's exact interim route-type rewrite", () => {
    const production = [
      '/// <reference types="next" />',
      'import "./.next/types/routes.d.ts";',
      "",
    ].join("\n");

    expect(expectedNextDevelopmentTypeContents(production)).toBe(
      production.replace(".next/types/routes.d.ts", ".next/dev/types/routes.d.ts"),
    );
    expect(() =>
      expectedNextDevelopmentTypeContents(
        production.replace(".next/types/routes.d.ts", ".next/other/routes.d.ts"),
      ),
    ).toThrow(/reviewed production form/u);
  });
});
