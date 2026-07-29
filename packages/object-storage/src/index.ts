import { createHash } from "node:crypto";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type ServerSideEncryption,
} from "@aws-sdk/client-s3";

export {
  captureTenantObjectRestoreInventory,
  compareTenantObjectRestoreInventories,
  summarizeTenantObjectRestoreInventory,
  verifyTenantObjectRestore,
  type S3TenantObjectRestoreVerificationConfig,
  type TenantObjectRestoreComparison,
  type TenantObjectRestoreInventory,
  type TenantObjectRestoreInventorySummary,
  type TenantObjectRestoreScope,
  type TenantObjectRestoreVerificationLimits,
  type TenantObjectVersionRecord,
} from "./restore-verification.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const objectKeyPattern = /^[a-z0-9][a-z0-9._/-]{0,1023}$/u;
const verifiedDeleteRequestTimeoutMs = 15_000;

export interface ImmutableObjectWrite {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly checksumSha256: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface VerifiedObjectRead {
  readonly key: string;
  readonly expectedChecksumSha256: string;
  readonly maximumBytes: number;
  readonly timeoutMs?: number;
}

export interface VerifiedObjectDelete {
  readonly key: string;
  readonly expectedChecksumSha256: string;
}

export interface ImmutableObjectStore {
  putImmutable(input: ImmutableObjectWrite): Promise<"stored" | "already_exists">;
  getVerified(input: VerifiedObjectRead): Promise<Uint8Array>;
  deleteVerified(input: VerifiedObjectDelete): Promise<"deleted" | "already_missing">;
}

export interface S3ObjectStoreConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
  readonly serverSideEncryption?: ServerSideEncryption;
  readonly kmsKeyId?: string;
}

export class ObjectIntegrityError extends Error {
  public constructor(message = "stored object failed integrity verification") {
    super(message);
    this.name = "ObjectIntegrityError";
  }
}

export class ObjectNotFoundError extends Error {
  public constructor() {
    super("stored object was not found");
    this.name = "ObjectNotFoundError";
  }
}

export class ObjectReadTimeoutError extends Error {
  public constructor() {
    super("stored object read exceeded its configured deadline");
    this.name = "ObjectReadTimeoutError";
  }
}

export class S3ImmutableObjectStore implements ImmutableObjectStore {
  readonly #client: S3Client;

