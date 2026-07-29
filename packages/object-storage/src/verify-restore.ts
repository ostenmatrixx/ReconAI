import { OrganizationIdSchema } from "@workspace/domain";
import { z } from "zod";

import type { S3ObjectStoreConfig } from "./index.js";
import {
  summarizeTenantObjectRestoreInventory,
  verifyTenantObjectRestore,
} from "./restore-verification.js";

const confirmation = "COMPARE-ISOLATED-TENANT-OBJECTS";
const inputSchema = z.object({
  OBJECT_BACKUP_SOURCE_ENDPOINT: z.url(),
  OBJECT_BACKUP_SOURCE_REGION: z.string().min(1).max(100),
  OBJECT_BACKUP_SOURCE_BUCKET: z.string().min(3).max(63),
  OBJECT_BACKUP_SOURCE_ACCESS_KEY_ID: z.string().min(1).max(512),
  OBJECT_BACKUP_SOURCE_SECRET_ACCESS_KEY: z.string().min(1).max(512),
  OBJECT_RESTORE_ENDPOINT: z.url(),
  OBJECT_RESTORE_REGION: z.string().min(1).max(100),
  OBJECT_RESTORE_BUCKET: z.string().min(3).max(63),
  OBJECT_RESTORE_ACCESS_KEY_ID: z.string().min(1).max(512),
  OBJECT_RESTORE_SECRET_ACCESS_KEY: z.string().min(1).max(512),
  OBJECT_RESTORE_ENVIRONMENT: z.string(),
  OBJECT_RESTORE_ORGANIZATION_ID: z.uuid(),
  OBJECT_RESTORE_VERIFY_CONFIRMATION: z.literal(confirmation),
  OBJECT_RESTORE_VERIFY_ALLOW_NON_LOOPBACK: z.enum(["true", "false"]).optional().default("false"),
  OBJECT_RESTORE_VERIFY_MAXIMUM_VERSIONS: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .optional()
    .default(10_000),
  OBJECT_RESTORE_VERIFY_MAXIMUM_OBJECT_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1024 * 1024 * 1024)
    .optional()
    .default(10 * 1024 * 1024),
  OBJECT_RESTORE_VERIFY_MAXIMUM_TOTAL_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1024 * 1024 * 1024 * 1024)
    .optional()
    .default(1024 * 1024 * 1024),
  OBJECT_RESTORE_VERIFY_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .optional()
    .default(15_000),
});

const input = inputSchema.parse(process.env);
const sourceEndpoint = validatedEndpoint(input.OBJECT_BACKUP_SOURCE_ENDPOINT);
const restoredEndpoint = validatedEndpoint(input.OBJECT_RESTORE_ENDPOINT);
if (
  sourceEndpoint.href === restoredEndpoint.href &&
  input.OBJECT_BACKUP_SOURCE_BUCKET === input.OBJECT_RESTORE_BUCKET
) {
  throw new Error("object backup source and restored bucket must differ");
}
const allowNonLoopback = input.OBJECT_RESTORE_VERIFY_ALLOW_NON_LOOPBACK === "true";
if (!allowNonLoopback) {
  assertLoopback(sourceEndpoint);
  assertLoopback(restoredEndpoint);
} else if (sourceEndpoint.protocol !== "https:" || restoredEndpoint.protocol !== "https:") {
  throw new Error("approved non-loopback object restore verification requires HTTPS endpoints");
}

const result = await verifyTenantObjectRestore(
  {
    source: objectConfig(
      sourceEndpoint,
      input.OBJECT_BACKUP_SOURCE_REGION,
      input.OBJECT_BACKUP_SOURCE_BUCKET,
      input.OBJECT_BACKUP_SOURCE_ACCESS_KEY_ID,
      input.OBJECT_BACKUP_SOURCE_SECRET_ACCESS_KEY,
    ),
    restored: objectConfig(
      restoredEndpoint,
      input.OBJECT_RESTORE_REGION,
      input.OBJECT_RESTORE_BUCKET,
      input.OBJECT_RESTORE_ACCESS_KEY_ID,
      input.OBJECT_RESTORE_SECRET_ACCESS_KEY,
    ),
  },
  {
    environment: input.OBJECT_RESTORE_ENVIRONMENT,
    organizationId: OrganizationIdSchema.parse(input.OBJECT_RESTORE_ORGANIZATION_ID),
    limits: {
      maximumVersions: input.OBJECT_RESTORE_VERIFY_MAXIMUM_VERSIONS,
      maximumObjectBytes: input.OBJECT_RESTORE_VERIFY_MAXIMUM_OBJECT_BYTES,
      maximumTotalBytes: input.OBJECT_RESTORE_VERIFY_MAXIMUM_TOTAL_BYTES,
      requestTimeoutMs: input.OBJECT_RESTORE_VERIFY_REQUEST_TIMEOUT_MS,
    },
  },
);

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      source: summarizeTenantObjectRestoreInventory(result.source),
      restored: summarizeTenantObjectRestoreInventory(result.restored),
      comparison: result.comparison,
      objectKeysRecorded: false,
      objectBodiesRecorded: false,
      credentialsRecorded: false,
    },
    null,
    2,
  )}\n`,
);
if (!result.comparison.matches) process.exitCode = 1;

function objectConfig(
  endpoint: URL,
  region: string,
  bucket: string,
  accessKeyId: string,
  secretAccessKey: string,
): S3ObjectStoreConfig {
  return {
    endpoint: endpoint.href,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: true,
  };
}

function validatedEndpoint(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    throw new Error("object restore verification endpoints must use HTTP or HTTPS");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("object restore verification endpoints must not contain credentials or paths");
  }
  return url;
}

function assertLoopback(url: URL): void {
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(
      "object restore verification defaults to loopback; explicitly allow an approved non-loopback drill",
    );
  }
}
