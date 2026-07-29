import { createHash, createHmac } from "node:crypto";

import Redis from "ioredis";
import type { JWT } from "next-auth/jwt";

import type { SessionRevocationConfiguration } from "./server-environment";

export const oidcSessionMaximumAgeSeconds = 8 * 60 * 60;
export const logoutTokenMaximumAgeSeconds = 5 * 60;
export const logoutTokenClockToleranceSeconds = 60;

const replayRetentionSeconds = logoutTokenMaximumAgeSeconds + 2 * logoutTokenClockToleranceSeconds;
const revocationRetentionSeconds =
  oidcSessionMaximumAgeSeconds + logoutTokenMaximumAgeSeconds + logoutTokenClockToleranceSeconds;
const environmentPattern = /^[a-z0-9][a-z0-9-]{1,31}$/u;

export interface OidcSessionIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly sessionId?: string;
  readonly startedAt: number;
}

export interface OidcLogoutEvent {
  readonly issuer: string;
  readonly subject?: string;
  readonly sessionId?: string;
  readonly issuedAt: number;
  readonly jwtId: string;
}

export interface SessionRevocationStore {
  recordLogout(event: OidcLogoutEvent): Promise<"recorded" | "replayed">;
  isRevoked(identity: OidcSessionIdentity): Promise<boolean>;
}

interface StoredRevocation {
  readonly cutoff: number;
  readonly expiresAt: number;
}

export class InMemorySessionRevocationStore implements SessionRevocationStore {
  readonly #revocations = new Map<string, StoredRevocation>();
  readonly #replays = new Map<string, number>();
  readonly #key: Uint8Array;
  readonly #namespace: string;
  readonly #now: () => number;

  public constructor(keySecret: string, environment = "test", now: () => number = Date.now) {
    this.#key = deriveIndexKey(keySecret);
    this.#namespace = revocationNamespace(environment);
    this.#now = now;
  }

  public async recordLogout(event: OidcLogoutEvent): Promise<"recorded" | "replayed"> {
    validateLogoutEvent(event);
    const now = this.#now();
    this.#removeExpired(now);
    const replayKey = this.#keyFor("replay", event.issuer, event.jwtId);
    if (this.#replays.has(replayKey)) return "replayed";

    const locator = revocationLocator(event);
    const revocationKey = this.#keyFor(locator.kind, event.issuer, locator.value);
    const current = this.#revocations.get(revocationKey);
    if (!current || current.cutoff < event.issuedAt) {
      this.#revocations.set(revocationKey, {
        cutoff: event.issuedAt,
        expiresAt: now + revocationRetentionSeconds * 1000,
      });
    }
    this.#replays.set(replayKey, now + replayRetentionSeconds * 1000);
    return "recorded";
  }

  public async isRevoked(identity: OidcSessionIdentity): Promise<boolean> {
    validateSessionIdentity(identity);
    const now = this.#now();
    this.#removeExpired(now);
    return sessionRevocationKeys(identity, (kind, value) =>
      this.#keyFor(kind, identity.issuer, value),
    ).some((key) => {
      const revocation = this.#revocations.get(key);
      return revocation !== undefined && revocation.cutoff >= identity.startedAt;
    });
  }

  #keyFor(kind: "replay" | "sid" | "sub", issuer: string, value: string): string {
    return `${this.#namespace}:${kind}:${opaqueIndex(this.#key, kind, issuer, value)}`;
  }

  #removeExpired(now: number): void {
    for (const [key, expiresAt] of this.#replays) {
      if (expiresAt <= now) this.#replays.delete(key);
    }
    for (const [key, revocation] of this.#revocations) {
      if (revocation.expiresAt <= now) this.#revocations.delete(key);
    }
  }
}

export class RedisSessionRevocationStore implements SessionRevocationStore {
  readonly #redis: Redis;
  readonly #key: Uint8Array;
  readonly #namespace: string;
  #connectPromise: Promise<void> | undefined;

