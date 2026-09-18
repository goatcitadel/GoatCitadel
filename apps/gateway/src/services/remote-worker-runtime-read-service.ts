import {
  ConflictError,
  NotFoundError,
  normalizeRemoteWorkerAssignmentRuntime,
  type RemoteWorkerAssignmentRuntime,
  type RemoteWorkerRuntimeOutputArtifact,
  type RemoteWorkerRuntimeReadKey,
} from "@goatcitadel/contracts";
import { prepareNativeOutputArtifact } from "./remote-worker-native-output-artifact.js";

export interface RemoteWorkerRuntimeReadStore {
  findAssignmentRuntime(key: RemoteWorkerRuntimeReadKey): Promise<RemoteWorkerAssignmentRuntime | undefined>;
  readNativeOutputArtifact?(key: RemoteWorkerRuntimeReadKey & { assignmentGeneration: number; nonce: string }): Promise<RemoteWorkerRuntimeOutputArtifact | null>;
}

export class RemoteWorkerRuntimeReadUnavailableError extends Error {
  public constructor() {
    super("Remote worker runtime reads are unavailable.");
    this.name = "RemoteWorkerRuntimeReadUnavailableError";
  }
}

/** Read-only projection; route validation and operator mutation owners remain separate. */
export async function readWorkerAssignmentRuntime(store: RemoteWorkerRuntimeReadStore | undefined, key: RemoteWorkerRuntimeReadKey) {
  if (!store) throw new RemoteWorkerRuntimeReadUnavailableError();
  const record = await store.findAssignmentRuntime({ ...key });
  if (!record) throw new NotFoundError({ entity: "Remote worker assignment", id: key.assignmentId });
  const projection = normalizeRemoteWorkerAssignmentRuntime(record);
  if (projection.workspaceId !== key.registryWorkspaceId || projection.assignmentId !== key.assignmentId) {
    throw new ConflictError({ message: "Remote worker runtime scope changed. Refresh the assignment." });
  }
  return projection;
}

export async function readWorkerNativeOutputArtifact(
  store: RemoteWorkerRuntimeReadStore | undefined,
  key: RemoteWorkerRuntimeReadKey & { assignmentGeneration: number; nonce: string },
) {
  if (!store?.readNativeOutputArtifact) throw new RemoteWorkerRuntimeReadUnavailableError();
  const record = await store.readNativeOutputArtifact({ ...key });
  return prepareNativeOutputArtifact(record, key);
}
