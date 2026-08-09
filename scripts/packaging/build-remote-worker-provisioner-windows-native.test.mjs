import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  REMOTE_WORKER_WINDOWS_PROVISIONER_IMPORTS,
  REMOTE_WORKER_WINDOWS_PROVISIONER_CLIENT_NAME,
  REMOTE_WORKER_WINDOWS_PROVISIONER_NAME,
  REMOTE_WORKER_WINDOWS_PROVISIONER_PREFLIGHT_NAME,
  REMOTE_WORKER_WINDOWS_PROVISIONER_TEST_NAME,
  REMOTE_WORKER_WINDOWS_PROVISIONER_W1B1A_SOURCE_PATHS,
  REMOTE_WORKER_WINDOWS_PROVISIONER_W1B1B_P0_SOURCE_PATHS,
  assertEmbeddedClientDigest,
  buildRemoteWorkerWindowsProvisioner,
  createFixedEd25519InteropFrame,
  computeW1B1aCanonicalSourceManifest,
  computeW1B1bP0CanonicalSourceManifest,
  inspectAdapterCheckCallgraph,
  inspectLinkedCheckCallgraph,
  inspectProtectedArtifactSigningCallgraph,
  inspectProtectedEd25519BridgeCallgraph,
  inspectRemoteWorkerProvisionerPe,
  normalizeLinkMapIcfConstantOwners,
  publishProvenProvisionerPairNoReplace,
  publishProvenProvisionerNoReplace,
  validateMonocypherSourceSnapshot,
  verifyProtectedSigningInteropReceipts,
} from "./build-remote-worker-provisioner-windows-native.mjs";
import {
  REMOTE_WORKER_WINDOWS_MSVC_VERSION,
  REMOTE_WORKER_WINDOWS_SDK_VERSION,
  assertNoRemoteWorkerBuildPathLeak,
  resolveExactWindowsToolchain,
} from "./lib/remote-worker-windows-toolchain.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "../..");
const builderPath = path.join(repoRoot, "scripts", "packaging", "build-remote-worker-provisioner-windows-native.mjs");
const nativeRoot = path.join(repoRoot, "apps", "remote-worker-provisioner-windows-native");
const sourcePath = path.join(nativeRoot, "src", "main.cpp");
const clientSourcePath = path.join(nativeRoot, "src", "client_main.cpp");
const serviceRuntimeSourcePath = path.join(nativeRoot, "src", "service_runtime.cpp");
const serviceRuntimeHeaderPath = path.join(nativeRoot, "src", "service_runtime.hpp");
const localTransportSourcePath = path.join(nativeRoot, "src", "local_transport.cpp");
const localTransportHeaderPath = path.join(nativeRoot, "src", "local_transport.hpp");
const protocolSourcePath = path.join(nativeRoot, "src", "protocol.cpp");
const protocolHeaderPath = path.join(nativeRoot, "src", "protocol.hpp");
const nativeTestSourcePath = path.join(nativeRoot, "src", "protocol.test.cpp");
const protectedOperationsSourcePath = path.join(nativeRoot, "src", "protected_operations.cpp");
const protectedArtifactSigningSourcePath = path.join(nativeRoot, "src", "protected_artifact_signing.cpp");
const protectedArtifactSigningHeaderPath = path.join(nativeRoot, "src", "protected_artifact_signing.hpp");
const protectedArtifactSigningTestPath = path.join(nativeRoot, "src", "protected_artifact_signing.test.cpp");
const protectedFilesystemSourcePath = path.join(nativeRoot, "src", "protected_filesystem.cpp");
const ed25519RuntimeSourcePath = path.join(nativeRoot, "src", "ed25519_runtime.cpp");
const ed25519RuntimeHeaderPath = path.join(nativeRoot, "src", "ed25519_runtime.hpp");
const ed25519RuntimeTestPath = path.join(nativeRoot, "src", "ed25519_runtime.test.cpp");
const productionProjectPath = path.join(nativeRoot, "GoatCitadel.RemoteWorker.Provisioner.vcxproj");
const clientProjectPath = path.join(nativeRoot, "GoatCitadel.RemoteWorker.Provisioner.Client.vcxproj");
const testProjectPath = path.join(nativeRoot, "GoatCitadel.RemoteWorker.Provisioner.Tests.vcxproj");
const monocypherVendorRoot = path.join(repoRoot, "vendor", "monocypher", "4.0.3");

let temporaryRoot;

before(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-rw-provisioner-builder-test-"));
});

