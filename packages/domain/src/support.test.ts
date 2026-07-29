import { describe, expect, it } from "vitest";

import {
  SUPPORT_ACCESS_MAXIMUM_DURATION_MINUTES,
  SUPPORT_ACCESS_MINIMUM_DURATION_MINUTES,
  SUPPORT_ACCESS_REQUEST_TTL_MS,
  SupportAccessRequestCodeSchema,
  SupportCapabilitySchema,
  SupportIdentityDigestSchema,
} from "./support.js";

describe("support access domain contract", () => {
  it("keeps grants short-lived and the capability read-only", () => {
    expect(SUPPORT_ACCESS_MINIMUM_DURATION_MINUTES).toBe(5);
    expect(SUPPORT_ACCESS_MAXIMUM_DURATION_MINUTES).toBe(60);
    expect(SUPPORT_ACCESS_REQUEST_TTL_MS).toBe(15 * 60 * 1000);
    expect(SupportCapabilitySchema.options).toEqual(["diagnostics:view"]);
  });

  it("accepts only fixed-size opaque request codes and identity digests", () => {
    expect(SupportAccessRequestCodeSchema.safeParse("a".repeat(43)).success).toBe(true);
    expect(SupportAccessRequestCodeSchema.safeParse("a".repeat(42)).success).toBe(false);
    expect(SupportAccessRequestCodeSchema.safeParse("a".repeat(44)).success).toBe(false);
    expect(SupportIdentityDigestSchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(SupportIdentityDigestSchema.safeParse("A".repeat(64)).success).toBe(false);
  });
});
