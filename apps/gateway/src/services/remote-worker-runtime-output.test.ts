import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA, remoteWorkerRuntimeOutputEvidenceSha256,
  type RemoteWorkerRuntimeOutputSubmission } from "@goatcitadel/contracts";
import { retainRemoteWorkerRuntimeOutput } from "./remote-worker-runtime-output.js";
import { createRemoteWorkerExecutionOwners, type RemoteWorkerExecutionOwnersDependencies } from "./remote-worker-execution-owners.js";
import { retainWorkerRuntimeOutput } from "../../../remote-worker/src/worker-runtime-output-client.js";
import { callProtectedRoute } from "../../../remote-worker/src/worker-protected-route-client.js";
import type { RouteContext } from "../../../remote-worker/src/connected-worker-routes.js";
vi.mock("../../../remote-worker/src/worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));
function fixture() {
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const evidence = { schemaVersion: REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA, nonce: "11".repeat(32), requestSha256: "22".repeat(32), resultSha256: "33".repeat(32),
    streams: { stdout: { bytes: 5, sha256: hash("hello"), text: "hello", truncated: false, provenance: "native_stream_local_diagnostic" as const },
      stderr: { bytes: 0, sha256: hash(""), text: "", truncated: false, provenance: "native_stream_local_diagnostic" as const } } };
  const saved = { evidence, evidenceSha256: remoteWorkerRuntimeOutputEvidenceSha256(evidence), leaseRevision: 1, recordedAt: "2026-09-15T00:00:00.000Z" };
  const retainOutputForAssignment = vi.fn(async () => saved);
  const llm = {}, owner = createRemoteWorkerExecutionOwners({ storage: { remoteWorkerRuntimeResults: { retainOutputForAssignment } }, llm,
    completionHost: { llmService: llm }, artifactRoot: "unused-native-output-fixture" } as unknown as RemoteWorkerExecutionOwnersDependencies).settlement.runtimeOutputs!;
  const lease = { registryWorkspaceId: "default", assignmentId: "assignment", assignmentGeneration: 1, leaseRevision: 2, leaseToken: "private-current-lease-token" };
  const context = { credential: {} } as RouteContext;
  const reply = async (submission: RemoteWorkerRuntimeOutputSubmission, signal?: AbortSignal) => ({ status: 200, body: {
    schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1", operation: "assignment.settlement.submit", disposition: "runtime_output",
    registryWorkspaceId: lease.registryWorkspaceId, runtimeOutput: await retainRemoteWorkerRuntimeOutput(owner, {
      registryWorkspaceId: lease.registryWorkspaceId, assignmentId: lease.assignmentId, assignmentGeneration: lease.assignmentGeneration,
      leaseRevision: lease.leaseRevision, leaseTokenSha256: "bb".repeat(32), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} } as never, submission, signal }) } });
  return { evidence, saved, retainOutputForAssignment, owner, lease, context, reply };
}
describe("native output retention transport", () => {
  beforeEach(() => vi.clearAllMocks());
  it("acknowledges exact retained evidence under the current lease without echoing text or credentials", async () => {
    const f = fixture(); vi.mocked(callProtectedRoute).mockImplementation(input => f.reply(input.payload.submission as RemoteWorkerRuntimeOutputSubmission));
    const receipt = await retainWorkerRuntimeOutput(f.context, f.lease, f.evidence);
    expect(receipt).toMatchObject({ leaseRevision: 2, recordedLeaseRevision: 1, evidenceSha256: f.saved.evidenceSha256 });
    expect(JSON.stringify(receipt)).not.toContain("hello"); expect(JSON.stringify(receipt)).not.toContain(f.lease.leaseToken);
    expect(Object.isFrozen(receipt)).toBe(true);
    await retainWorkerRuntimeOutput(f.context, f.lease, f.evidence);
    const calls = vi.mocked(callProtectedRoute).mock.calls;
    expect(calls[0]![0].idempotencyKey).toBe(calls[1]![0].idempotencyKey);
    expect(f.retainOutputForAssignment).toHaveBeenCalledWith(expect.objectContaining({ evidence: f.evidence, leaseRevision: 2, protectedAuthority: expect.any(Object) }));
  });
  it.each(["stored-text", "stored-hash", "revoked", "scope", "generation", "lease", "nonce", "request", "result", "hash", "future-revision", "date", "extra", "cancel", "lost"])("refuses %s without relaunch or automatic retry", async mode => {
    const f = fixture(), stop = new AbortController();
    if (mode === "stored-text") f.saved.evidence = { ...f.evidence, streams: { ...f.evidence.streams, stdout: { ...f.evidence.streams.stdout, text: "other" } } };
    if (mode === "stored-hash") f.saved.evidenceSha256 = "ff".repeat(32);
    if (mode === "revoked") f.retainOutputForAssignment.mockRejectedValue(new Error("revoked"));
    vi.mocked(callProtectedRoute).mockImplementation(async input => {
      if (mode === "lost") throw new Error("lost");
      const response = await f.reply(input.payload.submission as RemoteWorkerRuntimeOutputSubmission), receipt = response.body.runtimeOutput;
      const patch = mode === "scope" ? { assignmentId: "foreign" } : mode === "generation" ? { assignmentGeneration: 2 } : mode === "lease" ? { leaseRevision: 3 }
        : mode === "nonce" ? { nonce: "ff".repeat(32) } : mode === "request" ? { requestSha256: "ff".repeat(32) }
        : mode === "result" ? { resultSha256: "ff".repeat(32) } : mode === "hash" ? { evidenceSha256: "ff".repeat(32) }
        : mode === "future-revision" ? { recordedLeaseRevision: 3 } : mode === "date" ? { recordedAt: "2026-02-30T00:00:00.000Z" }
        : mode === "extra" ? { completed: true } : {};
      response.body.runtimeOutput = { ...receipt, ...patch };
      if (mode === "cancel") stop.abort();
      return response;
    });
    await expect(retainWorkerRuntimeOutput(f.context, f.lease, f.evidence, stop.signal)).rejects.toThrow();
    expect(callProtectedRoute).toHaveBeenCalledTimes(1);
  });
  it.each(["lease-secret", "known-secret", "cancelled"])("refuses %s before network delivery", async mode => {
    const f = fixture(), stop = new AbortController();
    f.evidence.streams.stdout.text = mode === "lease-secret" ? f.lease.leaseToken : "API_KEY=very-secret-output-value";
    if (mode === "cancelled") { f.evidence.streams.stdout.text = "hello"; stop.abort(); }
    await expect(retainWorkerRuntimeOutput(f.context, f.lease, f.evidence, stop.signal)).rejects.toThrow();
    expect(callProtectedRoute).not.toHaveBeenCalled();
  });
  it.each(["before", "after"])("honors %s-storage cancellation", async stage => {
    const f = fixture(), stop = new AbortController();
    if (stage === "before") stop.abort();
    else f.retainOutputForAssignment.mockImplementation(async () => { stop.abort(); return f.saved; });
    await expect(f.reply({ kind: "runtime.output.retain", evidence: f.evidence }, stop.signal)).rejects.toThrow();
    expect(f.retainOutputForAssignment).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
  });
});