after(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test("W1B1A freezes the exact 35-file fence and canonical current-byte source manifest", () => {
  const expected = [
    "apps/remote-worker-provisioner-windows-native/GoatCitadel.RemoteWorker.Provisioner.Client.vcxproj",
    "apps/remote-worker-provisioner-windows-native/GoatCitadel.RemoteWorker.Provisioner.Tests.vcxproj",
    "apps/remote-worker-provisioner-windows-native/GoatCitadel.RemoteWorker.Provisioner.vcxproj",
    "apps/remote-worker-provisioner-windows-native/src/client_main.cpp",
    "apps/remote-worker-provisioner-windows-native/src/ed25519_runtime.cpp",
    "apps/remote-worker-provisioner-windows-native/src/ed25519_runtime.hpp",
    "apps/remote-worker-provisioner-windows-native/src/ed25519_runtime.test.cpp",
    "apps/remote-worker-provisioner-windows-native/src/key_custody.cpp",
    "apps/remote-worker-provisioner-windows-native/src/key_custody.hpp",
    "apps/remote-worker-provisioner-windows-native/src/key_custody.test.cpp",
    "apps/remote-worker-provisioner-windows-native/src/local_transport.cpp",
    "apps/remote-worker-provisioner-windows-native/src/local_transport.hpp",
    "apps/remote-worker-provisioner-windows-native/src/local_transport.test.cpp",
    "apps/remote-worker-provisioner-windows-native/src/operation_journal.cpp",
    "apps/remote-worker-provisioner-windows-native/src/operation_journal.hpp",
    "apps/remote-worker-provisioner-windows-native/src/operation_journal.test.cpp",
    "apps/remote-worker-provisioner-windows-native/src/protected_filesystem.cpp",
    "apps/remote-worker-provisioner-windows-native/src/protected_filesystem.hpp",
    "apps/remote-worker-provisioner-windows-native/src/protected_filesystem.test.cpp",
    "apps/remote-worker-provisioner-windows-native/src/protected_operations.cpp",
    "apps/remote-worker-provisioner-windows-native/src/protected_operations.hpp",
    "apps/remote-worker-provisioner-windows-native/src/protected_operations.test.cpp",
    "apps/remote-worker-provisioner-windows-native/src/protocol.cpp",
    "apps/remote-worker-provisioner-windows-native/src/protocol.hpp",
    "apps/remote-worker-provisioner-windows-native/src/protocol.test.cpp",
    "apps/remote-worker-provisioner-windows-native/src/service_runtime.cpp",
    "apps/remote-worker-provisioner-windows-native/src/service_runtime.hpp",
    "apps/remote-worker-provisioner-windows-native/src/service_runtime.test.cpp",
    "apps/remote-worker-provisioner/src/windows-helper-protocol.test.ts",
    "apps/remote-worker-provisioner/src/windows-helper-protocol.ts",
    "apps/remote-worker-provisioner/src/windows-service-client.test.ts",
    "apps/remote-worker-provisioner/src/windows-service-client.ts",
    "scripts/packaging/build-remote-worker-provisioner-windows-native.mjs",
    "scripts/packaging/build-remote-worker-provisioner-windows-native.test.mjs",
    "scripts/packaging/lib/remote-worker-windows-toolchain.mjs",
  ];
  assert.deepEqual(REMOTE_WORKER_WINDOWS_PROVISIONER_W1B1A_SOURCE_PATHS, expected);
  assert.deepEqual(expected, [...expected].sort(asciiCompare));
  assert.equal(new Set(expected).size, 35);
  const manifest = computeW1B1aCanonicalSourceManifest();
  assert.equal(manifest.schema, "goatcitadel.remote-worker.provisioner.w1b1a-source-manifest.v2");
  assert.equal(manifest.fileCount, 35);
  assert.equal(manifest.entries.length, 35);
  assert.equal(manifest.bytes.toString("utf8").endsWith("\n"), false);
  const lines = manifest.bytes.toString("utf8").split("\n");
  assert.equal(lines.length, 35);
  for (let index = 0; index < lines.length; index += 1) {
    assert.match(lines[index], /^[a-f0-9]{64}  [a-zA-Z0-9_./-]+$/u);
    assert.equal(lines[index], `${manifest.entries[index].sha256}  ${expected[index]}`);
    assert.equal(
      manifest.entries[index].sha256,
      createHash("sha256")
        .update(fs.readFileSync(path.join(repoRoot, ...expected[index].split("/"))))
        .digest("hex"),
    );
  }
  assert.equal(createHash("sha256").update(manifest.bytes).digest("hex"), manifest.sha256);
});

test("W1B1B-P0 freezes the exact 17-file fence and canonical current-byte source manifest", () => {
  const expected = [
    "apps/remote-worker-provisioner-windows-native/GoatCitadel.RemoteWorker.Provisioner.Tests.vcxproj",
    "apps/remote-worker-provisioner-windows-native/GoatCitadel.RemoteWorker.Provisioner.vcxproj",
    "apps/remote-worker-provisioner-windows-native/src/ed25519_runtime.cpp",
    "apps/remote-worker-provisioner-windows-native/src/ed25519_runtime.hpp",
    "apps/remote-worker-provisioner-windows-native/src/ed25519_runtime.test.cpp",
    "apps/remote-worker-provisioner-windows-native/src/key_custody.cpp",
    "apps/remote-worker-provisioner-windows-native/src/key_custody.hpp",
    "apps/remote-worker-provisioner-windows-native/src/key_custody.test.cpp",
    "apps/remote-worker-provisioner-windows-native/src/protected_artifact_signing.cpp",
    "apps/remote-worker-provisioner-windows-native/src/protected_artifact_signing.hpp",
    "apps/remote-worker-provisioner-windows-native/src/protected_artifact_signing.test.cpp",
    "apps/remote-worker-provisioner-windows-native/src/protected_filesystem.cpp",
    "apps/remote-worker-provisioner-windows-native/src/protected_filesystem.hpp",
    "apps/remote-worker-provisioner-windows-native/src/protected_filesystem.test.cpp",
    "scripts/packaging/build-remote-worker-provisioner-windows-native.mjs",
    "scripts/packaging/build-remote-worker-provisioner-windows-native.test.mjs",
    "scripts/packaging/lib/remote-worker-windows-toolchain.mjs",
  ];
  assert.deepEqual(REMOTE_WORKER_WINDOWS_PROVISIONER_W1B1B_P0_SOURCE_PATHS, expected);
  assert.deepEqual(expected, [...expected].sort(asciiCompare));
  assert.equal(new Set(expected).size, 17);
  const manifest = computeW1B1bP0CanonicalSourceManifest();
  assert.equal(manifest.schema, "goatcitadel.remote-worker.provisioner.w1b1b-p0-source-manifest.v2");
  assert.equal(manifest.fileCount, 17);
  assert.equal(manifest.entries.length, 17);
  assert.equal(manifest.bytes.toString("utf8").endsWith("\n"), false);
  const lines = manifest.bytes.toString("utf8").split("\n");
  assert.equal(lines.length, 17);
  for (let index = 0; index < lines.length; index += 1) {
    assert.match(lines[index], /^[a-f0-9]{64}  [a-zA-Z0-9_./-]+$/u);
    assert.equal(lines[index], `${manifest.entries[index].sha256}  ${expected[index]}`);
    assert.equal(
      manifest.entries[index].sha256,
      createHash("sha256")
        .update(fs.readFileSync(path.join(repoRoot, ...expected[index].split("/"))))
        .digest("hex"),
    );
  }
  assert.equal(createHash("sha256").update(manifest.bytes).digest("hex"), manifest.sha256);
});

test("M2 source freezes the authority-bound production-callable signing surface", () => {
  const source = fs.readFileSync(protectedArtifactSigningSourcePath, "utf8");
  const header = fs.readFileSync(protectedArtifactSigningHeaderPath, "utf8");
  const nativeTest = fs.readFileSync(protectedArtifactSigningTestPath, "utf8");
  assert.equal(/#include\s+[<"]monocypher(?:-ed25519)?\.h[>"]/u.test(source), false);
  assert.equal(/\bcrypto_(?:ed25519|eddsa|x25519|sha512)[A-Za-z0-9_]*\s*\(/u.test(source), false);
  assert.equal(source.includes('#include "ed25519_runtime.hpp"'), true);
  assert.match(source, /sizeof\(kEvidenceDomain\) - 1U == 60U/u);
  assert.equal(source.includes("MapViewOfFile"), false);
  assert.equal(source.includes("CreateFileMapping"), false);
  assert.equal(source.includes("InterlockedCompareExchange"), true);
  assert.match(header, /class ProtectedSigningLease final \{\s+public:\s+ProtectedSigningLease\(\) noexcept;/u);
  assert.match(header, /struct ProtectedSigningFactoryInput final/u);
  assert.match(source, /bool CreateProtectedSigningLease\(/u);
  assert.match(header, /friend bool SignProtectedArtifact/u);
  assert.equal(nativeTest.includes("int RunProtectedArtifactSigningTests() noexcept"), true);
  assert.equal(nativeTest.includes("kRfc8032EmptySignature"), true);
  for (const oracle of [
    "c62cd6daaefc806a9307e259d7c03bc422b97d37ed627526b52acc260a5457ba104f8e1ed2332fdc997dbc264aec3562067ba3f9da3c04e49573570a34ef070b",
    "242524eb90116157cb109aeb5fb00876f05fca7af687da8529234aa2b8d4566f3106c07621a8e41fbe14cda2913a1fac7062839679e584cc1a7ea541a9210a00",
    "44237e1d28a7f64bc8c1fcba6bdff55a7446596aae15dc225318a99429a2c0f77d9c43172f0315d6a1fcf55c4caa316e338189e694d6993579cd6376c7b0ca01",
    "f7bc4cb11cd902820c80e2940070a53fffd0f2d5b515081d589ab9c674d57b35bbfe017319da89c88148b4190348270eff0ae27dd2cd22b07843af362efa9908",
    "7a089aadcdc7968cc6a8d7d1c9ded0251df8a8f3720711f2d986346d1375ca63e0d2211704d4fa437d15a691376178d085d38087b1394d8fe7f2d52684b88007",
    "36b3b8971c86752f32f4b0fcfd7415a976ebb07d0746c77d4a7f3cab52c188e3efff813a0cf06458d84f0c38147e38ed4c8321b39ffdb1612e52603aba09f707",
  ]) {
    assert.equal(nativeTest.includes(oracle), true, `missing Node Ed25519 boundary oracle ${oracle}`);
  }
});

test("builder reuses only the pinned shared toolchain and path-leak owners", () => {
  const source = fs.readFileSync(builderPath, "utf8");
  for (const fragment of [
    "REMOTE_WORKER_WINDOWS_MSVC_VERSION",
    "REMOTE_WORKER_WINDOWS_SDK_VERSION",
    "assertNoRemoteWorkerBuildPathLeak",
    "resolveExactWindowsToolchain",
    "const nativeRuntimeTest = runPinnedNativeTests({",
    "const nativeTargetTest =",
    "The two clean ${target} native-test builds were not byte-identical ",
    "runPinnedVendorPreflightBuild",
    "runVendorPreflight",
    "runVendorPostflight",
    "validateMonocypherSourceSnapshot",
    "inspectNativeCryptographyEvidence",
    "dumpbin.exe",
    "clang_rt.asan_dynamic-x86_64.dll",
    "spawnSync(firstBinaryPath, [], {",
    "The two clean provisioner client builds were not byte-identical.",
    "The two clean provisioner service builds were not byte-identical.",
    "publishProvenProvisionerPairNoReplace",
    "exactly one raw embedded client SHA-256",
    "forbidden text client SHA-256 projection",
    "The native-test executable escaped the temporary proof root.",
    "crypto.randomBytes(16)",
    "fs.constants.COPYFILE_EXCL",
  ]) {
    assert.equal(source.includes(fragment), true, `missing builder contract fragment: ${fragment}`);
  }
  for (const forbiddenFragment of [
    "inspectRemoteWorkerLauncherPe",
    "buildRemoteWorkerWindowsServiceLauncher",
    "REMOTE_WORKER_WINDOWS_LAUNCHER_NAME",
    "process.pid",
  ]) {
    assert.equal(
      source.includes(forbiddenFragment),
      false,
      `builder reused forbidden launcher proof authority: ${forbiddenFragment}`,
    );
  }
});

test("shared path-leak proof rejects ASCII and UTF-16 build identities", () => {
  assert.doesNotThrow(() => assertNoRemoteWorkerBuildPathLeak(Buffer.from("clean binary"), ["C:\\proof-root"]));
  assert.throws(
    () => assertNoRemoteWorkerBuildPathLeak(Buffer.from("prefix C:\\PROOF-ROOT suffix", "utf8"), ["c:\\proof-root"]),
    /forbidden build-identity string/u,
  );
  assert.throws(
    () => assertNoRemoteWorkerBuildPathLeak(Buffer.from("prefix C:\\PROOF-ROOT suffix", "utf16le"), ["c:\\proof-root"]),
    /forbidden build-identity string/u,
  );
});

test("service completes protected-state recovery before arming any live transport", () => {
  const source = fs.readFileSync(serviceRuntimeSourcePath, "utf8");
  const workerStart = source.indexOf("DWORD WINAPI ServiceStartupWorker(");
  const workerEnd = source.indexOf("bool ClosePublishedStopEvent(", workerStart);
  assert.notEqual(workerStart, -1, "StartupWorker owner is present");
  assert.notEqual(workerEnd, -1, "StartupWorker has a bounded source body");
  const worker = source.slice(workerStart, workerEnd);
  const recovery = worker.indexOf("RecoverProtectedServiceState(");
  const recoveryFailure = worker.indexOf("if (recovery_result != ServiceTransportResult::Success)", recovery);
  const arm = worker.indexOf("ArmServiceTransport(", recovery);
  const armedStage = worker.indexOf("StartupStage::TransportArmed", arm);
  assert.ok(recovery >= 0, "protected-state recovery is owned by StartupWorker");
  assert.ok(recoveryFailure > recovery, "recovery failure is checked before startup proceeds");
  assert.ok(arm > recoveryFailure, "live transport cannot arm before recovery succeeds");
  assert.ok(armedStage > arm, "the TransportArmed stage is published only after Arm succeeds");
  assert.equal(
    worker.slice(0, recovery).includes("ArmServiceTransport("),
    false,
    "no earlier transport-arm path bypasses protected-state recovery",
  );
});

test("protected recovery preserves one deadline and STOP authority across iterative restart", () => {
  const transport = fs.readFileSync(localTransportSourcePath, "utf8");
  const recoveryStart = transport.indexOf("ServiceTransportResult RecoverProtectedServiceState(");
  const recoveryEnd = transport.indexOf("ServiceTransportResult ArmServiceTransport(", recoveryStart);
  assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
  const recovery = transport.slice(recoveryStart, recoveryEnd);
  for (const fragment of [
    "startup_deadline_ms == 0U",
    "WaitForSingleObject(internal->context.stop_event, 0U)",
    "recovery_start >= startup_deadline_ms",
    "const std::uint64_t bounded_recovery_deadline =",
    "bounded_recovery_deadline,\n          internal->context.stop_event",
    "GetTickCount64() >= bounded_recovery_deadline",
  ]) {
    assert.equal(recovery.includes(fragment), true, `missing recovery budget/STOP contract: ${fragment}`);
  }

  const operations = fs.readFileSync(protectedOperationsSourcePath, "utf8");
  const initializeStart = operations.indexOf("bool InitializeProtectedOperations(");
  const initializeEnd = operations.indexOf("void CloseProtectedOperations(", initializeStart);
  assert.ok(initializeStart >= 0 && initializeEnd > initializeStart);
  const initialize = operations.slice(initializeStart, initializeEnd);
  assert.equal(
    initialize.includes("for (std::size_t restart = 0U;"),
    true,
    "recovery restarts are bounded by an iterative loop",
  );
  assert.equal(
    initialize.includes("InitializeProtectedOperationsOnce("),
    true,
    "each iterative pass uses the single-pass owner",
  );
  assert.equal(
    (initialize.match(/InitializeProtectedOperations\(/gu) ?? []).length,
    1,
    "the public initializer never recursively calls itself",
  );
  assert.equal(
    initialize.includes("recovery_deadline_ms,") && initialize.includes("recovery_stop_event,"),
    true,
    "each pass reuses the original absolute deadline and STOP handle",
  );
});

test("protected recovery owns large replay scratch only in aligned static storage", () => {
  const source = fs.readFileSync(protectedOperationsSourcePath, "utf8");
  for (const declaration of [
    "alignas(64) ProtectedRecoveryReplayOutput g_replay_first_scratch{};",
    "alignas(64) ProtectedRecoveryReplayOutput g_replay_second_scratch{};",
    "alignas(64) ProtectedRecoveryReplayOutput g_replay_phase_a_scratch{};",
    "alignas(64) std::array<RecoveredJournalOperation, 33U>\n    g_recovered_operations_scratch{};",
    "alignas(64) ProtectedOperationsState g_replay_state_scratch{};",
    "g_recovery_physical_projection_scratch{};",
    "g_residue_metadata_scratch{};",
  ]) {
    assert.equal(source.includes(declaration), true, `missing aligned recovery scratch: ${declaration}`);
  }
  assert.equal(
    source.includes("*output = ProtectedRecoveryReplayOutput{};"),
    false,
    "replay output reset must not materialize a full aggregate on the stack",
  );
  assert.equal(
    /\bProtectedRecoveryReplayOutput\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/u.test(
      source.slice(source.indexOf("bool ReplayRecoveryPublications(")),
    ),
    false,
    "no function-scope full replay output is permitted",
  );
  assert.equal(source.includes("WipeCustodyOwned(output, sizeof(*output));"), true, "replay output is reset in place");
  assert.equal(
    source.includes("WipeCustodyOwned(\n      &g_replay_phase_a_scratch, sizeof(g_replay_phase_a_scratch));"),
    true,
    "phase-A scratch has deterministic pre-use wiping",
  );
  assert.equal(
    source.includes("~PhaseAReplayScratchGuard() noexcept"),
    true,
    "phase-A scratch has all-exit teardown wiping",
  );
  assert.equal(
    source.includes("constexpr std::size_t kRecoveryPhysicalSnapshotBytes = 96U;") &&
      source.includes("std::array<std::uint8_t, kRecoveryPhysicalSnapshotBytes>") &&
      source.includes("kRecoveryPhysicalSnapshotOperationHashOffset + Byte32{}.size() ==") &&
      source.includes("physical_snapshot.size(),"),
    true,
    "physical snapshot exactly fits state, four counters, and operation hash",
  );
  assert.equal(
    source.includes("std::array<std::uint8_t, 88U> physical_snapshot{};"),
    false,
    "physical snapshot cannot truncate the final 32-byte operation hash",
  );
});

test("recovery replay duplicates only the five fixed directories and optional STOP with exact authority", () => {
  const source = fs.readFileSync(protectedOperationsSourcePath, "utf8");
  const client = fs.readFileSync(clientSourcePath, "utf8");
  const start = source.indexOf("bool DuplicateRecoveryFilesystem(");
  const end = source.indexOf("void CloseRecoveryFilesystem(", start);
  assert.ok(start >= 0 && end > start);
  const duplicate = source.slice(start, end);

  assert.equal((duplicate.match(/\bDuplicateHandle\(/gu) ?? []).length, 6);
  assert.equal((duplicate.match(/\binjected_failure\(\)/gu) ?? []).length, 6);
  assert.equal(duplicate.includes("const HANDLE process = GetCurrentProcess();"), true);
  for (const field of ["state_root", "journal", "keysets", "controls", "quarantine", "recovery_stop_event"]) {
    const call = new RegExp(
      `DuplicateHandle\\(\\s*process,\\s*source\\.${field},\\s*process,\\s*&destination->${field},\\s*0U,\\s*FALSE,\\s*DUPLICATE_SAME_ACCESS\\)`,
      "u",
    );
    assert.match(duplicate, call, `${field} has one exact same-process duplicate call`);
  }
  for (const forbidden of [
    "DuplicateRecoveryHandle",
    "DUPLICATE_CLOSE_SOURCE",
    "OpenProtectedExistingDirectory",
    "CreateFileW",
    "TRUE,\n          DUPLICATE_SAME_ACCESS",
  ]) {
    assert.equal(duplicate.includes(forbidden), false, `forbidden duplicate variant: ${forbidden}`);
  }
  assert.equal(client.includes("DuplicateHandle"), false, "client gains no duplicate-handle authority");
});

test("rename-capable directory handles keep exact no-delete sharing", () => {
  const source = fs.readFileSync(protectedFilesystemSourcePath, "utf8");
  const openStart = source.indexOf("bool OpenProtectedExistingDirectory(");
  const openEnd = source.indexOf("bool ReadProtectedExistingFile(", openStart);
  const createStart = source.indexOf("bool CreateProtectedDirectory(");
  const createEnd = source.indexOf("bool CreateProtectedFile(", createStart);
  assert.ok(openStart >= 0 && openEnd > openStart && createStart >= 0 && createEnd > createStart);
  const open = source.slice(openStart, openEnd);
  const create = source.slice(createStart, createEnd);
  assert.equal(
    open.includes("FILE_SHARE_READ | FILE_SHARE_WRITE"),
    true,
    "existing directories retain the frozen read/write share mask",
  );
  assert.equal(open.includes("FILE_SHARE_DELETE"), false, "directory reopen never adds delete sharing");
  assert.equal(
    create.includes("FILE_SHARE_READ | FILE_SHARE_WRITE"),
    true,
    "new rename-capable directories retain the frozen read/write share mask",
  );
  assert.equal(create.includes("FILE_SHARE_DELETE"), false, "new directory handle never adds delete sharing");
  assert.equal(
    create.includes("GENERIC_READ | DELETE"),
    true,
    "new rename-capable directories retain exact delete authority",
  );
});

test("complete CREATE recovery validates and moves the final effect before terminal records", () => {
  const source = fs.readFileSync(protectedOperationsSourcePath, "utf8");
  const initializeStart = source.indexOf("static bool InitializeProtectedOperationsOnce(");
  const initializeEnd = source.indexOf("bool InitializeProtectedOperations(", initializeStart);
  const initialize = source.slice(initializeStart, initializeEnd);
  const completeCandidate = initialize.indexOf("if (action == RecoveryAction::AppendAttemptThenPromoteAndFinish)");
  const appendRecoveryAttempt = initialize.indexOf("PublishJournalRecordWithOwnedParent(", completeCandidate);
  const captureFinalEffect = initialize.indexOf("CaptureDirectoryMoveAuthority(", appendRecoveryAttempt);
  const preMoveClosure = initialize.indexOf("BuildCandidateClosure(", captureFinalEffect);
  const moveFinalEffect = initialize.indexOf("MoveDirectoryWithCapturedAuthority(", preMoveClosure);
  const finalClosure = initialize.indexOf("BuildCandidateClosure(", moveFinalEffect);
  const reconstruct = initialize.indexOf("RecoverCommittedCreate(", moveFinalEffect);
  assert.ok(completeCandidate >= 0 && appendRecoveryAttempt > completeCandidate);
  assert.ok(captureFinalEffect > appendRecoveryAttempt && preMoveClosure > captureFinalEffect);
  assert.ok(moveFinalEffect > preMoveClosure && finalClosure > moveFinalEffect);
  assert.ok(reconstruct > finalClosure, "exact final keyset closure must precede terminal reconstruction");

  const recoverStart = source.indexOf("bool RecoverCommittedCreate(");
  const recoverEnd = source.indexOf("bool RecoverCommittedRevoke(", recoverStart);
  const recoverCreate = source.slice(recoverStart, recoverEnd);
  const reopenFinal = recoverCreate.indexOf("OpenProtectedExistingDirectory(");
  const receiptValidation = recoverCreate.indexOf("kReceiptDomain", reopenFinal);
  const finalState = recoverCreate.indexOf("ComputeCommittedState(", receiptValidation);
  const encodeOutcome = recoverCreate.indexOf("JournalRecordKind::Outcome", finalState);
  const encodeCommitted = recoverCreate.indexOf("JournalRecordKind::Committed", encodeOutcome);
  assert.ok(reopenFinal >= 0);
  assert.ok(receiptValidation > reopenFinal);
  assert.ok(finalState > receiptValidation);
  assert.ok(encodeOutcome > finalState);
  assert.ok(encodeCommitted > encodeOutcome);
});

test("residue publication makes one deterministic no-replace attempt and never retries another ordinal", () => {
  const source = fs.readFileSync(protectedOperationsSourcePath, "utf8");
  const selectStart = source.indexOf("bool SelectResidueOrdinal(");
  const fileStart = source.indexOf("bool MoveFileToResidue(");
  const select = source.slice(selectStart, fileStart);
  const fileEnd = source.indexOf("bool MoveDirectoryToResidue(", fileStart);
  const directoryEnd = source.indexOf("bool ParseOperationComponent(", fileEnd);
  assert.ok(selectStart >= 0 && fileStart > selectStart && fileEnd > fileStart && directoryEnd > fileEnd);
  for (const fragment of [
    "const ProtectedObjectIdentity& source_identity",
    "ProtectedObjectIdentity residue_identity{}",
    "residue_identity.volume_serial_number ==\n              source_identity.volume_serial_number",
    "residue_identity.file_id.data(),\n              source_identity.file_id.data()",
  ]) {
    assert.equal(
      select.includes(fragment),
      true,
      `selected residue final is compared to the still-present source: ${fragment}`,
    );
  }
  const fileMove = source.slice(fileStart, fileEnd);
  const directoryMove = source.slice(fileEnd, directoryEnd);
  for (const [label, owner, primitive, sourceIdentity] of [
    ["file", fileMove, "FlushAndRenameProtectedFile(", "source_identity"],
    ["directory", directoryMove, "MoveDirectoryWithCapturedAuthority(", "identity"],
  ]) {
    assert.equal(owner.split("SelectResidueOrdinal(").length - 1, 1, `${label} residue selects exactly one ordinal`);
    assert.equal(owner.split(primitive).length - 1, 1, `${label} residue attempts exactly one no-replace publication`);
    assert.equal(owner.includes("for ("), false, `${label} collision has no retry loop`);
    assert.equal(owner.includes("while ("), false, `${label} collision has no retry loop`);
    assert.equal(
      owner.includes("SelectResidueOrdinal(") && owner.includes(sourceIdentity),
      true,
      `${label} residue passes the captured source identity into selection`,
    );
    for (const fragment of [
      "state->next_publication_sequence == 0U",
      "state->next_publication_sequence > kMaximumPublicationSequence",
      "const std::uint16_t publication_sequence = state->next_publication_sequence",
      "operation_id, ordinal, publication_sequence, role, &component",
      "if (moved) ++state->next_publication_sequence",
    ]) {
      assert.equal(
        owner.includes(fragment),
        true,
        `${label} residue owns one exact bounded publication sequence: ${fragment}`,
      );
    }
  }
});

test("residue grammar carries one exact lowercase publication sequence into canonical projection", () => {
  const source = fs.readFileSync(protectedOperationsSourcePath, "utf8");
  const buildStart = source.indexOf("bool BuildResidueComponent(");
  const parseStart = source.indexOf("bool ParseResidueComponent(", buildStart);
  const selectStart = source.indexOf("bool SelectResidueOrdinal(", parseStart);
  assert.ok(buildStart >= 0 && parseStart > buildStart && selectStart > parseStart);
  const build = source.slice(buildStart, parseStart);
  const parse = source.slice(parseStart, selectStart);
  for (const fragment of [
    "publication_sequence == 0U",
    "publication_sequence > kMaximumPublicationSequence",
    "(*output)[offset++] = L'r'",
    "(*output)[offset++] = L'p'",
    "(publication_sequence >> shift) & 0x0fU",
  ]) {
    assert.equal(build.includes(fragment), true, `residue builder requires ${fragment}`);
  }
  for (const fragment of [
    "entry.name[kMarker + 1U] != L'r'",
    "entry.name[kMarker + 5U] != L'p'",
    "parsed_publication_sequence == 0U",
    "parsed_publication_sequence > kMaximumPublicationSequence",
    "*publication_sequence = parsed_publication_sequence",
  ]) {
    assert.equal(parse.includes(fragment), true, `residue parser requires ${fragment}`);
  }
  const hexStart = source.indexOf("int HexNibble(");
  const hexEnd = source.indexOf("struct RecoveredJournalOperation", hexStart);
  const hex = source.slice(hexStart, hexEnd);
  assert.equal(hex.includes("value >= L'A'"), false, "uppercase residue hex is never accepted");

  const projectionStart = source.indexOf("bool ResidueProjectionValid(");
  const projectionEnd = source.indexOf("template <typename Projection", projectionStart);
  const projection = source.slice(projectionStart, projectionEnd);
  assert.equal(
    projection.includes("ReadU16(projection.bytes.data() + 18U)"),
    true,
    "canonical residue projection reads its publication sequence",
  );
  assert.equal(projection.includes("publication_sequence == 0U"), true);
  assert.equal(projection.includes("publication_sequence > kMaximumPublicationSequence"), true);
  const recoveryStart = source.indexOf("bool RecoverResidueProjection(");
  const recoveryEnd = source.indexOf("bool BuildCandidateClosure(", recoveryStart);
  const recovery = source.slice(recoveryStart, recoveryEnd);
  assert.equal(
    recovery.includes("WriteU16(residue->bytes.data() + 18U, publication_sequence)"),
    true,
    "parsed p4 is bound into canonical residue projection bytes 18..19",
  );
});

test("startup inventory defers every residue and bootstrap projection until its chronological operation", () => {
  const source = fs.readFileSync(protectedOperationsSourcePath, "utf8");
  const initializeStart = source.indexOf("static bool InitializeProtectedOperationsOnce(");
  const initializeEnd = source.indexOf("bool InitializeProtectedOperations(", initializeStart);
  assert.ok(initializeStart >= 0 && initializeEnd > initializeStart);
  const initialize = source.slice(initializeStart, initializeEnd);
  const scanStart = initialize.indexOf("std::uint64_t residue_bytes = 0U;");
  const scanEnd = initialize.indexOf("quarantine_count = quarantine_operation_count;", scanStart);
  assert.ok(scanStart >= 0 && scanEnd > scanStart);
  const quarantineScan = initialize.slice(scanStart, scanEnd);
  for (const kind of ["1U", "2U", "3U"]) {
    assert.equal(
      quarantineScan.includes(`residue.bytes[17] == ${kind}`),
      true,
      `inventory classifies residue kind ${kind} before deferring it`,
    );
  }
  assert.equal(
    quarantineScan.includes("&state->residues"),
    false,
    "inventory cannot contaminate pre-operation canonical state with any later residue",
  );
  assert.equal(
    quarantineScan.includes("&state->operations"),
    false,
    "bootstrap operation projection must remain paired with its deferred residue",
  );
  assert.match(
    quarantineScan,
    /g_deferred_residues\[deferred_residue_count\] = residue;/u,
    "all residue kinds are inventoried into a noncanonical deferred collection",
  );
  assert.match(
    quarantineScan,
    /g_deferred_residue_operations\[deferred_residue_count\] = bootstrap_operation;/u,
    "bootstrap operation projections are also inventoried noncanonically",
  );
});

test("pending operation publication is normalized in two one-mutation restart cuts", () => {
  const source = fs.readFileSync(protectedOperationsSourcePath, "utf8");
  const inventoryStart = source.indexOf("bool InventoryOperationPublications(");
  const normalizeStart = source.indexOf("bool NormalizePendingOperationDirectory(");
  const normalizeEnd = source.indexOf("enum class PendingNormalizationKind", normalizeStart);
  const initializeStart = source.indexOf("static bool InitializeProtectedOperationsOnce(");
  const initializeEnd = source.indexOf("bool InitializeProtectedOperations(", initializeStart);
  assert.ok(
    inventoryStart >= 0 &&
      normalizeStart >= 0 &&
      normalizeEnd > normalizeStart &&
      initializeStart >= 0 &&
      initializeEnd > initializeStart,
  );
  const inventory = source.slice(inventoryStart, source.indexOf("bool NormalizePendingSource(", inventoryStart));
  const normalize = source.slice(normalizeStart, normalizeEnd);
  const initialize = source.slice(initializeStart, initializeEnd);

  assert.match(
    inventory,
    /pending_operation_directory\s*\?[^:]+:[^;]+[\s\S]*?SetPendingNormalizationSource\([\s\S]*?if \(ParseRecordComponent\([\s\S]*?\(!pending_operation_directory &&\s*!RegisterPublicationSequence/u,
    "the complete child under a pending parent remains the sole provisional N+1 source",
  );
  const pendingBranch = normalize.indexOf("if (pending_record) {");
  const childPromotion = normalize.indexOf("PromoteProtectedExistingFile(", pendingBranch);
  const restartCut = normalize.indexOf("return true;", childPromotion);
  const parentCapture = normalize.indexOf("CaptureDirectoryMoveAuthority(", restartCut);
  const parentPromotion = normalize.indexOf("MoveDirectoryWithCapturedAuthority(", parentCapture);
  assert.ok(pendingBranch >= 0 && childPromotion > pendingBranch);
  assert.ok(
    restartCut > childPromotion && parentCapture > restartCut && parentPromotion > parentCapture,
    "pending child promotion must return before the pending parent captured-authority move",
  );
  assert.ok(
    normalize.indexOf("publication_sequence != state->next_publication_sequence") < pendingBranch,
    "both pending-child and final-child passes require exact N+1 authority",
  );

  const normalizeSource = initialize.indexOf("if (pending_source_count != 0U) {");
  const normalizeCall = initialize.indexOf("const bool normalized = NormalizePendingSource(", normalizeSource);
  const closeAfterMutation = initialize.indexOf("CloseProtectedOperations(state);", normalizeCall);
  const restartFlag = initialize.indexOf("*restart_required = true;", closeAfterMutation);
  const restart = initialize.indexOf("return true;", restartFlag);
  assert.ok(normalizeSource >= 0 && normalizeCall > normalizeSource);
  assert.ok(
    closeAfterMutation > normalizeCall && restartFlag > closeAfterMutation && restart > restartFlag,
    "each provisional mutation closes and restarts full inventory before the next mutation",
  );
  assert.equal(
    initialize.slice(normalizeSource, restart).split("NormalizePendingSource(").length - 1,
    1,
    "one startup pass performs exactly one provisional normalization",
  );
});

test("phase-A inventory validates every finalized local chain before normalization", () => {
  const source = fs.readFileSync(protectedOperationsSourcePath, "utf8");
  const inventoryStart = source.indexOf("bool InventoryOperationPublications(");
  const inventoryEnd = source.indexOf("bool NormalizePendingSource(", inventoryStart);
  const initializeStart = source.indexOf("static bool InitializeProtectedOperationsOnce(");
  const initializeEnd = source.indexOf("bool InitializeProtectedOperations(", initializeStart);
  assert.ok(inventoryStart >= 0 && inventoryEnd > inventoryStart);
  assert.ok(initializeStart >= 0 && initializeEnd > initializeStart);
  const inventory = source.slice(inventoryStart, inventoryEnd);
  const initialize = source.slice(initializeStart, initializeEnd);
  for (const fragment of [
    "std::array<JournalRecord, kMaximumJournalRecordsPerOperation> final_records{}",
    "encoded_sequence >= final_records.size()",
    "final_record_present[encoded_sequence]",
    "final_record_count != 0U",
    "!final_record_present[sequence]",
    "ValidatePreparedRecordAuthority(final_records[0], operation_id)",
    "ValidateJournalTransition(\n              final_records[0],\n              final_records[sequence - 1U],\n              final_records[sequence])",
  ]) {
    assert.equal(inventory.includes(fragment), true, `read-only operation inventory requires ${fragment}`);
  }
  const journalInventory = initialize.indexOf("InventoryOperationPublications(");
  const quarantineInventory = initialize.indexOf("InventoryOperationPublications(", journalInventory + 1);
  const globalFinalize = initialize.indexOf("FinalizePublicationSequenceInventory(", quarantineInventory);
  const normalize = initialize.indexOf("const bool normalized = NormalizePendingSource(", globalFinalize);
  assert.ok(journalInventory >= 0 && quarantineInventory > journalInventory);
  assert.ok(
    globalFinalize > quarantineInventory && normalize > globalFinalize,
    "both physical operation locations validate local chains before global finalize and mutation",
  );
});

test("CREATE candidate closure is exact before final publication and malformed closure takes reason one quarantine", () => {
  const source = fs.readFileSync(protectedOperationsSourcePath, "utf8");
  const closureStart = source.indexOf("bool BuildCandidateClosure(");
  const closureEnd = source.indexOf("bool WriteReadExact(", closureStart);
  const closure = source.slice(closureStart, closureEnd);
  for (const fragment of [
    "constexpr std::array<std::size_t, 5U> kExactLengths",
    "DeriveEd25519KeyMaterial(",
    "Equal(runtime.spki.data(), observed_bytes[1U].data(), 44U)",
    "Equal(admission.spki.data(), observed_bytes[3U].data(), 44U)",
    "Equal(pair_hash.data(), receipt.data() + 416U, 32U)",
    "Equal(receipt_hash.data(), receipt.data() + 608U, 32U)",
    "*complete_five_file_closure = exact",
    "bool final_read_only_validation = false",
    "final_read_only_validation\n              ? ReadProtectedFinalFile(",
    ": ReadProtectedExistingFile(",
  ]) {
    assert.equal(closure.includes(fragment), true, `missing exact candidate validation: ${fragment}`);
  }

  const performStart = source.indexOf("ProtectedOperationResult PerformCreate(");
  const performEnd = source.indexOf("bool ComputeRevokedState(", performStart);
  const perform = source.slice(performStart, performEnd);
  const closeWriters = perform.indexOf("for (HANDLE& file : files)");
  const preMoveClosure = perform.indexOf("BuildCandidateClosure(", closeWriters);
  const parentRename = perform.indexOf("RenameProtectedDirectory(", preMoveClosure);
  const parentClose = perform.indexOf("CloseHandle(candidate_directory)", parentRename);
  const writerReopen = perform.indexOf("OpenProtectedExistingFileForParentRename(", parentClose);
  const writerFlush = perform.indexOf("FlushProtectedOpenFileForParentRename(", writerReopen);
  const finalClosure = perform.indexOf("BuildCandidateClosure(", writerFlush);
  assert.ok(performStart >= 0 && performEnd > performStart);
  assert.ok(closeWriters >= 0 && preMoveClosure > closeWriters);
  assert.ok(parentRename > preMoveClosure && parentClose > parentRename);
  assert.ok(writerReopen > parentClose && writerFlush > writerReopen && finalClosure > writerFlush);
  assert.equal(
    perform.slice(parentClose, writerReopen).includes("OpenProtectedExistingDirectory("),
    false,
    "candidate child writers reopen with no mutable parent handle",
  );
  assert.equal(
    perform.slice(finalClosure, finalClosure + 500).includes("nullptr,\n                  true"),
    true,
    "candidate final closure uses the read-only validation row",
  );

  const quarantineStart = source.indexOf("bool RecoverNonterminalCreateAsQuarantine(");
  const quarantineEnd = source.indexOf("ProtectedOperationResult PerformCreate(", quarantineStart);
  const quarantineOwner = source.slice(quarantineStart, quarantineEnd);
  const requireIncomplete = quarantineOwner.indexOf("complete_closure ||");
  const reasonOne = quarantineOwner.indexOf("1U,\n      &result", requireIncomplete);
  assert.ok(requireIncomplete >= 0 && reasonOne > requireIncomplete);
});

test("QUAR and residue directory moves capture bounded descendants and enforce the eight-stage Option-A order", () => {
  const source = fs.readFileSync(protectedOperationsSourcePath, "utf8");
  const header = fs.readFileSync(path.join(nativeRoot, "src", "protected_operations.hpp"), "utf8");
  const testingStart = header.indexOf("#if defined(GOATCITADEL_PROVISIONER_TESTING)");
  const testingEnd = header.indexOf("#endif", testingStart);
  const testingHeader = header.slice(testingStart, testingEnd);
  for (const symbol of [
    "SetProtectedDirectoryMoveFailureForTest(",
    "ProtectedDirectoryMoveStageForTest()",
    "ProtectedDirectoryMoveErrorForTest()",
    "MoveProtectedDirectoryToQuarantineForTest(",
  ]) {
    assert.equal(testingHeader.includes(symbol), true, `${symbol} remains testing-only`);
  }

  const captureStart = source.indexOf("bool CaptureDirectoryMoveAuthority(");
  const captureEnd = source.indexOf("bool EqualMoveIdentity(", captureStart);
  const capture = source.slice(captureStart, captureEnd);
  const enumerateRoot = capture.indexOf("EnumerateProtectedDirectory(");
  const rootCap = capture.indexOf("root_entry_count > kMaximumMoveRootFiles + 1U", enumerateRoot);
  const candidateCap = capture.indexOf("nested_entry_count <= authority->nested_files.size()", rootCap);
  const validateCandidateNames = capture.indexOf("CandidateMoveMaximumLength(", candidateCap);
  const firstCapture = capture.indexOf("CaptureMoveFileAuthority(", validateCandidateNames);
  const completeCapture = capture.lastIndexOf("RecordDirectoryMoveStep(true, 1U)");
  assert.ok(captureStart >= 0 && captureEnd > captureStart);
  assert.ok(rootCap > enumerateRoot && candidateCap > rootCap);
  assert.ok(
    validateCandidateNames > candidateCap && firstCapture > validateCandidateNames,
    "the complete bounded name/type/length set is rejected before any descendant content read",
  );
  assert.ok(
    completeCapture > firstCapture &&
      capture.slice(0, completeCapture).split("RecordDirectoryMoveStep(true, 1U)").length - 1 === 0,
    "stage one is recorded once only after whole-tree capture",
  );

  const moveStart = source.indexOf("bool MoveDirectoryWithCapturedAuthority(");
  const moveEnd = source.indexOf("void IdentityBytes(", moveStart);
  const move = source.slice(moveStart, moveEnd);
  const orderedFragments = [
    "source_path, authority, false),\n      2U",
    "RenameProtectedDirectory(filesystem, *source_directory, final_path),\n        3U",
    "*source_directory = nullptr;\n  if (moved) moved = RecordDirectoryMoveStep(true, 4U)",
    "ProtectedPathIsAbsentGuarded(filesystem, source_path),\n        5U",
    "final_path, authority, true),\n        6U",
    "ProtectedPathIsAbsentGuarded(filesystem, source_path),\n        7U",
    "RecordDirectoryMoveStep(true, 8U)",
  ];
  let cursor = -1;
  for (const fragment of orderedFragments) {
    const next = move.indexOf(fragment, cursor + 1);
    assert.ok(next > cursor, `missing ordered directory-move stage: ${fragment}`);
    cursor = next;
  }

  const quarantineStart = source.indexOf("ProtectedOperationResult QuarantineFailedCreate(");
  const quarantineEnd = source.indexOf("bool RecoverNonterminalCreateAsQuarantine(", quarantineStart);
  const quarantine = source.slice(quarantineStart, quarantineEnd);
  const closePublished = quarantine.indexOf("CloseHandle(quarantined_file)");
  const captureQuarantine = quarantine.indexOf("CaptureDirectoryMoveAuthority(", closePublished);
  const moveQuarantine = quarantine.indexOf("MoveDirectoryWithCapturedAuthority(", captureQuarantine);
  const setResultLength = quarantine.indexOf("*result_length = kCreateKeysetResultBytes", moveQuarantine);
  const rememberReplay = quarantine.indexOf("RememberReplay(", setResultLength);
  const replayLength = quarantine.indexOf("*result_length);", rememberReplay);
  assert.ok(closePublished >= 0 && captureQuarantine > closePublished);
  assert.ok(moveQuarantine > captureQuarantine);
  assert.ok(
    setResultLength > moveQuarantine && rememberReplay > setResultLength && replayLength > rememberReplay,
    "quarantine replay records the exact nonzero public result length after constructing the result",
  );

  const residueStart = source.indexOf("bool MoveDirectoryToResidue(");
  const residueEnd = source.indexOf("bool MoveFileToResidue(", residueStart);
  const residue = source.slice(residueStart, residueEnd);
  assert.ok(residue.indexOf("CaptureDirectoryMoveAuthority(") >= 0);
  assert.ok(
    residue.indexOf("MoveDirectoryWithCapturedAuthority(") > residue.indexOf("CaptureDirectoryMoveAuthority("),
    "directory residue uses the same captured-authority move owner",
  );
});

test("pending journal records are fully authoritative before any rename or promotion", () => {
  const source = fs.readFileSync(protectedOperationsSourcePath, "utf8");
  const authorityStart = source.indexOf("bool ValidatePreparedRecordAuthority(");
  const authorityEnd = source.indexOf("bool ValidatePendingRecordTransition(", authorityStart);
  const pendingEnd = source.indexOf("bool NormalizePendingOperationDirectory(", authorityEnd);
  const authority = source.slice(authorityStart, authorityEnd);
  const pendingAuthority = source.slice(authorityEnd, pendingEnd);
  for (const fragment of [
    "ValidateJournalRecord(prepared",
    "DecodeCreateKeysetRequest(",
    "DecodeRevokeKeysetRequest(",
    "Equal(request.operation_id.data(), operation_id.data(), 16U)",
  ]) {
    assert.equal(authority.includes(fragment), true, `missing PREPARED authority check: ${fragment}`);
  }
  for (const fragment of [
    "ValidateJournalTransition(prepared, prior, pending)",
    "pending_kind == JournalRecordKind::Committed",
    "pending.bytes.data() + 400U",
    "last_outcome.bytes.data() + 400U",
    "432U",
  ]) {
    assert.equal(
      pendingAuthority.includes(fragment),
      true,
      `missing pending transition/retained outcome check: ${fragment}`,
    );
  }
  const normalizeStart = source.indexOf("bool NormalizePendingOperationDirectory(");
  const normalizeEnd = source.indexOf("bool RecoverResidueProjection(", normalizeStart);
  const normalize = source.slice(normalizeStart, normalizeEnd);
  const readPrepared = normalize.indexOf("ReadJournalRecord(");
  const validatePrepared = normalize.indexOf("ValidatePreparedRecordAuthority(", readPrepared);
  const promotePrepared = normalize.indexOf("PromoteProtectedExistingFile(", validatePrepared);
  const captureOperation = normalize.indexOf("CaptureDirectoryMoveAuthority(", promotePrepared);
  const renameOperation = normalize.indexOf("MoveDirectoryWithCapturedAuthority(", captureOperation);
  assert.ok(readPrepared >= 0);
  assert.ok(validatePrepared > readPrepared);
  assert.ok(promotePrepared > validatePrepared);
  assert.ok(captureOperation > promotePrepared);
  assert.ok(renameOperation > captureOperation);

  const recoverStart = source.indexOf("bool RecoverJournalOperation(");
  const recoverEnd = source.indexOf("bool CreateAndWriteKeyFile(", recoverStart);
  const recover = source.slice(recoverStart, recoverEnd);
  assert.equal(
    recover.includes("Recovery reconstruction is\n  // strictly read-only"),
    true,
    "phase-B reconstruction is explicitly read-only",
  );
  assert.equal(recover.includes("ParsePendingRecordComponent("), true);
  assert.equal(recover.includes("return false;"), true);
  assert.equal(recover.includes("PromoteProtectedExistingFile("), false);
  assert.equal(recover.includes("FlushAndRenameProtectedFile("), false);
  assert.equal(recover.includes("MoveProtectedExistingDirectory("), false);
});

test("journal-side QUARANTINED state is reconstructed canonically before its final move", () => {
  const source = fs.readFileSync(protectedOperationsSourcePath, "utf8");
  const initializeStart = source.indexOf("static bool InitializeProtectedOperationsOnce(");
  const initializeEnd = source.indexOf("bool InitializeProtectedOperations(", initializeStart);
  const initialize = source.slice(initializeStart, initializeEnd);
  const branch = initialize.indexOf(
    "replay_operation.lifecycle !=\n              RecoveryReplayLifecycle::Quarantined",
  );
  const alreadyFinal = initialize.indexOf("if (inventory.quarantine_location)", branch);
  const finalCapture = initialize.indexOf("CaptureDirectoryMoveAuthority(", alreadyFinal);
  const finalContinuation = initialize.indexOf("CompleteCapturedDirectoryAtFinal(", finalCapture);
  const finalReconstruct = initialize.indexOf("LoadRecoveredReplayOperation(", finalContinuation);
  const sourceBranch = initialize.indexOf("RecoveredJournalOperation terminal{}", finalReconstruct);
  const reconstruct = initialize.indexOf(
    "bool moved = LoadRecoveredReplayOperation(state, inventory, &terminal)",
    sourceBranch,
  );
  const revalidate = initialize.indexOf("ClassifyReplayPhysicalEffect(", reconstruct);
  const capture = initialize.indexOf("CaptureDirectoryMoveAuthority(", revalidate);
  const finalMove = initialize.indexOf("MoveDirectoryWithCapturedAuthority(", capture);
  const relocate = initialize.indexOf("relocated_inventory.quarantine_location = true", finalMove);
  const reconstructFinal = initialize.indexOf("LoadRecoveredReplayOperation(", relocate);
  const restart = initialize.indexOf("return restart_after_recovery();", reconstructFinal);
  assert.ok(branch >= 0, "phase A retains terminal quarantined journal operations");
  assert.ok(alreadyFinal > branch && finalCapture > alreadyFinal);
  assert.ok(
    finalContinuation > finalCapture && finalReconstruct > finalContinuation,
    "an already-final QUAR directory completes write flush and final RO before reconstruction",
  );
  assert.ok(reconstruct > branch && revalidate > reconstruct);
  assert.ok(capture > revalidate && finalMove > capture, "phase B revalidates and captures before its final move");
  assert.ok(relocate > finalMove && reconstructFinal > relocate);
  assert.ok(restart > reconstructFinal, "the relocated canonical state is reconstructed before restart");
});

test("recovery filesystem mutations checkpoint STOP and deadline immediately around every durable effect", () => {
  const source = fs.readFileSync(protectedFilesystemSourcePath, "utf8");
  const createDirectoryStart = source.indexOf("bool CreateProtectedDirectory(");
  const createFileStart = source.indexOf("bool CreateProtectedFile(", createDirectoryStart);
  const rawFlushStart = source.indexOf("bool FlushAndRenameProtectedFile(\n    HANDLE", createFileStart);
  const guardedFlushStart = source.indexOf(
    "bool FlushAndRenameProtectedFile(\n    const ProtectedFilesystemState& state",
    rawFlushStart,
  );
  const rawRenameStart = source.indexOf("bool RenameProtectedDirectory(\n    HANDLE", guardedFlushStart);
  const guardedRenameStart = source.indexOf(
    "bool RenameProtectedDirectory(\n    const ProtectedFilesystemState& state",
    rawRenameStart,
  );
  assert.ok(
    createDirectoryStart >= 0 &&
      createFileStart > createDirectoryStart &&
      rawFlushStart > createFileStart &&
      guardedFlushStart > rawFlushStart &&
      rawRenameStart > guardedFlushStart &&
      guardedRenameStart > rawRenameStart,
  );
  const owners = [
    ["create directory", source.slice(createDirectoryStart, createFileStart), "CreateDirectoryW("],
    ["create file", source.slice(createFileStart, rawFlushStart), "CreateFileW("],
    ["guarded file publish", source.slice(guardedFlushStart, rawRenameStart), "RenameNoReplace("],
    [
      "guarded directory publish",
      source.slice(
        guardedRenameStart,
        source.indexOf("void SetProtectedFilesystemFailureForTest(", guardedRenameStart),
      ),
      "RenameNoReplace(",
    ],
  ];
  for (const [label, owner, effect] of owners) {
    const firstCheckpoint = owner.indexOf("ProtectedFilesystemRecoveryCheckpoint(state)");
    const durableEffect = owner.indexOf(effect);
    const checkpointAfter = owner.indexOf("ProtectedFilesystemRecoveryCheckpoint(state)", durableEffect);
    assert.ok(firstCheckpoint >= 0, `${label} has a leading recovery checkpoint`);
    assert.ok(durableEffect > firstCheckpoint, `${label} cannot mutate before its checkpoint`);
    assert.ok(checkpointAfter > durableEffect, `${label} rechecks immediately after its effect`);
  }

  const operations = fs.readFileSync(protectedOperationsSourcePath, "utf8");
  for (const owner of [
    "FlushAndRenameProtectedFile",
    "RenameProtectedDirectory",
    "EnumerateProtectedDirectory",
    "CaptureProtectedObjectIdentity",
    "OpenProtectedExistingDirectory",
    "ReadProtectedExistingFile",
    "PromoteProtectedExistingFile",
    "CaptureDirectoryMoveAuthority",
    "MoveDirectoryWithCapturedAuthority",
  ]) {
    const firstArguments = [...operations.matchAll(new RegExp(`${owner}\\(\\s*([^,\\n]+),`, "gu"))].map((match) =>
      match[1].trim(),
    );
    const productionArguments = firstArguments.filter(
      (argument) => argument !== "const ProtectedFilesystemState& filesystem",
    );
    assert.ok(productionArguments.length > 0, `${owner} has production call sites`);
    assert.equal(
      productionArguments.every(
        (argument) =>
          argument === "filesystem" || argument === "state->filesystem" || argument === "authority->filesystem",
      ),
      true,
      `${owner} production calls must use the guarded filesystem-state overload`,
    );
  }
  assert.equal(
    operations.includes("ProtectedDirectoryIsEmpty("),
    false,
    "recovery does not call the unguarded empty-directory helper",
  );
  assert.equal(
    [...operations.matchAll(/ProtectedDirectoryIsEmptyGuarded\(/gu)].length,
    2,
    "CREATE recovery classification and pre-ATTEMPT validation both use the guarded empty-directory owner",
  );
  for (const effect of ["FlushFileBuffers(", "WriteFile(", "ReadFile(", "SetFilePointerEx("]) {
    const positions = [...operations.matchAll(new RegExp(effect.replace("(", "\\("), "gu"))].map(
      (match) => match.index,
    );
    assert.ok(positions.length > 0, `${effect} has explicit production owners`);
    for (const position of positions) {
      const before = operations.slice(Math.max(0, position - 320), position);
      const after = operations.slice(position, position + 320);
      assert.equal(
        before.includes("ProtectedFilesystemRecoveryCheckpoint("),
        true,
        `${effect} has an immediate leading recovery checkpoint`,
      );
      assert.equal(
        after.includes("ProtectedFilesystemRecoveryCheckpoint("),
        true,
        `${effect} has an immediate trailing recovery checkpoint`,
      );
    }
  }
});

test("PREPARED CREATE recovery reaches the shared selector and publishes authority before its sole entropy call", () => {
  const source = fs.readFileSync(protectedOperationsSourcePath, "utf8");
  const initializeStart = source.indexOf("static bool InitializeProtectedOperationsOnce(");
  const initializeEnd = source.indexOf("bool InitializeProtectedOperations(", initializeStart);
  assert.ok(initializeStart >= 0 && initializeEnd > initializeStart);
  const initialize = source.slice(initializeStart, initializeEnd);
  const selector = initialize.indexOf("const RecoveryAction action = phase_a_replay.nonterminal_action;");
  const createStart = initialize.indexOf(
    "recovered.opcode ==\n      static_cast<std::uint8_t>(Opcode::CreateKeyset)",
    selector,
  );
  const revokeStart = initialize.indexOf(
    "recovered.opcode !=\n      static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)",
    createStart,
  );
  assert.ok(selector >= 0 && createStart > selector && revokeStart > createStart);
  const createRecovery = initialize.slice(createStart, revokeStart);
  const entropyAction = createRecovery.indexOf("action == RecoveryAction::EnsureEmptyCreateThenEntropy");
  const perform = createRecovery.indexOf("PerformCreate(", entropyAction);
  const recoveredArgument = createRecovery.indexOf("&recovered,", perform);
  const recoveryMode = createRecovery.indexOf("true)", recoveredArgument);
  assert.ok(entropyAction >= 0 && perform > entropyAction && recoveredArgument > perform);
  assert.ok(recoveryMode > recoveredArgument, "the shared CREATE owner receives recovered authority in recovery mode");

  const performStart = source.indexOf("ProtectedOperationResult PerformCreate(");
  const performEnd = source.indexOf("bool ComputeRevokedState(", performStart);
  assert.ok(performStart >= 0 && performEnd > performStart);
  const performCreate = source.slice(performStart, performEnd);
  assert.equal(
    performCreate.includes(
      "const std::uint64_t effect_creation_time = recovery == nullptr\n" +
        "      ? creation_time\n" +
        "      : ReadU64(recovery->prepared.bytes.data() + 832U);",
    ),
    true,
    "recovery effects retain the PREPARED creation time",
  );
  const candidateStart = performCreate.indexOf("ProtectedPath candidate_path{}");
  const attemptStart = performCreate.indexOf("JournalRecord attempt{}", candidateStart);
  const entropy = performCreate.indexOf("GenerateCustodyKeyset(", attemptStart);
  assert.ok(candidateStart >= 0 && attemptStart > candidateStart && entropy > attemptStart);
  const beforeAttempt = performCreate.slice(candidateStart, attemptStart);
  for (const forbiddenEffect of [
    "GenerateCustodyKeyset(",
    "CreateAndWriteKeyFile(",
    "FlushAndRenameProtectedFile(",
    "RenameProtectedDirectory(",
  ]) {
    assert.equal(
      beforeAttempt.includes(forbiddenEffect),
      false,
      `CREATE recovery cannot publish ${forbiddenEffect} before its recovery ATTEMPT`,
    );
  }
  for (const requiredGuard of [
    "recovery->candidate_present",
    "OpenProtectedExistingDirectory(",
    "CreateProtectedDirectory(",
    "CaptureProtectedObjectIdentity(",
    "candidate_identity",
  ]) {
    assert.equal(
      beforeAttempt.includes(requiredGuard),
      true,
      `candidate creation or empty-candidate reuse requires ${requiredGuard}`,
    );
  }
  const attemptToEntropy = performCreate.slice(attemptStart, entropy);
  for (const authorityFragment of [
    "recovery == nullptr ? 0U : 1U",
    "recovery == nullptr ? prepared : recovery->prior",
    "recovery == nullptr ? &authenticated_binding : nullptr",
    "recovery == nullptr ? 1U : recovery->next_sequence",
    "PublishJournalRecord(",
  ]) {
    assert.equal(
      attemptToEntropy.includes(authorityFragment),
      true,
      `recovery ATTEMPT authority requires ${authorityFragment}`,
    );
  }
  assert.equal(
    [...performCreate.matchAll(/GenerateCustodyKeyset\(/gu)].length,
    1,
    "PerformCreate contains exactly one entropy call site",
  );
});

test("ordinary journal publications require parent authority and advance only after exact final closure", () => {
  const source = fs.readFileSync(protectedOperationsSourcePath, "utf8");
  const publishStart = source.indexOf("bool PublishJournalRecord(");
  const publishEnd = source.indexOf("struct JournalParentAuthority final", publishStart);
  assert.ok(publishStart >= 0 && publishEnd > publishStart);
  const publish = source.slice(publishStart, publishEnd);
  for (const requiredSignature of [
    "HANDLE parent_authority",
    "const ProtectedObjectIdentity& expected_parent_identity",
  ]) {
    assert.equal(publish.includes(requiredSignature), true, `journal publication requires ${requiredSignature}`);
  }
  const initialParent = publish.indexOf("CaptureProtectedObjectIdentity(");
  const pendingCreate = publish.indexOf("CreateProtectedFile(", initialParent);
  const publicationStageOne = publish.indexOf("RecordJournalPublicationStep(", pendingCreate);
  const publishRename = publish.indexOf("FlushAndRenameProtectedFile(", publicationStageOne);
  const nonRetainedBranch = publish.indexOf("if (!retain) {", publicationStageOne);
  const writerClose = publish.indexOf("CloseHandle(file)", nonRetainedBranch);
  const finalRead = publish.indexOf("ReadProtectedFinalFile(", writerClose);
  const finalIdentity = publish.indexOf("EqualMoveIdentity(final_identity, published_identity)", finalRead);
  const finalBytes = publish.indexOf("Equal(final_bytes.data(), record.bytes.data(), final_length)", finalIdentity);
  const finalHash = publish.indexOf("Equal(final_hash.data(), published_hash.data(), final_hash.size())", finalBytes);
  const pendingAbsent = publish.indexOf("ProtectedPathIsAbsentGuarded(filesystem, pending_path)", finalHash);
  const finalParent = publish.indexOf("CaptureProtectedObjectIdentity(", pendingAbsent);
  const retainedTransfer = publish.indexOf("*retained = file", finalParent);
  const sequenceAdvance = publish.indexOf("++state->next_publication_sequence", retainedTransfer);
  const terminalStage = publish.indexOf("g_journal_publication_stage = 5U", sequenceAdvance);
  assert.ok(initialParent >= 0 && pendingCreate > initialParent && publicationStageOne > pendingCreate);
  assert.ok(publishRename > publicationStageOne && nonRetainedBranch > publishRename);
  assert.ok(writerClose > nonRetainedBranch);
  assert.ok(finalRead > writerClose && finalIdentity > finalRead && finalBytes > finalIdentity);
  assert.ok(finalHash > finalBytes && pendingAbsent > finalHash && finalParent > pendingAbsent);
  assert.ok(retainedTransfer > finalParent && sequenceAdvance > retainedTransfer && terminalStage > sequenceAdvance);

  const parseCall = (start) => {
    let depth = 0;
    for (let index = start + "PublishJournalRecord".length; index < source.length; ++index) {
      if (source[index] === "(") depth += 1;
      else if (source[index] === ")") {
        depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
      }
    }
    throw new Error("unterminated PublishJournalRecord call");
  };
  const directCalls = [...source.matchAll(/PublishJournalRecord\(/gu)]
    .map((match) => match.index)
    .filter((index) => !source.slice(Math.max(0, index - 5), index).includes("bool "));
  assert.ok(directCalls.length > 0);
  for (const callStart of directCalls) {
    const call = parseCall(callStart);
    let depth = 0;
    let arguments_ = 1;
    for (const character of call.slice(call.indexOf("(") + 1, -1)) {
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      else if (character === "," && depth === 0) arguments_ += 1;
    }
    assert.equal(arguments_, 9, "every direct journal publication supplies exact borrowed parent authority");
  }
});

test("REVOKE regenerate and promote paths converge on exact final authority before state or outcome", () => {
  const source = fs.readFileSync(protectedOperationsSourcePath, "utf8");
  const performStart = source.indexOf("ProtectedOperationResult PerformRevoke(");
  const performEnd = source.indexOf("}  // namespace", performStart);
  assert.ok(performStart >= 0 && performEnd > performStart);
  const revoke = source.slice(performStart, performEnd);
  const regenerate = revoke.indexOf("if (regenerate) {");
  const regenerateWrite = revoke.indexOf("WriteReadExact(", regenerate);
  const regeneratePublish = revoke.indexOf("FlushAndRenameProtectedFile(", regenerateWrite);
  const promoteBranch = revoke.indexOf("} else if (promote_existing) {", regeneratePublish);
  const promote = revoke.indexOf("PromoteProtectedExistingFile(", promoteBranch);
  const promotedIdentity = revoke.indexOf("Equal(\n            promoted_identity.file_id.data()", promote);
  const writerClose = revoke.indexOf("if (control_file != nullptr) CloseHandle(control_file);", promote);
  const finalRead = revoke.indexOf("ReadProtectedFinalFile(", writerClose);
  const exactLength = revoke.indexOf("final_control_length == final_control.size()", finalRead);
  const exactIdentity = revoke.indexOf("EqualMoveIdentity(final_control_identity, control_identity)", exactLength);
  const exactBytes = revoke.indexOf("Equal(final_control.data(), control.data(), control.size())", exactIdentity);
  const exactHash = revoke.indexOf(
    "Equal(final_control_hash.data(), control_hash.data(), control_hash.size())",
    exactBytes,
  );
  const embeddedHash = revoke.indexOf("final_control.data() + 224U", exactHash);
  const sourceAbsent = revoke.indexOf("ProtectedPathIsAbsentGuarded(", embeddedHash);
  const pendingSource = revoke.indexOf("pending_control_path", sourceAbsent);
  const parentCapture = revoke.indexOf("CaptureProtectedObjectIdentity(", pendingSource);
  const parentIdentity = revoke.indexOf("state->filesystem.controls_identity", parentCapture);
  const compute = revoke.indexOf("ComputeRevokedState(", parentIdentity);
  const outcome = revoke.indexOf("std::array<std::uint8_t, 432U> outcome_fields{}", compute);
  assert.ok(regenerate >= 0 && regenerateWrite > regenerate && regeneratePublish > regenerateWrite);
  assert.ok(promoteBranch > regeneratePublish && promote > promoteBranch && promotedIdentity > promote);
  assert.ok(writerClose > promotedIdentity && finalRead > writerClose && exactLength > finalRead);
  assert.ok(exactIdentity > exactLength && exactBytes > exactIdentity && exactHash > exactBytes);
  assert.ok(
    embeddedHash > exactHash &&
      sourceAbsent > embeddedHash &&
      pendingSource > sourceAbsent &&
      parentCapture > pendingSource,
  );
  assert.ok(parentIdentity > parentCapture && compute > parentIdentity && outcome > compute);
});

test("PREP, bootstrap, CREATE, and REVOKE final-only restart paths complete role-specific authority before recovery commit", () => {
  const source = fs.readFileSync(protectedOperationsSourcePath, "utf8");
  const createHelperStart = source.indexOf("bool CompleteFinalCreateKeysetDirectory(");
  const createHelperEnd = source.indexOf("void IdentityBytes(", createHelperStart);
  assert.ok(createHelperStart >= 0 && createHelperEnd > createHelperStart);
  const createHelper = source.slice(createHelperStart, createHelperEnd);
  const createFinalOpen = createHelper.indexOf("OpenProtectedExistingDirectory(");
  const createCapture = createHelper.indexOf("CaptureDirectoryMoveAuthority(", createFinalOpen);
  const createComplete = createHelper.indexOf("CompleteCapturedDirectoryAtFinal(", createCapture);
  const createSourceAbsent = createHelper.indexOf("ProtectedPathIsAbsentGuarded(", createComplete);
  assert.ok(createFinalOpen >= 0 && createCapture > createFinalOpen);
  assert.ok(createComplete > createCapture && createSourceAbsent > createComplete);

  const revokeHelperStart = source.indexOf("bool CompleteFinalRevokeControlAuthority(");
  const revokeHelperEnd = source.indexOf("ProtectedOperationResult QuarantineFailedCreate(", revokeHelperStart);
  assert.ok(revokeHelperStart >= 0 && revokeHelperEnd > revokeHelperStart);
  const revokeHelper = source.slice(revokeHelperStart, revokeHelperEnd);
  const initialRead = revokeHelper.indexOf("ReadProtectedFinalFile(");
  const writerOpen = revokeHelper.indexOf("OpenProtectedExistingFileForParentRename(", initialRead);
  const writerFlush = revokeHelper.indexOf("FlushProtectedOpenFileForParentRename(", writerOpen);
  const writerClose = revokeHelper.indexOf("CloseHandle(writer)", writerFlush);
  const finalRead = revokeHelper.indexOf("ReadProtectedFinalFile(", writerClose);
  const sourceAbsent = revokeHelper.indexOf("ProtectedPathIsAbsentGuarded(", finalRead);
  const parentCapture = revokeHelper.indexOf("CaptureProtectedObjectIdentity(", sourceAbsent);
  const parentIdentity = revokeHelper.indexOf("state->filesystem.controls_identity", parentCapture);
  const outputIdentity = revokeHelper.indexOf("*completed_identity = initial_identity", parentIdentity);
  const outputHash = revokeHelper.indexOf("*completed_hash = initial_hash", outputIdentity);
  assert.ok(initialRead >= 0 && writerOpen > initialRead && writerFlush > writerOpen);
  assert.ok(writerClose > writerFlush && finalRead > writerClose && sourceAbsent > finalRead);
  assert.ok(parentCapture > sourceAbsent && parentIdentity > parentCapture);
  assert.ok(outputIdentity > parentIdentity && outputHash > outputIdentity);

  const preparedHelperStart = source.indexOf("bool CompleteFinalPreparedOperationDirectory(");
  const preparedHelperEnd = source.indexOf("ProtectedOperationResult QuarantineFailedCreate(", preparedHelperStart);
  assert.ok(preparedHelperStart >= 0 && preparedHelperEnd > preparedHelperStart);
  const preparedHelper = source.slice(preparedHelperStart, preparedHelperEnd);
  const preparedParentInitial = preparedHelper.indexOf("state->filesystem.journal_identity");
  const preparedCapture = preparedHelper.indexOf("CaptureDirectoryMoveAuthority(", preparedParentInitial);
  const preparedComplete = preparedHelper.indexOf("CompleteCapturedDirectoryAtFinal(", preparedCapture);
  const preparedSourceAbsent = preparedHelper.indexOf("ProtectedPathIsAbsentGuarded(", preparedComplete);
  const preparedParentFinal = preparedHelper.indexOf("CaptureProtectedObjectIdentity(", preparedSourceAbsent);
  const preparedRevalidate = preparedHelper.indexOf("RecoverJournalOperation(", preparedParentFinal);
  assert.ok(preparedParentInitial >= 0 && preparedCapture > preparedParentInitial);
  assert.ok(preparedComplete > preparedCapture && preparedSourceAbsent > preparedComplete);
  assert.ok(preparedParentFinal > preparedSourceAbsent && preparedRevalidate > preparedParentFinal);

  const bootstrapHelperStart = source.indexOf("bool CompleteFinalBootstrapResidueDirectory(");
  const bootstrapHelperEnd = source.indexOf("ProtectedOperationResult QuarantineFailedCreate(", bootstrapHelperStart);
  assert.ok(bootstrapHelperStart >= 0 && bootstrapHelperEnd > bootstrapHelperStart);
  const bootstrapHelper = source.slice(bootstrapHelperStart, bootstrapHelperEnd);
  const quarantineInitial = bootstrapHelper.indexOf("state->filesystem.quarantine_identity");
  const journalInitial = bootstrapHelper.indexOf("state->filesystem.journal_identity", quarantineInitial);
  const bootstrapCapture = bootstrapHelper.indexOf("CaptureDirectoryMoveAuthority(", journalInitial);
  const bootstrapClosure = bootstrapHelper.indexOf("expected_residue.bytes.data() + 28U", bootstrapCapture);
  const bootstrapComplete = bootstrapHelper.indexOf("CompleteCapturedDirectoryAtFinal(", bootstrapClosure);
  const pendingAbsent = bootstrapHelper.indexOf(
    "ProtectedPathIsAbsentGuarded(state->filesystem, pending_path)",
    bootstrapComplete,
  );
  const operationAbsent = bootstrapHelper.indexOf(
    "ProtectedPathIsAbsentGuarded(state->filesystem, operation_path)",
    pendingAbsent,
  );
  const quarantineFinal = bootstrapHelper.indexOf("CaptureProtectedObjectIdentity(", operationAbsent);
  const journalFinal = bootstrapHelper.indexOf("CaptureProtectedObjectIdentity(", quarantineFinal + 1);
  const residueRevalidate = bootstrapHelper.indexOf("RecoverResidueProjection(", journalFinal);
  assert.ok(quarantineInitial >= 0 && journalInitial > quarantineInitial && bootstrapCapture > journalInitial);
  assert.ok(bootstrapClosure > bootstrapCapture && bootstrapComplete > bootstrapClosure);
  assert.ok(pendingAbsent > bootstrapComplete && operationAbsent > pendingAbsent);
  assert.ok(quarantineFinal > operationAbsent && journalFinal > quarantineFinal);
  assert.ok(residueRevalidate > journalFinal);

  const initializeStart = source.indexOf("static bool InitializeProtectedOperationsOnce(");
  const initializeEnd = source.indexOf("bool InitializeProtectedOperations(", initializeStart);
  assert.ok(initializeStart >= 0 && initializeEnd > initializeStart);
  const initialize = source.slice(initializeStart, initializeEnd);
  const phaseBProjection = initialize.indexOf("CopyRecoveryProjectionState(");
  const bootstrapCompletion = initialize.indexOf("CompleteFinalBootstrapResidueDirectory(", phaseBProjection);
  const phaseBNonterminal = initialize.indexOf("if (!phase_a_replay.nonterminal_present)", bootstrapCompletion);
  assert.ok(phaseBProjection >= 0 && bootstrapCompletion > phaseBProjection);
  assert.ok(phaseBNonterminal > bootstrapCompletion);
  const preparedAction = initialize.indexOf("if (recovered.attempt_count == 0U &&");
  const preparedCompletion = initialize.indexOf("CompleteFinalPreparedOperationDirectory(", preparedAction);
  const bodyDecode = initialize.indexOf("const std::uint16_t body_length", preparedCompletion);
  assert.ok(preparedAction >= 0 && preparedCompletion > preparedAction && bodyDecode > preparedCompletion);
  const createFinalAction = initialize.indexOf("action == RecoveryAction::AppendAttemptThenFinishFinal ||");
  const createCompletion = initialize.indexOf("CompleteFinalCreateKeysetDirectory(", createFinalAction);
  const createCommit = initialize.indexOf("RecoverCommittedCreate(", createCompletion);
  const revokeFinalAction = initialize.indexOf(
    "if (action == RecoveryAction::AppendAttemptThenFinishFinal) {",
    createCommit,
  );
  const revokeCompletion = initialize.indexOf("CompleteFinalRevokeControlAuthority(", revokeFinalAction);
  const revokeCommit = initialize.indexOf("RecoverCommittedRevoke(", revokeCompletion);
  const completedIdentity = initialize.indexOf("&completed_control_identity", revokeCommit);
  const completedHash = initialize.indexOf("&completed_control_hash", completedIdentity);
  assert.ok(createFinalAction >= 0 && createCompletion > createFinalAction && createCommit > createCompletion);
  assert.ok(revokeFinalAction > createCommit && revokeCompletion > revokeFinalAction);
  assert.ok(revokeCommit > revokeCompletion && completedIdentity > revokeCommit && completedHash > completedIdentity);
});

test("frozen Monocypher receipt, source tuples, and directory closure validate exactly", () => {
  const result = validateMonocypherSourceSnapshot(monocypherVendorRoot);
  assert.equal(result.version, "4.0.3");
  assert.equal(result.archive.bytes, 940_390);
  assert.equal(result.archive.sha256, "8cc9bc341a66249016db9bd70e9142d8d0aef9945973744b1ac05dbc55d8ee66");
  assert.match(result.receiptSha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.files.length, 5);

  const receiptMutation = path.join(temporaryRoot, "monocypher-receipt-mutation");
  fs.cpSync(monocypherVendorRoot, receiptMutation, { recursive: true, errorOnExist: true });
  fs.appendFileSync(path.join(receiptMutation, "GOATCITADEL_SOURCE_RECEIPT.json"), " ");
  assert.throws(() => validateMonocypherSourceSnapshot(receiptMutation), /exact bounded size|receipt differs/u);

  const extraEntry = path.join(temporaryRoot, "monocypher-extra-entry");
  fs.cpSync(monocypherVendorRoot, extraEntry, { recursive: true, errorOnExist: true });
  fs.writeFileSync(path.join(extraEntry, "UNAUTHORIZED"), "x", { flag: "wx" });
  assert.throws(() => validateMonocypherSourceSnapshot(extraEntry), /directory closure differs/u);

  const sourceMutation = path.join(temporaryRoot, "monocypher-source-mutation");
  fs.cpSync(monocypherVendorRoot, sourceMutation, { recursive: true, errorOnExist: true });
  fs.appendFileSync(path.join(sourceMutation, "src", "monocypher.c"), "\n");
  assert.throws(() => validateMonocypherSourceSnapshot(sourceMutation), /exact bounded size|official release tuple/u);

  const redirectedRoot = path.join(temporaryRoot, "monocypher-redirected-root");
  fs.symlinkSync(monocypherVendorRoot, redirectedRoot, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => validateMonocypherSourceSnapshot(redirectedRoot),
    /original Monocypher source snapshot root|resolves through/u,
  );
});

test("Node produces the exact fixed 72-byte RFC 8032 interoperability frame", () => {
  const frame = createFixedEd25519InteropFrame();
  assert.equal(frame.length, 72);
  assert.equal(frame.subarray(0, 8).toString("hex"), "4743454901004000");
  assert.equal(
    frame.subarray(8).toString("hex"),
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  );
});

test("Node verifies every canonical W1B1B-P0 protected-signing interoperability receipt", () => {
  const publicKey = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
  const cases = [
    [
      "runtime-manifest",
      0,
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    ],
    [
      "runtime-manifest",
      1,
      "c62cd6daaefc806a9307e259d7c03bc422b97d37ed627526b52acc260a5457ba104f8e1ed2332fdc997dbc264aec3562067ba3f9da3c04e49573570a34ef070b",
    ],
    [
      "runtime-manifest",
      65_535,
      "242524eb90116157cb109aeb5fb00876f05fca7af687da8529234aa2b8d4566f3106c07621a8e41fbe14cda2913a1fac7062839679e584cc1a7ea541a9210a00",
    ],
    [
      "runtime-manifest",
      65_536,
      "44237e1d28a7f64bc8c1fcba6bdff55a7446596aae15dc225318a99429a2c0f77d9c43172f0315d6a1fcf55c4caa316e338189e694d6993579cd6376c7b0ca01",
    ],
    [
      "runtime-manifest",
      65_537,
      "f7bc4cb11cd902820c80e2940070a53fffd0f2d5b515081d589ab9c674d57b35bbfe017319da89c88148b4190348270eff0ae27dd2cd22b07843af362efa9908",
    ],
    [
      "runtime-manifest",
      524_288,
      "7a089aadcdc7968cc6a8d7d1c9ded0251df8a8f3720711f2d986346d1375ca63e0d2211704d4fa437d15a691376178d085d38087b1394d8fe7f2d52684b88007",
    ],
    [
      "admission-evidence",
      8_388_608,
      "36b3b8971c86752f32f4b0fcfd7415a976ebb07d0746c77d4a7f3cab52c188e3efff813a0cf06458d84f0c38147e38ed4c8321b39ffdb1612e52603aba09f707",
    ],
  ];
  const protectedReceipts = cases
    .map(
      ([purpose, length, signature]) =>
        "GCPW_PROTECTED_SIGNING_INTEROP " +
        `schema=goatcitadel.remote-worker.protected-signing-interop.v1 purpose=${purpose} ` +
        `length=${length} pattern_seed=49 public_key=${publicKey} signature=${signature}\n`,
    )
    .join("");
  const stdout =
    `GCPW_ED25519_INTEROP public=${publicKey} ` +
    "signature=e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555" +
    "fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b\n" +
    protectedReceipts +
    "GCPW_NATIVE_TESTS seed=0x47504357 cases=65536\n";
  const verified = verifyProtectedSigningInteropReceipts(stdout);
  assert.equal(verified.schema, "goatcitadel.remote-worker.protected-signing-interop.v1");
  assert.equal(verified.publicKey, publicKey);
  assert.deepEqual(
    verified.cases.map(({ purpose, length, patternSeed, verified: passed }) => ({
      purpose,
      length,
      patternSeed,
      verified: passed,
    })),
    cases.map(([purpose, length]) => ({ purpose, length, patternSeed: 49, verified: true })),
  );
  assert.throws(
    () => verifyProtectedSigningInteropReceipts(stdout.replace("length=65536", "length=65538")),
    /changed its fixed authority/u,
  );
  assert.throws(() => verifyProtectedSigningInteropReceipts(stdout.replace("36b3b897", "06b3b897")), /Node rejected/u);
});

test("link-map normalization ignores only ICF-selected synthetic constant owners", () => {
  const first = " 0002:00001a20       __xmm@00000000000000010000000000000000 0000000140016a20     local_transport.obj";
  const second = " 0002:00001a20       __xmm@00000000000000010000000000000000 0000000140016a20     protocol.obj";
  assert.equal(normalizeLinkMapIcfConstantOwners(first), normalizeLinkMapIcfConstantOwners(second));
  assert.notEqual(
    normalizeLinkMapIcfConstantOwners(first),
    normalizeLinkMapIcfConstantOwners(second.replace("0000000140016a20", "0000000140016a30")),
  );
  const ordinary =
    " 0001:00000000       ?RunKnownAnswerSelfTest@remote_worker_provisioner@goatcitadel@@YA_NXZ 0000000140001000 service_runtime.obj";
  assert.equal(normalizeLinkMapIcfConstantOwners(ordinary), ordinary);
});

test("adapter callgraph proof rejects unowned headers, overloads, mnemonics, and address-taking relocations", () => {
  const pureSymbol =
    "?PureEd25519Sign@?A0xfa045e67@remote_worker_provisioner@goatcitadel@@YA_NPEAV?$array@E$0EA@@std@@AEBV45@PEBE_K@Z";
  const pureHeader =
    `${pureSymbol} (bool __cdecl goatcitadel::remote_worker_provisioner::` +
    "`anonymous namespace'::PureEd25519Sign(class std::array<unsigned char,64> *,class std::array<unsigned char,64> const &,unsigned char const *,unsigned __int64)):";
  const katSymbol = "?RunKnownAnswerSelfTest@remote_worker_provisioner@goatcitadel@@YA_NXZ";
  const katHeader =
    `${katSymbol} ` + "(bool __cdecl goatcitadel::remote_worker_provisioner::RunKnownAnswerSelfTest(void)):";
  const x64Disassembly = [
    pureHeader,
    "  00000000: call crypto_ed25519_check",
    katHeader,
    "  00000010: call crypto_ed25519_check",
  ].join("\n");
  const x64Relocations = [
    " 00000236  REL32                      00000000        CF  crypto_ed25519_check",
    " 0000022D  REL32                      00000000        CF  crypto_ed25519_check",
    "0CF 00000000 UNDEF  notype ()    External     | crypto_ed25519_check",
  ].join("\n");
  const x64 = inspectAdapterCheckCallgraph(x64Disassembly, x64Relocations, "windows-x64");
  assert.deepEqual(
    {
      callCount: x64.callCount,
      mnemonic: x64.mnemonic,
      relocation: x64.relocation,
      relocationCount: x64.relocationCount,
      addressTaken: x64.addressTaken,
    },
    { callCount: 2, mnemonic: "call", relocation: "REL32", relocationCount: 2, addressTaken: false },
  );

  const bareHelperBypass = [
    pureHeader,
    "evil_c_helper:",
    "  00000000: call crypto_ed25519_check",
    katHeader,
    "  00000010: call crypto_ed25519_check",
  ].join("\n");
  assert.throws(
    () => inspectAdapterCheckCallgraph(bareHelperBypass, x64Relocations, "windows-x64"),
    /not exactly the fixed post-sign\/KAT pair/u,
  );

  const wrongSymbol = "?PureEd25519Sign@?A0xfa045e67@remote_worker_provisioner@goatcitadel@@YA_NH@Z";
  const wrongOverload = [
    `${wrongSymbol} (bool __cdecl goatcitadel::remote_worker_provisioner::` +
      "`anonymous namespace'::PureEd25519Sign(int)):",
    "  00000000: call crypto_ed25519_check",
    katHeader,
    "  00000010: call crypto_ed25519_check",
  ].join("\n");
  assert.throws(
    () => inspectAdapterCheckCallgraph(wrongOverload, x64Relocations, "windows-x64"),
    /not exactly the fixed post-sign\/KAT pair/u,
  );
  assert.throws(
    () => inspectAdapterCheckCallgraph(x64Disassembly, x64Relocations.replace("REL32", "ADDR64"), "windows-x64"),
    /not exactly the fixed post-sign\/KAT pair/u,
  );
  assert.throws(
    () => inspectAdapterCheckCallgraph(x64Disassembly, x64Relocations, "windows-arm64"),
    /not exactly the fixed post-sign\/KAT pair/u,
  );

  const arm64Disassembly = x64Disassembly.replaceAll("call crypto_ed25519_check", "bl crypto_ed25519_check");
  const arm64Relocations = [
    " 000001B0  BRANCH26                   94000000        CB  crypto_ed25519_check",
    " 000001A0  BRANCH26                   94000000        CB  crypto_ed25519_check",
    "0CB 00000000 UNDEF  notype ()    External     | crypto_ed25519_check",
  ].join("\n");
  const arm64 = inspectAdapterCheckCallgraph(arm64Disassembly, arm64Relocations, "windows-arm64");
  assert.equal(arm64.mnemonic, "bl");
  assert.equal(arm64.relocation, "BRANCH26");

  const linkedMap = [
    " 0001:00000000       crypto_ed25519_check       0000000140001000 f   monocypher-ed25519.obj",
    ` 0001:00001000       ${pureSymbol} 0000000140002000 f   ed25519-runtime.obj`,
    " 0001:00001100       ?AfterPure@@YAXXZ 0000000140002100 f   service_runtime.obj",
    ` 0001:00001200       ${katSymbol} 0000000140002200 f   ed25519-runtime.obj`,
    " 0001:00001300       ?AfterKat@@YAXXZ 0000000140002300 f   service_runtime.obj",
  ].join("\n");
  const linkedX64Disassembly = [
    "  0000000140001000: 4C 8B DC           mov         r11,rsp",
    "  0000000140002008: E8 F3 EF FF FF     call        0000000140001000",
    "  0000000140002208: E8 F3 ED FF FF     call        0000000140001000",
  ].join("\n");
  const linkedX64 = inspectLinkedCheckCallgraph(linkedMap, linkedX64Disassembly, "windows-x64");
  assert.equal(linkedX64.callCount, 2);
  assert.equal(linkedX64.mnemonic, "call");
  assert.equal(linkedX64.targetAddress, "0000000140001000");
  assert.deepEqual(
    linkedX64.callers.map((entry) => entry.name),
    ["PureEd25519Sign", "RunKnownAnswerSelfTest"],
  );
  assert.throws(
    () =>
      inspectLinkedCheckCallgraph(
        linkedMap.replace(` 0001:00001000       ${pureSymbol} 0000000140002000 f   ed25519-runtime.obj\n`, ""),
        linkedX64Disassembly,
        "windows-x64",
      ),
    /does not retain one exact/u,
  );
  assert.throws(
    () =>
      inspectLinkedCheckCallgraph(
        linkedMap,
        `${linkedX64Disassembly}\n  0000000140002308: E8 F3 EC FF FF     call        0000000140001000`,
        "windows-x64",
      ),
    /does not retain exactly two direct/u,
  );
  const linkedArm64Disassembly = [
    "  0000000140001000: A9BE7BFD  stp         fp,lr,[sp,#-0x20]!",
    "  0000000140002008: 97FFFBFE  bl          0000000140001000",
    "  0000000140002208: 97FFFB7E  bl          0000000140001000",
  ].join("\n");
  const linkedArm64 = inspectLinkedCheckCallgraph(linkedMap, linkedArm64Disassembly, "windows-arm64");
  assert.equal(linkedArm64.callCount, 2);
  assert.equal(linkedArm64.mnemonic, "bl");
});

test("W1B1B-P0 object callgraph proof fixes passkey owner, bridge owners, counts, and relocation-only calls", () => {
  const bridgeNames = [
    "ExpandEd25519SeedForProtectedSigning",
    "ReduceEd25519ScalarForProtectedSigning",
    "Ed25519ScalarBaseForProtectedSigning",
    "Ed25519MulAddForProtectedSigning",
    "CheckEd25519EquationForProtectedSigning",
  ];
  const signingCounts = new Map([
    [bridgeNames[0], 1],
    [bridgeNames[1], 3],
    [bridgeNames[2], 1],
    [bridgeNames[3], 1],
    [bridgeNames[4], 1],
  ]);
  const primitiveCounts = new Map([
    ["crypto_sha512", 2],
    ["crypto_eddsa_trim_scalar", 2],
    ["crypto_eddsa_scalarbase", 3],
    ["crypto_eddsa_reduce", 2],
    ["crypto_eddsa_mul_add", 2],
    ["crypto_eddsa_check_equation", 1],
  ]);
  const bridgeOwnerCalls = new Map([
    [bridgeNames[0], ["crypto_sha512", "crypto_eddsa_trim_scalar", "crypto_eddsa_scalarbase"]],
    [bridgeNames[1], ["crypto_eddsa_reduce"]],
    [bridgeNames[2], ["crypto_eddsa_scalarbase"]],
    [bridgeNames[3], ["crypto_eddsa_mul_add"]],
    [bridgeNames[4], ["crypto_eddsa_check_equation"]],
  ]);
  for (const [target, mnemonic, relocation] of [
    ["windows-x64", "call", "REL32"],
    ["windows-arm64", "bl", "BRANCH26"],
  ]) {
    const signingSymbols = new Map(bridgeNames.map((name) => [name, `?${name}@remote_worker@goatcitadel@@YAXXZ`]));
    const signingDisassembly = [
      "?SignProtectedArtifact@remote_worker@goatcitadel@@YA_NXZ (bool __cdecl goatcitadel::remote_worker::SignProtectedArtifact(void)):",
      ...bridgeNames.flatMap((name) =>
        Array.from(
          { length: signingCounts.get(name) },
          (_, index) => `  000000${index}: ${mnemonic} ${signingSymbols.get(name)}`,
        ),
      ),
    ].join("\n");
    const signingRelocations = [...signingSymbols.entries()]
      .flatMap(([name, symbol]) => [
        ...Array.from(
          { length: signingCounts.get(name) },
          (_, index) => ` 0000000${index} ${relocation} 00000000 0 ${symbol}`,
        ),
        `001 00000000 UNDEF notype () External | ${symbol}`,
      ])
      .join("\n");
    const signing = inspectProtectedArtifactSigningCallgraph(signingDisassembly, signingRelocations, target);
    assert.equal(signing.owners.length, 1);
    assert.equal(signing.passkeyOwner, "SignProtectedArtifact");
    assert.equal(signing.passkeyType, "ProtectedEd25519SigningBridgeKey");
    assert.equal(signing.addressTaken, false);

    const bridgeDisassemblyLines = [];
    for (const [owner, calls] of bridgeOwnerCalls) {
      bridgeDisassemblyLines.push(
        `?${owner}@remote_worker@goatcitadel@@YAXXZ (void __cdecl goatcitadel::remote_worker::${owner}(void)):`,
      );
      for (const primitive of calls) bridgeDisassemblyLines.push(`  00000000: ${mnemonic} ${primitive}`);
    }
    bridgeDisassemblyLines.push("?LegacyEd25519Owner@@YAXXZ (void __cdecl LegacyEd25519Owner(void)):");
    for (const primitive of [
      "crypto_sha512",
      "crypto_eddsa_trim_scalar",
      "crypto_eddsa_scalarbase",
      "crypto_eddsa_reduce",
      "crypto_eddsa_mul_add",
    ]) {
      bridgeDisassemblyLines.push(`  00000000: ${mnemonic} ${primitive}`);
    }
    const bridgeRelocations = [...primitiveCounts.entries()]
      .flatMap(([primitive, count]) => [
        ...Array.from({ length: count }, (_, index) => ` 0000000${index} ${relocation} 00000000 0 ${primitive}`),
        `001 00000000 UNDEF notype () External | ${primitive}`,
      ])
      .join("\n");
    const bridge = inspectProtectedEd25519BridgeCallgraph(bridgeDisassemblyLines.join("\n"), bridgeRelocations, target);
    assert.equal(bridge.owners.length, 5);
    assert.equal(bridge.addressTaken, false);
    assert.throws(
      () =>
        inspectProtectedEd25519BridgeCallgraph(
          bridgeDisassemblyLines.join("\n"),
          bridgeRelocations.replace(relocation, "ADDR64"),
          target,
        ),
      /relocation graph is not exact/u,
    );
  }
});

test("native W1B0 source preserves public inspect and exposes only the fixed protected self-test boundary", () => {
  const source = fs.readFileSync(sourcePath, "utf8");
  const clientSource = fs.readFileSync(clientSourcePath, "utf8");
  const serviceRuntimeSource = fs.readFileSync(serviceRuntimeSourcePath, "utf8");
  const serviceRuntimeHeader = fs.readFileSync(serviceRuntimeHeaderPath, "utf8");
  const localTransportSource = fs.readFileSync(localTransportSourcePath, "utf8");
  const localTransportHeader = fs.readFileSync(localTransportHeaderPath, "utf8");
  const protocolSource = fs.readFileSync(protocolSourcePath, "utf8");
  const protocolHeader = fs.readFileSync(protocolHeaderPath, "utf8");
  const nativeTestSource = fs.readFileSync(nativeTestSourcePath, "utf8");
  const ed25519RuntimeSource = fs.readFileSync(ed25519RuntimeSourcePath, "utf8");
  const ed25519RuntimeHeader = fs.readFileSync(ed25519RuntimeHeaderPath, "utf8");
  const ed25519RuntimeTest = fs.readFileSync(ed25519RuntimeTestPath, "utf8");
  const modeTokens = [...`${source}\n${serviceRuntimeSource}`.matchAll(/L?"(--[A-Za-z0-9-]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual([...new Set(modeTokens)], ["--inspect-stdio"]);
  const clientModeTokens = [...clientSource.matchAll(/L?"(--[A-Za-z0-9-]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(clientModeTokens)], ["--service-stdio"]);
  assert.equal(clientSource.indexOf("if (!locally_valid)") >= 0, true);
  assert.equal(
    clientSource.indexOf("if (!locally_valid)") <
      clientSource.indexOf("RunProtectedClientExchange(request, &exchange)"),
    true,
    "local GCPW rejection must precede every privileged transport attempt",
  );
  for (const fragment of ["ProvisionerEntryPoint", "GetCommandLineW", "RunServiceDispatcher", "ExitProcess"]) {
    assert.equal(source.includes(fragment), true, `missing native W1A service entry boundary: ${fragment}`);
  }
  for (const [value, fragment] of [
    [serviceRuntimeSource, "--inspect-stdio"],
    [clientSource, "ProvisionerClientEntryPoint"],
    [clientSource, "--service-stdio"],
    [serviceRuntimeSource, "StartServiceCtrlDispatcherW"],
    [serviceRuntimeSource, "RegisterServiceCtrlHandlerExW"],
    [serviceRuntimeSource, "SetServiceStatus"],
    [localTransportSource, "kGcpaMagic"],
    [localTransportSource, "PeekNamedPipe"],
  ]) {
    assert.equal(value.includes(fragment), true, `missing native W1A boundary: ${fragment}`);
  }
  const combined = [
    source,
    clientSource,
    serviceRuntimeSource,
    serviceRuntimeHeader,
    localTransportSource,
    localTransportHeader,
    protocolSource,
    protocolHeader,
    ed25519RuntimeSource,
    ed25519RuntimeHeader,
  ].join("\n");
  for (const forbiddenFunction of [
    "CreateServiceW",
    "ChangeServiceConfigW",
    "ChangeServiceConfig2W",
    "DeleteService",
    "StartServiceW",
    "ControlService",
    "AdjustTokenPrivileges",
    "DuplicateToken",
    "DuplicateTokenEx",
    "SetThreadToken",
    "CreateRestrictedToken",
    "DeleteFileW",
    "CreateDirectoryW",
    "SetSecurityInfo",
    "MoveFileW",
    "MoveFileExW",
    "ReplaceFileW",
    "CreateProcessW",
    "LoadLibraryW",
    "LoadLibraryExW",
    "GetProcAddress",
    "ShellExecuteW",
    "WinExec",
    "CoInitializeEx",
    "WinHttpOpen",
    "InternetOpenW",
    "WSAStartup",
    "GetEnvironmentVariableW",
    "CommandLineToArgvW",
    "system",
    "wmain",
  ]) {
    assert.equal(
      new RegExp(`\\b${forbiddenFunction}\\s*\\(`, "u").test(combined),
      false,
      `native W1A includes forbidden authority call: ${forbiddenFunction}`,
    );
  }
  assert.equal(/\b(?:Nt|Zw)[A-Z][A-Za-z0-9_]*\s*\(/u.test(combined), false);
  assert.equal(/\b(?:__asm|_asm)\b/u.test(combined), false);
  for (const fuzzFragment of ["0x47504357U", "65536U", "GCPW_NATIVE_TESTS seed=0x47504357 cases=65536\\n"]) {
    assert.equal(
      nativeTestSource.includes(fuzzFragment),
      true,
      `missing native fuzz receipt fragment: ${fuzzFragment}`,
    );
  }
  assert.equal(nativeTestSource.includes("RunServiceRuntimeTests"), true);
  assert.equal(nativeTestSource.includes("RunLocalTransportTests"), true);
  assert.match(ed25519RuntimeHeader, /bool RunKnownAnswerSelfTest\(\) noexcept;/u);
  assert.equal([...ed25519RuntimeHeader.matchAll(/\bSignProtectedArtifact\s*\(/gu)].length, 2);
  assert.match(
    ed25519RuntimeHeader,
    /class ProtectedEd25519SigningBridgeKey final[\s\S]*?private:[\s\S]*?ProtectedEd25519SigningBridgeKey\(\) noexcept = default;[\s\S]*?friend bool SignProtectedArtifact/u,
  );
  assert.equal(
    /\b(?:Sign|Verify)[A-Za-z0-9_]*\s*\(/u.test(
      ed25519RuntimeHeader.replaceAll("SignProtectedArtifact", "AuthorityBoundProtectedArtifactOperation"),
    ),
    false,
  );
  for (const bridge of [
    "ExpandEd25519SeedForProtectedSigning",
    "ReduceEd25519ScalarForProtectedSigning",
    "Ed25519ScalarBaseForProtectedSigning",
    "Ed25519MulAddForProtectedSigning",
    "CheckEd25519EquationForProtectedSigning",
  ]) {
    assert.match(
      ed25519RuntimeHeader,
      new RegExp(`${bridge}\\(\\s*const ProtectedEd25519SigningBridgeKey& bridge_key,`, "u"),
    );
  }
  const startupWorkerStart = serviceRuntimeSource.indexOf(
    "DWORD WINAPI ServiceStartupWorker(void* raw_context) noexcept",
  );
  const startupWorkerEnd = serviceRuntimeSource.indexOf("void WINAPI ProvisionerServiceMain(", startupWorkerStart);
  assert.equal(startupWorkerStart >= 0 && startupWorkerEnd > startupWorkerStart, true);
  const startupWorkerSource = serviceRuntimeSource.slice(startupWorkerStart, startupWorkerEnd);
  assert.equal(
    [...startupWorkerSource.matchAll(/RunKnownAnswerSelfTest\(\)/gu)].length,
    1,
    "the protected startup worker must have one exact Ed25519 self-test call",
  );
  const imageValidationIndex = startupWorkerSource.indexOf("ValidateServiceTransportImages(");
  const imagesValidatedIndex = startupWorkerSource.indexOf("StartupStage::ImagesValidated");
  const selfTestIndex = startupWorkerSource.indexOf("RunKnownAnswerSelfTest()");
  const armTransportIndex = startupWorkerSource.indexOf("ArmServiceTransport(&g_transport_state)");
  assert.equal(
    imageValidationIndex >= 0 &&
      imageValidationIndex < imagesValidatedIndex &&
      imagesValidatedIndex < selfTestIndex &&
      selfTestIndex < armTransportIndex,
    true,
    "the Ed25519 self-test must run only after protected images validate and before pipe arming",
  );
  assert.match(
    startupWorkerSource,
    /LoadStartupStage\(\*context\) != StartupStage::ImagesValidated[\s\S]*?ClassifyPostCheckpointStartupState\([\s\S]*?IsDeadlineExpired\(context->startup_deadline\),[\s\S]*?StopControlWon\(\) \|\|[\s\S]*?WaitForSingleObject\(context->stop_event, 0U\)[\s\S]*?self_test_state == StartupGateDisposition::Stop[\s\S]*?self_test_state != StartupGateDisposition::Continue[\s\S]*?const bool ed25519_self_test_passed = RunKnownAnswerSelfTest\(\);[\s\S]*?ClassifyPostCheckpointStartupState\([\s\S]*?IsDeadlineExpired\(context->startup_deadline\),[\s\S]*?StopControlWon\(\) \|\|[\s\S]*?WaitForSingleObject\(context->stop_event, 0U\)[\s\S]*?self_test_state == StartupGateDisposition::Stop[\s\S]*?self_test_state != StartupGateDisposition::Continue[\s\S]*?if \(!ed25519_self_test_passed\)[\s\S]*?ServiceTransportResult::ProtectedImage[\s\S]*?ArmServiceTransport\(&g_transport_state\)/u,
    "STOP-first classification and deadline handling must bracket the self-test before protected-image failure or pipe arming",
  );
  assert.equal(ed25519RuntimeSource.includes("crypto_ed25519_sign("), false);
  assert.equal(ed25519RuntimeSource.includes("crypto_ed25519_ph_"), false);
  assert.equal(ed25519RuntimeSource.includes("crypto_x25519"), false);
  assert.equal(ed25519RuntimeSource.includes("crypto_eddsa_sign"), false);
  assert.equal(ed25519RuntimeSource.includes("crypto_eddsa_scalarbase"), true);
  assert.equal(ed25519RuntimeSource.includes("crypto_eddsa_mul_add"), true);
  assert.equal(ed25519RuntimeSource.includes("SecureZeroMemory"), true);
  assert.equal(ed25519RuntimeTest.includes("--vendor-preflight"), true);
  assert.equal(ed25519RuntimeTest.includes("--vendor-postflight"), true);
  const firstPartyMonocypherOwners = fs
    .readdirSync(path.join(nativeRoot, "src"))
    .filter((name) => /\.(?:cpp|hpp)$/u.test(name))
    .filter((name) => {
      const contents = fs.readFileSync(path.join(nativeRoot, "src", name), "utf8");
      return /#include\s+[<"]monocypher(?:-ed25519)?\.h[>"]/u.test(contents);
    })
    .sort(asciiCompare);
  assert.deepEqual(firstPartyMonocypherOwners, ["ed25519_runtime.cpp"]);
  const firstPartyMonocypherCallOwners = fs
    .readdirSync(path.join(nativeRoot, "src"))
    .filter((name) => /\.(?:cpp|hpp)$/u.test(name))
    .filter((name) => {
      const contents = fs.readFileSync(path.join(nativeRoot, "src", name), "utf8");
      return /\bcrypto_(?:ed25519|eddsa|x25519|sha512)[A-Za-z0-9_]*\s*\(/u.test(contents);
    })
    .sort(asciiCompare);
  assert.deepEqual(firstPartyMonocypherCallOwners, ["ed25519_runtime.cpp"]);
  assert.match(
    localTransportSource,
    /#if defined\(_M_ARM64\)[\s\S]*int __arm64_safe_unaligned_memory_access = 0;[\s\S]*#endif/u,
  );
  assert.equal(
    [...localTransportSource.matchAll(/__arm64_safe_unaligned_memory_access/gu)].length,
    1,
    "the conservative ARM64 VCRuntime selector must have one exact definition",
  );
});

test("native projects freeze separate service, client, and paired x64/ARM64 test build closures", () => {
  const productionProject = fs.readFileSync(productionProjectPath, "utf8");
  const clientProject = fs.readFileSync(clientProjectPath, "utf8");
  const testProject = fs.readFileSync(testProjectPath, "utf8");
  for (const project of [productionProject, clientProject, testProject]) {
    for (const fragment of [
      `<VCToolsVersion>${REMOTE_WORKER_WINDOWS_MSVC_VERSION}</VCToolsVersion>`,
      `<WindowsTargetPlatformVersion>${REMOTE_WORKER_WINDOWS_SDK_VERSION}</WindowsTargetPlatformVersion>`,
      "<RuntimeLibrary>MultiThreaded</RuntimeLibrary>",
      "<SpectreMitigation>Spectre</SpectreMitigation>",
      "<SDLCheck>true</SDLCheck>",
      "<WarningLevel>Level4</WarningLevel>",
      "<TreatWarningAsError>true</TreatWarningAsError>",
      "/pathmap:",
      "/INCREMENTAL:NO",
      "/DYNAMICBASE",
      "/HIGHENTROPYVA",
      "/NXCOMPAT",
      "/GUARD:CF",
    ]) {
      assert.equal(project.includes(fragment), true, `missing project contract fragment: ${fragment}`);
    }
  }
  for (const fragment of [
    `<TargetName>${path.parse(REMOTE_WORKER_WINDOWS_PROVISIONER_NAME).name}</TargetName>`,
    "RequireExpectedClientSha256",
    "GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX",
    "<WholeProgramOptimization>true</WholeProgramOptimization>",
    "<DebugInformationFormat>None</DebugInformationFormat>",
    "/Brepro",
    "/experimental:deterministic",
    "/DEBUG:NONE",
    "<IgnoreAllDefaultLibraries>true</IgnoreAllDefaultLibraries>",
    "<EntryPointSymbol>ProvisionerEntryPoint</EntryPointSymbol>",
    "<AdditionalDependencies>kernel32.lib;advapi32.lib;bcrypt.lib;secur32.lib;bufferoverflowu.lib;libvcruntime.lib;libcmt.lib</AdditionalDependencies>",
    "/NODEFAULTLIB",
    "/INCLUDE:__arm64_safe_unaligned_memory_access",
    "MonocypherSourceRoot",
    "ProvisionerLinkMapPath",
    "<GenerateMapFile>true</GenerateMapFile>",
    "$(MonocypherSourceRoot)\\src\\monocypher.c",
    "$(MonocypherSourceRoot)\\src\\optional\\monocypher-ed25519.c",
    "src\\ed25519_runtime.cpp",
    "/TC /O2 /Ob0 /GL- /Gy /volatile:iso",
  ]) {
    assert.equal(productionProject.includes(fragment), true, `missing production project fragment: ${fragment}`);
  }
  for (const fragment of [
    `<TargetName>${path.parse(REMOTE_WORKER_WINDOWS_PROVISIONER_CLIENT_NAME).name}</TargetName>`,
    "<WholeProgramOptimization>true</WholeProgramOptimization>",
    "/Brepro",
    "/experimental:deterministic",
    "/DEBUG:NONE",
    "<IgnoreAllDefaultLibraries>true</IgnoreAllDefaultLibraries>",
    "<EntryPointSymbol>ProvisionerClientEntryPoint</EntryPointSymbol>",
    "<AdditionalDependencies>kernel32.lib;advapi32.lib;bcrypt.lib;bufferoverflowu.lib;libvcruntime.lib;libcmt.lib</AdditionalDependencies>",
    "/NODEFAULTLIB",
    "/INCLUDE:__arm64_safe_unaligned_memory_access",
  ]) {
    assert.equal(clientProject.includes(fragment), true, `missing client project fragment: ${fragment}`);
  }
  for (const fragment of [
    `<TargetName Condition="'$(VendorPreflight)' != 'true'">${path.parse(REMOTE_WORKER_WINDOWS_PROVISIONER_TEST_NAME).name}</TargetName>`,
    `<TargetName Condition="'$(VendorPreflight)' == 'true'">${path.parse(REMOTE_WORKER_WINDOWS_PROVISIONER_PREFLIGHT_NAME).name}</TargetName>`,
    '<ProjectConfiguration Include="Release|x64">',
    '<ProjectConfiguration Include="Release|ARM64">',
    `<PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Release|ARM64'" Label="Configuration">`,
    `<EnableASAN Condition="'$(VendorPreflight)' != 'true' and '$(Platform)' == 'x64'">true</EnableASAN>`,
    `<EnableASAN Condition="'$(VendorPreflight)' == 'true' or '$(Platform)' != 'x64'">false</EnableASAN>`,
    "/fsanitize=address /Brepro /experimental:deterministic",
    "/D__arm64_safe_unaligned_memory_access=goatcitadel_test_arm64_safe_unaligned_memory_access",
    "GOATCITADEL_PROVISIONER_TESTING=1",
    "GOATCITADEL_VENDOR_PREFLIGHT=1",
    "VendorPreflight",
    "MonocypherSourceRoot",
    "$(MonocypherSourceRoot)\\src\\monocypher.c",
    "$(MonocypherSourceRoot)\\src\\optional\\monocypher-ed25519.c",
    "src\\ed25519_runtime.cpp",
    "src\\ed25519_runtime.test.cpp",
    "/TC /O2 /Ob0 /GL- /Gy /volatile:iso",
  ]) {
    assert.equal(testProject.includes(fragment), true, `missing native-test project fragment: ${fragment}`);
  }
  for (const forbiddenLibrary of [
    "user32.lib",
    "shell32.lib",
    "ole32.lib",
    "wbemuuid.lib",
    "winhttp.lib",
    "wininet.lib",
    "ws2_32.lib",
    "libucrt.lib",
    "ucrt.lib",
  ]) {
    assert.equal(productionProject.toLowerCase().includes(forbiddenLibrary), false);
    assert.equal(clientProject.toLowerCase().includes(forbiddenLibrary), false);
  }

  const productionCompiles = extractCompileIncludes(productionProject);
  const clientCompiles = extractCompileIncludes(clientProject);
  const testCompiles = extractCompileIncludes(testProject);
  assert.deepEqual(productionCompiles, [
    "src/local_transport.cpp",
    "src/main.cpp",
    "src/protocol.cpp",
    "src/service_runtime.cpp",
  ]);
  for (const source of [
    "ed25519_runtime.cpp",
    "key_custody.cpp",
    "operation_journal.cpp",
    "protected_artifact_signing.cpp",
    "protected_filesystem.cpp",
    "protected_operations.cpp",
  ]) {
    assert.equal(
      productionProject.includes(`<ClCompile Include="src\\${source}">`),
      true,
      `production project must compile the frozen W1B1A owner ${source}`,
    );
  }
  assert.deepEqual(clientCompiles, ["src/client_main.cpp", "src/local_transport.cpp", "src/protocol.cpp"]);
  assert.deepEqual(testCompiles, [
    "src/ed25519_runtime.test.cpp",
    "src/ed25519_runtime.test.cpp",
    "src/key_custody.test.cpp",
    "src/local_transport.cpp",
    "src/local_transport.test.cpp",
    "src/operation_journal.cpp",
    "src/operation_journal.test.cpp",
    "src/protected_artifact_signing.cpp",
    "src/protected_artifact_signing.test.cpp",
    "src/protected_filesystem.cpp",
    "src/protected_filesystem.test.cpp",
    "src/protected_operations.cpp",
    "src/protected_operations.test.cpp",
    "src/protocol.cpp",
    "src/protocol.test.cpp",
    "src/service_runtime.cpp",
    "src/service_runtime.test.cpp",
  ]);
  assert.deepEqual(extractIncludeIncludes(productionProject), [
    "src/ed25519_runtime.hpp",
    "src/key_custody.hpp",
    "src/local_transport.hpp",
    "src/operation_journal.hpp",
    "src/protected_artifact_signing.hpp",
    "src/protected_filesystem.hpp",
    "src/protected_operations.hpp",
    "src/protocol.hpp",
    "src/service_runtime.hpp",
  ]);
  assert.deepEqual(extractIncludeIncludes(clientProject), ["src/local_transport.hpp", "src/protocol.hpp"]);
  assert.deepEqual(extractIncludeIncludes(testProject), [
    "src/ed25519_runtime.hpp",
    "src/key_custody.hpp",
    "src/local_transport.hpp",
    "src/operation_journal.hpp",
    "src/protected_artifact_signing.hpp",
    "src/protected_filesystem.hpp",
    "src/protected_operations.hpp",
    "src/protocol.hpp",
    "src/service_runtime.hpp",
  ]);
  const preflightCompileGroup = extractSingle(
    testProject,
    /<ItemGroup Condition="'\$\(VendorPreflight\)' == 'true'">([\s\S]*?)<\/ItemGroup>/u,
  );
  assert.deepEqual(extractCompileIncludes(preflightCompileGroup), ["src/ed25519_runtime.test.cpp"]);
  assert.equal(preflightCompileGroup.includes("MonocypherSourceRoot"), false);

  const productionGuid = extractSingle(productionProject, /<ProjectGuid>([^<]+)<\/ProjectGuid>/u);
  const clientGuid = extractSingle(clientProject, /<ProjectGuid>([^<]+)<\/ProjectGuid>/u);
  const testGuid = extractSingle(testProject, /<ProjectGuid>([^<]+)<\/ProjectGuid>/u);
  assert.notEqual(productionGuid, testGuid);
  assert.notEqual(productionGuid, clientGuid);
  assert.notEqual(clientGuid, testGuid);
  for (const forbiddenProjectFragment of ["ProjectReference", "PostBuildEvent", "CustomBuild"]) {
    assert.equal(productionProject.includes(forbiddenProjectFragment), false);
    assert.equal(clientProject.includes(forbiddenProjectFragment), false);
    assert.equal(testProject.includes(forbiddenProjectFragment), false);
  }
});

test("embedded client digest proof requires one raw read-only non-code projection and no text copy", () => {
  const digestHex = "0123456789abcdef".repeat(4);
  const valid = createDigestCarrierPe(digestHex);
  assert.doesNotThrow(() => assertEmbeddedClientDigest(valid, digestHex));

  const duplicate = Buffer.from(valid);
  Buffer.from(digestHex, "hex").copy(duplicate, 0x500);
  assert.throws(() => assertEmbeddedClientDigest(duplicate, digestHex), /exactly one raw embedded/);

  const writable = Buffer.from(valid);
  writable.writeUInt32LE(0xc0000040, 0x80 + 24 + 240 + 36);
  assert.throws(() => assertEmbeddedClientDigest(writable, digestHex), /read-only non-code/);

  const executable = Buffer.from(valid);
  executable.writeUInt32LE(0x60000020, 0x80 + 24 + 240 + 36);
  assert.throws(() => assertEmbeddedClientDigest(executable, digestHex), /read-only non-code/);

  const ascii = Buffer.from(valid);
  Buffer.from(digestHex, "ascii").copy(ascii, 0x520);
  assert.throws(() => assertEmbeddedClientDigest(ascii, digestHex), /forbidden text/);

  const utf16 = Buffer.from(valid);
  Buffer.from(digestHex, "utf16le").copy(utf16, 0x520);
  assert.throws(() => assertEmbeddedClientDigest(utf16, digestHex), /forbidden text/);

  const mixedCase = Buffer.from(valid);
  Buffer.from("0123456789ABCDEF".repeat(4), "ascii").copy(mixedCase, 0x520);
  assert.throws(() => assertEmbeddedClientDigest(mixedCase, digestHex), /forbidden text/);

  const utf16BigEndian = Buffer.from(valid);
  const wideBigEndian = Buffer.from(digestHex, "utf16le").swap16();
  wideBigEndian.copy(utf16BigEndian, 0x520);
  assert.throws(() => assertEmbeddedClientDigest(utf16BigEndian, digestHex), /forbidden text/);
});

test("PE proof accepts only the exact per-binary W1B1A import closures and mitigations", () => {
  const w1b1aServiceAuthorityImports = [
    "CreateDirectoryW",
    "DuplicateHandle",
    "FlushFileBuffers",
    "GetSecurityDescriptorGroup",
    "GetVolumeInformationByHandleW",
    "SetFileInformationByHandle",
    "SetSecurityDescriptorGroup",
  ].sort(asciiCompare);
  for (const binaryKind of ["service", "client"]) {
    for (const [target, machine] of [
      ["windows-x64", 0x8664],
      ["windows-arm64", 0xaa64],
    ]) {
      assert.equal(REMOTE_WORKER_WINDOWS_PROVISIONER_IMPORTS[binaryKind][target].length > 0, true);
      const bytes = createSyntheticProvisionerPe(machine, { binaryKind });
      const inspection = inspectRemoteWorkerProvisionerPe(bytes, { expectedMachine: machine, binaryKind });
      assert.deepEqual(
        inspection.imports,
        canonicalImports(REMOTE_WORKER_WINDOWS_PROVISIONER_IMPORTS[binaryKind][target]),
      );
    }
  }
  for (const target of ["windows-x64", "windows-arm64"]) {
    const serviceFunctions = REMOTE_WORKER_WINDOWS_PROVISIONER_IMPORTS.service[target].flatMap(
      (entry) => entry.functions,
    );
    const clientFunctions = REMOTE_WORKER_WINDOWS_PROVISIONER_IMPORTS.client[target].flatMap(
      (entry) => entry.functions,
    );
    assert.deepEqual(
      serviceFunctions.filter((name) => w1b1aServiceAuthorityImports.includes(name)).sort(asciiCompare),
      w1b1aServiceAuthorityImports,
      `${target} service owns the exact seven-name W1B1A authority delta`,
    );
    assert.deepEqual(
      clientFunctions.filter((name) => w1b1aServiceAuthorityImports.includes(name)),
      [],
      `${target} client closure remains byte-for-byte outside W1B1A authority`,
    );
    const serviceKernel32 = REMOTE_WORKER_WINDOWS_PROVISIONER_IMPORTS.service[target].find(
      (entry) => entry.dll === "KERNEL32.dll",
    );
    assert.notEqual(serviceKernel32, undefined);
    assert.equal(
      serviceKernel32.functions.filter((name) => name === "DuplicateHandle").length,
      1,
      `${target} service imports DuplicateHandle exactly once from KERNEL32.dll`,
    );
  }

  const valid = createSyntheticProvisionerPe(0x8664, { binaryKind: "service" });
  const inspection = inspectRemoteWorkerProvisionerPe(valid, {
    expectedMachine: 0x8664,
    binaryKind: "service",
  });
  const requiredServiceImports = new Set(inspection.imports.flatMap((entry) => entry.functions));
  for (const requiredImport of ["StartServiceCtrlDispatcherW", "ConnectNamedPipe", "DuplicateHandle"]) {
    assert.equal(requiredServiceImports.has(requiredImport), true, `missing required W1B1A import: ${requiredImport}`);
  }
  assert.deepEqual(
    inspection.debugDirectory.map((entry) => entry.type),
    ["IMAGE_DEBUG_TYPE_POGO", "IMAGE_DEBUG_TYPE_REPRO"],
  );

  const noEntryPoint = Buffer.from(valid);
  noEntryPoint.writeUInt32LE(0, 0x80 + 24 + 16);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(noEntryPoint, { expectedMachine: 0x8664, binaryKind: "service" }),
    /AddressOfEntryPoint/,
  );

  const writableCode = Buffer.from(valid);
  writableCode.writeUInt32LE(0xe0000020, 0x80 + 24 + 240 + 36);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(writableCode, { expectedMachine: 0x8664, binaryKind: "service" }),
    /W\^X code policy/,
  );

  const nonExecutableCode = Buffer.from(valid);
  nonExecutableCode.writeUInt32LE(0x40000020, 0x80 + 24 + 240 + 36);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(nonExecutableCode, { expectedMachine: 0x8664, binaryKind: "service" }),
    /W\^X code policy/,
  );

  const wrongMachine = Buffer.from(valid);
  wrongMachine.writeUInt16LE(0xaa64, 0x84);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(wrongMachine, { expectedMachine: 0x8664, binaryKind: "service" }),
    /machine/,
  );

  const notExecutable = Buffer.from(valid);
  notExecutable.writeUInt16LE(notExecutable.readUInt16LE(0x80 + 4 + 18) & ~0x0002, 0x80 + 4 + 18);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(notExecutable, { expectedMachine: 0x8664, binaryKind: "service" }),
    /executable large-address-aware/,
  );

  const notLargeAddressAware = Buffer.from(valid);
  notLargeAddressAware.writeUInt16LE(notLargeAddressAware.readUInt16LE(0x80 + 4 + 18) & ~0x0020, 0x80 + 4 + 18);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(notLargeAddressAware, { expectedMachine: 0x8664, binaryKind: "service" }),
    /executable large-address-aware/,
  );

  const markedDll = Buffer.from(valid);
  markedDll.writeUInt16LE(markedDll.readUInt16LE(0x80 + 4 + 18) | 0x2000, 0x80 + 4 + 18);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(markedDll, { expectedMachine: 0x8664, binaryKind: "service" }),
    /marked as a DLL/,
  );

  const invalidImageBase = Buffer.from(valid);
  invalidImageBase.writeBigUInt64LE(0n, 0x80 + 24 + 24);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(invalidImageBase, { expectedMachine: 0x8664, binaryKind: "service" }),
    /image base or header alignment/,
  );

  const invalidSizeOfImage = Buffer.from(valid);
  invalidSizeOfImage.writeUInt32LE(0x20000, 0x80 + 24 + 56);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(invalidSizeOfImage, { expectedMachine: 0x8664, binaryKind: "service" }),
    /SizeOfImage is non-canonical/,
  );

  const missingCfg = Buffer.from(valid);
  missingCfg.writeUInt16LE(0x0160, 0x80 + 24 + 70);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(missingCfg, { expectedMachine: 0x8664, binaryKind: "service" }),
    /CFG flags/,
  );

  const loadConfigOffset = rvaToSyntheticOffset(0xd200);
  const guardTableOffset = rvaToSyntheticOffset(0xd2e0);

  const guardPointerUnderImageBase = Buffer.from(valid);
  guardPointerUnderImageBase.writeBigUInt64LE(0x13fffffffn, loadConfigOffset + 112);
  assert.throws(
    () =>
      inspectRemoteWorkerProvisionerPe(guardPointerUnderImageBase, {
        expectedMachine: 0x8664,
        binaryKind: "service",
      }),
    /GuardCF check pointer slot VA is below ImageBase/,
  );

  const guardPointerRvaOverflow = Buffer.from(valid);
  guardPointerRvaOverflow.writeBigUInt64LE(0x240000000n, loadConfigOffset + 112);
  assert.throws(
    () =>
      inspectRemoteWorkerProvisionerPe(guardPointerRvaOverflow, {
        expectedMachine: 0x8664,
        binaryKind: "service",
      }),
    /GuardCF check pointer slot VA overflows/,
  );

  const guardPointerOutsideImage = Buffer.from(valid);
  guardPointerOutsideImage.writeBigUInt64LE(0x140010000n, loadConfigOffset + 120);
  assert.throws(
    () =>
      inspectRemoteWorkerProvisionerPe(guardPointerOutsideImage, {
        expectedMachine: 0x8664,
        binaryKind: "service",
      }),
    /GuardCF dispatch pointer slot VA is outside SizeOfImage/,
  );

  const guardCountUnbounded = Buffer.from(valid);
  guardCountUnbounded.writeBigUInt64LE(65_537n, loadConfigOffset + 136);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(guardCountUnbounded, { expectedMachine: 0x8664, binaryKind: "service" }),
    /GuardCFFunctionCount is unbounded/,
  );

  const guardTableOverrun = Buffer.from(valid);
  guardTableOverrun.writeBigUInt64LE(0x14000fffcn, loadConfigOffset + 128);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(guardTableOverrun, { expectedMachine: 0x8664, binaryKind: "service" }),
    /GuardCFFunctionTable VA is outside SizeOfImage/,
  );

  const guardTableNonCode = Buffer.from(valid);
  guardTableNonCode.writeUInt32LE(0xd000, guardTableOffset);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(guardTableNonCode, { expectedMachine: 0x8664, binaryKind: "service" }),
    /GuardCFFunctionTable entry is not canonical executable code/,
  );

  const guardTableDuplicate = Buffer.from(valid);
  guardTableDuplicate.writeUInt32LE(0x1000, guardTableOffset + 4);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(guardTableDuplicate, { expectedMachine: 0x8664, binaryKind: "service" }),
    /GuardCFFunctionTable entry is not canonical executable code/,
  );

  const guardTableWithExtraStride = Buffer.from(valid);
  guardTableWithExtraStride.fill(0, guardTableOffset, guardTableOffset + 16);
  guardTableWithExtraStride.writeUInt32LE(0x1000, guardTableOffset);
  guardTableWithExtraStride.writeUInt8(0x7f, guardTableOffset + 4);
  guardTableWithExtraStride.writeUInt32LE(0x1010, guardTableOffset + 5);
  guardTableWithExtraStride.writeUInt8(0x00, guardTableOffset + 9);
  guardTableWithExtraStride.writeUInt32LE(0x10000500, loadConfigOffset + 144);
  inspectRemoteWorkerProvisionerPe(guardTableWithExtraStride, {
    expectedMachine: 0x8664,
    binaryKind: "service",
  });

  const exported = Buffer.from(valid);
  writeDirectory(exported, 0, 0x2400, 40);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(exported, { expectedMachine: 0x8664, binaryKind: "service" }),
    /export/,
  );

  const authenticodeMutation = Buffer.from(valid);
  writeDirectory(authenticodeMutation, 4, 0x3000, 32);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(authenticodeMutation, { expectedMachine: 0x8664, binaryKind: "service" }),
    /Authenticode/,
  );

  const delayImport = Buffer.from(valid);
  writeDirectory(delayImport, 13, 0x2400, 32);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(delayImport, { expectedMachine: 0x8664, binaryKind: "service" }),
    /delay-import/,
  );

  const tlsCallback = Buffer.from(valid);
  writeDirectory(tlsCallback, 9, 0x2400, 40);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(tlsCallback, { expectedMachine: 0x8664, binaryKind: "service" }),
    /TLS-callback/,
  );

  const boundImport = Buffer.from(valid);
  writeDirectory(boundImport, 11, 0x2400, 40);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(boundImport, { expectedMachine: 0x8664, binaryKind: "service" }),
    /bound-import/,
  );

  const serviceImports = thawImports(REMOTE_WORKER_WINDOWS_PROVISIONER_IMPORTS.service["windows-x64"]);
  const forbiddenDllImports = thawImports(serviceImports);
  forbiddenDllImports[0].dll = "USER32.dll";
  const forbiddenDll = createSyntheticProvisionerPe(0x8664, {
    binaryKind: "service",
    imports: forbiddenDllImports,
  });
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(forbiddenDll, { expectedMachine: 0x8664, binaryKind: "service" }),
    /DLL import/,
  );

  const clientImportsWithSecur32 = thawImports(REMOTE_WORKER_WINDOWS_PROVISIONER_IMPORTS.client["windows-x64"]);
  clientImportsWithSecur32[0].dll = "secur32.dll";
  const forbiddenClientSecur32 = createSyntheticProvisionerPe(0x8664, {
    binaryKind: "client",
    imports: clientImportsWithSecur32,
  });
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(forbiddenClientSecur32, { expectedMachine: 0x8664, binaryKind: "client" }),
    /DLL import/,
  );

  const serviceKernel32Index = serviceImports.findIndex((entry) => entry.dll === "KERNEL32.dll");
  assert.notEqual(serviceKernel32Index, -1);

  const missingDuplicateHandleImports = thawImports(serviceImports);
  missingDuplicateHandleImports[serviceKernel32Index].functions = missingDuplicateHandleImports[
    serviceKernel32Index
  ].functions.filter((name) => name !== "DuplicateHandle");
  const missingDuplicateHandle = createSyntheticProvisionerPe(0x8664, {
    binaryKind: "service",
    imports: missingDuplicateHandleImports,
  });
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(missingDuplicateHandle, { expectedMachine: 0x8664, binaryKind: "service" }),
    /exact W1A closure/,
  );

  const duplicateDuplicateHandleImports = thawImports(serviceImports);
  duplicateDuplicateHandleImports[serviceKernel32Index].functions.push("DuplicateHandle");
  const duplicateDuplicateHandle = createSyntheticProvisionerPe(0x8664, {
    binaryKind: "service",
    imports: duplicateDuplicateHandleImports,
  });
  assert.throws(
    () =>
      inspectRemoteWorkerProvisionerPe(duplicateDuplicateHandle, { expectedMachine: 0x8664, binaryKind: "service" }),
    /duplicate named imports/,
  );

  const unauthorizedDuplicateVariantImports = thawImports(serviceImports);
  unauthorizedDuplicateVariantImports[serviceKernel32Index].functions.push("DuplicateHandleEx");
  const unauthorizedDuplicateVariant = createSyntheticProvisionerPe(0x8664, {
    binaryKind: "service",
    imports: unauthorizedDuplicateVariantImports,
  });
  assert.throws(
    () =>
      inspectRemoteWorkerProvisionerPe(unauthorizedDuplicateVariant, {
        expectedMachine: 0x8664,
        binaryKind: "service",
      }),
    /exact W1A closure/,
  );

  const clientDuplicateHandleImports = thawImports(REMOTE_WORKER_WINDOWS_PROVISIONER_IMPORTS.client["windows-x64"]);
  const clientKernel32Index = clientDuplicateHandleImports.findIndex((entry) => entry.dll === "KERNEL32.dll");
  assert.notEqual(clientKernel32Index, -1);
  clientDuplicateHandleImports[clientKernel32Index].functions.push("DuplicateHandle");
  const forbiddenClientDuplicateHandle = createSyntheticProvisionerPe(0x8664, {
    binaryKind: "client",
    imports: clientDuplicateHandleImports,
  });
  assert.throws(
    () =>
      inspectRemoteWorkerProvisionerPe(forbiddenClientDuplicateHandle, {
        expectedMachine: 0x8664,
        binaryKind: "client",
      }),
    /exact W1A closure/,
  );

  for (const forbiddenFunction of [
    "DeleteFileW",
    "GetEnvironmentStringsW",
    "GetProcAddress",
    "LoadLibraryExW",
    "CreateProcessW",
    "CreateServiceW",
    "StartServiceW",
    "ControlService",
    "ChangeServiceConfig2W",
    "AdjustTokenPrivileges",
    "DuplicateTokenEx",
    "ImpersonateLoggedOnUser",
    "SetNamedPipeHandleState",
    "BCryptGenerateKeyPair",
    "BCryptSignHash",
    "RegOpenKeyExW",
    "ShellExecuteW",
    "CoInitializeEx",
    "WinHttpOpen",
    "WSAStartup",
    "connect",
  ]) {
    const forbiddenImports = thawImports(serviceImports);
    forbiddenImports[0].functions.push(forbiddenFunction);
    const forbiddenAuthority = createSyntheticProvisionerPe(0x8664, {
      binaryKind: "service",
      imports: forbiddenImports,
    });
    assert.throws(
      () => inspectRemoteWorkerProvisionerPe(forbiddenAuthority, { expectedMachine: 0x8664, binaryKind: "service" }),
      new RegExp(`forbidden W1A authority import: ${forbiddenFunction}`, "u"),
    );
  }

  const ordinalImport = Buffer.from(valid);
  ordinalImport.writeBigUInt64LE(0x8000000000000001n, rvaToSyntheticOffset(0x1800));
  ordinalImport.writeBigUInt64LE(0x8000000000000001n, rvaToSyntheticOffset(0x2800));
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(ordinalImport, { expectedMachine: 0x8664, binaryKind: "service" }),
    /ordinal import/,
  );

  const divergentIat = Buffer.from(valid);
  divergentIat.writeBigUInt64LE(0x4002n, rvaToSyntheticOffset(0x2800));
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(divergentIat, { expectedMachine: 0x8664, binaryKind: "service" }),
    /import-name and import-address/,
  );

  const codeView = Buffer.from(valid);
  codeView.writeUInt32LE(2, rvaToSyntheticOffset(0xd000) + 28 + 12);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(codeView, { expectedMachine: 0x8664, binaryKind: "service" }),
    /types/,
  );

  const unmappedRelocations = Buffer.from(valid);
  writeDirectory(unmappedRelocations, 5, 0xffff, 16);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(unmappedRelocations, { expectedMachine: 0x8664, binaryKind: "service" }),
    /base relocation/,
  );

  const relocationsStripped = Buffer.from(valid);
  relocationsStripped.writeUInt16LE(relocationsStripped.readUInt16LE(0x80 + 4 + 18) | 0x0001, 0x80 + 4 + 18);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(relocationsStripped, { expectedMachine: 0x8664, binaryKind: "service" }),
    /relocations must not be stripped/,
  );

  const relocationOffset = rvaToSyntheticOffset(0xd400);
  const zeroRelocationBlock = Buffer.from(valid);
  zeroRelocationBlock.writeUInt32LE(0, relocationOffset + 4);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(zeroRelocationBlock, { expectedMachine: 0x8664, binaryKind: "service" }),
    /base relocation block size/,
  );

  const truncatedRelocationBlock = Buffer.from(valid);
  writeDirectory(truncatedRelocationBlock, 5, 0xd400, 8);
  assert.throws(
    () =>
      inspectRemoteWorkerProvisionerPe(truncatedRelocationBlock, { expectedMachine: 0x8664, binaryKind: "service" }),
    /base relocation block size/,
  );

  const unalignedRelocationBlockSize = Buffer.from(valid);
  unalignedRelocationBlockSize.writeUInt32LE(10, relocationOffset + 4);
  assert.throws(
    () =>
      inspectRemoteWorkerProvisionerPe(unalignedRelocationBlockSize, {
        expectedMachine: 0x8664,
        binaryKind: "service",
      }),
    /base relocation block size/,
  );

  const unalignedRelocationPage = Buffer.from(valid);
  unalignedRelocationPage.writeUInt32LE(0xd100, relocationOffset);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(unalignedRelocationPage, { expectedMachine: 0x8664, binaryKind: "service" }),
    /page RVA is not page-aligned/,
  );

  const wrongArchitectureRelocation = Buffer.from(valid);
  wrongArchitectureRelocation.writeUInt16LE((3 << 12) | 0x270, relocationOffset + 8);
  assert.throws(
    () =>
      inspectRemoteWorkerProvisionerPe(wrongArchitectureRelocation, {
        expectedMachine: 0x8664,
        binaryKind: "service",
      }),
    /base relocation type 3/,
  );

  const unmappedRelocationTarget = Buffer.from(valid);
  unmappedRelocationTarget.writeUInt32LE(0x10000, relocationOffset);
  assert.throws(
    () =>
      inspectRemoteWorkerProvisionerPe(unmappedRelocationTarget, {
        expectedMachine: 0x8664,
        binaryKind: "service",
      }),
    /base relocation target is outside/,
  );

  const absoluteOnlyRelocations = Buffer.from(valid);
  absoluteOnlyRelocations.writeUInt16LE(0x0270, relocationOffset + 8);
  assert.throws(
    () => inspectRemoteWorkerProvisionerPe(absoluteOnlyRelocations, { expectedMachine: 0x8664, binaryKind: "service" }),
    /no architecture relocation entries/,
  );

  const partialTrailingRelocation = Buffer.from(valid);
  writeDirectory(partialTrailingRelocation, 5, 0xd400, 16);
  assert.throws(
    () =>
      inspectRemoteWorkerProvisionerPe(partialTrailingRelocation, {
        expectedMachine: 0x8664,
        binaryKind: "service",
      }),
    /trailing partial block data/,
  );
});

