// Dependency-free writers for the icon container formats the desktop hosts
// need: Windows .ico and macOS .icns. Callers hand in already-rendered frames.

const ICO_HEADER_BYTES = 6;
const ICO_ENTRY_BYTES = 16;
const BITMAPINFOHEADER_BYTES = 40;
const ICNS_HEADER_BYTES = 8;

// Largest frame stored as raw DIB. Bigger frames are stored as embedded PNG,
// which every ICO loader since Vista accepts and keeps the file small.
const MAX_DIB_FRAME = 255;

// ICNS entry type per PNG edge length.
export const ICNS_TYPE_BY_SIZE = Object.freeze({
  16: "icp4",
  32: "icp5",
  64: "icp6",
  128: "ic07",
  256: "ic08",
  512: "ic09",
  1024: "ic10",
});

function assertFrameSize(size) {
  if (!Number.isInteger(size) || size < 1 || size > 256) {
    throw new Error(`ICO frame size must be an integer in 1..256, got ${size}`);
  }
}

/**
 * Encode one frame as a 32-bit BGRA DIB (BITMAPINFOHEADER + bottom-up pixels +
 * all-zero AND mask). `rgba` is top-down RGBA, `size * size * 4` bytes.
 */
export function encodeDibFrame(size, rgba) {
  assertFrameSize(size);
  if (rgba.length !== size * size * 4) {
    throw new Error(`Expected ${size * size * 4} RGBA bytes for a ${size}px frame, got ${rgba.length}`);
  }
  const pixelBytes = size * size * 4;
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const maskBytes = maskRowBytes * size;
  const out = Buffer.alloc(BITMAPINFOHEADER_BYTES + pixelBytes + maskBytes);

  out.writeUInt32LE(BITMAPINFOHEADER_BYTES, 0);
  out.writeInt32LE(size, 4);
  out.writeInt32LE(size * 2, 8); // XOR bitmap + AND mask
  out.writeUInt16LE(1, 12); // planes
  out.writeUInt16LE(32, 14); // bpp
  out.writeUInt32LE(0, 16); // BI_RGB
  out.writeUInt32LE(pixelBytes + maskBytes, 20);

  for (let row = 0; row < size; row += 1) {
    const srcRow = size - 1 - row; // DIB rows are bottom-up
    for (let col = 0; col < size; col += 1) {
      const src = (srcRow * size + col) * 4;
      const dst = BITMAPINFOHEADER_BYTES + (row * size + col) * 4;
      out[dst] = rgba[src + 2];
      out[dst + 1] = rgba[src + 1];
      out[dst + 2] = rgba[src];
      out[dst + 3] = rgba[src + 3];
    }
  }
  return out;
}

/**
 * Build an .ico from frames `{ size, rgba?, png? }`. Frames up to 255px need
 * `rgba` (stored as DIB); 256px frames need `png` (stored as PNG).
 */
export function buildIco(frames) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error("buildIco needs at least one frame");
  }
  const sorted = [...frames].sort((a, b) => a.size - b.size);
  const payloads = sorted.map((frame) => {
    assertFrameSize(frame.size);
    if (frame.size <= MAX_DIB_FRAME) {
      if (!frame.rgba) throw new Error(`ICO frame ${frame.size}px needs rgba data`);
      return encodeDibFrame(frame.size, frame.rgba);
    }
    if (!frame.png) throw new Error(`ICO frame ${frame.size}px needs png data`);
    return frame.png;
  });

  const header = Buffer.alloc(ICO_HEADER_BYTES + ICO_ENTRY_BYTES * sorted.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sorted.length, 4);

  let offset = header.length;
  sorted.forEach((frame, index) => {
    const entry = ICO_HEADER_BYTES + index * ICO_ENTRY_BYTES;
    const edge = frame.size === 256 ? 0 : frame.size; // 0 means 256
    header.writeUInt8(edge, entry);
    header.writeUInt8(edge, entry + 1);
    header.writeUInt8(0, entry + 2); // palette colors
    header.writeUInt8(0, entry + 3); // reserved
    header.writeUInt16LE(1, entry + 4); // planes
    header.writeUInt16LE(32, entry + 6); // bpp
    header.writeUInt32LE(payloads[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += payloads[index].length;
  });

  return Buffer.concat([header, ...payloads]);
}

/** Build an .icns from PNG frames `{ size, png }`. */
export function buildIcns(frames) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error("buildIcns needs at least one frame");
  }
  const sorted = [...frames].sort((a, b) => a.size - b.size);
  const entries = sorted.map((frame) => {
    const type = ICNS_TYPE_BY_SIZE[frame.size];
    if (!type) throw new Error(`No ICNS entry type for ${frame.size}px`);
    if (!frame.png) throw new Error(`ICNS frame ${frame.size}px needs png data`);
    const entryHeader = Buffer.alloc(8);
    entryHeader.write(type, 0, "ascii");
    entryHeader.writeUInt32BE(frame.png.length + 8, 4);
    return Buffer.concat([entryHeader, frame.png]);
  });
  const total = ICNS_HEADER_BYTES + entries.reduce((sum, entry) => sum + entry.length, 0);
  const header = Buffer.alloc(ICNS_HEADER_BYTES);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(total, 4);
  return Buffer.concat([header, ...entries]);
}
