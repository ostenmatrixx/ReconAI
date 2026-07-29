import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { shouldSkipRepositoryHookInstall } from "./install-hooks.mjs";

describe("repository hook installation boundary", () => {
  it("accepts only the exact documented bypass value", () => {
    expect(shouldSkipRepositoryHookInstall({ LEFTHOOK: "0" })).toBe(true);
    expect(shouldSkipRepositoryHookInstall({ LEFTHOOK: "1" })).toBe(false);
    expect(shouldSkipRepositoryHookInstall({ LEFTHOOK: "false" })).toBe(false);
    expect(shouldSkipRepositoryHookInstall({})).toBe(false);
  });

  it("exits successfully without invoking Lefthook under the exact bypass", () => {
    const script = fileURLToPath(new URL("./install-hooks.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, LEFTHOOK: "0", PATH: "" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "Repository hook installation skipped by exact LEFTHOOK=0 boundary.\n",
    );
    expect(result.stderr).toBe("");
  });
});
