import { describe, expect, it, vi } from "vitest";
import { remoteWorkerInferenceCanonicalSha256 as digest } from "@goatcitadel/contracts";
import { createDatabase, DurableRunRepository, type AsyncStorage } from "@goatcitadel/storage";
import { prepareChatOfferFixture } from "../../../../packages/storage/src/remote-worker-chat-offer-fixture.js";
import { buildChatTurnRuntimeAuthoritySeal } from "./chat-durable-runtime-authority.js";
import { RemoteWorkerChatApprovalWaitReadService } from "./remote-worker-chat-approval-wait-read-service.js";

// The admission payload is real; repository reads below are controlled owner
// projections. Native authentication and SQLite/PG locking have separate proofs.
function fixture() {
  const db = createDatabase({ dbPath: ":memory:" });
  const seed = prepareChatOfferFixture(db, true);
  const run = new DurableRunRepository(db).getRun(seed.durableRunId);
  db.close();
  const manifest = seed.legacyCommand.manifest;
  const records = {
    assignment: { assignmentId: "assignment", registryWorkspaceId: "default", manifest, manifestSha256: digest(manifest) },
    generation: { assignmentGeneration: 1, workerId: "worker", workerGeneration: 1 },
    lease: { leaseRevision: 1, expiresAt: "2000-01-01T00:00:00.000Z" },
  };
  const approval = {
    approvalId: "approval-one", kind: "tool.invoke", riskLevel: "caution", status: "pending", expiresAt: "2099-01-01T00:00:00.000Z",
    linkage: { workspaceId: manifest.executionWorkspaceId, sessionId: manifest.sessionId, turnId: manifest.turnId,
      runId: manifest.durableRunId, toolName: "fs.read" },
  };
  const waitForEvent = { eventKey: "approval.resolved", correlationId: approval.approvalId };
  const seal = buildChatTurnRuntimeAuthoritySeal({ runId: run.runId, turnId: manifest.turnId!,
    transitionKind: "waiting", durableStatus: "waiting", traceStatus: "waiting_for_approval",
    transitionAt: "2026-09-09T00:00:00.000Z", postCommitGenerationId: "waiting-generation",
    postCommitEligibility: { version: 1, autonomyEnabledAtParentSettlement: false, evalIntegrityTurn: false, humanSession: true },
    waitForEvent, requiredFinalizers: ["general"],
  });
  run.status = "waiting";
  delete run.leaseOwnerId;
  delete run.leaseExpiresAt;
  run.metadata = { ...run.metadata, waitForEvent: structuredClone(waitForEvent), chatTurnRuntimeAuthority: seal };
  const checkpoint = { checkpointId: "waiting-checkpoint", state: { waitForEvent: structuredClone(waitForEvent), chatTurnRuntimeAuthority: structuredClone(seal) } };
  const tool = { toolRunId: "remote-tool:intent-one", sessionId: manifest.sessionId, turnId: manifest.turnId,
    toolName: "fs.read", args: { path: "private-fixture.txt" }, status: "approval_required", approvalId: approval.approvalId };
  const intent = { intentId: "intent-one", identity: { assignmentManifestSha256: records.assignment.manifestSha256,
    executionWorkspaceId: manifest.executionWorkspaceId, workerId: "worker", workerGeneration: 1 },
    effectSelector: tool.toolName, canonicalArgsSha256: digest(tool.args) };
  const history = [{ record: { transitionState: "approval_wait" } }];
  const inline = { approvalId: approval.approvalId, sessionId: manifest.sessionId, turnId: manifest.turnId, status: "pending" };
  const trace = { sessionId: manifest.sessionId, status: "waiting_for_approval", durable: { runId: run.runId, status: "waiting" } };
  const authenticate = vi.fn(async () => records);
  const resumeRead = vi.fn(async (): Promise<unknown> => undefined);
  const pending = { approvalId: approval.approvalId, resolutionStatus: "pending", request: { private: "retained-tool-arguments" } };
  const pendingRead = vi.fn(async () => pending);
  const checkpointRead = vi.fn(async () => checkpoint);
  const inlineRead = vi.fn(async () => inline);
  const writes = vi.fn();
  const storage = {
    runImmediateTransaction: async <T>(work: () => Promise<T>) => await work(),
    remoteWorkerAssignments: { resolveChatApprovalResumeByLeaseTokenHash: resumeRead,
      resolveWaitingChatAssignmentByLeaseTokenHash: authenticate, renewLease: writes },
    durableRuns: { getRunForUpdate: async () => run, getLatestCheckpointByKind: checkpointRead,
      readDatabaseNow: async () => "2026-09-09T01:00:00.000Z", updateRun: writes },
    remoteWorkerEffects: { listIntents: async () => [intent], readTransitionHistory: async () => history },
    chatToolRuns: { get: async () => tool, patch: writes },
    approvals: { get: async () => approval },
    pendingApprovalActions: { find: pendingRead },
    chatInlineApprovals: { get: inlineRead, upsert: writes },
    chatTurnTraces: { get: async () => trace, patchIfStatus: writes },
  } as unknown as AsyncStorage;
  const input = { registryWorkspaceId: "default", assignmentId: "assignment", expectedAssignmentGeneration: 1,
    expectedLeaseRevision: 1, leaseTokenSha256: digest("retained-lease") };
  const fence = { controlledAuthority: true } as unknown as Parameters<RemoteWorkerChatApprovalWaitReadService["read"]>[1];
  const retainResume = (phase: "waiting" | "renew", status = "approved") => {
    approval.status = status;
    pending.resolutionStatus = status === "approved" ? "pending" : "rejected";
    const material = { approvalId: approval.approvalId, durableRunId: run.runId,
      waitingCheckpointId: checkpoint.checkpointId, waitingRuntimeAuthoritySha256: seal.materialSha256,
      approvalSha256: digest(approval), pendingActionSha256: digest(pending) };
    const resume = { material, materialSha256: digest(material) };
    resumeRead.mockResolvedValue({ ...records, resume, phase });
    return resume;
  };
  return { run, records, approval, seal, checkpoint, tool, intent, history, inline, trace, authenticate,
    resumeRead, pending, pendingRead, retainResume,
    checkpointRead, inlineRead, writes, read: () => new RemoteWorkerChatApprovalWaitReadService(storage).read(input, fence) };
}

