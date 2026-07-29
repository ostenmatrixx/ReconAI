import { PostgresSourceEventClassificationRepairRepository } from "@workspace/database";
import { S3ImmutableObjectStore } from "@workspace/object-storage";
import postgres from "postgres";
import { z } from "zod";

import {
  assertLoopback,
  assertMaintenanceDatabaseNetworkBoundary,
  containsControlCharacter,
  databaseSystemIdentifier,
  sha256,
  validatedMaintenanceDatabaseUrl,
} from "./maintenance-command-security.js";
import {
  SourceEventClassificationRepairError,
  executeSourceEventClassificationRepairBatch,
} from "./source-event-classification-repair.js";

const exactConfirmation = "REPAIR-INTEGRITY-VERIFIED-SOURCE-CLASSIFICATIONS";
const inputSchema = z
  .object({
    DATABASE_MAINTENANCE_URL: z.url(),
    SOURCE_CLASSIFICATION_REPAIR_EXPECTED_DATABASE_SYSTEM_IDENTIFIER: z
      .string()
      .regex(/^[1-9][0-9]{0,19}$/u),
    SOURCE_CLASSIFICATION_REPAIR_REQUESTED_BY: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9@._:/-]{2,99}$/u),
    SOURCE_CLASSIFICATION_REPAIR_REASON: z
      .string()
      .min(20)
      .max(500)
      .refine((value) => !containsControlCharacter(value)),
    SOURCE_CLASSIFICATION_REPAIR_CONFIRMATION: z.literal(exactConfirmation),
    SOURCE_CLASSIFICATION_REPAIR_MAXIMUM_EVENTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
    SOURCE_CLASSIFICATION_REPAIR_REQUIRE_ZERO: z.enum(["true", "false"]).default("true"),
    SOURCE_CLASSIFICATION_REPAIR_ALLOW_NON_LOOPBACK: z.enum(["true", "false"]).default("false"),
    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().min(1).max(100),
    S3_BUCKET: z.string().min(3).max(255),
    S3_ACCESS_KEY_ID: z.string().min(1).max(1024),
    S3_SECRET_ACCESS_KEY: z.string().min(1).max(4096),
    S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true"),
  })
  .strict();

await main().catch((error: unknown) => {
  const errorCode =
    error instanceof SourceEventClassificationRepairError
      ? error.code
      : "SOURCE_CLASSIFICATION_REPAIR_FAILED";
  process.stderr.write(`${JSON.stringify({ status: "failed", errorCode })}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const parsed = inputSchema.safeParse(selectEnvironment(process.env));
  if (!parsed.success) throw new Error("source classification repair environment is invalid");
  const input = parsed.data;
  const databaseUrl = validatedMaintenanceDatabaseUrl(input.DATABASE_MAINTENANCE_URL);
  const objectEndpoint = validatedObjectEndpoint(input.S3_ENDPOINT);
  const allowNonLoopback = input.SOURCE_CLASSIFICATION_REPAIR_ALLOW_NON_LOOPBACK === "true";
  assertMaintenanceDatabaseNetworkBoundary(databaseUrl, allowNonLoopback);
  if (!allowNonLoopback) {
    assertLoopback(objectEndpoint, "object storage");
  } else if (objectEndpoint.protocol !== "https:") {
    throw new Error(
      "approved non-loopback classification repair requires PostgreSQL verify-full and HTTPS object storage",
    );
  }

  const database = postgres(databaseUrl.href, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 5,
  });
  const objectStore = new S3ImmutableObjectStore({
    endpoint: objectEndpoint.href,
    region: input.S3_REGION,
    bucket: input.S3_BUCKET,
    accessKeyId: input.S3_ACCESS_KEY_ID,
    secretAccessKey: input.S3_SECRET_ACCESS_KEY,
    forcePathStyle: input.S3_FORCE_PATH_STYLE === "true",
  });
  try {
    const systemIdentifier = await databaseSystemIdentifier(database);
    if (
      systemIdentifier !== input.SOURCE_CLASSIFICATION_REPAIR_EXPECTED_DATABASE_SYSTEM_IDENTIFIER
    ) {
      throw new Error("classification repair database identifier does not match approval");
    }
    const result = await executeSourceEventClassificationRepairBatch({
      repository: new PostgresSourceEventClassificationRepairRepository(database),
      objectStore,
      requestedBy: input.SOURCE_CLASSIFICATION_REPAIR_REQUESTED_BY,
      reason: input.SOURCE_CLASSIFICATION_REPAIR_REASON,
      batchSize: input.SOURCE_CLASSIFICATION_REPAIR_MAXIMUM_EVENTS,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: result.complete ? "complete" : "incomplete",
          databaseSystemIdentifier: systemIdentifier,
          repairRunIdSha256: sha256(result.repairRunId),
          examined: result.examined,
          classified: result.classified,
          alreadyClassified: result.alreadyClassified,
          remainingGaps: result.remainingGaps,
          remainingRepairableGaps: result.remainingRepairableGaps,
          organizationIdsRecorded: false,
          sourceEventIdsRecorded: false,
          connectionIdsRecorded: false,
          objectKeysRecorded: false,
          payloadDigestsRecorded: false,
          requestedByRecordedInOutput: false,
          reasonRecordedInOutput: false,
          credentialsRecorded: false,
        },
        null,
        2,
      )}\n`,
    );
    if (input.SOURCE_CLASSIFICATION_REPAIR_REQUIRE_ZERO === "true" && !result.complete) {
      process.exitCode = 2;
    }
  } finally {
    objectStore.close();
    await database.end({ timeout: 5 });
  }
}

function selectEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<keyof z.input<typeof inputSchema>, string | undefined> {
  return {
    DATABASE_MAINTENANCE_URL: environment.DATABASE_MAINTENANCE_URL,
    SOURCE_CLASSIFICATION_REPAIR_EXPECTED_DATABASE_SYSTEM_IDENTIFIER:
      environment.SOURCE_CLASSIFICATION_REPAIR_EXPECTED_DATABASE_SYSTEM_IDENTIFIER,
    SOURCE_CLASSIFICATION_REPAIR_REQUESTED_BY:
      environment.SOURCE_CLASSIFICATION_REPAIR_REQUESTED_BY,
    SOURCE_CLASSIFICATION_REPAIR_REASON: environment.SOURCE_CLASSIFICATION_REPAIR_REASON,
    SOURCE_CLASSIFICATION_REPAIR_CONFIRMATION:
      environment.SOURCE_CLASSIFICATION_REPAIR_CONFIRMATION,
    SOURCE_CLASSIFICATION_REPAIR_MAXIMUM_EVENTS:
      environment.SOURCE_CLASSIFICATION_REPAIR_MAXIMUM_EVENTS,
    SOURCE_CLASSIFICATION_REPAIR_REQUIRE_ZERO:
      environment.SOURCE_CLASSIFICATION_REPAIR_REQUIRE_ZERO,
    SOURCE_CLASSIFICATION_REPAIR_ALLOW_NON_LOOPBACK:
      environment.SOURCE_CLASSIFICATION_REPAIR_ALLOW_NON_LOOPBACK,
    S3_ENDPOINT: environment.S3_ENDPOINT,
    S3_REGION: environment.S3_REGION,
    S3_BUCKET: environment.S3_BUCKET,
    S3_ACCESS_KEY_ID: environment.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: environment.S3_SECRET_ACCESS_KEY,
    S3_FORCE_PATH_STYLE: environment.S3_FORCE_PATH_STYLE,
  };
}

function validatedObjectEndpoint(value: string): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("classification repair object endpoint is invalid");
  }
  return url;
}
