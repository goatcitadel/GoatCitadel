import type {
  RemoteWorkerAssignmentWorkloadProjection,
  ResolveRemoteWorkerAssignmentWorkloadInput,
} from "@goatcitadel/storage";

interface WorkloadRepository {
  resolveTaskBoundChatWorkload(input: ResolveRemoteWorkerAssignmentWorkloadInput):
    RemoteWorkerAssignmentWorkloadProjection | undefined | Promise<RemoteWorkerAssignmentWorkloadProjection | undefined>;
}

export type RemoteWorkerWorkloadProjector = (
  workload: RemoteWorkerAssignmentWorkloadProjection,
  scope: { registryWorkspaceId: string; assignmentId: string; assignmentGeneration: number },
) => Promise<RemoteWorkerAssignmentWorkloadProjection>;

interface WorkloadDependencies {
  readonly assignments: WorkloadRepository;
  readonly projectWorkload?: RemoteWorkerWorkloadProjector;
}

/** Reconstruction is read-only and must not return history after the retained
 * workload or its current authority changes during asynchronous projection. */
export async function readProjectedWorkerAssignmentWorkload(
  deps: WorkloadDependencies,
  binding: ResolveRemoteWorkerAssignmentWorkloadInput,
): Promise<RemoteWorkerAssignmentWorkloadProjection | undefined> {
  const workload = await deps.assignments.resolveTaskBoundChatWorkload(binding);
  if (!workload || !deps.projectWorkload || !workload.nativeChatContext) return workload;
  const projected = await deps.projectWorkload(workload, {
    registryWorkspaceId: binding.registryWorkspaceId,
    assignmentId: binding.assignmentId,
    assignmentGeneration: binding.expectedAssignmentGeneration,
  });
  const fresh = await deps.assignments.resolveTaskBoundChatWorkload(binding);
  if (!fresh || fresh.workloadSha256 !== workload.workloadSha256)
    throw new Error("Native Chat workload changed during history reconstruction.");
  return projected;
}
