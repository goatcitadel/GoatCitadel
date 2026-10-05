import {
  measureWinAnsi,
  toWinAnsiBytes,
  truncateWinAnsi,
  wrapWinAnsi,
  type PdfColor,
  type PdfFont,
  type PdfPage,
} from "./pdf-writer.js";
import {
  presentationBulletSourceIds,
  presentationBulletText,
  sourceMap,
  type PresentationBullet,
  type PresentationSource,
  type PresentationTableCell,
} from "./presentation-model.js";

/** A styled word sequence; citation runs are drawn in the accent color and linked. */
export interface PdfTextRun {
  bytes: string;
  kind: "text" | "citation";
  url?: string;
}

interface PdfLineToken extends PdfTextRun {
  width: number;
}

export interface PdfTextBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfRunColors {
  text: PdfColor;
  citation: PdfColor;
}

export interface PdfBulletListOptions {
  font?: PdfFont;
  maxSize: number;
  minSize: number;
  colors: PdfRunColors;
  marker?: PdfColor;
  /** Link the whole entry to its first cited source (source appendix slides). */
  linkEntries?: boolean;
  /** Vertically center the list inside the box when it fits. */
  center?: boolean;
}

export const PDF_CITATION_FONT_SIZE = 11;
const LINE_HEIGHT = 1.28;

export function sourceLabel(sourceId: string, sources: readonly PresentationSource[]): string {
  return `S${
    Math.max(
      0,
      sources.findIndex((source) => source.id === sourceId),
    ) + 1
  }`;
}

export function bulletRuns(bullet: PresentationBullet, sources: readonly PresentationSource[]): PdfTextRun[] {
  return withCitations(presentationBulletText(bullet), presentationBulletSourceIds(bullet), sources);
}

export function tableCellRuns(cell: PresentationTableCell, sources: readonly PresentationSource[]): PdfTextRun[] {
  return withCitations(cell.text, cell.sourceIds ?? [], sources);
}

function withCitations(text: string, sourceIds: readonly string[], sources: readonly PresentationSource[]) {
  const byId = sourceMap(sources);
  const runs: PdfTextRun[] = [{ bytes: toWinAnsiBytes(text), kind: "text" }];
  for (const id of sourceIds) {
    const source = byId.get(id);
    if (source) runs.push({ bytes: `[${sourceLabel(id, sources)}]`, kind: "citation", url: source.url });
  }
  return runs;
}

