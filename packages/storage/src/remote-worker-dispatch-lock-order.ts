export interface RemoteWorkerTaskBoundDispatchLockIdentity {
  readonly sessionId: string;
  readonly executionWorkspaceId: string;
  readonly nodeId: string;
  readonly registryWorkspaceId: string;
  readonly workerId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
}

export interface RemoteWorkerTaskBoundDispatchAdvisoryLock {
  readonly namespace: 411 | 412 | 501 | 502 | 503 | 504 | 505;
  readonly key: string;
}

/**
 * One canonical cross-owner order for task-bound claim and workload reads:
 * the session and mesh roots that share namespace 411 (sorted by exact key),
 * the mesh-node root, M2 credential roots, the M3 binding, then assignment
 * roots.
 * Acquiring the complete plan up front makes nested repository re-acquisition
 * non-blocking and prevents claim/read order inversion.
 */
export function buildRemoteWorkerTaskBoundDispatchLockPlan(
  input: RemoteWorkerTaskBoundDispatchLockIdentity,
): readonly RemoteWorkerTaskBoundDispatchAdvisoryLock[] {
  const sharedRoots = [...new Set([input.sessionId, input.executionWorkspaceId])]
    .sort()
    .map((key) => Object.freeze({ namespace: 411 as const, key }));
  return Object.freeze([
    ...sharedRoots,
    Object.freeze({ namespace: 412 as const, key: `${input.executionWorkspaceId}:${input.nodeId}` }),
    Object.freeze({ namespace: 501 as const, key: input.registryWorkspaceId }),
    Object.freeze({ namespace: 502 as const, key: `${input.registryWorkspaceId}:${input.workerId}` }),
    Object.freeze({
      namespace: 505 as const,
      key: `${input.registryWorkspaceId}:${input.workerId}:${input.executionWorkspaceId}:${input.nodeId}`,
    }),
    Object.freeze({ namespace: 503 as const, key: `${input.registryWorkspaceId}:${input.assignmentId}` }),
    Object.freeze({
      namespace: 504 as const,
      key: `${input.registryWorkspaceId}:${input.assignmentId}:${input.assignmentGeneration}`,
    }),
  ]);
}
