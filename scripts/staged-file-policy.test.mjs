import { describe, expect, it } from "vitest";

import { stagedPathPolicyError, stagedTextPolicyErrors } from "./staged-file-policy.mjs";

describe("staged file safety policy", () => {
  it.each([
    ".env",
    ".env.production",
    "customer-data/export.csv",
    "fixtures/real/ledger.json",
    "packages/example/production_data/payload.json",
    "exports/ledger.csv",
    "backups/database.dump",
    "config/private.key",
  ])("rejects sensitive path %s", (path) => {
    expect(stagedPathPolicyError(path)).toBeDefined();
  });

  it.each([
    ".env.example",
    "apps/web/src/app/api/recon/exports/exceptions/route.ts",
    "packages/database/src/backup-policy.ts",
    "docs/exports.md",
  ])("allows product source path %s", (path) => {
    expect(stagedPathPolicyError(path)).toBeUndefined();
  });

  it("rejects private keys and production-token shapes", () => {
    const privateKeyHeader = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    expect(
      stagedTextPolicyErrors(`${privateKeyHeader}\nsynthetic\n-----END PRIVATE KEY-----`),
    ).toContain("private key material detected");
    expect(stagedTextPolicyErrors(`token=${"sk_live_"}${"a".repeat(24)}`)).toContain(
      "likely production token detected",
    );
    expect(stagedTextPolicyErrors("ordinary source text")).toEqual([]);
  });
});
