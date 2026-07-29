import { randomUUID } from "node:crypto";

import { PostgresSourceEventClassificationWriterFenceRepository } from "@workspace/database";
import postgres from "postgres";
import { z } from "zod";

import {
  assertMaintenanceDatabaseNetworkBoundary,
  containsControlCharacter,
  databaseSystemIdentifier,
  sha256,
  validatedMaintenanceDatabaseUrl,
} from "./maintenance-command-security.js";

const exactConfirmation = "ENABLE-SOURCE-CLASSIFICATION-WRITER-FENCE";
const inputSchema = z
  .object({
    DATABASE_MAINTENANCE_URL: z.url(),
    SOURCE_CLASSIFICATION_FENCE_EXPECTED_DATABASE_SYSTEM_IDENTIFIER: z
      .string()
      .regex(/^[1-9][0-9]{0,19}$/u),
    SOURCE_CLASSIFICATION_FENCE_REQUESTED_BY: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9@._:/-]{2,99}$/u),
    SOURCE_CLASSIFICATION_FENCE_REASON: z
      .string()
      .min(20)
      .max(500)
      .refine((value) => !containsControlCharacter(value)),
    SOURCE_CLASSIFICATION_FENCE_CONFIRMATION: z.literal(exactConfirmation),
    SOURCE_CLASSIFICATION_FENCE_ALLOW_NON_LOOPBACK: z.enum(["true", "false"]).default("false"),
  })
  .strict();

await main().catch(() => {
  process.stderr.write(
    `${JSON.stringify({
      status: "failed",
      errorCode: "SOURCE_CLASSIFICATION_FENCE_ACTIVATION_FAILED",
    })}\n`,
  );
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const parsed = inputSchema.safeParse(selectEnvironment(process.env));
  if (!parsed.success) throw new Error("classification writer fence environment is invalid");
  const input = parsed.data;
  const databaseUrl = validatedMaintenanceDatabaseUrl(input.DATABASE_MAINTENANCE_URL);
  assertMaintenanceDatabaseNetworkBoundary(
    databaseUrl,
    input.SOURCE_CLASSIFICATION_FENCE_ALLOW_NON_LOOPBACK === "true",
  );
  const database = postgres(databaseUrl.href, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 5,
  });
  try {
    const systemIdentifier = await databaseSystemIdentifier(database);
    if (
      systemIdentifier !== input.SOURCE_CLASSIFICATION_FENCE_EXPECTED_DATABASE_SYSTEM_IDENTIFIER
    ) {
      throw new Error("classification writer fence database identifier does not match approval");
    }
    const result = await new PostgresSourceEventClassificationWriterFenceRepository(
      database,
    ).activate({
      activationId: randomUUID(),
      requestedBy: input.SOURCE_CLASSIFICATION_FENCE_REQUESTED_BY,
      reason: input.SOURCE_CLASSIFICATION_FENCE_REASON,
      confirmation: exactConfirmation,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: result.changed ? "activated" : "already_active",
          databaseSystemIdentifier: systemIdentifier,
          activationIdSha256: sha256(result.activationId ?? ""),
          fenceVersion: result.fenceVersion,
          enabled: result.enabled,
          requestedByRecordedInOutput: false,
          reasonRecordedInOutput: false,
          credentialsRecorded: false,
          organizationIdsRecorded: false,
          sourceEventIdsRecorded: false,
          objectKeysRecorded: false,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await database.end({ timeout: 5 });
  }
}

function selectEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<keyof z.input<typeof inputSchema>, string | undefined> {
  return {
    DATABASE_MAINTENANCE_URL: environment.DATABASE_MAINTENANCE_URL,
    SOURCE_CLASSIFICATION_FENCE_EXPECTED_DATABASE_SYSTEM_IDENTIFIER:
      environment.SOURCE_CLASSIFICATION_FENCE_EXPECTED_DATABASE_SYSTEM_IDENTIFIER,
    SOURCE_CLASSIFICATION_FENCE_REQUESTED_BY: environment.SOURCE_CLASSIFICATION_FENCE_REQUESTED_BY,
    SOURCE_CLASSIFICATION_FENCE_REASON: environment.SOURCE_CLASSIFICATION_FENCE_REASON,
    SOURCE_CLASSIFICATION_FENCE_CONFIRMATION: environment.SOURCE_CLASSIFICATION_FENCE_CONFIRMATION,
    SOURCE_CLASSIFICATION_FENCE_ALLOW_NON_LOOPBACK:
      environment.SOURCE_CLASSIFICATION_FENCE_ALLOW_NON_LOOPBACK,
  };
}
