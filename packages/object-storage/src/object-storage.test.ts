import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import {
  InMemoryImmutableObjectStore,
  ObjectIntegrityError,
  ObjectNotFoundError,
  ObjectReadTimeoutError,
  S3ImmutableObjectStore,
  buildTenantObjectKey,
} from "./index.js";

describe("immutable object storage contract", () => {
  it("stores exact content once and verifies reads", async () => {
    const store = new InMemoryImmutableObjectStore();
    const body = Buffer.from("id,amount\nentry-1,25.00\n");
    const checksumSha256 = createHash("sha256").update(body).digest("hex");
    const key = buildTenantObjectKey(
      "test",
      "00000000-0000-4000-8000-000000000001",
      "imports",
      "00000000-0000-4000-8000-000000000002",
      "payload.csv",
    );

    await expect(
      store.putImmutable({ key, body, contentType: "text/csv", checksumSha256 }),
    ).resolves.toBe("stored");
    await expect(
      store.putImmutable({ key, body, contentType: "text/csv", checksumSha256 }),
    ).resolves.toBe("already_exists");
    await expect(
      store.getVerified({ key, expectedChecksumSha256: checksumSha256, maximumBytes: 1024 }),
    ).resolves.toEqual(Uint8Array.from(body));
  });

  it("rejects key collisions, checksum mismatches, and oversized reads", async () => {
    const store = new InMemoryImmutableObjectStore();
    const key = "test/00000000-0000-4000-8000-000000000001/imports/id/payload.csv";
    const first = Buffer.from("first");
    const second = Buffer.from("second");
    const firstHash = createHash("sha256").update(first).digest("hex");
    const secondHash = createHash("sha256").update(second).digest("hex");
    await store.putImmutable({
      key,
      body: first,
      contentType: "text/csv",
      checksumSha256: firstHash,
    });

    await expect(
      store.putImmutable({
        key,
        body: second,
        contentType: "text/csv",
        checksumSha256: secondHash,
      }),
    ).rejects.toBeInstanceOf(ObjectIntegrityError);
    await expect(
      store.getVerified({ key, expectedChecksumSha256: secondHash, maximumBytes: 1024 }),
    ).rejects.toBeInstanceOf(ObjectIntegrityError);
    await expect(
      store.getVerified({ key, expectedChecksumSha256: firstHash, maximumBytes: 2 }),
    ).rejects.toBeInstanceOf(ObjectIntegrityError);
    await expect(
      store.getVerified({
        key,
        expectedChecksumSha256: firstHash,
        maximumBytes: 1024,
        timeoutMs: 31_000,
      }),
    ).rejects.toThrow("timeoutMs must be an integer between 100 and 30000");
  });

  it("deletes only the checksum-authorized immutable object and is idempotent", async () => {
    const store = new InMemoryImmutableObjectStore();
    const key = "test/00000000-0000-4000-8000-000000000001/imports/id/payload.csv";
    const body = Buffer.from("retained source evidence");
    const checksumSha256 = createHash("sha256").update(body).digest("hex");
    await store.putImmutable({
      key,
      body,
      contentType: "text/csv",
      checksumSha256,
    });

    await expect(
      store.deleteVerified({ key, expectedChecksumSha256: "f".repeat(64) }),
    ).rejects.toBeInstanceOf(ObjectIntegrityError);
    await expect(
      store.getVerified({ key, expectedChecksumSha256: checksumSha256, maximumBytes: 1024 }),
    ).resolves.toEqual(Uint8Array.from(body));
    await expect(
      store.deleteVerified({ key, expectedChecksumSha256: checksumSha256 }),
    ).resolves.toBe("deleted");
    await expect(
      store.getVerified({ key, expectedChecksumSha256: checksumSha256, maximumBytes: 1024 }),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(
      store.deleteVerified({ key, expectedChecksumSha256: checksumSha256 }),
    ).resolves.toBe("already_missing");
  });

  it("aborts an S3 read whose response exceeds the configured deadline", async () => {
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("test server has no port");
    const store = new S3ImmutableObjectStore({
      endpoint: `http://127.0.0.1:${String(address.port)}`,
      region: "test",
      bucket: "reconai-timeout-test",
      accessKeyId: "synthetic-access-key",
      secretAccessKey: "synthetic-secret-key",
      forcePathStyle: true,
    });
    try {
      await expect(
        store.getVerified({
          key: "test/timeout/provider-events/event/payload.json",
          expectedChecksumSha256: "a".repeat(64),
          maximumBytes: 1024,
          timeoutMs: 200,
        }),
      ).rejects.toBeInstanceOf(ObjectReadTimeoutError);
    } finally {
      store.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
