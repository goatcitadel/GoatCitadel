import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { WindowsRuntimeCleanupSender } from "../../apps/remote-worker/dist/worker-windows-runtime-cleanup.js";
import { encodeWindowsAssignmentCleanupAdmission } from "../../apps/remote-worker/dist/worker-windows-assignment-cleanup.js";
import { test } from "node:test";
import { snapshotCellControllerSources, buildWindowsCellController } from "./build-remote-worker-windows-cell-controller.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";
import { objectInventoryHistoryFixture } from "../../packages/contracts/dist/remote-worker-cell-object-inventory-test-fixture.js";
import { encodeRemoteWorkerRuntimeCleanup, REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA } from "../../packages/contracts/dist/index.js";
import { readRemoteWorkerCellProvisioningCheckpoint, REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION,
  REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION, remoteWorkerRuntimeInstallRequestSha256,
  encodeRemoteWorkerRuntimeInstallRequest, readRemoteWorkerRuntimeInstallOutcome } from "../../packages/contracts/dist/index.js";

async function cleanupParent(executable, fixture, env, output, label, mismatched = false) {
  const pipe = `\\\\.\\pipe\\LOCAL\\GoatCitadel.Cleanup.Parent.${randomUUID()}`, server = net.createServer(), stop = new AbortController();
  let channel, child, stdout = "", stderr = "";
  const connected = new Promise((resolve, reject) => {
    server.on("error", reject); server.once("connection", socket => { channel = socket; socket.on("error", () => {}); resolve(socket); });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(pipe, resolve); });
  const input = mismatched ? path.join(output, `${label}-mismatched.bin`) : fixture.input;
  if (mismatched) { const bytes = fs.readFileSync(fixture.input); bytes[32] ^= 1; fs.writeFileSync(input, bytes, { flag: "wx" }); }
  child = spawn(executable, ["--cleanup-parent", input, pipe, String(process.pid)], { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  child.stdout.on("data", bytes => { stdout += bytes; if (stdout.length > 8192) child.kill(); });
  child.stderr.on("data", bytes => { stderr += bytes; if (stderr.length > 8192) child.kill(); });
  const timer = setTimeout(() => { stop.abort(); channel?.destroy(); child.kill(); }, 15000);
  const delivery = (async () => {
    const socket = await Promise.race([connected, exited.then(() => { throw new Error("Native receiver exited before connection"); })]);
    const sender = new WindowsRuntimeCleanupSender(socket, fixture.exchange, { signal: stop.signal, timeoutMs: 10000,
      authorize: async signal => { signal.throwIfAborted(); if (child.exitCode !== null || child.signalCode !== null) throw new Error("Native receiver ended"); } });
    const receipt = await sender.send();
    await new Promise((resolve, reject) => socket.write(Buffer.from([1]), error => error ? reject(error) : resolve()));
    return receipt;
  })();
  try {
    const [sent, process] = await Promise.allSettled([delivery, exited]);
    fs.writeFileSync(path.join(output, `${label}.log`), stdout + stderr, { flag: "wx" });
    assert.equal(process.status, "fulfilled"); assert.equal(process.value.signal, null);
    if (mismatched) { assert.equal(sent.status, "rejected"); assert.equal(process.value.code, 1); return { rejected: true }; }
    assert.equal(sent.status, "fulfilled", sent.reason?.stack); assert.equal(process.value.code, 0, stderr);
    const result = JSON.parse(stdout); assert.equal(result.passed, true); assert.equal(result.expectations, fixture.count);
    return { ...result, receipt: sent.value };
  } finally {
    clearTimeout(timer); stop.abort(); channel?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited.catch(() => {}); await new Promise(resolve => server.close(resolve));
  }
}
test("controller local outcomes survive interrupted delivery without replay", { skip: process.platform !== "win32" }, async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Local Outcome "));
  console.log(`Retained local outcome evidence: ${output}`);
  const fixture = "apps/remote-worker-windows-cell-native/tests/cell_runtime_local_outcome_test.cpp";
  const snapshot = snapshotCellControllerSources(output, [fixture, "packages/contracts/src/remote-worker-runtime-cleanup-wire.ts",
    "packages/contracts/dist/remote-worker-runtime-cleanup-wire.js", "packages/contracts/src/remote-worker-runtime-cleanup.ts",
    "packages/contracts/dist/remote-worker-runtime-cleanup.js", "scripts/packaging/remote-worker-windows-runtime-result.test.mjs",
    "apps/remote-worker/src/worker-windows-runtime-cleanup.ts", "apps/remote-worker/dist/worker-windows-runtime-cleanup.js",
    "apps/remote-worker/src/worker-windows-assignment-cleanup.ts", "apps/remote-worker/dist/worker-windows-assignment-cleanup.js"]);
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  const env = { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" };
  const outcomes = [];
  const history = objectInventoryHistoryFixture(), first = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]);
  const installation = { schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION, nonce: "18".repeat(32),
    journalIdentityHex: first.journalIdentityHex, preparedSha256: first.recordSha256,
    checkpointSha256: history.mountedWorkspaceRecords[1].slice(-64), packageSha256: "55".repeat(32),
    runtimeBundle: { schemaVersion: REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION, files: [
      { relativePath: "node.exe", bytes: 100, sha256: "66".repeat(32) },
      { relativePath: "worker-host-receipt.json", bytes: 20, sha256: "77".repeat(32) },
    ] } };
  const installationInput = path.join(output, "installation-input.bin");
  fs.writeFileSync(installationInput, Buffer.concat([
    Buffer.from(installation.nonce + remoteWorkerRuntimeInstallRequestSha256(installation), "hex"),
    encodeRemoteWorkerRuntimeInstallRequest(installation),
    Buffer.from(history.plan.assignmentBindingSha256 + history.plan.profileSha256, "hex"),
  ]), { flag: "wx" });
  const cleanupInputs = [0, 2, 1000].map(count => {
    const exchange = { schemaVersion: REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA, challenge: "cc".repeat(32), history,
      expectations: Array.from({ length: count }, (_, index) => ({ nonce: (index + 1).toString(16).padStart(64, "0"), requestSha256: "aa".repeat(32),
        checkpointSha256: installation.checkpointSha256, runtimeBundleSha256: "dd".repeat(32), maxInputBytes: index % 100,
        maxOutputBytes: 100000 + index, maxInventoryEntries: 20000 - index })) };
    const encoded = encodeRemoteWorkerRuntimeCleanup(exchange);
    assert.equal(encoded.setSha256, createHash("sha256").update("goatcitadel.worker-runtime-cleanup.v1\0").update(Buffer.from(encoded.bytesHex, "hex")).digest("hex"));
    const input = path.join(output, `cleanup-${count}.bin`);
    fs.writeFileSync(input, Buffer.from(encoded.challenge + encoded.setSha256 + encoded.bytesHex, "hex"), { flag: "wx" });
    return { count, input, exchange };
  });
  const admissionInputs = [false, true].map(installed => {
    const input = path.join(output, installed ? "cleanup-admission-install.bin" : "cleanup-admission-empty.bin");
    const value = encodeWindowsAssignmentCleanupAdmission({ challenge: "cc".repeat(32), setSha256: "dd".repeat(32),
      installations: installed ? [{ nonce: installation.nonce, requestSha256: remoteWorkerRuntimeInstallRequestSha256(installation),
        requestHex: Buffer.from(encodeRemoteWorkerRuntimeInstallRequest(installation)).toString("hex") }] : [] });
    fs.writeFileSync(input, value, { flag: "wx" }); return input;
  });
  for (const asan of [false, true]) {
    const executable = buildWindowsCellController({ outputDirectory: output, snapshot, sourceBatchSize: 8, asan, fixture });
    const admissions = admissionInputs.map((input, index) => {
      const run = spawnSync(executable, ["--cleanup-admission", input], { windowsHide: true, encoding: "utf8", timeout: 10000, env });
      fs.writeFileSync(path.join(output, `${asan ? "asan" : "normal"}-admission-${index}.log`), (run.stdout ?? "") + (run.stderr ?? ""), { flag: "wx" });
      assert.equal(run.error, undefined); assert.equal(run.status, 0, run.stderr);
      const report = JSON.parse(run.stdout); assert.equal(report.passed, true); assert.equal(report.bytes, index ? 416 : 80); return report;
    });
    const run = spawnSync(executable, [path.join(output, asan ? "asan-data" : "normal-data")], { windowsHide: true, encoding: "utf8", timeout: 40000, env });
    fs.writeFileSync(path.join(output, asan ? "asan.log" : "normal.log"), (run.stdout ?? "") + (run.stderr ?? ""), { flag: "wx" });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, `Local outcome evidence: ${output}\n${run.stdout}${run.stderr}`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.passed, true); assert.ok(report.checks >= 60);
    assert.equal(report.installedService, false); assert.equal(report.volumeAttached, false); assert.equal(report.workloadsRun, 0);
    const installationRun = spawnSync(executable, ["--installation-exchange", path.join(output, asan ? "asan-installation" : "normal-installation"), installationInput],
      { windowsHide: true, encoding: "utf8", timeout: 40000, env });
    fs.writeFileSync(path.join(output, asan ? "asan-installation.log" : "normal-installation.log"),
      (installationRun.stdout ?? "") + (installationRun.stderr ?? ""), { flag: "wx" });
    assert.equal(installationRun.error, undefined); assert.equal(installationRun.status, 0, installationRun.stderr);
    const nativeInstallation = JSON.parse(installationRun.stdout);
    assert.equal(nativeInstallation.installedService, false); assert.equal(nativeInstallation.volumeAttached, false); assert.equal(nativeInstallation.workloadsRun, 0);
    const decoded = readRemoteWorkerRuntimeInstallOutcome(nativeInstallation.installationHex, installation, history);
    assert.equal(decoded.installation.verified, true); assert.equal(decoded.installation.bytesWritten, 120);
    assert.equal(decoded.installation.filesCreated, 2);
    assert.equal(readRemoteWorkerRuntimeInstallOutcome(nativeInstallation.installationHex.slice(0, 512), installation, history).installation, null);
    assert.throws(() => readRemoteWorkerRuntimeInstallOutcome(nativeInstallation.installationHex, { ...installation, packageSha256: "88".repeat(32) }, history));
    const cleanup = cleanupInputs.map(({ count, input }) => {
      const checked = spawnSync(executable, ["--cleanup-exchange", path.join(output, `${asan ? "asan" : "normal"}-cleanup-${count}`), input],
        { windowsHide: true, encoding: "utf8", timeout: 40000, env });
      fs.writeFileSync(path.join(output, `${asan ? "asan" : "normal"}-cleanup-${count}.log`), (checked.stdout ?? "") + (checked.stderr ?? ""), { flag: "wx" });
      assert.equal(checked.error, undefined); assert.equal(checked.status, 0, checked.stderr);
      const result = JSON.parse(checked.stdout); assert.equal(result.passed, true); assert.equal(result.expectations, count); return result;
    });
    const parent = [];
    for (const item of cleanupInputs) parent.push(await cleanupParent(executable, item, env, output, `${asan ? "asan" : "normal"}-parent-${item.count}`));
    parent.push(await cleanupParent(executable, cleanupInputs[1], env, output, `${asan ? "asan" : "normal"}-parent-mismatch`, true));
    outcomes.push({ asan, ...report, admissions, installation: decoded, installationChecks: nativeInstallation.checks, cleanup, parent });
  }
  const repository = path.resolve(import.meta.dirname, "../..");
  for (const item of snapshot.sourceManifest) assert.equal(createHash("sha256").update(fs.readFileSync(path.join(repository, item.name))).digest("hex"), item.sha256,
    `Source changed during proof: ${item.name}`);
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ sourceManifest: snapshot.sourceManifest, outcomes,
    boundary: "Actual exclusive files in protected temporary NTFS host directories prove flushed attempt/outcome readback, no nonce replay, corruption refusal, host-custody loss, diagnostic-only outcomes and raw-output exclusion. Admission/journal metadata is controlled through a private test port. The production entry refuses an absent journal. No actual mounted journal, installed listener, physical drive operation, workload or live Gateway acceptance is claimed."
  }, null, 2), { flag: "wx" });
});