describe("read-only worker approval wait", () => {
  it.each(["waiting", "renew"] as const)("projects a native %s handoff without pending tool state", async phase => {
    const f = fixture();
    f.approval.kind = "remote_worker.native_runtime";
    const nativeRuntime = { requestSha256: digest("retained-native-request") };
    Object.assign(f.approval, { payload: { nativeRuntime } });
    const original = f.retainResume(phase);
    const { pendingActionSha256: _toolHash, ...common } = original.material;
    const material = { ...common, schemaVersion: "goatcitadel.remote-worker-native-runtime-resume.v1",
      nativeRuntimeBindingSha256: digest(nativeRuntime) };
    f.pendingRead.mockResolvedValue(undefined!);
    const resume = { material, materialSha256: digest(material) };
    f.resumeRead.mockResolvedValue({ ...f.records, resume, phase });
    expect(await f.read()).toMatchObject({ phase, resume: { resumeSha256: resume.materialSha256 } });
    const recoveryMaterial = { schemaVersion: "goatcitadel.remote-worker-native-runtime-resume-recovery.v1",
      nativeRuntimeBindingSha256: material.nativeRuntimeBindingSha256 };
    const recovery = { material: recoveryMaterial, materialSha256: digest(recoveryMaterial) };
    f.resumeRead.mockResolvedValue({ ...f.records, resume: { ...resume, recovery }, phase });
    expect(await f.read()).toMatchObject({ phase, resume: { resumeSha256: recovery.materialSha256 } });
    recoveryMaterial.nativeRuntimeBindingSha256 = digest("substituted");
    await expect(f.read()).rejects.toThrow("retained handoff");
    expect(f.writes).not.toHaveBeenCalled();
  });

  it("projects the anchored wait without renewing a lease, changing Chat state or returning tool arguments", async () => {
    const f = fixture();
    const before = structuredClone({ run: f.run, tool: f.tool, inline: f.inline, trace: f.trace });
    const first = await f.read();
    expect(first).toMatchObject({ waiting: { approvalId: "approval-one", runtimeAuthoritySha256: f.seal.materialSha256 } });
    expect(await f.read()).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("private-fixture.txt");
    expect({ run: f.run, tool: f.tool, inline: f.inline, trace: f.trace }).toEqual(before);
    expect(f.writes).not.toHaveBeenCalled();
  });

  it("cannot manufacture a wait when the native repository refuses retained authority", async () => {
    const f = fixture();
    f.authenticate.mockResolvedValue(undefined!);
    expect(await f.read()).toBeUndefined();
    expect(f.checkpointRead).not.toHaveBeenCalled();
    expect(f.writes).not.toHaveBeenCalled();
  });

  it.each([["approved", "pending"], ["approved", "approved"], ["rejected", "pending"],
    ["rejected", "denied"], ["edited", "pending"], ["edited", "approved"]])(
    "keeps a %s decision parked while its inline projection is %s", async (status, inlineStatus) => {
    const f = fixture();
    f.approval.status = status!;
    f.inline.status = inlineStatus!;
    expect(await f.read()).toMatchObject({ waiting: { approvalId: "approval-one" } });
    expect(f.writes).not.toHaveBeenCalled();
  });

  it.each((["waiting", "renew"] as const).flatMap(phase =>
    ["approved", "rejected", "edited"].map(status => [phase, status] as const)))(
    "projects %s continuation for %s without returning executable authority or arguments", async (phase, status) => {
    const f = fixture();
    const resume = f.retainResume(phase, status);
    const observed = await f.read();
    expect(observed).toEqual({ ...f.records, phase, resume: { approvalId: "approval-one",
      runtimeAuthoritySha256: f.seal.materialSha256, resumeSha256: resume.materialSha256 } });
    expect(JSON.stringify(observed)).not.toContain("retained-tool-arguments");
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.writes).not.toHaveBeenCalled();
  });

  it("does not turn a recorded approval back into an expired pending decision while the handoff is deferred", async () => {
    const f = fixture();
    f.approval.status = "approved";
    f.inline.status = "approved";
    f.approval.expiresAt = "2000-01-01T00:00:00.000Z";
    expect(await f.read()).toMatchObject({ waiting: { approvalId: "approval-one" } });
    expect(f.writes).not.toHaveBeenCalled();
  });

  it("keeps a completed action parked while another parent claim awaits its recovery binding", async () => {
    const f = fixture();
    const resume = f.retainResume("waiting");
    f.pending.resolutionStatus = "executed";
    f.resumeRead.mockResolvedValue({ ...f.records, resume, phase: "waiting", pendingRecovery: true });
    expect(await f.read()).toEqual({ ...f.records, phase: "waiting", resume: { approvalId: "approval-one",
      runtimeAuthoritySha256: f.seal.materialSha256, resumeSha256: resume.materialSha256 } });
    expect(f.writes).not.toHaveBeenCalled();
  });

  it("uses the new recovery snapshot for renewal after the pending action has completed", async () => {
    const f = fixture();
    const original = f.retainResume("renew");
    f.pending.resolutionStatus = "executed";
    const material = { schemaVersion: "goatcitadel.remote-worker-chat-resume-recovery.v1", pendingActionSha256: digest(f.pending) };
    const recovery = { material, materialSha256: digest(material) };
    const resume = { ...original, recovery };
    f.resumeRead.mockResolvedValue({ ...f.records, resume, phase: "renew", pendingRecovery: false });
    expect(await f.read()).toEqual({ ...f.records, phase: "renew", resume: { approvalId: "approval-one",
      runtimeAuthoritySha256: f.seal.materialSha256, resumeSha256: recovery.materialSha256 } });
    f.pending.request.private = "changed-after-binding";
    await expect(f.read()).rejects.toThrow("retained handoff");
    expect(f.writes).not.toHaveBeenCalled();
  });

  it("never promotes a pending recovery observation to a renewal instruction", async () => {
    const f = fixture();
    const resume = f.retainResume("renew");
    f.resumeRead.mockResolvedValue({ ...f.records, resume, phase: "renew", pendingRecovery: true });
    await expect(f.read()).rejects.toThrow("retained handoff");
    expect(f.writes).not.toHaveBeenCalled();
  });

  it("accepts an approved action settling after recovery binding and before worker renewal", async () => {
    const f = fixture();
    const original = f.retainResume("renew");
    const material = { schemaVersion: "goatcitadel.remote-worker-chat-resume-recovery.v1", pendingActionSha256: digest(f.pending) };
    const recovery = { material, materialSha256: digest(material) };
    f.resumeRead.mockResolvedValue({ ...f.records, resume: { ...original, recovery }, phase: "renew", pendingRecovery: false });
    Object.assign(f.pending, { resolutionStatus: "executed", resolvedAt: "2026-09-09T01:00:00.000Z",
      result: { outcome: "executed", result: { fixture: true } } });
    expect(await f.read()).toMatchObject({ phase: "renew", resume: { resumeSha256: recovery.materialSha256 } });
    f.pending.request.private = "changed-after-completion";
    await expect(f.read()).rejects.toThrow("retained handoff");
    expect(f.writes).not.toHaveBeenCalled();
  });

  const resumeDrift: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["missing checkpoint", f => { f.checkpointRead.mockResolvedValue(undefined!); }],
    ["another checkpoint", f => { f.checkpoint.checkpointId = "replaced"; }],
    ["checkpoint seal", f => { f.checkpoint.state.chatTurnRuntimeAuthority.materialSha256 = "0".repeat(64); }],
    ["approval resolution", f => { f.approval.status = "rejected"; }],
    ["approval binding", f => { f.approval.linkage.runId = "another"; }],
    ["missing action", f => { f.pendingRead.mockResolvedValue(undefined!); }],
    ["resolved action", f => { f.pending.resolutionStatus = "executed"; }],
    ["changed action", f => { f.pending.request.private = "changed"; }],
  ];
  it.each(resumeDrift)("refuses resume %s without falling back to parked authority", async (_label, mutate) => {
    const f = fixture();
    f.retainResume("renew");
    mutate(f);
    await expect(f.read()).rejects.toThrow();
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.writes).not.toHaveBeenCalled();
  });

  const drift: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["running parent", f => { f.run.status = "running"; }],
    ["parent lease", f => { f.run.leaseOwnerId = "another-owner"; }],
    ["parent expiry", f => { f.run.leaseExpiresAt = "2099-01-01T00:00:00.000Z"; }],
    ["parent turn", f => { f.run.payload!.turnId = "foreign-turn"; }],
    ["missing checkpoint", f => { f.checkpointRead.mockResolvedValue(undefined!); }],
    ["checkpoint seal", f => { f.checkpoint.state.chatTurnRuntimeAuthority.materialSha256 = "0".repeat(64); }],
    ["checkpoint wait", f => { f.checkpoint.state.waitForEvent.correlationId = "another-approval"; }],
    ["metadata wait", f => { (f.run.metadata!.waitForEvent as { eventKey: string }).eventKey = "another-event"; }],
    ["trace status", f => { f.trace.status = "completed"; }],
    ["trace durable status", f => { f.trace.durable.status = "running"; }],
    ["trace run", f => { f.trace.durable.runId = "another-run"; }],
    ["missing inline", f => { f.inlineRead.mockResolvedValue(undefined!); }],
    ["resolved inline", f => { f.inline.status = "approved"; }],
    ["mismatched resolution", f => { f.approval.status = "rejected"; f.inline.status = "approved"; }],
    ["expired approval", f => { f.approval.expiresAt = "2000-01-01T00:00:00.000Z"; }],
    ["approval parent", f => { f.approval.linkage.runId = "another-run"; }],
    ["approval workspace", f => { f.approval.linkage.workspaceId = "another-workspace"; }],
    ["approval tool", f => { f.approval.linkage.toolName = "fs.write"; }],
    ["tool arguments", f => { f.tool.args.path = "changed.txt"; }],
    ["tool turn", f => { f.tool.turnId = "another-turn"; }],
    ["intent worker", f => { f.intent.identity.workerId = "another-worker"; }],
    ["settled effect", f => { f.history[0]!.record.transitionState = "blocked_before_dispatch"; }],
  ];
  it.each(drift)("refuses %s drift without changing state", async (_label, mutate) => {
    const f = fixture();
    mutate(f);
    await expect(f.read()).rejects.toThrow();
    expect(f.writes).not.toHaveBeenCalled();
  });
});
