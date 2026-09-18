import { describe, expect, it, vi } from "vitest";
import { normalizeRemoteWorkerAssignmentRuntime, REMOTE_WORKER_RUNTIME_OUTPUT_ARTIFACT_SCHEMA,
  remoteWorkerRuntimeOutputEvidenceSha256 } from "@goatcitadel/contracts";
import { nativeChatOutputContextFixture } from "../../../../packages/contracts/src/remote-worker-native-chat-context-test-fixture.js";
import {
  RemoteWorkersRouteService,
  RemoteWorkerRuntimeReadUnavailableError,
  type RemoteWorkerAssignmentStore,
  type RemoteWorkerRegistryStore,
  type RemoteWorkerRuntimeReadStore,
} from "./remote-workers-route-service.js";

function projection() {
  const observedAt = "2026-09-12T12:00:00.000Z";
  const truth = (owner: string, authorityClass: string) => ({ owner, authorityClass, value: null, observedAt });
  return normalizeRemoteWorkerAssignmentRuntime({ schemaVersion: "goatcitadel.remote-worker-assignment-runtime.v1", readOnly: true, mutationSemantics: "none",
    workspaceId: "workspace-a", assignmentId: "assignment-a", assignmentGeneration: null, workerId: null, workerGeneration: null, observedAt,
    usageAndCost: truth("storage.remoteWorkerRuntimeReads", "derived_projection"), resourceCell: truth("storage.remoteWorkerCells", "canonical_record"),
    artifactAndEffects: truth("storage.remoteWorkerRuntimeReads", "derived_projection"), connectionHealth: truth("gateway.remoteWorkerListener", "unavailable") });
}
const input = { workspaceId: "workspace-a", assignmentId: "assignment-a" };
function service(store?: RemoteWorkerRuntimeReadStore) {
  return new RemoteWorkersRouteService({} as RemoteWorkerRegistryStore, {} as RemoteWorkerAssignmentStore, undefined, undefined, store);
}

describe("remote worker runtime read service", () => {
  it("downloads exact retained output and refuses foreign scope or an unavailable owner", async () => {
    const context = nativeChatOutputContextFixture();
    if (context.schemaVersion !== "goatcitadel.remote-worker-native-chat-context.v2" || !context.recorded) throw new Error("Expected output fixture");
    const document = { schemaVersion: REMOTE_WORKER_RUNTIME_OUTPUT_ARTIFACT_SCHEMA, registryWorkspaceId: input.workspaceId,
      assignmentId: input.assignmentId, assignmentGeneration: 1, expectation: context.recorded.expectation,
      resultReceipt: context.recorded.receipt, outcome: context.recorded.outcome, output: context.output,
      evidenceSha256: remoteWorkerRuntimeOutputEvidenceSha256(context.output), recordedLeaseRevision: context.recorded.receipt.leaseRevision,
      recordedAt: context.recorded.receipt.recordedAt };
    const request = { ...input, assignmentGeneration: 1, nonce: context.output.nonce };
    const readNativeOutputArtifact = vi.fn(async () => document);
    const owner = { findAssignmentRuntime: async () => undefined, readNativeOutputArtifact };
    const result = await service(owner).getNativeOutputArtifact(request);
    expect(JSON.parse(result.content)).toEqual(document);
    expect(readNativeOutputArtifact).toHaveBeenCalledExactlyOnceWith({ registryWorkspaceId: input.workspaceId,
      assignmentId: input.assignmentId, assignmentGeneration: 1, nonce: context.output.nonce });
    for (const patch of [{ workspaceId: "foreign" }, { assignmentId: "foreign" }, { assignmentGeneration: 2 }, { nonce: "ab".repeat(32) }]) {
      await expect(service(owner).getNativeOutputArtifact({ ...request, ...patch })).rejects.toMatchObject({ httpStatus: 409 });
    }
    await expect(service().getNativeOutputArtifact(request)).rejects.toBeInstanceOf(RemoteWorkerRuntimeReadUnavailableError);
    await expect(service({ ...owner, readNativeOutputArtifact: async () => null }).getNativeOutputArtifact(request)).rejects.toMatchObject({ httpStatus: 404 });
    const calls = readNativeOutputArtifact.mock.calls.length;
    for (const patch of [{ assignmentGeneration: 0 }, { nonce: "0".repeat(64) }]) {
      await expect(service(owner).getNativeOutputArtifact({ ...request, ...patch })).rejects.toThrow("request is invalid");
    }
    expect(readNativeOutputArtifact).toHaveBeenCalledTimes(calls);
  });
  it("awaits only its canonical read owner and binds the exact requested workspace and assignment", async () => {
    const record = projection();
    const findAssignmentRuntime = vi.fn(async () => record);
    const result = await service({ findAssignmentRuntime }).getAssignmentRuntime(input);
    expect(result).toEqual(record);
    expect(findAssignmentRuntime).toHaveBeenCalledExactlyOnceWith({ registryWorkspaceId: input.workspaceId, assignmentId: input.assignmentId });
  });
  it("keeps a missing read owner distinct from a missing assignment", async () => {
    await expect(service().getAssignmentRuntime(input)).rejects.toBeInstanceOf(RemoteWorkerRuntimeReadUnavailableError);
    await expect(service({ findAssignmentRuntime: async () => undefined }).getAssignmentRuntime(input)).rejects.toMatchObject({ httpStatus: 404 });
  });
  it("refuses cross-scope and malformed owner results", async () => {
    await expect(service({ findAssignmentRuntime: async () => ({ ...projection(), workspaceId: "other" }) }).getAssignmentRuntime(input))
      .rejects.toMatchObject({ httpStatus: 409 });
    await expect(service({ findAssignmentRuntime: async () => ({ ...projection(), rawCredential: "private" }) }).getAssignmentRuntime(input))
      .rejects.toThrow("projection is invalid");
  });
  it("validates identifiers before any storage access", async () => {
    const findAssignmentRuntime = vi.fn(async () => projection());
    await expect(service({ findAssignmentRuntime }).getAssignmentRuntime({ ...input, workspaceId: " workspace-a" })).rejects.toThrow("request is invalid");
    expect(findAssignmentRuntime).not.toHaveBeenCalled();
  });
});