test("CLI rejects missing and unknown arguments before any native build", () => {
  const missing = spawnSync(process.execPath, [builderPath], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^Usage:/u);
  assert.equal(missing.stdout, "");

  const unknown = spawnSync(process.execPath, [builderPath, "--unknown"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown argument/u);
  assert.equal(unknown.stdout, "");

  assert.throws(
    () => buildRemoteWorkerWindowsProvisioner({ target: "windows-ia64", outDir: temporaryRoot }),
    /Unsupported remote-worker Windows provisioner target/,
  );
});

test("publication is atomic no-replace under a destination race", () => {
  const root = fs.mkdtempSync(path.join(temporaryRoot, "publish-race-"));
  const source = path.join(root, "source.exe");
  const destination = path.join(root, REMOTE_WORKER_WINDOWS_PROVISIONER_NAME);
  const provenBytes = Buffer.from("proven provisioner bytes");
  const racedBytes = Buffer.from("concurrent destination bytes");
  fs.writeFileSync(source, provenBytes, { flag: "wx" });
  fs.writeFileSync(destination, racedBytes, { flag: "wx" });

  assert.throws(
    () =>
      publishProvenProvisionerNoReplace({
        source,
        destination,
        expectedBytes: provenBytes,
      }),
    (error) => error?.code === "EEXIST",
  );
  assert.deepEqual(fs.readFileSync(destination), racedBytes);
  assert.deepEqual(
    fs.readdirSync(root).sort(asciiCompare),
    [REMOTE_WORKER_WINDOWS_PROVISIONER_NAME, "source.exe"].sort(asciiCompare),
  );
});

test("pair publication is client-first, no-replace, and preserves every partial outcome", () => {
  const root = fs.mkdtempSync(path.join(temporaryRoot, "publish-pair-"));
  const serviceSource = path.join(root, "service-source.exe");
  const clientSource = path.join(root, "client-source.exe");
  const serviceDestination = path.join(root, REMOTE_WORKER_WINDOWS_PROVISIONER_NAME);
  const clientDestination = path.join(root, REMOTE_WORKER_WINDOWS_PROVISIONER_CLIENT_NAME);
  const serviceBytes = Buffer.from("proven service bytes");
  const clientBytes = Buffer.from("proven client bytes");
  fs.writeFileSync(serviceSource, serviceBytes, { flag: "wx" });
  fs.writeFileSync(clientSource, clientBytes, { flag: "wx" });

  assert.equal(
    publishProvenProvisionerPairNoReplace({
      serviceSource,
      serviceDestination,
      serviceExpectedBytes: serviceBytes,
      clientSource,
      clientDestination,
      clientExpectedBytes: clientBytes,
    }),
    true,
  );
  assert.deepEqual(fs.readFileSync(serviceDestination), serviceBytes);
  assert.deepEqual(fs.readFileSync(clientDestination), clientBytes);

  assert.equal(
    publishProvenProvisionerPairNoReplace({
      serviceSource,
      serviceDestination,
      serviceExpectedBytes: serviceBytes,
      clientSource,
      clientDestination,
      clientExpectedBytes: clientBytes,
    }),
    false,
  );
  assert.throws(
    () =>
      publishProvenProvisionerPairNoReplace({
        serviceSource,
        serviceDestination,
        serviceExpectedBytes: Buffer.from("changed service bytes"),
        clientSource,
        clientDestination,
        clientExpectedBytes: clientBytes,
      }),
    /preexisting provisioner pair differs/,
  );

  const partialRoot = fs.mkdtempSync(path.join(temporaryRoot, "publish-partial-"));
  const partialClient = path.join(partialRoot, REMOTE_WORKER_WINDOWS_PROVISIONER_CLIENT_NAME);
  const partialService = path.join(partialRoot, REMOTE_WORKER_WINDOWS_PROVISIONER_NAME);
  fs.writeFileSync(partialClient, clientBytes, { flag: "wx" });
  assert.throws(
    () =>
      publishProvenProvisionerPairNoReplace({
        serviceSource,
        serviceDestination: partialService,
        serviceExpectedBytes: serviceBytes,
        clientSource,
        clientDestination: partialClient,
        clientExpectedBytes: clientBytes,
      }),
    /partial service\/client pair/,
  );
  assert.deepEqual(fs.readFileSync(partialClient), clientBytes);
  assert.equal(fs.existsSync(partialService), false);

  const serviceOnlyRoot = fs.mkdtempSync(path.join(temporaryRoot, "publish-service-only-"));
  const serviceOnlyClient = path.join(serviceOnlyRoot, REMOTE_WORKER_WINDOWS_PROVISIONER_CLIENT_NAME);
  const serviceOnlyService = path.join(serviceOnlyRoot, REMOTE_WORKER_WINDOWS_PROVISIONER_NAME);
  fs.writeFileSync(serviceOnlyService, serviceBytes, { flag: "wx" });
  assert.throws(
    () =>
      publishProvenProvisionerPairNoReplace({
        serviceSource,
        serviceDestination: serviceOnlyService,
        serviceExpectedBytes: serviceBytes,
        clientSource,
        clientDestination: serviceOnlyClient,
        clientExpectedBytes: clientBytes,
      }),
    /partial service\/client pair/,
  );
  assert.deepEqual(fs.readFileSync(serviceOnlyService), serviceBytes);
  assert.equal(fs.existsSync(serviceOnlyClient), false);

  const failedRoot = fs.mkdtempSync(path.join(temporaryRoot, "publish-failed-service-"));
  const failedClient = path.join(failedRoot, REMOTE_WORKER_WINDOWS_PROVISIONER_CLIENT_NAME);
  const failedService = path.join(failedRoot, REMOTE_WORKER_WINDOWS_PROVISIONER_NAME);
  assert.throws(() =>
    publishProvenProvisionerPairNoReplace({
      serviceSource: path.join(failedRoot, "missing-service.exe"),
      serviceDestination: failedService,
      serviceExpectedBytes: serviceBytes,
      clientSource,
      clientDestination: failedClient,
      clientExpectedBytes: clientBytes,
    }),
  );
  assert.deepEqual(fs.readFileSync(failedClient), clientBytes);
  assert.equal(fs.existsSync(failedService), false);

  const residueRoot = fs.mkdtempSync(path.join(temporaryRoot, "publish-residue-"));
  const residueClient = path.join(residueRoot, REMOTE_WORKER_WINDOWS_PROVISIONER_CLIENT_NAME);
  const residueService = path.join(residueRoot, REMOTE_WORKER_WINDOWS_PROVISIONER_NAME);
  const residueName = `.${REMOTE_WORKER_WINDOWS_PROVISIONER_CLIENT_NAME}.${"a".repeat(32)}.tmp`;
  const residuePath = path.join(residueRoot, residueName);
  fs.writeFileSync(residuePath, Buffer.from("preserved crash residue"), { flag: "wx" });
  assert.throws(
    () =>
      publishProvenProvisionerPairNoReplace({
        serviceSource,
        serviceDestination: residueService,
        serviceExpectedBytes: serviceBytes,
        clientSource,
        clientDestination: residueClient,
        clientExpectedBytes: clientBytes,
      }),
    /preserved publication residue.*HOLD/,
  );
  assert.deepEqual(fs.readFileSync(residuePath), Buffer.from("preserved crash residue"));
  assert.equal(fs.existsSync(residueClient), false);
  assert.equal(fs.existsSync(residueService), false);
});

test("pair publication survives real identical and differing two-process contention without replacement", async () => {
  const identical = await runPairPublicationContention({
    label: "identical",
    left: {
      serviceBytes: Buffer.from("identical service"),
      clientBytes: Buffer.from("identical client"),
    },
    right: {
      serviceBytes: Buffer.from("identical service"),
      clientBytes: Buffer.from("identical client"),
    },
  });
  assert.deepEqual(identical.serviceBytes, Buffer.from("identical service"));
  assert.deepEqual(identical.clientBytes, Buffer.from("identical client"));
  assert.equal(identical.outcomes.filter((entry) => entry.published === true).length <= 1, true);
  assert.equal(
    identical.outcomes.every((entry) => isSafePairContentionOutcome(entry, true)),
    true,
  );

  const leftPair = {
    serviceBytes: Buffer.from("left service"),
    clientBytes: Buffer.from("left client"),
  };
  const rightPair = {
    serviceBytes: Buffer.from("right service"),
    clientBytes: Buffer.from("right client"),
  };
  const differing = await runPairPublicationContention({ label: "differing", left: leftPair, right: rightPair });
  const leftWon =
    differing.serviceBytes.equals(leftPair.serviceBytes) && differing.clientBytes.equals(leftPair.clientBytes);
  const rightWon =
    differing.serviceBytes.equals(rightPair.serviceBytes) && differing.clientBytes.equals(rightPair.clientBytes);
  assert.equal(leftWon || rightWon, true, "contention produced a mixed service/client pair");
  assert.equal(differing.outcomes.filter((entry) => entry.published === true).length <= 1, true);
  assert.equal(differing.outcomes.filter((entry) => entry.error === true).length >= 1, true);
  assert.equal(
    differing.outcomes.every((entry) => isSafePairContentionOutcome(entry, false)),
    true,
  );
});

for (const [target, machine] of [
  ["windows-x64", 0x8664],
  ["windows-arm64", 0xaa64],
]) {
  let toolchainAvailable = false;
  let skipReason = "native proof is available only on Windows with the pinned MSVC/SDK toolchain";
  if (process.platform === "win32") {
    try {
      resolveExactWindowsToolchain(target);
      resolveExactWindowsToolchain("windows-x64");
      toolchainAvailable = true;
    } catch (error) {
      skipReason = error instanceof Error ? error.message : String(error);
    }
  }

  test(
    `${target} runs x64 ASan proof and performs paired byte-identical target service/client/test builds`,
    { skip: toolchainAvailable ? false : skipReason, timeout: 240_000 },
    () => {
      const outDir = path.join(temporaryRoot, target);
      const result = buildRemoteWorkerWindowsProvisioner({ target, outDir });
      assert.equal(result.target, target);
      assert.equal(result.machine, `0x${machine.toString(16)}`);
      assert.equal(result.cleanBuildsByteIdentical, true);
      assert.equal(result.msvcVersion, REMOTE_WORKER_WINDOWS_MSVC_VERSION);
      assert.equal(result.windowsSdkVersion, REMOTE_WORKER_WINDOWS_SDK_VERSION);
      const sourceManifest = computeW1B1aCanonicalSourceManifest();
      assert.deepEqual(result.sourceManifest, {
        schema: sourceManifest.schema,
        sha256: sourceManifest.sha256,
        byteLength: sourceManifest.byteLength,
        fileCount: sourceManifest.fileCount,
        entries: sourceManifest.entries,
      });
      const w1b1bP0SourceManifest = computeW1B1bP0CanonicalSourceManifest();
      assert.deepEqual(result.w1b1bP0SourceManifest, {
        schema: w1b1bP0SourceManifest.schema,
        sha256: w1b1bP0SourceManifest.sha256,
        byteLength: w1b1bP0SourceManifest.byteLength,
        fileCount: w1b1bP0SourceManifest.fileCount,
        entries: w1b1bP0SourceManifest.entries,
      });
      assert.equal(result.nativeTests.target, "windows-x64");
      assert.equal(result.nativeTests.addressSanitizer, true);
      assert.equal(result.nativeTests.seed, "0x47504357");
      assert.equal(result.nativeTests.cases, 65_536);
      assert.equal(result.nativeTests.executed, true);
      assert.equal(result.nativeTests.passed, true);
      assert.equal(result.nativeTests.cleanBuildCount, 2);
      assert.equal(result.nativeTests.cleanBuildsByteIdentical, true);
      assert.match(result.nativeTests.sha256, /^[a-f0-9]{64}$/u);
      assert.equal(result.nativeTests.byteLength > 0, true);
      assert.deepEqual(result.nativeTests.nodeInterop, {
        publicKey: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        signature:
          "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
        frameBytes: 72,
        verified: true,
      });
      assert.equal(
        result.nativeTests.protectedArtifactSigningInterop.schema,
        "goatcitadel.remote-worker.protected-signing-interop.v1",
      );
      assert.equal(
        result.nativeTests.protectedArtifactSigningInterop.publicKey,
        "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      );
      assert.deepEqual(
        result.nativeTests.protectedArtifactSigningInterop.cases.map(({ purpose, length, patternSeed, verified }) => ({
          purpose,
          length,
          patternSeed,
          verified,
        })),
        [
          { purpose: "runtime-manifest", length: 0, patternSeed: 49, verified: true },
          { purpose: "runtime-manifest", length: 1, patternSeed: 49, verified: true },
          { purpose: "runtime-manifest", length: 65_535, patternSeed: 49, verified: true },
          { purpose: "runtime-manifest", length: 65_536, patternSeed: 49, verified: true },
          { purpose: "runtime-manifest", length: 65_537, patternSeed: 49, verified: true },
          { purpose: "runtime-manifest", length: 524_288, patternSeed: 49, verified: true },
          { purpose: "admission-evidence", length: 8_388_608, patternSeed: 49, verified: true },
        ],
      );
      assert.deepEqual(result.targetNativeTestBuild, {
        target,
        machine: `0x${machine.toString(16).padStart(4, "0")}`,
        addressSanitizer: target === "windows-x64",
        executed: target === "windows-x64",
        passed: true,
        cleanBuildCount: 2,
        cleanBuildsByteIdentical: true,
        sha256: result.targetNativeTestBuild.sha256,
        byteLength: result.targetNativeTestBuild.byteLength,
      });
      assert.match(result.targetNativeTestBuild.sha256, /^[a-f0-9]{64}$/u);
      assert.equal(result.targetNativeTestBuild.byteLength > 0, true);
      assert.equal(result.monocypherSource.version, "4.0.3");
      assert.equal(result.monocypherSource.archive.bytes, 940_390);
      assert.equal(result.monocypherSource.files.length, 5);
      assert.match(result.monocypherSource.receiptSha256, /^[a-f0-9]{64}$/u);
      assert.match(result.monocypherSource.preflightIdentitySha256, /^[a-f0-9]{64}$/u);
      assert.equal(result.monocypherSource.postflightPassed, true);
      assert.equal(result.nativeCodeEvidence.target, target);
      assert.equal(result.nativeCodeEvidence.msvcVersion, REMOTE_WORKER_WINDOWS_MSVC_VERSION);
      assert.equal(result.nativeCodeEvidence.linkMap.cryptoEd25519CheckRetained, true);
      assert.equal(result.nativeCodeEvidence.linkMap.cryptoEd25519CheckCallgraph.callCount, 2);
      assert.deepEqual(
        {
          mnemonic: result.nativeCodeEvidence.linkMap.cryptoEd25519CheckCallgraph.mnemonic,
          relocation: result.nativeCodeEvidence.linkMap.cryptoEd25519CheckCallgraph.relocation,
          relocationCount: result.nativeCodeEvidence.linkMap.cryptoEd25519CheckCallgraph.relocationCount,
          addressTaken: result.nativeCodeEvidence.linkMap.cryptoEd25519CheckCallgraph.addressTaken,
        },
        {
          mnemonic: target === "windows-x64" ? "call" : "bl",
          relocation: target === "windows-x64" ? "REL32" : "BRANCH26",
          relocationCount: 2,
          addressTaken: false,
        },
      );
      assert.deepEqual(
        result.nativeCodeEvidence.linkMap.cryptoEd25519CheckCallgraph.callers
          .map((entry) => entry.name)
          .sort(asciiCompare),
        ["PureEd25519Sign", "RunKnownAnswerSelfTest"],
      );
      assert.equal(
        result.nativeCodeEvidence.linkMap.cryptoEd25519CheckCallgraph.callers.every(
          (entry) =>
            entry.calls === 1 &&
            entry.symbol.startsWith(`?${entry.name}@`) &&
            entry.header.startsWith(`${entry.symbol} `) &&
            entry.header.endsWith(":"),
        ),
        true,
      );
      assert.equal(
        result.nativeCodeEvidence.linkMap.cryptoEd25519CheckCallgraph.callers.every((entry) =>
          /^[a-f0-9]{64}$/u.test(entry.disassemblySha256),
        ),
        true,
      );
      assert.match(result.nativeCodeEvidence.linkMap.linkedDisassemblySha256, /^[a-f0-9]{64}$/u);
      const linkedCallgraph = result.nativeCodeEvidence.linkMap.linkedCryptoEd25519CheckCallgraph;
      assert.equal(linkedCallgraph.callCount, 2);
      assert.equal(linkedCallgraph.mnemonic, target === "windows-x64" ? "call" : "bl");
      assert.match(linkedCallgraph.targetAddress, /^[A-F0-9]{16}$/u);
      assert.equal(linkedCallgraph.addressTaken, false);
      assert.deepEqual(
        linkedCallgraph.callers.map((entry) => entry.name),
        ["PureEd25519Sign", "RunKnownAnswerSelfTest"],
      );
      assert.equal(
        linkedCallgraph.callers.every(
          (entry) =>
            entry.mapLine.includes("ed25519-runtime.obj") &&
            /^[A-F0-9]{16}$/u.test(entry.startAddress) &&
            /^[A-F0-9]{16}$/u.test(entry.endAddress) &&
            /^[A-F0-9]{16}$/u.test(entry.callAddress) &&
            /^[a-f0-9]{64}$/u.test(entry.disassemblySha256) &&
            entry.disassembly.length > 0,
        ),
        true,
      );
      assert.equal(result.nativeCodeEvidence.linkMap.forbiddenSymbolsRemoved, true);
      assert.equal(result.nativeCodeEvidence.protectedArtifactSigningCallgraph.target, target);
      assert.equal(result.nativeCodeEvidence.protectedArtifactSigningCallgraph.passkeyOwner, "SignProtectedArtifact");
      assert.equal(
        result.nativeCodeEvidence.protectedArtifactSigningCallgraph.passkeyType,
        "ProtectedEd25519SigningBridgeKey",
      );
      assert.equal(result.nativeCodeEvidence.protectedArtifactSigningCallgraph.addressTaken, false);
      assert.deepEqual(
        result.nativeCodeEvidence.protectedArtifactSigningCallgraph.owners[0].calls.map(({ target, count }) => ({
          target,
          count,
        })),
        [
          { target: "ExpandEd25519SeedForProtectedSigning", count: 1 },
          { target: "ReduceEd25519ScalarForProtectedSigning", count: 3 },
          { target: "Ed25519ScalarBaseForProtectedSigning", count: 1 },
          { target: "Ed25519MulAddForProtectedSigning", count: 1 },
          { target: "CheckEd25519EquationForProtectedSigning", count: 1 },
        ],
      );
      assert.equal(result.nativeCodeEvidence.protectedEd25519BridgeCallgraph.target, target);
      assert.equal(result.nativeCodeEvidence.protectedEd25519BridgeCallgraph.owners.length, 5);
      assert.equal(result.nativeCodeEvidence.protectedEd25519BridgeCallgraph.addressTaken, false);
      assert.equal(result.nativeCodeEvidence.linkMap.productionSigningSymbolsRetained, true);
      assert.deepEqual(result.nativeCodeEvidence.linkMap.productionSigningSymbols, [
        "CreateProtectedSigningLease",
        "SignProtectedArtifact",
        "ExpandEd25519SeedForProtectedSigning",
        "ReduceEd25519ScalarForProtectedSigning",
        "Ed25519ScalarBaseForProtectedSigning",
        "Ed25519MulAddForProtectedSigning",
        "CheckEd25519EquationForProtectedSigning",
      ]);
      assert.equal(result.nativeCodeEvidence.linkMap.productionSigningTypesRetained, true);
      assert.deepEqual(result.nativeCodeEvidence.linkMap.productionSigningTypes, [
        "ProtectedArtifactAuthority",
        "ProtectedSigningLease",
      ]);
      assert.equal(result.nativeCodeEvidence.linkMap.productionSigningDomainDataRetained, true);
      assert.equal(result.nativeCodeEvidence.linkMap.productionObjectTestOnlyResidueRemoved, true);
      assert.deepEqual(result.nativeCodeEvidence.linkMap.productionObjectForbiddenResidue, [
        "CreateProtectedSigningLeaseForTest",
        "SetProtectedSigningFailureForTest",
        "SetProtectedSigningDivergenceForTest",
        "SetProtectedSigningRevokeBeforeFinalForTest",
        "SetProtectedSigningWipeObserverForTest",
        "ResetProtectedSigningStateForTest",
        "DriftProtectedSigningLeaseForTest",
        "SignalProtectedSigningStopForTest",
        "ProtectedSigningLeaseConsumedForTest",
        "ProtectedArtifactPatternByteForTest",
        "w1b1b-p0-artifact.bin",
        "w1b1b-p0-key.pk8",
        "g_failure_for_test",
        "g_divergence_for_test",
        "g_wipe_observer_for_test",
        "revoke_ordered_for_test_",
        "atexit",
        "_initterm",
      ]);
      assert.deepEqual(result.nativeCodeEvidence.linkMap.objectBasenames, [
        "monocypher-core.obj",
        "monocypher-ed25519.obj",
        "ed25519-runtime.obj",
        "protected-artifact-signing.obj",
      ]);
      assert.deepEqual(result.nativeCodeEvidence.compiler.protectedArtifactSigningRequiredFlags, [
        "/O2",
        "/Ob0",
        "/GL-",
        "/Gy",
        "/Gw",
        "/volatile:iso",
        "/EHs-c-",
        "/GR-",
      ]);
      for (const [objectName, object] of Object.entries(result.nativeCodeEvidence.objects)) {
        assert.equal(object.bytes > 0, true);
        assert.match(object.sha256, /^[a-f0-9]{64}$/u);
        assert.match(object.secondSha256, /^[a-f0-9]{64}$/u);
        assert.equal(object.secondBytes > 0, true);
        assert.equal(typeof object.byteIdentical, "boolean", `${objectName} raw COFF identity disposition missing`);
        assert.match(object.disassemblySha256, /^[a-f0-9]{64}$/u);
        assert.equal(object.disassembly.length > 0, true);
        assert.match(object.relocationSemanticsSha256, /^[a-f0-9]{64}$/u);
        assert.equal(object.relocationSemantics.length > 0, true);
      }
      assert.equal(result.nativeCodeEvidence.objects.protectedArtifactSigning.testOnlyResidueRemoved, true);
      assert.deepEqual(result.nativeCodeEvidence.objects.protectedArtifactSigning.requiredEd25519Bridges, [
        "ExpandEd25519SeedForProtectedSigning",
        "ReduceEd25519ScalarForProtectedSigning",
        "Ed25519ScalarBaseForProtectedSigning",
        "Ed25519MulAddForProtectedSigning",
        "CheckEd25519EquationForProtectedSigning",
      ]);
      assert.equal(result.nativeCodeEvidence.objects.protectedArtifactSigning.directMonocypherCallsRemoved, true);
      assert.deepEqual(result.ed25519, {
        mode: "fixed-protected-kat-and-admission-evidence-signing",
        rfc8032TestOne: true,
        rfc8410CanonicalEncodings: true,
        realKey: true,
        signingLease: true,
        callableMutation: true,
      });
      assert.deepEqual(result.protectedArtifactSigning, {
        tranche: "M2-admission-evidence",
        compiledObject: true,
        finalServiceReachable: true,
        productionFactory: true,
        productionCaller: true,
        artifactProducer: true,
        signingRoute: true,
        testOnlyFactories: true,
        exactArtifactPasses: 2,
        postSignEquationValidation: true,
      });
      assert.equal(result.publishedNativeTests, false);
      assert.deepEqual(result.entrypoints, {
        service: ["SCM-no-args", "--inspect-stdio"],
        client: ["--service-stdio"],
      });
      assert.equal(result.productionDark, false);
      assert.equal(result.protectedAdmissionEvidenceSigningCallable, true);
      assert.deepEqual(result.externalProof, {
        elevatedScm: "HOLD",
        successfulProductionClientAuthentication: "HOLD",
        privilegedTransport: "HOLD",
        liveArm64Execution: "HOLD",
      });
      assert.match(result.sha256, /^[a-f0-9]{64}$/u);
      assert.equal(path.basename(result.path), REMOTE_WORKER_WINDOWS_PROVISIONER_NAME);
      assert.equal(path.basename(result.service.path), REMOTE_WORKER_WINDOWS_PROVISIONER_NAME);
      assert.equal(path.basename(result.client.path), REMOTE_WORKER_WINDOWS_PROVISIONER_CLIENT_NAME);
      assert.deepEqual(
        fs.readdirSync(outDir).sort(asciiCompare),
        [REMOTE_WORKER_WINDOWS_PROVISIONER_CLIENT_NAME, REMOTE_WORKER_WINDOWS_PROVISIONER_NAME].sort(asciiCompare),
      );
      const serviceBytes = fs.readFileSync(result.service.path);
      const clientBytes = fs.readFileSync(result.client.path);
      assert.equal(serviceBytes.length, result.service.byteLength);
      assert.equal(clientBytes.length, result.client.byteLength);
      assert.equal(result.byteLength, result.service.byteLength);
      assert.equal(result.sha256, result.service.sha256);
      assert.match(result.service.sha256, /^[a-f0-9]{64}$/u);
      assert.match(result.client.sha256, /^[a-f0-9]{64}$/u);
      const expectedClient =
        target === "windows-x64"
          ? { bytes: 69_632, sha256: "c72fb8028d2e18e6edc4573ff7be50d20f4096fc47d9d9965c807d30cf53c507" }
          : { bytes: 59_904, sha256: "8e89ae758f44700ba21f8fbf8ed915b7dd51dcde42e9c9112f94b24d65232179" };
      assert.equal(result.client.byteLength, expectedClient.bytes);
      assert.equal(result.client.sha256, expectedClient.sha256);
      const serviceInspection = inspectRemoteWorkerProvisionerPe(serviceBytes, {
        expectedMachine: machine,
        binaryKind: "service",
      });
      const clientInspection = inspectRemoteWorkerProvisionerPe(clientBytes, {
        expectedMachine: machine,
        binaryKind: "client",
      });
      assert.deepEqual(
        serviceInspection.imports,
        canonicalImports(REMOTE_WORKER_WINDOWS_PROVISIONER_IMPORTS.service[target]),
      );
      assert.deepEqual(
        clientInspection.imports,
        canonicalImports(REMOTE_WORKER_WINDOWS_PROVISIONER_IMPORTS.client[target]),
      );
      const embeddedClientDigest = Buffer.from(result.client.sha256, "hex");
      const firstDigest = serviceBytes.indexOf(embeddedClientDigest);
      assert.notEqual(firstDigest, -1);
      assert.equal(serviceBytes.indexOf(embeddedClientDigest, firstDigest + 1), -1);

      if (target === "windows-x64") {
        proveProductionInspectMode(result.service.path, machine);
        proveProductionClientNegativeMode(result.client.path);
      }
    },
  );
}

function proveProductionInspectMode(executablePath, machine) {
  for (const arguments_ of [[], ["--unknown"], ["--inspect-stdio", "extra"]]) {
    const rejected = spawnSync(executablePath, arguments_, {
      input: Buffer.alloc(0),
      windowsHide: true,
      timeout: 5_000,
    });
    assert.equal(rejected.error, undefined);
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.stdout.length, 0);
  }

  const request = Buffer.alloc(16);
  request.write("GCPW", 0, "ascii");
  request.writeUInt16LE(1, 4);
  request.writeUInt8(0x01, 6);
  request.writeUInt8(0, 7);
  request.writeUInt32LE(1, 8);
  request.writeUInt32LE(0, 12);
  const accepted = spawnSync(executablePath, ["--inspect-stdio"], {
    input: request,
    windowsHide: true,
    timeout: 5_000,
  });
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.status, 0);
  assert.equal(accepted.stdout.length, 48);
  assert.deepEqual(accepted.stdout.subarray(0, 4), Buffer.from("GCPW", "ascii"));
  assert.equal(accepted.stdout.readUInt16LE(4), 1);
  assert.equal(accepted.stdout.readUInt8(6), 0x81);
  assert.equal(accepted.stdout.readUInt8(7), 0);
  assert.equal(accepted.stdout.readUInt32LE(8), 1);
  assert.equal(accepted.stdout.readUInt32LE(12), 32);
  assert.equal(accepted.stdout.readUInt16LE(16), 1);
  assert.equal(accepted.stdout.readUInt16LE(18), machine);
  assert.equal(accepted.stdout.readUInt32LE(20), 2 * 1024 * 1024);
  assert.equal(accepted.stdout.readUInt32LE(24), 8 * 1024);
  assert.equal(accepted.stdout.readUInt32LE(28), 0);
  assert.equal(accepted.stdout.readBigUInt64LE(32), 0x00070007000f0002n);
  assert.equal(accepted.stdout.readBigUInt64LE(40), 0x0000000000000002n);
}

