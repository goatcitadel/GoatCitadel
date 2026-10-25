import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTrueTypeFont, type TrueTypeFont } from "./pdf-truetype.js";

/**
 * Bundled SIL OFL fonts that draw what the standard Helvetica faces cannot:
 * Noto Sans for Latin Extended, Greek, and Cyrillic letters, then Noto Sans
 * Symbols 2 for checkboxes, check marks, arrows, and other symbols. Each PDF
 * embeds only the glyphs it uses. CJK, emoji, and other scripts are not covered.
 */

export type PdfFallbackFace = "sans" | "sansBold" | "symbols";
export type PdfFallbackWeight = "regular" | "bold";

export const PDF_FALLBACK_RESOURCE_NAMES: Readonly<Record<PdfFallbackFace, string>> = {
  sans: "F3",
  sansBold: "F4",
  symbols: "F5",
};

const FONT_FILES: Readonly<Record<PdfFallbackFace, { file: string; name: string }>> = {
  sans: { file: "NotoSans-Regular.ttf", name: "NotoSans-Regular" },
  sansBold: { file: "NotoSans-Bold.ttf", name: "NotoSans-Bold" },
  symbols: { file: "NotoSansSymbols2-Regular.ttf", name: "NotoSansSymbols2-Regular" },
};
const FACE_CHAINS: Readonly<Record<PdfFallbackWeight, readonly PdfFallbackFace[]>> = {
  regular: ["sans", "symbols", "sansBold"],
  bold: ["sansBold", "symbols", "sans"],
};
/** Shown, and disclosed in a warning, for a character no bundled font can draw. */
export const PDF_MISSING_GLYPH_SUBSTITUTE = "�";

// The fonts sit beside src/ and dist/, so the same relative URL works from both.
const FONT_DIRECTORY = new URL("../fonts/", import.meta.url);

let loadedFaces: Partial<Record<PdfFallbackFace, TrueTypeFont>> | undefined;

function faces(): Partial<Record<PdfFallbackFace, TrueTypeFont>> {
  if (!loadedFaces) {
    const loaded: Partial<Record<PdfFallbackFace, TrueTypeFont>> = {};
    for (const [face, { file, name }] of Object.entries(FONT_FILES) as Array<
      [PdfFallbackFace, { file: string; name: string }]
    >) {
      try {
        loaded[face] = parseTrueTypeFont(fs.readFileSync(fileURLToPath(new URL(file, FONT_DIRECTORY))), name);
      } catch {
        // A missing or unreadable font only narrows coverage: its characters get the substitute and a warning.
      }
    }
    loadedFaces = loaded;
  }
  return loadedFaces;
}

/** The first face in the weight's chain that has a glyph for the code point. */
export function pdfFallbackFaceFor(codePoint: number, weight: PdfFallbackWeight): PdfFallbackFace | undefined {
  const available = faces();
  return FACE_CHAINS[weight].find((face) => (available[face]?.glyphIdOf(codePoint) ?? 0) !== 0);
}

/** Glyph id and advance width (1/1000 em) of a code point in a face. */
export function pdfFallbackGlyph(face: PdfFallbackFace, codePoint: number): { glyphId: number; width: number } {
  const font = faces()[face];
  if (!font) return { glyphId: 0, width: 1000 };
  const glyphId = font.glyphIdOf(codePoint);
  return { glyphId, width: Math.round((font.advanceOf(glyphId) * 1000) / font.unitsPerEm) };
}

export interface PdfObjectSink {
  add(body: string): number;
  set(id: number, body: string): void;
  addStream(dictionary: string, data: Buffer): number;
}

/**
 * Writes a Type0 font (Identity-H, two-byte glyph ids) for the glyphs a document
 * used, with a ToUnicode map so the text stays searchable and copyable.
 */
export function writePdfFallbackFont(
  sink: PdfObjectSink,
  fontId: number,
  face: PdfFallbackFace,
  used: ReadonlyMap<number, number>,
): void {
  const font = faces()[face];
  if (!font) throw new Error(`The ${FONT_FILES[face].name} font is not available.`);
  const glyphIds = [...used.keys()].sort((left, right) => left - right);
  const scale = (value: number) => Math.round((value * 1000) / font.unitsPerEm);
  const baseFont = `${subsetTag(face, glyphIds)}+${font.postScriptName}`;
  const program = font.subset(glyphIds);
  const fileId = sink.addStream(`/Length1 ${program.length}`, program);
  const descriptorId = sink.add(
    [
      `<< /Type /FontDescriptor /FontName /${baseFont} /Flags ${face === "symbols" ? 4 : 32}`,
      `/FontBBox [${font.bbox.map(scale).join(" ")}] /ItalicAngle 0 /Ascent ${scale(font.ascent)}`,
      `/Descent ${scale(font.descent)} /CapHeight ${scale(font.capHeight)} /StemV ${face === "sansBold" ? 140 : 80}`,
      `/FontFile2 ${fileId} 0 R >>`,
    ].join(" "),
  );
  const widths = glyphIds.map((glyphId) => `${glyphId} [${scale(font.advanceOf(glyphId))}]`).join(" ");
  const cidFontId = sink.add(
    [
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseFont}`,
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>",
      `/FontDescriptor ${descriptorId} 0 R /DW 1000 /W [${widths}] /CIDToGIDMap /Identity >>`,
    ].join(" "),
  );
  const toUnicodeId = sink.addStream("", Buffer.from(toUnicodeCMap(glyphIds, used), "latin1"));
  sink.set(
    fontId,
    `<< /Type /Font /Subtype /Type0 /BaseFont /${baseFont} /Encoding /Identity-H /DescendantFonts [${cidFontId} 0 R] /ToUnicode ${toUnicodeId} 0 R >>`,
  );
}

/** Hex string operand for glyph ids under Identity-H. */
export function pdfGlyphHex(glyphIds: readonly number[]): string {
  return `<${glyphIds.map((glyphId) => glyphId.toString(16).padStart(4, "0")).join("")}>`;
}

/** Six capital letters derived from the glyph set, as PDF subset font names require. */
function subsetTag(face: PdfFallbackFace, glyphIds: readonly number[]): string {
  const digest = createHash("sha256")
    .update(`${face}:${glyphIds.join(",")}`)
    .digest();
  return Array.from({ length: 6 }, (_, index) => String.fromCharCode(65 + (digest[index]! % 26))).join("");
}

function toUnicodeCMap(glyphIds: readonly number[], used: ReadonlyMap<number, number>): string {
  const entries = glyphIds.map((glyphId) => `${pdfGlyphHex([glyphId])} ${utf16Hex(used.get(glyphId) ?? 0xfffd)}`);
  const blocks: string[] = [];
  for (let start = 0; start < entries.length; start += 100) {
    const block = entries.slice(start, start + 100);
    blocks.push(`${block.length} beginbfchar\n${block.join("\n")}\nendbfchar`);
  }
  return [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    ...blocks,
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
}

function utf16Hex(codePoint: number): string {
  const units = String.fromCodePoint(codePoint);
  let hex = "";
  for (let index = 0; index < units.length; index += 1) hex += units.charCodeAt(index).toString(16).padStart(4, "0");
  return `<${hex}>`;
}
