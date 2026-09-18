import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { snapshotCellControllerSources, buildWindowsCellController } from "./build-remote-worker-windows-cell-controller.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";
import { readRemoteWorkerCellProvisioningCheckpoint, normalizeRemoteWorkerCellProvisioningExchange,
  remoteWorkerCellProvisioningPlanSha256, REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION } from "../../packages/contracts/dist/remote-worker-cell-provisioning.js";
import { readRemoteWorkerNativeCapacityLayout } from "../../packages/contracts/dist/remote-worker-native-capacity-layout.js";
import { readRemoteWorkerNativeCapacityCapture } from "../../packages/contracts/dist/remote-worker-native-capacity-capture.js";
import { composeRemoteWorkerNativeCapacityInventory } from "../../packages/contracts/dist/remote-worker-native-capacity-composition.js";
import { composeRemoteWorkerNativePoolCapacityInventory } from "../../packages/contracts/dist/remote-worker-native-pool-capacity-composition.js";
import { readRemoteWorkerNativePoolCapacityResponse } from "../../packages/contracts/dist/remote-worker-native-pool-capacity-response.js";
import { remoteWorkerCellCanonicalSha256 } from "../../packages/contracts/dist/remote-worker-cell.js";
import { accountRemoteWorkerCellCapacityInventory, remoteWorkerCellCapacityInventorySha256 } from "../../packages/contracts/dist/remote-worker-cell-capacity-inventory.js";
import { objectInventoryHistoryFixture, objectInventoryFixture } from "../../packages/contracts/dist/remote-worker-cell-object-inventory-test-fixture.js";
import { backingCapacityObservationFixture } from "../../packages/contracts/dist/remote-worker-cell-backing-capacity-test-fixture.js";
import { encodeWindowsWorkerPoolHistory } from "../../apps/remote-worker/dist/worker-windows-pool-history.js";

const repository = path.resolve(import.meta.dirname, "../..");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const consumerSnapshot = () => ["src", "dist"].flatMap(kind => {
  const directory = path.join(repository, "packages/contracts", kind);
  return fs.readdirSync(directory, { recursive: true }).filter(name => name.endsWith(kind === "src" ? ".ts" : ".js"))
    .sort().map(name => ({ name: `packages/contracts/${kind}/${name}`, sha256: sha256(fs.readFileSync(path.join(directory, name))) }));
}).concat(["src", "dist"].flatMap(kind => ["worker-windows-pool-history", "connected-worker-routes"].map(name => {
  const file = `apps/remote-worker/${kind}/${name}.${kind === "src" ? "ts" : "js"}`;
  return { name: file, sha256: sha256(fs.readFileSync(path.join(repository, file))) };
})));

function writePoolFixture(directory, count) {
  fs.mkdirSync(directory);
  const histories = Array.from({ length: count }, (_, seed) => objectInventoryHistoryFixture(seed))
    .sort((a, b) => a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : 0);
  const members = histories.map(({ schemaVersion, registryWorkspaceId, assignmentId, assignmentGeneration, leaseRevision, ...history }) => ({
    assignmentId, assignmentGeneration, workerGeneration: 1, cellId: `cell-${assignmentId}`, profileSha256: history.plan.profileSha256, history,
  }));
  const current = histories[0];
  const pool = { schemaVersion: "goatcitadel.remote-worker-native-pool.v1", registryWorkspaceId: current.registryWorkspaceId,
    assignmentId: current.assignmentId, assignmentGeneration: current.assignmentGeneration, leaseRevision: current.leaseRevision,
    workerId: "fixture-worker", workerGeneration: 1, members, membershipSha256: remoteWorkerCellCanonicalSha256(members) };
  fs.writeFileSync(path.join(directory, "pool.bin"), encodeWindowsWorkerPoolHistory(pool, current, 20, 10000), { flag: "wx" });
  histories.forEach((history, index) => {
    const guest = objectInventoryFixture(history);
    fs.writeFileSync(path.join(directory, `guest-${index}.bin`), guest.summary, { flag: "wx" });
    fs.writeFileSync(path.join(directory, `chunks-${index}.bin`), Buffer.concat(guest.chunks), { flag: "wx" });
    fs.writeFileSync(path.join(directory, `backing-${index}.bin`), backingCapacityObservationFixture(history), { flag: "wx" });
  });
  return pool;
}

