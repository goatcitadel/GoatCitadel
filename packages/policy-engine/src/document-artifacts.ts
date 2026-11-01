import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { createArtifactDesignPlan, cssColor, type ArtifactDesignPlan } from "./artifact-design.js";
import { createDocumentPdf, createPlainDocumentPdf } from "./document-pdf.js";
import { createStoredZip, type ZipEntry } from "./presentation-pptx.js";

export type DocumentArtifactFormat = "markdown" | "txt" | "html" | "json" | "csv" | "docx" | "pdf";

export interface DocumentArtifactSection {
  heading: string;
  body: string;
  bullets: string[];
}

export interface DocumentArtifactInput {
  title: string;
  body?: string;
  sections: DocumentArtifactSection[];
  /** True when sections[0] is the generated "Summary" copy of body, not a section the caller sent. */
  bodySummaryIsFallback?: boolean;
  rows?: Array<Record<string, unknown> | unknown[]>;
  createdAt?: Date;
  /** IANA zone for visible dates (the PDF cover); defaults to the host's zone. */
  timeZone?: string;
  design?: ArtifactDesignPlan;
  /**
   * A complete HTML document authored by the model (only honored for the `html` format, only when
   * the gateway admitted it under a design receipt). Written verbatim: nothing is escaped.
   */
  html?: string;
}

export type DocumentArtifactMarkup = "template" | "model-authored";

export interface DocumentArtifactOutput {
  data: Buffer | string;
  extension: string;
  mimeType: string;
  binary: boolean;
  /** Whether the bytes came from the fixed renderer template or from model-authored markup. */
  markup: DocumentArtifactMarkup;
  /** PDF only: the layouts the renderer actually drew, so the design report never claims more. */
  renderedLayouts?: string[];
  /** PDF only: renderer warnings, such as characters the Latin font could not show. */
  warnings?: string[];
}

export const MODEL_AUTHORED_HTML_MAX_BYTES = 512 * 1024;

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

const FORMAT_OUTPUTS: Record<
  DocumentArtifactFormat,
  Pick<DocumentArtifactOutput, "extension" | "mimeType" | "binary">
> = {
  markdown: { extension: ".md", mimeType: "text/markdown", binary: false },
  txt: { extension: ".txt", mimeType: "text/plain", binary: false },
  html: { extension: ".html", mimeType: "text/html", binary: false },
  json: { extension: ".json", mimeType: "application/json", binary: false },
  csv: { extension: ".csv", mimeType: "text/csv", binary: false },
  docx: {
    extension: ".docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    binary: true,
  },
  pdf: { extension: ".pdf", mimeType: "application/pdf", binary: true },
};

export async function createDocumentArtifact(
  format: DocumentArtifactFormat,
  input: DocumentArtifactInput,
): Promise<DocumentArtifactOutput> {
  const output = { ...FORMAT_OUTPUTS[format], markup: "template" as const };
  switch (format) {
    case "markdown":
      return { ...output, data: buildMarkdown(input) };
    case "txt":
      return { ...output, data: buildPlainText(input) };
    case "html": {
      const modelAuthored = resolveModelAuthoredHtml(input.html);
      return modelAuthored === undefined
        ? { ...output, data: buildHtml(input) }
        : { ...output, data: modelAuthored, markup: "model-authored" };
    }
    case "json":
      return { ...output, data: JSON.stringify(toJsonDocument(input), null, 2) };
    case "csv":
      return { ...output, data: buildCsv(input) };
    case "docx":
      return { ...output, data: await buildDocx(input) };
    case "pdf": {
      const design = input.design;
      if (!design || design.mode === "plain" || design.mode === "minimal") {
        const pdf = createPlainDocumentPdf(input.title, plainLines(input));
        return { ...output, data: pdf.buffer, renderedLayouts: ["plain-text"], warnings: pdf.warnings };
      }
      const pdf = createDocumentPdf({ ...input, design });
      return { ...output, data: pdf.buffer, renderedLayouts: pdf.layouts, warnings: pdf.warnings };
    }
  }
}

export function documentArtifactExtension(format: DocumentArtifactFormat): string {
  return FORMAT_OUTPUTS[format].extension;
}

/**
 * The model's HTML when it is a whole document (`<html` or `<!doctype`) within the size cap;
 * undefined for a fragment or nothing, so the template path runs. Oversize input is an error
 * rather than a silent fallback: the caller asked for specific markup and must learn it was refused.
 */
