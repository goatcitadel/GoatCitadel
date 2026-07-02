import type {
  MemoryCitation,
  MemoryContextPack,
  MemoryFreshness,
  MemoryRelationScope,
  MemoryRetrievalMatchSignals,
  MemoryRetrievalStrategy,
} from "@goatcitadel/contracts";
import { estimateTokensFromText, type ParsedDistillation } from "@goatcitadel/memory-core";
import { scanPromptwareContent } from "./assembled-prompt-injection-guard.js";

export const MEMORY_CONTEXT_PROMPT_INJECTION_REASON = "prompt_injection_detected_in_memory_context";

type CandidateCitationMetadata = {
  sourceType: "transcript" | "file" | "memory_item";
  timestamp?: string;
  rankScore?: number;
  rankSignals?: MemoryRetrievalMatchSignals;
};

export function enrichMemoryPack(
  pack: MemoryContextPack,
  relationScope: MemoryRelationScope,
  candidatesById: Map<string, CandidateCitationMetadata>,
): MemoryContextPack {
  return {
    ...pack,
    relationScope,
    citations: enrichMemoryCitations(pack.citations, relationScope, candidatesById),
  };
}

export function findInvalidFactCitationIds(parsed: ParsedDistillation): string[] {
  const returnedCitationIds = new Set(parsed.citations.map((citation) => citation.candidateId));
  const invalid = new Set<string>();
  for (const fact of parsed.payload.facts) {
    for (const citationId of fact.citationIds) {
      if (!returnedCitationIds.has(citationId)) {
        invalid.add(citationId);
      }
    }
  }
  return [...invalid];
}

export function sanitizeMemoryContextWrite(input: {
  contextText: string;
  citations: MemoryCitation[];
  quality: MemoryContextPack["quality"];
  distilledTokenEstimate: number;
}): {
  contextText: string;
  citations: MemoryCitation[];
  quality: MemoryContextPack["quality"];
  distilledTokenEstimate: number;
  promptInjectionDetected: boolean;
  evidenceHash?: string;
} {
  const [finding] = scanPromptwareContent({ source: "memory_context", content: input.contextText });
  if (!finding) {
    return { ...input, promptInjectionDetected: false };
  }
  const contextText =
    "Fallback Context:\n- Memory context withheld because retrieved content matched the promptware safety filter.";
  return {
    contextText,
    citations: [],
    quality: {
      status: "fallback",
      reason: MEMORY_CONTEXT_PROMPT_INJECTION_REASON,
    },
    distilledTokenEstimate: estimateTokensFromText(contextText),
    promptInjectionDetected: true,
    evidenceHash: finding.evidenceHash,
  };
}

export function enrichMemoryCitations(
  citations: MemoryCitation[],
  relationScope: MemoryRelationScope,
  candidatesById: Map<string, CandidateCitationMetadata>,
): MemoryCitation[] {
  return citations.map((citation) => {
    const candidate = candidatesById.get(citation.candidateId);
    const selectionReason =
      candidate?.rankSignals !== undefined
        ? buildMemorySelectionReason(candidate.rankSignals)
        : candidate?.rankScore !== undefined
          ? `selected by lexical/recency retrieval score ${candidate.rankScore.toFixed(3)}`
          : (citation.provenance?.selectionReason ?? "selected from reusable cached context");
    return {
      ...citation,
      provenance: {
        relationScope: citation.provenance?.relationScope ?? relationScope,
        freshness: citation.provenance?.freshness ?? classifyMemoryFreshness(candidate?.timestamp),
        selectionReason,
        retrievalStrategy: citation.provenance?.retrievalStrategy ?? resolveCitationRetrievalStrategy(candidate),
        matchSignals: citation.provenance?.matchSignals ?? candidate?.rankSignals,
        sourceTimestamp: citation.provenance?.sourceTimestamp ?? candidate?.timestamp,
      },
    };
  });
}

function buildMemorySelectionReason(signals: MemoryRetrievalMatchSignals): string {
  const lexical = signals.lexicalBm25Score ?? signals.lexicalScore;
  const embedding = signals.embeddingScore ?? signals.semanticVectorScore ?? 0;
  const method =
    embedding > 0 && lexical > 0
      ? "hybrid retrieval"
      : embedding > 0
        ? "semantic-vector retrieval"
        : signals.semanticHintScore > 0
          ? "semantic-hint retrieval"
          : "lexical/recency retrieval";
  return [
    `selected by ${method} score ${signals.totalScore.toFixed(3)} (BM25 ${lexical.toFixed(3)}`,
    embedding > 0 ? `embedding ${embedding.toFixed(3)}` : undefined,
    `semantic hint ${signals.semanticHintScore.toFixed(3)}`,
    `recency ${signals.recencyScore.toFixed(3)}`,
    `diversity ${signals.diversityScore.toFixed(3)})`,
  ]
    .filter(Boolean)
    .join(", ");
}

function resolveCitationRetrievalStrategy(
  candidate:
    | {
        rankSignals?: MemoryRetrievalMatchSignals;
        rankScore?: number;
      }
    | undefined,
): MemoryRetrievalStrategy | undefined {
  if (candidate?.rankSignals) {
    const lexical = candidate.rankSignals.lexicalBm25Score ?? candidate.rankSignals.lexicalScore;
    const embedding = candidate.rankSignals.embeddingScore ?? candidate.rankSignals.semanticVectorScore ?? 0;
    if (embedding > 0 && lexical > 0) {
      return "hybrid_rank";
    }
    if (embedding > 0) {
      return "semantic_vector";
    }
    return candidate.rankSignals.semanticHintScore > 0 ? "semantic_hints" : "lexical_recency";
  }
  return candidate?.rankScore !== undefined ? "lexical_recency" : undefined;
}

function classifyMemoryFreshness(timestamp?: string): MemoryFreshness {
  if (!timestamp) {
    return "unknown";
  }
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return "unknown";
  }
  const ageHours = Math.max(0, Date.now() - parsed) / (60 * 60 * 1000);
  if (ageHours <= 1) {
    return "fresh";
  }
  if (ageHours <= 24 * 7) {
    return "recent";
  }
  return "stale";
}
