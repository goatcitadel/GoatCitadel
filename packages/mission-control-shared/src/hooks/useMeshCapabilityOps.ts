import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  const scope = useMemo(() => ({ workspaceId }), [workspaceId]);
  const activeScope = useRef<typeof scope | null>(null);
  const loadSequenceRef = useRef(0);
  const [result, setResult] = useState<
    Pick<MeshCapabilityOpsState, "inspection" | "invocationActivity" | "error" | "activityError"> & {
      scope: typeof scope;
    }
  >();

  useLayoutEffect(() => {
    activeScope.current = scope;
    return () => {
      activeScope.current = null;
      loadSequenceRef.current += 1;
    };
  }, [scope]);

  const reload = useCallback(async () => {
    if (activeScope.current !== scope) return;
    const loadId = ++loadSequenceRef.current;
    const [inspectionResult, activityResult] = await Promise.allSettled([
      fetchMeshCapabilityPublications(scope.workspaceId),
      fetchMeshCapabilityInvocationActivity(scope.workspaceId),
    ]);
    if (loadSequenceRef.current !== loadId) return;
    setResult({
      scope,
      inspection: inspectionResult.status === "fulfilled" ? inspectionResult.value : null,
      invocationActivity: activityResult.status === "fulfilled" ? activityResult.value : [],
      error:
        inspectionResult.status === "rejected" ? "The mesh capability publication inspection is unavailable." : null,
      activityError: activityResult.status === "rejected" ? "Recent mesh invocation activity is unavailable." : null,
    });
  }, [scope]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useRefreshSubscription("system", reload, {
    staleMs: 60_000,
    pollIntervalMs: 60_000,
  });
  useRefreshSubscription("approvals", reload);

  const current = result?.scope === scope ? result : undefined;
  return useMemo(
    () => ({
      inspection: current?.inspection ?? null,
      invocationActivity: current?.invocationActivity ?? [],
      error: current?.error ?? null,
      activityError: current?.activityError ?? null,
      loading: !current,
      reload,
    }),
    [current, reload],
  );
}
