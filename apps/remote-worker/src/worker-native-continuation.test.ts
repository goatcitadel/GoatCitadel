import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonString, normalizeRemoteWorkerNativeContinuation, REMOTE_WORKER_ASSIGNMENT_WORKLOAD_SCHEMA_VERSION } from "@goatcitadel/contracts";
import { routeWorkerNativeContinuation } from "./worker-native-continuation.js";
import { sha256Utf8, type RouteContext } from "./connected-worker-routes.js";
import type { WorkerAssignmentLeaseOwner } from "./worker-assignment-lease-owner.js";
import { buildWorkerInferenceSubmission } from "./worker-inference-execution.js";
import { readWorkload } from "./connected-worker-routes.js";
import { nativeChatContextFixture } from "../../../packages/contracts/src/remote-worker-native-chat-context-test-fixture.js";
vi.mock("./connected-worker-routes.js", async importOriginal => ({ ...await importOriginal<typeof import("./connected-worker-routes.js")>(), readWorkload: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const continuation = normalizeRemoteWorkerNativeContinuation({ schemaVersion: "goatcitadel.remote-worker-native-continuation.v1", assignmentGeneration: 1,
    resumeSha256: "11".repeat(32), approvalId: "approval", approvalSha256: "22".repeat(32), nativeRuntimeBindingSha256: "33".repeat(32), decision: "approved" });
  const identity = { schemaVersion: REMOTE_WORKER_ASSIGNMENT_WORKLOAD_SCHEMA_VERSION, registryWorkspaceId: "registry", assignmentId: "assignment",
    assignmentManifestSha256: "44".repeat(32), durableRunId: "run", durableRunVersion: 2, durableRunPayloadSha256: "55".repeat(32),
    capabilityProfileId: "profile", capabilityProfileSha256: "66".repeat(32), contextSnapshotSha256: "77".repeat(32), nativeContinuation: continuation };
  const lease = { registryWorkspaceId: "registry", assignmentId: "assignment", assignmentGeneration: 1, leaseRevision: 2, leaseToken: "private-token" };
  const run = vi.fn(async () => ({ lease: { ...lease, leaseRevision: 3 } }));
  const workload = { ...identity, workloadSha256: sha256Utf8(canonicalJsonString(identity)) } as Record<string, unknown>;
  vi.mocked(readWorkload).mockResolvedValue({ body: { workload } } as never);
  return { workload, lease,
    context: { credential: { protectedKey: {} }, protectedKeys: {} } as RouteContext, owner: {} as WorkerAssignmentLeaseOwner,
    nativeRuntime: { run }, signal: new AbortController().signal, observed: {} as Record<string, unknown> };
}
describe("connected native continuation routing", () => {
  it("passes the exact canonical route and lease to the owner without completing Chat", async () => {
    const f = fixture(); expect((await routeWorkerNativeContinuation(f)).kind).toBe("waiting");
    expect(f.nativeRuntime.run).toHaveBeenCalledWith(expect.objectContaining({ continuation: f.workload.nativeContinuation, lease: f.lease, signal: f.signal }));
    expect(f.observed.awaiting).toBe("native_parent_continuation");
    expect(f.observed).not.toHaveProperty("settlementOutcome");
    expect(() => buildWorkerInferenceSubmission(f.workload, f.lease)).toThrow("Native continuation");
  });
  it("leaves ordinary Chat on its existing path", async () => {
    const f = fixture(); delete f.workload.nativeContinuation;
    expect((await routeWorkerNativeContinuation(f)).kind).toBe("chat"); expect(f.nativeRuntime.run).not.toHaveBeenCalled();
  });
  it("routes rejection to the parent without entering native execution", async () => {
    const f = fixture(); f.workload.nativeContinuation = { ...f.workload.nativeContinuation as object, decision: "rejected" };
    const { workloadSha256: _hash, ...identity } = f.workload;
    f.workload.workloadSha256 = sha256Utf8(canonicalJsonString(identity));
    expect((await routeWorkerNativeContinuation(f)).kind).toBe("waiting");
    expect(f.nativeRuntime.run).not.toHaveBeenCalled(); expect(f.observed.awaiting).toBe("native_parent_continuation");
  });
  it.each(["lease", "cancel"])("withholds parent continuation after changed %s", async mode => {
    const f = fixture(), stop = new AbortController(); f.signal = stop.signal;
    f.nativeRuntime.run.mockImplementation(async () => {
      if (mode === "cancel") stop.abort();
      return { lease: { ...f.lease, assignmentId: mode === "lease" ? "foreign" : f.lease.assignmentId } };
    });
    await expect(routeWorkerNativeContinuation(f)).rejects.toThrow();
    expect(f.observed.awaiting).toBeUndefined(); expect(f.nativeRuntime.run).toHaveBeenCalledTimes(1);
  });
  it.each(["owner", "key"])("withholds native work when %s is unavailable", async mode => {
    const f = fixture();
    const input = mode === "owner" ? { ...f, nativeRuntime: undefined } : { ...f, context: { credential: {} } as RouteContext };
    expect((await routeWorkerNativeContinuation(input)).kind).toBe("waiting");
    expect(f.nativeRuntime.run).not.toHaveBeenCalled(); expect(f.observed.awaiting).toBe("native_runtime_owner");
  });
  it.each(["generation", "approval", "hash", "scope", "extra", "cancel"])("refuses changed %s before owner entry", async mode => {
    const f = fixture();
    if (mode === "generation") f.lease.assignmentGeneration += 1;
    if (mode === "approval") f.workload.nativeContinuation = { ...f.workload.nativeContinuation as object, approvalId: "foreign" };
    if (mode === "hash") f.workload.workloadSha256 = "ff".repeat(32);
    if (mode === "scope") f.lease.assignmentId = "foreign";
    if (mode === "extra") f.workload.nativeContinuation = { ...f.workload.nativeContinuation as object, command: "hidden" };
    if (mode === "cancel") f.signal = AbortSignal.abort();
    await expect(routeWorkerNativeContinuation(f)).rejects.toThrow(); expect(f.nativeRuntime.run).not.toHaveBeenCalled();
  });
  it("withholds continuation after an ambiguous owner failure and does not retry", async () => {
    const f = fixture(); f.nativeRuntime.run.mockRejectedValue(new Error("lost native result"));
    await expect(routeWorkerNativeContinuation(f)).rejects.toThrow("lost native result");
    expect(f.nativeRuntime.run).toHaveBeenCalledTimes(1); expect(f.observed.awaiting).toBeUndefined();
  });
  it("refreshes canonical native context once, then enters Chat without executing again on restart", async () => {
    const f = fixture(), nativeChatContext = nativeChatContextFixture();
    const { workloadSha256: _hash, ...identity } = f.workload;
    const updated = { ...identity, nativeChatContext };
    const workload = { ...updated, workloadSha256: sha256Utf8(canonicalJsonString(updated)) };
    vi.mocked(readWorkload).mockResolvedValue({ body: { workload } } as never);
    const next = await routeWorkerNativeContinuation(f);
    expect(next).toMatchObject({ kind: "chat", lease: { leaseRevision: 3 }, workload });
    expect(f.nativeRuntime.run).toHaveBeenCalledOnce(); expect(readWorkload).toHaveBeenCalledOnce();
    expect((await routeWorkerNativeContinuation({ ...f, workload })).kind).toBe("chat");
    expect(f.nativeRuntime.run).toHaveBeenCalledOnce(); expect(readWorkload).toHaveBeenCalledOnce();
  });
});
