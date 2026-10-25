import { deflateSync } from "node:zlib";
import {
  PDF_FALLBACK_RESOURCE_NAMES,
  PDF_MISSING_GLYPH_SUBSTITUTE,
  pdfFallbackFaceFor,
  pdfFallbackGlyph,
  pdfGlyphHex,
  writePdfFallbackFont,
  type PdfFallbackFace,
} from "./pdf-fallback-fonts.js";

/**
 * Minimal dependency-free PDF 1.4 writer for server-rendered artifacts.
 * Text uses the standard Helvetica faces with WinAnsiEncoding (widths from the
 * Adobe core-font metrics). Characters WinAnsi lacks are drawn from bundled
 * fallback fonts, of which each PDF embeds only the glyphs it uses.
 *
 * "WinAnsi byte-string" text below holds one character per drawn glyph: codes up
 * to 0xFF are WinAnsi bytes for Helvetica, and higher BMP code points are drawn
 * with a fallback font.
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
// Spacing and hyphen variants keep their meaning for line wrapping.
const NORMALIZED: Readonly<Record<string, string>> = {
  "‐": "-",
  "‑": "-",
  "\u2009": " ",
  "\u202f": " ",
};
// Used only when no fallback font has the symbol.
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
  "−": "-",
};

/**
 * Maps text to WinAnsi byte-string text (see the module comment). A character
 * no font can draw falls back to an ASCII stand-in or its unaccented base
 * letter, else to the visible missing-glyph substitute; each emoji or other
 * unsupported grapheme becomes one substitute.
 */
export function toWinAnsiBytes(text: string): string {
  let output = "";
  for (const grapheme of graphemes(text)) output += mapGrapheme(grapheme).bytes;
  return output;
}

/** Counts visible graphemes, and those shown as the missing-glyph substitute or dropped. */
export function countWinAnsiLoss(text: string): { lost: number; visible: number } {
  let lost = 0;
  let visible = 0;
  for (const grapheme of graphemes(text)) {
    const chars = [...grapheme].filter((char) => !INVISIBLE.test(char));
    if (chars.length === 0 || chars.every((char) => /\s/u.test(char) || (char.codePointAt(0) ?? 0) < 0x20)) continue;
    visible += 1;
    if (mapGrapheme(grapheme).lost) lost += 1;
  }
  return { lost, visible };
}

/** The warning for graphemes shown as the missing-glyph substitute. */
export function missingGlyphWarning(lost: number): string {
  return `${lost} character(s) that no PDF font here can draw (such as emoji or CJK script) are shown as "${missingGlyphSubstitute()}".`;
}

/** The glyph shown for characters no font can draw; reported in loss warnings. */
export function missingGlyphSubstitute(): string {
  return pdfFallbackFaceFor(PDF_MISSING_GLYPH_SUBSTITUTE.codePointAt(0)!, "regular")
    ? PDF_MISSING_GLYPH_SUBSTITUTE
    : "?";
}

