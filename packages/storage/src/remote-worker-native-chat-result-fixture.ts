import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readRemoteWorkerCellMountedWorkspaceCheckpoint, remoteWorkerCellProvisioningMountedWorkspaceAnchor,
  readRemoteWorkerCellProvisioningCheckpoint, remoteWorkerRuntimeBundleManifestSha256, remoteWorkerCellCapacityInventorySha256,
  type RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";
import { REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA } from "@goatcitadel/contracts";
import { prepareWindowsRuntimeDispatch, type WindowsRuntimeDispatchRequest } from "@goatcitadel/contracts/remote-worker-runtime-node";
import { objectInventoryFixture } from "../../contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import { capacityInventoryFixture } from "../../contracts/src/remote-worker-cell-capacity-inventory-test-fixture.js";
import { verifyNativeRuntimeLeaseResume } from "./remote-worker-native-runtime-resume-fixture.js";
import { verifyCellProvisioningExchange } from "./remote-worker-cell-exchange-fixture.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { RemoteWorkerRuntimeAdmissionRepository, type RemoteWorkerRuntimeAdmissionInput, type RemoteWorkerRuntimeAdmissionResult } from "./remote-worker-runtime-admission-repo.js";
import { RemoteWorkerRuntimeResultRepository } from "./remote-worker-runtime-result-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import type { RemoteWorkerCellCapacityAuthority } from "./remote-worker-cell-capacity-admission-repo.js";

/** Real temporary DB approval, native resume, admission and result retention.
 * Native journal/result bytes are controlled fixtures; no OS disk or job operations. */