function proveProductionClientNegativeMode(executablePath) {
  for (const arguments_ of [[], ["--unknown"], ["--service-stdio", "extra"]]) {
    const rejected = spawnSync(executablePath, arguments_, {
      input: Buffer.alloc(0),
      windowsHide: true,
      timeout: 5_000,
    });
    assert.equal(rejected.error, undefined);
    assert.equal(rejected.status, 2);
    assert.equal(rejected.stdout.length, 0);
    assert.equal(rejected.stderr.length, 0);
  }

  const inspect = createGcpwRequest(0x01, Buffer.alloc(0));
  const malformedInputs = [];
  for (let length = 0; length < 16; length += 1) {
    malformedInputs.push({ label: `truncated-header-${length}`, input: Buffer.from(inspect.subarray(0, length)) });
  }
  const badMagic = Buffer.from(inspect);
  badMagic.write("XCPW", 0, "ascii");
  malformedInputs.push({ label: "bad-magic", input: badMagic });
  const badVersion = Buffer.from(inspect);
  badVersion.writeUInt16LE(2, 4);
  malformedInputs.push({ label: "bad-version", input: badVersion });
  const badFlags = Buffer.from(inspect);
  badFlags.writeUInt8(1, 7);
  malformedInputs.push({ label: "bad-flags", input: badFlags });
  const badRequestId = Buffer.from(inspect);
  badRequestId.writeUInt32LE(2, 8);
  malformedInputs.push({ label: "bad-request-id", input: badRequestId });
  const unknownOpcode = Buffer.from(inspect);
  unknownOpcode.writeUInt8(0xff, 6);
  malformedInputs.push({ label: "unknown-opcode", input: unknownOpcode });
  const overCap = Buffer.from(inspect);
  overCap.writeUInt32LE(2 * 1024 * 1024 + 1, 12);
  malformedInputs.push({ label: "over-cap-declaration", input: overCap });
  const truncatedBody = createGcpwRequest(0x10, Buffer.from([0x41]));
  malformedInputs.push({ label: "truncated-body", input: truncatedBody.subarray(0, truncatedBody.length - 1) });
  malformedInputs.push({ label: "trailing-byte", input: Buffer.concat([inspect, Buffer.from([0x00])]) });
  malformedInputs.push({ label: "second-frame", input: Buffer.concat([inspect, inspect]) });
  malformedInputs.push({ label: "inspect-payload", input: createGcpwRequest(0x01, Buffer.from([0x00])) });

  const protocolInvalid = createGcpwError(1);
  for (const { label, input } of malformedInputs) {
    const rejected = spawnSync(executablePath, ["--service-stdio"], {
      input,
      windowsHide: true,
      timeout: 5_000,
    });
    assert.equal(rejected.error, undefined, label);
    assert.equal(rejected.signal, null, label);
    assert.equal(rejected.status, 3, label);
    assert.deepEqual(rejected.stdout, protocolInvalid, label);
    assert.equal(rejected.stderr.length, 0, label);
  }

  const unavailable = spawnSync(executablePath, ["--service-stdio"], {
    input: inspect,
    windowsHide: true,
    timeout: 15_000,
  });
  assert.equal(unavailable.error, undefined);
  assert.equal(unavailable.status, 5);
  assert.equal(unavailable.stdout.length, 0);
  assert.equal(unavailable.stderr.length, 0);
}

