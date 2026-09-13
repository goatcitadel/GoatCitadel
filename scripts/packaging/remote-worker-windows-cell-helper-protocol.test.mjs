import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { snapshotCellControllerSources, buildWindowsCellController } from "./build-remote-worker-windows-cell-controller.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";

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
  const child = spawn(executable, [String(maximum), mode], { windowsHide: true, shell: false, env, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  let failure, pending = Buffer.alloc(0), total = 0, checkpoints = 0, authority = 0, receipt;
  const stop = (error) => { failure ??= error; child.kill(); child.stdin.destroy(); };
  const timer = setTimeout(() => stop(new Error("Compiled helper stream fixture timed out.")), 5000);
  child.on("error", stop); child.stdout.on("error", stop); child.stderr.on("error", stop);
  child.stderr.on("data", () => stop(new Error("Unexpected helper diagnostics.")));
  child.stdin.on("error", (error) => { if (error.code !== "EPIPE") stop(error); });
  if (mode === "recover") child.stdin.end();
  child.stdout.on("data", (chunk) => {
    try {
      total += chunk.length; assert.ok(total <= (maximum === 21 ? 33150 : maximum === 5 ? 8192 : 32768));
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const kind = pending[0], size = pending.readUInt32LE(1);
        assert.ok((kind === 1 && size === 1024) || (kind === 2 && size === 16) || (kind === 4 && size === 40));
        if (pending.length < size + 5) break;
        assert.equal(receipt, undefined);
        const payload = Buffer.from(pending.subarray(5, size + 5)); pending = pending.subarray(size + 5);
        if (kind === 1) {
          assert.ok(checkpoints < maximum);
          assert.equal(payload.subarray(0, 8).toString("ascii"), stages[checkpoints][0]);
          assert.equal(payload.readUInt32LE(8), stages[checkpoints][1]);
          assert.deepEqual(payload.subarray(992), Buffer.alloc(32, ++checkpoints));
          if (mode !== "recover") {
            const ack = Buffer.alloc(36); ack.writeUInt32LE(checkpoints); payload.subarray(992).copy(ack, 4);
            if (badAck === checkpoints) ack[4] ^= 1;
            if (maximum === 5 && checkpoints === 5) child.stdin.end(frame(3, ack));
            else child.stdin.write(frame(3, ack));
          }
        } else if (kind === 4) {
          assert.notEqual(mode, "recover"); assert.ok(authority < 256);
          assert.equal(payload.readUInt32LE(0), ++authority); assert.equal(payload.readUInt32LE(4), checkpoints);
          assert.deepEqual(payload.subarray(8), Buffer.alloc(32, checkpoints));
          const response = Buffer.from(payload);
          if (badAuthority?.count === checkpoints) response[badAuthority.offset] ^= 1;
          child.stdin.write(frame(5, response));
        } else {
          assert.equal(checkpoints, maximum);
          assert.deepEqual([...new Uint32Array(payload.buffer, payload.byteOffset, 4)], [0, 5, mode === "recover" ? 0 : 1, maximum]);
          receipt = payload.toString("hex"); if (mode !== "recover" && maximum > 5) child.stdin.end();
        }
      }
    } catch (error) { stop(error); }
  });
  try {
    const result = await closed;
    if (failure) throw failure;
    assert.equal(result.signal, null); assert.equal(pending.length, 0);
    const refused = badAck !== undefined || badAuthority !== undefined || mode === "over-bound";
    assert.equal(result.code, refused ? 3 : 0); assert.equal(Boolean(receipt), !refused);
    assert.equal(checkpoints, badAck ?? badAuthority?.count ?? maximum);
    if (mode === "recover") assert.equal(authority, 0);
    if (mode === "full-bound" || mode === "over-bound") assert.equal(authority, 256);
    return { maximum, mode, badAck, badAuthority, checkpoints, authority, outputBytes: total, exitCode: result.code };
  } finally { clearTimeout(timer); child.stdin.destroy(); await closed; }
}

test("compiled helper forwards every stage and withholds invalid acknowledgements without a controller or volume", {
  skip: process.platform !== "win32", timeout: 180000,
}, async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Cell Helper Protocol "));
  console.log(`Retained helper stream evidence: ${output}`);
  const fixture = `${cell}/tests/cell_provisioning_helper_protocol_test.cpp`;
  const clients = ["cell_controller_client_identity", "cell_controller_client_protocol"].flatMap((name) =>
    ["cpp", "hpp"].map((extension) => `${cell}/src/${name}.${extension}`));
  const snapshot = snapshotCellControllerSources(output, [fixture, `${cell}/src/cell_provisioning_main.cpp`, ...clients]);
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  const env = { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" };
  const outcomes = [];
  for (const asan of [false, true]) {
    const executable = buildWindowsCellController({ outputDirectory: output, snapshot, asan, fixture,
      extraSources: clients.filter((name) => name.endsWith(".cpp")) });
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
    outcomes.push({ asan, cases });
  }
  const repository = path.resolve(import.meta.dirname, "../..");
  for (const item of snapshot.sourceManifest) assert.equal(createHash("sha256").update(fs.readFileSync(path.join(repository, item.name))).digest("hex"),
    item.sha256, `Helper source changed during proof: ${item.name}`);
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ sourceManifest: snapshot.sourceManifest, outcomes,
    installedService: false, controllerConnected: false, volumeAttached: false, ntfsFormatted: false, volumeRootProtected: false, volumeMounted: false,
    boundary: "Production helper stream callbacks over owned child stdio with synthetic checkpoint metadata. Full native canonical-chain validation is a separate controller test. No installed entrypoint, custody, journal, VHDX or volume operation is invoked.",
  }, null, 2), { flag: "wx" });
});
