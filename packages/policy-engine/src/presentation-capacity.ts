export const MAX_PRESENTATION_BULLET_CHARACTERS = 240;
export const MAX_PRESENTATION_BULLETS_PER_SLIDE = 5;

const BULLET_CHARACTERS_PER_LINE = 92;
const BULLET_LINE_CAPACITY = 11;
const TABLE_WIDTH_CHARACTER_BUDGET = 124;
const TABLE_LINE_HEIGHT = 0.205;
const TABLE_AVAILABLE_HEIGHT = 4.35;
const TABLE_AVAILABLE_HEIGHT_WITH_INTRO = 3.55;
const MAX_TABLE_ROW_HEIGHT = 2.45;
const SOURCE_AVAILABLE_HEIGHT = 5;
const MAX_SOURCE_URL_CHARACTERS = 480;
const MAX_SOURCE_URL_SEGMENT_CHARACTERS = 120;

export interface PresentationSourceEntryLayout {
  labelHeight: number;
  urlHeight: number;
  cardHeight: number;
  advance: number;
}

export function presentationBulletCapacityFindings(authoredText: string, layoutText = authoredText): string[] {
  const findings: string[] = [];
  if (authoredText.length > MAX_PRESENTATION_BULLET_CHARACTERS) {
    findings.push(
      `bullet text is ${authoredText.length} characters; the maximum is ${MAX_PRESENTATION_BULLET_CHARACTERS}`,
    );
  }
  if (presentationBulletLineCount(layoutText) > BULLET_LINE_CAPACITY) {
    findings.push(`bullet text requires more than ${BULLET_LINE_CAPACITY} estimated lines`);
  }
  return findings;
}

export function paginatePresentationItems<T>(
  items: readonly T[],
  textOf: (item: T) => string,
  options: { authoredTextOf?: (item: T) => string; maxItems?: number; maxLines?: number } = {},
): T[][] {
  if (items.length === 0) return [[]];
  const maxItems = options.maxItems ?? MAX_PRESENTATION_BULLETS_PER_SLIDE;
  const maxLines = options.maxLines ?? BULLET_LINE_CAPACITY;
  const pages: T[][] = [];
  let page: T[] = [];
  let lineCount = 0;
  for (const item of items) {
    const layoutText = textOf(item);
    const authoredText = options.authoredTextOf?.(item) ?? layoutText;
    const findings = presentationBulletCapacityFindings(authoredText, layoutText);
    if (findings.length > 0) {
      throw new Error(`Presentation content overflow: ${findings.join("; ")}.`);
    }
    const itemLines = presentationBulletLineCount(layoutText);
    if (itemLines > maxLines) {
      throw new Error(`Presentation content overflow: bullet text requires more than ${maxLines} estimated lines.`);
    }
    if (page.length > 0 && (page.length >= maxItems || lineCount + itemLines > maxLines)) {
      pages.push(page);
      page = [];
      lineCount = 0;
    }
    page = [...page, item];
    lineCount += itemLines;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

export function presentationBulletLineCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / BULLET_CHARACTERS_PER_LINE));
}

export function paginatePresentationTableRows<T>(input: {
  headers: readonly T[];
  rows: readonly (readonly T[])[];
  textOf: (cell: T) => string;
  hasIntro: boolean;
}): T[][][] {
  const availableHeight = input.hasIntro ? TABLE_AVAILABLE_HEIGHT_WITH_INTRO : TABLE_AVAILABLE_HEIGHT;
  const headerHeight = presentationTableRowHeight(input.headers.map(input.textOf), input.headers.length, true);
  if (headerHeight >= availableHeight) {
    throw new Error("Presentation content overflow: table headers cannot fit at the 14 pt typography floor.");
  }
  const pages: T[][][] = [];
  let page: T[][] = [];
  let usedHeight = headerHeight;
  for (const row of input.rows) {
    const rowHeight = presentationTableRowHeight(row.map(input.textOf), input.headers.length, false);
    if (rowHeight > MAX_TABLE_ROW_HEIGHT || headerHeight + rowHeight > availableHeight) {
      throw new Error("Presentation content overflow: a table cell cannot fit at the 14 pt typography floor.");
    }
    if (page.length > 0 && usedHeight + rowHeight > availableHeight) {
      pages.push(page);
      page = [];
      usedHeight = headerHeight;
    }
    page = [...page, [...row]];
    usedHeight += rowHeight;
  }
  if (page.length > 0) pages.push(page);
  return pages.length > 0 ? pages : [[]];
}

