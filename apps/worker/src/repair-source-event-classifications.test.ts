import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("source-classification repair command boundary", () => {
  it("fails with a fixed redacted error when maintenance authority is invalid", () => {
    const databaseSecret = "database-password-must-not-appear";
    const objectSecret = "object-secret-must-not-appear";
    const requestedBy = "operator-identity-must-not-appear";
    const reason = "approved reason text must not appear in command failure";
    const result = spawnSync(
      process.execPath,
      ["--conditions=development", "--import", "tsx", "src/repair-source-event-classifications.ts"],
      {
        cwd: resolve(import.meta.dirname, ".."),
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          DATABASE_MAINTENANCE_URL: `postgresql://reconai_maintenance:${databaseSecret}@127.0.0.1:1/reconai`,
          SOURCE_CLASSIFICATION_REPAIR_EXPECTED_DATABASE_SYSTEM_IDENTIFIER: "123456789",
          SOURCE_CLASSIFICATION_REPAIR_REQUESTED_BY: requestedBy,
          SOURCE_CLASSIFICATION_REPAIR_REASON: reason,
          SOURCE_CLASSIFICATION_REPAIR_CONFIRMATION: "WRONG-CONFIRMATION",
          S3_ENDPOINT: "http://127.0.0.1:1",
          S3_REGION: "test",
          S3_BUCKET: "reconai-test",
          S3_ACCESS_KEY_ID: "synthetic-access",
          S3_SECRET_ACCESS_KEY: objectSecret,
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      JSON.stringify({
        status: "failed",
        errorCode: "SOURCE_CLASSIFICATION_REPAIR_FAILED",
      }),
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(databaseSecret);
    expect(`${result.stdout}${result.stderr}`).not.toContain(objectSecret);
    expect(`${result.stdout}${result.stderr}`).not.toContain(requestedBy);
    expect(`${result.stdout}${result.stderr}`).not.toContain(reason);
  });
});
