import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("source-classification writer-fence activation command", () => {
  it("fails closed without echoing maintenance credentials or approval context", () => {
    const databaseSecret = "synthetic-fence-database-secret";
    const requester = "sensitive.operator@example.test";
    const reason = "Sensitive deployment context that must never appear in command output";
    const command = spawnSync(
      process.execPath,
      [
        "--conditions=development",
        "--import",
        "tsx",
        resolve(import.meta.dirname, "activate-source-event-classification-writer-fence.ts"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_MAINTENANCE_URL: `postgresql://reconai_maintenance:${databaseSecret}@127.0.0.1:1/reconai`,
          SOURCE_CLASSIFICATION_FENCE_EXPECTED_DATABASE_SYSTEM_IDENTIFIER: "1234567890123456789",
          SOURCE_CLASSIFICATION_FENCE_REQUESTED_BY: requester,
          SOURCE_CLASSIFICATION_FENCE_REASON: reason,
          SOURCE_CLASSIFICATION_FENCE_CONFIRMATION: "wrong-confirmation",
          SOURCE_CLASSIFICATION_FENCE_ALLOW_NON_LOOPBACK: "false",
        },
      },
    );

    expect(command.status).toBe(1);
    expect(command.stdout).toBe("");
    expect(command.stderr).toBe(
      `${JSON.stringify({
        status: "failed",
        errorCode: "SOURCE_CLASSIFICATION_FENCE_ACTIVATION_FAILED",
      })}\n`,
    );
    expect(command.stderr).not.toContain(databaseSecret);
    expect(command.stderr).not.toContain(requester);
    expect(command.stderr).not.toContain(reason);
  });
});