export function presentationTableRowHeights(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): number[] {
  const columnCount = headers.length;
  return [
    presentationTableRowHeight(headers, columnCount, true),
    ...rows.map((row) => presentationTableRowHeight(row, columnCount, false)),
  ];
}

export function presentationTableCapacityFindings(input: {
  headers: readonly string[];
  rows: readonly (readonly string[])[];
  hasIntro: boolean;
}): string[] {
  try {
    const pages = paginatePresentationTableRows({ ...input, textOf: (cell) => cell });
    return pages.length > 1 ? ["table rows require additional pagination"] : [];
  } catch (error) {
    return [error instanceof Error ? error.message : "table content cannot fit"];
  }
}

export function paginatePresentationSources<T>(
  sources: readonly T[],
  labelOf: (source: T) => string,
  urlOf: (source: T) => string,
): T[][] {
  const pages: T[][] = [];
  let page: T[] = [];
  let usedHeight = 0;
  for (const source of sources) {
    const label = labelOf(source);
    const url = urlOf(source);
    const findings = presentationSourceCapacityFindings(label, url);
    if (findings.length > 0) {
      throw new Error(`Presentation content overflow: ${findings.join("; ")}.`);
    }
    const advance = presentationSourceEntryLayout(label, url).advance;
    if (page.length > 0 && usedHeight + advance > SOURCE_AVAILABLE_HEIGHT) {
      pages.push(page);
      page = [];
      usedHeight = 0;
    }
    page = [...page, source];
    usedHeight += advance;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

export function presentationSourceCapacityFindings(label: string, url: string): string[] {
  const findings: string[] = [];
  if (url.length > MAX_SOURCE_URL_CHARACTERS) {
    findings.push(`source URL is ${url.length} characters; the maximum is ${MAX_SOURCE_URL_CHARACTERS}`);
  }
  if (longestSourceUrlSegment(url) > MAX_SOURCE_URL_SEGMENT_CHARACTERS) {
    findings.push(
      `source URL contains an unbreakable segment longer than ${MAX_SOURCE_URL_SEGMENT_CHARACTERS} characters`,
    );
  }
  if (presentationSourceEntryLayout(label, url).advance > SOURCE_AVAILABLE_HEIGHT) {
    findings.push("source label and URL cannot fit at the 12 pt source typography floor");
  }
  return findings;
}

export function presentationSourceEntryLayout(label: string, url: string): PresentationSourceEntryLayout {
  const labelLines = Math.max(1, Math.ceil(label.length / 96));
  const urlLines = Math.max(1, Math.ceil(url.length / 92));
  const labelHeight = Math.max(0.3, labelLines * 0.26);
  const urlHeight = Math.max(0.32, urlLines * 0.24);
  const cardHeight = 0.15 + labelHeight + 0.1 + urlHeight + 0.16;
  return { labelHeight, urlHeight, cardHeight, advance: cardHeight + 0.1 };
}

function presentationTableRowHeight(cells: readonly string[], columnCount: number, header: boolean): number {
  const charactersPerLine = Math.max(12, Math.floor(TABLE_WIDTH_CHARACTER_BUDGET / Math.max(1, columnCount)));
  const lineCount = Math.max(1, ...cells.map((cell) => Math.ceil(cell.length / charactersPerLine)));
  return Math.max(header ? 0.58 : 0.52, 0.18 + lineCount * TABLE_LINE_HEIGHT);
}

function longestSourceUrlSegment(url: string): number {
  return Math.max(0, ...url.split(/[/?&=._-]+/u).map((segment) => segment.length));
}
