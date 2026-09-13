import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRemoteWorkerExecutionOwners, type RemoteWorkerExecutionOwnersDependencies } from "./remote-worker-execution-owners.js";
import { REMOTE_WORKER_NATIVE_CELL_POLICY } from "./remote-worker-native-cell-policy.js";

describe("native cell owner production composition", () => {
  it.each(["current", "before", "after"])("uses only Gateway limits and respects %s cancellation", async (stage) => {
    const controller = new AbortController();
    const recorded = { decision: "create_once" };
    const prepareForAssignment = vi.fn(async () => { if (stage === "after") controller.abort(); return recorded; });
    const llm = {};
    // Other execution owners are constructed but never invoked in this check.
    const dependencies = { storage: { remoteWorkerCellProvisioning: { prepareForAssignment } }, llm,
      completionHost: { llmService: llm }, artifactRoot: path.join(process.cwd(), "unused-native-preparation-fixture")
    } as unknown as RemoteWorkerExecutionOwnersDependencies;
    const owner = createRemoteWorkerExecutionOwners(dependencies).settlement.cellProvisioning!;
    const input = { registryWorkspaceId: "default", assignmentId: "assignment", assignmentGeneration: 1,
      leaseRevision: 1, leaseTokenSha256: "1".repeat(64), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} },
      submission: { kind: "cell.provisioning.prepare", parentIdentityHex: "0100000000000000" + "1".repeat(32) },
      policy: { capacity: "caller must not choose this" }, signal: controller.signal };
    if (stage === "before") controller.abort();
    const pending = owner.prepare!(input as unknown as Parameters<NonNullable<typeof owner.prepare>>[0]);
    if (stage === "current") await expect(pending).resolves.toBe(recorded);
    else await expect(pending).rejects.toThrow();
    expect(prepareForAssignment).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
    if (stage !== "before") expect(prepareForAssignment).toHaveBeenCalledWith({
      registryWorkspaceId: input.registryWorkspaceId, assignmentId: input.assignmentId,
      assignmentGeneration: 1, leaseRevision: 1, leaseTokenSha256: input.leaseTokenSha256,
      protectedAuthority: input.protectedAuthority, submission: input.submission, policy: REMOTE_WORKER_NATIVE_CELL_POLICY });
    expect(Object.isFrozen(REMOTE_WORKER_NATIVE_CELL_POLICY.capacity)).toBe(true);
  });
});