function resolveModelAuthoredHtml(html: string | undefined): string | undefined {
  if (typeof html !== "string") return undefined;
  const trimmed = html.trim();
  if (!/<html[\s>]|<!doctype\s/iu.test(trimmed)) return undefined;
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MODEL_AUTHORED_HTML_MAX_BYTES) {
    throw new Error(
      `model_authored_html_too_large: the html argument is ${bytes} bytes; the limit is ${MODEL_AUTHORED_HTML_MAX_BYTES} bytes.`,
    );
  }
  return html;
}

function buildMarkdown(input: DocumentArtifactInput): string {
  const sections = normalizedSections(input);
  const lines = [`# ${input.title}`, ""];
  if (input.body?.trim()) {
    lines.push(input.body.trim(), "");
  }
  for (const section of sections) {
    lines.push(`## ${section.heading}`, "");
    if (section.body) {
      lines.push(section.body, "");
    }
    for (const bullet of section.bullets) {
      lines.push(`- ${bullet}`);
    }
    if (section.bullets.length > 0) {
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function buildPlainText(input: DocumentArtifactInput): string {
  return `${plainLines(input).join("\n").trimEnd()}\n`;
}

function buildHtml(input: DocumentArtifactInput): string {
  const sections = normalizedSections(input);
  const design = resolveDocumentDesign(input, "html");
  const body = [
    `<header class="cover"><h1>${escapeHtml(input.title)}</h1>${
      input.body?.trim() ? `<p>${escapeHtml(input.body.trim())}</p>` : ""
    }</header>`,
    ...sections.map((section) => {
      const bullets =
        section.bullets.length > 0
          ? `<ul>${section.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>`
          : "";
      return `<section><h2>${escapeHtml(section.heading)}</h2>${section.body ? `<p>${escapeHtml(section.body)}</p>` : ""}${bullets}</section>`;
    }),
  ]
    .filter(Boolean)
    .join("\n");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(input.title)}</title>`,
    `<style>${buildHtmlCss(design)}</style>`,
    "</head>",
    `<body>${body}</body>`,
    "</html>",
    "",
  ].join("\n");
}

function toJsonDocument(input: DocumentArtifactInput) {
  return {
    title: input.title,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    body: input.body ?? "",
    sections: normalizedSections(input),
    rows: input.rows ?? [],
  };
}

function buildCsv(input: DocumentArtifactInput): string {
  const rows = input.rows && input.rows.length > 0 ? input.rows : sectionsToRows(input);
  if (rows.length === 0) {
    return "title,body\n" + [csvCell(input.title), csvCell(input.body ?? "")].join(",") + "\n";
  }
  if (rows.every(Array.isArray)) {
    return `${rows.map((row) => (row as unknown[]).map((cell) => csvCell(stringifyCell(cell))).join(",")).join("\n")}\n`;
  }
  const records = rows.map((row) => (Array.isArray(row) ? arrayToRecord(row) : row));
  const headers = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const lines = [
    headers.map(csvCell).join(","),
    ...records.map((record) => headers.map((header) => csvCell(stringifyCell(record[header]))).join(",")),
  ];
  return `${lines.join("\n")}\n`;
}

async function buildDocx(input: DocumentArtifactInput): Promise<Buffer> {
  try {
    return await buildStyledDocx(input);
  } catch {
    return buildFallbackDocx(input);
  }
}

async function buildStyledDocx(input: DocumentArtifactInput): Promise<Buffer> {
  const design = resolveDocumentDesign(input, "docx");
  const children: Array<Paragraph | Table> = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      spacing: { after: 220 },
      children: [
        new TextRun({
          text: input.title,
          bold: true,
          size: 44,
          color: design.tokens.text,
          font: design.typography.headingFont,
        }),
      ],
    }),
  ];
  if (input.body?.trim()) {
    children.push(bodyParagraph(input.body.trim(), design));
  }
  const sections = normalizedSections(input);
  sections.forEach((section, index) => {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 260, after: 120 },
        children: [
          new TextRun({
            text: section.heading,
            bold: true,
            size: 30,
            color: design.tokens.text,
            font: design.typography.headingFont,
          }),
        ],
      }),
    );
    if (section.body) {
      children.push(bodyParagraph(section.body, design));
    }
    for (const bullet of section.bullets) {
      children.push(
        new Paragraph({
          spacing: { after: 80 },
          indent: { left: 360 },
          children: [
            new TextRun({
              text: `- ${bullet}`,
              size: 22,
              color: design.tokens.text,
              font: design.typography.bodyFont,
            }),
          ],
        }),
      );
    }
    if (index === 0 && section.bullets[0] && design.mode !== "plain" && design.mode !== "minimal") {
      children.push(calloutTable(section.bullets[0], design));
    }
  });
  const doc = new Document({
    title: input.title,
    creator: "GoatCitadel",
    description: `Generated artifact using ${design.preset} design brief.`,
    sections: [
      {
        properties: {
          page: {
            margin: { top: 720, right: 720, bottom: 720, left: 720 },
          },
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

function buildFallbackDocx(input: DocumentArtifactInput): Buffer {
  const createdAt = input.createdAt ?? new Date();
  const entries: ZipEntry[] = [
    xmlEntry("[Content_Types].xml", buildDocxContentTypes()),
    xmlEntry("_rels/.rels", buildDocxRootRelationships()),
    xmlEntry("docProps/core.xml", buildCoreProperties(input.title, createdAt)),
    xmlEntry("docProps/app.xml", buildAppProperties()),
    xmlEntry("word/document.xml", buildDocumentXml(input)),
  ];
  return createStoredZip(entries);
}

function resolveDocumentDesign(input: DocumentArtifactInput, format: "docx" | "html"): ArtifactDesignPlan {
  return (
    input.design ??
    createArtifactDesignPlan({
      kind: format === "html" ? "html" : "document",
      title: input.title,
      body: input.body,
      sections: input.sections,
      format,
    })
  );
}

function buildHtmlCss(design: ArtifactDesignPlan): string {
  if (design.mode === "plain" || design.mode === "minimal") {
    return "body{font-family:Arial,sans-serif;line-height:1.5;max-width:840px;margin:48px auto;padding:0 24px;color:#111827}h1,h2{color:#0f172a}";
  }
  return [
    `:root{--bg:${cssColor(design.tokens.background)};--surface:${cssColor(design.tokens.surface)};--text:${cssColor(design.tokens.text)};--muted:${cssColor(design.tokens.mutedText)};--accent:${cssColor(design.tokens.accent)};--accent2:${cssColor(design.tokens.accent2)};--border:${cssColor(design.tokens.border)}}`,
    `body{font-family:${cssFont(design.typography.bodyFont)},Arial,sans-serif;line-height:1.55;max-width:960px;margin:0 auto;padding:40px 24px 64px;background:var(--bg);color:var(--text)}`,
    `.cover{background:var(--surface);border:1px solid var(--border);border-left:8px solid var(--accent);padding:36px 40px;margin-bottom:28px;box-shadow:0 18px 40px rgba(15,23,42,.08)}`,
    `h1{font-family:${cssFont(design.typography.headingFont)},Arial,sans-serif;font-size:44px;line-height:1.05;margin:0 0 16px;color:var(--text)}`,
    `h2{font-family:${cssFont(design.typography.headingFont)},Arial,sans-serif;font-size:24px;margin:0 0 10px;color:var(--text)}`,
    `p{color:var(--muted);font-size:16px;margin:0 0 14px}`,
    `section{background:var(--surface);border:1px solid var(--border);padding:24px 28px;margin:18px 0}`,
    `ul{margin:12px 0 0;padding-left:22px;color:var(--text)}`,
    `li{margin:8px 0}`,
  ].join("");
}

function bodyParagraph(text: string, design: ArtifactDesignPlan): Paragraph {
  return new Paragraph({
    spacing: { after: 140 },
    children: [
      new TextRun({
        text,
        size: 22,
        color: design.tokens.mutedText,
        font: design.typography.bodyFont,
      }),
    ],
  });
}

function calloutTable(text: string, design: ArtifactDesignPlan): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: "single", size: 8, color: design.tokens.accent },
      bottom: { style: "single", size: 8, color: design.tokens.accent },
      left: { style: "single", size: 8, color: design.tokens.accent },
      right: { style: "single", size: 8, color: design.tokens.accent },
      insideHorizontal: { style: "single", size: 0, color: design.tokens.surface },
      insideVertical: { style: "single", size: 0, color: design.tokens.surface },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { type: ShadingType.CLEAR, fill: design.tokens.surface },
            margins: { top: 220, bottom: 220, left: 260, right: 260 },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: text.length > 180 ? `${text.slice(0, 177)}...` : text,
                    bold: true,
                    color: design.tokens.text,
                    size: 22,
                    font: design.typography.bodyFont,
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function cssFont(font: string): string {
  const safeFont = font.replace(/[^A-Za-z0-9 ._-]/g, "").trim() || "Arial";
  return safeFont.includes(" ") ? `"${safeFont}"` : safeFont;
}

function buildDocxContentTypes(): string {
  return xmlDocument(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `</Types>`,
  );
}

function buildDocxRootRelationships(): string {
  return xmlDocument(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="word/document.xml"/>` +
      `<Relationship Id="rId2" Type="${PACKAGE_REL_NS}/metadata/core-properties" Target="docProps/core.xml"/>` +
      `<Relationship Id="rId3" Type="${REL_NS}/extended-properties" Target="docProps/app.xml"/>` +
      `</Relationships>`,
  );
}

function buildDocumentXml(input: DocumentArtifactInput): string {
  const paragraphs = [
    paragraph(input.title, { bold: true, size: 32 }),
    ...(input.body?.trim()
      ? input.body
          .trim()
          .split(/\r?\n/)
          .map((line) => paragraph(line))
      : []),
    ...normalizedSections(input).flatMap((section) => [
      paragraph(section.heading, { bold: true, size: 24 }),
      ...(section.body ? section.body.split(/\r?\n/).map((line) => paragraph(line)) : []),
      ...section.bullets.map((bullet) => paragraph(`- ${bullet}`)),
    ]),
  ];
  return xmlDocument(
    `<w:document xmlns:w="${WORD_NS}"><w:body>${paragraphs.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  );
}

function buildCoreProperties(title: string, createdAt: Date): string {
  const timestamp = createdAt.toISOString();
  return xmlDocument(
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
      `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
      `xmlns:dcterms="http://purl.org/dc/terms/" ` +
      `xmlns:dcmitype="http://purl.org/dc/dcmitype/" ` +
      `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>${escapeXml(title)}</dc:title>` +
      `<dc:creator>GoatCitadel</dc:creator>` +
      `<cp:lastModifiedBy>GoatCitadel</cp:lastModifiedBy>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified>` +
      `</cp:coreProperties>`,
  );
}

function buildAppProperties(): string {
  return xmlDocument(
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
      `<Application>GoatCitadel</Application>` +
      `</Properties>`,
  );
}

function paragraph(text: string, options: { bold?: boolean; size?: number } = {}): string {
  const runProps =
    options.bold || options.size
      ? `<w:rPr>${options.bold ? "<w:b/>" : ""}${options.size ? `<w:sz w:val="${options.size * 2}"/>` : ""}</w:rPr>`
      : "";
  return `<w:p><w:r>${runProps}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function plainLines(input: DocumentArtifactInput): string[] {
  const lines = [input.title, ""];
  if (input.body?.trim()) {
    lines.push(...input.body.trim().split(/\r?\n/), "");
  }
  for (const section of normalizedSections(input)) {
    lines.push(section.heading);
    if (section.body) {
      lines.push(...section.body.split(/\r?\n/));
    }
    for (const bullet of section.bullets) {
      lines.push(`- ${bullet}`);
    }
    lines.push("");
  }
  return lines;
}

function normalizedSections(input: DocumentArtifactInput): DocumentArtifactSection[] {
  if (input.sections.length > 0) {
    return input.sections;
  }
  return input.body?.trim() ? [{ heading: "Summary", body: input.body.trim(), bullets: [] }] : [];
}

function sectionsToRows(input: DocumentArtifactInput): Array<Record<string, unknown>> {
  return normalizedSections(input).map((section) => ({
    title: input.title,
    heading: section.heading,
    body: section.body,
    bullets: section.bullets.join("; "),
  }));
}

function arrayToRecord(row: unknown[]): Record<string, unknown> {
  return Object.fromEntries(row.map((value, index) => [`column_${index + 1}`, value]));
}

function xmlEntry(name: string, xml: string): ZipEntry {
  return { name, data: Buffer.from(xml, "utf8") };
}

function xmlDocument(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
}

function escapeXml(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- strip C0 control chars illegal in XML 1.0 (tab/newline/CR preserved)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      .replace(/[<>&"']/g, (char) => {
        switch (char) {
          case "<":
            return "&lt;";
          case ">":
            return "&gt;";
          case "&":
            return "&amp;";
          case '"':
            return "&quot;";
          default:
            return "&apos;";
        }
      })
  );
}

function escapeHtml(value: string): string {
  return escapeXml(value);
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}
