import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

const cookiePayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    attemptId: z.uuid(),
    organizationId: z.uuid(),
    provider: z.enum(["shopify", "stripe"]),
    stateSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
const cookiePartSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);
const maximumCookieLength = 1024;
const maximumLifetimeSeconds = 15 * 60;
const clockSkewSeconds = 60;
const signatureContext = "reconai-provider-authorization-v1";

export type ProviderAuthorizationCookie = z.infer<typeof cookiePayloadSchema>;

export function providerAuthorizationCookieName(): string {
  return process.env.NODE_ENV === "production"
    ? "__Host-reconai.provider-authorization"
    : "reconai.provider-authorization";
}

export function issueProviderAuthorizationCookie(
  input: Omit<ProviderAuthorizationCookie, "schemaVersion" | "issuedAt">,
  subject: string,
  secret: string,
  now = new Date(),
): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload = cookiePayloadSchema.parse({
    schemaVersion: 1,
    ...input,
    issuedAt,
  });
  validateLifetime(payload, issuedAt);
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signCookie(encoded, subject, secret)}`;
}

export function verifyProviderAuthorizationCookie(
  value: string | undefined,
  subject: string,
  secret: string,
  now = new Date(),
): ProviderAuthorizationCookie | undefined {
  if (!value || value.length > maximumCookieLength) return undefined;
  const [encoded, signature, extra] = value.split(".");
  if (
    extra !== undefined ||
    !encoded ||
    !signature ||
    !cookiePartSchema.safeParse(encoded).success ||
    !cookiePartSchema.safeParse(signature).success
  ) {
    return undefined;
  }
  const expectedSignature = signCookie(encoded, subject, secret);
  if (!safeEqual(signature, expectedSignature)) return undefined;

  try {
    const payload = cookiePayloadSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
    validateLifetime(payload, Math.floor(now.getTime() / 1000));
    return payload;
  } catch {
    return undefined;
  }
}

function validateLifetime(payload: ProviderAuthorizationCookie, now: number): void {
  if (
    payload.expiresAt <= payload.issuedAt ||
    payload.expiresAt - payload.issuedAt > maximumLifetimeSeconds ||
    payload.issuedAt > now + clockSkewSeconds ||
    payload.expiresAt <= now
  ) {
    throw new TypeError("provider authorization cookie lifetime is invalid");
  }
}

function signCookie(encoded: string, subject: string, secret: string): string {
  if (subject.length === 0 || subject.length > 2048 || secret.length < 32) {
    throw new TypeError("provider authorization cookie signing context is invalid");
  }
  return createHmac("sha256", secret)
    .update(`${signatureContext}\0${subject}\0${encoded}`)
    .digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
