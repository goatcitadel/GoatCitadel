import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY_PREFIX = "mc-next:projects:pinned:";

function storageKeyFor(workspaceId: string): string {
  return `${STORAGE_KEY_PREFIX}${workspaceId || "default"}`;
}

function readPinnedSet(workspaceId: string): ReadonlySet<string> {
  if (typeof window === "undefined" || !window.localStorage) {
    return new Set();
  }
  try {
    const raw = window.localStorage.getItem(storageKeyFor(workspaceId));
    if (!raw) {
      return new Set();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set();
  }
}

function writePinnedSet(workspaceId: string, pinned: ReadonlySet<string>): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(storageKeyFor(workspaceId), JSON.stringify([...pinned]));
  } catch {
    // Ignore quota or serialization errors; pin state is best-effort.
  }
}

export type ProjectPinController = {
  pinnedIds: ReadonlySet<string>;
  isPinned: (projectId: string) => boolean;
  togglePinned: (projectId: string) => void;
};

export function useProjectPinController(workspaceId: string): ProjectPinController {
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(() => readPinnedSet(workspaceId));

  useEffect(() => {
    setPinnedIds(readPinnedSet(workspaceId));
  }, [workspaceId]);

  const isPinned = useCallback((projectId: string) => pinnedIds.has(projectId), [pinnedIds]);

  const togglePinned = useCallback(
    (projectId: string) => {
      setPinnedIds((current) => {
        const next = new Set(current);
        if (next.has(projectId)) {
          next.delete(projectId);
        } else {
          next.add(projectId);
        }
        writePinnedSet(workspaceId, next);
        return next;
      });
    },
    [workspaceId],
  );

  return { pinnedIds, isPinned, togglePinned };
}

export type ProjectFilterView = "all" | "pinned" | "active" | "archived";

export const PROJECT_FILTER_VIEWS: ReadonlyArray<{
  id: ProjectFilterView;
  label: string;
}> = [
  { id: "all", label: "All" },
  { id: "pinned", label: "Pinned" },
  { id: "active", label: "Active" },
  { id: "archived", label: "Archived" },
];
