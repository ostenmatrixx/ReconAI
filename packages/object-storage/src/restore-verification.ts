import { createHash } from "node:crypto";

import {
  GetBucketVersioningCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { OrganizationIdSchema, type OrganizationId } from "@workspace/domain";
import { z } from "zod";

import type { S3ObjectStoreConfig } from "./index.js";

const environmentSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/u);
const limitsSchema = z
  .object({
    maximumVersions: z.number().int().min(1).max(1_000_000),
    maximumObjectBytes: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024 * 1024),
    maximumTotalBytes: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024 * 1024 * 1024),
    requestTimeoutMs: z.number().int().min(1_000).max(600_000),
  })
  .strict();
const sha256Pattern = /^[a-f0-9]{64}$/u;
const objectKeyPattern = /^[a-z0-9][a-z0-9._/-]{0,1023}$/u;
const maximumMetadataEntries = 100;
const maximumMetadataBytes = 64 * 1024;

export interface TenantObjectRestoreVerificationLimits {
  readonly maximumVersions: number;
  readonly maximumObjectBytes: number;
  readonly maximumTotalBytes: number;
  readonly requestTimeoutMs: number;
}

export interface TenantObjectRestoreScope {
  readonly environment: string;
  readonly organizationId: OrganizationId;
  readonly limits: TenantObjectRestoreVerificationLimits;
}

export interface TenantObjectVersionRecord {
  readonly key: string;
  readonly positionFromNewest: number;
  readonly kind: "object" | "delete_marker";
  readonly isLatest: boolean;
  readonly size: number;
  readonly contentSha256: string | null;
  readonly contentType: string | null;
  readonly metadataSha256: string | null;
}

export interface TenantObjectRestoreInventory {
  readonly schemaVersion: 1;
  readonly environment: string;
  readonly organizationId: OrganizationId;
  readonly prefix: string;
  readonly bucketVersioning: "Enabled";
  readonly keyCount: number;
  readonly objectVersionCount: number;
  readonly deleteMarkerCount: number;
  readonly totalBytes: number;
  readonly historySha256: string;
  readonly currentStateSha256: string;
  readonly records: readonly TenantObjectVersionRecord[];
}

export interface TenantObjectRestoreInventorySummary {
  readonly schemaVersion: 1;
  readonly environment: string;
  readonly organizationId: OrganizationId;
  readonly prefixSha256: string;
  readonly bucketVersioning: "Enabled";
  readonly keyCount: number;
  readonly objectVersionCount: number;
  readonly deleteMarkerCount: number;
  readonly totalBytes: number;
  readonly historySha256: string;
  readonly currentStateSha256: string;
}

export interface TenantObjectRestoreComparison {
  readonly matches: boolean;
  readonly mismatches: readonly string[];
}

export interface S3TenantObjectRestoreVerificationConfig {
  readonly source: S3ObjectStoreConfig;
  readonly restored: S3ObjectStoreConfig;
}

interface ListedVersion {
  readonly key: string;
  readonly versionId: string;
  readonly kind: "object" | "delete_marker";
  readonly isLatest: boolean;
  readonly lastModifiedMs: number;
  readonly listedSize: number;
}

export async function captureTenantObjectRestoreInventory(
  config: S3ObjectStoreConfig,
  scopeInput: TenantObjectRestoreScope,
): Promise<TenantObjectRestoreInventory> {
  const scope = validatedScope(scopeInput);
  const client = buildClient(config);
  try {
    return await captureWithClient(client, config.bucket, scope);
  } finally {
    client.destroy();
  }
}

export async function verifyTenantObjectRestore(
  config: S3TenantObjectRestoreVerificationConfig,
  scope: TenantObjectRestoreScope,
): Promise<{
  readonly source: TenantObjectRestoreInventory;
  readonly restored: TenantObjectRestoreInventory;
  readonly comparison: TenantObjectRestoreComparison;
}> {
  const [source, restored] = await Promise.all([
    captureTenantObjectRestoreInventory(config.source, scope),
    captureTenantObjectRestoreInventory(config.restored, scope),
  ]);
  return {
    source,
    restored,
    comparison: compareTenantObjectRestoreInventories(source, restored),
  };
}