function createGcpwRequest(opcode, payload) {
  const request = Buffer.alloc(16 + payload.length);
  request.write("GCPW", 0, "ascii");
  request.writeUInt16LE(1, 4);
  request.writeUInt8(opcode, 6);
  request.writeUInt8(0, 7);
  request.writeUInt32LE(1, 8);
  request.writeUInt32LE(payload.length, 12);
  payload.copy(request, 16);
  return request;
}

function createGcpwError(code) {
  const response = Buffer.alloc(20);
  response.write("GCPW", 0, "ascii");
  response.writeUInt16LE(1, 4);
  response.writeUInt8(0x7f, 6);
  response.writeUInt8(0, 7);
  response.writeUInt32LE(1, 8);
  response.writeUInt32LE(4, 12);
  response.writeUInt32LE(code, 16);
  return response;
}

function extractCompileIncludes(project) {
  return [...project.matchAll(/<ClCompile\s+Include="([^"]+)"\s*\/>/gu)]
    .map((match) => match[1].replaceAll("\\", "/"))
    .sort(asciiCompare);
}

function extractIncludeIncludes(project) {
  return [...project.matchAll(/<ClInclude\s+Include="([^"]+)"\s*\/>/gu)]
    .map((match) => match[1].replaceAll("\\", "/"))
    .sort(asciiCompare);
}

