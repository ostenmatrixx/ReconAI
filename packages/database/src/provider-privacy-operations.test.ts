import { describe, expect, it } from "vitest";

import {
  ProviderPrivacyOperationsCursorError,
  decodeProviderPrivacyOperationsCursor,
  encodeProviderPrivacyOperationsCursor,
} from "./provider-privacy-operations.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const otherOrganizationId = "00000000-0000-4000-8000-000000000002";
const item = {
  id: "00000000-0000-4000-8000-000000000041",
  dueAt: "2026-08-27T01:00:00.000Z",
  receivedAt: "2026-07-28T01:00:00.000Z",
} as const;

describe("provider privacy operations cursor", () => {
  it("round-trips the stable deadline position without privacy subject data", () => {
    const encoded = encodeProviderPrivacyOperationsCursor(item, organizationId);

    expect(decodeProviderPrivacyOperationsCursor(encoded, organizationId)).toEqual({
      version: 1,
      organizationId,
      ...item,
    });
    expect(Buffer.from(encoded, "base64url").toString("utf8")).not.toContain("customer");
  });

  it("rejects a cursor replayed against another tenant", () => {
    const encoded = encodeProviderPrivacyOperationsCursor(item, organizationId);

    expect(() => decodeProviderPrivacyOperationsCursor(encoded, otherOrganizationId)).toThrow(
      ProviderPrivacyOperationsCursorError,
    );
  });

  it("rejects malformed and oversized cursors", () => {
    expect(() => decodeProviderPrivacyOperationsCursor("not-json", organizationId)).toThrow(
      ProviderPrivacyOperationsCursorError,
    );
    expect(() => decodeProviderPrivacyOperationsCursor("A".repeat(1024), organizationId)).toThrow(
      ProviderPrivacyOperationsCursorError,
    );
  });
});
