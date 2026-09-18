import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { WindowsRuntimeParentStreams } from "../../../apps/remote-worker/dist/worker-windows-runtime-streams.js";
import { runtimeResultPagesFixture } from "../../../packages/contracts/dist/remote-worker-runtime-result-pages-test-fixture.js";

export async function runRuntimeStreamParentFixture(executable, output, env, asan) {
  const fixture = runtimeResultPagesFixture(0), outcomes = [];
  const expected = { ...fixture.expectation, nonce: "31".repeat(32), requestSha256: "72".repeat(32), maxInputBytes: 976, maxOutputBytes: 1952 };
  const data = Buffer.from(Array.from({ length: 976 }, (_, i) => i & 255));
  for (const mode of ["forwarded", "input_denied", "output_denied", "wrong_receipt", "cancel_after_output"]) {
    const endpoint = `\\\\.\\pipe\\GoatCitadel.NativeStreams.Proof.${randomUUID()}`;
    const server = net.createServer(), stop = new AbortController();
    let socket, pending = Buffer.alloc(0), draining = false, parentFailure = false, sourceCalls = 0, inputApprovals = 0;
    const frames = []; let drainTask = Promise.resolve();
    server.on("connection", channel => {
      if (socket) { channel.destroy(); return; } socket = channel;
      const parent = new WindowsRuntimeParentStreams(expected, fixture.history, {
        signal: stop.signal, timeoutMs: 10000,
        authorizePeer: async () => { assert.equal(channel.destroyed, false); },
        readInput: async maximum => {
          sourceCalls += 1; assert.equal(maximum, sourceCalls < 3 ? 976 : 0);
          return sourceCalls === 1 ? null : sourceCalls === 2 ? data : "eof";
        },
        authorizeInput: async (_expected, _history, frame) => {
          inputApprovals += 1;
          assert.deepEqual(frame.bytes, frame.eof ? Buffer.alloc(0) : data);
          if (mode === "input_denied") throw new Error("Controlled exact input denial");
        },
        consumeOutput: async (_expected, _history, stream, frame) => {
          assert.deepEqual(frame.bytes, frame.eof ? Buffer.alloc(0) : data);
          frames.push({ stream, sequence: frame.sequence, total: frame.total, eof: frame.eof, count: frame.bytes.length });
          if (mode === "output_denied") throw new Error("Controlled output refusal");
          if (mode === "cancel_after_output") stop.abort();
        },
        reply: async (kind, bytes, signal) => {
          assert.equal(signal.aborted, false);
          const payload = Buffer.from(bytes), header = Buffer.alloc(16); header.write("GCCELL01");
          header.writeUInt32LE(kind, 8); header.writeUInt32LE(payload.length, 12);
          if (mode === "wrong_receipt" && kind === 34) payload[0] ^= 2;
          await new Promise((resolve, reject) => channel.write(Buffer.concat([header, payload]), error => error ? reject(error) : resolve()));
        },
      });
      const drain = async () => {
        if (draining) return; draining = true;
        try {
          while (pending.length >= 16) {
            assert.equal(pending.subarray(0, 8).equals(Buffer.from("GCCELL01")), true);
            const kind = pending.readUInt32LE(8), size = pending.readUInt32LE(12);
            assert.ok([24, 25, 26, 27, 32].includes(kind)); assert.equal(size, kind === 32 ? 88 : 1056);
            if (pending.length < size + 16) break;
            const payload = Buffer.from(pending.subarray(16, size + 16)); pending = Buffer.from(pending.subarray(size + 16));
            await parent.respond(kind, payload);
          }
        } catch { parentFailure = true; channel.destroy(); }
        finally { draining = false; }
      };
      channel.on("data", bytes => {
        pending = Buffer.concat([pending, bytes]);
        if (pending.length > 4096) { parentFailure = true; channel.destroy(); return; }
        if (!draining) drainTask = drain();
      });
      channel.on("error", () => { parentFailure = true; channel.destroy(); });
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
    const child = spawn(executable, ["--parent-streams", endpoint, String(process.pid)], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", watchdogExpired = false;
    const finished = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.on("data", bytes => { stdout += bytes; if (stdout.length > 4096) child.kill(); });
      child.stderr.on("data", bytes => { stderr += bytes; if (stderr.length > 4096) child.kill(); });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const watchdog = setTimeout(() => { watchdogExpired = true; stop.abort(); socket?.destroy(); child.kill(); }, 15000);
    try {
      const ended = await finished; await drainTask;
      assert.equal(watchdogExpired, false); assert.equal(ended.code, 0, stderr); assert.equal(ended.signal, null);
      const native = JSON.parse(stdout); assert.equal(native.completed, mode === "forwarded");
      assert.equal(native.installedService, false); assert.equal(native.volumeAttached, false);
      assert.equal(parentFailure, ["input_denied", "output_denied", "cancel_after_output"].includes(mode));
      assert.equal(sourceCalls, mode === "forwarded" ? 3 : 2);
      assert.equal(inputApprovals, mode === "forwarded" ? 2 : 1);
      assert.equal(frames.length, mode === "forwarded" ? 4 : mode === "input_denied" ? 0 : 1);
      if (mode === "forwarded") assert.deepEqual(frames.map(frame => [frame.stream, frame.eof]), [["stdout", false], ["stderr", false], ["stderr", true], ["stdout", true]]);
      outcomes.push({ mode, native, sourceCalls, inputApprovals, frames, parentFailure });
      fs.writeFileSync(path.join(output, `${asan ? "asan" : "normal"}-streams-${mode}.log`), stdout + stderr, { flag: "wx" });
    } finally {
      clearTimeout(watchdog); stop.abort(); socket?.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await finished.catch(() => {}); await drainTask.catch(() => {}); await new Promise(resolve => server.close(resolve));
    }
  }
  return outcomes;
}
