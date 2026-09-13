import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyCellProtectionJournalReceipt } from "./remote-worker-cell-protection-record-proof.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest();

// Reconstruct actual native journal output independently. The SDK operations
// are controlled fixtures; this receipt does not assert a physical mount.
export function verifyCellMountJournalReceipt(receipt) {
  assert.equal(receipt.volumeMountExercised, false);
  assert.equal(receipt.mountProvisioningHistory.length, 19);
  verifyCellProtectionJournalReceipt({ volumeRootProtectionExercised: false,
    protectionProvisioningHistory: receipt.mountProvisioningHistory.slice(0, 15) });
  const records = receipt.mountProvisioningHistory.map((hex) => {
    assert.match(hex, /^[0-9a-f]{2048}$/u); return Buffer.from(hex, "hex");
  });
  const protection = records[14], root = protection.subarray(280, 792);
  const parent = records[4].subarray(600, 624), base = protection.subarray(992);
  let previousOuter = base, previousInner = Buffer.alloc(32);
  for (const [index, actual] of records.slice(15).entries()) {
    const nested = Buffer.alloc(512);
    nested.write("GCCMNT01", 0, "ascii"); nested.writeUInt32LE(index + 1, 8); previousInner.copy(nested, 16);
    root.subarray(480).copy(nested, 48); root.subarray(80, 112).copy(nested, 80);
    root.subarray(112, 128).copy(nested, 112); parent.copy(nested, 128); root.subarray(160, 184).copy(nested, 152);
    if (index > 0) { parent.subarray(0, 8).copy(nested, 176); nested.fill(0xe7, 184, 200); }
    previousInner = hash(nested.subarray(0, 480)); previousInner.copy(nested, 480);
    const expected = Buffer.alloc(1024);
    expected.write("GCCMNV01", 0, "ascii"); expected.writeUInt32LE(index + 1, 8); expected.writeUInt32LE(index + 1, 12);
    previousOuter.copy(expected, 16); protection.subarray(48, 216).copy(expected, 48); base.copy(expected, 216);
    protection.subarray(248, 280).copy(expected, 248); nested.copy(expected, 280);
    previousOuter = hash(expected.subarray(0, 992)); previousOuter.copy(expected, 992);
    assert.deepEqual(actual, expected, "Native mount journal must match independently constructed policy and identity-bound records.");
  }
}
