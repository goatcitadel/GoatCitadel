import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeRemoteWorkerRuntimeCleanupExchange, REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA, type RemoteWorkerRuntimeCleanupSubmission } from "@goatcitadel/contracts";
import { runtimeResultPagesFixture } from "../../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { createRemoteWorkerRuntimeCleanupReader } from "./remote-worker-runtime-cleanup.js";
import { dispatchNativeRuntimeSubmission } from "./remote-worker-native-runtime-submissions.js";
import { normalizeNativeRuntimeSettlementSubmission } from "./remote-worker-assignment-execution-validators.js";
import { readWorkerRuntimeCleanup } from "../../../remote-worker/src/worker-runtime-cleanup-client.js";
import { callProtectedRoute } from "../../../remote-worker/src/worker-protected-route-client.js";
import type { RouteContext } from "../../../remote-worker/src/connected-worker-routes.js";
import { createRemoteWorkerExecutionOwners, type RemoteWorkerExecutionOwnersDependencies } from "./remote-worker-execution-owners.js";
vi.mock("../../../remote-worker/src/worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));
function fixture() {
  const f = runtimeResultPagesFixture(2), retained = { history: f.history, expectations: [f.expectation] };
  const readCleanupExpectationsForAssignment = vi.fn(async () => retained);
  const owner = createRemoteWorkerRuntimeCleanupReader({ remoteWorkerRuntimeResults: { readCleanupExpectationsForAssignment } } as never);
  const lease = { registryWorkspaceId: f.history.registryWorkspaceId, assignmentId: f.history.assignmentId,
    assignmentGeneration: f.history.assignmentGeneration, leaseRevision: f.history.leaseRevision, leaseToken: "private-token" };
  const reply = async (submission: RemoteWorkerRuntimeCleanupSubmission, signal = new AbortController().signal) => {
    normalizeNativeRuntimeSettlementSubmission(submission, submission.kind, lease.leaseToken);
    return { status: 200, body: { schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1", operation: "assignment.settlement.submit",
      registryWorkspaceId: lease.registryWorkspaceId, ...await dispatchNativeRuntimeSubmission({ runtimeCleanup: owner }, {
        registryWorkspaceId: lease.registryWorkspaceId, assignmentId: lease.assignmentId, assignmentGeneration: lease.assignmentGeneration,
        leaseRevision: lease.leaseRevision, leaseTokenSha256: "bb".repeat(32), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} } as never,
        submission, signal }) } };
  };
  return { ...f, retained, readCleanupExpectationsForAssignment, owner, lease, reply, context: { credential: {} } as RouteContext };
}
describe("native cleanup metadata transport", () => {
  beforeEach(() => vi.clearAllMocks());
  it("composes the cleanup reader from canonical storage in the production owner", async () => {
    const f = fixture(), llm = {};
    const owners = createRemoteWorkerExecutionOwners({ storage: { remoteWorkerRuntimeResults: { readCleanupExpectationsForAssignment: f.readCleanupExpectationsForAssignment } },
      llm, completionHost: { llmService: llm }, artifactRoot: "unused-cleanup-fixture" } as unknown as RemoteWorkerExecutionOwnersDependencies);
    expect(owners.settlement.runtimeOutcomes).toBeDefined();
    await owners.settlement.runtimeCleanup!.read({ registryWorkspaceId: f.lease.registryWorkspaceId, assignmentId: f.lease.assignmentId,
      assignmentGeneration: f.lease.assignmentGeneration, leaseRevision: f.lease.leaseRevision, leaseTokenSha256: "bb".repeat(32),
      protectedAuthority: { credentialAuthority: {}, meshAdmission: {} } as never, submission: { kind: "runtime.cleanup.read", challenge: "cc".repeat(32) } });
    expect(f.readCleanupExpectationsForAssignment).toHaveBeenCalledTimes(1);
  });
  it("reads complete metadata through dispatch with a fresh challenge on every lookup", async () => {
    const f = fixture(); vi.mocked(callProtectedRoute).mockImplementation(input => f.reply(input.payload.submission as RemoteWorkerRuntimeCleanupSubmission));
    const response = await readWorkerRuntimeCleanup(f.context, f.lease);
    expect(response).toMatchObject(f.retained); expect(JSON.stringify(response)).not.toContain(f.lease.leaseToken);
    expect(f.readCleanupExpectationsForAssignment).toHaveBeenCalledWith(expect.objectContaining({ protectedAuthority: expect.any(Object) }));
    await readWorkerRuntimeCleanup(f.context, f.lease);
    expect(vi.mocked(callProtectedRoute).mock.calls[0]![0].idempotencyKey).not.toBe(vi.mocked(callProtectedRoute).mock.calls[1]![0].idempotencyKey);
  });
  it.each(["revoked", "cancel", "challenge", "lease", "scope", "lost"])("refuses %s without retry", async mode => {
    const f = fixture(), stop = new AbortController();
    if (mode === "revoked") f.readCleanupExpectationsForAssignment.mockRejectedValue(new Error("revoked"));
    vi.mocked(callProtectedRoute).mockImplementation(async input => {
      if (mode === "lost") throw new Error("lost");
      const response = await f.reply(input.payload.submission as RemoteWorkerRuntimeCleanupSubmission);
      if (response.body.disposition !== "runtime_cleanup") throw new Error("wrong fixture");
      const value = response.body.runtimeCleanup;
      if (mode === "challenge") response.body.runtimeCleanup = { ...value, challenge: "ff".repeat(32) };
      if (mode === "lease") response.body.runtimeCleanup = { ...value, history: { ...value.history, leaseRevision: value.history.leaseRevision + 1 } };
      if (mode === "scope") response.body.runtimeCleanup = { ...value, history: { ...value.history, assignmentId: "foreign" } };
      if (mode === "cancel") stop.abort();
      return response;
    });
    await expect(readWorkerRuntimeCleanup(f.context, f.lease, stop.signal)).rejects.toThrow();
    expect(callProtectedRoute).toHaveBeenCalledTimes(1);
  });
  it("checks cancellation after storage and rejects caller-supplied expectations before storage", async () => {
    const f = fixture(), stop = new AbortController(), submission = { kind: "runtime.cleanup.read", challenge: "cc".repeat(32) } as const;
    await expect(f.reply({ ...submission, expectations: [] } as never)).rejects.toThrow();
    expect(f.readCleanupExpectationsForAssignment).not.toHaveBeenCalled();
    f.readCleanupExpectationsForAssignment.mockImplementation(async () => { stop.abort(); return f.retained; });
    await expect(f.reply(submission, stop.signal)).rejects.toThrow();
  });
  it("refuses incomplete, unordered, duplicate, accessor and mismatched metadata sets", () => {
    const f = fixture(), valid = { schemaVersion: REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA, challenge: "cc".repeat(32), ...f.retained };
    expect(normalizeRemoteWorkerRuntimeCleanupExchange({ ...valid, expectations: [] }).expectations).toEqual([]);
    const accessor = [f.expectation]; Object.defineProperty(accessor, "0", { get: () => { throw new Error("getter must not run"); } });
    for (const expectations of [new Array(1), new Array(1001).fill(f.expectation), [f.expectation, f.expectation], accessor,
      [{ ...f.expectation, nonce: "ff".repeat(32) }, { ...f.expectation, nonce: "01".repeat(32) }],
      [{ ...f.expectation, checkpointSha256: "ff".repeat(32) }], [{ ...f.expectation, stdin: "secret" }]])
      expect(() => normalizeRemoteWorkerRuntimeCleanupExchange({ ...valid, expectations })).toThrow(TypeError);
  });
  it("fits the full 1000-entry bound inside the existing protected response limit", () => {
    const f = fixture(), expectations = Array.from({ length: 1000 }, (_, index) => ({ ...f.expectation, nonce: (index + 1).toString(16).padStart(64, "0") }));
    const response = normalizeRemoteWorkerRuntimeCleanupExchange({ schemaVersion: REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA, challenge: "cc".repeat(32), history: f.history, expectations });
    expect(response.expectations).toHaveLength(1000);
    expect(Buffer.byteLength(JSON.stringify({ schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1", operation: "assignment.settlement.submit",
      disposition: "runtime_cleanup", registryWorkspaceId: f.lease.registryWorkspaceId, runtimeCleanup: response }))).toBeLessThan(1024 * 1024);
    expect(Object.isFrozen(response.expectations)).toBe(true);
  });
});
