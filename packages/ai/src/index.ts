import { z } from "zod";

export const AI_SCHEMA_VERSION = "1.0.0";

export const AiCandidateSchema = z.object({
  candidateId: z.string().regex(/^[a-f0-9]{64}$/u),
  deterministicScore: z.int().min(0).max(100),
  evidenceCodes: z
    .array(z.string().regex(/^[A-Z0-9_]{1,80}$/u))
    .min(1)
    .max(20),
});

export const AiRankingRequestSchema = z.object({
  schemaVersion: z.literal(AI_SCHEMA_VERSION),
  organizationFeatureEnabled: z.literal(true),
  exceptionType: z.string().regex(/^[a-z0-9_]{1,100}$/u),
  candidates: z.array(AiCandidateSchema).min(2).max(10),
  promptVersion: z.string().min(1).max(50),
});

export const AiRankingResponseSchema = z.object({
  schemaVersion: z.literal(AI_SCHEMA_VERSION),
  rankedCandidateIds: z
    .array(z.string().regex(/^[a-f0-9]{64}$/u))
    .min(1)
    .max(10),
  explanation: z.string().min(1).max(1000),
  citedEvidenceCodes: z
    .array(z.string().regex(/^[A-Z0-9_]{1,80}$/u))
    .min(1)
    .max(20),
  confidence: z.number().min(0).max(1),
});

export type AiRankingRequest = z.infer<typeof AiRankingRequestSchema>;
export type AiRankingResponse = z.infer<typeof AiRankingResponseSchema>;

export interface AiProvider {
  readonly providerId: string;
  readonly modelVersion: string;
  rankCandidates(request: AiRankingRequest, signal: AbortSignal): Promise<AiRankingResponse>;
}

export interface AiCallPolicy {
  readonly enabled: boolean;
  readonly timeoutMs: number;
  readonly maximumAttempts: 1 | 2;
}

export interface AiRankingResult {
  readonly status: "completed" | "disabled" | "failed";
  readonly response?: AiRankingResponse;
  readonly failureCode?: "TIMEOUT" | "INVALID_SCHEMA" | "PROVIDER_FAILURE";
}

export async function rankCandidatesSafely(
  provider: AiProvider,
  request: AiRankingRequest,
  policy: AiCallPolicy,
): Promise<AiRankingResult> {
  if (!policy.enabled) return { status: "disabled" };
  const validRequest = AiRankingRequestSchema.parse(request);
  for (let attempt = 1; attempt <= policy.maximumAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), policy.timeoutMs);
    try {
      const response = await provider.rankCandidates(validRequest, controller.signal);
      const valid = AiRankingResponseSchema.safeParse(response);
      if (!valid.success) return { status: "failed", failureCode: "INVALID_SCHEMA" };
      const requestedIds = new Set(validRequest.candidates.map((item) => item.candidateId));
      if (valid.data.rankedCandidateIds.some((id) => !requestedIds.has(id))) {
        return { status: "failed", failureCode: "INVALID_SCHEMA" };
      }
      return { status: "completed", response: valid.data };
    } catch (error) {
      if (controller.signal.aborted) return { status: "failed", failureCode: "TIMEOUT" };
      if (attempt === policy.maximumAttempts) {
        return { status: "failed", failureCode: "PROVIDER_FAILURE" };
      }
      if (!(error instanceof Error)) continue;
    } finally {
      clearTimeout(timeout);
    }
  }
  return { status: "failed", failureCode: "PROVIDER_FAILURE" };
}

export class DisabledAiProvider implements AiProvider {
  public readonly providerId = "disabled";
  public readonly modelVersion = "none";

  public rankCandidates(
    _request: AiRankingRequest,
    _signal: AbortSignal,
  ): Promise<AiRankingResponse> {
    return Promise.reject(new Error("AI provider is disabled"));
  }
}