export function compareTenantObjectRestoreInventories(
  source: TenantObjectRestoreInventory,
  restored: TenantObjectRestoreInventory,
): TenantObjectRestoreComparison {
  const mismatches: string[] = [];
  compareField(source, restored, "environment", mismatches);
  compareField(source, restored, "organizationId", mismatches);
  compareField(source, restored, "prefix", mismatches);
  compareField(source, restored, "bucketVersioning", mismatches);
  compareField(source, restored, "keyCount", mismatches);
  compareField(source, restored, "objectVersionCount", mismatches);
  compareField(source, restored, "deleteMarkerCount", mismatches);
  compareField(source, restored, "totalBytes", mismatches);
  compareField(source, restored, "historySha256", mismatches);
  compareField(source, restored, "currentStateSha256", mismatches);
  if (canonicalJson(source.records) !== canonicalJson(restored.records)) {
    mismatches.push("logical tenant object version histories differ");
  }
  return { matches: mismatches.length === 0, mismatches };
}

export function summarizeTenantObjectRestoreInventory(
  inventory: TenantObjectRestoreInventory,
): TenantObjectRestoreInventorySummary {
  return {
    schemaVersion: 1,
    environment: inventory.environment,
    organizationId: inventory.organizationId,
    prefixSha256: sha256(inventory.prefix),
    bucketVersioning: inventory.bucketVersioning,
    keyCount: inventory.keyCount,
    objectVersionCount: inventory.objectVersionCount,
    deleteMarkerCount: inventory.deleteMarkerCount,
    totalBytes: inventory.totalBytes,
    historySha256: inventory.historySha256,
    currentStateSha256: inventory.currentStateSha256,
  };
}

async function captureWithClient(
  client: S3Client,
  bucket: string,
  scope: TenantObjectRestoreScope,
): Promise<TenantObjectRestoreInventory> {
  const bucketVersioning = await client.send(
    new GetBucketVersioningCommand({ Bucket: bucket }),
    requestOptions(scope.limits.requestTimeoutMs),
  );
  if (bucketVersioning.Status !== "Enabled") {
    throw new Error("tenant object restore verification requires bucket versioning enabled");
  }

  const prefix = `${scope.environment}/${scope.organizationId}/`;
  const listed = await listTenantVersions(client, bucket, prefix, scope.limits);
  const histories = groupAndOrderVersions(listed);
  const records: TenantObjectVersionRecord[] = [];
  let totalBytes = 0;

  for (const [key, versions] of histories) {
    for (const [positionFromNewest, version] of versions.entries()) {
      if (version.kind === "delete_marker") {
        records.push({
          key,
          positionFromNewest,
          kind: version.kind,
          isLatest: version.isLatest,
          size: 0,
          contentSha256: null,
          contentType: null,
          metadataSha256: null,
        });
        continue;
      }
      const remainingBytes = scope.limits.maximumTotalBytes - totalBytes;
      if (remainingBytes < 1) {
        throw new Error("tenant object inventory exceeds the configured total byte limit");
      }
      const object = await inspectObjectVersion(
        client,
        bucket,
        version,
        Math.min(scope.limits.maximumObjectBytes, remainingBytes),
        scope.limits.requestTimeoutMs,
      );
      totalBytes += object.size;
      records.push({
        key,
        positionFromNewest,
        kind: version.kind,
        isLatest: version.isLatest,
        ...object,
      });
    }
  }

  const keyCount = histories.size;
  const objectVersionCount = records.filter((record) => record.kind === "object").length;
  const deleteMarkerCount = records.length - objectVersionCount;
  const historySha256 = sha256(canonicalJson(records));
  const currentStateSha256 = sha256(
    canonicalJson(records.filter((record) => record.positionFromNewest === 0)),
  );
  return {
    schemaVersion: 1,
    environment: scope.environment,
    organizationId: scope.organizationId,
    prefix,
    bucketVersioning: "Enabled",
    keyCount,
    objectVersionCount,
    deleteMarkerCount,
    totalBytes,
    historySha256,
    currentStateSha256,
    records,
  };
}

