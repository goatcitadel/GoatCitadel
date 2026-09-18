import { describe, expect, it, vi } from "vitest";
import { normalizeRemoteWorkerNativeContinuation, REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA, remoteWorkerNativeFileStagingSha256 } from "@goatcitadel/contracts";
import { remoteWorkerAssignmentCanonicalSha256 as digest, remoteWorkerRuntimeBundleManifestSha256, remoteWorkerCellCapacityInventorySha256, type ApprovalRequest } from "@goatcitadel/contracts";
import { capacityInventoryFixture } from "../../../../packages/contracts/src/remote-worker-cell-capacity-inventory-test-fixture.js";
import { REMOTE_WORKER_NATIVE_CELL_POLICY } from "./remote-worker-native-cell-policy.js";
import type { ApprovalRuntime } from "./approval-runtime-service.js";
import { normalizeWindowsRuntimeDispatch, prepareWindowsRuntimeDispatch } from "@goatcitadel/contracts/remote-worker-runtime-node";
import type { RemoteWorkerRuntimeRequestPreparationInput } from "@goatcitadel/storage";
import { RemoteWorkerRuntimeRequestProducer } from "./remote-worker-runtime-request-producer.js";
import { createRemoteWorkerExecutionOwners, type RemoteWorkerExecutionOwnersDependencies } from "./remote-worker-execution-owners.js";

function fixture() {
  const identity = (digit: string) => "1".repeat(16) + digit.repeat(32), jobName = `gc-cell-${"1".repeat(32)}`, root = `C:\\cells\\${jobName}`;
  const runtimeBundle = { schemaVersion: "goatcitadel.worker-runtime-bundle.v1" as const, files: [{ relativePath: "entry.exe", bytes: 3, sha256: "a".repeat(64) }] };
  const launch = { jobName, appContainerName: `GoatCitadel.Worker.${"1".repeat(32)}`, image: `${root}\\runtime\\entry.exe`,
    commandLine: `"${root}\\runtime\\entry.exe" serve`, directory: `${root}\\work`, runtimeRoot: `${root}\\runtime`,
    imageSha256: "a".repeat(64), directoryIdentity: identity("5"), runtimeRootIdentity: identity("4"), runtimeBundle,
    runtimeBundleSha256: remoteWorkerRuntimeBundleManifestSha256(runtimeBundle), environment: { SystemRoot: "C:\\Windows" },
    limits: { processLimit: 1, memoryBytes: 64 * 1024 * 1024, cpuMilli: 1000, wallMs: 60000, rawOutputBytes: 65536, diagnosticBytes: 1024, inputBytes: 4096 },
    protectedWorkspace: { parentPath: "C:\\cells", parentIdentity: identity("1"), rootIdentity: identity("2"), controlIdentity: identity("3"),
      runtimeIdentity: identity("4"), workIdentity: identity("5"), ownerSid: "S-1-5-18", controllerSid: "S-1-5-80-1-2-3-4-5" } };
  const input = { registryWorkspaceId: "default", assignmentId: "assignment", assignmentGeneration: 1, leaseRevision: 1,
    leaseTokenSha256: "b".repeat(64), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} }, launch,
    inventoryLimits: { maxEntries: 1000, maxDepth: 32, wallMs: 10000 } } as unknown as RemoteWorkerRuntimeRequestPreparationInput;
  const candidate = (value = input) => {
    const request = normalizeWindowsRuntimeDispatch({ nonce: "9".repeat(64), anchor: { fileIdentity: identity("6"), preparedSha256: "7".repeat(64) },
      checkpointSha256: "8".repeat(64), launch: value.launch, inventoryLimits: value.inventoryLimits,
      ...(value.fileStaging === undefined ? {} : { fileStaging: value.fileStaging }) });
    const candidateExpectation = prepareWindowsRuntimeDispatch(request).expectation;
    const revisions = { expectedCapacityRevision: 3, expectedExecutionRevision: 2, expectedCleanupRevision: 0, expectedBackupRevision: 0 };
    return { decision: "review_required" as const, request, candidateExpectation, revisions,
      approvalDraft: { kind: "remote_worker.native_runtime", riskLevel: "danger" as const,
        payload: { nativeRuntime: { schemaVersion: "goatcitadel.native-runtime-approval.v1", registryWorkspaceId: value.registryWorkspaceId,
          assignmentId: value.assignmentId, assignmentGeneration: value.assignmentGeneration, profileSha256: "c".repeat(64), expectation: candidateExpectation, ...revisions },
          ...(value.discloseFilesToGateway ? { nativeFileDisclosure: { schemaVersion: REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA,
            destination: "gateway_artifacts", registryWorkspaceId: value.registryWorkspaceId, assignmentId: value.assignmentId,
            assignmentGeneration: value.assignmentGeneration, nonce: candidateExpectation.nonce, requestSha256: candidateExpectation.requestSha256,
            executionWorkspaceId: "execution-workspace", pathJailSha256: "d".repeat(64), fileStagingSha256: remoteWorkerNativeFileStagingSha256(value.fileStaging) } } : {}) },
        preview: {}, linkage: { workspaceId: "execution-workspace", taskId: "task", durableRunId: "run", sessionId: "session", turnId: "turn", actionType: "remote_worker.native_runtime" } } };
  };
  const prepareRequestForAssignment = vi.fn(async (value: RemoteWorkerRuntimeRequestPreparationInput) => candidate(value));
  const storage = { remoteWorkerRuntimeAdmissions: { prepareRequestForAssignment } };
  const producer = new RemoteWorkerRuntimeRequestProducer(storage as ConstructorParameters<typeof RemoteWorkerRuntimeRequestProducer>[0]);
  return { launch, input, candidate, prepareRequestForAssignment, storage, producer };
}

