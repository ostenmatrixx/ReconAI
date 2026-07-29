import postgres from "postgres";
import { z } from "zod";

import {
  captureDatabaseRestoreSnapshot,
  compareDatabaseRestoreSnapshots,
} from "./restore-verification.js";

const confirmation = "COMPARE-ISOLATED-RESTORE";
const inputSchema = z.object({
  DATABASE_BACKUP_SOURCE_URL: z.url(),
  DATABASE_RESTORE_URL: z.url(),
  BACKUP_RESTORE_VERIFY_CONFIRMATION: z.literal(confirmation),
  BACKUP_RESTORE_VERIFY_ALLOW_NON_LOOPBACK: z.enum(["true", "false"]).optional().default("false"),
});

const input = inputSchema.parse(process.env);
const sourceUrl = validatedPostgresUrl(input.DATABASE_BACKUP_SOURCE_URL);
const restoredUrl = validatedPostgresUrl(input.DATABASE_RESTORE_URL);
if (sourceUrl.href === restoredUrl.href) {
  throw new Error("backup source and restored database URLs must differ");
}
const allowNonLoopback = input.BACKUP_RESTORE_VERIFY_ALLOW_NON_LOOPBACK === "true";
if (!allowNonLoopback) {
  assertLoopback(sourceUrl);
  assertLoopback(restoredUrl);
}

const source = postgres(sourceUrl.href, connectionOptions());
const restored = postgres(restoredUrl.href, connectionOptions());
try {
  const [sourceSnapshot, restoredSnapshot] = await Promise.all([
    captureDatabaseRestoreSnapshot(source),
    captureDatabaseRestoreSnapshot(restored),
  ]);
  const comparison = compareDatabaseRestoreSnapshots(sourceSnapshot, restoredSnapshot);
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        source: sourceSnapshot,
        restored: restoredSnapshot,
        comparison,
        customerDataRecorded: false,
      },
      null,
      2,
    )}\n`,
  );
  if (!comparison.matches) process.exitCode = 1;
} finally {
  await Promise.all([source.end({ timeout: 5 }), restored.end({ timeout: 5 })]);
}

function validatedPostgresUrl(value: string): URL {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("restore verification URLs must use postgresql");
  }
  if (!url.hostname || !url.pathname || url.pathname === "/") {
    throw new Error("restore verification URLs require a host and database");
  }
  return url;
}

function assertLoopback(url: URL): void {
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(
      "restore verification defaults to loopback; explicitly allow an approved non-loopback drill",
    );
  }
}

function connectionOptions(): {
  readonly max: 1;
  readonly connect_timeout: 5;
  readonly idle_timeout: 5;
} {
  return { max: 1, connect_timeout: 5, idle_timeout: 5 };
}
