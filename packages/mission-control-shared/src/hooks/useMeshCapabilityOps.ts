import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchMeshCapabilityInvocationActivity,
  fetchMeshCapabilityPublications,
  type MeshCapabilityInvocationActivityItem,
  type MeshCapabilityPublicationInspectionResponse,
} from "../api/mesh-capabilities";
import { useRefreshSubscription } from "./useRefreshSubscription";

export interface MeshCapabilityOpsState {
  readonly inspection: MeshCapabilityPublicationInspectionResponse | null;
  readonly invocationActivity: readonly MeshCapabilityInvocationActivityItem[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly activityError: string | null;
  readonly reload: () => Promise<void>;
}

/**
 * HX-408 M4 Ops truth for one workspace's mesh capability publications: the
 * server-built inspection projection (M1 route) plus best-effort invocation
 * activity reduced from the retained realtime events (M3 owner). The two reads
 * fail independently so a broken events listing never hides publication truth,
 * and vice versa — neither read is ever substituted with client inference.
 */
export function useMeshCapabilityOps(workspaceId: string): MeshCapabilityOpsState {
  const [inspection, setInspection] = useState<MeshCapabilityPublicationInspectionResponse | null>(null);
  const [invocationActivity, setInvocationActivity] = useState<readonly MeshCapabilityInvocationActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);

  const reload = useCallback(async () => {
    const loadId = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadId;
    const [inspectionResult, activityResult] = await Promise.allSettled([
      fetchMeshCapabilityPublications(workspaceId),
      fetchMeshCapabilityInvocationActivity(workspaceId),
    ]);
    if (loadSequenceRef.current !== loadId) {
      return;
    }
    if (inspectionResult.status === "fulfilled") {
      setInspection(inspectionResult.value);
      setError(null);
    } else {
      setInspection(null);
      setError("The mesh capability publication inspection is unavailable.");
    }
    if (activityResult.status === "fulfilled") {
      setInvocationActivity(activityResult.value);
      setActivityError(null);
    } else {
      setInvocationActivity([]);
      setActivityError("Recent mesh invocation activity is unavailable.");
    }
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    setLoading(true);
    setInspection(null);
    setInvocationActivity([]);
    setError(null);
    setActivityError(null);
    void reload();
    return () => {
      loadSequenceRef.current += 1;
    };
  }, [reload]);

  useRefreshSubscription("system", reload, {
    staleMs: 60_000,
    pollIntervalMs: 60_000,
  });
  useRefreshSubscription("approvals", reload);

  return useMemo(
    () => ({ inspection, invocationActivity, loading, error, activityError, reload }),
    [inspection, invocationActivity, loading, error, activityError, reload],
  );
}
