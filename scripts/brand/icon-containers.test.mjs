import assert from "node:assert/strict";
import test from "node:test";

import { buildIcns, buildIco, encodeDibFrame } from "./icon-containers.mjs";

function solidRgba(size, [r, g, b, a]) {
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  }
  return buf;
}

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test("encodeDibFrame writes a bottom-up BGRA bitmap with a double-height header", () => {
  const rgba = Buffer.alloc(2 * 2 * 4);
  rgba.set([10, 20, 30, 255], 0); // top-left red-ish
  rgba.set([40, 50, 60, 128], 8); // bottom-left
  const dib = encodeDibFrame(2, rgba);

  assert.equal(dib.readUInt32LE(0), 40);
  assert.equal(dib.readInt32LE(4), 2);
  assert.equal(dib.readInt32LE(8), 4);
  assert.equal(dib.readUInt16LE(14), 32);
  // First stored row is the bottom source row, channels swapped to BGRA.
  assert.deepEqual([...dib.subarray(40, 44)], [60, 50, 40, 128]);
  assert.deepEqual([...dib.subarray(48, 52)], [30, 20, 10, 255]);
  // 16 pixel bytes + 2 rows * 4-byte AND mask rows.
  assert.equal(dib.length, 40 + 16 + 8);
});

test("encodeDibFrame rejects mismatched pixel buffers", () => {
  assert.throws(() => encodeDibFrame(4, Buffer.alloc(3)), /Expected 64 RGBA bytes/);
});

test("buildIco sorts frames, stores DIB for small sizes and PNG for 256", () => {
  const ico = buildIco([
    { size: 256, png: FAKE_PNG },
    { size: 16, rgba: solidRgba(16, [1, 2, 3, 255]) },
  ]);

  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 2);
  // Entry 0 is 16px.
  assert.equal(ico.readUInt8(6), 16);
  const firstOffset = ico.readUInt32LE(6 + 12);
  assert.equal(firstOffset, 6 + 16 * 2);
  assert.equal(ico.readUInt32LE(firstOffset), 40);
  // Entry 1 is 256px, encoded as width byte 0, payload is the PNG verbatim.
  assert.equal(ico.readUInt8(22), 0);
  const secondOffset = ico.readUInt32LE(22 + 12);
  const secondLength = ico.readUInt32LE(22 + 8);
  assert.deepEqual(ico.subarray(secondOffset, secondOffset + secondLength), FAKE_PNG);
  assert.equal(ico.length, secondOffset + secondLength);
});

test("buildIco requires the right payload per frame size", () => {
  assert.throws(() => buildIco([]), /at least one frame/);
  assert.throws(() => buildIco([{ size: 32 }]), /needs rgba/);
  assert.throws(() => buildIco([{ size: 256 }]), /needs png/);
  assert.throws(() => buildIco([{ size: 300, png: FAKE_PNG }]), /1\.\.256/);
});

test("buildIcns writes typed PNG entries and a correct total length", () => {
  const icns = buildIcns([
    { size: 512, png: FAKE_PNG },
    { size: 16, png: FAKE_PNG },
  ]);

  assert.equal(icns.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  assert.equal(icns.subarray(8, 12).toString("ascii"), "icp4");
  assert.equal(icns.readUInt32BE(12), FAKE_PNG.length + 8);
  const second = 8 + FAKE_PNG.length + 8;
  assert.equal(icns.subarray(second, second + 4).toString("ascii"), "ic09");
});

test("buildIcns rejects sizes without an ICNS type", () => {
  assert.throws(() => buildIcns([{ size: 48, png: FAKE_PNG }]), /No ICNS entry type for 48px/);
});
