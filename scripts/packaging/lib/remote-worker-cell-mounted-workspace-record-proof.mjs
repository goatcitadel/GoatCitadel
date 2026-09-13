import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyCellMountJournalReceipt } from "./remote-worker-cell-mount-record-proof.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest();

// Reconstruct the actual journal bytes independently. The native owner runs
// through controlled volume/directory drivers; this does not prove a physical mount.
export function verifyCellMountedWorkspaceJournalReceipt(receipt) {
  assert.equal(receipt.mountedWorkspaceExercised, false);
  assert.equal(receipt.mountedWorkspaceProvisioningHistory.length, 21);
  verifyCellMountJournalReceipt({ volumeMountExercised: false,
    mountProvisioningHistory: receipt.mountedWorkspaceProvisioningHistory.slice(0, 19) });
  const records = receipt.mountedWorkspaceProvisioningHistory.map((hex) => {
    assert.match(hex, /^[0-9a-f]{2048}$/u); return Buffer.from(hex, "hex");
  });
  const mounted = records[18], mount = mounted.subarray(280, 792), base = mounted.subarray(992);
  let previousOuter = base, previousInner = Buffer.alloc(32);
  for (const [index, actual] of records.slice(19).entries()) {
    const nested = Buffer.alloc(512);
    nested.write("GCCWRK01", 0, "ascii"); nested.writeUInt32LE(index + 1, 8); previousInner.copy(nested, 16);
    mount.subarray(480).copy(nested, 48); mount.subarray(80, 112).copy(nested, 80);
    records[4].subarray(192, 232).copy(nested, 112); mount.subarray(152, 176).copy(nested, 152);
    if (index) {
      for (let directory = 0; directory < 4; ++directory) {
        const offset = 176 + directory * 24;
        mount.subarray(152, 160).copy(nested, offset); nested.fill(0xe8 + directory, offset + 8, offset + 24);
      }
    }
    previousInner = hash(nested.subarray(0, 480)); previousInner.copy(nested, 480);
    const expected = Buffer.alloc(1024);
    expected.write("GCCMWP01", 0, "ascii"); expected.writeUInt32LE(index + 1, 8); expected.writeUInt32LE(index + 1, 12);
    previousOuter.copy(expected, 16); mounted.subarray(48, 216).copy(expected, 48); base.copy(expected, 216);
    mounted.subarray(248, 280).copy(expected, 248); nested.copy(expected, 280);
    previousOuter = hash(expected.subarray(0, 992)); previousOuter.copy(expected, 992);
    assert.deepEqual(actual, expected, "Mounted workspace journal must match independently reconstructed owner, mount, policy and identity bindings.");
  }
}
