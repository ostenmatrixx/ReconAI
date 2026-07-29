const forbiddenPaths = [
  /^\.env(?:\.|$)/u,
  /(^|\/)(?:customer|production|real)[-_ ]?data(?:\/|$)/iu,
  /(^|\/)fixtures\/(?:customer|production|real)(?:\/|$)/iu,
  /^(?:exports?|uploads?|backups?|dumps?)(?:\/|$)/iu,
  /\.(?:pem|key|p12|pfx)$/iu,
];

/**
 * Rejects paths that represent likely local secrets or customer-data dumps.
 *
 * Product source directories such as `apps/web/.../exports/` are intentionally allowed. Generic
 * dump-directory names are blocked only at the repository root; customer/production/real-data
 * names remain forbidden at any depth.
 *
 * @param {string} path
 * @returns {string | undefined}
 */
export function stagedPathPolicyError(path) {
  if (path === ".env.example") return undefined;
  if (forbiddenPaths.some((pattern) => pattern.test(path))) {
    return "forbidden environment, credential, or customer-data path";
  }
  return undefined;
}

/**
 * @param {string} content
 * @returns {readonly string[]}
 */
export function stagedTextPolicyErrors(content) {
  const failures = [];
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(content)) {
    failures.push("private key material detected");
  }
  if (/(?:sk_live_|rk_live_|shpat_|shpss_|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/u.test(content)) {
    failures.push("likely production token detected");
  }
  return failures;
}
