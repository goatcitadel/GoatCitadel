import { redactSecretText, type ChatMessageSourceAuthority } from "@goatcitadel/contracts";

export interface MemoryIntentProposal {
  kind: "explicit_save" | "correction" | "inferred_candidate";
  content: string;
  itemType: "preference" | "fact";
  claimHint?: { subject: string; predicate: string; cardinality: "scalar" | "set"; value: string };
  sourceMessageId: string;
}
export interface MemoryIntentResult {
  kind: "none" | MemoryIntentProposal["kind"];
  proposals: MemoryIntentProposal[];
  truncated: boolean;
  remainderDisposition?: "deferred";
}

const WEEKLY_UPDATE_PREFERENCE =
  /^(?:(?:please\s+)?remember(?:\s+that)?\s+|actually[,\s]+|no[,\s]+|correction[:,\s]+)?I\s+prefer\s+(?:a\s+)?([1-9]\d?|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]+bullets?\s+weekly\s+updates?[.!]?$/iu;
const BULLET_COUNT_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
export function classifyMemoryIntent(input: {
  content: string;
  sourceAuthority: ChatMessageSourceAuthority;
  sourceMessageId: string;
}): MemoryIntentResult {
  const truncated = input.content.length > 8000;
  const base = { truncated, ...(truncated ? { remainderDisposition: "deferred" as const } : {}) };
  if (input.sourceAuthority !== "operator" || !input.sourceMessageId.trim())
    return { kind: "none", proposals: [], ...base };
  const bounded = input.content.slice(0, 8000).normalize("NFKC");
  if (redactSecretText(bounded, { env: process.env }).redactionCount) return { kind: "none", proposals: [], ...base };
  const proposals: MemoryIntentProposal[] = [];
  for (const content of memoryIntentSentences(bounded)) {
    if (
      !content ||
      content.endsWith("?") ||
      /^(?:if|suppose|imagine|hypothetically|what|why|how|do|does|did|can|could|would|should|si\s+(?:yo|prefiriera)|sup[oó]n|imagina|¿)/iu.test(
        content,
      )
    )
      continue;
    const explicit =
      /^(?:(?:please|por favor)[,\s]+)?(?:remember(?:\s+that)?|keep\s+in\s+mind(?:\s+that)?|take\s+note(?:\s+that)?|recuerda(?:\s+que)?|recuerde(?:\s+que)?|ten\s+en\s+cuenta(?:\s+que)?|guarda(?:\s+que)?)\b/iu.test(
        content,
      );
    const correction =
      /^(?:no[,;:\s]+|actually[,;:\s]+|correction[,;:\s]+|en\s+realidad[,;:\s]+)/iu.test(content) &&
      /\b(?:use|prefer|want|from now on|usa|utiliza|prefiero|de ahora en adelante)\b/iu.test(content);
    const inferred =
      /^(?:i\s+(?:prefer|like|want)|my\s+preference\s+is|prefiero|me\s+gusta(?:n)?|i\s+am\s+(?:a|an))\b/iu.test(
        content,
      );
    if (!explicit && !correction && !inferred) continue;
    if (content.length > 1000) {
      base.truncated = true;
      base.remainderDisposition = "deferred";
      continue;
    }
    const kind = correction ? "correction" : explicit ? "explicit_save" : "inferred_candidate";
    const hint = identifyProperty(content);
    proposals.push({
      kind,
      content: content.slice(0, 1200),
      itemType: hint || /\b(?:prefer|like|prefiero|gusta|replies|respuestas)\b/iu.test(content) ? "preference" : "fact",
      sourceMessageId: input.sourceMessageId,
      ...(hint ? { claimHint: hint } : {}),
    });
    if (proposals.length === 8) break;
  }
  const unique = [...new Map(proposals.map((proposal) => [proposal.content.toLowerCase(), proposal])).values()];
  return {
    kind:
      unique.find((proposal) => proposal.kind === "correction")?.kind ??
      unique.find((proposal) => proposal.kind === "explicit_save")?.kind ??
      unique[0]?.kind ??
      "none",
    proposals: unique,
    ...base,
  };
}

