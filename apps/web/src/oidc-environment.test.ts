import { afterEach, describe, expect, it, vi } from "vitest";

import { readOidcEnvironment } from "./oidc-environment";

describe("OIDC web environment", { concurrent: false }, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pins the provider signing algorithm to a reviewed allowlist", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("OIDC_ID_TOKEN_SIGNING_ALGORITHM", "HS256");
    expect(() => readOidcEnvironment()).toThrow("not permitted");

    vi.stubEnv("OIDC_ID_TOKEN_SIGNING_ALGORITHM", "PS256");
    expect(readOidcEnvironment()).toMatchObject({ signingAlgorithm: "PS256" });
  });

  it("rejects credentials, query data, fragments, and ambiguous issuer spellings", () => {
    vi.stubEnv("NODE_ENV", "test");
    for (const issuer of [
      "https://user:password@identity.example.test/realms/reconai",
      "https://identity.example.test/realms/reconai?target=attacker",
      "https://identity.example.test/realms/reconai#attacker",
      "file:///tmp/issuer",
      String.raw`https:\identity.example.test\realms\reconai`,
      "https://identity.example.test/realms/../attacker",
      "https://identity.example.test/realms/reconai//",
    ]) {
      vi.stubEnv("OIDC_ISSUER", issuer);
      expect(() => readOidcEnvironment()).toThrow("canonical HTTP(S)");
    }

    vi.stubEnv("OIDC_ISSUER", "https://identity.example.test/realms/reconai/");
    expect(readOidcEnvironment().issuer).toBe("https://identity.example.test/realms/reconai");
  });

  it("accepts only a canonical bounded ACR request list", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("OIDC_ACR_VALUES", "urn:reconai:loa:mfa 2");
    expect(readOidcEnvironment()).toMatchObject({
      authenticationContextValues: "urn:reconai:loa:mfa 2",
    });

    for (const value of [
      " 2",
      "2 ",
      "2  3",
      "2 2",
      "value with spaces and more values than this boundary permits now",
      "invalid?query",
    ]) {
      vi.stubEnv("OIDC_ACR_VALUES", value);
      expect(() => readOidcEnvironment()).toThrow("OIDC_ACR_VALUES");
    }
  });

  it("rejects production plaintext identity transport", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("OIDC_ISSUER", "http://identity.example.test/realms/reconai");
    vi.stubEnv("OIDC_CLIENT_ID", "reconai-web");
    vi.stubEnv("OIDC_CLIENT_SECRET", "synthetic-production-client-secret");
    vi.stubEnv("SESSION_SECRET", "synthetic-production-session-secret-over-thirty-two-characters");
    vi.stubEnv("NEXTAUTH_URL", "https://app.example.test");
    vi.stubEnv("WEB_ORIGIN", "https://app.example.test");
    expect(() => readOidcEnvironment()).toThrow("production OIDC/session configuration");
  });
});