async function listTenantVersions(
  client: S3Client,
  bucket: string,
  prefix: string,
  limits: TenantObjectRestoreVerificationLimits,
): Promise<readonly ListedVersion[]> {
  const listed: ListedVersion[] = [];
  const seenPages = new Set<string>();
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;

  for (;;) {
    const pageIdentity = `${keyMarker ?? ""}\0${versionIdMarker ?? ""}`;
    if (seenPages.has(pageIdentity)) {
      throw new Error("object version listing repeated a pagination marker");
    }
    seenPages.add(pageIdentity);
    const remaining = limits.maximumVersions - listed.length;
    if (remaining < 1) {
      throw new Error("tenant object inventory exceeds the configured version limit");
    }
    const page = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: Math.min(1000, remaining),
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
      }),
      requestOptions(limits.requestTimeoutMs),
    );

    for (const version of page.Versions ?? []) {
      listed.push(
        listedVersion({
          key: version.Key,
          versionId: version.VersionId,
          kind: "object",
          isLatest: version.IsLatest,
          lastModified: version.LastModified,
          size: version.Size,
          prefix,
        }),
      );
    }
    for (const marker of page.DeleteMarkers ?? []) {
      listed.push(
        listedVersion({
          key: marker.Key,
          versionId: marker.VersionId,
          kind: "delete_marker",
          isLatest: marker.IsLatest,
          lastModified: marker.LastModified,
          size: 0,
          prefix,
        }),
      );
    }
    if (listed.length > limits.maximumVersions) {
      throw new Error("tenant object inventory exceeds the configured version limit");
    }
    if (!page.IsTruncated) break;
    if (!page.NextKeyMarker) {
      throw new Error("truncated object version listing omitted its next key marker");
    }
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  }
  return listed;
}

function groupAndOrderVersions(
  listed: readonly ListedVersion[],
): ReadonlyMap<string, readonly ListedVersion[]> {
  const grouped = new Map<string, ListedVersion[]>();
  for (const version of listed) {
    const group = grouped.get(version.key) ?? [];
    group.push(version);
    grouped.set(version.key, group);
  }
  const ordered = new Map<string, readonly ListedVersion[]>();
  for (const [key, versions] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
    versions.sort((left, right) => right.lastModifiedMs - left.lastModifiedMs);
    for (let index = 1; index < versions.length; index += 1) {
      if (versions[index - 1]?.lastModifiedMs === versions[index]?.lastModifiedMs) {
        throw new Error(
          "object version history contains an ambiguous same-timestamp ordering; use a provider-native inventory that preserves order",
        );
      }
    }
    if (versions.filter((version) => version.isLatest).length !== 1 || !versions[0]?.isLatest) {
      throw new Error("object version history has an invalid latest-version marker");
    }
    ordered.set(key, versions);
  }
  return ordered;
}

async function inspectObjectVersion(
  client: S3Client,
  bucket: string,
  version: ListedVersion,
  maximumBytes: number,
  requestTimeoutMs: number,
): Promise<{
  readonly size: number;
  readonly contentSha256: string;
  readonly contentType: string | null;
  readonly metadataSha256: string;
}> {
  if (version.listedSize < 1 || version.listedSize > maximumBytes) {
    throw new Error("tenant object version exceeds the configured object or total byte limit");
  }
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: version.key,
      VersionId: version.versionId,
      ChecksumMode: "ENABLED",
    }),
    requestOptions(requestTimeoutMs),
  );
  if (response.ContentLength !== undefined && response.ContentLength !== version.listedSize) {
    throw new Error("object version content length differs from its inventory entry");
  }
  if (!response.Body) throw new Error("object version has no readable response body");
  const { bytes, checksumSha256 } = await hashBoundedBody(response.Body, maximumBytes);
  if (bytes !== version.listedSize) {
    throw new Error("object version streamed byte count differs from its inventory entry");
  }
  if (response.ChecksumSHA256) {
    const expected = Buffer.from(checksumSha256, "hex").toString("base64");
    if (response.ChecksumSHA256 !== expected) {
      throw new Error("object version provider checksum does not match streamed content");
    }
  }
  const metadata = normalizedMetadata(response.Metadata);
  if (
    !sha256Pattern.test(metadata["content-sha256"] ?? "") ||
    metadata["content-sha256"] !== checksumSha256
  ) {
    throw new Error("object version ReconAI checksum metadata does not match streamed content");
  }
  if (response.ContentType !== undefined && response.ContentType.length > 255) {
    throw new Error("object version content type exceeds the supported limit");
  }
  return {
    size: bytes,
    contentSha256: checksumSha256,
    contentType: response.ContentType ?? null,
    metadataSha256: sha256(canonicalJson(metadata)),
  };
}