  public constructor(private readonly config: S3ObjectStoreConfig) {
    this.#client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  public async putImmutable(input: ImmutableObjectWrite): Promise<"stored" | "already_exists"> {
    validateWrite(input);
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: input.key,
          Body: input.body,
          ContentLength: input.body.byteLength,
          ContentType: input.contentType,
          ChecksumSHA256: Buffer.from(input.checksumSha256, "hex").toString("base64"),
          IfNoneMatch: "*",
          Metadata: {
            ...input.metadata,
            "content-sha256": input.checksumSha256,
          },
          ...(this.config.serverSideEncryption
            ? { ServerSideEncryption: this.config.serverSideEncryption }
            : {}),
          ...(this.config.kmsKeyId ? { SSEKMSKeyId: this.config.kmsKeyId } : {}),
        }),
      );
      return "stored";
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      await this.verifyHead(input);
      return "already_exists";
    }
  }

  public async health(signal: AbortSignal = AbortSignal.timeout(5_000)): Promise<boolean> {
    if (signal.aborted) return false;
    try {
      await this.#client.send(new HeadBucketCommand({ Bucket: this.config.bucket }), {
        abortSignal: signal,
      });
      return !signal.aborted;
    } catch {
      return false;
    }
  }

  public async getVerified(input: VerifiedObjectRead): Promise<Uint8Array> {
    validateRead(input);
    const signal = input.timeoutMs === undefined ? undefined : AbortSignal.timeout(input.timeoutMs);
    let response;
    try {
      response = await this.#client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: input.key }),
        signal ? { abortSignal: signal } : {},
      );
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError();
      if (isAbortError(error)) throw new ObjectReadTimeoutError();
      throw error;
    }
    if (
      response.ContentLength !== undefined &&
      (response.ContentLength < 0 || response.ContentLength > input.maximumBytes)
    ) {
      throw new ObjectIntegrityError("stored object exceeds the configured read limit");
    }
    if (!response.Body) throw new ObjectIntegrityError("stored object has no response body");
    let body: Uint8Array;
    try {
      body = await readBoundedBody(response.Body, input.maximumBytes, signal);
    } catch (error) {
      if (error instanceof ObjectReadTimeoutError || isAbortError(error)) {
        throw new ObjectReadTimeoutError();
      }
      throw error;
    }
    verifyChecksum(body, input.expectedChecksumSha256);
    return body;
  }

  public async deleteVerified(input: VerifiedObjectDelete): Promise<"deleted" | "already_missing"> {
    validateDelete(input);
    let head;
    try {
      head = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: input.key }),
        { abortSignal: AbortSignal.timeout(verifiedDeleteRequestTimeoutMs) },
      );
    } catch (error) {
      if (isNotFound(error)) return "already_missing";
      throw error;
    }
    if (
      head.Metadata?.["content-sha256"] !== input.expectedChecksumSha256 ||
      typeof head.ETag !== "string" ||
      head.ETag.length === 0
    ) {
      throw new ObjectIntegrityError("stored object does not match deletion authority");
    }
    try {
      await this.#client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: input.key,
          IfMatch: head.ETag,
          ...(head.VersionId ? { VersionId: head.VersionId } : {}),
        }),
        { abortSignal: AbortSignal.timeout(verifiedDeleteRequestTimeoutMs) },
      );
    } catch (error) {
      if (isNotFound(error)) return "already_missing";
      if (isPreconditionFailure(error)) {
        throw new ObjectIntegrityError("stored object changed before conditional deletion");
      }
      throw error;
    }
    try {
      await this.#client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: input.key }),
        { abortSignal: AbortSignal.timeout(verifiedDeleteRequestTimeoutMs) },
      );
    } catch (error) {
      if (isNotFound(error)) return "deleted";
      throw error;
    }
    throw new ObjectIntegrityError("stored object remained readable after deletion");
  }

  public close(): void {
    this.#client.destroy();
  }

  private async verifyHead(input: ImmutableObjectWrite): Promise<void> {
    const head = await this.#client.send(
      new HeadObjectCommand({ Bucket: this.config.bucket, Key: input.key }),
    );
    if (
      head.ContentLength !== input.body.byteLength ||
      head.Metadata?.["content-sha256"] !== input.checksumSha256
    ) {
      throw new ObjectIntegrityError("immutable object key already contains different content");
    }
  }
}

interface StoredObject {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly checksumSha256: string;
}

export class InMemoryImmutableObjectStore implements ImmutableObjectStore {
  readonly #objects = new Map<string, StoredObject>();

  public async putImmutable(input: ImmutableObjectWrite): Promise<"stored" | "already_exists"> {
    validateWrite(input);
    const existing = this.#objects.get(input.key);
    if (existing) {
      if (
        existing.checksumSha256 !== input.checksumSha256 ||
        existing.body.byteLength !== input.body.byteLength
      ) {
        throw new ObjectIntegrityError("immutable object key already contains different content");
      }
      return "already_exists";
    }
    this.#objects.set(input.key, {
      body: Uint8Array.from(input.body),
      contentType: input.contentType,
      checksumSha256: input.checksumSha256,
    });
    return "stored";
  }

  public async getVerified(input: VerifiedObjectRead): Promise<Uint8Array> {
    validateRead(input);
    const stored = this.#objects.get(input.key);
    if (!stored) throw new ObjectNotFoundError();
    if (stored.body.byteLength > input.maximumBytes) {
      throw new ObjectIntegrityError("stored object exceeds the configured read limit");
    }
    verifyChecksum(stored.body, input.expectedChecksumSha256);
    return Uint8Array.from(stored.body);
  }

  public async deleteVerified(input: VerifiedObjectDelete): Promise<"deleted" | "already_missing"> {
    validateDelete(input);
    const stored = this.#objects.get(input.key);
    if (!stored) return "already_missing";
    if (stored.checksumSha256 !== input.expectedChecksumSha256) {
      throw new ObjectIntegrityError("stored object does not match deletion authority");
    }
    this.#objects.delete(input.key);
    return "deleted";
  }
}

