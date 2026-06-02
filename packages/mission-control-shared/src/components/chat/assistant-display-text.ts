import type { ChatCitationRecord, MemoryCitationProvenance, MemoryRetrievalMatchSignals } from "@goatcitadel/contracts";

const FENCED_CODE_BLOCK_RE = /(```[\s\S]*?```)/g;
const RAW_HTML_BLOCK_RE = /<(script|style|svg|math|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const RAW_HTML_TAG_RE = /<\/?[A-Za-z][^>\n]{0,1000}>/g;
const RAW_HTML_DANGLING_TAG_RE = /<[A-Za-z][^<\n]{0,1000}$/gm;
const HTML_LINE_BREAK_RE = /<\s*br\s*\/?>/gi;
const HTML_BLOCK_BREAK_RE =
  /<\/?(?:address|article|aside|blockquote|div|dl|dt|dd|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi;
const HTML_COMMENT_STRIP_MAX_PASSES = 20;

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
  apos: "'",
};

export function normalizeAssistantDisplayText(content: string): string {
  const decoded = decodeJsonUnicodeEscapes(content);
  return stripHtmlNoiseOutsideCode(decoded);
}

export function normalizeCitationDisplayText(content: string | undefined | null): string | undefined {
  if (!content) {
    return undefined;
  }
  const normalized = stripHtmlNoiseOutsideCode(decodeJsonUnicodeEscapes(content));
  return normalized.trim() || undefined;
}

export function isMemoryCitation(citation: ChatCitationRecord): boolean {
  return (
    citation.sourceType === "memory" || citation.url?.startsWith("memory://") === true || Boolean(citation.provenance)
  );
}

export function formatMemoryRetrievalStrategy(value: MemoryCitationProvenance["retrievalStrategy"]): string | null {
  switch (value) {
    case "semantic_vector":
      return "semantic vector";
    case "semantic_hints":
      return "semantic hints";
    case "lexical_recency":
      return "lexical/recency";
    default:
      return null;
  }
}

export function formatMemoryScore(value: number | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : null;
}

export function formatMemorySignals(signals: MemoryRetrievalMatchSignals | undefined): string | null {
  if (!signals) {
    return null;
  }
  return [
    ["total", signals.totalScore],
    ["lexical", signals.lexicalScore],
    ["vector", signals.semanticVectorScore],
    ["hint", signals.semanticHintScore],
    ["recency", signals.recencyScore],
    ["diversity", signals.diversityScore],
  ]
    .map(([label, value]) => {
      const score = typeof value === "number" ? formatMemoryScore(value) : null;
      return score ? `${label} ${score}` : null;
    })
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

export function formatMemoryCitationMeta(provenance: MemoryCitationProvenance | undefined): string | null {
  if (!provenance) {
    return null;
  }
  return [
    formatMemoryRetrievalStrategy(provenance.retrievalStrategy),
    provenance.relationScope,
    provenance.freshness,
    provenance.sourceTimestamp ? `source ${provenance.sourceTimestamp}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

export function decodeJsonUnicodeEscapes(content: string): string {
  if (!/\\u[0-9a-fA-F]{4}/.test(content)) {
    return content;
  }
  return content.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function stripHtmlNoiseOutsideCode(content: string): string {
  const parts = content.split(FENCED_CODE_BLOCK_RE);
  const normalized = parts
    .map((part) => (part.startsWith("```") ? part : stripHtmlNoise(part)))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized || !looksLikeHtml(content)) {
    return normalized;
  }
  return "HTML-only content omitted.";
}

function stripHtmlNoise(content: string): string {
  return stripRawHtmlComments(decodeBasicHtmlEntities(content))
    .replace(RAW_HTML_BLOCK_RE, " ")
    .replace(HTML_LINE_BREAK_RE, "\n")
    .replace(HTML_BLOCK_BREAK_RE, "\n")
    .replace(RAW_HTML_TAG_RE, "")
    .replace(RAW_HTML_DANGLING_TAG_RE, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trimEnd())
    .join("\n")
    .replace(/[ \t\f\v]{2,}/g, " ");
}

function stripRawHtmlComments(content: string): string {
  let output = content;
  for (let pass = 0; pass < HTML_COMMENT_STRIP_MAX_PASSES; pass += 1) {
    const next = stripRawHtmlCommentsOnce(output);
    if (next === output) {
      return next;
    }
    output = next;
  }
  return output;
}

function stripRawHtmlCommentsOnce(content: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf("<!--", cursor);
    if (start === -1) {
      output += content.slice(cursor);
      break;
    }
    output += content.slice(cursor, start);
    const end = content.indexOf("-->", start + 4);
    if (end === -1) {
      const residualClose = content.indexOf(">", start + 4);
      if (residualClose !== -1 && residualClose - start <= 8) {
        cursor = residualClose + 1;
        continue;
      }
      break;
    }
    cursor = end + 3;
  }
  return output;
}

function decodeBasicHtmlEntities(content: string): string {
  return content.replace(/&(#x?[0-9a-fA-F]+|[A-Za-z]+);/g, (match, entity: string) => {
    const named = HTML_ENTITIES[entity.toLowerCase()];
    if (named !== undefined) {
      return named;
    }
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const value = Number.parseInt(entity.slice(2), 16);
      return decodeCodePoint(value) ?? match;
    }
    if (entity.startsWith("#")) {
      const value = Number.parseInt(entity.slice(1), 10);
      return decodeCodePoint(value) ?? match;
    }
    return match;
  });
}

function decodeCodePoint(value: number): string | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  try {
    return String.fromCodePoint(value);
  } catch {
    return undefined;
  }
}

function looksLikeHtml(content: string): boolean {
  return (content.includes("<!--") && content.includes("-->")) || /<\/?[A-Za-z][^>\n]{0,1000}>/.test(content);
}
