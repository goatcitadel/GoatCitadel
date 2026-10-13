import { ValidationError } from "@goatcitadel/contracts";
import type {
  MemoryItemRecord,
  MemoryFeedbackRecord,
  MemoryFeedbackTargetKind,
  MemoryContextPack,
  MemoryRetrievalStrategy,
  MemoryRetrievalBenchmarkLabel,
  MemoryRetrievalRelevanceMetrics,
  MemoryCitation,
} from "@goatcitadel/contracts";

interface NearDuplicateMemoryItems {
  primary: MemoryItemRecord;
  related: MemoryItemRecord[];
  score: number;
}

export function detectNearDuplicateMemoryItems(items: MemoryItemRecord[]): NearDuplicateMemoryItems[] {
  const activeItems = items.filter((item) => item.status === "active").slice(0, 125);
  const groups = new Map<string, NearDuplicateMemoryItems>();
  for (let leftIndex = 0; leftIndex < activeItems.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < activeItems.length; rightIndex += 1) {
      const left = activeItems[leftIndex];
      const right = activeItems[rightIndex];
      if (!left || !right) {
        continue;
      }
      const score = calculateMemoryDuplicateScore(left, right);
      if (score < 0.82) {
        continue;
      }
      const primary = Date.parse(left.updatedAt) >= Date.parse(right.updatedAt) ? left : right;
      const related = primary.itemId === left.itemId ? right : left;
      const group = groups.get(primary.itemId) ?? { primary, related: [] as MemoryItemRecord[], score };
      if (!group.related.some((item) => item.itemId === related.itemId)) {
        group.related.push(related);
      }
      group.score = Math.max(group.score, score);
      groups.set(primary.itemId, group);
    }
  }
  return [...groups.values()].filter((group) => group.related.length > 0).slice(0, 25);
}

export function calculateMemoryDuplicateScore(left: MemoryItemRecord, right: MemoryItemRecord): number {
  const leftTitle = normalizeQualityText(left.title);
  const rightTitle = normalizeQualityText(right.title);
  const titleMatch = leftTitle.length >= 6 && leftTitle === rightTitle;
  const leftContent = normalizeQualityText(left.content);
  const rightContent = normalizeQualityText(right.content);
  if (leftContent.length >= 80 && leftContent.slice(0, 240) === rightContent.slice(0, 240)) {
    return 0.94;
  }
  const leftTerms = significantTerms(`${left.title} ${left.content}`);
  const rightTerms = significantTerms(`${right.title} ${right.content}`);
  const overlap = calculateSetOverlap(leftTerms, rightTerms);
  if (titleMatch && overlap >= 0.5) {
    return Number(Math.max(0.86, overlap).toFixed(3));
  }
  return Number(overlap.toFixed(3));
}

export function calculateSetOverlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersections = 0;
  for (const term of left) {
    if (right.has(term)) {
      intersections += 1;
    }
  }
  return intersections / Math.min(left.size, right.size);
}

interface RetrievalGapIssueGroup {
  targetKind: MemoryFeedbackTargetKind;
  targetRef: string;
  feedback: MemoryFeedbackRecord[];
}

export function detectRetrievalGaps(feedback: MemoryFeedbackRecord[]): RetrievalGapIssueGroup[] {
  const groups = new Map<string, RetrievalGapIssueGroup>();
  for (const item of feedback) {
    if (item.kind !== "missing" || item.status !== "open") {
      continue;
    }
    const targetRef = item.targetRef ?? item.contextId ?? item.citationId ?? item.feedbackId;
    const noteKey = normalizeQualityText(item.note ?? "missing").slice(0, 80);
    const key = `${item.targetKind}|${targetRef}|${noteKey}`;
    const group = groups.get(key) ?? {
      targetKind: item.targetKind,
      targetRef,
      feedback: [],
    };
    group.feedback.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].slice(0, 25);
}

export function normalizeQualityText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function calculateLexicalOverlap(prompt: string, contextText: string): number {
  const promptTerms = significantTerms(prompt);
  if (promptTerms.size === 0) {
    return 0;
  }
  const contextTerms = significantTerms(contextText);
  let matches = 0;
  for (const term of promptTerms) {
    if (contextTerms.has(term)) {
      matches += 1;
    }
  }
  return Number((matches / promptTerms.size).toFixed(3));
}