function extractSingle(value, pattern) {
  const match = pattern.exec(value);
  assert.notEqual(match, null);
  return match[1];
}

async function runPairPublicationContention({ label, left, right }) {
  const root = fs.mkdtempSync(path.join(temporaryRoot, `publish-contention-${label}-`));
  const gatePath = path.join(root, "release.gate");
  const serviceDestination = path.join(root, REMOTE_WORKER_WINDOWS_PROVISIONER_NAME);
  const clientDestination = path.join(root, REMOTE_WORKER_WINDOWS_PROVISIONER_CLIENT_NAME);
  const publisherModuleUrl = pathToFileURL(builderPath).href;
  const childScript = `
    import fs from "node:fs";
    import { publishProvenProvisionerPairNoReplace } from ${JSON.stringify(publisherModuleUrl)};
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    fs.writeFileSync(config.readyPath, "ready", { flag: "wx" });
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(config.gatePath)) {
      if (Date.now() >= deadline) throw new Error("pair publication contention gate timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    try {
      const published = publishProvenProvisionerPairNoReplace({
        serviceSource: config.serviceSource,
        serviceDestination: config.serviceDestination,
        serviceExpectedBytes: Buffer.from(config.serviceExpectedBase64, "base64"),
        clientSource: config.clientSource,
        clientDestination: config.clientDestination,
        clientExpectedBytes: Buffer.from(config.clientExpectedBase64, "base64"),
      });
      process.stdout.write(JSON.stringify({ published }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        error: true,
        code: typeof error?.code === "string" ? error.code : null,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  `;

  const launches = [left, right].map((pair, index) => {
    const side = index === 0 ? "left" : "right";
    const serviceSource = path.join(root, `${side}-service-source.exe`);
    const clientSource = path.join(root, `${side}-client-source.exe`);
    const readyPath = path.join(root, `${side}.ready`);
    const configPath = path.join(root, `${side}.json`);
    fs.writeFileSync(serviceSource, pair.serviceBytes, { flag: "wx" });
    fs.writeFileSync(clientSource, pair.clientBytes, { flag: "wx" });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        serviceSource,
        serviceDestination,
        serviceExpectedBase64: pair.serviceBytes.toString("base64"),
        clientSource,
        clientDestination,
        clientExpectedBase64: pair.clientBytes.toString("base64"),
        readyPath,
        gatePath,
      }),
      { flag: "wx" },
    );
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childScript, configPath], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { child, readyPath };
  });

  const completions = launches.map(({ child }) => collectChildResult(child));
  try {
    await waitForFiles(
      launches.map(({ readyPath }) => readyPath),
      10_000,
    );
    fs.writeFileSync(gatePath, "release", { flag: "wx" });
  } catch (error) {
    for (const { child } of launches) child.kill();
    throw error;
  }
  const childResults = await Promise.all(completions);
  const outcomes = childResults.map(({ status, signal, stdout, stderr }) => {
    assert.equal(signal, null);
    assert.equal(status, 0, stderr);
    assert.equal(stderr, "");
    return JSON.parse(stdout);
  });
  assert.equal(fs.existsSync(serviceDestination), true);
  assert.equal(fs.existsSync(clientDestination), true);
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => /^\..+\.[a-f0-9]{32}\.tmp$/u.test(name)),
    [],
  );
  return {
    outcomes,
    serviceBytes: fs.readFileSync(serviceDestination),
    clientBytes: fs.readFileSync(clientDestination),
  };
}

