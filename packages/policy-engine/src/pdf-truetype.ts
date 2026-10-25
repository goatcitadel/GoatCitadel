/**
 * Just enough TrueType (glyf-outline) parsing to embed a font subset in a PDF:
 * the cmap lookup, advance widths, vertical metrics, and a glyph subsetter that
 * keeps glyph ids stable so a PDF can use an Identity CID-to-GID map.
 */

export interface TrueTypeFont {
  readonly postScriptName: string;
  readonly unitsPerEm: number;
  readonly ascent: number;
  readonly descent: number;
  readonly capHeight: number;
  readonly bbox: readonly [number, number, number, number];
  /** Glyph id for a code point, or 0 (.notdef) when the font has none. */
  glyphIdOf(codePoint: number): number;
  /** Advance width in font units. */
  advanceOf(glyphId: number): number;
  /** A font program holding only these glyphs (and their composite parts) at their original ids. */
  subset(glyphIds: Iterable<number>): Buffer;
}

interface TableRecord {
  offset: number;
  length: number;
}

// Tables a PDF viewer needs to draw glyf outlines; cmap, name, post, and layout tables are dropped.
const SUBSET_TABLES = ["OS/2", "cvt ", "fpgm", "glyf", "head", "hhea", "hmtx", "loca", "maxp", "prep"];
const COMPOSITE_ARGS_ARE_WORDS = 0x0001;
const COMPOSITE_HAS_SCALE = 0x0008;
const COMPOSITE_MORE_COMPONENTS = 0x0020;
const COMPOSITE_HAS_XY_SCALE = 0x0040;
const COMPOSITE_HAS_2X2 = 0x0080;

export function parseTrueTypeFont(data: Buffer, fallbackName: string): TrueTypeFont {
  const tables = readTableDirectory(data);
  const table = (tag: string): TableRecord => {
    const record = tables.get(tag);
    if (!record) throw new Error(`TrueType font ${fallbackName} has no ${tag} table.`);
    return record;
  };
  const head = table("head");
  const hhea = table("hhea");
  const unitsPerEm = data.readUInt16BE(head.offset + 18);
  const longLoca = data.readInt16BE(head.offset + 50) === 1;
  const numGlyphs = data.readUInt16BE(table("maxp").offset + 4);
  const numberOfHMetrics = data.readUInt16BE(hhea.offset + 34);
  const hmtx = table("hmtx");
  const loca = table("loca");
  const glyf = table("glyf");
  const os2 = tables.get("OS/2");
  const ascent = data.readInt16BE(hhea.offset + 4);
  const descent = data.readInt16BE(hhea.offset + 6);
  const capHeight =
    os2 && os2.length >= 90 && data.readUInt16BE(os2.offset) >= 2
      ? data.readInt16BE(os2.offset + 88)
      : Math.round(ascent * 0.7);
  const cmap = readCmap(data, table("cmap"));

  const glyphRange = (glyphId: number): [number, number] => {
    const start = longLoca
      ? data.readUInt32BE(loca.offset + glyphId * 4)
      : data.readUInt16BE(loca.offset + glyphId * 2) * 2;
    const end = longLoca
      ? data.readUInt32BE(loca.offset + (glyphId + 1) * 4)
      : data.readUInt16BE(loca.offset + (glyphId + 1) * 2) * 2;
    return [glyf.offset + start, glyf.offset + end];
  };

  return {
    postScriptName: readPostScriptName(data, tables.get("name")) ?? fallbackName,
    unitsPerEm,
    ascent,
    descent,
    capHeight,
    bbox: [
      data.readInt16BE(head.offset + 36),
      data.readInt16BE(head.offset + 38),
      data.readInt16BE(head.offset + 40),
      data.readInt16BE(head.offset + 42),
    ],
    glyphIdOf: (codePoint) => {
      const glyphId = cmap.get(codePoint) ?? 0;
      return glyphId < numGlyphs ? glyphId : 0;
    },
    advanceOf: (glyphId) => {
      const index = Math.min(Math.max(0, glyphId), numberOfHMetrics - 1);
      return data.readUInt16BE(hmtx.offset + index * 4);
    },
    subset: (glyphIds) => {
      const keep = new Set<number>([0]);
      const queue = [...glyphIds].filter((id) => id > 0 && id < numGlyphs);
      while (queue.length > 0) {
        const glyphId = queue.pop()!;
        if (keep.has(glyphId)) continue;
        keep.add(glyphId);
        queue.push(...compositeComponents(data, glyphRange(glyphId)).filter((id) => id < numGlyphs));
      }
      const glyphParts: Buffer[] = [];
      const offsets = Buffer.alloc((numGlyphs + 1) * 4);
      let cursor = 0;
      for (let glyphId = 0; glyphId < numGlyphs; glyphId += 1) {
        offsets.writeUInt32BE(cursor, glyphId * 4);
        if (!keep.has(glyphId)) continue;
        const [start, end] = glyphRange(glyphId);
        const glyph = pad4(data.subarray(start, end));
        glyphParts.push(glyph);
        cursor += glyph.length;
      }
      offsets.writeUInt32BE(cursor, numGlyphs * 4);
      const replaced = new Map<string, Buffer>([
        ["glyf", Buffer.concat(glyphParts)],
        ["loca", offsets],
        ["head", longLocaHead(data.subarray(head.offset, head.offset + head.length))],
      ]);
      const subsetTables = SUBSET_TABLES.flatMap((tag): Array<[string, Buffer]> => {
        const replacement = replaced.get(tag);
        if (replacement) return [[tag, replacement]];
        const record = tables.get(tag);
        return record ? [[tag, data.subarray(record.offset, record.offset + record.length)]] : [];
      });
      return writeFontFile(subsetTables);
    },
  };
}

