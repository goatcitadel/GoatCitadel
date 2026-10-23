import { useEffect, useRef, useState } from "react";
import type { RemoteWorkerAssignmentEventPage } from "@goatcitadel/contracts";
import { fetchRemoteWorkerAssignmentEvents } from "@goatcitadel/mission-control-shared/api/remote-workers";

const UNAVAILABLE = "Events for this assignment are unavailable.";

/**
 * Event summaries for one assignment generation, moved from the Classic workers page: a page for another workspace,
 * assignment or generation is refused, and newer pages merge by sequence under a busy lock.
 */
export function useAssignmentEvents(
  workspaceId: string,
  assignment: { assignmentId: string; generation: number | undefined; refreshKey?: string } | undefined,
) {
  const [page, setPage] = useState<RemoteWorkerAssignmentEventPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const lifecycle = useRef(0);
  const busy = useRef(false);
  const assignmentId = assignment?.assignmentId,
    generation = assignment?.generation,
    refreshKey = assignment?.refreshKey;

  useEffect(() => {
    const counter = lifecycle;
    const sequence = ++counter.current;
    busy.current = false;
    setLoadingNewer(false);
    setMoreError(null);
    setPage(null);
    setError(null);
    if (!assignmentId || generation === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchRemoteWorkerAssignmentEvents(workspaceId, assignmentId, { limit: 50 });
        if (
          next.workspaceId !== workspaceId ||
          next.assignmentId !== assignmentId ||
          next.assignmentGeneration !== generation
        )
          throw new Error("Event generation changed");
        if (!cancelled) setPage(next);
      } catch {
        if (!cancelled) setError(UNAVAILABLE);
      }
    })();
    return () => {
      cancelled = true;
      if (counter.current === sequence) counter.current++;
    };
  }, [workspaceId, assignmentId, generation, refreshKey]);

  const loadNewer = async () => {
    if (!assignmentId || !page || page.nextAfterSequence === undefined || busy.current) return;
    const sequence = lifecycle.current;
    busy.current = true;
    setLoadingNewer(true);
    setMoreError(null);
    try {
      const next = await fetchRemoteWorkerAssignmentEvents(workspaceId, assignmentId, {
        limit: 50,
        afterSequence: page.nextAfterSequence,
      });
      if (sequence !== lifecycle.current) return;
      if (next.assignmentGeneration !== page.assignmentGeneration) throw new Error("Event generation changed");
      const rows = new Map(page.items.map((item) => [item.sequence, item]));
      next.items.forEach((item) => rows.set(item.sequence, item));
      setPage({ ...next, items: [...rows.values()] });
    } catch {
      if (sequence === lifecycle.current) setMoreError("Newer events are unavailable. Loaded events stay shown.");
    } finally {
      if (sequence === lifecycle.current) {
        busy.current = false;
        setLoadingNewer(false);
      }
    }
  };

  return { page, error, moreError, loadingNewer, loadNewer };
}
