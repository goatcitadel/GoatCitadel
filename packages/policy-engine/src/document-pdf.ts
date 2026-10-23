import type { ArtifactDesignPlan } from "./artifact-design.js";
import {
  PdfDocumentWriter,
  PdfPage,
  countWinAnsiLoss,
  measureWinAnsi,
  mixPdfColors,
  pdfColor,
  pdfColorLuminance,
  toWinAnsiBytes,
  truncateWinAnsi,
  wrapWinAnsi,
  type PdfColor,
  type PdfFont,
} from "./pdf-writer.js";

/** US Letter portrait in points. */
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 60;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const CONTENT_TOP = 72;
const CONTENT_BOTTOM = 720;
const COVER_BAND_H = 300;
const BODY_SIZE = 11;
const BODY_LEADING = 1.45;
const HEADING_SIZE = 17;
const TABLE_SIZE = 9.5;
const TABLE_PADDING = 6;
const BULLET_INDENT = 18;
const SUMMARY_HEADING = /^(summary|overview|executive summary|introduction|at a glance)$/iu;

export interface DocumentPdfSection {
  heading: string;
  body: string;
  bullets: string[];
}

export interface DocumentPdfInput {
  title: string;
  body?: string;
  sections: DocumentPdfSection[];
  rows?: Array<Record<string, unknown> | unknown[]>;
  design: ArtifactDesignPlan;
  createdAt?: Date;
}

export interface DocumentPdfResult {
  buffer: Buffer;
  /** Layout names that were actually drawn, in first-use order. */
  layouts: string[];
  pageCount: number;
  warnings: string[];
}

interface ReportTheme {
  background: PdfColor;
  surface: PdfColor;
  text: PdfColor;
  muted: PdfColor;
  accent: PdfColor;
  border: PdfColor;
  band: PdfColor;
  onBand: PdfColor;
  onBandMuted: PdfColor;
}

/**
 * Renders a designed portrait report: a colored cover band, a summary callout, accented section
 * headings, marked bullets, and a paginated table for `rows`, all in the plan's design tokens.
 * Text uses the standard Helvetica faces, so no fonts or images are embedded.
 */