function verifyPoolOutput(directory, pool) {
  const read = name => fs.readFileSync(path.join(directory, `output-${name}.bin`));
  const layout = readRemoteWorkerNativeCapacityLayout(read("layout").toString("hex"));
  const poolSnapshotSha256 = remoteWorkerCellCanonicalSha256(pool);
  assert.equal(read("pool-sha256").toString("hex"), poolSnapshotSha256);
  const source = { hostCaptureHex: read("host").toString("hex"), references: [], members: pool.members.map((_, index) => {
    const chunks = read(`chunks-${index}`); assert.equal(chunks.length % 1000, 0);
    for (const name of ["guest", "backing", "chunks"])
      assert.deepEqual(read(`${name}-${index}`), fs.readFileSync(path.join(directory, `${name}-${index}.bin`)), "Native output must preserve the independent member fixture bytes.");
    return { guestObservationHex: read(`guest-${index}`).toString("hex"), backingObservationHex: read(`backing-${index}`).toString("hex"),
      guestChunkHex: Array.from({ length: chunks.length / 1000 }, (_, i) => chunks.subarray(i * 1000, (i + 1) * 1000).toString("hex")) };
  }) };
  // Codec proof only: the fixture retains these bytes after native encoding.
  // Installed capture authority must come from the protected quiescence owner.
  const nonce = "44".repeat(32), host = readRemoteWorkerNativeCapacityCapture(source.hostCaptureHex, nonce, layout);
  const window = Object.freeze({ nonce, connectionNonceHex: "71".repeat(32), poolSnapshotSha256,
    hostCaptureSha256: host.captureSha256, membersSha256: remoteWorkerCellCanonicalSha256(source.members),
    referencesSha256: remoteWorkerCellCanonicalSha256(source.references) });
  const delivery = readRemoteWorkerNativePoolCapacityResponse(read("response").toString("hex"), pool, layout, window, source.references);
  assert.deepEqual(delivery.source, source, "Bounded native response retains every independently emitted frame.");
  const inventory = delivery.inventory;
  const accounting = accountRemoteWorkerCellCapacityInventory(inventory, { profileSha256: inventory.profileSha256,
    captureSha256: inventory.captureSha256, inventorySha256: remoteWorkerCellCapacityInventorySha256(inventory) });
  const count = pool.members.length;
  const expectedHost = pool.members.reduce((sum, _, index) => {
    const backing = fs.readFileSync(path.join(directory, `backing-${index}.bin`));
    return sum + Number(backing.readBigUInt64LE(392) + backing.readBigUInt64LE(408)) + 4 * 4096;
  }, 13 * 4096);
  assert.equal(accounting.hostAllocatedBytes, expectedHost);
  assert.equal(accounting.guestAllocatedBytes, count * 22 * 4096);
  assert.equal(accounting.hostFileCount, count * 2); assert.equal(accounting.hostDirectoryCount, 13 + count * 4);
  assert.equal(accounting.guestFileCount, count * 22); assert.equal(accounting.guestDirectoryCount, count * 4);
  assert.equal(inventory.areas.flatMap(area => area.objects).filter(object => object.kind === "volume_backing").length, count);
  // Rehash the swapped source as well, so refusal must check member history,
  // not merely notice a stale digest.
  const swapped = { ...source, members: [source.members[1], source.members[0], ...source.members.slice(2)] };
  assert.throws(() => composeRemoteWorkerNativePoolCapacityInventory(swapped, pool, layout,
    { ...window, membersSha256: remoteWorkerCellCanonicalSha256(swapped.members) }));
  fs.writeFileSync(path.join(directory, "portable-acceptance.json"), JSON.stringify({ members: count, accounting, captureWindow: window,
    physicalVolumeScanned: false, canonicalAdmission: false, responseTransport: false }, null, 2), { flag: "wx" });
  return accounting;
}

