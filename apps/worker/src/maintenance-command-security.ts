import { createHash } from "node:crypto";

import type { Sql } from "postgres";
import { z } from "zod";

export function validatedMaintenanceDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname ||
    url.pathname === "/" ||
    url.hash
  ) {
    throw new Error("maintenance database URL is invalid");
  }
  return url;
}

export function assertMaintenanceDatabaseNetworkBoundary(
  url: URL,
  allowNonLoopback: boolean,
): void {
  if (!allowNonLoopback) {
    assertLoopback(url, "database");
    return;
  }
  if (url.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("approved non-loopback maintenance requires PostgreSQL verify-full");
  }
}

export function assertLoopback(url: URL, target: string): void {
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(`maintenance ${target} defaults to loopback; approve non-loopback explicitly`);
  }
}

export async function databaseSystemIdentifier(sql: Sql): Promise<string> {
  const rows = await sql`select system_identifier::text from pg_control_system()`;
  return z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/u)
    .parse(rows[0]?.["system_identifier"]);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) return true;
  }
  return false;
}
