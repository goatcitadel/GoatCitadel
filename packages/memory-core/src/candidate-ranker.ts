import type { MemoryCandidate, RankedMemoryCandidate } from "./types.js";

export interface CandidateRankerOptions {
  maxCandidates: number;
  nowIso?: string;
}

export function rankMemoryCandidates(
  prompt: string,
  candidates: MemoryCandidate[],
  options: CandidateRankerOptions,
): RankedMemoryCandidate[] {
  const terms = tokenize(prompt);
  const now = Date.parse(options.nowIso ?? new Date().toISOString());

  const scored = candidates.map((candidate) => {
    const lexical = lexicalScore(terms, candidate.text);
    const semanticHint = semanticHintScore(terms, candidate.retrievalHints);
    const recency = recencyScore(now, candidate.timestamp);
    const diversity = candidate.sourceType === "transcript" ? 0.1 : candidate.sourceType === "memory_item" ? 0.08 : 0;
    const rankScore = lexical + semanticHint + recency + diversity;
    return {
      ...candidate,
      rankScore,
      rankSignals: {
        lexicalScore: roundScore(lexical),
        semanticHintScore: roundScore(semanticHint),
        recencyScore: roundScore(recency),
        diversityScore: roundScore(diversity),
        totalScore: roundScore(rankScore),
      },
    } satisfies RankedMemoryCandidate;
  });

  scored.sort((left, right) => {
    const scoreDelta = right.rankScore - left.rankScore;
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    if (left.candidateId < right.candidateId) {
      return -1;
    }
    if (left.candidateId > right.candidateId) {
      return 1;
    }
    return 0;
  });
  return scored.slice(0, Math.max(1, options.maxCandidates));
}

function roundScore(value: number): number {
  return Number(value.toFixed(3));
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function lexicalScore(terms: string[], content: string): number {
  if (terms.length === 0) {
    return 0;
  }
  const normalized = content.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (normalized.includes(term)) {
      hits += 1;
    }
  }
  return hits / terms.length;
}

function semanticHintScore(terms: string[], hints?: string[]): number {
  if (terms.length === 0 || !hints?.length) {
    return 0;
  }
  const hintTerms = hints.flatMap((hint) => tokenize(hint));
  if (hintTerms.length === 0) {
    return 0;
  }
  let hits = 0;
  for (const term of terms) {
    if (hintTerms.some((hint) => hint.includes(term) || term.includes(hint))) {
      hits += 1;
    }
  }
  return Math.min(0.2, (hits / terms.length) * 0.2);
}

function recencyScore(nowMs: number, timestamp?: string): number {
  if (!timestamp) {
    return 0;
  }
  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts)) {
    return 0;
  }
  const ageMs = Math.max(0, nowMs - ts);
  const ageHours = ageMs / (60 * 60 * 1000);
  if (ageHours <= 1) {
    return 0.25;
  }
  if (ageHours <= 24) {
    return 0.15;
  }
  if (ageHours <= 24 * 7) {
    return 0.05;
  }
  return 0;
}
