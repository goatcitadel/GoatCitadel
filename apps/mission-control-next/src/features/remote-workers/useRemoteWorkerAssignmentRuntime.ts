import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteWorkerAssignmentProjection, RemoteWorkerAssignmentRuntime } from "@goatcitadel/contracts";
import { fetchRemoteWorkerAssignmentRuntime } from "@goatcitadel/mission-control-shared/api/remote-workers";

/** Ops and Chat share the same generation-bound, read-only evidence lifecycle. */
export function useRemoteWorkerAssignmentRuntime({
  workspaceId,
  assignment,
  refreshKey,
}: {
  workspaceId: string;
  assignment: RemoteWorkerAssignmentProjection;
  refreshKey?: string | number;
}) {
  const assignmentId = assignment.assignmentId;
  const assignmentGeneration = assignment.identity.value?.assignmentGeneration ?? null;
  const workerId = assignment.identity.value?.workerId ?? null;
  const workerGeneration = assignment.identity.value?.workerGeneration ?? null;
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([
    workspaceId,
    assignmentId,
    assignmentGeneration,
    workerId,
    workerGeneration,
    refreshKey,
    attempt,
  ]);
  const [state, setState] = useState<{
    key: string;
    data: RemoteWorkerAssignmentRuntime | null;
    error: string | null;
  }>({ key, data: null, error: null });
  const sequence = useRef(0);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const requestId = ++sequence.current;
    setState({ key, data: null, error: null });
    void fetchRemoteWorkerAssignmentRuntime(workspaceId, assignmentId)
      .then((result) => {
        if (sequence.current !== requestId) return;
        if (
          result.workspaceId !== workspaceId ||
          result.assignmentId !== assignmentId ||
          result.assignmentGeneration !== assignmentGeneration ||
          result.workerId !== workerId ||
          result.workerGeneration !== workerGeneration
        ) {
          setState({
            key,
            data: null,
            error: "Assignment identity changed. Refresh the worker before inspecting this generation.",
          });
          return;
        }
        setState({ key, data: result, error: null });
      })
      .catch(() => {
        if (sequence.current === requestId) {
          setState({
            key,
            data: null,
            error: "Assignment runtime evidence is unavailable. No health, usage, or settlement was inferred.",
          });
        }
      });
    return () => {
      sequence.current = requestId + 1;
    };
  }, [key, workspaceId, assignmentId, assignmentGeneration, workerId, workerGeneration]);

  // Hide the previous scope in the render that precedes effect cleanup as well.
  const data = state.key === key ? state.data : null;
  const error = state.key === key ? state.error : null;
  return { data, error, loading: !data && !error, reload };
}
