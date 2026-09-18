import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { remoteWorkerCellCapacityInventorySha256, remoteWorkerRuntimeBundleManifestSha256, remoteWorkerAssignmentCanonicalSha256,
  normalizeRemoteWorkerCellCapacityReservation, REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
  type ToolAccessEvaluateResponse, type ToolAccessEvaluateRequest } from "@goatcitadel/contracts";
import { prepareWindowsRuntimeDispatch } from "@goatcitadel/contracts/remote-worker-runtime-node";
import { capacityInventoryFixture } from "../../contracts/src/remote-worker-cell-capacity-inventory-test-fixture.js";
import { admitNativeRuntimeWithPolicy, type NativeRuntimePolicyAdmissionInput } from "./native-runtime-admission.js";
import { ToolPolicyEngine } from "./engine.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function nativeRequest() {
  const jobName = `gc-cell-${"1".repeat(32)}`, root = `C:\\cells\\${jobName}`;
  const identity = (digit: string) => "1".repeat(16) + digit.repeat(32);
  const runtimeBundle = { schemaVersion: "goatcitadel.worker-runtime-bundle.v1" as const,
    files: [{ relativePath: "entry.exe", bytes: 3, sha256: "a".repeat(64) }] };
  return { nonce: "9".repeat(64), anchor: { fileIdentity: identity("6"), preparedSha256: "7".repeat(64) }, checkpointSha256: "8".repeat(64),
    inventoryLimits: { maxEntries: 20000, maxDepth: 64, wallMs: 10000 }, launch: {
      jobName, appContainerName: `GoatCitadel.Worker.${"1".repeat(32)}`, image: `${root}\\runtime\\entry.exe`,
      commandLine: `"${root}\\runtime\\entry.exe" serve`, directory: `${root}\\work`, runtimeRoot: `${root}\\runtime`,
      imageSha256: "a".repeat(64), directoryIdentity: identity("5"), runtimeRootIdentity: identity("4"), runtimeBundle,
      runtimeBundleSha256: remoteWorkerRuntimeBundleManifestSha256(runtimeBundle), environment: { SystemRoot: "C:\\Windows" },
      limits: { processLimit: 1, memoryBytes: 67108864, cpuMilli: 1000, wallMs: 60000, rawOutputBytes: 65536, diagnosticBytes: 1024, inputBytes: 4096 },
      protectedWorkspace: { parentPath: "C:\\cells", parentIdentity: identity("1"), rootIdentity: identity("2"), controlIdentity: identity("3"),
        runtimeIdentity: identity("4"), workIdentity: identity("5"), ownerSid: "S-1-5-21-1-2-3-1001", controllerSid: "S-1-5-80-1-2-3-4-5" } } };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gc-native-policy-admission-"));
  const sync = new Storage({ dbPath: ":memory:", transcriptsDir: join(root, "transcripts"), auditDir: join(root, "audit") });
  const storage = createSqliteAsyncStorage(sync);
  cleanup.push(async () => { await storage.close(); await rm(root, { recursive: true, force: true }); });
  const grant = await storage.toolGrants.create({ toolPattern: "shell.exec", decision: "allow", scope: "session",
    scopeRef: "session", grantType: "one_time", createdBy: "operator", constraints: { maxCallsPerHour: 1, maxWritesPerHour: 1 } });
  const approval = await storage.approvals.create({ kind: "remote_worker.native_runtime", riskLevel: "danger",
    payload: {}, preview: {}, expiresAt: new Date(Date.now() + 300_000).toISOString() });
  await storage.approvals.resolve(approval.approvalId, { decision: "approve", resolvedBy: "operator" });
  const native = nativeRequest(), stop = new AbortController();
  const reservation = normalizeRemoteWorkerCellCapacityReservation({ schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
    logicalDiskBytes: 268435456, allocatedDiskBytes: 603979776, fileLimit: 10000, inodeLimit: 20000, processLimit: 4,
    cpuLimitMilli: 1000, wallLimitMs: 600000, memoryLimitBytes: 536870912, rawOutputLimitBytes: 1048576,
    diagnosticLimitBytes: 1048576, artifactCeilingBytes: 67108864, backupStagingBytes: 67108864, backupPublicationBytes: 67108864 });
  const inventory = capacityInventoryFixture("cc".repeat(32), "native-policy-admission");
  const input: NativeRuntimePolicyAdmissionInput = { registryWorkspaceId: "registry", assignmentId: "assignment", assignmentGeneration: 1,
    leaseRevision: 1, leaseTokenSha256: "dd".repeat(32), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} } as never,
    approvalId: approval.approvalId, request: native, expectation: prepareWindowsRuntimeDispatch(native).expectation, signal: stop.signal,
    expectedCapacityRevision: 1, expectedExecutionRevision: 1, expectedCleanupRevision: 1, expectedBackupRevision: 1,
    inventory, inventoryBinding: { profileSha256: inventory.profileSha256, captureSha256: inventory.captureSha256,
      inventorySha256: remoteWorkerCellCapacityInventorySha256(inventory) }, observation: { reservation,
      incomingBytes: 1000, peakDiskBytes: 0, peakMemoryBytes: 0, peakFileCount: 0, peakProcessCount: 0, rawOutputBytes: 0 } };
  const request: ToolAccessEvaluateRequest = { toolName: "shell.exec", agentId: "assistant", surface: "chat", sessionId: "session",
    workspaceId: "workspace", taskId: "task", runId: "run", args: { command: native.launch.commandLine, cwd: native.launch.directory } };
  const evaluate = vi.fn(async (): Promise<ToolAccessEvaluateResponse> => ({ toolName: "shell.exec", allowed: true,
    requiresApproval: true, riskLevel: "danger", reasonCodes: ["native-test"], matchedGrantId: grant.grantId }));
  // The native repository has its own authority tests. This controlled write
  // observes the real SQLite transaction encompassing that commit callback.
  const admission = vi.fn(async () => { await storage.systemSettings.set("controlled-native-admission", true);
    return { decision: "accept" as const, cell: {} as never, expectation: input.expectation }; });
  const record = vi.fn(storage.toolAccessDecisions.record.bind(storage.toolAccessDecisions));
  const dependencies = { runImmediateTransaction: storage.runImmediateTransaction.bind(storage), toolGrants: storage.toolGrants, approvals: storage.approvals,
    remoteWorkerNativePolicyReservations: { retainForAssignment: vi.fn(async ({ decisionId }: { decisionId: string }) => {
      expect((await storage.toolGrants.get(grant.grantId)).usesRemaining).toBe(0);
      expect((await storage.toolAccessDecisions.get(decisionId))?.countsTowardLimits).toBe(true);
    }) },
    toolAccessDecisions: { record }, remoteWorkerRuntimeAdmissions: { admitPreparedForAssignment: admission },
    remoteWorkerAssignments: { resolveActiveChatExecution: vi.fn(async () => ({ authority: { assignment: { manifest: {
      sessionId: "session", executionWorkspaceId: "workspace", taskId: "task", durableRunId: "run" } } } })) } };
  const run = () => admitNativeRuntimeWithPolicy(dependencies as unknown as Parameters<typeof admitNativeRuntimeWithPolicy>[0], evaluate, request, input);
  const calls = () => storage.toolAccessDecisions.countToolCallsInLastHour("shell.exec", "assistant", "session");
  return { storage, grant, input, stop, request, evaluate, admission, record, run, calls };
}
describe("native policy admission transaction", () => {
  it("serializes hourly admission across concurrent external-runtime invocations", async () => {
    const f = await fixture();
    await f.storage.toolGrants.create({ toolPattern: "session.status", decision: "allow", scope: "session", scopeRef: "session",
      grantType: "persistent", createdBy: "operator", constraints: { maxCallsPerHour: 1 } });
    let release!: () => void, observed!: () => void, secondObserved!: () => void, reads = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const firstRead = new Promise<void>(resolve => { observed = resolve; });
    const secondRead = new Promise<void>(resolve => { secondObserved = resolve; });
    const decisions = new Proxy(f.storage.toolAccessDecisions, { get(target, property, receiver) {
      if (property !== "countToolCallsInLastHourInScope") return Reflect.get(target, property, receiver);
      return async (...args: Parameters<typeof target.countToolCallsInLastHourInScope>) => {
        const count = await target.countToolCallsInLastHourInScope(...args);
        if (++reads === 1) { observed(); await gate; } else secondObserved();
        return count;
      };
    } });
    const storage = new Proxy(f.storage, { get(target, property, receiver) {
      return property === "toolAccessDecisions" ? decisions : Reflect.get(target, property, receiver);
    } });
    const engine = new ToolPolicyEngine({ profiles: { danger: [] }, tools: { profile: "danger", approvalMode: "approve_risky", allow: [], deny: [] },
      agents: {}, sandbox: { writeJailRoots: [], readOnlyRoots: [], networkAllowlist: [], riskyShellPatterns: [], requireApprovalForRiskyShell: true } }, storage);
    const request = { toolName: "session.status", args: {}, agentId: "assistant", sessionId: "session", externalRuntime: true };
    const first = engine.invoke(request); await firstRead;
    const second = engine.invoke(request);
    // Before serialization both reads observe zero. With an owned transaction
    // the second read waits; release the first without requiring that unsafe read.
    try { await Promise.race([secondRead, new Promise(resolve => setTimeout(resolve, 100))]); } finally { release(); }
    const results = await Promise.all([first, second]);
    expect(results.filter(result => result.outcome === "executed")).toHaveLength(1);
    expect(results.filter(result => result.outcome === "blocked")).toHaveLength(1);
    expect(await f.storage.toolAccessDecisions.countToolCallsInLastHour("session.status", "assistant", "session")).toBe(1);
  }, 15_000);
  it("rechecks an admitted grant without counting it again and still honors a new deny", async () => {
    const f = await fixture(); await f.run();
    const decision = await f.record.mock.results[0]!.value;
    const reservation = { policyRequestSha256: remoteWorkerAssignmentCanonicalSha256(f.request), decision,
      grant: await f.storage.toolGrants.get(f.grant.grantId) };
    // Canonical receipt/lease/revocation checks have a real native SQL fixture.
    // This test isolates the shared engine's grant and limit evaluation using
    // real grant/decision repositories and a controlled authorized receipt.
    const readForAssignment = vi.fn(async () => reservation);
    const storage = new Proxy(f.storage, { get(target, property, receiver) {
      return property === "remoteWorkerNativePolicyReservations" ? { readForAssignment } : Reflect.get(target, property, receiver);
    } });
    const engine = new ToolPolicyEngine({ profiles: { danger: [] }, tools: { profile: "danger", approvalMode: "approve_risky", allow: [], deny: [] },
      agents: {}, sandbox: { writeJailRoots: [], readOnlyRoots: [], networkAllowlist: [], riskyShellPatterns: [], requireApprovalForRiskyShell: true } }, storage);
    vi.spyOn(engine as unknown as { validateStructuralSafety(): Promise<string | undefined> }, "validateStructuralSafety").mockResolvedValue(undefined);
    const lookup = { ...f.input, nonce: f.input.expectation.nonce, requestSha256: f.input.expectation.requestSha256 };
    expect((await engine.inspectAccess(f.request)).allowed).toBe(false);
    expect((await engine.inspectNativeRuntime(f.request, lookup)).allowed).toBe(true);
    expect((await engine.inspectNativeRuntime(f.request, lookup)).allowed).toBe(true);
    expect(await f.calls()).toBe(1); expect((await f.storage.toolGrants.get(f.grant.grantId)).usesRemaining).toBe(0);
    await expect(engine.inspectNativeRuntime({ ...f.request, args: { command: "different" } }, lookup)).rejects.toThrow("differs");
    await f.storage.toolGrants.create({ toolPattern: "shell.exec", decision: "deny", scope: "session", scopeRef: "session", createdBy: "operator" });
    expect((await engine.inspectNativeRuntime(f.request, lookup)).allowed).toBe(false);
    expect(await f.calls()).toBe(1);
  }, 15_000);
  it("commits a single grant debit and limit-counting decision with admitted state", async () => {
    const f = await fixture(); expect((await f.run()).decision).toBe("accept");
    expect((await f.storage.toolGrants.get(f.grant.grantId)).usesRemaining).toBe(0);
    expect(await f.calls()).toBe(1); expect((await f.storage.systemSettings.get("controlled-native-admission"))?.value).toBe(true);
  }, 15_000);
  it.each(["spent", "revoked", "audit", "cancelled", "cancelled-after-debit", "admission"])("rolls back the admission transaction on %s", async mode => {
    const f = await fixture();
    if (mode === "spent") await f.storage.toolGrants.consumeOne(f.grant.grantId);
    if (mode === "revoked") await f.storage.toolGrants.revoke(f.grant.grantId, undefined, "operator");
    if (mode === "audit") f.record.mockRejectedValue(new Error("audit failed"));
    if (mode === "cancelled-after-debit") f.record.mockImplementation(async value => {
      const result = await f.storage.toolAccessDecisions.record(value); f.stop.abort(); return result;
    });
    if (mode === "admission" || mode === "cancelled") f.admission.mockImplementation(async () => {
      await f.storage.systemSettings.set("controlled-native-admission", true);
      if (mode === "admission") throw new Error("admission failed");
      f.stop.abort(); return { decision: "accept", cell: {} as never, expectation: f.input.expectation };
    });
    await expect(f.run()).rejects.toThrow();
    expect(await f.storage.systemSettings.get("controlled-native-admission")).toBeUndefined();
    expect(await f.calls()).toBe(0);
    expect((await f.storage.toolGrants.get(f.grant.grantId)).usesRemaining).toBe(mode === "spent" ? 0 : 1);
  });
  it("allows only one concurrent admission to consume the same one-time grant", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.run(), f.run()]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await f.calls()).toBe(1);
    expect((await f.storage.toolGrants.get(f.grant.grantId)).usesRemaining).toBe(0);
  });
  it.each(["reject", "quarantine"] as const)("does not debit grants for capacity %s", async decision => {
    const f = await fixture();
    f.admission.mockResolvedValue({ decision, cell: {}, reason: "capacity" } as never);
    expect((await f.run()).decision).toBe(decision);
    expect(await f.calls()).toBe(0);
    expect((await f.storage.toolGrants.get(f.grant.grantId)).usesRemaining).toBe(1);
  });
  it.each(["scope", "command", "image", "denied", "ward"])("refuses %s before calling native admission", async mode => {
    const f = await fixture();
    if (mode === "scope") f.request.sessionId = "foreign";
    if (mode === "command") f.request.args = { command: "echo harmless", cwd: "C:\\elsewhere" };
    if (mode === "image") {
      (f.input.request as ReturnType<typeof nativeRequest>).launch.commandLine = "echo harmless";
      f.request.args = { ...f.request.args, command: "echo harmless" };
    }
    if (mode === "denied" || mode === "ward") f.evaluate.mockResolvedValue({ toolName: "shell.exec", allowed: mode !== "denied",
      requiresApproval: true, riskLevel: "danger", reasonCodes: [], wardEffect: "require_dry_run" });
    await expect(f.run()).rejects.toThrow(); expect(f.admission).not.toHaveBeenCalled(); expect(await f.calls()).toBe(0);
  });
});