  public constructor(
    configuration: Extract<SessionRevocationConfiguration, { readonly store: "redis" }>,
  ) {
    this.#key = deriveIndexKey(configuration.keySecret);
    this.#namespace = revocationNamespace(configuration.environment);
    this.#redis = new Redis(configuration.redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: configuration.connectTimeoutMilliseconds,
      commandTimeout: configuration.commandTimeoutMilliseconds,
      enableReadyCheck: true,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectionName: `reconai-${configuration.environment}-web-session-revocation`,
    });
  }

  public async recordLogout(event: OidcLogoutEvent): Promise<"recorded" | "replayed"> {
    validateLogoutEvent(event);
    await this.#ensureReady();
    const replayKey = this.#keyFor("replay", event.issuer, event.jwtId);
    const locator = revocationLocator(event);
    const revocationKey = this.#keyFor(locator.kind, event.issuer, locator.value);
    const result = await this.#redis.eval(
      recordLogoutScript,
      2,
      replayKey,
      revocationKey,
      replayRetentionSeconds,
      revocationRetentionSeconds,
      event.issuedAt,
    );
    if (result === 0 || result === "0") return "replayed";
    if (result === 1 || result === "1") return "recorded";
    throw new Error("session revocation store returned an invalid result");
  }

  public async isRevoked(identity: OidcSessionIdentity): Promise<boolean> {
    validateSessionIdentity(identity);
    await this.#ensureReady();
    const keys = sessionRevocationKeys(identity, (kind, value) =>
      this.#keyFor(kind, identity.issuer, value),
    );
    const cutoffs = await this.#redis.mget(...keys);
    for (const value of cutoffs) {
      if (value === null) continue;
      if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
        throw new Error("session revocation store contains an invalid cutoff");
      }
      if (Number(value) >= identity.startedAt) return true;
    }
    return false;
  }

  public disconnect(): void {
    this.#redis.disconnect();
  }

  #keyFor(kind: "replay" | "sid" | "sub", issuer: string, value: string): string {
    return `${this.#namespace}:${kind}:${opaqueIndex(this.#key, kind, issuer, value)}`;
  }

  async #ensureReady(): Promise<void> {
    if (this.#redis.status === "wait") {
      this.#connectPromise ??= this.#redis.connect().finally(() => {
        this.#connectPromise = undefined;
      });
      await this.#connectPromise;
    }
    if (this.#redis.status !== "ready") {
      throw new Error("session revocation store is unavailable");
    }
  }
}

let sharedStore:
  | {
      readonly fingerprint: string;
      readonly store: SessionRevocationStore;
    }
  | undefined;

export function sessionRevocationStore(
  configuration: SessionRevocationConfiguration,
): SessionRevocationStore {
  const fingerprint = configurationFingerprint(configuration);
  if (sharedStore?.fingerprint === fingerprint) return sharedStore.store;
  const store =
    configuration.store === "redis"
      ? new RedisSessionRevocationStore(configuration)
      : new InMemorySessionRevocationStore(configuration.keySecret, configuration.environment);
  sharedStore = { fingerprint, store };
  return store;
}

export function oidcSessionIdentity(
  token: JWT,
  expectedIssuer: string,
): OidcSessionIdentity | undefined {
  const startedAt = token.apiSessionStartedAt;
  if (
    token.apiOidcIssuer !== expectedIssuer ||
    !validOpaqueIdentifier(token.apiOidcSubject) ||
    typeof startedAt !== "number" ||
    !Number.isSafeInteger(startedAt) ||
    startedAt <= 0 ||
    (token.apiOidcSessionId !== undefined && !validOpaqueIdentifier(token.apiOidcSessionId))
  ) {
    return undefined;
  }
  return {
    issuer: token.apiOidcIssuer,
    subject: token.apiOidcSubject,
    ...(token.apiOidcSessionId ? { sessionId: token.apiOidcSessionId } : {}),
    startedAt,
  };
}