describe("Gateway native runtime request producer", () => {
  it.each(["missing", "unsolicited", "destination", "workspace", "plan", "request"])("rejects a substituted file disclosure scope: %s", async mode => {
    const f = fixture(), input = { ...f.input, discloseFilesToGateway: mode !== "unsolicited",
      fileStaging: { paths: ["report.txt"], maximumFileBytes: 1024, maximumTotalBytes: 2048 } };
    f.prepareRequestForAssignment.mockImplementation(async value => {
      const candidate = f.candidate({ ...value, discloseFilesToGateway: true });
      const scope = candidate.approvalDraft.payload.nativeFileDisclosure!;
      if (mode === "missing") delete candidate.approvalDraft.payload.nativeFileDisclosure;
      if (mode === "destination") Object.assign(scope, { destination: "model_context" });
      if (mode === "workspace") scope.executionWorkspaceId = "foreign";
      if (mode === "plan") scope.fileStagingSha256 = "f".repeat(64);
      if (mode === "request") scope.requestSha256 = "e".repeat(64);
      return candidate;
    });
    await expect(f.producer.prepare(input)).rejects.toThrow();
  });
  async function admissionFixture() {
    const f = fixture(); let approval!: ApprovalRequest;
    const get = vi.fn(async () => approval);
    const authorizeForAssignment = vi.fn(async (_command: unknown) => f.candidate().candidateExpectation);
    const admitPreparedForAssignment = vi.fn(async (command: any) => ({ decision: "accept" as const, expectation: command.expectation,
      cell: { registryWorkspaceId: command.registryWorkspaceId, assignmentId: command.assignmentId, assignmentGeneration: command.assignmentGeneration,
        profileSha256: "c".repeat(64), executionState: "starting", executionRevision: command.expectedExecutionRevision + 1,
        capacityRevision: command.expectedCapacityRevision + 1, cleanupRevision: command.expectedCleanupRevision, backupRevision: command.expectedBackupRevision } }));
    const resolveActiveChatApprovalResume = vi.fn(async () => ({ materialSha256: "ab".repeat(32), material: {
      schemaVersion: "goatcitadel.remote-worker-native-runtime-resume.v1", approvalId: approval.approvalId,
      approvalSha256: digest(approval), nativeRuntimeBindingSha256: digest(approval.payload.nativeRuntime),
    } }));
    const storage = { approvals: { get }, remoteWorkerRuntimeResults: { authorizeForAssignment }, remoteWorkerAssignments: { resolveActiveChatApprovalResume }, remoteWorkerRuntimeAdmissions: { ...f.storage.remoteWorkerRuntimeAdmissions,
      validatePendingReviewForAssignment: vi.fn(async () => {}), admitPreparedForAssignment } };
    const createApproval = vi.fn<ApprovalRuntime["createApproval"]>(async (draft, hook) => {
      approval = { ...draft, approvalId: "admit-review", status: "pending", createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(), explanationStatus: "not_requested" };
      await hook?.(approval); return approval;
    });
    const authorizePolicy = vi.fn(async () => {});
    const owner = new RemoteWorkerRuntimeRequestProducer(storage as never, { createApproval }, { authorize: authorizePolicy,
      authorizeAdmitted: authorizePolicy, admit: admitPreparedForAssignment });
    const { candidate } = await owner.requestReview(f.input);
    approval.status = "approved";
    const inventory = capacityInventoryFixture("c".repeat(64), "reviewed-admission");
    const input = { ...f.input, approvalId: approval.approvalId, ...candidate.revisions, inventory,
      inventoryBinding: { profileSha256: inventory.profileSha256, captureSha256: inventory.captureSha256, inventorySha256: remoteWorkerCellCapacityInventorySha256(inventory) },
      observation: { reservation: REMOTE_WORKER_NATIVE_CELL_POLICY.capacity, incomingBytes: 1000, peakDiskBytes: 0, peakMemoryBytes: 0,
        peakFileCount: 0, peakProcessCount: 0, rawOutputBytes: 0 } };
    return { ...f, input, owner, storage, approval, candidate, get, admitPreparedForAssignment, resolveActiveChatApprovalResume, authorizeForAssignment, authorizePolicy };
  }
  it("rechecks policy before admission, selection and every runtime authorization", async () => {
    const f = await admissionFixture(), expected = f.candidate.candidateExpectation;
    f.authorizePolicy.mockRejectedValueOnce(new Error("tool revoked"));
    await expect(f.owner.admitReviewed(f.input)).rejects.toThrow("tool revoked"); expect(f.admitPreparedForAssignment).not.toHaveBeenCalled();
    await f.owner.admitReviewed(f.input);
    await f.owner.authorizePolicyForRequest({ ...f.input, nonce: expected.nonce, requestSha256: expected.requestSha256 });
    f.authorizePolicy.mockRejectedValueOnce(new Error("tool revoked"));
    await expect(f.owner.authorizePolicyForRequest({ ...f.input, nonce: expected.nonce, requestSha256: expected.requestSha256 })).rejects.toThrow("tool revoked");
    f.authorizePolicy.mockRejectedValueOnce(new Error("tool revoked"));
    await expect(f.owner.selectAdmittedForAssignment(f.input)).rejects.toThrow("tool revoked");
    const count = f.authorizePolicy.mock.calls.length;
    for (const patch of [{ nonce: "ff".repeat(32) }, { assignmentId: "foreign" }, { assignmentGeneration: 2 }])
      await expect(f.owner.authorizePolicyForRequest({ ...f.input, nonce: expected.nonce, requestSha256: expected.requestSha256, ...patch })).rejects.toThrow();
    expect(f.authorizePolicy).toHaveBeenCalledTimes(count);
  });
  it("selects only the exact admitted request and rechecks current authority on every handoff", async () => {
    const f = await admissionFixture();
    await expect(f.owner.selectAdmittedForAssignment(f.input)).rejects.toThrow("No unique admitted");
    expect(f.authorizeForAssignment).not.toHaveBeenCalled();
    await f.owner.admitReviewed(f.input);
    const selected = await f.owner.selectAdmittedForAssignment(f.input);
    expect(selected).toEqual({ request: f.candidate.request, expectation: f.candidate.candidateExpectation });
    expect(Object.isFrozen(selected)).toBe(true);
    await f.owner.selectAdmittedForAssignment({ ...f.input, leaseRevision: 2, leaseTokenSha256: "d".repeat(64) });
    expect(f.authorizeForAssignment).toHaveBeenCalledTimes(2);
    expect(f.authorizeForAssignment).toHaveBeenLastCalledWith(expect.objectContaining({ registryWorkspaceId: f.input.registryWorkspaceId,
      assignmentId: f.input.assignmentId, assignmentGeneration: 1, leaseRevision: 2, leaseTokenSha256: "d".repeat(64),
      nonce: selected.expectation.nonce, requestSha256: selected.expectation.requestSha256, phase: "execution" }));
    await expect(new RemoteWorkerRuntimeRequestProducer(f.storage as never).selectAdmittedForAssignment(f.input)).rejects.toThrow("No unique admitted");
  });
  it.each(["exact", "approval", "decision", "generation", "binding", "wake", "approval_hash", "cancel"])("binds selection to its %s continuation", async mode => {
    const f = await admissionFixture(); await f.owner.admitReviewed(f.input);
    const resume = await f.resolveActiveChatApprovalResume(), stop = new AbortController();
    const continuation = { ...normalizeRemoteWorkerNativeContinuation({ schemaVersion: "goatcitadel.remote-worker-native-continuation.v1",
      assignmentGeneration: f.input.assignmentGeneration, resumeSha256: resume.materialSha256, approvalId: f.approval.approvalId,
      approvalSha256: resume.material.approvalSha256, nativeRuntimeBindingSha256: resume.material.nativeRuntimeBindingSha256, decision: "approved" }) };
    if (mode === "approval") continuation.approvalId = "other-review";
    if (mode === "decision") continuation.decision = "rejected";
    if (mode === "generation") continuation.assignmentGeneration += 1;
    if (mode === "binding") continuation.nativeRuntimeBindingSha256 = "ff".repeat(32);
    if (mode === "wake") continuation.resumeSha256 = "ff".repeat(32);
    if (mode === "approval_hash") continuation.approvalSha256 = "ff".repeat(32);
    if (mode === "cancel") f.resolveActiveChatApprovalResume.mockImplementation(async () => { stop.abort(); return resume; });
    const pending = f.owner.selectAdmittedForAssignment({ ...f.input, continuation, signal: stop.signal });
    if (mode === "exact") {
      expect(await pending).toEqual({ request: f.candidate.request, expectation: f.candidate.candidateExpectation });
      expect(f.resolveActiveChatApprovalResume).toHaveBeenLastCalledWith(expect.objectContaining({ leaseTokenSha256: f.input.leaseTokenSha256 }), f.input.protectedAuthority);
    } else await expect(pending).rejects.toThrow();
    expect(f.admitPreparedForAssignment).toHaveBeenCalledTimes(1);
  });
  it.each(["exact", "capture-missing", "capture-revision", "wake", "policy", "cancel"])("admits through retained capacity only for %s continuation", async mode => {
    const f = await admissionFixture(), stop = new AbortController(), resume = await f.resolveActiveChatApprovalResume();
    const continuation = normalizeRemoteWorkerNativeContinuation({ schemaVersion: "goatcitadel.remote-worker-native-continuation.v1",
      assignmentGeneration: f.input.assignmentGeneration, resumeSha256: mode === "wake" ? "ff".repeat(32) : resume.materialSha256,
      approvalId: f.approval.approvalId, approvalSha256: resume.material.approvalSha256,
      nativeRuntimeBindingSha256: resume.material.nativeRuntimeBindingSha256, decision: "approved" });
    const readAdmissionForAssignment = vi.fn(async () => {
      if (mode === "capture-missing") throw new Error("complete capture unavailable");
      if (mode === "cancel") stop.abort();
      return { ...f.candidate.revisions, expectedCapacityRevision: f.candidate.revisions.expectedCapacityRevision + (mode === "capture-revision" ? 1 : 0),
        observation: f.input.observation, inventory: f.input.inventory, inventoryBinding: f.input.inventoryBinding };
    });
    Object.assign(f.storage, { remoteWorkerNativeCapacityPages: { readAdmissionForAssignment } });
    if (mode === "policy") f.authorizePolicy.mockRejectedValue(new Error("policy denied"));
    const pending = f.owner.selectAdmittedForAssignment({ ...f.input, continuation, signal: stop.signal });
    if (mode !== "exact") {
      await expect(pending).rejects.toThrow(); expect(f.admitPreparedForAssignment).not.toHaveBeenCalled();
      if (mode === "wake") expect(readAdmissionForAssignment).not.toHaveBeenCalled();
      return;
    }
    expect(await pending).toEqual({ request: f.candidate.request, expectation: f.candidate.candidateExpectation });
    expect(readAdmissionForAssignment).toHaveBeenCalledWith(expect.objectContaining(f.candidate.revisions));
    const stored = f.admitPreparedForAssignment.mock.calls[0]![0];
    expect(remoteWorkerCellCapacityInventorySha256(stored.inventory)).toBe(remoteWorkerCellCapacityInventorySha256(f.input.inventory));
    expect(stored.observation.incomingBytes).toBeGreaterThanOrEqual(f.candidate.request.launch.limits.rawOutputBytes);
    await f.owner.selectAdmittedForAssignment({ ...f.input, continuation });
    expect(readAdmissionForAssignment).toHaveBeenCalledOnce(); expect(f.admitPreparedForAssignment).toHaveBeenCalledOnce();
  });
  it.each(["scope", "generation", "credential", "revoked", "expectation", "cancelled", "expired"])("withholds admitted selection on %s", async mode => {
    const f = await admissionFixture(), stop = new AbortController(); await f.owner.admitReviewed(f.input);
    const input = { ...f.input, signal: stop.signal };
    if (mode === "scope") input.assignmentId = "foreign";
    if (mode === "generation") input.assignmentGeneration += 1;
    if (mode === "credential") input.protectedAuthority = undefined as never;
    f.authorizeForAssignment.mockImplementation(async () => {
      if (mode === "revoked") throw new Error("revoked");
      if (mode === "cancelled") stop.abort();
      if (mode === "expired") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300001);
      return mode === "expectation" ? { ...f.candidate.candidateExpectation, requestSha256: "f".repeat(64) } : f.candidate.candidateExpectation;
    });
    try { await expect(f.owner.selectAdmittedForAssignment(input)).rejects.toThrow(); }
    finally { vi.restoreAllMocks(); }
    expect(f.authorizeForAssignment).toHaveBeenCalledTimes(["scope", "generation", "credential"].includes(mode) ? 0 : 1);
  });
  it.each(["missing", "tool", "approval", "snapshot", "request"])("refuses %s Chat resume before native admission", async mode => {
    const f = await admissionFixture();
    const resume = await f.resolveActiveChatApprovalResume();
    if (mode === "tool") resume.material.schemaVersion = "goatcitadel.remote-worker-chat-resume.v1";
    if (mode === "approval") resume.material.approvalId = "foreign";
    if (mode === "snapshot") resume.material.approvalSha256 = digest("foreign");
    if (mode === "request") resume.material.nativeRuntimeBindingSha256 = digest("foreign");
    f.resolveActiveChatApprovalResume.mockResolvedValue(mode === "missing" ? undefined as never : resume);
    await expect(f.owner.admitReviewed(f.input)).rejects.toThrow("exact protected Chat resume");
    expect(f.admitPreparedForAssignment).not.toHaveBeenCalled();
    expect(f.resolveActiveChatApprovalResume).toHaveBeenLastCalledWith({ registryWorkspaceId: f.input.registryWorkspaceId,
      assignmentId: f.input.assignmentId, assignmentGeneration: f.input.assignmentGeneration,
      leaseTokenSha256: f.input.leaseTokenSha256 }, f.input.protectedAuthority);
  });
  it("withholds admission when cancelled during the protected resume lookup", async () => {
    const f = await admissionFixture(), stop = new AbortController();
    const resume = await f.resolveActiveChatApprovalResume();
    f.resolveActiveChatApprovalResume.mockImplementation(async () => { stop.abort(); return resume; });
    await expect(f.owner.admitReviewed({ ...f.input, signal: stop.signal })).rejects.toThrow();
    expect(f.admitPreparedForAssignment).not.toHaveBeenCalled();
  });
  it("consumes the review once when two protected resume reads finish together", async () => {
    const f = await admissionFixture(), resume = await f.resolveActiveChatApprovalResume();
    const release: Array<() => void> = [];
    f.resolveActiveChatApprovalResume.mockImplementation(async () => {
      await new Promise<void>(resolve => release.push(resolve)); return resume;
    });
    const results = Promise.allSettled([f.owner.admitReviewed(f.input), f.owner.admitReviewed(f.input)]);
    await vi.waitFor(() => expect(release).toHaveLength(2));
    release.forEach(resolve => resolve());
    const settled = await results;
    expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(f.admitPreparedForAssignment).toHaveBeenCalledOnce();
  });
  it("admits only the reviewed private request and snapshots the collection before approval lookup", async () => {
    const f = await admissionFixture(); let release!: () => void;
    f.get.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return f.approval; });
    const pending = f.owner.admitReviewed({ ...f.input, request: { malicious: true }, expectation: { malicious: true } } as never);
    const backingIdentity = f.input.inventory.areas[0]!.objects[0]!.identitySha256;
    f.input.inventory.areas[0]!.objects[0]!.logicalBytes = 999;
    f.launch.commandLine += " changed";
    release(); const result = await pending;
    expect(result.disposition).toBe("admitted");
    expect(result).toHaveProperty("request.launch.commandLine", f.candidate.request.launch.commandLine);
    const stored = f.admitPreparedForAssignment.mock.calls[0]![0];
    expect(stored.request).toBe(f.candidate.request);
    expect(stored.expectation).toBe(f.candidate.candidateExpectation);
    expect(stored.inventory.areas.flatMap((area: any) => area.objects).find((object: any) => object.identitySha256 === backingIdentity).logicalBytes).toBe(65536);
    await expect(f.owner.admitReviewed({ ...f.input, inventory: capacityInventoryFixture("c".repeat(64), "reviewed-admission") })).rejects.toThrow("already attempted");
    expect(f.admitPreparedForAssignment).toHaveBeenCalledOnce();
  });
  it.each(["pending", "foreign", "revision", "scope"])("refuses %s authority before admission", async mode => {
    const f = await admissionFixture();
    if (mode === "pending") f.approval.status = "pending";
    if (mode === "foreign") f.approval.linkage = { ...f.approval.linkage, durableRunId: "foreign" };
    if (mode === "revision") f.input.expectedExecutionRevision += 1;
    if (mode === "scope") f.input.assignmentId = "foreign";
    await expect(f.owner.admitReviewed(f.input)).rejects.toThrow();
    expect(f.admitPreparedForAssignment).not.toHaveBeenCalled();
  });
  it.each(["lost", "reject", "quarantine", "cancelled", "tampered"])("does not retry after a %s admission outcome", async mode => {
    const f = await admissionFixture(), stop = new AbortController();
    const accepted = f.admitPreparedForAssignment.getMockImplementation()!;
    f.admitPreparedForAssignment.mockImplementation(async command => {
      if (mode === "lost") throw new Error("response lost");
      const result = await accepted(command);
      if (mode === "cancelled") stop.abort();
      if (mode === "tampered") result.cell.executionState = "running";
      if (mode === "reject" || mode === "quarantine") return { ...result, decision: mode, reason: "controlled capacity outcome" } as never;
      return result;
    });
    const pending = f.owner.admitReviewed({ ...f.input, signal: stop.signal });
    if (mode === "lost" || mode === "tampered") await expect(pending).rejects.toThrow();
    else {
      const result = await pending;
      expect(result.disposition).toBe(mode === "cancelled" ? "admitted_cancelled" : mode);
      expect(result).not.toHaveProperty("request");
    }
    await expect(f.owner.admitReviewed(f.input)).rejects.toThrow("already attempted");
    await expect(f.owner.selectAdmittedForAssignment(f.input)).rejects.toThrow("No unique admitted");
    expect(f.admitPreparedForAssignment).toHaveBeenCalledOnce();
  });
  it("permits only one concurrent admission attempt", async () => {
    const f = await admissionFixture(); let finish!: () => void;
    const accepted = f.admitPreparedForAssignment.getMockImplementation()!;
    f.admitPreparedForAssignment.mockImplementation(async command => { await new Promise<void>(resolve => { finish = resolve; }); return accepted(command); });
    const first = f.owner.admitReviewed(f.input);
    await expect(f.owner.admitReviewed(f.input)).rejects.toThrow();
    finish(); expect((await first).disposition).toBe("admitted");
    expect(f.admitPreparedForAssignment).toHaveBeenCalledOnce();
  });
  it.each([false, true])("keeps review details ephemeral and scoped with file disclosure opt-in %s", async discloseFilesToGateway => {
    const f = fixture(); let id = 0;
    const validatePendingReviewForAssignment = vi.fn(async () => {});
    const createApproval = vi.fn<ApprovalRuntime["createApproval"]>(async (draft, hook) => {
      const approval: ApprovalRequest = { ...draft, approvalId: `review-${++id}`, status: "pending", createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(), explanationStatus: "not_requested" };
      await hook?.(approval); return approval;
    });
    const storage = { ...f.storage, remoteWorkerRuntimeAdmissions: { ...f.storage.remoteWorkerRuntimeAdmissions, validatePendingReviewForAssignment } };
    const owner = new RemoteWorkerRuntimeRequestProducer(storage as never, { createApproval });
    const fileStaging = { paths: ["report.txt"], maximumFileBytes: 1024, maximumTotalBytes: 2048 };
    const { approval } = await owner.requestReview({ ...f.input, fileStaging, discloseFilesToGateway });
    fileStaging.paths[0] = "unreviewed.txt";
    const details = owner.readReview(approval)!;
    expect(details.commandLine).toBe(f.launch.commandLine);
    expect(details.environment).toEqual(f.launch.environment);
    expect(details.fileStaging?.paths).toEqual(["report.txt"]);
    expect(Object.isFrozen(details.fileStaging?.paths)).toBe(true);
    expect(details.fileDisclosure).toEqual(discloseFilesToGateway ? { destination: "gateway_artifacts", workspaceId: "execution-workspace" } : undefined);
    expect(owner.readReview({ ...approval, payload: { ...approval.payload, nativeFileDisclosure: discloseFilesToGateway ? undefined : {} } })).toBeUndefined();
    expect(JSON.stringify(approval)).not.toContain("report.txt");
    expect(Object.isFrozen(details.limits)).toBe(true);
    expect(JSON.stringify(approval)).not.toContain(f.launch.commandLine);
    expect(owner.readReview({ ...approval, linkage: { ...approval.linkage, workspaceId: "foreign" } })).toBeUndefined();
    expect(owner.readReview({ ...approval, status: "rejected" })).toBeUndefined();
    expect(owner.readReview({ ...approval, payload: { nativeRuntime: {} } })).toBeUndefined();
    expect(new RemoteWorkerRuntimeRequestProducer(storage as never, { createApproval }).readReview(approval)).toBeUndefined();
    await Promise.all(Array.from({ length: 31 }, () => owner.requestReview(f.input)));
    await expect(owner.requestReview(f.input)).rejects.toThrow("capacity is full");
    expect(createApproval).toHaveBeenCalledTimes(32);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse(approval.expiresAt!) + 1);
    try { expect(owner.readReview(approval)).toBeUndefined(); await owner.requestReview(f.input); }
    finally { now.mockRestore(); }
    expect(createApproval).toHaveBeenCalledTimes(33);
  });
  it("freezes the launch and authority before awaiting a read-only candidate", async () => {
    const f = fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.prepareRequestForAssignment.mockImplementation(async input => { await gate; return f.candidate(input); });
    const pending = f.producer.prepare(f.input), saved = f.prepareRequestForAssignment.mock.calls[0]![0];
    f.launch.commandLine += " changed"; f.launch.limits.processLimit = 2;
    expect(Object.isFrozen(saved)).toBe(true); expect(Object.isFrozen(saved.launch)).toBe(true);
    release(); const result = await pending;
    expect(result.decision).toBe("review_required"); expect(result.request.launch.commandLine).not.toContain("changed");
    expect(result.request.launch.limits.processLimit).toBe(1);
    expect(Object.isFrozen(result.request.launch.limits)).toBe(true);
    expect(Object.isFrozen(result.revisions)).toBe(true);
    expect(Object.isFrozen(result.approvalDraft.payload.nativeRuntime)).toBe(true);
    expect(result.approvalDraft.linkage?.workspaceId).toBe("execution-workspace");
    expect(JSON.stringify(result)).not.toContain(f.input.leaseTokenSha256);
    expect(f.prepareRequestForAssignment).toHaveBeenCalledOnce();
  });
  it.each(["before", "after"])("does not return a candidate after %s cancellation", async stage => {
    const f = fixture(), controller = new AbortController();
    if (stage === "before") controller.abort();
    else f.prepareRequestForAssignment.mockImplementation(async input => { controller.abort(); return f.candidate(input); });
    await expect(f.producer.prepare({ ...f.input, signal: controller.signal })).rejects.toThrow();
    expect(f.prepareRequestForAssignment).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
  });
  it.each(["approved", "digest", "nonce", "revision", "launch", "scan", "fileStaging"])("refuses substituted %s response metadata", async mode => {
    const f = fixture(), result = f.candidate();
    if (mode === "approved") Object.assign(result, { decision: "accept" });
    if (mode === "digest") result.candidateExpectation = { ...result.candidateExpectation, requestSha256: "f".repeat(64) };
    if (mode === "nonce") result.request = { ...result.request, nonce: "f".repeat(64) };
    if (mode === "revision") result.revisions.expectedExecutionRevision = -1;
    if (mode === "launch") result.request = { ...result.request, launch: { ...result.request.launch, commandLine: result.request.launch.commandLine + " substituted" } };
    if (mode === "scan") result.request = { ...result.request, inventoryLimits: { ...result.request.inventoryLimits, maxEntries: 1001 } };
    if (mode === "fileStaging") result.request = { ...result.request, fileStaging: { paths: ["unreviewed.txt"], maximumFileBytes: 1, maximumTotalBytes: 1 } };
    if (mode === "launch" || mode === "scan" || mode === "fileStaging") result.candidateExpectation = prepareWindowsRuntimeDispatch(result.request).expectation;
    f.prepareRequestForAssignment.mockResolvedValue(result);
    await expect(f.producer.prepare(f.input)).rejects.toThrow();
  });
  it("rejects executable getters before invoking storage", async () => {
    const f = fixture(); let called = false;
    const launch = { ...f.launch, get commandLine() { called = true; return "unreviewed"; } };
    await expect(f.producer.prepare({ ...f.input, launch })).rejects.toThrow();
    expect(called).toBe(false); expect(f.prepareRequestForAssignment).not.toHaveBeenCalled();
  });
  it.each(["kind", "risk", "assignment", "expectation", "revision", "links"])("refuses a substituted review %s", async mode => {
    const f = fixture(), result = f.candidate();
    if (mode === "kind") result.approvalDraft.kind = "tool.invoke";
    if (mode === "risk") Object.assign(result.approvalDraft, { riskLevel: "safe" });
    if (mode === "assignment") result.approvalDraft.payload.nativeRuntime.assignmentId = "foreign";
    if (mode === "expectation") result.approvalDraft.payload.nativeRuntime.expectation = { ...result.candidateExpectation, nonce: "a".repeat(64) };
    if (mode === "revision") result.approvalDraft.payload.nativeRuntime.expectedExecutionRevision += 1;
    if (mode === "links") result.approvalDraft.linkage.durableRunId = "";
    f.prepareRequestForAssignment.mockResolvedValue(result);
    await expect(f.producer.prepare(f.input)).rejects.toThrow();
  });
  it("projects only review metadata and never propagates an approval decision or command into the draft", async () => {
    const f = fixture(), result = f.candidate();
    Object.assign(result.approvalDraft, { approvalId: "not-created", status: "approved" });
    Object.assign(result.approvalDraft.preview, { commandLine: "private command", environment: "private environment" });
    f.prepareRequestForAssignment.mockResolvedValue(result);
    const prepared = await f.producer.prepare(f.input);
    expect(prepared.approvalDraft).not.toHaveProperty("approvalId");
    expect(prepared.approvalDraft).not.toHaveProperty("status");
    expect(JSON.stringify(prepared.approvalDraft)).not.toContain("private");
  });
  it("is composed for the governed Gateway owner without entering worker settlement", async () => {
    const f = fixture(), llm = {};
    const authorize = vi.fn(async () => {});
    const owners = createRemoteWorkerExecutionOwners({ storage: f.storage, llm, completionHost: { llmService: llm }, artifactRoot: "unused", nativeRuntimePolicy: { authorize } } as unknown as RemoteWorkerExecutionOwnersDependencies);
    expect(owners.nativeRuntimeRequests).toBeInstanceOf(RemoteWorkerRuntimeRequestProducer);
    expect((await owners.nativeRuntimeRequests.prepare(f.input)).decision).toBe("review_required");
    expect(authorize).toHaveBeenCalledOnce();
    expect("nativeRuntimeRequests" in owners.settlement).toBe(false);
  });
  it("refuses production preparation when its policy owner is missing", async () => {
    const f = fixture(), llm = {};
    const owners = createRemoteWorkerExecutionOwners({ storage: f.storage, llm, completionHost: { llmService: llm }, artifactRoot: "unused" } as unknown as RemoteWorkerExecutionOwnersDependencies);
    await expect(owners.nativeRuntimeRequests.prepare(f.input)).rejects.toThrow("Gateway policy owner");
    expect(f.prepareRequestForAssignment).not.toHaveBeenCalled();
  });
  it("requires the approval lifecycle rather than creating approvals through storage", async () => {
    const f = fixture();
    await expect(f.producer.requestReview(f.input)).rejects.toThrow("canonical approval lifecycle");
    expect(f.prepareRequestForAssignment).not.toHaveBeenCalled();
  });
  it.each(["pending", "rejected", "cancelled_after_commit", "stale", "cancelled_in_hook"])("uses the canonical creation hook for %s", async mode => {
    const f = fixture(), controller = new AbortController();
    const validatePendingReviewForAssignment = vi.fn(async () => {
      if (mode === "stale") throw new Error("stale candidate");
      if (mode === "cancelled_in_hook") controller.abort();
    });
    const createApproval = vi.fn<ApprovalRuntime["createApproval"]>(async (draft, onCreated) => {
      const approval: ApprovalRequest = { ...draft, approvalId: "review", status: "pending", createdAt: new Date().toISOString(), explanationStatus: "not_requested" };
      await onCreated?.(approval);
      if (mode === "rejected") approval.status = "rejected";
      if (mode === "cancelled_after_commit") controller.abort();
      return approval;
    });
    const owners = createRemoteWorkerExecutionOwners({ storage: { ...f.storage, remoteWorkerRuntimeAdmissions: {
      ...f.storage.remoteWorkerRuntimeAdmissions, validatePendingReviewForAssignment } },
      approvals: { createApproval }, nativeRuntimePolicy: { authorize: vi.fn(async () => {}) }, llm: null, completionHost: { llmService: null }, artifactRoot: "unused" } as unknown as RemoteWorkerExecutionOwnersDependencies);
    const operation = owners.nativeRuntimeRequests.requestReview({ ...f.input, signal: controller.signal });
    if (mode === "stale" || mode === "cancelled_in_hook") await expect(operation).rejects.toThrow();
    else {
      const result = await operation;
      expect(result.approval.status).toBe(mode === "rejected" ? "rejected" : "pending");
      expect(result.candidate.request.nonce).toBe("9".repeat(64));
    }
    expect(createApproval).toHaveBeenCalledOnce();
    expect(createApproval).toHaveBeenCalledWith(expect.objectContaining({ kind: "remote_worker.native_runtime" }), expect.any(Function), { ttlMs: 300_000 });
    expect(validatePendingReviewForAssignment).toHaveBeenCalledWith(expect.objectContaining({ approvalId: "review", assignmentId: f.input.assignmentId,
      request: expect.objectContaining({ nonce: "9".repeat(64) }) }));
    expect("nativeRuntimeRequests" in owners.settlement).toBe(false);
  });
});
