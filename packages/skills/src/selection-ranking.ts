import type { LoadedSkill, SkillResolveInput } from "@goatcitadel/contracts";

const MAX_CANDIDATES = 1_000;
const MAX_QUERY_CHARS = 8_192;
const MAX_FIELD_CHARS = 4_096;
const MAX_TERMS = 64;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "from",
  "in",
  "is",
  "of",
  "on",
  "please",
  "the",
  "to",
  "with",
]);

export interface SkillSelectionRanking {
  method: "metadata_bm25_v1";
  candidates: Array<{ skillId: string; score: number; explicit: boolean }>;
  queryTruncated: boolean;
  candidatesTruncated: boolean;
}

/** Evaluation only. Metadata scores are not confidence, activation, or permission. */
export function rankSkillSelectionCandidates(
  input: SkillResolveInput,
  skills: readonly LoadedSkill[],
  limit = 5,
): SkillSelectionRanking {
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.min(50, Math.floor(limit))) : 5;
  const queryTokens = tokenize(input.text.slice(0, MAX_QUERY_CHARS));
  const query = [...new Set(queryTokens)].slice(0, MAX_TERMS);
  const explicit = new Set((input.explicitSkills ?? []).slice(0, 50).map((name) => name.toLowerCase()));
  if (input.explicitSkills === undefined) {
    for (const match of input.text.slice(0, MAX_QUERY_CHARS).matchAll(/(?:@skill\s+|\buse\s+)([a-z0-9:_-]+)/giu)) {
      if (match[1]) explicit.add(match[1].toLowerCase());
    }
  }
  const documents = skills.slice(0, MAX_CANDIDATES).map((skill) => ({
    skill,
    explicit: explicit.has(skill.name.toLowerCase()) || explicit.has(skill.skillId.toLowerCase()),
    fields: [
      tokenize(skill.name.slice(0, MAX_FIELD_CHARS)),
      tokenize(
        boundedMetadata([
          ...(skill.keywords ?? []).slice(0, 32),
          ...(skill.routingHints?.keywords ?? []).slice(0, 32),
          ...(skill.routingHints?.phrases ?? []).slice(0, 32),
        ]),
      ),
      tokenize(boundedMetadata(skill.routingHints?.whenToUse ?? [])),
    ],
  }));
  const averageLengths = [0, 1, 2].map(
    (field) =>
      documents.reduce((sum, document) => sum + (document.fields[field]?.length ?? 0), 0) /
      Math.max(1, documents.length),
  );
  const frequencies = new Map(
    query.map((term) => [
      term,
      documents.filter((document) => document.fields.some((field) => field.includes(term))).length,
    ]),
  );
  const weights = [8, 4, 1];
  const ranked = documents
    .map((document) => {
      let score = 0;
      for (const term of query) {
        let weightedFrequency = 0;
        document.fields.forEach((field, index) => {
          const frequency = field.filter((value) => value === term).length;
          const lengthRatio = field.length / Math.max(1, averageLengths[index] ?? 0);
          weightedFrequency += ((weights[index] ?? 1) * frequency) / (0.25 + 0.75 * lengthRatio);
        });
        if (weightedFrequency > 0) {
          const frequency = frequencies.get(term) ?? 0;
          const rarity = Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5));
          score += (rarity * weightedFrequency * 2.2) / (weightedFrequency + 1.2);
        }
      }
      return {
        skillId: document.skill.skillId,
        score: Math.round(score * 1_000_000) / 1_000_000,
        explicit: document.explicit,
      };
    })
    .filter((candidate) => candidate.explicit || candidate.score > 0)
    .sort(
      (left, right) =>
        Number(right.explicit) - Number(left.explicit) ||
        right.score - left.score ||
        (left.skillId < right.skillId ? -1 : left.skillId > right.skillId ? 1 : 0),
    );
  return {
    method: "metadata_bm25_v1",
    candidates: ranked.slice(0, boundedLimit),
    queryTruncated: input.text.length > MAX_QUERY_CHARS || new Set(queryTokens).size > MAX_TERMS,
    candidatesTruncated: skills.length > MAX_CANDIDATES || ranked.length > boundedLimit,
  };
}

function boundedMetadata(values: readonly string[]): string {
  return values
    .slice(0, 96)
    .map((value) => value.slice(0, 256))
    .join(" ")
    .slice(0, MAX_FIELD_CHARS);
}

function tokenize(value: string): string[] {
  return (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((term) => !STOP_WORDS.has(term)).slice(0, 512);
}
