import { createHash, randomUUID } from "node:crypto";

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { OrganizationIdSchema } from "@workspace/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  compareTenantObjectRestoreInventories,
  verifyTenantObjectRestore,
} from "./restore-verification.js";

const sourceBucket = `reconai-restore-source-${randomUUID().slice(0, 8)}`;
const restoredBucket = `reconai-restore-target-${randomUUID().slice(0, 8)}`;
const organizationId = OrganizationIdSchema.parse("82000000-0000-4000-8000-000000000001");
const prefix = `integration/${organizationId}/`;
const deletedKey = `${prefix}provider-events/83000000-0000-4000-8000-000000000001/payload.json`;
const currentKey = `${prefix}imports/84000000-0000-4000-8000-000000000001/payload.csv`;
let client: S3Client | undefined;

describe("live versioned tenant object restore comparison", { concurrent: false }, () => {
  beforeAll(async () => {
    const config = integrationConfig();
    client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    await Promise.all(
      [sourceBucket, restoredBucket].map(async (bucket) => {
        await requiredClient().send(new CreateBucketCommand({ Bucket: bucket }));
        await requiredClient().send(
          new PutBucketVersioningCommand({
            Bucket: bucket,
            VersioningConfiguration: { Status: "Enabled" },
          }),
        );
      }),
    );
    await Promise.all([seedVersionHistory(sourceBucket), seedVersionHistory(restoredBucket)]);
  }, 15_000);

  afterAll(async () => {
    if (!client) return;
    await Promise.all([emptyVersionedBucket(sourceBucket), emptyVersionedBucket(restoredBucket)]);
    await Promise.all(
      [sourceBucket, restoredBucket].map((bucket) =>
        requiredClient().send(new DeleteBucketCommand({ Bucket: bucket })),
      ),
    );
    client.destroy();
  });

  it("matches object bodies, metadata, history order, and a current delete marker", async () => {
    const config = integrationConfig();
    const result = await verifyTenantObjectRestore(
      {
        source: { ...config, bucket: sourceBucket, forcePathStyle: true },
        restored: { ...config, bucket: restoredBucket, forcePathStyle: true },
      },
      {
        environment: "integration",
        organizationId,
        limits: {
          maximumVersions: 20,
          maximumObjectBytes: 1024,
          maximumTotalBytes: 4096,
          requestTimeoutMs: 5000,
        },
      },
    );

    expect(result.comparison).toEqual({ matches: true, mismatches: [] });
    expect(result.source).toMatchObject({
      keyCount: 2,
      objectVersionCount: 3,
      deleteMarkerCount: 1,
      totalBytes: result.restored.totalBytes,
      historySha256: result.restored.historySha256,
      currentStateSha256: result.restored.currentStateSha256,
    });
    expect(result.source.records[0]).not.toHaveProperty("versionId");
  });

  it("fails closed when the restored tenant prefix has an extra version", async () => {
    await put(restoredBucket, currentKey, Buffer.from("id,amount\nentry-2,99.00\n"), "text/csv");
    const config = integrationConfig();
    const result = await verifyTenantObjectRestore(
      {
        source: { ...config, bucket: sourceBucket, forcePathStyle: true },
        restored: { ...config, bucket: restoredBucket, forcePathStyle: true },
      },
      {
        environment: "integration",
        organizationId,
        limits: {
          maximumVersions: 20,
          maximumObjectBytes: 1024,
          maximumTotalBytes: 4096,
          requestTimeoutMs: 5000,
        },
      },
    );

    expect(result.comparison.matches).toBe(false);
    expect(result.comparison.mismatches).toContain("objectVersionCount differs");
    expect(compareTenantObjectRestoreInventories(result.source, result.restored).matches).toBe(
      false,
    );
  });
});

async function seedVersionHistory(bucket: string): Promise<void> {
  await Promise.all([
    put(bucket, deletedKey, Buffer.from('{"state":"received"}'), "application/json"),
    put(bucket, currentKey, Buffer.from("id,amount\nentry-1,25.00\n"), "text/csv"),
  ]);
  await pauseForDistinctVersionTimestamp();
  await put(bucket, deletedKey, Buffer.from('{"state":"normalized"}'), "application/json");
  await pauseForDistinctVersionTimestamp();
  await requiredClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: deletedKey }));
}

async function put(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
  const checksumSha256 = createHash("sha256").update(body).digest("hex");
  await requiredClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentLength: body.byteLength,
      ContentType: contentType,
      ChecksumSHA256: Buffer.from(checksumSha256, "hex").toString("base64"),
      Metadata: {
        "content-sha256": checksumSha256,
        provenance: "synthetic-restore-drill",
      },
    }),
  );
}

async function emptyVersionedBucket(bucket: string): Promise<void> {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  for (;;) {
    const page = await requiredClient().send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
      }),
    );
    const objects = [
      ...(page.Versions ?? []).map((version) => ({
        Key: requiredString(version.Key, "version key"),
        VersionId: requiredString(version.VersionId, "version identifier"),
      })),
      ...(page.DeleteMarkers ?? []).map((marker) => ({
        Key: requiredString(marker.Key, "delete marker key"),
        VersionId: requiredString(marker.VersionId, "delete marker identifier"),
      })),
    ];
    if (objects.length > 0) {
      await requiredClient().send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
      );
    }
    if (!page.IsTruncated) break;
    keyMarker = requiredString(page.NextKeyMarker, "next key marker");
    versionIdMarker = page.NextVersionIdMarker;
  }
}

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

function requiredClient(): S3Client {
  if (!client) throw new Error("S3 integration client was not initialized");
  return client;
}

function requiredString(value: string | undefined, field: string): string {
  if (!value) throw new Error(`S3 version listing omitted ${field}`);
  return value;
}

async function pauseForDistinctVersionTimestamp(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1100));
}