export function buildTenantObjectKey(
  environment: string,
  organizationId: string,
  purpose: "imports" | "provider-events" | "exports",
  opaqueId: string,
  suffix: string,
): string {
  const key = [environment, organizationId, purpose, opaqueId, suffix].join("/");
  validateObjectKey(key);
  return key;
}

function validateWrite(input: ImmutableObjectWrite): void {
  validateObjectKey(input.key);
  validateChecksum(input.checksumSha256);
  if (input.body.byteLength === 0) throw new TypeError("immutable object body must not be empty");
  if (input.contentType.length < 1 || input.contentType.length > 255) {
    throw new TypeError("immutable object content type is invalid");
  }
  verifyChecksum(input.body, input.checksumSha256);
}

function validateRead(input: VerifiedObjectRead): void {
  validateObjectKey(input.key);
  validateChecksum(input.expectedChecksumSha256);
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1) {
    throw new TypeError("maximumBytes must be a positive safe integer");
  }
  if (
    input.timeoutMs !== undefined &&
    (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 30_000)
  ) {
    throw new TypeError("timeoutMs must be an integer between 100 and 30000");
  }
}

function validateDelete(input: VerifiedObjectDelete): void {
  validateObjectKey(input.key);
  validateChecksum(input.expectedChecksumSha256);
}

function validateObjectKey(key: string): void {
  if (
    !objectKeyPattern.test(key) ||
    key.includes("//") ||
    key.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError("object key is not a safe server-generated key");
  }
}

function validateChecksum(checksum: string): void {
  if (!sha256Pattern.test(checksum)) throw new TypeError("checksum must be lowercase SHA-256");
}

function verifyChecksum(body: Uint8Array, expected: string): void {
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== expected) throw new ObjectIntegrityError();
}

async function readBoundedBody(
  body: unknown,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!isAsyncIterable(body)) {
    throw new ObjectIntegrityError("stored object response is not a readable byte stream");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const iterator = body[Symbol.asyncIterator]();
  for (;;) {
    let step: IteratorResult<unknown>;
    try {
      step = signal ? await nextWithAbort(iterator, signal) : await iterator.next();
    } catch (error) {
      if (signal?.aborted) {
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
        throw new ObjectReadTimeoutError();
      }
      throw error;
    }
    if (step.done) break;
    const value = step.value;
    const chunk =
      typeof value === "string"
        ? Buffer.from(value)
        : value instanceof Uint8Array
          ? Buffer.from(value)
          : undefined;
    if (!chunk) throw new ObjectIntegrityError("stored object returned a non-byte chunk");
    total += chunk.byteLength;
    if (total > maximumBytes) {
      throw new ObjectIntegrityError("stored object exceeds the configured read limit");
    }
    chunks.push(chunk);
  }
  return Uint8Array.from(Buffer.concat(chunks, total));
}

function nextWithAbort(
  iterator: AsyncIterator<unknown>,
  signal: AbortSignal,
): Promise<IteratorResult<unknown>> {
  if (signal.aborted) return Promise.reject(new ObjectReadTimeoutError());
  return new Promise((resolve, reject) => {
    const rejectForAbort = (): void => reject(new ObjectReadTimeoutError());
    signal.addEventListener("abort", rejectForAbort, { once: true });
    void iterator
      .next()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", rejectForAbort);
      });
  });
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

function isPreconditionFailure(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.$metadata.httpStatusCode === 409 || error.$metadata.httpStatusCode === 412)
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