export async function enforceOidcSessionRevocation(
  token: JWT,
  expectedIssuer: string,
  store: SessionRevocationStore,
): Promise<JWT> {
  const identity = oidcSessionIdentity(token, expectedIssuer);
  if (!identity) return invalidatedToken(token, "SESSION_IDENTITY_INVALID");
  try {
    return (await store.isRevoked(identity)) ? invalidatedToken(token, "SESSION_REVOKED") : token;
  } catch {
    return invalidatedToken(token, "SESSION_REVOCATION_UNAVAILABLE");
  }
}

function invalidatedToken(
  token: JWT,
  error: "SESSION_IDENTITY_INVALID" | "SESSION_REVOKED" | "SESSION_REVOCATION_UNAVAILABLE",
): JWT {
  const invalidated = { ...token, providerTokenError: error };
  delete invalidated.apiAccessToken;
  delete invalidated.apiAccessTokenExpiresAt;
  delete invalidated.apiRefreshToken;
  delete invalidated.apiIdToken;
  return invalidated;
}

function sessionRevocationKeys(
  identity: OidcSessionIdentity,
  key: (kind: "sid" | "sub", value: string) => string,
): string[] {
  return [
    key("sub", identity.subject),
    ...(identity.sessionId ? [key("sid", identity.sessionId)] : []),
  ];
}

function revocationLocator(event: OidcLogoutEvent): {
  readonly kind: "sid" | "sub";
  readonly value: string;
} {
  if (event.sessionId) return { kind: "sid", value: event.sessionId };
  if (event.subject) return { kind: "sub", value: event.subject };
  throw new Error("logout event has no session locator");
}

function validateLogoutEvent(event: OidcLogoutEvent): void {
  validateIssuer(event.issuer);
  if (
    !validOpaqueIdentifier(event.jwtId) ||
    !Number.isSafeInteger(event.issuedAt) ||
    event.issuedAt <= 0 ||
    (event.subject !== undefined && !validOpaqueIdentifier(event.subject)) ||
    (event.sessionId !== undefined && !validOpaqueIdentifier(event.sessionId)) ||
    (!event.subject && !event.sessionId)
  ) {
    throw new Error("logout event is invalid");
  }
}

function validateSessionIdentity(identity: OidcSessionIdentity): void {
  validateIssuer(identity.issuer);
  if (
    !validOpaqueIdentifier(identity.subject) ||
    !Number.isSafeInteger(identity.startedAt) ||
    identity.startedAt <= 0 ||
    (identity.sessionId !== undefined && !validOpaqueIdentifier(identity.sessionId))
  ) {
    throw new Error("OIDC session identity is invalid");
  }
}

function validateIssuer(value: string): void {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("OIDC issuer is invalid");
  }
}

function validOpaqueIdentifier(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return false;
  }
  return true;
}

function revocationNamespace(environment: string): string {
  if (!environmentPattern.test(environment)) {
    throw new Error("session revocation environment namespace is invalid");
  }
  return `reconai-${environment}-web-session-revocation-v1`;
}

function deriveIndexKey(secret: string): Uint8Array {
  if (secret.length < 32) throw new Error("session revocation key material is too short");
  return createHmac("sha256", secret)
    .update("reconai/session-revocation-index-key/v1", "utf8")
    .digest();
}

function opaqueIndex(
  key: Uint8Array,
  kind: "replay" | "sid" | "sub",
  issuer: string,
  value: string,
): string {
  return createHmac("sha256", key)
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(issuer, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function configurationFingerprint(configuration: SessionRevocationConfiguration): string {
  return createHash("sha256")
    .update(JSON.stringify({ ...configuration, keySecret: undefined }))
    .update("\0")
    .update(configuration.keySecret)
    .digest("hex");
}

const recordLogoutScript = `
if redis.call("EXISTS", KEYS[1]) == 1 then
  return 0
end
redis.call("SET", KEYS[1], "1", "EX", ARGV[1])
local cutoff = redis.call("GET", KEYS[2])
if (not cutoff) or tonumber(cutoff) < tonumber(ARGV[3]) then
  redis.call("SET", KEYS[2], ARGV[3], "EX", ARGV[2])
end
return 1
`;
