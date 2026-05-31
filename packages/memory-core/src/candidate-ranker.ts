import type { MemoryCandidate, RankedMemoryCandidate } from "./types.js";

export interface CandidateRankerOptions {
  maxCandidates: number;
  nowIso?: string;
  queryEmbedding?: number[];
}

export function rankMemoryCandidates(
  prompt: string,
  candidates: MemoryCandidate[],
  options: CandidateRankerOptions,
): RankedMemoryCandidate[] {
  const terms = tokenize(prompt);
  const now = Date.parse(options.nowIso ?? new Date().toISOString());
  const bm25 = calculateBm25Scores(terms, candidates);
  const sourceCounts = countSourceRefs(candidates);

  const scored = candidates.map((candidate, index) => {
    const lexical = bm25[index] ?? 0;
    const semanticHint = semanticHintScore(terms, candidate.retrievalHints);
    const embedding = embeddingScore(options.queryEmbedding, candidate.embedding);
    const recency = recencyScore(now, candidate.timestamp);
    const diversity = sourceDiversityScore(candidate, sourceCounts);
    const rankScore = lexical + semanticHint + embedding + recency + diversity;
    return {
      ...candidate,
      rankScore,
      rankSignals: {
        lexicalScore: roundScore(lexical),
        lexicalBm25Score: roundScore(lexical),
        semanticHintScore: roundScore(semanticHint),
        ...(embedding > 0 ? { semanticVectorScore: roundScore(embedding), embeddingScore: roundScore(embedding) } : {}),
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

function calculateBm25Scores(queryTerms: string[], candidates: MemoryCandidate[]): number[] {
  if (queryTerms.length === 0 || candidates.length === 0) {
    return candidates.map(() => 0);
  }
  const uniqueQueryTerms = Array.from(new Set(queryTerms));
  const documents = candidates.map((candidate) => tokenize(candidate.text));
  const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length || 1;
  const documentFrequencies = new Map<string, number>();
  for (const term of uniqueQueryTerms) {
    documentFrequencies.set(
      term,
      documents.filter((doc) => doc.some((token) => token === term || token.includes(term) || term.includes(token)))
        .length,
    );
  }
  const k1 = 1.2;
  const b = 0.75;
  return documents.map((doc) => {
    if (doc.length === 0) {
      return 0;
    }
    let rawScore = 0;
    for (const term of uniqueQueryTerms) {
      const termFrequency = doc.filter(
        (token) => token === term || token.includes(term) || term.includes(token),
      ).length;
      if (termFrequency === 0) {
        continue;
      }
      const df = documentFrequencies.get(term) ?? 0;
      const idf = Math.log(1 + (candidates.length - df + 0.5) / (df + 0.5));
      rawScore +=
        idf * ((termFrequency * (k1 + 1)) / (termFrequency + k1 * (1 - b + b * (doc.length / averageLength))));
    }
    return Math.min(1, rawScore / Math.max(1, uniqueQueryTerms.length * 1.5));
  });
}

function embeddingScore(queryEmbedding?: number[], candidateEmbedding?: number[]): number {
  if (!isUsableEmbedding(queryEmbedding) || !isUsableEmbedding(candidateEmbedding)) {
    return 0;
  }
  const similarity = cosine(queryEmbedding, candidateEmbedding);
  if (similarity < 0.65) {
    return 0;
  }
  return Math.min(0.35, ((similarity - 0.65) / 0.35) * 0.35);
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

function sourceDiversityScore(candidate: MemoryCandidate, sourceCounts: Map<string, number>): number {
  const base = candidate.sourceType === "transcript" ? 0.1 : candidate.sourceType === "memory_item" ? 0.08 : 0;
  if (base === 0) {
    return 0;
  }
  const count = sourceCounts.get(`${candidate.sourceType}:${candidate.sourceRef}`) ?? 1;
  return base / Math.sqrt(count);
}

function countSourceRefs(candidates: MemoryCandidate[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = `${candidate.sourceType}:${candidate.sourceRef}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function isUsableEmbedding(value: number[] | undefined): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => Number.isFinite(item));
}

function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    return 0;
  }
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude) || 1);
}