test("terminal runtime results retain complete inventory and refuse partial delivery", { skip: process.platform !== "win32" }, () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Runtime Result "));
  console.log(`Retained runtime result evidence: ${output}`);
  const fixture = "apps/remote-worker-windows-cell-native/tests/cell_runtime_result_test.cpp";
  const snapshot = snapshotCellControllerSources(output, [fixture]);
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  const env = { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" };
  const outcomes = [];
  for (const asan of [false, true]) {
    const executable = buildWindowsCellController({ outputDirectory: output, snapshot, sourceBatchSize: 8, asan, fixture });
    const run = spawnSync(executable, [], { windowsHide: true, encoding: "utf8", timeout: 40000, env });
    fs.writeFileSync(path.join(output, asan ? "asan.log" : "normal.log"), (run.stdout ?? "") + (run.stderr ?? ""), { flag: "wx" });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, `Runtime result evidence: ${output}\n${run.stdout}${run.stderr}`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.passed, true); assert.ok(report.checks >= 60);
    assert.equal(report.pipeFixtures, 54); assert.equal(report.maximumInventoryEntries, 20000);
    assert.equal(report.installedService, false); assert.equal(report.volumeAttached, false);
    outcomes.push({ asan, ...report });
  }
  const repository = path.resolve(import.meta.dirname, "../..");
  for (const item of snapshot.sourceManifest) assert.equal(createHash("sha256").update(fs.readFileSync(path.join(repository, item.name))).digest("hex"), item.sha256,
    `Source changed during proof: ${item.name}`);
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ sourceManifest: snapshot.sourceManifest, outcomes,
    boundary: "Real private local pipes transport the complete declared 20000-object inventory, with controlled execution metadata, canonical authority and a retention committer. A distinct exact digest acknowledges retention; changed results, forged retention receipts and late commits are refused without replay. Malformed, partial, revoked, expired, reentrant and substituted results are withheld. This does not prove real durable Gateway retention, actual mounted inventory collection, installed dispatch or live workload admission. No service or volume operation occurs.",
  }, null, 2), { flag: "wx" });
});
