import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const hash = (bytes) => createHash("sha256").update(bytes).digest();
function policyHash(first) {
  const parts = [Buffer.from("goatcitadel.native-cell-volume-root-security.v1\0", "ascii")];
  for (const offset of [232, 416]) {
    const field = first.subarray(offset, offset + 184), end = field.indexOf(0);
    assert.ok(end > 0 && field.subarray(end).every((byte) => byte === 0));
    const sid = field.subarray(0, end);
    assert.match(sid.toString("ascii"), /^S-1-5-(?:18|21-\d+-\d+-\d+-\d+|80-\d+-\d+-\d+-\d+-\d+)$/u);
    const length = Buffer.alloc(2); length.writeUInt16LE(sid.length); parts.push(length, sid);
  }
  return hash(Buffer.concat(parts));
}

// Independent construction against actual emitted native journal bytes. These
// fixtures prove sequencing/retention only; they never attach or format a volume.
export function verifyCellProtectionJournalReceipt(receipt) {
  assert.equal(receipt.volumeRootProtectionExercised, false);
  assert.equal(receipt.protectionProvisioningHistory.length, 15);
  const records = receipt.protectionProvisioningHistory.map((hex) => {
    assert.match(hex, /^[0-9a-f]{2048}$/u); return Buffer.from(hex, "hex");
  });
  let previous = Buffer.alloc(32);
  for (const [index, record] of records.entries()) {
    const [magic, sequence] = index < 5 ? ["GCCELLP1", index + 1] : index < 11 ? ["GCCVOL01", index - 4]
      : index < 13 ? ["GCCFMT01", index - 10] : ["GCCPRV01", index - 12];
    assert.equal(record.subarray(0, 8).toString("ascii"), magic);
    assert.equal(record.readUInt32LE(8), sequence); assert.equal(record.readUInt32LE(12), sequence);
    assert.deepEqual(record.subarray(16, 48), previous);
    previous = hash(record.subarray(0, 992)); assert.deepEqual(record.subarray(992), previous);
  }
  const format = records[12], ntfs = format.subarray(280, 792), base = format.subarray(992);
  assert.equal(ntfs.subarray(0, 8).toString("ascii"), "GCCNTF01");
  assert.equal(ntfs.readUInt32LE(8), 2); assert.deepEqual(ntfs.subarray(480), hash(ntfs.subarray(0, 480)));
  let priorOuter = base, priorNested = Buffer.alloc(32);
  for (const [index, actual] of records.slice(13).entries()) {
    const nested = Buffer.alloc(512);
    nested.write("GCCPRT01", 0, "ascii"); nested.writeUInt32LE(index + 1, 8); priorNested.copy(nested, 16);
    ntfs.subarray(480).copy(nested, 48); policyHash(records[0]).copy(nested, 80);
    ntfs.subarray(80, 96).copy(nested, 112); ntfs.subarray(96, 104).copy(nested, 128);
    ntfs.subarray(184, 208).copy(nested, 136); ntfs.subarray(184, 192).copy(nested, 160); nested.fill(0xd6, 168, 184);
    priorNested = hash(nested.subarray(0, 480)); priorNested.copy(nested, 480);
    const expected = Buffer.alloc(1024);
    expected.write("GCCPRV01", 0, "ascii"); expected.writeUInt32LE(index + 1, 8); expected.writeUInt32LE(index + 1, 12);
    priorOuter.copy(expected, 16); format.subarray(48, 216).copy(expected, 48); base.copy(expected, 216);
    format.subarray(248, 280).copy(expected, 248); nested.copy(expected, 280);
    priorOuter = hash(expected.subarray(0, 992)); priorOuter.copy(expected, 992);
    assert.deepEqual(actual, expected, "Native protection journal must match independently constructed policy/identity-bound records.");
  }
}
