import { readConfiguredOrigin, readSessionSecret } from "./server-environment";

export type OidcSigningAlgorithm = "RS256" | "PS256" | "ES256";

export interface OidcEnvironment {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly signingAlgorithm: OidcSigningAlgorithm;
  readonly sessionSecret: string;
  readonly authenticationContextValues?: string;
}

const signingAlgorithms = new Set<OidcSigningAlgorithm>(["RS256", "PS256", "ES256"]);
const authenticationContextValuePattern = /^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,99}$/u;

export function readOidcEnvironment(
  options: { allowProductionBuild?: boolean } = {},
): OidcEnvironment {
  const issuer = process.env["OIDC_ISSUER"] ?? "http://127.0.0.1:8080/realms/reconai-development";
  const clientId = process.env["OIDC_CLIENT_ID"] ?? "reconai-web-development";
  const clientSecret = process.env["OIDC_CLIENT_SECRET"] ?? "local-oidc-secret-only";
  const configuredAlgorithm = process.env["OIDC_ID_TOKEN_SIGNING_ALGORITHM"] ?? "RS256";
  const authenticationContextValues = readAuthenticationContextValues(
    process.env["OIDC_ACR_VALUES"],
  );
  if (!signingAlgorithms.has(configuredAlgorithm as OidcSigningAlgorithm)) {
    throw new Error("OIDC_ID_TOKEN_SIGNING_ALGORITHM is not permitted");
  }
  const signingAlgorithm = configuredAlgorithm as OidcSigningAlgorithm;
  const isProductionBuild =
    options.allowProductionBuild === true && process.env["NEXT_PHASE"] === "phase-production-build";
  const issuerUrl = new URL(issuer);
  const canonicalIssuer = issuerUrl.toString().replace(/\/$/u, "");
  const configuredIssuer = issuer.replace(/\/$/u, "");
  if (
    !["http:", "https:"].includes(issuerUrl.protocol) ||
    issuerUrl.username ||
    issuerUrl.password ||
    issuerUrl.search ||
    issuerUrl.hash ||
    issuerUrl.pathname.endsWith("//") ||
    configuredIssuer !== canonicalIssuer
  ) {
    throw new Error(
      "OIDC_ISSUER must be a canonical HTTP(S) issuer URL without credentials, query data, or a fragment",
    );
  }
  if (process.env.NODE_ENV === "production" && !isProductionBuild) {
    const nextAuthOrigin = readConfiguredOrigin("NEXTAUTH_URL", "http://localhost:3000");
    const webOrigin = readConfiguredOrigin("WEB_ORIGIN", "http://localhost:3000");
    if (
      !process.env["NEXTAUTH_URL"] ||
      nextAuthOrigin !== webOrigin ||
      !clientId ||
      clientSecret.length < 16 ||
      clientSecret.includes("local-") ||
      issuerUrl.protocol !== "https:"
    ) {
      throw new Error("production OIDC/session configuration is missing or local-only");
    }
  }
  return {
    issuer: canonicalIssuer,
    clientId,
    clientSecret,
    signingAlgorithm,
    sessionSecret: readSessionSecret(options),
    ...(authenticationContextValues ? { authenticationContextValues } : {}),
  };
}

function readAuthenticationContextValues(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value !== value.trim() || value.length > 200) {
    throw new Error("OIDC_ACR_VALUES must be a bounded, canonical space-delimited list");
  }
  const values = value.split(" ");
  if (
    values.length > 10 ||
    new Set(values).size !== values.length ||
    values.some((item) => !authenticationContextValuePattern.test(item))
  ) {
    throw new Error("OIDC_ACR_VALUES must be a bounded, canonical space-delimited list");
  }
  return values.join(" ");
}