function readTableDirectory(data: Buffer): Map<string, TableRecord> {
  const version = data.readUInt32BE(0);
  if (version !== 0x00010000 && version !== 0x74727565) {
    throw new Error("Only TrueType (glyf) fonts can be embedded in PDFs.");
  }
  const tables = new Map<string, TableRecord>();
  const count = data.readUInt16BE(4);
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    const offset = data.readUInt32BE(record + 8);
    const length = data.readUInt32BE(record + 12);
    if (offset + length > data.length) throw new Error("TrueType table runs past the end of the font file.");
    tables.set(data.toString("latin1", record, record + 4), { offset, length });
  }
  return tables;
}

/** Reads the best Unicode cmap subtable: format 12 (full Unicode) over format 4 (BMP). */
function readCmap(data: Buffer, cmap: TableRecord): Map<number, number> {
  const count = data.readUInt16BE(cmap.offset + 2);
  const subtables: Array<{ format: number; offset: number; rank: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const record = cmap.offset + 4 + index * 8;
    const platform = data.readUInt16BE(record);
    const encoding = data.readUInt16BE(record + 2);
    const offset = cmap.offset + data.readUInt32BE(record + 4);
    const format = data.readUInt16BE(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (unicode && (format === 4 || format === 12)) subtables.push({ format, offset, rank: format === 12 ? 2 : 1 });
  }
  const best = subtables.sort((left, right) => right.rank - left.rank)[0];
  if (!best) throw new Error("TrueType font has no Unicode cmap.");
  return best.format === 12 ? readCmapFormat12(data, best.offset) : readCmapFormat4(data, best.offset);
}

function readCmapFormat4(data: Buffer, offset: number): Map<number, number> {
  const map = new Map<number, number>();
  const segments = data.readUInt16BE(offset + 6) / 2;
  const ends = offset + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  for (let segment = 0; segment < segments; segment += 1) {
    const start = data.readUInt16BE(starts + segment * 2);
    const end = data.readUInt16BE(ends + segment * 2);
    const delta = data.readInt16BE(deltas + segment * 2);
    const rangeOffsetAt = rangeOffsets + segment * 2;
    const rangeOffset = data.readUInt16BE(rangeOffsetAt);
    for (let code = start; code <= end && code !== 0xffff; code += 1) {
      let glyphId: number;
      if (rangeOffset === 0) {
        glyphId = (code + delta) & 0xffff;
      } else {
        const glyphAt = rangeOffsetAt + rangeOffset + (code - start) * 2;
        const raw = glyphAt + 2 <= data.length ? data.readUInt16BE(glyphAt) : 0;
        glyphId = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyphId !== 0) map.set(code, glyphId);
    }
  }
  return map;
}

function readCmapFormat12(data: Buffer, offset: number): Map<number, number> {
  const map = new Map<number, number>();
  const groups = data.readUInt32BE(offset + 12);
  for (let group = 0; group < groups; group += 1) {
    const record = offset + 16 + group * 12;
    const start = data.readUInt32BE(record);
    const end = Math.min(data.readUInt32BE(record + 4), 0x10ffff);
    const firstGlyph = data.readUInt32BE(record + 8);
    for (let code = start; code <= end; code += 1) map.set(code, firstGlyph + (code - start));
  }
  return map;
}

function readPostScriptName(data: Buffer, name: TableRecord | undefined): string | undefined {
  if (!name) return undefined;
  const count = data.readUInt16BE(name.offset + 2);
  const strings = name.offset + data.readUInt16BE(name.offset + 4);
  for (let index = 0; index < count; index += 1) {
    const record = name.offset + 6 + index * 12;
    if (data.readUInt16BE(record + 6) !== 6) continue;
    const platform = data.readUInt16BE(record);
    const length = data.readUInt16BE(record + 8);
    const start = strings + data.readUInt16BE(record + 10);
    const raw = data.subarray(start, start + length);
    const text = platform === 1 ? raw.toString("latin1") : Buffer.from(raw).swap16().toString("utf16le");
    // A PDF name must stay plain ASCII without delimiters.
    const safe = text.replace(/[^A-Za-z0-9_.-]/gu, "");
    if (safe) return safe;
  }
  return undefined;
}

function compositeComponents(data: Buffer, [start, end]: [number, number]): number[] {
  if (end - start < 10 || data.readInt16BE(start) >= 0) return [];
  const components: number[] = [];
  let cursor = start + 10;
  for (;;) {
    if (cursor + 4 > end) break;
    const flags = data.readUInt16BE(cursor);
    components.push(data.readUInt16BE(cursor + 2));
    cursor += 4 + (flags & COMPOSITE_ARGS_ARE_WORDS ? 4 : 2);
    if (flags & COMPOSITE_HAS_SCALE) cursor += 2;
    else if (flags & COMPOSITE_HAS_XY_SCALE) cursor += 4;
    else if (flags & COMPOSITE_HAS_2X2) cursor += 8;
    if (!(flags & COMPOSITE_MORE_COMPONENTS)) break;
  }
  return components;
}

function longLocaHead(head: Buffer): Buffer {
  const copy = Buffer.from(head);
  copy.writeUInt32BE(0, 8); // checkSumAdjustment, recomputed over the whole file
  copy.writeInt16BE(1, 50); // indexToLocFormat: long offsets
  return copy;
}

function writeFontFile(tables: Array<[string, Buffer]>): Buffer {
  const sorted = [...tables].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const count = sorted.length;
  const power = 2 ** Math.floor(Math.log2(count));
  const header = Buffer.alloc(12 + count * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(count, 4);
  header.writeUInt16BE(power * 16, 6);
  header.writeUInt16BE(Math.log2(power), 8);
  header.writeUInt16BE(count * 16 - power * 16, 10);
  const bodies: Buffer[] = [];
  let offset = header.length;
  let headOffset = -1;
  sorted.forEach(([tag, body], index) => {
    const record = 12 + index * 16;
    header.write(tag, record, 4, "latin1");
    header.writeUInt32BE(checksum(body), record + 4);
    header.writeUInt32BE(offset, record + 8);
    header.writeUInt32BE(body.length, record + 12);
    if (tag === "head") headOffset = offset;
    const padded = pad4(body);
    bodies.push(padded);
    offset += padded.length;
  });
  const font = Buffer.concat([header, ...bodies]);
  if (headOffset >= 0) font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headOffset + 8);
  return font;
}

function checksum(data: Buffer): number {
  const padded = pad4(data);
  let sum = 0;
  for (let index = 0; index < padded.length; index += 4) sum = (sum + padded.readUInt32BE(index)) >>> 0;
  return sum;
}

function pad4(data: Buffer): Buffer {
  const remainder = data.length % 4;
  return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(4 - remainder)]);
}
