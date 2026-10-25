// "The best option", "a good choice", "the right one": a referent with no subject of its own.
const VAGUE_REFERENT_PATTERN =
  /\b(?:the|a|an|my|our)\s+(?:best|right|better|top|ideal|good|smartest|safest|cheapest)\s+(?:option|options|choice|choices|one|pick|solution|approach|thing|move|path|deal)\b/i;

// Words that only say what to do or who it is for. A prompt made of nothing else names no subject.
const FILLER_WORDS = new Set([
  "a",
  "ahead",
  "an",
  "and",
  "can",
  "check",
  "choose",
  "could",
  "decide",
  "do",
  "find",
  "for",
  "get",
  "give",
  "go",
  "help",
  "i",
  "into",
  "it",
  "just",
  "look",
  "make",
  "me",
  "my",
  "now",
  "online",
  "or",
  "our",
  "out",
  "pick",
  "please",
  "quickly",
  "recommend",
  "research",
  "search",
  "select",
  "should",
  "tell",
  "that",
  "the",
  "then",
  "this",
  "to",
  "up",
  "us",
  "web",
  "what",
  "which",
  "would",
  "you",
  "yourself",
]);

interface HistoryMessage {
  role?: unknown;
  content?: unknown;
}

function hasEarlierUserTurn(userPrompt: string, historyMessages: readonly HistoryMessage[]): boolean {
  const userMessages = historyMessages.filter((message) => message.role === "user");
  const last = userMessages.at(-1);
  // The runner's history usually ends with the current message; any other user message may give the referent.
  const current = typeof last?.content === "string" && last.content.trim() === userPrompt.trim() ? 1 : 0;
  return userMessages.length > current;
}

function namesNoSubject(userPrompt: string, referent: string): boolean {
  const remainder = userPrompt.replace(referent, " ").toLowerCase();
  const words = remainder.match(/[\p{L}\p{N}$'’-]+/gu) ?? [];
  return words.every((word) => FILLER_WORDS.has(word));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Under Manual tool autonomy, a request such as "Research the best option for me and decide." names no subject,
 * so declining the web lookup is not the useful answer: what the user means is. This asks for it and still says
 * tools are off. It is deterministic and runs no model or tool, like the decline it replaces. Prompts with any
 * subject, or with an earlier user turn that may supply one, return undefined and keep the decline.
 */
export function buildManualAutonomyClarification(
  userPrompt: string,
  historyMessages: readonly HistoryMessage[],
): string | undefined {
  const referent = VAGUE_REFERENT_PATTERN.exec(userPrompt)?.[0];
  if (!referent || !namesNoSubject(userPrompt, referent) || hasEarlierUserTurn(userPrompt, historyMessages)) {
    return undefined;
  }
  const quoted = capitalize(referent.toLowerCase());
  return [
    `"${quoted}" for what? Tell me what you're choosing between and what matters most to you (for example cost, speed, quality, or risk), and I'll compare them and recommend one.`,
    "",
    "Note: tool autonomy is set to Manual for this chat, so I can't run web or browser tools this turn. Once you tell me, I can answer from what I already know, or you can set Inspect > Conversation > Tool autonomy to Safe Auto and resend for a web-backed answer.",
  ].join("\n");
}