test("joined native frames reach portable accounting without counting guest allocation twice", {
  skip: process.platform !== "win32", timeout: 480000,
}, () => {
  assert.equal(process.env.GOATCITADEL_NATIVE_VHD_ATTACHMENT_PROOF, undefined);
  const space = fs.statfsSync(os.tmpdir(), { bigint: true });
  assert.ok(space.bavail * space.bsize >= 4n * 1024n ** 3n, "Native evidence needs 4 GiB free temporary space.");
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Joined Capacity Wire "));
  console.log(`Retained joined capacity wire evidence: ${output}`);
  const fixture = "apps/remote-worker-windows-cell-native/tests/cell_controller_protocol_test.cpp";
  const helpers = ["cell_virtual_disk_layout", "cell_ntfs_format", "cell_volume_protection", "cell_volume_mount", "cell_mounted_workspace"]
    .map(name => `apps/remote-worker-windows-cell-native/tests/${name}_test.cpp`);
  const clients = ["cpp", "hpp"].map(extension => `apps/remote-worker-windows-cell-native/src/cell_controller_client_protocol.${extension}`);
  const snapshot = snapshotCellControllerSources(output, [fixture, ...helpers, ...clients]);
  const consumers = consumerSnapshot();
  fs.writeFileSync(path.join(output, "sources.json"), JSON.stringify({ native: snapshot.sourceManifest, consumers }, null, 2), { flag: "wx" });
  const env = { SystemRoot: process.env.SystemRoot, PATH: path.dirname(resolveExactWindowsToolchain("windows-x64").compilerPath),
    ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" };
  for (const asan of [false, true]) {
    const mode = asan ? "asan" : "normal", data = path.join(output, `${mode}-data`);
    const executable = buildWindowsCellController({ outputDirectory: output, snapshot, asan, fixture, sourceBatchSize: 8,
      extraSources: [...helpers, clients[0]] });
    for (const count of [2, 64]) {
      const poolDirectory = path.join(output, `${mode}-pool-${count}`), pool = writePoolFixture(poolDirectory, count);
      // Twelve admission scenarios each retain their own 10-second native
      // deadline, in addition to the existing bounded response-stream cases.
      const poolRun = spawnSync(executable, ["--pool-output", poolDirectory], { windowsHide: true, encoding: "utf8", timeout: 120000, env });
      fs.writeFileSync(path.join(output, `${mode}-pool-${count}.log`), `${poolRun.stdout ?? ""}${poolRun.stderr ?? ""}`, { flag: "wx" });
      assert.equal(poolRun.error, undefined); assert.equal(poolRun.status, 0, `Multi-member native output: ${poolRun.stdout}${poolRun.stderr}`);
      const proof = JSON.parse(poolRun.stdout); assert.equal(proof.members, count); assert.equal(proof.passed, true);
      assert.equal(proof.physicalVolumeScanned, false);
      const accounting = verifyPoolOutput(poolDirectory, pool);
      console.log(JSON.stringify({ mode, poolMembers: count, checks: proof.checks, hostAllocatedBytes: accounting.hostAllocatedBytes,
        guestAllocatedBytes: accounting.guestAllocatedBytes, physicalVolumeScanned: false }));
    }
    const run = spawnSync(executable, ["--inventory", data], { windowsHide: true, encoding: "utf8", timeout: 40000, env });
    fs.writeFileSync(path.join(output, `${mode}.log`), `${run.stdout ?? ""}${run.stderr ?? ""}`, { flag: "wx" });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, `Native joined capture evidence: ${output}\n${run.stdout}${run.stderr}`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.passed, true); assert.ok(report.checks >= 100);
    assert.equal(report.sessions, 50); assert.equal(report.nativeClientSessions, 50);
    for (const key of ["installedService", "canonicalStorage", "volumeAttached", "ntfsFormatted", "volumeRootProtected", "volumeMounted"])
      assert.equal(report[key], false);
    const read = name => fs.readFileSync(path.join(data, `joined-${name}.bin`));
    const retained = read("history"); assert.equal(retained.length, 21 * 1024);
    const records = Array.from({ length: 21 }, (_, i) => retained.subarray(i * 1024, (i + 1) * 1024).toString("hex"));
    const plan = readRemoteWorkerCellProvisioningCheckpoint(records[0]).plan;
    const history = normalizeRemoteWorkerCellProvisioningExchange({
      schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
      registryWorkspaceId: "native-joined-wire", assignmentId: "native-joined-wire", assignmentGeneration: 1, leaseRevision: 1,
      plan, planSha256: remoteWorkerCellProvisioningPlanSha256(plan), records: records.slice(0, 5),
      volumeRecords: records.slice(5, 11), formatRecords: records.slice(11, 13), protectionRecords: records.slice(13, 15),
      mountRecords: records.slice(15, 19), mountedWorkspaceRecords: records.slice(19),
    });
    const layout = readRemoteWorkerNativeCapacityLayout(read("layout").toString("hex"));
    const chunks = read("chunks"); assert.equal(chunks.length, 2000);
    const source = { hostCaptureHex: read("host").toString("hex"), guestObservationHex: read("guest").toString("hex"),
      guestChunkHex: [chunks.subarray(0, 1000).toString("hex"), chunks.subarray(1000).toString("hex")],
      backingObservationHex: read("backing").toString("hex"), references: [] };
    const nonce = "44".repeat(32), host = readRemoteWorkerNativeCapacityCapture(source.hostCaptureHex, nonce, layout);
    // A codec fixture freezes expected digests here. In production only the
    // independently authorized quiescence owner can retain this capture window.
    const window = Object.freeze({ nonce, hostCaptureSha256: host.captureSha256,
      guestObservationSha256: remoteWorkerCellCanonicalSha256({ schemaVersion: "goatcitadel.native-capacity-guest-source.v1",
        observationHex: source.guestObservationHex, chunkHex: source.guestChunkHex }),
      backingObservationSha256: remoteWorkerCellCanonicalSha256({ schemaVersion: "goatcitadel.native-capacity-backing-source.v1",
        observationHex: source.backingObservationHex }), referencesSha256: remoteWorkerCellCanonicalSha256([]) });
    assert.equal(source.guestObservationHex.slice(0, 64), "11".repeat(32));
    assert.equal(source.backingObservationHex.slice(0, 64), "11".repeat(32));
    const inventory = composeRemoteWorkerNativeCapacityInventory(source, history, layout, window);
    const accounting = accountRemoteWorkerCellCapacityInventory(inventory, { profileSha256: plan.profileSha256,
      captureSha256: inventory.captureSha256, inventorySha256: remoteWorkerCellCapacityInventorySha256(inventory) });
    assert.equal(accounting.hostAllocatedBytes, plan.virtualDiskBytes + 2 * 1024 * 1024 + 24576 + 17 * 4096);
    assert.equal(accounting.guestAllocatedBytes, 22 * 4096);
    assert.equal(accounting.hostFileCount, 2); assert.equal(accounting.hostDirectoryCount, 17);
    assert.equal(accounting.guestFileCount, 22); assert.equal(accounting.guestDirectoryCount, 4);
    assert.equal(accounting.logicalReferenceCount, 0);
    assert.equal(inventory.areas.flatMap(area => area.objects).filter(object => object.kind === "volume_backing").length, 1);
    for (const key of ["hostCaptureHex", "guestObservationHex", "backingObservationHex", "guestChunkHex"]) {
      const changed = structuredClone(source);
      const flip = hex => `${hex.slice(0, -2)}${hex.endsWith("ff") ? "00" : "ff"}`;
      if (key === "guestChunkHex") changed[key][1] = flip(changed[key][1]); else changed[key] = flip(changed[key]);
      assert.throws(() => composeRemoteWorkerNativeCapacityInventory(changed, history, layout, window));
    }
    assert.deepEqual(consumerSnapshot(), consumers, "Portable sources and emitted code must remain unchanged during native proof.");
    for (const input of snapshot.sourceManifest)
      assert.equal(sha256(fs.readFileSync(path.join(repository, input.name))), input.sha256, `Native source changed: ${input.name}`);
    fs.writeFileSync(path.join(output, `${mode}-acceptance.json`), JSON.stringify({ executableSha256: sha256(fs.readFileSync(executable)),
      report, accounting, captureWindow: window, physicalVolumeScanned: false, canonicalAdmission: false }, null, 2), { flag: "wx" });
    console.log(JSON.stringify({ mode, checks: report.checks, hostAllocatedBytes: accounting.hostAllocatedBytes,
      guestAllocatedBytes: accounting.guestAllocatedBytes, physicalVolumeScanned: false }));
  }
});