async function hashBoundedBody(
  body: unknown,
  maximumBytes: number,
): Promise<{ readonly bytes: number; readonly checksumSha256: string }> {
  if (!isAsyncIterable(body)) throw new Error("object version body is not a readable byte stream");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const value of body) {
    const chunk =
      typeof value === "string"
        ? Buffer.from(value)
        : value instanceof Uint8Array
          ? Buffer.from(value)
          : undefined;
    if (!chunk) throw new Error("object version returned a non-byte chunk");
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) {
      throw new Error("object version exceeds the configured streaming byte limit");
    }
    hash.update(chunk);
  }
  return { bytes, checksumSha256: hash.digest("hex") };
}

function listedVersion(input: {
  readonly key: string | undefined;
  readonly versionId: string | undefined;
  readonly kind: ListedVersion["kind"];
  readonly isLatest: boolean | undefined;
  readonly lastModified: Date | undefined;
  readonly size: number | undefined;
  readonly prefix: string;
}): ListedVersion {
  if (!input.key?.startsWith(input.prefix)) {
    throw new Error("object version listing escaped the tenant prefix");
  }
  validateObjectKey(input.key);
  if (!input.versionId) throw new Error("object version listing omitted a version identifier");
  if (typeof input.isLatest !== "boolean") {
    throw new Error("object version listing omitted its latest-version state");
  }
  const lastModifiedMs = input.lastModified?.getTime();
  if (lastModifiedMs === undefined || !Number.isFinite(lastModifiedMs)) {
    throw new Error("object version listing omitted a valid modification time");
  }
  const size = input.size ?? 0;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("object version listing returned an invalid size");
  }
  return {
    key: input.key,
    versionId: input.versionId,
    kind: input.kind,
    isLatest: input.isLatest,
    lastModifiedMs,
    listedSize: size,
  };
}

function validatedScope(input: TenantObjectRestoreScope): TenantObjectRestoreScope {
  return {
    environment: environmentSchema.parse(input.environment),
    organizationId: OrganizationIdSchema.parse(input.organizationId),
    limits: limitsSchema.parse(input.limits),
  };
}

function buildClient(config: S3ObjectStoreConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function normalizedMetadata(
  metadata: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const entries = Object.entries(metadata ?? {});
  if (entries.length > maximumMetadataEntries) {
    throw new Error("object version metadata exceeds the supported entry limit");
  }
  let totalBytes = 0;
  const normalized: Record<string, string> = {};
  for (const [rawKey, value] of entries) {
    const key = rawKey.toLowerCase();
    totalBytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(key) || value.length > 2048) {
      throw new Error("object version metadata is outside the supported format");
    }
    normalized[key] = value;
  }
  if (totalBytes > maximumMetadataBytes) {
    throw new Error("object version metadata exceeds the supported byte limit");
  }
  return Object.fromEntries(
    Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function validateObjectKey(key: string): void {
  if (
    !objectKeyPattern.test(key) ||
    key.includes("//") ||
    key.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("object version listing returned an unsafe key");
  }
}

function compareField(
  source: TenantObjectRestoreInventory,
  restored: TenantObjectRestoreInventory,
  field: keyof TenantObjectRestoreInventory,
  mismatches: string[],
): void {
  if (source[field] !== restored[field]) mismatches.push(`${field} differs`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requestOptions(requestTimeoutMs: number): { readonly abortSignal: AbortSignal } {
  return { abortSignal: AbortSignal.timeout(requestTimeoutMs) };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as { readonly [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
      "function"
  );
}
