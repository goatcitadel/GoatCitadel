import { describe, expect, it, vi } from "vitest";
import { REMOTE_WORKER_CHAT_OUTPUT_PROFILE_SHA256, canonicalJsonString, remoteWorkerArtifactManifestSha256,
  type RemoteWorkerArtifactManifest } from "@goatcitadel/contracts";
import { publishWorkerChatArtifact, type WorkerArtifactCall } from "./worker-artifact-publication.js";
import { createInMemoryWorkerDurableState } from "./worker-durable-state.js";
import type { LeaseBinding } from "./connected-worker-routes.js";

function fixture() {
  const state = createInMemoryWorkerDurableState();
  const lease: LeaseBinding = { registryWorkspaceId: "default", assignmentId: "assignment-one", assignmentGeneration: 1, leaseRevision: 1, leaseToken: "a".repeat(43) };
  const workload = { registryWorkspaceId: "default", assignmentId: lease.assignmentId, assignmentManifestSha256: "b".repeat(64),
    artifactPolicy: { pathJailSha256: "c".repeat(64), verifierProfileSha256: REMOTE_WORKER_CHAT_OUTPUT_PROFILE_SHA256, deadlineAt: "2099-01-01T00:00:00.000Z" } };
  const identity = { registryWorkspaceId: "default", executionWorkspaceId: "default", assignmentId: lease.assignmentId, assignmentGeneration: 1,
    workerId: "worker-one", workerGeneration: 1, runtimeManifestSha256: "d".repeat(64), workspaceCeilingSha256: "e".repeat(64),
    capabilityCeilingSha256: "f".repeat(64), assignmentManifestSha256: workload.assignmentManifestSha256 };
  let upload: Record<string, unknown>;
  const call = vi.fn<WorkerArtifactCall>(async (phase, submission) => {
    if (phase === "open") upload = { identity, uploadId: "upload-one", ...submission, uploadState: "open" };
    if (phase === "commit") upload = { ...upload, uploadState: "committed", verificationGateState: "satisfied",
      committedManifestSha256: remoteWorkerArtifactManifestSha256(submission.manifest as RemoteWorkerArtifactManifest) };
    return upload!;
  });
  return { state, lease, workload, call, lines: ["Verified ", "response."] };
}
describe("worker verified artifact publication", () => {
  it("retains the exact upload expiry and manifest across a lost commit response", async () => {
    const f = fixture(), requests: string[] = []; let failed = false;
    const call: WorkerArtifactCall = async (phase, submission) => {
      requests.push(canonicalJsonString({ phase, submission })); const result = await f.call(phase, submission);
      if (phase === "commit" && !failed) { failed = true; throw new Error("response lost"); } return result;
    };
    await expect(publishWorkerChatArtifact({ ...f, call })).rejects.toThrow("response lost");
    await expect(publishWorkerChatArtifact({ ...f, call })).resolves.toMatchObject({ resultSha256: expect.any(String), outputManifestSha256: expect.any(String) });
    expect(requests.slice(0, 3)).toEqual(requests.slice(3));
  });
  it("blocks changed output before reopening the retained upload", async () => {
    const f = fixture(); await publishWorkerChatArtifact(f); f.call.mockClear();
    await expect(publishWorkerChatArtifact({ ...f, lines: ["Different response."] })).rejects.toThrow("intent changed");
    expect(f.call).not.toHaveBeenCalled();
  });
  it("does not send any bytes when the durable intent cannot be saved", async () => {
    const f = fixture();
    await expect(publishWorkerChatArtifact({ ...f, state: { ...f.state, write: async () => { throw new Error("disk full"); } } })).rejects.toThrow("disk full");
    expect(f.call).not.toHaveBeenCalled();
  });
  it.each(["pending", "not_required"])("refuses a %s verification gate", async gate => {
    const f = fixture(); const call: WorkerArtifactCall = async (phase, submission) => ({ ...await f.call(phase, submission), verificationGateState: gate });
    await expect(publishWorkerChatArtifact({ ...f, call })).rejects.toThrow("no matching Gateway verification");
  });
  it("rejects substituted upload identity before sending a part", async () => {
    const f = fixture(); const call: WorkerArtifactCall = async (phase, submission) => {
      const result = await f.call(phase, submission); return { ...result, identity: { ...(result.identity as object), assignmentId: "another-assignment" } };
    };
    await expect(publishWorkerChatArtifact({ ...f, call })).rejects.toThrow("does not match");
    expect(f.call).toHaveBeenCalledTimes(1);
  });
});