export function createDocumentPdf(input: DocumentPdfInput): DocumentPdfResult {
  const theme = resolveReportTheme(input.design);
  const warnings = latinWarnings(input);
  const flow = new ReportFlow(theme, input.title);
  const sections = [...input.sections];
  const summarySection = !input.body?.trim() && sections[0] && SUMMARY_HEADING.test(sections[0].heading.trim());
  const summary = input.body?.trim() || (summarySection ? sections.shift()!.body.trim() : "");

  drawCover(flow, input, summary);
  for (const section of sections) drawSection(flow, section);
  const table = rowsToTable(input.rows);
  if (table) drawTable(flow, table);

  const writer = new PdfDocumentWriter();
  const catalogId = writer.reserve();
  const pagesId = writer.reserve();
  const fonts = writer.addStandardFonts();
  const pageIds = flow.pages.map((page, index) => {
    if (index > 0) drawPageFooter(page, theme, input.title, index + 1);
    return writer.addPage(page, pagesId, fonts);
  });
  writer.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  writer.set(
    pagesId,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`,
  );
  const infoId = writer.add(writer.infoDictionary(input.title));
  return {
    buffer: writer.serialize(catalogId, infoId),
    layouts: [...flow.layouts],
    pageCount: flow.pages.length,
    warnings,
  };
}

class ReportFlow {
  readonly pages: PdfPage[] = [];
  readonly layouts = new Set<string>();
  page: PdfPage;
  y = CONTENT_TOP;

  constructor(
    readonly theme: ReportTheme,
    readonly title: string,
  ) {
    this.page = this.addPage();
  }

  /** Starts a new page when `height` does not fit below the cursor. */
  ensure(height: number): void {
    if (this.y + height > CONTENT_BOTTOM) this.breakPage();
  }

  breakPage(): void {
    this.page = this.addPage();
    this.y = CONTENT_TOP;
  }

  private addPage(): PdfPage {
    const page = new PdfPage(PAGE_W, PAGE_H);
    page.rect(0, 0, PAGE_W, PAGE_H, this.theme.background);
    this.pages.push(page);
    return page;
  }
}

function drawCover(flow: ReportFlow, input: DocumentPdfInput, summary: string): void {
  const { page, theme } = flow;
  flow.layouts.add("report-cover");
  page.rect(0, 0, PAGE_W, COVER_BAND_H, theme.band);
  page.rect(MARGIN_X, 92, 56, 5, theme.onBand);
  const eyebrow = input.design.audience ? `For ${input.design.audience}` : "Report";
  page.text(MARGIN_X, 128, truncateWinAnsi(toWinAnsiBytes(eyebrow.toUpperCase()), "bold", 10, CONTENT_W), {
    font: "bold",
    size: 10,
    color: theme.onBandMuted,
  });
  const titleSize = fitSize(input.title, "bold", CONTENT_W, 38, 24, 3);
  const titleLines = wrapWinAnsi(toWinAnsiBytes(input.title), "bold", titleSize, CONTENT_W).slice(0, 3);
  titleLines.forEach((line, index) => {
    page.text(MARGIN_X, 150 + titleSize + index * titleSize * 1.12, line, {
      font: "bold",
      size: titleSize,
      color: theme.onBand,
    });
  });
  const date = (input.createdAt ?? new Date()).toISOString().slice(0, 10);
  page.text(MARGIN_X, COVER_BAND_H + 28, date, { font: "regular", size: 10, color: theme.muted });
  flow.y = COVER_BAND_H + 52;
  if (summary) drawCallout(flow, summary);
}

function drawCallout(flow: ReportFlow, text: string): void {
  const { theme } = flow;
  const lines = wrapParagraphs(text, CONTENT_W - 40, BODY_SIZE + 1);
  const leading = (BODY_SIZE + 1) * BODY_LEADING;
  const height = Math.min(lines.length * leading + 32, CONTENT_BOTTOM - flow.y);
  const visible = lines.slice(0, Math.max(1, Math.floor((height - 32) / leading)));
  flow.layouts.add("callout-box");
  flow.page.rect(MARGIN_X, flow.y, CONTENT_W, height, theme.surface, { color: theme.border, width: 0.75 });
  flow.page.rect(MARGIN_X, flow.y, 5, height, theme.accent);
  visible.forEach((line, index) => {
    flow.page.text(MARGIN_X + 24, flow.y + 16 + BODY_SIZE + 1 + index * leading, line, {
      font: "regular",
      size: BODY_SIZE + 1,
      color: theme.text,
    });
  });
  flow.y += height + 28;
  // A summary longer than the cover continues as body text rather than being cut.
  if (visible.length < lines.length) drawLines(flow, lines.slice(visible.length), BODY_SIZE + 1, 0);
}

function drawSection(flow: ReportFlow, section: DocumentPdfSection): void {
  const { theme } = flow;
  const headingLines = wrapWinAnsi(toWinAnsiBytes(section.heading), "bold", HEADING_SIZE, CONTENT_W - 16);
  const headingHeight = headingLines.length * HEADING_SIZE * 1.2;
  // Keep a heading with at least two lines of what follows it.
  flow.ensure(headingHeight + 12 + BODY_SIZE * BODY_LEADING * 2);
  flow.layouts.add("title-body");
  flow.page.rect(MARGIN_X, flow.y + 3, 4, HEADING_SIZE, theme.accent);
  headingLines.forEach((line, index) => {
    flow.page.text(MARGIN_X + 16, flow.y + HEADING_SIZE + index * HEADING_SIZE * 1.2, line, {
      font: "bold",
      size: HEADING_SIZE,
      color: theme.text,
    });
  });
  flow.y += headingHeight + 12;
  if (section.body.trim()) {
    drawLines(flow, wrapParagraphs(section.body, CONTENT_W, BODY_SIZE), BODY_SIZE, 0);
    flow.y += 6;
  }
  for (const bullet of section.bullets) drawBullet(flow, bullet);
  flow.y += 18;
}

function drawBullet(flow: ReportFlow, bullet: string): void {
  const lines = wrapWinAnsi(toWinAnsiBytes(bullet), "regular", BODY_SIZE, CONTENT_W - BULLET_INDENT);
  const leading = BODY_SIZE * BODY_LEADING;
  flow.ensure(leading);
  flow.page.rect(MARGIN_X + 3, flow.y + BODY_SIZE * 0.45, 5, 5, flow.theme.accent);
  drawLines(flow, lines, BODY_SIZE, BULLET_INDENT);
  flow.y += 4;
}

/** Draws pre-wrapped lines, breaking pages between lines; an empty line is a paragraph gap. */
function drawLines(flow: ReportFlow, lines: string[], size: number, indent: number): void {
  const leading = size * BODY_LEADING;
  for (const line of lines) {
    if (!line) {
      flow.y += leading * 0.5;
      continue;
    }
    flow.ensure(leading);
    flow.page.text(MARGIN_X + indent, flow.y + size, line, { font: "regular", size, color: flow.theme.text });
    flow.y += leading;
  }
}

interface ReportTable {
  headers: string[];
  rows: string[][];
}

function drawTable(flow: ReportFlow, table: ReportTable): void {
  const widths = columnWidths(table);
  const leading = TABLE_SIZE * 1.3;
  const layoutRow = (cells: string[], font: PdfFont) =>
    widths.map((width, index) =>
      wrapWinAnsi(toWinAnsiBytes(cells[index] ?? ""), font, TABLE_SIZE, width - TABLE_PADDING * 2),
    );
  const rowHeight = (row: string[][]) => Math.max(1, ...row.map((lines) => lines.length)) * leading + TABLE_PADDING * 2;
  const header = layoutRow(table.headers, "bold");
  const headerHeight = rowHeight(header);
  const rows = table.rows.map((cells) => layoutRow(cells, "regular"));
  const tableHeight = rows.reduce((sum, row) => sum + rowHeight(row), headerHeight);
  // Keep a table that fits on one page together, and never start one with fewer than three rows.
  const openingHeight = rows.slice(0, 3).reduce((sum, row) => sum + rowHeight(row), headerHeight);
  const keepTogether = tableHeight <= CONTENT_BOTTOM - CONTENT_TOP;
  flow.ensure(keepTogether ? tableHeight : openingHeight);
  flow.layouts.add("data-table");
  let drawHeader = true;
  for (const [index, row] of rows.entries()) {
    const height = rowHeight(row);
    if (flow.y > CONTENT_TOP && flow.y + (drawHeader ? headerHeight : 0) + height > CONTENT_BOTTOM) {
      flow.breakPage();
      drawHeader = true;
    }
    if (drawHeader) {
      // The header repeats on every page the table spans.
      flow.page.rect(MARGIN_X, flow.y, CONTENT_W, headerHeight, flow.theme.band);
      drawTableRow(flow, header, widths, "bold", flow.theme.onBand);
      flow.y += headerHeight;
      drawHeader = false;
    }
    const fill = index % 2 === 0 ? flow.theme.surface : mixPdfColors(flow.theme.surface, flow.theme.border, 0.25);
    flow.page.rect(MARGIN_X, flow.y, CONTENT_W, height, fill);
    flow.page.line(MARGIN_X, flow.y + height, MARGIN_X + CONTENT_W, flow.y + height, flow.theme.border, 0.5);
    drawTableRow(flow, row, widths, "regular", flow.theme.text);
    flow.y += height;
  }
  flow.y += 18;
}

function drawTableRow(flow: ReportFlow, row: string[][], widths: number[], font: PdfFont, color: PdfColor): void {
  let x = MARGIN_X;
  row.forEach((lines, column) => {
    lines.forEach((line, index) => {
      flow.page.text(x + TABLE_PADDING, flow.y + TABLE_PADDING + TABLE_SIZE + index * TABLE_SIZE * 1.3, line, {
        font,
        size: TABLE_SIZE,
        color,
      });
    });
    x += widths[column] ?? 0;
  });
}

/** Column widths in proportion to each column's longest text, with a readable minimum. */
function columnWidths(table: ReportTable): number[] {
  const count = Math.max(table.headers.length, 1);
  const weights = Array.from({ length: count }, (_, column) =>
    Math.min(40, Math.max(6, ...[table.headers, ...table.rows].map((cells) => (cells[column] ?? "").length))),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => (weight / total) * CONTENT_W);
}

function rowsToTable(rows: DocumentPdfInput["rows"]): ReportTable | undefined {
  if (!rows || rows.length === 0) return undefined;
  if (rows.every(Array.isArray)) {
    const [headers, ...body] = (rows as unknown[][]).map((row) => row.map(cellText));
    return headers && body.length > 0 ? { headers, rows: body } : undefined;
  }
  const records = rows.filter((row): row is Record<string, unknown> => !Array.isArray(row) && isRecord(row));
  const headers = [...new Set(records.flatMap((record) => Object.keys(record)))];
  if (headers.length === 0) return undefined;
  return { headers, rows: records.map((record) => headers.map((key) => cellText(record[key]))) };
}

function drawPageFooter(page: PdfPage, theme: ReportTheme, title: string, pageNumber: number): void {
  page.line(MARGIN_X, 744, PAGE_W - MARGIN_X, 744, theme.border, 0.75);
  const footer = truncateWinAnsi(toWinAnsiBytes(title), "regular", 9, CONTENT_W - 40);
  page.text(MARGIN_X, 760, footer, { font: "regular", size: 9, color: theme.muted });
  const number = String(pageNumber);
  page.text(PAGE_W - MARGIN_X - measureWinAnsi(number, "regular", 9), 760, number, {
    font: "regular",
    size: 9,
    color: theme.muted,
  });
}

function wrapParagraphs(text: string, width: number, size: number): string[] {
  const paragraphs = text
    .split(/\n\s*\n|\n/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return paragraphs.flatMap((paragraph, index) => [
    ...(index > 0 ? [""] : []),
    ...wrapWinAnsi(toWinAnsiBytes(paragraph), "regular", size, width),
  ]);
}

function fitSize(text: string, font: PdfFont, width: number, max: number, min: number, maxLines: number): number {
  const bytes = toWinAnsiBytes(text);
  for (let size = max; size > min; size -= 1) {
    if (wrapWinAnsi(bytes, font, size, width).length <= maxLines) return size;
  }
  return min;
}

function resolveReportTheme(design: ArtifactDesignPlan): ReportTheme {
  const text = pdfColor(design.tokens.text);
  const accent = pdfColor(design.tokens.accent);
  const white = pdfColor("FFFFFF");
  // The cover band and table header carry white text, so darken the accent toward the text color
  // until white reaches 4.5:1; a dark brand color passes unchanged.
  let band = accent;
  for (let weight = 0.1; contrastRatio(white, band) < 4.5 && weight <= 1; weight += 0.1) {
    band = mixPdfColors(accent, text, weight);
  }
  return {
    background: pdfColor(design.tokens.background),
    surface: pdfColor(design.tokens.surface),
    text,
    muted: pdfColor(design.tokens.mutedText),
    accent,
    border: pdfColor(design.tokens.border),
    band,
    onBand: white,
    onBandMuted: mixPdfColors(white, band, 0.25),
  };
}

function contrastRatio(left: PdfColor, right: PdfColor): number {
  const a = pdfColorLuminance(left);
  const b = pdfColorLuminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function latinWarnings(input: DocumentPdfInput): string[] {
  const text = [
    input.title,
    input.body ?? "",
    ...input.sections.flatMap((section) => [section.heading, section.body, ...section.bullets]),
  ].join("\n");
  const { lost } = countWinAnsiLoss(text);
  return lost > 0
    ? [
        `${lost} character(s) outside the PDF's Latin character set (such as emoji or non-Latin script) were replaced or dropped.`,
      ]
    : [];
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
