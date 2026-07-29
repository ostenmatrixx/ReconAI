import { describe, expect, it } from "vitest";

import {
  compareDatabaseRestoreSnapshots,
  type DatabaseRestoreSnapshot,
} from "./restore-verification.js";

describe("database restore snapshot comparison", () => {
  it("accepts an exact logical restore on a distinct checksummed cluster", () => {
    const source = snapshot();
    const restored = snapshot({ systemIdentifier: "target-system" });

    expect(compareDatabaseRestoreSnapshots(source, restored)).toEqual({
      matches: true,
      mismatches: [],
    });
  });

  it("rejects a same-cluster copy and a restored cluster without data checksums", () => {
    const source = snapshot();
    const restored = snapshot({ dataChecksums: "off" });

    expect(compareDatabaseRestoreSnapshots(source, restored)).toEqual({
      matches: false,
      mismatches: [
        "restored cluster must have a different PostgreSQL system identifier",
        "restored cluster data checksums are not enabled",
      ],
    });
  });

  it("reports data, catalog, count, and server-version differences", () => {
    const source = snapshot();
    const restored = snapshot({
      serverVersion: "18.4",
      systemIdentifier: "target-system",
      tables: [{ name: "organizations", rows: 2, sha256: "different-table-digest" }],
      counts: { ...source.counts, rows: 2 },
      digests: { ...source.digests, policies: "different-policy-digest" },
    });

    expect(compareDatabaseRestoreSnapshots(source, restored)).toEqual({
      matches: false,
      mismatches: [
        "PostgreSQL server versions differ",
        "counts.rows differs",
        "digests.policies differs",
        "public table row counts or content digests differ",
      ],
    });
  });
});

function snapshot(overrides: Partial<DatabaseRestoreSnapshot> = {}): DatabaseRestoreSnapshot {
  return {
    serverVersion: "17.10",
    systemIdentifier: "source-system",
    dataChecksums: "on",
    tables: [{ name: "organizations", rows: 1, sha256: "table-digest" }],
    counts: {
      tables: 1,
      rows: 1,
      columns: 3,
      constraints: 1,
      policies: 1,
      indexes: 1,
      triggers: 1,
      functions: 1,
      rlsEnabled: 1,
      rlsForced: 1,
      grants: 1,
    },
    digests: {
      tableData: "table-data-digest",
      columns: "column-digest",
      constraints: "constraint-digest",
      policies: "policy-digest",
      indexes: "index-digest",
      triggers: "trigger-digest",
      functions: "function-digest",
      rls: "rls-digest",
      grants: "grant-digest",
    },
    ...overrides,
  };
}
