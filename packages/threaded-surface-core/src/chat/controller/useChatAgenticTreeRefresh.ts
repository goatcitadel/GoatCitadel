import {
  fetchAgenticRuns,
  fetchAgenticRunTree,
  type AgenticRunTreeResponse,
} from "@goatcitadel/mission-control-shared/api/agentic";
import { useCallback, useEffect } from "react";
import type { MissionThreadedControllerHostProps } from "../../MissionThreadedControllerHost.types";
import { useChatSessionSelection } from "./useChatSessionSelection";

type Input = {
  selection: Pick<ReturnType<typeof useChatSessionSelection>, "selectedSessionId">;
  workspaceId: NonNullable<MissionThreadedControllerHostProps["workspaceId"]>;
  setAgenticRunTree: React.Dispatch<React.SetStateAction<AgenticRunTreeResponse | null>>;
};

/** Reads the selected session run tree, ignoring obsolete async completions. */
export function useChatAgenticTreeRefresh({ selection, workspaceId, setAgenticRunTree }: Input) {
  const resolveAgenticRunTree = useCallback(async (): Promise<AgenticRunTreeResponse | null> => {
    if (!selection.selectedSessionId) {
      return null;
    }
    const response = await fetchAgenticRuns({
      workspaceId,
      sessionId: selection.selectedSessionId,
      surface: "chat",
      limit: 1,
    });
    const runId = response.items[0]?.runId;
    return runId ? fetchAgenticRunTree(runId, { workspaceId }) : null;
  }, [selection.selectedSessionId, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    void resolveAgenticRunTree()
      .then((tree) => {
        if (!cancelled) {
          setAgenticRunTree(tree);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAgenticRunTree(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [resolveAgenticRunTree, setAgenticRunTree]);

  return { resolveAgenticRunTree };
}
