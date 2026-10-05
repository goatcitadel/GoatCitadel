import { deflateSync } from "node:zlib";

/**
 * Minimal dependency-free PDF 1.4 writer for server-rendered artifacts.
 * Text uses the standard Helvetica faces with WinAnsiEncoding, so no font
 * files are embedded; widths come from the Adobe core-font metrics.
 */

export type PdfFont = "regular" | "bold";

export interface PdfColor {
  r: number;
  g: number;
  b: number;
}

export interface PdfTextStyle {
  font: PdfFont;
  size: number;
  color: PdfColor;
}

export interface PdfImageXObject {
  name: string;
  objectId: number;
}

// Adobe Helvetica / Helvetica-Bold advance widths (1/1000 em) for U+0020..U+007E.
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
  556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
  260, 334, 584,
];
const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611,
  556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389,
  280, 389, 584,
];
const EXTENDED_WIDTHS: Readonly<Record<number, number>> = {
  0x80: 556, // €
  0x85: 1000, // …
  0x91: 222, // ‘
  0x92: 222, // ’
  0x93: 333, // “
  0x94: 333, // ”
  0x95: 350, // •
  0x96: 556, // –
  0x97: 1000, // —
  0x99: 1000, // ™
  0xa0: 278, // nbsp
  0xb0: 400, // °
  0xb7: 278, // ·
};

// WinAnsi code points in 0x80..0x9F that differ from Latin-1.
const WIN_ANSI_SPECIALS: ReadonlyMap<string, number> = new Map([
  ["€", 0x80],
  ["‚", 0x82],
  ["ƒ", 0x83],
  ["„", 0x84],
  ["…", 0x85],
  ["†", 0x86],
  ["‡", 0x87],
  ["ˆ", 0x88],
  ["‰", 0x89],
  ["Š", 0x8a],
  ["‹", 0x8b],
  ["Œ", 0x8c],
  ["Ž", 0x8e],
  ["‘", 0x91],
  ["’", 0x92],
  ["“", 0x93],
  ["”", 0x94],
  ["•", 0x95],
  ["–", 0x96],
  ["—", 0x97],
  ["˜", 0x98],
  ["™", 0x99],
  ["š", 0x9a],
  ["›", 0x9b],
  ["œ", 0x9c],
  ["ž", 0x9e],
  ["Ÿ", 0x9f],
]);
const ASCII_FALLBACKS: Readonly<Record<string, string>> = {
  "→": "->",
  "←": "<-",
  "↔": "<->",
  "≥": ">=",
  "≤": "<=",
  "≠": "!=",
  "≈": "~",
  "✓": "v",
  "✔": "v",
  "★": "*",
  "‐": "-",
  "‑": "-",
  "−": "-",
  "\u2009": " ",
  "\u202f": " ",
};

/**
 * Maps text to a string whose every character is a single WinAnsi byte
 * (char code 0..255). Pictographs are dropped; other unmappable characters
 * fall back to their unaccented base letter or "?".
 */
export function toWinAnsiBytes(text: string): string {
  let output = "";
  for (const char of text.replace(/\r\n?/gu, "\n")) {
    output += winAnsiByteString(char);
  }
  return output;
}

/**
 * Counts visible characters that WinAnsi cannot show: those replaced by "?"
 * or dropped (pictographs). Non-Latin scripts are lost in a Helvetica PDF.
 */
export function countWinAnsiLoss(text: string): { lost: number; visible: number } {
  let lost = 0;
  let visible = 0;
  for (const char of text) {
    if (/\s/u.test(char) || (char.codePointAt(0) ?? 0) < 0x20 || VARIATION_OR_JOINER.test(char)) continue;
    visible += 1;
    const mapped = winAnsiByteString(char);
    if (mapped === "" || (mapped === "?" && char !== "?")) lost += 1;
  }
  return { lost, visible };
}

const VARIATION_OR_JOINER = /[\uFE0F\u200D]/u;

function winAnsiByteString(char: string): string {
  const code = char.codePointAt(0) ?? 0x3f;
  if (char === "\t" || char === "\n") return " ";
  if (code < 0x20 || code === 0x7f) return "";
  if (code <= 0x7e || (code >= 0xa0 && code <= 0xff)) return char;
  const special = WIN_ANSI_SPECIALS.get(char);
  if (special !== undefined) return String.fromCharCode(special);
  const fallback = ASCII_FALLBACKS[char];
  if (fallback !== undefined) return fallback;
  if (/\p{Extended_Pictographic}/u.test(char) || VARIATION_OR_JOINER.test(char)) return "";
  const base = char.normalize("NFKD").replace(/\p{M}/gu, "");
  if (base && base !== char && [...base].every((part) => (part.codePointAt(0) ?? 0x100) <= 0xff)) return base;
  return "?";
}

