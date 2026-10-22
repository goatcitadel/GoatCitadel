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

/**
 * True when a derived search query has at least three content words: whitespace-split tokens,
 * trimmed of edge punctuation, at least two characters long, and not a stopword. Deep mode uses
 * it so a greeting or a short follow-up does not open with a web search on its own.
 */
export function hasSubstantiveSeedQuery(query: string): boolean {
  let contentWords = 0;
  for (const rawToken of query.split(/\s+/)) {
    const token = trimEdgePunctuation(rawToken).toLowerCase();
    if (token.length < 2 || SEED_QUERY_STOPWORDS.has(token)) {
      continue;
    }
    contentWords += 1;
    if (contentWords >= MIN_SEED_QUERY_CONTENT_WORDS) {
      return true;
    }
  }
  return false;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function trimEdgePunctuation(token: string): string {
  const chars = Array.from(token);
  let start = 0;
  let end = chars.length;
  while (start < end && !LETTER_OR_DIGIT.test(chars[start]!)) {
    start += 1;
  }
  while (end > start && !LETTER_OR_DIGIT.test(chars[end - 1]!)) {
    end -= 1;
  }
  return chars.slice(start, end).join("");
}
