import { OrganizationIdSchema } from "@workspace/domain";
import { describe, expect, it } from "vitest";

import {
  compareTenantObjectRestoreInventories,
  summarizeTenantObjectRestoreInventory,
  type TenantObjectRestoreInventory,
} from "./restore-verification.js";

const organizationId = OrganizationIdSchema.parse("81000000-0000-4000-8000-000000000001");

describe("tenant object restore inventory", () => {
  it("accepts a logically identical version history with provider-neutral evidence", () => {
    const source = inventory();
    const restored = inventory();

    expect(compareTenantObjectRestoreInventories(source, restored)).toEqual({
      matches: true,
      mismatches: [],
    });
    expect(summarizeTenantObjectRestoreInventory(source)).not.toHaveProperty("records");
    expect(summarizeTenantObjectRestoreInventory(source).prefixSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("detects a missing delete marker and changed current-state digest", () => {
    const source = inventory();
    const restored = inventory({
      deleteMarkerCount: 0,
      historySha256: "b".repeat(64),
      currentStateSha256: "c".repeat(64),
      records: source.records.slice(1),
    });

    expect(compareTenantObjectRestoreInventories(source, restored)).toEqual({
      matches: false,
      mismatches: [
        "deleteMarkerCount differs",
        "historySha256 differs",
        "currentStateSha256 differs",
        "logical tenant object version histories differ",
      ],
    });
  });

  it("does not include object keys or body data in the evidence summary", () => {
    const serialized = JSON.stringify(summarizeTenantObjectRestoreInventory(inventory()));
    expect(serialized).not.toContain("provider-events");
    expect(serialized).not.toContain("source-event.json");
    expect(serialized).not.toContain("customer-payload");
  });
});

function inventory(
  overrides: Partial<TenantObjectRestoreInventory> = {},
): TenantObjectRestoreInventory {
  return {
    schemaVersion: 1,
    environment: "integration",
    organizationId,
    prefix: `integration/${organizationId}/`,
    bucketVersioning: "Enabled",
    keyCount: 1,
    objectVersionCount: 1,
    deleteMarkerCount: 1,
    totalBytes: 16,
    historySha256: "9".repeat(64),
    currentStateSha256: "a".repeat(64),
    records: [
      {
        key: `integration/${organizationId}/provider-events/event/source-event.json`,
        positionFromNewest: 0,
        kind: "delete_marker",
        isLatest: true,
        size: 0,
        contentSha256: null,
        contentType: null,
        metadataSha256: null,
      },
      {
        key: `integration/${organizationId}/provider-events/event/source-event.json`,
        positionFromNewest: 1,
        kind: "object",
        isLatest: false,
        size: 16,
        contentSha256: "d".repeat(64),
        contentType: "application/json",
        metadataSha256: "e".repeat(64),
      },
    ],
    ...overrides,
  };
}
