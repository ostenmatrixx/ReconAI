import type { DefaultJWT } from "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    reauthenticationRequired?: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT extends DefaultJWT {
    apiAccessToken?: string;
    apiAccessTokenExpiresAt?: number;
    apiRefreshToken?: string;
    apiIdToken?: string;
    apiOidcIssuer?: string;
    apiOidcSubject?: string;
    apiOidcSessionId?: string;
    apiSessionStartedAt?: number;
    providerTokenError?:
      | "MISSING_REFRESH_TOKEN"
      | "REFRESH_FAILED"
      | "SESSION_IDENTITY_INVALID"
      | "SESSION_REVOKED"
      | "SESSION_REVOCATION_UNAVAILABLE";
  }
}
