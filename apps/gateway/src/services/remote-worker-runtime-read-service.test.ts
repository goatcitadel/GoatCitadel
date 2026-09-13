import { describe, expect, it, vi } from "vitest";
import { normalizeRemoteWorkerAssignmentRuntime } from "@goatcitadel/contracts";
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
