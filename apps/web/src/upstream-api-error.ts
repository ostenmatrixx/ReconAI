import { z } from "zod";

import { readBoundedResponseBytes } from "./bounded-response";

const MAXIMUM_API_ERROR_BYTES = 64 * 1024;
const InternalApiErrorSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Z][A-Z0-9_]*$/u),
    message: z.string().min(1).max(2_000),
    correlationId: z.uuid(),
  })
  .strict();

export interface BrowserSafeApiError {
  readonly code: string;
  readonly message: string;
  readonly correlationId: string;
}

export interface ApiErrorPolicyEntry {
  readonly status: number;
  readonly message: string;
}

export type ApiErrorPolicy = Readonly<Record<string, ApiErrorPolicyEntry>>;

/**
 * Converts a bounded internal API error into a browser-safe, route-approved response.
 * Upstream messages are intentionally discarded because they may contain internal diagnostics.
 */
export async function readAllowlistedApiError(
  response: Response,
  policy: ApiErrorPolicy,
): Promise<BrowserSafeApiError> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("upstream returned a non-JSON API error");
  }

  const bytes = await readBoundedResponseBytes(response, MAXIMUM_API_ERROR_BYTES);
  const parsed = InternalApiErrorSchema.safeParse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
  );
  if (!parsed.success) {
    throw new Error("upstream returned an invalid API error");
  }

  const rule = Object.hasOwn(policy, parsed.data.code) ? policy[parsed.data.code] : undefined;
  if (rule?.status !== response.status) {
    throw new Error("upstream API error is not approved for this route");
  }

  return {
    code: parsed.data.code,
    message: rule.message,
    correlationId: parsed.data.correlationId,
  };
}
