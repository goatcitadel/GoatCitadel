const FENCED_CODE_BLOCK_RE = /(```[\s\S]*?```)/g;
const RAW_HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const RAW_HTML_BLOCK_RE = /<(script|style|svg|math|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const RAW_HTML_TAG_RE = /<\/?[A-Za-z][^>\n]{0,1000}>/g;
const RAW_HTML_DANGLING_TAG_RE = /<[A-Za-z][^<\n]{0,1000}$/gm;
const HTML_LINE_BREAK_RE = /<\s*br\s*\/?>/gi;
const HTML_BLOCK_BREAK_RE =
  /<\/?(?:address|article|aside|blockquote|div|dl|dt|dd|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi;

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
  return decodeBasicHtmlEntities(content)
    .replace(RAW_HTML_COMMENT_RE, "")
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
  return /<!--[\s\S]*?-->/.test(content) || /<\/?[A-Za-z][^>\n]{0,1000}>/.test(content);
}