/** Wraps styled runs into lines no wider than maxWidth. */
export function layoutRuns(runs: readonly PdfTextRun[], font: PdfFont, size: number, maxWidth: number) {
  const lines: PdfLineToken[][] = [];
  let line: PdfLineToken[] = [];
  let lineWidth = 0;
  const space = measureWinAnsi(" ", font, size);
  for (const run of runs) {
    const tokenSize = run.kind === "citation" ? Math.min(size, PDF_CITATION_FONT_SIZE + 2) : size;
    for (const word of wrapWinAnsi(run.bytes, font, tokenSize, maxWidth).flatMap((part) => part.split(" "))) {
      if (!word) continue;
      const width = measureWinAnsi(word, font, tokenSize);
      const needed = line.length > 0 ? lineWidth + space + width : width;
      if (line.length > 0 && needed > maxWidth) {
        lines.push(line);
        line = [];
        lineWidth = 0;
      }
      lineWidth = line.length > 0 ? lineWidth + space + width : width;
      line.push({ ...run, bytes: word, width });
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

export function drawRunLine(
  page: PdfPage,
  tokens: readonly PdfLineToken[],
  x: number,
  baseline: number,
  font: PdfFont,
  size: number,
  colors: PdfRunColors,
): void {
  const space = measureWinAnsi(" ", font, size);
  let cursor = x;
  for (const segment of mergeTokens(tokens, space)) {
    const tokenSize = segment.kind === "citation" ? Math.min(size, PDF_CITATION_FONT_SIZE + 2) : size;
    page.text(cursor, baseline, segment.bytes, {
      font,
      size: tokenSize,
      color: segment.kind === "citation" ? colors.citation : colors.text,
    });
    if (segment.kind === "citation" && segment.url) {
      page.link(cursor, baseline - tokenSize, segment.width, tokenSize * 1.25, segment.url);
    }
    cursor += segment.width + space;
  }
}

/** Joins adjacent plain words into one text run so viewers extract whole phrases. */
function mergeTokens(tokens: readonly PdfLineToken[], space: number): PdfLineToken[] {
  const segments: PdfLineToken[] = [];
  for (const token of tokens) {
    const previous = segments.at(-1);
    if (previous && previous.kind === "text" && token.kind === "text") {
      segments[segments.length - 1] = {
        ...previous,
        bytes: `${previous.bytes} ${token.bytes}`,
        width: previous.width + space + token.width,
      };
    } else {
      segments.push(token);
    }
  }
  return segments;
}

/**
 * Draws a bulleted list inside box, shrinking from maxSize to minSize to fit.
 * Returns true when content had to be truncated at the minimum size.
 */
export function drawBulletList(
  page: PdfPage,
  entries: ReadonlyArray<readonly PdfTextRun[]>,
  box: PdfTextBox,
  options: PdfBulletListOptions,
): boolean {
  const font = options.font ?? "regular";
  const indent = options.marker ? 22 : 0;
  let size = options.maxSize;
  let laidOut = entries.map((runs) => layoutRuns(runs, font, size, box.w - indent));
  while (size > options.minSize && listHeight(laidOut, size) > box.h) {
    size -= 1;
    laidOut = entries.map((runs) => layoutRuns(runs, font, size, box.w - indent));
  }
  const lineHeight = size * LINE_HEIGHT;
  const gap = size * 0.55;
  const contentHeight = listHeight(laidOut, size);
  let cursor = options.center && contentHeight < box.h ? box.y + (box.h - contentHeight) / 2 : box.y;
  let truncated = false;
  for (const [entryIndex, lines] of laidOut.entries()) {
    const entryTop = cursor;
    for (const [lineIndex, tokens] of lines.entries()) {
      if (cursor + lineHeight > box.y + box.h + 0.5) {
        truncated = true;
        break;
      }
      const isLastFitting = cursor + 2 * lineHeight > box.y + box.h + 0.5 && lineIndex < lines.length - 1;
      const drawn = isLastFitting ? ellipsize(tokens, font, size, box.w - indent) : tokens;
      truncated ||= isLastFitting;
      drawRunLine(page, drawn, box.x + indent, cursor + size, font, size, options.colors);
      if (lineIndex === 0 && options.marker) {
        const square = Math.max(5, size * 0.32);
        page.rect(box.x + 4, cursor + size * 0.62 - square / 2, square, square, options.marker);
      }
      cursor += lineHeight;
      if (isLastFitting) break;
    }
    const url = entries[entryIndex]?.find((run) => run.url)?.url;
    if (options.linkEntries && url) page.link(box.x, entryTop, box.w, cursor - entryTop, url);
    if (truncated) break;
    cursor += gap;
  }
  return truncated;
}

function listHeight(laidOut: ReadonlyArray<readonly unknown[]>, size: number): number {
  const lines = laidOut.reduce((count, lines) => count + lines.length, 0);
  return lines * size * LINE_HEIGHT + Math.max(0, laidOut.length - 1) * size * 0.55;
}

function ellipsize(tokens: readonly PdfLineToken[], font: PdfFont, size: number, maxWidth: number): PdfLineToken[] {
  const text = tokens.map((token) => token.bytes).join(" ");
  const bytes = truncateWinAnsi(`${text}${String.fromCharCode(0x85)}`, font, size, maxWidth);
  return [{ bytes, kind: "text", width: measureWinAnsi(bytes, font, size) }];
}

/** Draws plain text wrapped to at most maxLines, with an ellipsis on overflow. */
export function drawWrappedText(
  page: PdfPage,
  text: string,
  box: { x: number; y: number; w: number },
  style: { font: PdfFont; size: number; color: PdfColor; maxLines: number; align?: "left" | "center" },
): number {
  const lines = wrapWinAnsi(toWinAnsiBytes(text), style.font, style.size, box.w);
  const visible = lines.slice(0, style.maxLines);
  if (lines.length > style.maxLines && visible.length > 0) {
    visible[visible.length - 1] = truncateWinAnsi(
      `${visible[visible.length - 1]}${String.fromCharCode(0x85)}`,
      style.font,
      style.size,
      box.w,
    );
  }
  const lineHeight = style.size * 1.18;
  visible.forEach((line, index) => {
    const width = measureWinAnsi(line, style.font, style.size);
    const x = style.align === "center" ? box.x + (box.w - width) / 2 : box.x;
    page.text(x, box.y + style.size + index * lineHeight, line, style);
  });
  return visible.length * lineHeight;
}

/** Largest size in [minSize, maxSize] at which text wraps into maxLines. */
export function fitTextSize(
  text: string,
  font: PdfFont,
  maxWidth: number,
  maxSize: number,
  minSize: number,
  maxLines: number,
) {
  const bytes = toWinAnsiBytes(text);
  for (let size = maxSize; size > minSize; size -= 1) {
    if (wrapWinAnsi(bytes, font, size, maxWidth).length <= maxLines) return size;
  }
  return minSize;
}
