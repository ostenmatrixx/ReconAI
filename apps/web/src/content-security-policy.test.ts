import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy } from "./content-security-policy";

const nonce = "VGVzdC1ub25jZS0wMDAwMDAwMDAwMA==";

describe("content security policy", () => {
  it("uses nonce-bound styles and denies style attributes in production", () => {
    const policy = buildContentSecurityPolicy(
      nonce,
      true,
      "https://identity.example/realms/reconai",
    );

    expect(policy).toContain("form-action 'self' https://identity.example");
    expect(policy).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(policy).toContain(`style-src 'self' 'nonce-${nonce}'`);
    expect(policy).toContain("style-src-attr 'none'");
    expect(policy).toContain("upgrade-insecure-requests");
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it("limits framework compatibility exceptions to development", () => {
    const policy = buildContentSecurityPolicy(
      nonce,
      false,
      "http://localhost:8080/realms/reconai-development",
    );

    expect(policy).toContain("form-action 'self' http://localhost:8080");
    expect(policy).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`);
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).not.toContain("style-src-attr");
    expect(policy).not.toContain("upgrade-insecure-requests");
  });

  it.each(["", "short", "nonce\ninjection", "<style-nonce>"])(
    "rejects a malformed nonce before header construction",
    (invalidNonce) => {
      expect(() =>
        buildContentSecurityPolicy(invalidNonce, true, "https://identity.example/realms/reconai"),
      ).toThrow("content security policy nonce is invalid");
    },
  );

  it("rejects an invalid or non-HTTPS production OIDC form-action origin", () => {
    for (const issuer of [
      "not-a-url",
      "https://user:password@identity.example/realms/reconai",
      "https://identity.example/realms/reconai?tenant=untrusted",
      "http://identity.example/realms/reconai",
    ]) {
      expect(() => buildContentSecurityPolicy(nonce, true, issuer)).toThrow(
        "content security policy OIDC issuer is invalid",
      );
    }
  });

  it("keeps production UI source free of inline style dependencies", () => {
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const files = [
      ...productionSourceFiles(join(repositoryRoot, "apps/web/src")),
      ...productionSourceFiles(join(repositoryRoot, "packages/ui/src")),
    ];
    const violations = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return /\bstyle\s*=\s*(?:\{|["'])|<style(?:\s|>)|dangerouslySetInnerHTML/iu.test(source)
        ? [file]
        : [];
    });

    expect(violations).toEqual([]);
  });
});

function productionSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSourceFiles(path);
    return /\.(?:ts|tsx)$/u.test(entry.name) && !/\.test\.(?:ts|tsx)$/u.test(entry.name)
      ? [path]
      : [];
  });
}
