import type { ChatWebMode } from "@goatcitadel/contracts";

/**
 * Decides whether a Chat turn counts as a web lookup. Regex-detected web intent always counts;
 * Deep mode also counts on its own unless the turn targets a local file or is a workflow-skill
 * capture. Web Off never counts, whatever was detected.
 */
export function resolveTurnWebLookupIntent(input: {
  webMode: ChatWebMode;
  detectedWebLookupIntent: boolean;
  localFileIntent: boolean;
  workflowSkillCapture: boolean;
}): boolean {
  if (input.webMode === "off") return false;
  return (
    input.detectedWebLookupIntent || (input.webMode === "deep" && !input.localFileIntent && !input.workflowSkillCapture)
  );
}

const SEED_QUERY_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "it",
  "this",
  "that",
  "me",
  "my",
  "please",
  "hi",
  "hello",
  "hey",
  "thanks",
]);
const MIN_SEED_QUERY_CONTENT_WORDS = 3;
const MIN_LATIN_WORD_LENGTH = 2;
const LATIN_OR_DIGIT_WORD = /^[\p{Script=Latin}\p{N}]+$/u;

/**
 * True when a derived search query has at least three content words. Words come from
 * `Intl.Segmenter`, so scripts written without spaces (Chinese, Japanese, Thai) count word by
 * word. Latin/digit words must be at least two characters long and not a stopword; words in
 * other scripts are often a single character, so they count regardless of length. Deep mode
 * uses it so a greeting or a short follow-up does not open with a web search on its own.
 */
export function hasSubstantiveSeedQuery(query: string): boolean {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  let contentWords = 0;
  for (const segment of segmenter.segment(query)) {
    if (!segment.isWordLike) {
      continue;
    }
    const word = segment.segment.toLowerCase();
    if (LATIN_OR_DIGIT_WORD.test(word) && (word.length < MIN_LATIN_WORD_LENGTH || SEED_QUERY_STOPWORDS.has(word))) {
      continue;
    }
    contentWords += 1;
    if (contentWords >= MIN_SEED_QUERY_CONTENT_WORDS) {
      return true;
    }
  }
  return false;
}