/** Keep quotations and code out of both natural capture and the legacy session-evidence reader. */
export function memoryIntentSentences(content: string): string[] {
  let inFence = false;
  return content
    .slice(0, 8000)
    .normalize("NFKC")
    .split(/\r?\n/u)
    .filter((line) => {
      if (/^\s*(?:```|~~~)/u.test(line)) {
        inFence = !inFence;
        return false;
      }
      if (inFence || /^\s*(?:>|["“”'])/u.test(line)) return false;
      if (
        /["“”']/u.test(line) &&
        /\b(?:says?|said|quoted|quotation|webpage|website|document|email|external|tool\s+output)\b/iu.test(line)
      )
        return false;
      return true;
    })
    .flatMap((line) => line.split(/(?<=[.!?])\s+/u))
    .map((line) => line.trim())
    .filter(Boolean);
}

function identifyProperty(content: string): MemoryIntentProposal["claimHint"] {
  const hint = (predicate: string, value: string) => ({
    subject: "operator",
    predicate,
    cardinality: "scalar" as const,
    value,
  });
  const weeklyCount = WEEKLY_UPDATE_PREFERENCE.exec(content)?.[1]?.toLowerCase();
  if (weeklyCount) {
    const count = Number(weeklyCount) || BULLET_COUNT_WORDS.indexOf(weeklyCount) + 1;
    return hint("weekly_update_bullet_count", String(count));
  }
  if (
    /\b(?:repl(?:y|ies)|responses?|answers?|explanations?|reports?|respuestas?|explicaciones?|informes?)\b/iu.test(
      content,
    )
  ) {
    const concise = /\b(?:concise|brief|short|terse|concisas?|concisos?|breves?|cortas?)\b/iu.test(content);
    const detailed = /\b(?:detailed|thorough|long|detalladas?|detallados?|extensas?)\b/iu.test(content);
    if (concise !== detailed) return hint("reply_length", concise ? "concise" : "detailed");
    if (/\b(?:bullet\s+points?|bullets|vi[nñ]etas)\b/iu.test(content)) return hint("reply_format", "bullets");
    const language =
      /\b(english|spanish|french|german|japanese|ingl[eé]s|espa[nñ]ol|franc[eé]s|alem[aá]n|japon[eé]s)\b/iu
        .exec(content)?.[1]
        ?.toLowerCase();
    const languages: Record<string, string> = {
      english: "English",
      spanish: "Spanish",
      french: "French",
      german: "German",
      japanese: "Japanese",
      inglés: "English",
      español: "Spanish",
      francés: "French",
      alemán: "German",
      japonés: "Japanese",
    };
    if (language && languages[language]) return hint("reply_language", languages[language]!);
  }
  if (/\b(?:dates?|fechas?)\b/iu.test(content) && /\bYYYY-MM-DD\b/u.test(content))
    return hint("date_format", "YYYY-MM-DD");
  return undefined;
}

/** A property hint for review-only maintenance; it conveys no write or replacement authority. */
export function identifyReviewMemoryProperty(content: string): MemoryIntentProposal["claimHint"] {
  return identifyProperty(content);
}

/** Model guidance only; the completed-turn owner still rechecks all write authority. */
export function buildNaturalMemoryReviewInstruction(
  input: Parameters<typeof classifyMemoryIntent>[0],
): string | undefined {
  if (!classifyMemoryIntent(input).proposals.length) return undefined;
  return "Memory handling for this turn: Gateway is responsible for preparing matching preferences from the user's message for explicit operator review after this turn succeeds. They are not saved yet. Do not call memory.upsert or memory.write for those same preferences or report them as saved. For a preference-only request, acknowledge pending review without calling tools; Gateway handles matching existing preferences. Continue any other requested work under current policy. The current message already qualifies: do not ask the user to repeat it, add a special prefix, or send another save request. Explain that the preference needs the Save to memory review decision. Do not claim a proposal was created before its receipt. Reading existing memory for other requested work still follows current policy.";
}

/** Conservative downscope for preference-only turns; mixed work keeps its ordinary tools. */
export function isNaturalMemoryReviewOnlyTurn(content: string): boolean {
  if (
    content.length > 1000 ||
    !classifyMemoryIntent({ content, sourceAuthority: "operator", sourceMessageId: "review-only-check" }).proposals
      .length
  )
    return false;
  const english =
    /^(?:(?:please\s+)?remember(?:\s+that)?\s+)?(?:I\s+prefer|(?:no,?\s+)?use)\s+(?:concise|brief|short|terse|detailed|thorough|long)\s+(?:replies|responses|answers|explanations|reports)(?:\s+(?:from\s+now\s+on|going\s+forward))?[.!]?$/iu;
  const spanish =
    /^(?:recuerda(?:\s+que)?\s+)?(?:prefiero\s+(?:respuestas|explicaciones|informes)\s+(?:breves|concisas|detalladas)|(?:no,?\s+)?(?:usa|utiliza)\s+(?:respuestas|explicaciones)\s+(?:breves|concisas|detalladas))(?:\s+(?:a\s+partir\s+de\s+ahora|de\s+ahora\s+en\s+adelante))?[.!]?$/iu;
  const save =
    /^(?:save|store)\s+(?:this|my)\s+preference(?:\s+in\s+(?:your\s+)?(?:persistent\s+)?memory)?(?:,?\s+(?:and|then)\s+(?:briefly\s+)?acknowledge(?:\s+what\s+was\s+saved|\s+it)?)?[.!]?$/iu;
  const replace =
    /^replace\s+my\s+(?:saved\s+)?(?:reply[-\s]length\s+)?preference\s+with\s+(?:concise\s+replies|detailed\s+explanations)[.!]?$/iu;
  const sentences = content
    .normalize("NFKC")
    .trim()
    .split(/(?<=[.!?])\s+/u);
  return (
    sentences.length > 0 &&
    sentences.every(
      (sentence) =>
        english.test(sentence) ||
        spanish.test(sentence) ||
        save.test(sentence) ||
        replace.test(sentence) ||
        WEEKLY_UPDATE_PREFERENCE.test(sentence),
    )
  );
}
