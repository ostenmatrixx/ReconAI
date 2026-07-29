import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { proxy } from "./proxy";

describe("web security proxy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits and forwards one strict production policy with a fresh nonce", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OIDC_ISSUER", "https://identity.example/realms/reconai");

    const first = proxy(new NextRequest("https://reconai.example/"));
    const second = proxy(new NextRequest("https://reconai.example/"));
    const firstPolicy = first.headers.get("content-security-policy");
    const secondPolicy = second.headers.get("content-security-policy");
    const firstNonce = nonceFrom(firstPolicy);
    const secondNonce = nonceFrom(secondPolicy);

    expect(firstPolicy).toContain(`style-src 'self' 'nonce-${firstNonce}'`);
    expect(firstPolicy).toContain("style-src-attr 'none'");
    expect(firstPolicy).toContain("form-action 'self' https://identity.example");
    expect(firstPolicy).not.toContain("'unsafe-inline'");
    expect(first.headers.get("x-middleware-request-content-security-policy")).toBe(firstPolicy);
    expect(first.headers.get("x-middleware-request-x-nonce")).toBe(firstNonce);
    expect(secondNonce).not.toBe(firstNonce);
  });
});

function nonceFrom(policy: string | null): string {
  const nonce = /script-src [^;]*'nonce-([^']+)'/u.exec(policy ?? "")?.[1];
  if (!nonce) throw new Error("content security policy nonce is missing");
  return nonce;
}
