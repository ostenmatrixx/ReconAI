import { describe, expect, it } from "vitest";

import {
  AuditChainIntegrityError,
  computeAuditEventHashV2,
  type AuditEventHashV2Input,
} from "./audit.js";

const baseInput: AuditEventHashV2Input = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  actorType: "user",
  actorId: "33333333-3333-4333-8333-333333333333",
  action: "audit.tested",
  resourceType: "organization",
  resourceId: "22222222-2222-4222-8222-222222222222",
  occurredAt: "2026-07-28T10:30:00+08:00",
  correlationId: "44444444-4444-4444-8444-444444444444",
  reason: "verify canonical hashing",
  previousValue: { z: 1, a: { y: true, x: "value" } },
  newValue: { items: [{ b: 2, a: 1 }] },
  versionContext: { ruleVersion: "audit-v2" },
  previousEventHash: "a".repeat(64),
};

describe("audit event hash v2", () => {
  it("is stable across object-key order and equivalent instant representations", () => {
    const reordered: AuditEventHashV2Input = {
      ...baseInput,
      occurredAt: "2026-07-28T02:30:00.000Z",
      previousValue: { a: { x: "value", y: true }, z: 1 },
      newValue: { items: [{ a: 1, b: 2 }] },
    };

    expect(computeAuditEventHashV2(baseInput)).toMatch(/^[a-f0-9]{64}$/u);
    expect(computeAuditEventHashV2(reordered)).toBe(computeAuditEventHashV2(baseInput));
  });

  it.each([
    ["organizationId", { organizationId: "55555555-5555-4555-8555-555555555555" }],
    ["reason", { reason: "changed reason" }],
    ["newValue", { newValue: { items: [{ a: 1, b: 3 }] } }],
    ["previousEventHash", { previousEventHash: "b".repeat(64) }],
  ] satisfies readonly (readonly [string, Partial<AuditEventHashV2Input>])[])(
    "binds %s into the digest",
    (_field, change) => {
      expect(computeAuditEventHashV2({ ...baseInput, ...change })).not.toBe(
        computeAuditEventHashV2(baseInput),
      );
    },
  );

  it("rejects malformed predecessor hashes and invalid instants", () => {
    expect(() =>
      computeAuditEventHashV2({ ...baseInput, previousEventHash: "not-a-digest" }),
    ).toThrow(AuditChainIntegrityError);
    expect(() => computeAuditEventHashV2({ ...baseInput, occurredAt: "not-an-instant" })).toThrow(
      "audit occurredAt must be a valid instant",
    );
  });
});