export async function verifyRetainedNativeChatResult(
  db: Parameters<typeof verifyNativeRuntimeLeaseResume>[0], seed: string,
  worker: Parameters<typeof verifyNativeRuntimeLeaseResume>[2], fence: Parameters<typeof verifyNativeRuntimeLeaseResume>[3],
  onAdmitted?: (authority: RemoteWorkerCellCapacityAuthority) => void,
  admit?: (input: RemoteWorkerRuntimeAdmissionInput) => Promise<RemoteWorkerRuntimeAdmissionResult>,
) {
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const cells = new RemoteWorkerCellRepository(db), assignments = new RemoteWorkerAssignmentRepository(db), clock = new DurableRunRepository(db);
  let history!: RemoteWorkerCellProvisioningExchange;
  let request!: WindowsRuntimeDispatchRequest;
  let expectation!: ReturnType<typeof prepareWindowsRuntimeDispatch>["expectation"];
  const resumed = await verifyNativeRuntimeLeaseResume(db, seed, worker, fence, "approve", {
    recoveryCount: 0, expireBeforeRenewal: false,
    prepareReview({ ref, token }) {
      verifyCellProvisioningExchange(db, ref, token, fence, () => { throw new Error("Fixture must retain its protected authority."); },
        (_current, exchange) => { history = exchange; return () => {}; }, 120_000, true);
      const currentToken = digest(`${ref.assignmentId}:renewed`);
      const active = assignments.resolveActiveAuthorityByLeaseTokenHash(currentToken, fence)!;
      const journal = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]);
      const mounted = readRemoteWorkerCellMountedWorkspaceCheckpoint(remoteWorkerCellProvisioningMountedWorkspaceAnchor(history), history.mountedWorkspaceRecords![1]);
      const jobName = history.plan.cellName, parentPath = "C:\\controlled-mounted-volume", root = `${parentPath}\\${jobName}`;
      const identities = mounted.workspaceCheckpoint.directoryIdentityHex;
      const runtimeBundle = { schemaVersion: "goatcitadel.worker-runtime-bundle.v1" as const,
        files: [{ relativePath: "entry.exe", bytes: 3, sha256: digest("controlled-image") }] };
      request = { nonce: digest(`native-chat-result:${seed}`), anchor: { fileIdentity: journal.journalIdentityHex, preparedSha256: journal.recordSha256 },
        checkpointSha256: mounted.recordSha256, inventoryLimits: { maxEntries: 20000, maxDepth: 64, wallMs: 10000 },
        launch: { jobName, appContainerName: `GoatCitadel.Worker.${jobName.slice(8)}`, image: `${root}\\runtime\\entry.exe`,
          commandLine: `"${root}\\runtime\\entry.exe" controlled`, directory: `${root}\\work`, runtimeRoot: `${root}\\runtime`,
          imageSha256: digest("controlled-image"), directoryIdentity: identities[3]!, runtimeRootIdentity: identities[2]!, runtimeBundle,
          runtimeBundleSha256: remoteWorkerRuntimeBundleManifestSha256(runtimeBundle), environment: { SystemRoot: "C:\\Windows" },
          limits: { processLimit: 1, memoryBytes: 64 * 1024 * 1024, cpuMilli: 1000, wallMs: 60000, rawOutputBytes: 65536, diagnosticBytes: 1024, inputBytes: 100 },
          protectedWorkspace: { parentPath, parentIdentity: mounted.workspaceCheckpoint.rootIdentityHex,
            rootIdentity: identities[0]!, controlIdentity: identities[1]!, runtimeIdentity: identities[2]!, workIdentity: identities[3]!,
            ownerSid: history.plan.ownerSid, controllerSid: history.plan.controllerSid } } };
      expectation = prepareWindowsRuntimeDispatch(request).expectation;
      const cell = cells.getCell(ref)!;
      cells.persistPlatformIdentity({ ...ref, provisioningOwner: cell.provisioningOwner!, provisioningLeaseExpiresAt: cell.provisioningLeaseExpiresAt!,
        platformIdentity: { schemaVersion: "goatcitadel.remote-worker-cell-platform.v2", backend: "windows_native", jobName,
          appContainerName: request.launch.appContainerName, volumeIdentitySha256: digest("planned-volume"),
          runtimeBundleSha256: expectation.runtimeBundleSha256, launcherSha256: digest("planned-launcher"), networkPolicy: "deny_all" },
        detailSha256: digest("controlled-platform"), now: clock.readDatabaseNow() });
      const ready = cells.getCell(ref)!;
      return { token: currentToken, lease: active.lease, nativeRuntime: { schemaVersion: "goatcitadel.native-runtime-approval.v1", ...ref,
        profileSha256: ready.profileSha256, expectation, expectedCapacityRevision: ready.capacityRevision,
        expectedExecutionRevision: ready.executionRevision, expectedCleanupRevision: ready.cleanupRevision, expectedBackupRevision: ready.backupRevision } };
    },
  });
  const { ref } = resumed, cell = cells.getCell(ref)!;
  const authority = { ...ref, leaseTokenSha256: resumed.token, leaseRevision: resumed.lease.leaseRevision, protectedAuthority: fence };
  const inventory = capacityInventoryFixture(cell.profileSha256, `${seed}:admission`);
  const admissionInput: RemoteWorkerRuntimeAdmissionInput = { ...authority,
    approvalId: resumed.approval.approvalId, request, expectation, expectedCapacityRevision: cell.capacityRevision,
    expectedExecutionRevision: cell.executionRevision, expectedCleanupRevision: cell.cleanupRevision, expectedBackupRevision: cell.backupRevision,
    inventory, inventoryBinding: { profileSha256: inventory.profileSha256, captureSha256: inventory.captureSha256,
      inventorySha256: remoteWorkerCellCapacityInventorySha256(inventory) },
    observation: { reservation: cell.capacity, incomingBytes: 1000, peakDiskBytes: 0, peakMemoryBytes: 0,
      peakFileCount: 0, peakProcessCount: 0, rawOutputBytes: 0 } };
  const admission = admit ? await admit(admissionInput)
    : new RemoteWorkerRuntimeAdmissionRepository(db).admitPreparedForAssignment(admissionInput);
  assert.equal(admission.decision, "accept");
  onAdmitted?.(authority);
  const results = new RemoteWorkerRuntimeResultRepository(db), read = { ...ref, durableRunId: resumed.parent.runId, continuation: resumed.continuation };
  assert.equal(results.readChatContextForParent(read), null);
  const { summary, chunks } = objectInventoryFixture(history, 2);
  for (const buffer of [summary, ...chunks]) Buffer.from(expectation.nonce, "hex").copy(buffer, 0);
  const header = Buffer.alloc(256); header.write("GCRRS001");
  for (const [offset, value] of [[8, expectation.nonce], [40, expectation.requestSha256], [72, expectation.checkpointSha256], [184, expectation.runtimeBundleSha256]] as const)
    Buffer.from(value, "hex").copy(header, offset);
  header.writeUInt32LE(0x9fef, 104); header.writeUInt32LE(23, 116); header.writeUInt32LE(777, 120); header.writeUInt32LE(6, 216);
  const text = "useful native output\n";
  header.writeBigUInt64LE(BigInt(Buffer.byteLength(text)), 168);
  for (const [offset, value] of [[220, history.plan.virtualDiskBytes], [228, history.plan.reservedDiskBytes],
    [236, 21 * 1024], [244, 24576]] as const) header.writeBigUInt64LE(BigInt(value), offset);
  const resultHex = Buffer.concat([header, summary, ...chunks]).toString("hex");
  const retained = results.retainForAssignment({ ...authority, nonce: expectation.nonce, resultHex });
  assert.deepEqual(retained.result.backing, { backingFileBytes: history.plan.virtualDiskBytes,
    backingAllocatedBytes: history.plan.reservedDiskBytes, journalBytes: 21504, journalAllocatedBytes: 24576,
    hostFileAllocatedBytes: history.plan.reservedDiskBytes + 24576 });
  assert.deepEqual(results.findForAssignment({ ...authority, nonce: expectation.nonce })?.result.backing, retained.result.backing);
  assert.deepEqual(results.readForChatContinuation(read).recorded?.result.backing, retained.result.backing);
  const nativeChatContext = results.readChatContextForParent(read)!;
  assert.equal(nativeChatContext.recorded!.outcome.exitCode, 23);
  assert.equal(nativeChatContext.recorded!.receipt.resultSha256, retained.result.resultSha256);
  assert.equal(assignments.resolveActiveChatExecution({ ...ref, leaseTokenSha256: resumed.token }, fence).workload.nativeChatContext?.recorded?.outcome.exitCode, 23);
  assert.equal(nativeChatContext.schemaVersion, "goatcitadel.remote-worker-native-chat-context.v1");
  const output = results.retainOutputForAssignment({ ...authority, evidence: { schemaVersion: REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA,
    nonce: expectation.nonce, requestSha256: expectation.requestSha256, resultSha256: retained.result.resultSha256,
    streams: { stdout: { bytes: Buffer.byteLength(text), sha256: digest(text), text, truncated: false, provenance: "native_stream_local_diagnostic" },
      stderr: { bytes: 0, sha256: digest(""), text: "", truncated: false, provenance: "native_stream_local_diagnostic" } } } });
  const withOutput = results.readChatContextForParent(read)!;
  assert.equal(withOutput.schemaVersion, "goatcitadel.remote-worker-native-chat-context.v2");
  if (withOutput.schemaVersion !== "goatcitadel.remote-worker-native-chat-context.v2") throw new Error("Expected output context");
  assert.deepEqual(withOutput.output, output.evidence);
  assert.deepEqual(assignments.resolveActiveChatExecution({ ...ref, leaseTokenSha256: resumed.token }, fence).workload.nativeChatContext, withOutput);
  assert.throws(() => results.authorizeForAssignment({ ...authority, nonce: expectation.nonce, requestSha256: expectation.requestSha256, phase: "execution" }));
  return { ...resumed, authority, nativeChatContext, expectation, resultHex, retained };
}
