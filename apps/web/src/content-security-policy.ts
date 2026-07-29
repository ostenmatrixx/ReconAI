const cspNoncePattern = /^[A-Za-z0-9+/_=-]{16,128}$/u;

/**
 * Builds the browser policy from an internally generated, per-request nonce.
 *
 * Production denies style attributes and permits inline style elements only when Next.js attaches
 * the matching nonce. Development retains the framework's inline-style and eval compatibility
 * paths; neither exception is emitted in production.
 */
export function buildContentSecurityPolicy(
  nonce: string,
  isProduction: boolean,
  oidcIssuer: string,
): string {
  if (!cspNoncePattern.test(nonce)) {
    throw new Error("content security policy nonce is invalid");
  }
  const oidcOrigin = contentSecurityPolicyOidcOrigin(oidcIssuer, isProduction);

  return [
    "default-src 'self'",
    "base-uri 'self'",
    `form-action 'self' ${oidcOrigin}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isProduction ? "" : " 'unsafe-eval'"}`,
    isProduction ? `style-src 'self' 'nonce-${nonce}'` : "style-src 'self' 'unsafe-inline'",
    isProduction ? "style-src-attr 'none'" : "",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    isProduction ? "upgrade-insecure-requests" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function contentSecurityPolicyOidcOrigin(issuer: string, isProduction: boolean): string {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error("content security policy OIDC issuer is invalid");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (isProduction && url.protocol !== "https:")
  ) {
    throw new Error("content security policy OIDC issuer is invalid");
  }
  return url.origin;
}
