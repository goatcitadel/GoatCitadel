import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { compileTlsNative } from "./build-remote-worker-windows-tls.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";
import { WORKER_CELL_SOURCE_FILES, WORKER_CELL_FIXTURE_SOURCES, WORKER_CELL_CONTROLLER_SOURCES } from "./lib/remote-worker-cell-build-inputs.mjs";
import { stageWorkerCellAcceptance, verifyWorkerCellAcceptance } from "./lib/remote-worker-cell-acceptance-files.mjs";
import { verifyCellProtectionJournalReceipt } from "./lib/remote-worker-cell-protection-record-proof.mjs";
import { verifyCellMountJournalReceipt } from "./lib/remote-worker-cell-mount-record-proof.mjs";
import { verifyCellMountedWorkspaceJournalReceipt } from "./lib/remote-worker-cell-mounted-workspace-record-proof.mjs";

const source = path.resolve(import.meta.dirname, "../../apps/remote-worker-windows-cell-native");
const attachmentProof = process.env.GOATCITADEL_NATIVE_VHD_ATTACHMENT_PROOF === "1";
const packageRoot = process.env.GOATCITADEL_NATIVE_CELL_PACKAGE_ROOT;
const packageHash = process.env.GOATCITADEL_NATIVE_CELL_PACKAGE_SHA256;
if ((packageRoot !== undefined) !== (packageHash !== undefined)) throw new Error("Native cell package root and hash must be supplied together.");
const packageReference = packageRoot === undefined ? undefined : { root: packageRoot, expectedManifestSha256: packageHash };
if (process.env.GOATCITADEL_NATIVE_VHD_ATTACHMENT_PROOF !== undefined && !attachmentProof) {
  throw new Error("GOATCITADEL_NATIVE_VHD_ATTACHMENT_PROOF must be exactly 1 when supplied.");
}
function run(executable, args, env = {}, minimumChecks = 222, timeoutMs = 40000) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    env: { SystemRoot: process.env.SystemRoot, ...env },
  });
  assert.equal(result.error, undefined, `${String(result.error)}\n${result.stderr}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const receipt = JSON.parse(result.stdout.trim());
  assert.ok(receipt.checks >= minimumChecks, "Native resource and AppContainer checks must execute.");
  if ((args.length === 1 && !args[0].startsWith("--")) || args[0] === "--volume-attachment") {
    verifyCompleteReceipt(receipt, args);
  }
  return receipt;
}
function verifyCompleteReceipt(receipt, args) {
    assert.ok(receipt.filesystemChecks >= 41, "Actual NTFS launch-file cases must execute.");
    assert.ok(receipt.runtimeDispatchChecks >= 980, "Exact workload binding, protected configuration and independent admission must be checked before dispatch.");
    assert.ok(receipt.quiescentCaptureChecks >= 87, "Capture and borrowed journal binding must use the held empty job, exact cell/directory and current authority, with failure withholding.");
    assert.ok(receipt.executionAuthorityChecks >= 35, "Authority must be checked before creation/resume and during execution, with exact-job cleanup on revocation.");
    assert.ok(receipt.inputChecks >= 40, "Bounded input, duplex pressure and pending-write cancellation must execute.");
    assert.ok(
      receipt.stdioChecks >= 57,
      "Interactive native exchanges, bounded queues, cancellation and one-shot channel ownership must execute.",
    );
    assert.ok(
      receipt.workspaceChecks >= 120,
      "Actual parent custody, protected-root and AppContainer work cases must execute.",
    );
    assert.ok(
      receipt.virtualDiskChecks >= 108,
      "Actual fixed VHDX creation, recorded reopening, identity substitution and custody refusal cases must execute.",
    );
    assert.equal(receipt.virtualDiskRecoveryProcessVerified, true, "A fresh process must verify the recorded disk and workspace.");
    assert.ok(receipt.provisioningJournalChecks >= 244, "Protected journal persistence, allocated bytes, actual creation conflicts and corruption refusal must execute.");
    assert.equal(receipt.provisioningRecoveryProcessVerified, true, "A fresh process must recover actual resources from the persisted journal.");
    assert.ok(Array.isArray(receipt.provisioningCheckpointRecords));
    assert.equal(receipt.provisioningCheckpointRecords.length, 5, "Actual canonical acknowledgement fixtures must retain all five records.");
    let previousCheckpointHash = "0".repeat(64);
    for (const [index, recordHex] of receipt.provisioningCheckpointRecords.entries()) {
      assert.match(recordHex, /^[0-9a-f]{2048}$/u);
      const record = Buffer.from(recordHex, "hex");
      assert.equal(record.subarray(0, 8).toString("ascii"), "GCCELLP1");
      assert.equal(record.readUInt32LE(8), index + 1);
      assert.equal(record.readUInt32LE(12), index + 1);
      assert.equal(record.subarray(16, 48).toString("hex"), previousCheckpointHash);
      previousCheckpointHash = createHash("sha256").update(record.subarray(0, 992)).digest("hex");
      assert.equal(record.subarray(992).toString("hex"), previousCheckpointHash);
    }
    assert.ok(receipt.volumeAttachmentChecks >= 24, "Attachment and recorded-recovery authority rejection checks must execute.");
    assert.equal(receipt.volumeAttachmentExercised, args[0] === "--volume-attachment");
    assert.equal(receipt.volumeAttachmentRecoveryVerified, receipt.volumeAttachmentExercised);
    assert.equal(receipt.volumeDeviceBindingVerified, receipt.volumeAttachmentExercised);
    assert.ok(receipt.volumeDeviceMetadataChecks >= 60, "Bounded device-dependency decoding and unadmitted device refusal must execute.");
    assert.ok(receipt.volumeLayoutComponentChecks >= 150, "GPT sequencing, lost acknowledgements, authority loss and readback rejection must execute.");
    assert.ok(receipt.volumeBindingComponentChecks >= 300, "Exact volume selection, identity drift and ambiguous names must be checked.");
    assert.equal(receipt.volumeBindingExercised, false, "Component volume identity proof does not claim physical binding.");
    assert.ok(receipt.ntfsFormatComponentChecks >= 1100, "Formatting authority, intent, readback and uncertain outcomes must be checked.");
    assert.equal(receipt.ntfsFormatExercised, false, "Component formatting proof does not claim a physical filesystem write.");
    const recordedDisk = Buffer.from(receipt.provisioningCheckpointRecords[4], "hex");
    const derivedIds = [1, 2].map((role) => {
      const guid = createHash("sha256").update(Buffer.from("goatcitadel.native-cell-gpt.v1\0", "ascii"))
        .update(recordedDisk.subarray(48, 112)).update(recordedDisk.subarray(112, 128)).update(Buffer.from([role]))
        .digest().subarray(0, 16);
      guid[7] = (guid[7] & 0x0f) | 0x80;
      guid[8] = (guid[8] & 0x3f) | 0x80;
      return guid.toString("hex");
    }).join("");
    assert.equal(receipt.provisioningDiskLayoutIdsHex, derivedIds,
      "Native journal GPT identifiers derive only from the exact recorded assignment/profile/VHDX identity.");
    assert.equal(receipt.volumeProvisioningCoreRecords.length, 5);
    assert.equal(receipt.volumeProvisioningRecords.length, 6);
    let volumeBaseHash = "0".repeat(64);
    for (const [index, hex] of receipt.volumeProvisioningCoreRecords.entries()) {
      const record = Buffer.from(hex, "hex");
      assert.equal(record.length, 1024);
      assert.equal(record.subarray(0, 8).toString("ascii"), "GCCELLP1");
      assert.equal(record.readUInt32LE(8), index + 1);
      assert.equal(record.subarray(16, 48).toString("hex"), volumeBaseHash);
      volumeBaseHash = createHash("sha256").update(record.subarray(0, 992)).digest("hex");
      assert.equal(record.subarray(992).toString("hex"), volumeBaseHash);
    }
    const volumeBase = Buffer.from(receipt.volumeProvisioningCoreRecords[4], "hex");
    let volumePrevious = volumeBaseHash, nestedPrevious = "0".repeat(64);
    for (const [index, hex] of receipt.volumeProvisioningRecords.entries()) {
      const record = Buffer.from(hex, "hex");
      assert.equal(record.length, 1024);
      assert.equal(record.subarray(0, 8).toString("ascii"), "GCCVOL01");
      assert.equal(record.readUInt32LE(8), index + 1);
      assert.equal(record.readUInt32LE(12), index + 1);
      assert.equal(record.subarray(16, 48).toString("hex"), volumePrevious);
      assert.deepEqual(record.subarray(48, 144), volumeBase.subarray(48, 144));
      assert.deepEqual(record.subarray(144, 168), volumeBase.subarray(168, 192));
      assert.deepEqual(record.subarray(168, 192), volumeBase.subarray(624, 648));
      assert.deepEqual(record.subarray(192, 216), volumeBase.subarray(696, 720));
      assert.equal(record.subarray(216, 248).toString("hex"), volumeBaseHash);
      assert.ok(record.subarray(792, 992).every((byte) => byte === 0));
      if (index < 2) assert.ok(record.subarray(280, 792).every((byte) => byte === 0));
      else {
        const nested = record.subarray(280, 792);
        assert.equal(nested.subarray(0, 8).toString("ascii"), "GCCGPT01");
        assert.equal(nested.readUInt32LE(8), index - 1);
        assert.equal(nested.subarray(16, 48).toString("hex"), nestedPrevious);
        nestedPrevious = createHash("sha256").update(nested.subarray(0, 480)).digest("hex");
        assert.equal(nested.subarray(480).toString("hex"), nestedPrevious);
      }
      volumePrevious = createHash("sha256").update(record.subarray(0, 992)).digest("hex");
      assert.equal(record.subarray(992).toString("hex"), volumePrevious);
    }
    assert.equal(receipt.formatProvisioningHistory.length, 13);
    verifyCellProtectionJournalReceipt(receipt);
    verifyCellMountJournalReceipt(receipt);
    const formatHistory = receipt.formatProvisioningHistory.map((hex) => {
      assert.match(hex, /^[0-9a-f]{2048}$/u);
      return Buffer.from(hex, "hex");
    });
    let formatPrevious = Buffer.alloc(32);
    for (const [index, record] of formatHistory.entries()) {
      assert.equal(record.subarray(0, 8).toString("ascii"), index < 5 ? "GCCELLP1" : index < 11 ? "GCCVOL01" : "GCCFMT01");
      const phase = index < 5 ? index + 1 : index < 11 ? index - 4 : index - 10;
      assert.equal(record.readUInt32LE(8), phase); assert.equal(record.readUInt32LE(12), phase);
      assert.deepEqual(record.subarray(16, 48), formatPrevious);
      formatPrevious = createHash("sha256").update(record.subarray(0, 992)).digest();
      assert.deepEqual(record.subarray(992), formatPrevious);
    }
    const recordedVolume = formatHistory[10], recordedLayout = recordedVolume.subarray(280, 792);
    const formatBase = recordedVolume.subarray(992);
    let previousOuter = formatBase, previousNested = Buffer.alloc(32);
    for (const [index, record] of formatHistory.slice(11).entries()) {
      const nested = Buffer.alloc(512);
      nested.write("GCCNTF01", 0, "ascii"); nested.writeUInt32LE(index + 1, 8); previousNested.copy(nested, 16);
      recordedLayout.subarray(480).copy(nested, 48);
      Buffer.from("78563412bc9aef4d8123456789abcdef", "hex").copy(nested, 80);
      const partitionBytes = recordedLayout.readBigUInt64LE(300);
      nested.writeBigUInt64LE(partitionBytes, 96);
      nested.writeUInt32LE(512, 104); nested.writeUInt32LE(4096, 108); nested.write("GoatCitadel cell", 112, "utf16le");
      if (index === 1) {
        const sectors = partitionBytes / 512n - 1n;
        nested.writeBigUInt64LE(0xfedcba9876543210n, 184); nested.writeBigUInt64LE(sectors, 192); nested.writeBigUInt64LE(sectors / 8n, 200);
      }
      previousNested = createHash("sha256").update(nested.subarray(0, 480)).digest(); previousNested.copy(nested, 480);
      const expected = Buffer.alloc(1024);
      expected.write("GCCFMT01", 0, "ascii"); expected.writeUInt32LE(index + 1, 8); expected.writeUInt32LE(index + 1, 12);
      previousOuter.copy(expected, 16); recordedVolume.subarray(48, 216).copy(expected, 48); formatBase.copy(expected, 216);
      recordedVolume.subarray(248, 280).copy(expected, 248); nested.copy(expected, 280);
      previousOuter = createHash("sha256").update(expected.subarray(0, 992)).digest(); previousOuter.copy(expected, 992);
      assert.deepEqual(record, expected, "Native format journal must match independently constructed bound intent/completion records.");
    }
    assert.equal(receipt.volumeLayoutExercised, false, "Component sequencing does not claim actual disk initialization or partitioning.");
    assert.equal(receipt.volumeLayoutCheckpointRecords.length, 4);
    let previousLayoutHash = "0".repeat(64);
    let layoutPlan;
    let initializedLayout;
    for (const [index, recordHex] of receipt.volumeLayoutCheckpointRecords.entries()) {
      assert.match(recordHex, /^[0-9a-f]{1024}$/u);
      const record = Buffer.from(recordHex, "hex");
      assert.equal(record.subarray(0, 8).toString("ascii"), "GCCGPT01");
      assert.equal(record.readUInt32LE(8), index + 1);
      assert.equal(record.readUInt32LE(12), 0);
      assert.equal(record.subarray(16, 48).toString("hex"), previousLayoutHash);
      const currentPlan = record.subarray(48, 160).toString("hex");
      if (index === 0) layoutPlan = currentPlan;
      assert.equal(currentPlan, layoutPlan, "Frozen backing/GPT/data identities remain identical across every checkpoint.");
      assert.equal(record.readBigUInt64LE(64), 256n * 1024n * 1024n);
      assert.equal(record.readBigUInt64LE(72), 384n * 1024n * 1024n);
      if (index === 0) {
        assert.ok(record.subarray(160, 388).every((value) => value === 0), "Initialization intent cannot claim observed partitions.");
      } else {
        if (index === 1) initializedLayout = record.subarray(160, 388).toString("hex");
        assert.equal(record.subarray(160, 388).toString("hex"), initializedLayout);
        assert.equal(record.readBigUInt64LE(160), 17408n);
        assert.equal(record.readUInt32LE(176), 128);
        assert.equal(record.readBigUInt64LE(292), 17n * 1024n * 1024n);
        assert.equal(record.readBigUInt64LE(300), 238n * 1024n * 1024n);
        assert.equal(record.readBigUInt64LE(308), 0x8000000000000000n);
      }
      assert.equal(record.readUInt32LE(388), 512);
      assert.ok(record.subarray(392, 480).every((value) => value === 0));
      previousLayoutHash = createHash("sha256").update(record.subarray(0, 480)).digest("hex");
      assert.equal(record.subarray(480).toString("hex"), previousLayoutHash);
    }
    if (receipt.volumeAttachmentExercised) {
      assert.ok(
        receipt.volumeAttachmentChecks >= 43,
        "Actual attachment, recorded recovery, SDK identity and exact recovered detach checks must execute.",
      );
    }
    assert.ok(
      receipt.runtimeBundleChecks >= 68,
      "Exact runtime bundle validation, input limits and interactive launch cases must execute.",
    );
    const chunks = [Buffer.from("goatcitadel.worker-runtime-bundle.v1\0", "ascii")];
    const count = Buffer.alloc(4);
    count.writeUInt32LE(2);
    chunks.push(count);
    for (const [name, content] of [
      ["a.txt", "abc"],
      ["lib/empty.txt", ""],
    ]) {
      const pathBytes = Buffer.from(name, "ascii");
      const length = Buffer.alloc(4);
      length.writeUInt32LE(pathBytes.length);
      const size = Buffer.alloc(8);
      size.writeBigUInt64LE(BigInt(Buffer.byteLength(content)));
      chunks.push(length, pathBytes, size, createHash("sha256").update(content).digest());
    }
    assert.equal(receipt.runtimeBundleGoldenSha256, createHash("sha256").update(Buffer.concat(chunks)).digest("hex"));
    assert.equal(receipt.controllerDescriptorControl, true);
    assert.ok([0, 5].includes(receipt.explicitDescriptorCreateError));
    assert.ok([0, 2, 5].includes(receipt.explicitDescriptorWriteDaclError));
}
const workspacePhaseFields = [
  "workspaceChecks", "virtualDiskChecks", "volumeAttachmentChecks", "volumeAttachmentExercised",
  "explicitDescriptorCreateError", "explicitDescriptorWriteDaclError", "virtualDiskRecoveryProcessVerified",
  "volumeAttachmentRecoveryVerified", "volumeDeviceBindingVerified", "volumeDeviceMetadataChecks",
  "provisioningJournalChecks", "provisioningRecoveryProcessVerified", "provisioningCheckpointRecords",
  "provisioningDiskLayoutIdsHex", "volumeProvisioningCoreRecords", "volumeProvisioningRecords",
  "formatProvisioningHistory", "protectionProvisioningHistory", "mountProvisioningHistory", "controllerDescriptorControl",
];
const provisioningPhaseFields = ["provisioningJournalChecks", "provisioningRecoveryProcessVerified", "provisioningCheckpointRecords",
  "provisioningDiskLayoutIdsHex", "volumeProvisioningCoreRecords", "volumeProvisioningRecords", "formatProvisioningHistory",
  "protectionProvisioningHistory", "mountProvisioningHistory"];
function joinPhaseReceipts(core, workspace, provisioning) {
  assert.equal(core.phase, "core"); assert.equal(workspace.phase, "workspace");
  assert.equal(provisioning.phase, "provisioning"); assert.equal(provisioning.status, "passed");
  assert.equal(core.status, "passed"); assert.equal(workspace.status, "passed");
  assert.deepEqual(Object.keys(workspace).sort(), [...workspacePhaseFields, "phase", "status", "checks"].sort());
  assert.deepEqual(Object.keys(provisioning).sort(), [...provisioningPhaseFields, "phase", "status", "checks"].sort());
  assert.equal(core.provisioningJournalChecks, 0); assert.equal(workspace.provisioningJournalChecks, 0);
  assert.ok(Number.isSafeInteger(provisioning.checks) && provisioning.checks > 0);
  assert.equal(provisioning.checks, provisioning.provisioningJournalChecks);
  let workspaceChecks = 0;
  for (const key of ["workspaceChecks", "virtualDiskChecks", "volumeAttachmentChecks"]) {
    assert.equal(core[key], 0, "Core phase must not duplicate the workspace proof");
    assert.ok(Number.isSafeInteger(workspace[key]) && workspace[key] > 0);
    workspaceChecks += workspace[key];
  }
  assert.equal(workspace.checks, workspaceChecks);
  assert.ok(Number.isSafeInteger(core.checks) && core.checks > 0 && Number.isSafeInteger(core.checks + workspaceChecks + provisioning.checks));
  assert.equal(core.volumeAttachmentExercised, false); assert.equal(workspace.volumeAttachmentExercised, false);
  return { ...core, ...Object.fromEntries(workspacePhaseFields.map(key => [key, workspace[key]])),
    ...Object.fromEntries(provisioningPhaseFields.map(key => [key, provisioning[key]])),
    checks: core.checks + workspaceChecks + provisioning.checks, phase: "combined-proof" };
}
function runPhases(executable, fixture, environment, output, mode) {
  const executableSha256 = createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
  const receipts = {};
  for (const phase of ["core", "provisioning", "workspace"]) {
    const started = performance.now();
    const target = phase === "provisioning" ? path.join(output, `provisioning-${mode}`) : fixture;
    // Thousands of journal fault assertions include durable flushes. Bound
    // that whole test group separately; per-operation deadline assertions and
    // the core/workspace process watchdogs remain unchanged.
    const receipt = run(executable, [`--${phase}-phase`, target], environment, 222,
      phase === "provisioning" ? 120000 : 40000);
    receipts[phase] = receipt;
    fs.writeFileSync(path.join(output, `${mode}-${phase}.json`), JSON.stringify({
      executableSha256, elapsedMs: performance.now() - started, receipt,
    }, null, 2), { flag: "wx" });
    assert.equal(createHash("sha256").update(fs.readFileSync(executable)).digest("hex"), executableSha256);
  }
  const combined = joinPhaseReceipts(receipts.core, receipts.workspace, receipts.provisioning);
  verifyCompleteReceipt(combined, [fixture]);
  return { ...combined, phaseReceipts: { core: `${mode}-core.json`, workspace: `${mode}-workspace.json`,
    provisioning: `${mode}-provisioning.json`, executableSha256 } };
}
test("phase receipts cannot omit workspace evidence or double-count native assertions", () => {
  const workspace = { ...Object.fromEntries(workspacePhaseFields.map(key => [key, null])),
    phase: "workspace", status: "passed", checks: 6, workspaceChecks: 1, virtualDiskChecks: 2,
    volumeAttachmentChecks: 3, provisioningJournalChecks: 0, volumeAttachmentExercised: false };
  const provisioning = { ...Object.fromEntries(provisioningPhaseFields.map(key => [key, null])),
    phase: "provisioning", status: "passed", checks: 4, provisioningJournalChecks: 4 };
  const core = { phase: "core", status: "passed", checks: 20, workspaceChecks: 0, virtualDiskChecks: 0,
    volumeAttachmentChecks: 0, provisioningJournalChecks: 0, volumeAttachmentExercised: false, filesystemChecks: 41 };
  const joined = joinPhaseReceipts(core, workspace, provisioning);
  assert.equal(joined.checks, 30); assert.equal(joined.filesystemChecks, 41); assert.equal(joined.provisioningJournalChecks, 4);
  const missing = { ...workspace }; delete missing.provisioningCheckpointRecords;
  assert.throws(() => joinPhaseReceipts(core, missing, provisioning));
  assert.throws(() => joinPhaseReceipts({ ...core, workspaceChecks: 1 }, workspace, provisioning));
  assert.throws(() => joinPhaseReceipts(core, { ...workspace, checks: 11 }, provisioning));
  assert.throws(() => joinPhaseReceipts(core, { ...workspace, phase: "core" }, provisioning));
  assert.throws(() => joinPhaseReceipts(core, { ...workspace, volumeAttachmentExercised: true }, provisioning));
  const incompleteJournal = { ...provisioning }; delete incompleteJournal.provisioningCheckpointRecords;
  assert.throws(() => joinPhaseReceipts(core, workspace, incompleteJournal));
  assert.throws(() => joinPhaseReceipts(core, workspace, { ...provisioning, checks: 5 }));
});
async function networkProof(controller, asan, fixture, asanEnvironment) {
  let accepted = 0;
  const listener = net.createServer((socket) => {
    accepted += 1;
    socket.destroy();
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  const nativeControl = () => {
    const result = spawnSync(fixture, ["network", String(port)], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5000,
      env: { SystemRoot: process.env.SystemRoot },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      "network_error=0 connected=1",
      "The same native probe connects outside AppContainer.",
    );
    return { networkError: 0, connected: true };
  };
  const control = () =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host: "127.0.0.1" });
      socket.setTimeout(3000, () => socket.destroy(new Error("Loopback control timed out.")));
      socket.once("error", reject);
      socket.once("close", () => resolve());
    });
  try {
    await control();
    assert.equal(accepted, 1, "Control connection reaches the actual loopback listener.");
    const before = nativeControl();
    const normal = run(controller, ["--network", fixture, String(port)], {}, 7);
    const sanitized = run(asan, ["--network", fixture, String(port)], asanEnvironment, 7);
    const after = nativeControl();
    await control();
    assert.equal(accepted, 4, "Only the native and JS control connections reach the listener.");
    return {
      normal,
      sanitized,
      nativeControlBefore: before,
      nativeControlAfter: after,
      acceptedControlConnections: accepted,
    };
  } finally {
    listener.close();
    await once(listener, "close");
  }
}
async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Task-owned process did not reach the required state.");
    await delay(25);
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

test(
  attachmentProof
    ? "native Windows volume attachment and exact detach with resource boundary proof"
    : "native per-assignment job enforces resources and owns descendants",
  {
    skip: process.platform !== "win32",
    timeout: 600000,
  },
  async (t) => {
    const temporaryRoot = os.tmpdir();
    const temporarySpace = fs.statfsSync(temporaryRoot, { bigint: true });
    const availableBytes = temporarySpace.bavail * temporarySpace.bsize;
    // The normal and ASAN fixture sets retain about 11.3 GB of fixed VHDX
    // images together. Leave room for both sets, build outputs and metadata.
    assert.ok(availableBytes >= 16n * 1024n ** 3n,
      `Native cell fixtures require at least 16 GiB free before retaining fixed VHDX allocations. ${temporaryRoot} has ${availableBytes} bytes available. Set TEMP and TMP to an owned NTFS directory with sufficient space; no volume operation has started.`);
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Worker Cell Job "));
    t.diagnostic(`Retained native cell job evidence: ${output}`);
    const prebuilt = packageReference ? stageWorkerCellAcceptance(packageReference, output) : undefined;
    const snapshot = () =>
      WORKER_CELL_SOURCE_FILES.map((file) => ({
        file,
        sha256: createHash("sha256")
          .update(fs.readFileSync(path.join(source, file)))
          .digest("hex"),
      }));
    const originalSources = snapshot();
    fs.writeFileSync(path.join(output, "sources.json"), JSON.stringify(originalSources, null, 2), { flag: "wx" });
    const options = { target: "windows-x64", outputDirectory: output, includes: [path.join(source, "src")] };
    const fixture = prebuilt?.fixture ?? compileTlsNative({
      ...options,
      outputName: "job-fixture.exe",
      sources: WORKER_CELL_FIXTURE_SOURCES.map((file) => path.join(source, file)),
    });
    const sources = WORKER_CELL_CONTROLLER_SOURCES.map((file) => path.join(source, file));
    const controller = prebuilt?.controller ?? compileTlsNative({ ...options, outputName: "cell-job-test.exe", sources, compilerTimeoutMs: 120000 });
    if (attachmentProof) {
      const preflight = run(controller, ["--volume-preflight"], {}, 1);
      assert.equal(preflight.volumePrivilegeAvailable, true);
      fs.writeFileSync(path.join(output, "volume-preflight.json"), JSON.stringify(preflight, null, 2), { flag: "wx" });
    }
    const proofArguments = attachmentProof ? ["--volume-attachment", fixture] : [fixture];
    const normal = attachmentProof ? run(controller, proofArguments) : runPhases(controller, fixture, {}, output, "normal");
    fs.writeFileSync(path.join(output, "normal.json"), JSON.stringify(normal, null, 2), { flag: "wx" });
    const asan = prebuilt?.asan ?? compileTlsNative({ ...options, outputName: "cell-job-asan.exe", sources, asan: true, compilerTimeoutMs: 120000 });
    const toolchain = prebuilt ? undefined : resolveExactWindowsToolchain("windows-x64");
    const asanEnvironment = {
      PATH: prebuilt?.runtimeDirectory ?? path.dirname(toolchain.compilerPath),
      ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0",
    };
    const sanitized = attachmentProof ? run(asan, proofArguments, asanEnvironment) : runPhases(asan, fixture, asanEnvironment, output, "asan");
    fs.writeFileSync(path.join(output, "asan.json"), JSON.stringify(sanitized, null, 2), { flag: "wx" });
    // Keep each native invocation within its existing 40-second watchdog.
    // Journal fault cases run separately from the job/runtime regression suite.
    for (const [mode, image, environment] of [["normal", controller, {}], ["asan", asan, asanEnvironment]]) {
      const hostCapacity = run(image, ["--host-capacity-journal", path.join(output, `host-capacity-${mode}`)], environment, 50);
      assert.equal(hostCapacity.hostCapacityObserver, true);
      assert.equal(hostCapacity.volumeAttachmentExercised, false);
      fs.writeFileSync(path.join(output, `host-capacity-${mode}.json`), JSON.stringify(hostCapacity, null, 2), { flag: "wx" });
      const workspaceJournal = run(image, ["--mounted-workspace-journal", path.join(output, `workspace-journal-${mode}`)], environment, 600);
      verifyCellMountedWorkspaceJournalReceipt(workspaceJournal);
      fs.writeFileSync(path.join(output, `mounted-workspace-${mode}.json`), JSON.stringify(workspaceJournal, null, 2), { flag: "wx" });
    }
    const network = await networkProof(controller, asan, fixture, asanEnvironment);
    fs.writeFileSync(path.join(output, "network.json"), JSON.stringify(network, null, 2), { flag: "wx" });
    for (const mode of ["static", "stdio"]) {
      const controlDirectory = path.join(output, `control-${mode}`);
      fs.mkdirSync(controlDirectory);
      const pidPath = path.join(controlDirectory, "owned-child.pid");
      const profilePath = `${pidPath}.profile`;
      const crashLog = fs.openSync(path.join(output, `owner-crash-${mode}.log`), "wx");
      const owner = spawn(controller, [mode === "stdio" ? "--hold-stdio" : "--hold", fixture, pidPath], {
        windowsHide: true,
        stdio: ["ignore", crashLog, crashLog],
        env: { SystemRoot: process.env.SystemRoot },
      });
      fs.closeSync(crashLog);
      const ownerExit = once(owner, "exit");
      try {
        await until(() => fs.existsSync(pidPath));
        const { pid: childPid } = JSON.parse(fs.readFileSync(pidPath, "utf8"));
        assert.ok(Number.isSafeInteger(childPid) && childPid > 0 && alive(childPid));
        assert.equal(owner.kill("SIGKILL"), true);
        await ownerExit;
        await until(() => !alive(childPid));
        fs.writeFileSync(
          path.join(output, `owner-crash-${mode}.json`),
          JSON.stringify({ mode, childPid, childExited: true }),
          {
            flag: "wx",
          },
        );
      } finally {
        // Kill only after ownership was retained. Otherwise let the bounded
        // controller finish and perform its own profile cleanup.
        if (owner.exitCode === null && owner.signalCode === null && fs.existsSync(profilePath)) owner.kill("SIGKILL");
        await until(() => owner.exitCode !== null || owner.signalCode !== null, 40000);
        await ownerExit;
        if (fs.existsSync(profilePath)) {
          const { profile } = JSON.parse(fs.readFileSync(profilePath, "utf8"));
          assert.match(profile, /^GoatCitadel\.Worker\.[a-f0-9]{32}$/u);
          const cleanup = spawnSync(controller, ["--cleanup-profile", profile], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 10000,
            env: { SystemRoot: process.env.SystemRoot },
          });
          assert.equal(cleanup.status, 0, cleanup.stderr);
        }
      }
    }
    assert.deepEqual(snapshot(), originalSources, "Native source must remain unchanged during its proof.");
    if (packageReference) verifyWorkerCellAcceptance(packageReference);
  },
);