/** Ground-truth relevance evaluates exact source identities, never lexical overlap or model self-grading. */
export function calculateLabeledRetrievalRelevance(
  citations: readonly MemoryCitation[],
  label: MemoryRetrievalBenchmarkLabel,
): MemoryRetrievalRelevanceMetrics {
  const key = (source: Pick<MemoryCitation, "sourceType" | "sourceRef">) => JSON.stringify([source.sourceType, source.sourceRef]);
  const retrieved = [...new Set(citations.map(key))];
  const relevant = new Set(label.relevantSources.map(key));
  const forbidden = new Set(label.forbiddenSources?.map(key));
  const matchedRelevantCount = retrieved.filter((source) => relevant.has(source)).length;
  const firstRelevant = retrieved.findIndex((source) => relevant.has(source));
  const noResults = label.expectNoResults === true;
  return {
    retrievedSourceCount: retrieved.length, relevantSourceCount: relevant.size, matchedRelevantCount,
    precision: retrieved.length ? matchedRelevantCount / retrieved.length : noResults ? 1 : 0,
    recall: relevant.size ? matchedRelevantCount / relevant.size : noResults && retrieved.length === 0 ? 1 : 0,
    reciprocalRank: firstRelevant >= 0 ? 1 / (firstRelevant + 1) : noResults && retrieved.length === 0 ? 1 : 0,
    forbiddenSourceCount: retrieved.filter((source) => forbidden.has(source)).length,
    ...(noResults ? { abstentionCorrect: retrieved.length === 0 } : {}),
  };
}

/** Validate labels independently of routes so internal evaluation calls cannot create ambiguous scores. */
export function indexRetrievalBenchmarkLabels(
  prompts: readonly string[],
  labels: readonly MemoryRetrievalBenchmarkLabel[] = [],
): Map<string, MemoryRetrievalBenchmarkLabel> {
  if (labels.length > 25) throw new ValidationError({ field: "labels", message: "Memory benchmark supports at most 25 labels." });
  const available = new Set(prompts);
  const result = new Map<string, MemoryRetrievalBenchmarkLabel>();
  for (const label of labels) {
    const prompt = label.prompt.trim();
    if (!available.has(prompt) || result.has(prompt) || label.relevantSources.length > 100 ||
        (label.forbiddenSources?.length ?? 0) > 100 ||
        (label.expectNoResults === true ? label.relevantSources.length > 0 : label.relevantSources.length === 0)) {
      throw new ValidationError({ field: "labels", message: "Memory benchmark labels must uniquely match a prompt and specify relevant sources or an empty-result expectation." });
    }
    const relevant = new Set(label.relevantSources.map((source) => JSON.stringify([source.sourceType, source.sourceRef])));
    for (const source of [...label.relevantSources, ...(label.forbiddenSources ?? [])]) {
      if (!["transcript", "file", "memory_item"].includes(source.sourceType) || !source.sourceRef || source.sourceRef.length > 1024) {
        throw new ValidationError({ field: "labels", message: "Memory benchmark source labels require bounded exact source identities." });
      }
    }
    if (label.forbiddenSources?.some((source) => relevant.has(JSON.stringify([source.sourceType, source.sourceRef])))) {
      throw new ValidationError({ field: "labels", message: "Memory benchmark sources cannot be both relevant and forbidden." });
    }
    result.set(prompt, label);
  }
  return result;
}

export function resolveBenchmarkRetrievalStrategy(pack: MemoryContextPack): MemoryRetrievalStrategy | undefined {
  return pack.citations.find((citation) => citation.provenance?.retrievalStrategy)?.provenance?.retrievalStrategy;
}

export function buildMemoryBenchmarkCoverageNote(pack: MemoryContextPack): string {
  const strategies = new Set(
    pack.citations
      .map((citation) => citation.provenance?.retrievalStrategy)
      .filter((strategy): strategy is MemoryRetrievalStrategy => Boolean(strategy)),
  );
  if (strategies.has("hybrid_rank")) {
    return "Context used hybrid BM25, optional embedding, semantic hint, recency, and source-diversity scoring.";
  }
  if (strategies.has("semantic_vector")) {
    return "Context used caller-supplied embedding similarity over active memory items plus lexical/recency provenance.";
  }
  if (strategies.has("semantic_hints")) {
    return "Context used operator-visible semantic hints plus lexical/recency scoring; vector semantic search was not used.";
  }
  if (strategies.has("lexical_recency")) {
    return "Context was selected with lexical/recency provenance; vector semantic search was not used.";
  }
  if (pack.citations.length === 0) {
    return "No citations were selected, so retrieval strategy coverage is unavailable.";
  }
  return "Citation provenance did not record a retrieval strategy.";
}

export function significantTerms(value: string): Set<string> {
  const stopWords = new Set([
    "about",
    "after",
    "again",
    "also",
    "and",
    "are",
    "but",
    "for",
    "from",
    "has",
    "have",
    "how",
    "into",
    "that",
    "the",
    "this",
    "was",
    "what",
    "when",
    "where",
    "with",
    "you",
  ]);
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9._-]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3 && !stopWords.has(term)),
  );
}
