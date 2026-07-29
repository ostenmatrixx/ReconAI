import { createHash } from "node:crypto";

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { S3ImmutableObjectStore } from "./index.js";

const bucket = "reconai-integration";
const key =
  "integration/00000000-0000-4000-8000-000000000001/imports/00000000-0000-4000-8000-000000000002/payload.csv";
let client: S3Client | undefined;

describe("live S3-compatible immutable object contract", { concurrent: false }, () => {
  beforeAll(async () => {
    const config = integrationConfig();
    const s3 = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    client = s3;
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (
        !(error instanceof S3ServiceException) ||
        (error.$metadata.httpStatusCode !== 409 && error.name !== "BucketAlreadyOwnedByYou")
      ) {
        throw error;
      }
    }
  });

  afterAll(async () => {
    if (client) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      client.destroy();
    }
  });

  it("uses a conditional write and verifies the exact payload checksum", async () => {
    const config = integrationConfig();
    const store = new S3ImmutableObjectStore({
      ...config,
      bucket,
      forcePathStyle: true,
    });
    const body = Buffer.from("id,amount\nentry-1,25.00\n");
    const checksumSha256 = createHash("sha256").update(body).digest("hex");
    await expect(store.health(AbortSignal.timeout(1_000))).resolves.toBe(true);
    await expect(
      store.putImmutable({ key, body, contentType: "text/csv", checksumSha256 }),
    ).resolves.toBe("stored");
    await expect(
      store.putImmutable({ key, body, contentType: "text/csv", checksumSha256 }),
    ).resolves.toBe("already_exists");
    await expect(
      store.getVerified({ key, expectedChecksumSha256: checksumSha256, maximumBytes: 1024 }),
    ).resolves.toEqual(Uint8Array.from(body));
    await expect(
      store.deleteVerified({ key, expectedChecksumSha256: "f".repeat(64) }),
    ).rejects.toThrow("stored object does not match deletion authority");
    await expect(
      store.deleteVerified({ key, expectedChecksumSha256: checksumSha256 }),
    ).resolves.toBe("deleted");
    await expect(
      store.deleteVerified({ key, expectedChecksumSha256: checksumSha256 }),
    ).resolves.toBe("already_missing");
    store.close();
  });
});

function integrationConfig() {
  return {
    endpoint: requiredEnvironment("S3_ENDPOINT"),
    region: requiredEnvironment("S3_REGION"),
    accessKeyId: requiredEnvironment("S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnvironment("S3_SECRET_ACCESS_KEY"),
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the object storage integration suite`);
  return value;
}
