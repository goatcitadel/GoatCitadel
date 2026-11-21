import type { MemoryCitation } from "@goatcitadel/contracts";
import type { DistillationPayload, RankedMemoryCandidate } from "./types.js";
import { estimateTokensFromText, truncateByTokenEstimate } from "./token-estimator.js";

export interface ComposeContextInput {
  payload: DistillationPayload;
  citations: MemoryCitation[];
  maxContextTokens: number;
}

export function composeDistilledContext(input: ComposeContextInput): {
  contextText: string;
  distilledTokenEstimate: number;
} {
  const sections: string[] = [];

  if (input.payload.summary.trim()) {
    sections.push(`Summary:\n${input.payload.summary.trim()}`);
  }
  if (input.payload.facts.length > 0) {
    const facts = input.payload.facts.map((fact) => `- ${fact.text} [${fact.citationIds.join(", ")}]`).join("\n");
    sections.push(`Facts:\n${facts}`);
  }
  if (input.payload.risks.length > 0) {
    sections.push(`Risks:\n${input.payload.risks.map((risk) => `- ${risk}`).join("\n")}`);
  }
  if (input.payload.openQuestions.length > 0) {
    sections.push(`Open Questions:\n${input.payload.openQuestions.map((question) => `- ${question}`).join("\n")}`);
  }
  if (input.payload.saferNextSteps.length > 0) {
    sections.push(`Safer Next Steps:\n${input.payload.saferNextSteps.map((step) => `- ${step}`).join("\n")}`);
  }

  const citationsBlock = input.citations
    .map((citation) => `- ${citation.candidateId} (${citation.sourceType}:${citation.sourceRef})`)
    .join("\n");
  if (citationsBlock) {
    sections.push(`Citations:\n${citationsBlock}`);
  }

  const raw = sections.join("\n\n").trim();
  const contextText = truncateByTokenEstimate(raw, input.maxContextTokens);
  return {
    contextText,
    distilledTokenEstimate: estimateTokensFromText(contextText),
  };
}

export function composeFallbackContext(
  candidates: RankedMemoryCandidate[],
  maxContextTokens: number,
): { contextText: string; citations: MemoryCitation[]; distilledTokenEstimate: number } {
  const selected = candidates.slice(0, 6);
  const lines: string[] = ["Fallback Context:"];
  const citations: MemoryCitation[] = [];
  for (const candidate of selected) {
    lines.push(`- ${candidate.text.slice(0, 280)}`);
    citations.push({
      candidateId: candidate.candidateId,
      sourceType: candidate.sourceType,
      sourceRef: candidate.sourceRef,
      ...(candidate.sourceHash ? { sourceHash: candidate.sourceHash } : {}),
      snippet: candidate.text.slice(0, 180),
      score: Number(candidate.rankScore.toFixed(3)),
    });
  }

  const contextText = truncateByTokenEstimate(lines.join("\n"), maxContextTokens);
  return {
    contextText,
    citations,
    distilledTokenEstimate: estimateTokensFromText(contextText),
  };
}