// Variation selectors and joiners shape emoji sequences but have no glyph of their own.
const INVISIBLE = /[\uFE0E\uFE0F\u200D]/u;
const GRAPHEMES = new Intl.Segmenter("und", { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return [...GRAPHEMES.segment(text.replace(/\r\n?/gu, "\n").normalize("NFC"))].map(({ segment }) => segment);
}

function mapGrapheme(grapheme: string): { bytes: string; lost: boolean } {
  let bytes = "";
  for (const char of grapheme) {
    if (INVISIBLE.test(char)) continue;
    const mapped = winAnsiByteString(char);
    if (mapped === undefined) return { bytes: missingGlyphSubstitute(), lost: true };
    bytes += mapped;
  }
  return { bytes, lost: false };
}

/** WinAnsi byte-string text for one character, or undefined when nothing can draw it. */
function winAnsiByteString(char: string): string | undefined {
  const code = char.codePointAt(0) ?? 0x3f;
  if (char === "\t" || char === "\n") return " ";
  if (code < 0x20 || code === 0x7f) return "";
  if (code <= 0x7e || (code >= 0xa0 && code <= 0xff)) return char;
  const special = WIN_ANSI_SPECIALS.get(char);
  if (special !== undefined) return String.fromCharCode(special);
  const normalized = NORMALIZED[char];
  if (normalized !== undefined) return normalized;
  // Astral code points stay out so every drawn glyph is one UTF-16 unit for wrapping.
  if (code > 0xff && code <= 0xffff && pdfFallbackFaceFor(code, "regular")) return char;
  const fallback = ASCII_FALLBACKS[char];
  if (fallback !== undefined) return fallback;
  const base = char.normalize("NFKD").replace(/\p{M}/gu, "");
  if (base && base !== char && [...base].every((part) => (part.codePointAt(0) ?? 0x100) <= 0xff)) return base;
  return undefined;
}

/** Width in points of WinAnsi byte-string text. */
export function measureWinAnsi(bytes: string, font: PdfFont, size: number): number {
  const table = font === "bold" ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let units = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const code = bytes.charCodeAt(index);
    if (code > 0xff) {
      const face = pdfFallbackFaceFor(code, font);
      units += face ? pdfFallbackGlyph(face, code).width : 1000;
      continue;
    }
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

/** A PDF text string (UTF-16BE with a byte-order mark) for document metadata. */
function textString(text: string): string {
  const units = `\ufeff${text}`;
  let hex = "";
  for (let index = 0; index < units.length; index += 1) hex += units.charCodeAt(index).toString(16).padStart(4, "0");
  return `<${hex}>`;
}

interface TextRun {
  /** Undefined for Helvetica (WinAnsi) text. */
  face: PdfFallbackFace | undefined;
  text: string;
}

/** Splits WinAnsi byte-string text into runs that share one font. */
function textRuns(bytes: string, font: PdfFont): TextRun[] {
  const runs: TextRun[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const code = bytes.charCodeAt(index);
    const face = code > 0xff ? pdfFallbackFaceFor(code, font) : undefined;
    const last = runs[runs.length - 1];
    if (last && last.face === face) last.text += bytes[index];
    else runs.push({ face, text: bytes[index]! });
  }
  return runs;
}

/** Percent-encodes anything outside printable ASCII so a link URI stays one byte per character. */
function asciiUri(url: string): string {
  return url.replace(/[^\x21-\x7e]/gu, (char) => encodeURIComponent(char));
}

/** One page's drawing surface. Coordinates are points from the top-left corner. */
export class PdfPage {
  private readonly ops: string[] = [];
  readonly links: Array<{ x: number; y: number; w: number; h: number; url: string }> = [];
  readonly images = new Map<string, number>();
  /** Fallback-font glyphs this page draws, per face: glyph id to code point. */
  readonly fallbackGlyphs = new Map<PdfFallbackFace, Map<number, number>>();

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

  /** Draws WinAnsi byte-string text with its baseline at y, switching fonts between runs. */
  text(x: number, y: number, bytes: string, style: PdfTextStyle) {
    if (!bytes) return;
    const size = formatNumber(style.size);
    const shows = textRuns(bytes, style.font).map((run) => {
      const resource = run.face ? PDF_FALLBACK_RESOURCE_NAMES[run.face] : style.font === "bold" ? "F2" : "F1";
      const operand = run.face ? this.fallbackOperand(run.face, run.text) : `(${escapeLiteral(run.text)})`;
      return { select: `/${resource} ${size} Tf`, show: `${operand} Tj` };
    });
    const [first, ...rest] = shows;
    if (!first) return;
    this.ops.push(
      [
        `BT ${first.select} ${colorOperands(style.color)} rg ${formatNumber(x)} ${formatNumber(this.height - y)} Td ${first.show}`,
        ...rest.map((part) => `${part.select} ${part.show}`),
        "ET",
      ].join(" "),
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

  private fallbackOperand(face: PdfFallbackFace, text: string): string {
    const used = this.fallbackGlyphs.get(face) ?? new Map<number, number>();
    this.fallbackGlyphs.set(face, used);
    const glyphIds = [...text].map((char) => {
      const codePoint = char.codePointAt(0)!;
      const { glyphId } = pdfFallbackGlyph(face, codePoint);
      used.set(glyphId, codePoint);
      return glyphId;
    });
    return pdfGlyphHex(glyphIds);
  }

  private box(x: number, y: number, w: number, h: number): string {
    return [x, this.height - y - h, w, h].map(formatNumber).join(" ");
  }
}

/** Collects numbered objects and serializes the cross-reference table. */
export class PdfDocumentWriter {
  private readonly objects: Array<Buffer | undefined> = [];
  /** Reserved Type0 font object and the glyphs every page used, per fallback face. */
  private readonly fallbackFonts = new Map<PdfFallbackFace, { id: number; glyphs: Map<number, number> }>();

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
          asciiUri(link.url),
        )}) >> >>`,
      ),
    );
    const xObjects = [...page.images.entries()].map(([name, id]) => `/${name} ${id} 0 R`).join(" ");
    const fallbackFonts = [...page.fallbackGlyphs.entries()]
      .map(([face, glyphs]) => ` /${PDF_FALLBACK_RESOURCE_NAMES[face]} ${this.useFallbackFont(face, glyphs)} 0 R`)
      .join("");
    return this.add(
      [
        `<< /Type /Page /Parent ${parentId} 0 R /MediaBox [0 0 ${formatNumber(page.width)} ${formatNumber(page.height)}]`,
        `/Resources << /Font << /F1 ${fontIds.regular} 0 R /F2 ${fontIds.bold} 0 R${fallbackFonts} >>${xObjects ? ` /XObject << ${xObjects} >>` : ""} >>`,
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
    return `<< /Title ${textString(title)} /Producer (GoatCitadel) /Creator (GoatCitadel presentations.create) >>`;
  }

  /** The font object id for a fallback face, recording the glyphs a page used. */
  private useFallbackFont(face: PdfFallbackFace, glyphs: ReadonlyMap<number, number>): number {
    const entry = this.fallbackFonts.get(face) ?? { id: this.reserve(), glyphs: new Map<number, number>() };
    this.fallbackFonts.set(face, entry);
    for (const [glyphId, codePoint] of glyphs) entry.glyphs.set(glyphId, codePoint);
    return entry.id;
  }

  serialize(rootId: number, infoId: number): Buffer {
    // Fallback fonts are written last, once every page has added the glyphs it draws.
    for (const [face, { id, glyphs }] of this.fallbackFonts) writePdfFallbackFont(this, id, face, glyphs);
    this.fallbackFonts.clear();
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
