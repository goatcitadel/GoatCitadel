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
  rows?: Array<Record<string, unknown> | unknown[]>;
  createdAt?: Date;
}

export interface DocumentArtifactOutput {
  data: Buffer | string;
  extension: string;
  mimeType: string;
  binary: boolean;
}

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

export function createDocumentArtifact(
  format: DocumentArtifactFormat,
  input: DocumentArtifactInput,
): DocumentArtifactOutput {
  const output = FORMAT_OUTPUTS[format];
  switch (format) {
    case "markdown":
      return { ...output, data: buildMarkdown(input) };
    case "txt":
      return { ...output, data: buildPlainText(input) };
    case "html":
      return { ...output, data: buildHtml(input) };
    case "json":
      return { ...output, data: JSON.stringify(toJsonDocument(input), null, 2) };
    case "csv":
      return { ...output, data: buildCsv(input) };
    case "docx":
      return { ...output, data: buildDocx(input) };
    case "pdf":
      return { ...output, data: buildPdf(input) };
  }
}

export function documentArtifactExtension(format: DocumentArtifactFormat): string {
  return FORMAT_OUTPUTS[format].extension;
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
  const body = [
    `<h1>${escapeHtml(input.title)}</h1>`,
    input.body?.trim() ? `<p>${escapeHtml(input.body.trim())}</p>` : "",
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
    "<style>body{font-family:Arial,sans-serif;line-height:1.5;max-width:840px;margin:48px auto;padding:0 24px;color:#111827}h1,h2{color:#0f172a}</style>",
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

function buildDocx(input: DocumentArtifactInput): Buffer {
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

function buildPdf(input: DocumentArtifactInput): Buffer {
  const wrappedLines = plainLines(input).flatMap((line) => wrapLine(toPdfSafeText(line), 90));
  const pages = chunk(wrappedLines.length > 0 ? wrappedLines : ["No content provided."], 44);
  const pageIds = pages.map((_, index) => 4 + index * 2);
  const contentIds = pages.map((_, index) => 5 + index * 2);
  const objects: string[] = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    `2 0 obj\n<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>\nendobj\n`,
    "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  pages.forEach((lines, index) => {
    const pageId = pageIds[index] as number;
    const contentId = contentIds[index] as number;
    const stream = buildPageStream(lines);
    objects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
    );
    objects.push(
      `${contentId} 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  });
  return buildPdfBuffer(objects);
}

function buildPageStream(lines: string[]): string {
  return [
    "BT",
    "/F1 12 Tf",
    "16 TL",
    "72 740 Td",
    ...lines.map((line) => `(${escapePdfLiteral(line)}) Tj T*`),
    "ET",
  ].join("\n");
}

function buildPdfBuffer(objects: string[]): Buffer {
  let output = "%PDF-1.4\n% GoatCitadel\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(output, "utf8"));
    output += object;
  }
  const xrefOffset = Buffer.byteLength(output, "utf8");
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";
  output += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
    .join("\n");
  output += `\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "utf8");
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
  return value.replace(/[<>&"']/g, (char) => {
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
  });
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

function wrapLine(line: string, maxLength: number): string[] {
  if (line.length <= maxLength) {
    return [line];
  }
  const words = line.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length > maxLength) {
      lines.push(current);
      current = word;
    } else {
      current = `${current} ${word}`;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks.length > 0 ? chunks : [[]];
}

function escapePdfLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function toPdfSafeText(value: string): string {
  return value.replace(/[^\t\n\r -~]/g, "?");
}
