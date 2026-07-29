import { OrganizationIdSchema } from "@workspace/domain";
import { describe, expect, it } from "vitest";

import {
  ConnectorJobEnvelopeSchema,
  DurableTraceContextSchema,
  DurableJobEnvelopeSchema,
  EnvironmentConnectorSecretResolver,
  InMemoryWebhookReceiptStore,
  ReconciliationRunJobEnvelopeSchema,
  connectorJobId,
  connectorCredentialEnvelopeSha256,
  connectorQueueName,
  createDurableTraceContext,
  createProviderAuthorizationState,
  createConnectorCredentialKeyring,
  durableJobId,
  openConnectorCredential,
  parseProviderOAuthTokenBundle,
  providerAuthorizationStateSha256,
  retryDelayMs,
  sealConnectorCredential,
  serializeProviderOAuthTokenBundle,
} from "./index.js";

describe("connector delivery primitives", () => {
  it("deduplicates the same provider event within a tenant connection", async () => {
    const store = new InMemoryWebhookReceiptStore();
    const receipt = {
      organizationId: OrganizationIdSchema.parse("00000000-0000-4000-8000-000000000001"),
      connectionId: "00000000-0000-4000-8000-000000000002",
      connector: "shopify",
      externalEventId: "webhook-1",
      receivedAt: "2026-07-27T00:00:00.000Z",
      rawBodySha256: "a".repeat(64),
      status: "received",
    } as const;
    await expect(store.insertIfAbsent(receipt)).resolves.toBe("inserted");
    await expect(store.insertIfAbsent(receipt)).resolves.toBe("duplicate");
  });

  it("uses bounded retry delays", () => {
    expect(retryDelayMs(1)).toBeGreaterThan(0);
    expect(retryDelayMs(20)).toBeLessThanOrEqual(60_000);
  });

  it("preserves required event identity and rejects unknown job capabilities", () => {
    const envelope = {
      schemaVersion: 1,
      type: "connector.webhook.received",
      organizationId: "00000000-0000-4000-8000-000000000001",
      connectionId: "00000000-0000-4000-8000-000000000002",
      provider: "shopify",
      eventType: "orders/updated",
      externalEventId: "shopify/webhooks/1",
      correlationId: "00000000-0000-4000-8000-000000000003",
      idempotencyKey: "shopify:webhook:1",
      requestedBy: "webhook-ingress",
      createdAt: "2026-07-27T00:00:00.000Z",
    } as const;

    const parsed = ConnectorJobEnvelopeSchema.parse(envelope);
    expect(parsed.type).toBe("connector.webhook.received");
    if (parsed.type !== "connector.webhook.received") throw new Error("unexpected job type");
    expect(parsed.externalEventId).toBe("shopify/webhooks/1");
    expect(parsed.provider).toBe("shopify");
    expect(
      ConnectorJobEnvelopeSchema.safeParse({ ...envelope, type: "connector.admin.execute" })
        .success,
    ).toBe(false);
  });

  it("resolves only bounded connector-specific environment references", async () => {
    const resolver = new EnvironmentConnectorSecretResolver({
      RECONAI_CONNECTOR_SHOP_1: "synthetic-secret-at-least-16-bytes",
      OTHER_SECRET: "must-not-be-addressable",
    });
    const request = {
      organizationId: OrganizationIdSchema.parse("00000000-0000-4000-8000-000000000001"),
      connectionId: "00000000-0000-4000-8000-000000000002",
      provider: "shopify",
      purpose: "api_read",
    } as const;
    await expect(
      resolver.resolve({ ...request, reference: "env:RECONAI_CONNECTOR_SHOP_1" }),
    ).resolves.toBe("synthetic-secret-at-least-16-bytes");
    await expect(resolver.resolve({ ...request, reference: "env:OTHER_SECRET" })).rejects.toThrow(
      /unsupported/u,
    );
    await expect(resolver.resolve({ ...request, reference: "file:/tmp/secret" })).rejects.toThrow(
      /unsupported/u,
    );
  });

  it("seals credentials with tenant-bound authenticated context and detects tampering", () => {
    const keyring = createConnectorCredentialKeyring({
      references: "v1=env:RECONAI_CONNECTOR_ENCRYPTION_KEY_TEST",
      activeVersion: "v1",
      environment: {
        RECONAI_CONNECTOR_ENCRYPTION_KEY_TEST: Buffer.alloc(32, 7).toString("base64url"),
      },
      production: true,
    });
    const envelope = sealConnectorCredential(
      {
        organizationId: OrganizationIdSchema.parse("00000000-0000-4000-8000-000000000001"),
        connectionId: "00000000-0000-4000-8000-000000000002",
        provider: "stripe",
        purpose: "api_read",
        secret: "synthetic-read-only-provider-credential",
      },
      keyring,
    );

    expect(openConnectorCredential(envelope, keyring)).toBe(
      "synthetic-read-only-provider-credential",
    );
    expect(connectorCredentialEnvelopeSha256(envelope)).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      openConnectorCredential(
        {
          ...envelope,
          connectionId: "00000000-0000-4000-8000-000000000003",
        },
        keyring,
      ),
    ).toThrow(/could not be opened/u);
    expect(() =>
      openConnectorCredential(
        {
          ...envelope,
          ciphertext: `${
            envelope.ciphertext.startsWith("A") ? "B" : "A"
          }${envelope.ciphertext.slice(1)}`,
        },
        keyring,
      ),
    ).toThrow(/could not be opened/u);
  });

  it("requires a configured active key and rejects the local placeholder in production", () => {
    const placeholder = Buffer.alloc(32).toString("base64url");
    expect(() =>
      createConnectorCredentialKeyring({
        references: "v1=env:RECONAI_CONNECTOR_ENCRYPTION_KEY_TEST",
        activeVersion: "v2",
        environment: { RECONAI_CONNECTOR_ENCRYPTION_KEY_TEST: placeholder },
        production: false,
      }),
    ).toThrow(/ACTIVE_KEY_VERSION/u);
    expect(() =>
      createConnectorCredentialKeyring({
        references: "v1=env:RECONAI_CONNECTOR_ENCRYPTION_KEY_TEST",
        activeVersion: "v1",
        environment: { RECONAI_CONNECTOR_ENCRYPTION_KEY_TEST: placeholder },
        production: true,
      }),
    ).toThrow(/placeholder/u);
  });

  it("creates digest-only authorization state authority and validates refreshable token bundles", () => {
    const state = createProviderAuthorizationState();
    expect(state.value).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(state.sha256).toBe(providerAuthorizationStateSha256(state.value));
    expect(state.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(createProviderAuthorizationState().value).not.toBe(state.value);

    const serialized = serializeProviderOAuthTokenBundle({
      schemaVersion: 1,
      credentialType: "oauth_refreshable",
      provider: "shopify",
      externalAccountId: "reconai-test.myshopify.com",
      accessToken: "synthetic-shopify-access-token-value",
      refreshToken: "synthetic-shopify-refresh-token-value",
      accessTokenExpiresAt: "2026-07-28T01:00:00.000Z",
      refreshTokenExpiresAt: "2026-10-26T00:00:00.000Z",
      scopes: ["read_orders"],
      issuedAt: "2026-07-28T00:00:00.000Z",
    });
    expect(serialized).not.toContain("\n");
    expect(parseProviderOAuthTokenBundle(serialized)).toMatchObject({
      provider: "shopify",
      externalAccountId: "reconai-test.myshopify.com",
      scopes: ["read_orders"],
    });
    expect(() =>
      parseProviderOAuthTokenBundle(
        serialized.replace("2026-10-26T00:00:00.000Z", "2026-07-28T00:30:00.000Z"),
      ),
    ).toThrow(/invalid/u);
  });

  it("accepts only the bounded CSV import capability and derives a stable queue id", () => {
    const envelope = ConnectorJobEnvelopeSchema.parse({
      schemaVersion: 1,
      type: "csv.import.commit",
      organizationId: "00000000-0000-4000-8000-000000000001",
      connectionId: "00000000-0000-4000-8000-000000000002",
      importId: "00000000-0000-4000-8000-000000000003",
      correlationId: "00000000-0000-4000-8000-000000000004",
      idempotencyKey: "csv-import-commit-1",
      requestedBy: "00000000-0000-4000-8000-000000000005",
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    if (envelope.type !== "csv.import.commit") throw new Error("unexpected job type");
    expect(connectorJobId(envelope)).toMatch(/^[a-f0-9]{64}$/u);
    expect(connectorJobId(envelope)).toBe(connectorJobId({ ...envelope }));
    expect(
      connectorJobId({
        ...envelope,
        importId: "00000000-0000-4000-8000-000000000006",
      }),
    ).not.toBe(connectorJobId(envelope));
    expect(connectorQueueName("test")).toBe("reconai-test-connector-v1");
    expect(connectorQueueName("test")).not.toContain(":");
  });

  it("accepts a tenant-bound reconciliation execution without connector authority", () => {
    const envelope = ReconciliationRunJobEnvelopeSchema.parse({
      schemaVersion: 1,
      type: "reconciliation.run.requested",
      organizationId: "00000000-0000-4000-8000-000000000001",
      runId: "00000000-0000-4000-8000-000000000011",
      executionAttempt: 1,
      correlationId: "00000000-0000-4000-8000-000000000012",
      idempotencyKey: "reconciliation-run:test:dispatch:1",
      requestedBy: "00000000-0000-4000-8000-000000000013",
      createdAt: "2026-07-27T12:00:00.000Z",
      traceContext: {
        schemaVersion: 1,
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      },
    });

    expect(DurableJobEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(durableJobId(envelope)).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      durableJobId({
        ...envelope,
        traceContext: {
          schemaVersion: 1,
          traceparent: "00-0123456789abcdef0123456789abcdef-fedcba9876543210-01",
        },
      }),
    ).not.toBe(durableJobId(envelope));
    expect(DurableJobEnvelopeSchema.safeParse({ ...envelope, executionAttempt: 101 }).success).toBe(
      false,
    );
  });

  it("accepts only versioned nonzero W3C trace context in durable authority", () => {
    const valid = {
      schemaVersion: 1,
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-00",
    } as const;
    expect(DurableTraceContextSchema.parse(valid)).toEqual(valid);
    expect(createDurableTraceContext(valid.traceparent)).toEqual(valid);
    expect(createDurableTraceContext(undefined)).toBeUndefined();

    for (const traceparent of [
      "00-00000000000000000000000000000000-0123456789abcdef-01",
      "00-0123456789abcdef0123456789abcdef-0000000000000000-01",
      "00-0123456789ABCDEF0123456789ABCDEF-0123456789abcdef-01",
      "ff-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-03",
      "organization-secret-value",
    ]) {
      expect(DurableTraceContextSchema.safeParse({ ...valid, traceparent }).success).toBe(false);
      expect(() => createDurableTraceContext(traceparent)).toThrow();
    }
    expect(
      DurableTraceContextSchema.safeParse({ ...valid, tracestate: "untrusted=value" }).success,
    ).toBe(false);
  });
});