/** Width in points of WinAnsi byte-string text. */
export function measureWinAnsi(bytes: string, font: PdfFont, size: number): number {
  const table = font === "bold" ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let units = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const code = bytes.charCodeAt(index);
    units += code >= 0x20 && code <= 0x7e ? table[code - 0x20]! : (EXTENDED_WIDTHS[code] ?? 556);
  }
  return (units * size) / 1000;
}

/** Greedy word wrap of WinAnsi byte-string text; over-long words are split. */
export function wrapWinAnsi(bytes: string, font: PdfFont, size: number, maxWidth: number): string[] {
  const words = bytes.split(/ +/u).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measureWinAnsi(candidate, font, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    while (measureWinAnsi(current, font, size) > maxWidth && current.length > 1) {
      const cut = fittingPrefixLength(current, font, size, maxWidth);
      lines.push(current.slice(0, cut));
      current = current.slice(cut);
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Longest prefix (at least one character) that fits maxWidth, in one forward pass. */
function fittingPrefixLength(bytes: string, font: PdfFont, size: number, maxWidth: number): number {
  let width = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    width += measureWinAnsi(bytes[index]!, font, size);
    if (width > maxWidth) return Math.max(1, index);
  }
  return bytes.length;
}

/** Shortens WinAnsi byte-string text with an ellipsis so it fits maxWidth. */
export function truncateWinAnsi(bytes: string, font: PdfFont, size: number, maxWidth: number): string {
  if (measureWinAnsi(bytes, font, size) <= maxWidth) return bytes;
  const ellipsis = String.fromCharCode(0x85);
  let end = bytes.length;
  while (end > 0 && measureWinAnsi(`${bytes.slice(0, end).trimEnd()}${ellipsis}`, font, size) > maxWidth) end -= 1;
  return `${bytes.slice(0, end).trimEnd()}${ellipsis}`;
}

export function pdfColor(hex: string): PdfColor {
  const normalized = hex.replace(/^#/u, "").trim();
  const full =
    normalized.length === 3
      ? normalized
          .split("")
          .map((part) => part + part)
          .join("")
      : normalized;
  const value = /^[0-9a-f]{6}$/iu.test(full) ? Number.parseInt(full, 16) : 0;
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

export function mixPdfColors(base: PdfColor, overlay: PdfColor, overlayWeight: number): PdfColor {
  const weight = Math.min(1, Math.max(0, overlayWeight));
  const mix = (left: number, right: number) => Math.round(left * (1 - weight) + right * weight);
  return { r: mix(base.r, overlay.r), g: mix(base.g, overlay.g), b: mix(base.b, overlay.b) };
}

/** Relative luminance (0..1) used to pick legible text on filled shapes. */
export function pdfColorLuminance(color: PdfColor): number {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function colorOperands(color: PdfColor): string {
  return [color.r, color.g, color.b].map((value) => formatNumber(value / 255)).join(" ");
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}

function escapeLiteral(bytes: string): string {
  return bytes.replace(/[\\()]/gu, (char) => `\\${char}`);
}

/** One page's drawing surface. Coordinates are points from the top-left corner. */
export class PdfPage {
  private readonly ops: string[] = [];
  readonly links: Array<{ x: number; y: number; w: number; h: number; url: string }> = [];
  readonly images = new Map<string, number>();

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  rect(x: number, y: number, w: number, h: number, fill?: PdfColor, stroke?: { color: PdfColor; width: number }) {
    if (!fill && !stroke) return;
    const parts = ["q"];
    if (fill) parts.push(`${colorOperands(fill)} rg`);
    if (stroke) parts.push(`${colorOperands(stroke.color)} RG ${formatNumber(stroke.width)} w`);
    parts.push(`${this.box(x, y, w, h)} re ${fill && stroke ? "B" : fill ? "f" : "S"} Q`);
    this.ops.push(parts.join(" "));
  }

  line(x1: number, y1: number, x2: number, y2: number, color: PdfColor, width: number) {
    this.polyline(
      [
        [x1, y1],
        [x2, y2],
      ],
      color,
      width,
    );
  }

  polyline(points: ReadonlyArray<readonly [number, number]>, color: PdfColor, width: number) {
    if (points.length < 2) return;
    const path = points
      .map(([x, y], index) => `${formatNumber(x)} ${formatNumber(this.height - y)} ${index === 0 ? "m" : "l"}`)
      .join(" ");
    this.ops.push(`q ${colorOperands(color)} RG ${formatNumber(width)} w 1 J 1 j ${path} S Q`);
  }

  /** Draws WinAnsi byte-string text with its baseline at y. */
  text(x: number, y: number, bytes: string, style: PdfTextStyle) {
    if (!bytes) return;
    const font = style.font === "bold" ? "F2" : "F1";
    this.ops.push(
      `BT /${font} ${formatNumber(style.size)} Tf ${colorOperands(style.color)} rg ${formatNumber(x)} ${formatNumber(
        this.height - y,
      )} Td (${escapeLiteral(bytes)}) Tj ET`,
    );
  }

  image(xObject: PdfImageXObject, x: number, y: number, w: number, h: number) {
    this.images.set(xObject.name, xObject.objectId);
    this.ops.push(
      `q ${formatNumber(w)} 0 0 ${formatNumber(h)} ${formatNumber(x)} ${formatNumber(this.height - y - h)} cm /${xObject.name} Do Q`,
    );
  }

  link(x: number, y: number, w: number, h: number, url: string) {
    if (/^https:\/\//iu.test(url)) this.links.push({ x, y, w, h, url });
  }

  contentBytes(): Buffer {
    return Buffer.from(this.ops.join("\n"), "latin1");
  }

  linkRect(link: { x: number; y: number; w: number; h: number }): string {
    return [link.x, this.height - link.y - link.h, link.x + link.w, this.height - link.y].map(formatNumber).join(" ");
  }

  private box(x: number, y: number, w: number, h: number): string {
    return [x, this.height - y - h, w, h].map(formatNumber).join(" ");
  }
}

/** Collects numbered objects and serializes the cross-reference table. */
export class PdfDocumentWriter {
  private readonly objects: Array<Buffer | undefined> = [];

  reserve(): number {
    this.objects.push(undefined);
    return this.objects.length;
  }

  set(id: number, body: string | Buffer): void {
    const content = typeof body === "string" ? Buffer.from(body, "latin1") : body;
    this.objects[id - 1] = Buffer.concat([
      Buffer.from(`${id} 0 obj\n`, "latin1"),
      content,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
  }

  add(body: string | Buffer): number {
    const id = this.reserve();
    this.set(id, body);
    return id;
  }

  addStream(dictionary: string, data: Buffer, options: { compress?: boolean } = {}): number {
    const payload = options.compress === false ? data : deflateSync(data);
    const filter = options.compress === false ? "" : " /Filter /FlateDecode";
    return this.add(
      Buffer.concat([
        Buffer.from(`<< ${dictionary}${filter} /Length ${payload.length} >>\nstream\n`, "latin1"),
        payload,
        Buffer.from("\nendstream", "latin1"),
      ]),
    );
  }

  addImage(jpeg: Buffer, width: number, height: number): number {
    return this.addStream(
      `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      jpeg,
      { compress: false },
    );
  }

  /** Adds a page object (content stream, fonts, images, link annotations). */
  addPage(page: PdfPage, parentId: number, fontIds: { regular: number; bold: number }): number {
    const contentId = this.addStream("", page.contentBytes());
    const annotIds = page.links.map((link) =>
      this.add(
        `<< /Type /Annot /Subtype /Link /Rect [${page.linkRect(link)}] /Border [0 0 0] /A << /Type /Action /S /URI /URI (${escapeLiteral(
          toWinAnsiBytes(link.url),
        )}) >> >>`,
      ),
    );
    const xObjects = [...page.images.entries()].map(([name, id]) => `/${name} ${id} 0 R`).join(" ");
    return this.add(
      [
        `<< /Type /Page /Parent ${parentId} 0 R /MediaBox [0 0 ${formatNumber(page.width)} ${formatNumber(page.height)}]`,
        `/Resources << /Font << /F1 ${fontIds.regular} 0 R /F2 ${fontIds.bold} 0 R >>${xObjects ? ` /XObject << ${xObjects} >>` : ""} >>`,
        `/Contents ${contentId} 0 R${annotIds.length > 0 ? ` /Annots [${annotIds.map((id) => `${id} 0 R`).join(" ")}]` : ""} >>`,
      ].join(" "),
    );
  }

  addStandardFonts(): { regular: number; bold: number } {
    return {
      regular: this.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
      bold: this.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
    };
  }

  infoDictionary(title: string): string {
    return `<< /Title (${escapeLiteral(toWinAnsiBytes(title))}) /Producer (GoatCitadel) /Creator (GoatCitadel presentations.create) >>`;
  }

  serialize(rootId: number, infoId: number): Buffer {
    const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    const offsets: number[] = [];
    let length = chunks[0]!.length;
    this.objects.forEach((object, index) => {
      if (!object) throw new Error(`PDF object ${index + 1} was reserved but never written.`);
      offsets.push(length);
      chunks.push(object);
      length += object.length;
    });
    const xref = [
      "xref",
      `0 ${this.objects.length + 1}`,
      "0000000000 65535 f ",
      ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
      "trailer",
      `<< /Size ${this.objects.length + 1} /Root ${rootId} 0 R /Info ${infoId} 0 R >>`,
      "startxref",
      String(length),
      "%%EOF",
      "",
    ].join("\n");
    chunks.push(Buffer.from(xref, "latin1"));
    return Buffer.concat(chunks);
  }
}
