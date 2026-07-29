import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  AuthorizationError,
  SupportIdentityDigestSchema,
  type SupportIdentityDigest,
} from "@workspace/domain";

import type { VerifiedIdentity } from "./auth.js";

export type SupportIdentityAuthorizationOptions =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly requiredGroup: string;
      readonly requiredAuthenticationContext: string;
      readonly identityHmacKey: string;
    };

export interface SupportIdentityAuthorizer {
  authorize(identity: VerifiedIdentity): SupportIdentityDigest;
}

/**
 * Separates platform support identity from tenant membership. Eligibility is asserted by the
 * configured OIDC group and exact MFA assurance context; the durable identity locator is a keyed
 * digest, never the raw issuer or subject.
 */
export class ConfiguredSupportIdentityAuthorizer implements SupportIdentityAuthorizer {
  readonly #configuration:
    | { readonly enabled: false }
    | {
        readonly enabled: true;
        readonly requiredGroup: string;
        readonly requiredAuthenticationContext: string;
        readonly identityHmacKey: Buffer;
      };

  public constructor(options: SupportIdentityAuthorizationOptions) {
    this.#configuration = options.enabled
      ? {
          enabled: true,
          requiredGroup: boundedClaimValue(options.requiredGroup, "support OIDC group"),
          requiredAuthenticationContext: boundedClaimValue(
            options.requiredAuthenticationContext,
            "support OIDC authentication context",
          ),
          identityHmacKey: decodeKey(options.identityHmacKey),
        }
      : { enabled: false };
  }

  public authorize(identity: VerifiedIdentity): SupportIdentityDigest {
    const configuration = this.#configuration;
    if (
      !configuration.enabled ||
      !identity.groups?.some((group) => exactEqual(group, configuration.requiredGroup)) ||
      !identity.authenticationContext ||
      !exactEqual(identity.authenticationContext, configuration.requiredAuthenticationContext)
    ) {
      throw new AuthorizationError();
    }
    return SupportIdentityDigestSchema.parse(
      createHmac("sha256", configuration.identityHmacKey)
        .update(identity.issuer, "utf8")
        .update("\0", "utf8")
        .update(identity.subject, "utf8")
        .digest("hex"),
    );
  }
}

function decodeKey(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43,86}$/u.test(value)) {
    throw new TypeError("support identity HMAC key is invalid");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length < 32 || decoded.length > 64 || decoded.toString("base64url") !== value) {
    throw new TypeError("support identity HMAC key is invalid");
  }
  return decoded;
}

function boundedClaimValue(value: string, name: string): string {
  if (value.length < 1 || value.length > 200 || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function exactEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
