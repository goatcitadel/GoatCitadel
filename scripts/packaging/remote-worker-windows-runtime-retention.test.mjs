import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { snapshotCellControllerSources, buildWindowsCellController } from "./build-remote-worker-windows-cell-controller.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";
import { WindowsRuntimeResultRetentionParent } from "../../apps/remote-worker/dist/worker-windows-runtime-retention.js";
import { WindowsRuntimeParentSession } from "../../apps/remote-worker/dist/worker-windows-runtime-parent-session.js";
import { runtimeResultPagesFixture } from "../../packages/contracts/dist/remote-worker-runtime-result-pages-test-fixture.js";

test("native callback and JavaScript parent require a separate exact retention receipt", { skip: process.platform !== "win32" }, async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Native Retention "));
  console.log(`Retained native retention evidence: ${output}`);
  const repository = path.resolve(import.meta.dirname, "../.."), hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const parentInputs = ["apps/remote-worker/src/worker-windows-runtime-retention.ts", "apps/remote-worker/dist/worker-windows-runtime-retention.js",
    "apps/remote-worker/src/worker-windows-runtime-parent-session.ts", "apps/remote-worker/dist/worker-windows-runtime-parent-session.js",
    "apps/remote-worker/src/worker-windows-runtime-streams.ts", "apps/remote-worker/dist/worker-windows-runtime-streams.js",
    "apps/remote-worker/src/worker-windows-runtime-authority.ts", "apps/remote-worker/dist/worker-windows-runtime-authority.js",
    "apps/remote-worker/src/worker-runtime-result-client.ts", "apps/remote-worker/dist/worker-runtime-result-client.js",
    "packages/contracts/src/remote-worker-runtime-result.ts", "packages/contracts/dist/remote-worker-runtime-result.js"]
    .map(name => ({ name, sha256: hash(fs.readFileSync(path.join(repository, name))) }));
  const fixture = "apps/remote-worker-windows-cell-native/tests/cell_runtime_result_test.cpp", snapshot = snapshotCellControllerSources(output, [fixture]);
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  const env = { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" };
  const f = runtimeResultPagesFixture(19996, true), summary = f.bytes.subarray(256, 608), material = Buffer.alloc(324);
  material.write("GCRBF001");
  for (const [offset, value] of [[8, f.expectation.nonce], [40, f.expectation.requestSha256], [72, f.expectation.checkpointSha256], [104, f.expectation.runtimeBundleSha256]])
    Buffer.from(value, "hex").copy(material, offset);
  summary.copy(material, 136, 32, 56); summary.copy(material, 160, 56, 88);
  summary.copy(material, 192, 184, 208); summary.copy(material, 216, 208, 304);
  material.writeUInt32LE(f.expectation.maxInputBytes, 312); material.writeUInt32LE(f.expectation.maxOutputBytes, 316); material.writeUInt32LE(f.expectation.maxInventoryEntries, 320);
  const expectedPath = path.join(output, "independent-expectation.bin"), resultPath = path.join(output, "canonical-result.bin");
  fs.writeFileSync(expectedPath, material, { flag: "wx" }); fs.writeFileSync(resultPath, f.bytes, { flag: "wx" });
  const outcomes = [];
  for (const asan of [false, true]) {
    const executable = buildWindowsCellController({ outputDirectory: output, snapshot, asan, fixture });
    const component = spawnSync(executable, [], { windowsHide: true, encoding: "utf8", timeout: 40000, env });
    fs.writeFileSync(path.join(output, `${asan ? "asan" : "normal"}-components.log`), (component.stdout ?? "") + (component.stderr ?? ""), { flag: "wx" });
    assert.equal(component.error, undefined); assert.equal(component.status, 0, component.stderr);
    const report = JSON.parse(component.stdout); assert.equal(report.passed, true); assert.equal(report.pipeFixtures, 31);
    const cases = [];
    for (const mode of ["retained", "retained_delayed_final_check", "peer_closed_after_receipt", "refused", "wrong_digest", "cancelled_after_commit", "session_complete", "session_input_denied",
      "session_runtime_denied", "session_output_denied", "session_retention_denied", "session_cancel_commit", "session_finish_denied"]) {
      const session = mode.startsWith("session_");
      const pipeName = `\\\\.\\pipe\\GoatCitadel.NativeRetention.Proof.${randomUUID()}`, server = net.createServer(), controller = new AbortController();
      let socket, parent, commits = 0, rejectConnection;
      const retained = new Promise((resolve, reject) => {
        rejectConnection = reject;
        server.once("connection", channel => {
          socket = channel;
          const retentionOwner = {
            signal: controller.signal, timeoutMs: 12000, authorize: async () => {
              if (!parent?.state.retentionReceiptAttempted) return;
              if (mode === "retained_delayed_final_check") await new Promise(resolve => setTimeout(resolve, 25));
              if (mode === "peer_closed_after_receipt" && !channel.destroyed) await new Promise(resolve => channel.once("close", resolve));
            },
            retain: async (hex, signal) => {
              assert.equal(hex, f.resultHex); assert.equal(signal.aborted, false); commits += 1;
              if (mode === "refused") throw new Error("Controlled uncertain protected commit");
              if (mode === "cancelled_after_commit" || mode === "session_cancel_commit") controller.abort();
              return { ...f.response(null, true).record, ...(mode === "wrong_digest" ? { resultSha256: "ff".repeat(32) } : {}) };
            },
          };
          parent = session ? new WindowsRuntimeParentSession(channel, f.expectation, f.history, {
            signal: controller.signal, timeoutMs: 12000, retain: retentionOwner.retain, authorizePeer: async () => {},
            readInput: async () => "eof",
            authorizeInput: async () => { if (mode === "session_input_denied") throw new Error("Controlled input denial"); },
            authorizeRuntime: async () => { if (mode === "session_runtime_denied") throw new Error("Controlled runtime denial"); },
            consumeOutput: async () => { if (mode === "session_output_denied") throw new Error("Controlled output denial"); },
            authorizeDelivery: async () => {},
            authorizeRetention: async () => {
              if (mode === "session_retention_denied" || (mode === "session_finish_denied" && parent.state.phase === "retained")) throw new Error("Controlled retention/finish denial");
            },
          }) : new WindowsRuntimeResultRetentionParent(channel, f.expectation, f.history, retentionOwner);
          parent.run().then(value => resolve({ ok: true, value }), () => {
            resolve({ ok: false }); channel.destroy();
          });
        });
      });
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(pipeName, resolve); });
      const invocation = session ? "--parent-session" : mode === "peer_closed_after_receipt" ? "--parent-bridge-close" : "--parent-bridge";
      const child = spawn(executable, [invocation, pipeName, expectedPath, resultPath, String(process.pid)], { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      let resolveReported;
      const reported = new Promise(resolve => { resolveReported = resolve; });
      const finished = new Promise((resolve, reject) => {
        child.once("error", reject); child.stdout.on("data", bytes => {
          stdout += bytes; if (stdout.length > 4096) child.kill();
          if (stdout.includes("\n")) resolveReported();
        });
        child.stderr.on("data", bytes => { stderr += bytes; if (stderr.length > 4096) child.kill(); });
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      const watchdog = setTimeout(() => { controller.abort(); socket?.destroy(); child.kill(); rejectConnection(new Error("Owned native bridge watchdog expired")); }, 20000);
      try {
        // Join both callback owners before releasing the fixture endpoint. The
        // stdout report means the native callback (including final custody)
        // has returned, not that any production protocol check can be skipped.
        const [received] = await Promise.all([retained, Promise.race([reported, finished])]);
        socket?.destroy();
        const exited = await finished;
        fs.writeFileSync(path.join(output, `${asan ? "asan" : "normal"}-${mode}.log`), stdout + stderr, { flag: "wx" });
        const evidence = { mode, asan, received, exited, parent: parent.state, commits };
        fs.writeFileSync(path.join(output, `${asan ? "asan" : "normal"}-${mode}.json`), JSON.stringify(evidence, null, 2), { flag: "wx" });
        assert.equal(exited.code, 0, stderr); assert.equal(exited.signal, null);
        const native = JSON.parse(stdout);
        if (session) {
          assert.equal(native.retained, ["session_complete", "session_finish_denied"].includes(mode));
          assert.equal(native.finished, mode === "session_complete"); assert.equal(received.ok, mode === "session_complete");
          assert.equal(parent.state.finished, mode === "session_complete");
          assert.equal(parent.state.retentionConfirmed, ["session_complete", "session_finish_denied"].includes(mode));
          assert.equal(commits, ["session_complete", "session_cancel_commit", "session_finish_denied"].includes(mode) ? 1 : 0);
        } else {
          const complete = mode === "retained" || mode === "retained_delayed_final_check";
          assert.equal(native.retained, complete || mode === "peer_closed_after_receipt", JSON.stringify(evidence));
          assert.equal(received.ok, complete, JSON.stringify(evidence));
          assert.equal(commits, 1); assert.equal(parent.state.retentionReceiptSent, complete);
          if (mode === "peer_closed_after_receipt") {
            assert.equal(parent.state.retentionConfirmed, true); assert.equal(parent.state.retentionReceiptAttempted, true);
          }
        }
        assert.equal(native.installedService, false); assert.equal(native.volumeAttached, false);
        cases.push({ mode, native, parent: parent.state, commits });
      } finally {
        clearTimeout(watchdog); controller.abort(); socket?.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await finished.catch(() => {}); await new Promise(resolve => server.close(resolve));
      }
    }
    outcomes.push({ asan, component: report, cases });
  }
  for (const input of [...snapshot.sourceManifest, ...parentInputs]) assert.equal(hash(fs.readFileSync(path.join(repository, input.name))), input.sha256, input.name);
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ sourceManifest: snapshot.sourceManifest, parentInputs, outcomes,
    resultSha256: f.resultSha256, resultBytes: f.bytes.length, expectationFileSha256: hash(material),
    boundary: "Actual private Windows pipes connect the native retention and composed callback owners to the production Node receiver/dispatcher in normal and AddressSanitizer builds. Seven composed cases cover input, runtime, output, delivery, complete 20000-object result retention, post-retention checks and explicit finish. Canonical grants, controller completion and commit responses are controlled. No installed custody, mounted capture, live admission, actual workload or service/volume operation occurs.",
  }, null, 2), { flag: "wx" });
});