function isSafePairContentionOutcome(entry, identicalPairs) {
  if (entry?.published === true || entry?.published === false || entry?.code === "EEXIST") {
    return true;
  }
  if (entry?.error !== true || entry?.code !== null || typeof entry?.message !== "string") {
    return false;
  }
  if (entry.message === "The provisioner output contains a partial service/client pair; preserve it and HOLD.") {
    return true;
  }
  if (
    /^The provisioner output contains preserved publication residue .+; HOLD without cleanup\.$/u.test(entry.message)
  ) {
    return true;
  }
  return (
    !identicalPairs &&
    entry.message === "The preexisting provisioner pair differs from the newly proven pair; preserve it and HOLD."
  );
}

function collectChildResult(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function waitForFiles(paths, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((candidate) => fs.existsSync(candidate))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for pair-publication publishers: ${paths.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createDigestCarrierPe(digestHex) {
  const bytes = Buffer.alloc(2048);
  const peOffset = 0x80;
  const coffOffset = peOffset + 4;
  const optionalSize = 240;
  const sectionOffset = coffOffset + 20 + optionalSize;
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(peOffset, 0x3c);
  bytes.writeUInt32LE(0x00004550, peOffset);
  bytes.writeUInt16LE(0x8664, coffOffset);
  bytes.writeUInt16LE(1, coffOffset + 2);
  bytes.writeUInt16LE(optionalSize, coffOffset + 16);
  bytes.writeUInt16LE(0x20b, coffOffset + 20);
  bytes.write(".rdata\0\0", sectionOffset, "ascii");
  bytes.writeUInt32LE(0x400, sectionOffset + 8);
  bytes.writeUInt32LE(0x1000, sectionOffset + 12);
  bytes.writeUInt32LE(0x400, sectionOffset + 16);
  bytes.writeUInt32LE(0x400, sectionOffset + 20);
  bytes.writeUInt32LE(0x40000040, sectionOffset + 36);
  Buffer.from(digestHex, "hex").copy(bytes, 0x480);
  return bytes;
}

function createSyntheticProvisionerPe(machine, { binaryKind = "service", imports = undefined } = {}) {
  const target = machine === 0x8664 ? "windows-x64" : "windows-arm64";
  const frozenImports = thawImports(imports ?? REMOTE_WORKER_WINDOWS_PROVISIONER_IMPORTS[binaryKind][target]);
  const bytes = Buffer.alloc(64 * 1024);
  const peOffset = 0x80;
  const coffOffset = peOffset + 4;
  const optionalOffset = coffOffset + 20;
  const optionalSize = 240;
  const sectionOffset = optionalOffset + optionalSize;
  const importDescriptorRva = 0x1100;
  const dllNameRva = 0x1300;
  const originalThunkRva = 0x1800;
  const importAddressTableRva = 0x2800;
  const hintNameRva = 0x4000;
  const debugDirectoryRva = 0xd000;
  const loadConfigRva = 0xd200;
  const relocationRva = 0xd400;

  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(peOffset, 0x3c);
  bytes.writeUInt32LE(0x00004550, peOffset);
  bytes.writeUInt16LE(machine, coffOffset);
  bytes.writeUInt16LE(2, coffOffset + 2);
  bytes.writeUInt32LE(0x12345678, coffOffset + 4);
  bytes.writeUInt16LE(optionalSize, coffOffset + 16);
  bytes.writeUInt16LE(0x0022, coffOffset + 18);
  bytes.writeUInt16LE(0x20b, optionalOffset);
  bytes.writeUInt32LE(0x1000, optionalOffset + 16);
  bytes.writeBigUInt64LE(0x140000000n, optionalOffset + 24);
  bytes.writeUInt32LE(0x1000, optionalOffset + 32);
  bytes.writeUInt32LE(0x400, optionalOffset + 36);
  bytes.writeUInt32LE(0x10000, optionalOffset + 56);
  bytes.writeUInt32LE(0x400, optionalOffset + 60);
  bytes.writeUInt16LE(3, optionalOffset + 68);
  bytes.writeUInt16LE(0x4160, optionalOffset + 70);
  bytes.writeUInt32LE(16, optionalOffset + 108);

  const totalThunkBytes = frozenImports.reduce((total, entry) => total + (entry.functions.length + 1) * 8, 0);
  writeDirectory(bytes, 1, importDescriptorRva, (frozenImports.length + 1) * 20);
  writeDirectory(bytes, 5, relocationRva, 12);
  writeDirectory(bytes, 6, debugDirectoryRva, 56);
  writeDirectory(bytes, 10, loadConfigRva, 160);
  writeDirectory(bytes, 12, importAddressTableRva, totalThunkBytes);

  bytes.write(".text\0\0\0", sectionOffset, "ascii");
  bytes.writeUInt32LE(0xc000, sectionOffset + 8);
  bytes.writeUInt32LE(0x1000, sectionOffset + 12);
  bytes.writeUInt32LE(0xc000, sectionOffset + 16);
  bytes.writeUInt32LE(0x400, sectionOffset + 20);
  bytes.writeUInt32LE(0x60000020, sectionOffset + 36);

  const readOnlySectionOffset = sectionOffset + 40;
  bytes.write(".rdata\0\0", readOnlySectionOffset, "ascii");
  bytes.writeUInt32LE(0x3000, readOnlySectionOffset + 8);
  bytes.writeUInt32LE(0xd000, readOnlySectionOffset + 12);
  bytes.writeUInt32LE(0x3000, readOnlySectionOffset + 16);
  bytes.writeUInt32LE(rvaToSyntheticOffset(0xd000), readOnlySectionOffset + 20);
  bytes.writeUInt32LE(0x40000040, readOnlySectionOffset + 36);

  let nextDllNameRva = dllNameRva;
  let nextOriginalThunkRva = originalThunkRva;
  let nextImportAddressTableRva = importAddressTableRva;
  let nextHintNameRva = hintNameRva;
  frozenImports.forEach((entry, descriptorIndex) => {
    const descriptorOffset = rvaToSyntheticOffset(importDescriptorRva) + descriptorIndex * 20;
    bytes.writeUInt32LE(nextOriginalThunkRva, descriptorOffset);
    bytes.writeUInt32LE(nextDllNameRva, descriptorOffset + 12);
    bytes.writeUInt32LE(nextImportAddressTableRva, descriptorOffset + 16);
    bytes.write(`${entry.dll}\0`, rvaToSyntheticOffset(nextDllNameRva), "ascii");
    nextDllNameRva += Buffer.byteLength(entry.dll, "ascii") + 1;

    entry.functions.forEach((name, functionIndex) => {
      const originalThunkOffset = rvaToSyntheticOffset(nextOriginalThunkRva) + functionIndex * 8;
      const addressThunkOffset = rvaToSyntheticOffset(nextImportAddressTableRva) + functionIndex * 8;
      bytes.writeBigUInt64LE(BigInt(nextHintNameRva), originalThunkOffset);
      bytes.writeBigUInt64LE(BigInt(nextHintNameRva), addressThunkOffset);
      const hintNameOffset = rvaToSyntheticOffset(nextHintNameRva);
      bytes.writeUInt16LE(functionIndex, hintNameOffset);
      bytes.write(`${name}\0`, hintNameOffset + 2, "ascii");
      nextHintNameRva += 2 + Buffer.byteLength(name, "ascii") + 1;
      if ((nextHintNameRva & 1) !== 0) nextHintNameRva += 1;
    });
    const thunkBytes = (entry.functions.length + 1) * 8;
    nextOriginalThunkRva += thunkBytes;
    nextImportAddressTableRva += thunkBytes;
  });

  assert.equal(nextDllNameRva < originalThunkRva, true, "synthetic DLL-name layout overflow");
  assert.equal(nextOriginalThunkRva <= importAddressTableRva, true, "synthetic original-thunk layout overflow");
  assert.equal(nextImportAddressTableRva <= hintNameRva, true, "synthetic IAT layout overflow");
  assert.equal(nextHintNameRva < debugDirectoryRva, true, "synthetic hint/name layout overflow");

  writeSyntheticDebugEntry(bytes, rvaToSyntheticOffset(debugDirectoryRva), 13, 0xd080, Buffer.from("GCTL"));
  const repro = Buffer.alloc(36, 0x5a);
  repro.writeUInt32LE(32, 0);
  writeSyntheticDebugEntry(bytes, rvaToSyntheticOffset(debugDirectoryRva) + 28, 16, 0xd090, repro);

  const loadConfigOffset = rvaToSyntheticOffset(loadConfigRva);
  bytes.writeUInt32LE(160, loadConfigOffset);
  bytes.writeBigUInt64LE(0x14000d2c0n, loadConfigOffset + 112);
  bytes.writeBigUInt64LE(0x14000d2c8n, loadConfigOffset + 120);
  bytes.writeBigUInt64LE(0x14000d2e0n, loadConfigOffset + 128);
  bytes.writeBigUInt64LE(2n, loadConfigOffset + 136);
  bytes.writeUInt32LE(0x500, loadConfigOffset + 144);
  bytes.writeUInt32LE(0x1000, rvaToSyntheticOffset(0xd2e0));
  bytes.writeUInt32LE(0x1010, rvaToSyntheticOffset(0xd2e0) + 4);

  const relocationOffset = rvaToSyntheticOffset(relocationRva);
  bytes.writeUInt32LE(0xd000, relocationOffset);
  bytes.writeUInt32LE(12, relocationOffset + 4);
  bytes.writeUInt16LE((10 << 12) | 0x270, relocationOffset + 8);
  bytes.writeUInt16LE(0, relocationOffset + 10);
  return bytes;
}

function thawImports(imports) {
  return imports.map((entry) => ({ dll: entry.dll, functions: [...entry.functions] }));
}

function canonicalImports(imports) {
  return thawImports(imports)
    .map((entry) => ({ dll: entry.dll, functions: [...new Set(entry.functions)].sort(asciiCompare) }))
    .sort((left, right) => asciiCompare(left.dll, right.dll));
}

function writeDirectory(bytes, index, rva, size) {
  const optionalOffset = 0x80 + 4 + 20;
  bytes.writeUInt32LE(rva, optionalOffset + 112 + index * 8);
  bytes.writeUInt32LE(size, optionalOffset + 116 + index * 8);
}

function writeSyntheticDebugEntry(bytes, entryOffset, type, dataRva, data) {
  const dataOffset = rvaToSyntheticOffset(dataRva);
  bytes.writeUInt32LE(0x12345678, entryOffset + 4);
  bytes.writeUInt32LE(type, entryOffset + 12);
  bytes.writeUInt32LE(data.length, entryOffset + 16);
  bytes.writeUInt32LE(dataRva, entryOffset + 20);
  bytes.writeUInt32LE(dataOffset, entryOffset + 24);
  data.copy(bytes, dataOffset);
}

function rvaToSyntheticOffset(rva) {
  return 0x400 + (rva - 0x1000);
}

function asciiCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
