import { AiRankingResponseSchema, type AiProvider, type AiRankingRequest } from "@workspace/ai";
import { z } from "zod";

export const EvaluationCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,100}$/u),
  datasetVersion: z.string().min(1).max(50),
  synthetic: z.literal(true),
  request: z.custom<AiRankingRequest>(),
  expectedTopCandidateId: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type EvaluationCase = z.infer<typeof EvaluationCaseSchema>;

export interface EvaluationSummary {
  readonly datasetVersion: string;
  readonly cases: number;
  readonly validSchema: number;
  readonly topChoiceAgreement: number;
  readonly failures: readonly string[];
}

export async function evaluateProvider(
  provider: AiProvider,
  cases: readonly EvaluationCase[],
): Promise<EvaluationSummary> {
  const failures: string[] = [];
  let validSchema = 0;
  let topChoiceAgreement = 0;
  for (const value of cases) {
    const item = EvaluationCaseSchema.parse(value);
    const response = await provider.rankCandidates(item.request, AbortSignal.timeout(10_000));
    const parsed = AiRankingResponseSchema.safeParse(response);
    if (!parsed.success) {
      failures.push(item.id);
      continue;
    }
    validSchema += 1;
    if (parsed.data.rankedCandidateIds[0] === item.expectedTopCandidateId) {
      topChoiceAgreement += 1;
    }
  }
  return {
    datasetVersion: cases[0]?.datasetVersion ?? "empty",
    cases: cases.length,
    validSchema,
    topChoiceAgreement,
    failures,
  };
}
