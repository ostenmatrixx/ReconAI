import { z } from "zod";

export const SUPPORT_ACCESS_REQUEST_TTL_MS = 15 * 60 * 1000;
export const SUPPORT_ACCESS_MINIMUM_DURATION_MINUTES = 5;
export const SUPPORT_ACCESS_MAXIMUM_DURATION_MINUTES = 60;

export const SupportIdentityDigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .brand<"SupportIdentityDigest">();
export const SupportAccessRequestCodeSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u)
  .brand<"SupportAccessRequestCode">();
export const SupportAccessGrantIdSchema = z.uuid().brand<"SupportAccessGrantId">();
export const SupportCapabilitySchema = z.enum(["diagnostics:view"]);

export type SupportIdentityDigest = z.infer<typeof SupportIdentityDigestSchema>;
export type SupportAccessRequestCode = z.infer<typeof SupportAccessRequestCodeSchema>;
export type SupportAccessGrantId = z.infer<typeof SupportAccessGrantIdSchema>;
export type SupportCapability = z.infer<typeof SupportCapabilitySchema>;
