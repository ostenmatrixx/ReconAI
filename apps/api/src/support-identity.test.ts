import { Buffer } from "node:buffer";

import { AuthorizationError } from "@workspace/domain";
import { describe, expect, it } from "vitest";

import {
  ConfiguredSupportIdentityAuthorizer,
  type SupportIdentityAuthorizationOptions,
} from "./support-identity.js";

const enabled = {
  enabled: true,
  requiredGroup: "/reconai/support",
  requiredAuthenticationContext: "urn:reconai:loa:mfa",
  identityHmacKey: Buffer.alloc(32, 37).toString("base64url"),
} as const satisfies SupportIdentityAuthorizationOptions;

describe("support identity authorization", () => {
  it("requires the exact configured group and MFA assurance context", () => {
    const authorizer = new ConfiguredSupportIdentityAuthorizer(enabled);
    const digest = authorizer.authorize({
      issuer: "https://identity.example.test/realms/reconai",
      subject: "support-user-1",
      emailVerified: false,
      groups: ["/reconai/support"],
      authenticationContext: "urn:reconai:loa:mfa",
    });
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);

    for (const identity of [
      {
        issuer: "https://identity.example.test/realms/reconai",
        subject: "support-user-1",
        emailVerified: false,
        groups: ["/reconai/support-child"],
        authenticationContext: "urn:reconai:loa:mfa",
      },
      {
        issuer: "https://identity.example.test/realms/reconai",
        subject: "support-user-1",
        emailVerified: false,
        groups: ["/reconai/support"],
        authenticationContext: "urn:reconai:loa:password",
      },
      {
        issuer: "https://identity.example.test/realms/reconai",
        subject: "support-user-1",
        emailVerified: false,
      },
    ]) {
      expect(() => authorizer.authorize(identity)).toThrow(AuthorizationError);
    }
  });

  it("stays fail-closed when support access is disabled", () => {
    const authorizer = new ConfiguredSupportIdentityAuthorizer({ enabled: false });
    expect(() =>
      authorizer.authorize({
        issuer: "https://identity.example.test/realms/reconai",
        subject: "support-user-1",
        emailVerified: false,
        groups: ["/reconai/support"],
        authenticationContext: "urn:reconai:loa:mfa",
      }),
    ).toThrow(AuthorizationError);
  });

  it("pseudonymizes the full issuer-subject pair with a dedicated key", () => {
    const identity = {
      issuer: "https://identity.example.test/realms/reconai",
      subject: "support-user-1",
      emailVerified: false,
      groups: ["/reconai/support"],
      authenticationContext: "urn:reconai:loa:mfa",
    } as const;
    const first = new ConfiguredSupportIdentityAuthorizer(enabled).authorize(identity);
    const second = new ConfiguredSupportIdentityAuthorizer({
      ...enabled,
      identityHmacKey: Buffer.alloc(32, 38).toString("base64url"),
    }).authorize(identity);
    expect(first).not.toBe(second);
    expect(first).not.toContain(identity.subject);
  });
});
