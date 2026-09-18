import { ConflictError, NotFoundError, serializeRemoteWorkerRuntimeOutputArtifact,
  type RemoteWorkerRuntimeOutputArtifact } from "@goatcitadel/contracts";

/** Validate canonical evidence and bind its download to the operator's exact request. */
export function prepareNativeOutputArtifact(record: RemoteWorkerRuntimeOutputArtifact | null, scope: {
  registryWorkspaceId: string; assignmentId: string; assignmentGeneration: number; nonce: string;
}) {
  if (!record) throw new NotFoundError({ entity: "Native output artifact", id: scope.nonce });
  const artifact = serializeRemoteWorkerRuntimeOutputArtifact(record), document = artifact.document;
  if (document.registryWorkspaceId !== scope.registryWorkspaceId || document.assignmentId !== scope.assignmentId ||
      document.assignmentGeneration !== scope.assignmentGeneration || document.output.nonce !== scope.nonce)
    throw new ConflictError({ message: "Native output artifact scope changed." });
  return artifact;
}
