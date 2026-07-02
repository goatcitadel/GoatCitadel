import type { ChatCitationRecord, MemoryCitationProvenance, MemoryRetrievalMatchSignals } from "@goatcitadel/contracts";

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
    readNonEmptyString(provenance.relationScope),
    readNonEmptyString(provenance.freshness),
    provenance.sourceTimestamp ? `source ${provenance.sourceTimestamp}` : null,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" · ");
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
  const parts = splitMarkdownFenceSegments(content);
  const normalized = parts
    .map((part) => (part.kind === "code" ? part.value : stripHtmlNoise(part.value)))
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
    .map(preserveMarkdownIndentation)
    .join("\n");
}

type MarkdownFenceSegment = { kind: "text" | "code"; value: string };

function splitMarkdownFenceSegments(content: string): MarkdownFenceSegment[] {
  const segments: MarkdownFenceSegment[] = [];
  let inFence = false;
  let fenceChar: "`" | "~" | null = null;
  let fenceLength = 0;
  let textStart = 0;
  let codeStart = -1;
  let lineStart = 0;

  for (let index = 0; index <= content.length; index += 1) {
    const hasLineBreak = index < content.length && content[index] === "\n";
    const atLineEnd = index === content.length || hasLineBreak;
    if (!atLineEnd) {
      continue;
    }
    const line = content.slice(lineStart, index);
    if (!inFence) {
      const opening = matchMarkdownFenceOpening(line);
      if (opening) {
        const lineEnd = index + (hasLineBreak ? 1 : 0);
        if (lineStart > textStart) {
          segments.push({ kind: "text", value: content.slice(textStart, lineStart) });
        }
        codeStart = lineStart;
        if (hasSameLineFenceClose(line, opening.char, opening.length, opening.start + opening.length)) {
          segments.push({ kind: "code", value: content.slice(codeStart, lineEnd) });
          textStart = lineEnd;
          codeStart = -1;
        } else {
          inFence = true;
          fenceChar = opening.char;
          fenceLength = opening.length;
        }
      }
    } else if (fenceChar && matchMarkdownFenceClosing(line, fenceChar, fenceLength)) {
      const lineEnd = index + (hasLineBreak ? 1 : 0);
      segments.push({ kind: "code", value: content.slice(codeStart, lineEnd) });
      textStart = lineEnd;
      codeStart = -1;
      inFence = false;
      fenceChar = null;
      fenceLength = 0;
    }
    lineStart = index + 1;
  }

  if (inFence && codeStart >= 0) {
    segments.push({ kind: "code", value: content.slice(codeStart) });
    textStart = content.length;
  }
  if (textStart < content.length) {
    segments.push({ kind: "text", value: content.slice(textStart) });
  }
  return segments.length > 0 ? segments : [{ kind: "text", value: "" }];
}

function matchMarkdownFenceOpening(line: string): { char: "`" | "~"; length: number; start: number } | null {
  const match = /^( {0,3})(`{3,}|~{3,})/.exec(line);
  if (!match) {
    return null;
  }
  const marker = match[2]!;
  return { char: marker[0] as "`" | "~", length: marker.length, start: match[1]!.length };
}

function matchMarkdownFenceClosing(line: string, fenceChar: "`" | "~", fenceLength: number): boolean {
  const marker = fenceChar.repeat(fenceLength);
  const match = new RegExp(`^ {0,3}${escapeRegExp(marker)}+`).exec(line);
  if (!match) {
    return false;
  }
  return line.slice(match[0].length).trim().length === 0;
}

function hasSameLineFenceClose(line: string, fenceChar: "`" | "~", fenceLength: number, searchStart: number): boolean {
  for (let index = searchStart; index <= line.length - fenceLength; index += 1) {
    if (line[index] !== fenceChar) {
      continue;
    }
    let markerLength = 0;
    while (line[index + markerLength] === fenceChar) {
      markerLength += 1;
    }
    if (markerLength >= fenceLength && line.slice(index + markerLength).trim().length === 0) {
      return true;
    }
    index += Math.max(0, markerLength - 1);
  }
  return false;
}

function preserveMarkdownIndentation(line: string): string {
  const indent = /^[ \t\f\v]*/.exec(line)?.[0] ?? "";
  const rest = line
    .slice(indent.length)
    .replace(/[ \t\f\v]{2,}/g, " ")
    .trimEnd();
  return `${indent}${rest}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
