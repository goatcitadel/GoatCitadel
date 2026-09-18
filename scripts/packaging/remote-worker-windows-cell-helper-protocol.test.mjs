import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { snapshotCellControllerSources, buildWindowsCellController } from "./build-remote-worker-windows-cell-controller.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";
import { helperRuntimeHandshakeCase } from "./lib/remote-worker-runtime-helper-fixture.mjs";

const cell = "apps/remote-worker-windows-cell-native";
const stages = [
  ...Array.from({ length: 5 }, (_, index) => ["GCCELLP1", index + 1]),
  ...Array.from({ length: 6 }, (_, index) => ["GCCVOL01", index + 1]),
  ["GCCFMT01", 1], ["GCCFMT01", 2], ["GCCPRV01", 1], ["GCCPRV01", 2],
  ["GCCMNV01", 1], ["GCCMNV01", 2], ["GCCMNV01", 3], ["GCCMNV01", 4],
  ["GCCMWP01", 1], ["GCCMWP01", 2],
];
function frame(kind, payload) {
  const bytes = Buffer.alloc(5 + payload.length);
  bytes[0] = kind; bytes.writeUInt32LE(payload.length, 1); payload.copy(bytes, 5); return bytes;
}
async function exchange(executable, env, maximum, { mode = "create", badAck, badAuthority } = {}) {
  const backingMode = mode.startsWith("backing-capacity");
  const inventoryMode = mode.startsWith("inventory-capacity");
  const capacityMode = mode.startsWith("capacity") || backingMode || inventoryMode;
  const recover = mode === "recover" || capacityMode;
  const child = spawn(executable, [String(maximum), mode], { windowsHide: true, shell: false, env, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  let failure, pending = Buffer.alloc(0), total = 0, checkpoints = 0, authority = 0, receipt, capacity, inventoryEntries = 0;
  const stop = (error) => { failure ??= error; child.kill(); child.stdin.destroy(); };
  const timer = setTimeout(() => stop(new Error("Compiled helper stream fixture timed out.")), 5000);
  child.on("error", stop); child.stdout.on("error", stop); child.stderr.on("error", stop);
  child.stderr.on("data", () => stop(new Error("Unexpected helper diagnostics.")));
  child.stdin.on("error", (error) => { if (error.code !== "EPIPE") stop(error); });
  if (mode === "recover") child.stdin.end();
  child.stdout.on("data", (chunk) => {
    try {
      total += chunk.length; assert.ok(total <= (maximum === 21 ? 33150 + (inventoryMode ? 2367 : backingMode ? 429 : capacityMode ? 357 : 0) : maximum === 5 ? 8192 : 32768));
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const kind = pending[0], size = pending.readUInt32LE(1);
        assert.ok((kind === 1 && size === 1024) || (kind === 2 && size === 16) || (kind === 4 && size === 40) ||
          (capacityMode && !backingMode && !inventoryMode && kind === 6 && size === 352) || (backingMode && kind === 7 && size === 424) ||
          (inventoryMode && ((kind === 8 && size === 352) || (kind === 9 && size === 1000))));
        if (pending.length < size + 5) break;
        assert.equal(receipt, undefined);
        const payload = Buffer.from(pending.subarray(5, size + 5)); pending = pending.subarray(size + 5);
        if (kind === 1) {
          assert.equal(capacity, undefined);
          assert.ok(checkpoints < maximum);
          assert.equal(payload.subarray(0, 8).toString("ascii"), stages[checkpoints][0]);
          assert.equal(payload.readUInt32LE(8), stages[checkpoints][1]);
          assert.deepEqual(payload.subarray(992), Buffer.alloc(32, ++checkpoints));
          if (!recover) {
            const ack = Buffer.alloc(36); ack.writeUInt32LE(checkpoints); payload.subarray(992).copy(ack, 4);
            if (badAck === checkpoints) ack[4] ^= 1;
            if (maximum === 5 && checkpoints === 5) child.stdin.end(frame(3, ack));
            else child.stdin.write(frame(3, ack));
          }
        } else if (kind === 4) {
          assert.equal(capacity, undefined);
          assert.notEqual(mode, "recover"); assert.ok(authority < 256);
          assert.equal(payload.readUInt32LE(0), ++authority); assert.equal(payload.readUInt32LE(4), checkpoints);
          assert.deepEqual(payload.subarray(8), Buffer.alloc(32, checkpoints));
          const response = Buffer.from(payload);
          if (badAuthority?.count === checkpoints) response[badAuthority.offset] ^= 1;
          child.stdin.write(frame(5, response));
        } else if (kind === 6 || kind === 7 || kind === 8) {
          assert.equal(capacity, undefined); assert.equal(checkpoints, 21); assert.ok(authority > 0);
          const expected = Buffer.alloc(backingMode ? 424 : 352, 0);
          expected.fill(0x51, 0, 32); expected.writeBigUInt64LE(backingMode ? 22n : 11n, 32); expected.fill(12, 40, 56);
          expected.fill(13, 56, 88); expected.fill(14, 88, 120); expected.fill(15, 120, 152); expected.fill(16, 152, 184);
          for (let index = 0; index < 5; index += 1) {
            expected.writeBigUInt64LE(22n, 184 + index * 24); expected.fill(21 + index, 192 + index * 24, 208 + index * 24);
          }
          if (backingMode) {
            expected.fill(0x24, 304, 320); expected.writeBigUInt64LE(64n * 1024n * 1024n, 320); expected.writeBigUInt64LE(128n * 1024n * 1024n, 328);
            expected.copy(expected, 336, 232, 256); expected.writeBigUInt64LE(22n, 360); expected.fill(26, 368, 384);
            expected.writeBigUInt64LE(66n * 1024n * 1024n, 384); expected.writeBigUInt64LE(66n * 1024n * 1024n, 392);
            expected.writeBigUInt64LE(21504n, 400); expected.writeBigUInt64LE(24576n, 408); expected.writeBigUInt64LE(66n * 1024n * 1024n + 24576n, 416);
          } else {
            expected.copy(expected, 304, 208, 232); expected.writeBigUInt64LE(0x200000005n, 328); expected.writeBigUInt64LE(inventoryMode ? 22n * 4096n : 4096n, 336);
            expected.writeUInt32LE(inventoryMode ? 22 : 7, 344); expected.writeUInt32LE(inventoryMode ? 4 : 9, 348);
          }
          assert.deepEqual(payload, expected); capacity = payload.toString("hex");
        } else if (kind === 9) {
          assert.ok(capacity); assert.ok(inventoryEntries < 26);
          const count = Math.min(20, 26 - inventoryEntries), expected = Buffer.alloc(1000);
          expected.fill(0x51, 0, 32); expected.writeUInt32LE(inventoryEntries, 32); expected.writeUInt32LE(count, 36);
          for (let index = 0; index < count; index += 1) {
            const object = inventoryEntries + index, offset = 40 + index * 48;
            expected.writeBigUInt64LE(22n, offset); expected.fill(22 + object, offset + 8, offset + 24);
            expected.writeUInt32LE(object < 4 ? 1 : 0, offset + 24);
            expected.writeBigUInt64LE(object === 4 ? 0x200000005n : 0n, offset + 32);
            expected.writeBigUInt64LE(object < 4 ? 0n : 4096n, offset + 40);
          }
          assert.deepEqual(payload, expected); inventoryEntries += count;
        } else {
          assert.equal(checkpoints, maximum);
          if (inventoryMode) assert.equal(inventoryEntries, 26);
          assert.deepEqual([...new Uint32Array(payload.buffer, payload.byteOffset, 4)], [0, 5, recover ? 0 : 1, maximum]);
          assert.equal(Boolean(capacity), capacityMode);
          receipt = payload.toString("hex"); if (mode !== "recover" && maximum > 5) child.stdin.end();
        }
      }
    } catch (error) { stop(error); }
  });
  try {
    const result = await closed;
    if (failure) throw failure;
    assert.equal(result.signal, null); assert.equal(pending.length, 0);
    const refused = badAck !== undefined || badAuthority !== undefined || mode.endsWith("over-bound") || mode.endsWith("invalid");
    assert.equal(result.code, refused ? 3 : 0); assert.equal(Boolean(receipt), !refused);
    assert.equal(checkpoints, badAck ?? badAuthority?.count ?? maximum);
    if (mode === "recover") assert.equal(authority, 0);
    if (mode.endsWith("full-bound") || mode.endsWith("over-bound")) assert.equal(authority, 256);
    assert.equal(Boolean(capacity), capacityMode && !refused);
    assert.equal(inventoryEntries, inventoryMode && !refused ? 26 : 0);
    return { maximum, mode, badAck, badAuthority, checkpoints, authority, capacityForwarded: Boolean(capacity), inventoryEntries, outputBytes: total, exitCode: result.code };
  } finally { clearTimeout(timer); child.stdin.destroy(); await closed; }
}

test("compiled helper forwards every stage and withholds invalid acknowledgements without a controller or volume", {
  skip: process.platform !== "win32", timeout: 180000,
}, async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Cell Helper Protocol "));
  console.log(`Retained helper stream evidence: ${output}`);
  const repository = path.resolve(import.meta.dirname, "../..");
  const parentInputs = ["apps/remote-worker/src/worker-windows-runtime-helper.ts", "apps/remote-worker/dist/worker-windows-runtime-helper.js",
    "apps/remote-worker/src/worker-windows-runtime-dispatch.ts", "apps/remote-worker/dist/worker-windows-runtime-dispatch.js",
    "packages/contracts/src/remote-worker-runtime-node.ts", "packages/contracts/dist/remote-worker-runtime-node.js",
    "apps/remote-worker/src/worker-windows-cell-provisioning.ts", "apps/remote-worker/dist/worker-windows-cell-provisioning.js",
    "scripts/packaging/lib/remote-worker-runtime-helper-fixture.mjs"].map(name => ({ name,
    sha256: createHash("sha256").update(fs.readFileSync(path.join(repository, name))).digest("hex") }));
  const fixture = `${cell}/tests/cell_provisioning_helper_protocol_test.cpp`;
  const clients = ["cell_controller_client_identity", "cell_controller_client_protocol"].flatMap((name) =>
    ["cpp", "hpp"].map((extension) => `${cell}/src/${name}.${extension}`));
  const snapshot = snapshotCellControllerSources(output, [fixture, `${cell}/src/cell_provisioning_main.cpp`, ...clients]);
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  const env = { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" };
  const outcomes = [];
  for (const asan of [false, true]) {
    const executable = buildWindowsCellController({ outputDirectory: output, snapshot, asan, fixture, sourceBatchSize: 8,
      extraSources: clients.filter((name) => name.endsWith(".cpp")) });
    for (const suffix of ["", "-nonce", "-short", "-large"]) {
      const run = spawnSync(executable, [`--pool-response${suffix}`], { windowsHide: true, timeout: 5000, env });
      assert.equal(run.error, undefined); assert.equal(run.stderr.length, 0);
      assert.equal(run.status, suffix ? 3 : 0);
      if (suffix) assert.equal(run.stdout.length, 0, "Refused helper response emits no partial frame.");
      else {
        const bytes = Buffer.from(Array.from({ length: 1312 }, (_, i) => i % 251));
        bytes.write("GCPRESP1"); bytes.fill(0x51, 24, 56);
        const receipt = Buffer.alloc(16); receipt.writeUInt32LE(5, 4); receipt.writeUInt32LE(21, 12);
        assert.deepEqual(run.stdout, Buffer.concat([frame(14, bytes), frame(2, receipt)]));
      }
    }
    const cases = [];
    for (const maximum of [5, 11, 13, 15, 19, 21]) {
      cases.push(await exchange(executable, env, maximum));
      cases.push(await exchange(executable, env, maximum, { mode: "recover" }));
    }
    for (const badAck of [14, 15, 16, 17, 18, 19]) cases.push(await exchange(executable, env, 19, { badAck }));
    for (const count of [15, 16, 17, 18, 19]) for (const offset of [0, 4, 8])
      cases.push(await exchange(executable, env, 19, { badAuthority: { count, offset } }));
    for (const mode of ["full-bound", "over-bound"]) cases.push(await exchange(executable, env, 19, { mode }));
    for (const badAck of [20, 21]) cases.push(await exchange(executable, env, 21, { badAck }));
    for (const count of [19, 20, 21]) for (const offset of [0, 4, 8])
      cases.push(await exchange(executable, env, 21, { badAuthority: { count, offset } }));
    for (const mode of ["full-bound", "over-bound"]) cases.push(await exchange(executable, env, 21, { mode }));
    assert.equal(cases.length, 48);
    assert.equal(cases.find((item) => item.maximum === 21 && item.mode === "full-bound").outputBytes, 33150);
    for (const mode of ["capacity", "capacity-invalid", "capacity-full-bound", "capacity-over-bound"])
      cases.push(await exchange(executable, env, 21, { mode }));
    for (const offset of [0, 4, 8]) cases.push(await exchange(executable, env, 21, { mode: "capacity", badAuthority: { count: 21, offset } }));
    for (const mode of ["backing-capacity", "backing-capacity-invalid", "backing-capacity-full-bound", "backing-capacity-over-bound"])
      cases.push(await exchange(executable, env, 21, { mode }));
    for (const offset of [0, 4, 8]) cases.push(await exchange(executable, env, 21, { mode: "backing-capacity", badAuthority: { count: 21, offset } }));
    assert.equal(cases.length, 62);
    assert.equal(cases.find((item) => item.mode === "capacity-full-bound").outputBytes, 33507);
    assert.equal(cases.find((item) => item.mode === "backing-capacity-full-bound").outputBytes, 33579);
    for (const mode of ["inventory-capacity", "inventory-capacity-invalid", "inventory-capacity-full-bound", "inventory-capacity-over-bound"])
      cases.push(await exchange(executable, env, 21, { mode }));
    for (const offset of [0, 4, 8]) cases.push(await exchange(executable, env, 21, { mode: "inventory-capacity", badAuthority: { count: 21, offset } }));
    assert.equal(cases.length, 69);
    assert.equal(cases.find((item) => item.mode === "inventory-capacity-full-bound").outputBytes, 35517);
    const runtimeHandshake = [];
    for (const mode of ["accepted", "wrong-ack", "wrong-magic", "changed-request", "reserved", "zero-secret", "public-secret", "oversized", "cancelled", "expired", "control-accepted", "control-wrong-role"])
      runtimeHandshake.push(await helperRuntimeHandshakeCase(executable, env, mode));
    outcomes.push({ asan, cases, runtimeHandshake });
  }
  for (const item of [...snapshot.sourceManifest, ...parentInputs]) assert.equal(createHash("sha256").update(fs.readFileSync(path.join(repository, item.name))).digest("hex"),
    item.sha256, `Helper source changed during proof: ${item.name}`);
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ sourceManifest: snapshot.sourceManifest, parentInputs, outcomes,
    installedService: false, controllerConnected: false, volumeAttached: false, ntfsFormatted: false, volumeRootProtected: false, volumeMounted: false,
    boundary: "Production helper stream callbacks over owned child stdio with synthetic checkpoint metadata. Full native canonical-chain validation is a separate controller test. No installed entrypoint, custody, journal, VHDX or volume operation is invoked.",
  }, null, 2), { flag: "wx" });
});
