import type { ChatMode, ChatSessionRecord, ChatThreadResponse } from "@goatcitadel/contracts";
import { useEffect, useMemo, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { flattenThreadMessages } from "./chat-page-normalizers";
import { resolveSelectedTurnId } from "./chat-page-pure-helpers";
import { formatSessionLabel } from "./useMissionControlSurfaceState";

export type ChatHistoryView = "active" | "archived";

type SessionListItem = ChatSessionRecord & {
  projectName?: string | null;
  channel?: string | null;
  account?: string | null;
};

type ProjectListItem = {
  projectId: string;
  name: string;
};

export function useChatThreadController(input: {
  surfaceMode: ChatMode;
  showAllModes?: boolean;
  routeSearch: string;
  sessions?: SessionListItem[];
  projects?: ProjectListItem[];
  thread: ChatThreadResponse | null;
  selectedProjectId: string;
  setSelectedProjectId: Dispatch<SetStateAction<string>>;
  selectedFolderId: string;
  setSelectedFolderId: Dispatch<SetStateAction<string>>;
  selectedTag: string | null;
  setSelectedTag: Dispatch<SetStateAction<string | null>>;
  historyView: ChatHistoryView;
  setHistoryView: Dispatch<SetStateAction<ChatHistoryView>>;
  selectedSessionId: string | null;
  setSelectedSessionId: Dispatch<SetStateAction<string | null>>;
  selectedTurnId: string | null;
  setSelectedTurnId: Dispatch<SetStateAction<string | null>>;
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  followThreadOutput: boolean;
  setFollowThreadOutput: Dispatch<SetStateAction<boolean>>;
  applyFetchedThreadRef: MutableRefObject<(thread: ChatThreadResponse, requestVersion: number | null) => boolean>;
  messageMutationVersionRef: MutableRefObject<number>;
}) {
  const appliedRouteSelectionKeyRef = useRef<string | null>(null);
  const pendingRouteTurnSelectionRef = useRef<string | null>(null);
  const { routeSearch, selectedSessionId, setFollowThreadOutput, setSelectedSessionId, setSelectedTurnId, thread } =
    input;

  useEffect(() => {
    if (!routeSearch) {
      appliedRouteSelectionKeyRef.current = null;
      pendingRouteTurnSelectionRef.current = null;
      return;
    }
    const params = new URLSearchParams(routeSearch);
    const routeSessionId = params.get("sessionId")?.trim() || "";
    const routeTurnId = params.get("turnId")?.trim() || "";
    if (!routeSessionId) {
      appliedRouteSelectionKeyRef.current = null;
      pendingRouteTurnSelectionRef.current = null;
      return;
    }
    const routeSelectionKey = `${routeSessionId}:${routeTurnId}`;
    if (appliedRouteSelectionKeyRef.current === routeSelectionKey) {
      return;
    }
    appliedRouteSelectionKeyRef.current = routeSelectionKey;
    pendingRouteTurnSelectionRef.current = routeTurnId || null;
    setSelectedSessionId(routeSessionId);
    setSelectedTurnId(routeTurnId || null);
  }, [routeSearch, setSelectedSessionId, setSelectedTurnId]);

  useEffect(() => {
    setSelectedTurnId((current) => {
      const pendingRouteTurnId = pendingRouteTurnSelectionRef.current;
      const nextTurnId = resolveSelectedTurnId(thread, current, pendingRouteTurnId);
      if (thread?.turns.length && pendingRouteTurnId) {
        pendingRouteTurnSelectionRef.current = null;
      }
      return nextTurnId;
    });
  }, [setSelectedTurnId, thread]);

  useEffect(() => {
    setFollowThreadOutput(true);
  }, [selectedSessionId, setFollowThreadOutput]);

  const selectedSession = useMemo(
    () => input.sessions?.find((item) => item.sessionId === input.selectedSessionId) ?? null,
    [input.selectedSessionId, input.sessions],
  );
  const selectedProject = useMemo(
    () => input.projects?.find((item) => item.projectId === selectedSession?.projectId) ?? null,
    [input.projects, selectedSession?.projectId],
  );
  const availableFolders = useMemo(() => {
    const folders = new Map<string, { folderId: string; name: string; count: number }>();
    for (const item of input.sessions ?? []) {
      if (!item.folderId || !item.folderName) {
        continue;
      }
      const current = folders.get(item.folderId);
      folders.set(item.folderId, {
        folderId: item.folderId,
        name: item.folderName,
        count: (current?.count ?? 0) + 1,
      });
    }
    return [...folders.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [input.sessions]);
  const availableTags = useMemo(() => {
    const tags = new Map<string, { tag: string; count: number }>();
    for (const item of input.sessions ?? []) {
      for (const tag of item.tags ?? []) {
        const key = tag.toLowerCase();
        tags.set(key, {
          tag,
          count: (tags.get(key)?.count ?? 0) + 1,
        });
      }
    }
    return [...tags.values()].sort((left, right) => left.tag.localeCompare(right.tag));
  }, [input.sessions]);
  const visibleSessions = useMemo(() => {
    const all = input.sessions ?? [];
    return all.filter((item) => {
      if (!input.showAllModes && (item.mode ?? "chat") !== input.surfaceMode) {
        return false;
      }
      if (input.selectedProjectId !== "all") {
        if (input.selectedProjectId === "none") {
          if (item.projectId) {
            return false;
          }
        } else if (item.projectId !== input.selectedProjectId) {
          return false;
        }
      }
      if (input.selectedFolderId !== "all") {
        if (input.selectedFolderId === "none") {
          if (item.folderId) {
            return false;
          }
        } else if (item.folderId !== input.selectedFolderId) {
          return false;
        }
      }
      if (input.selectedTag) {
        return (item.tags ?? []).some((tag) => tag.toLowerCase() === input.selectedTag?.toLowerCase());
      }
      return true;
    });
  }, [
    input.selectedFolderId,
    input.selectedProjectId,
    input.selectedTag,
    input.sessions,
    input.showAllModes,
    input.surfaceMode,
  ]);

  const missionSessions = useMemo(() => visibleSessions.filter((item) => item.scope === "mission"), [visibleSessions]);
  const externalSessions = useMemo(
    () => visibleSessions.filter((item) => item.scope === "external"),
    [visibleSessions],
  );
  const workspaceMissionSessionCount = useMemo(
    () => missionSessions.filter((item) => item.lifecycleStatus === "active").length,
    [missionSessions],
  );
  const boundMissionSessionCount = useMemo(
    () => (input.sessions ?? []).filter((item) => item.scope === "mission" && Boolean(item.projectId)).length,
    [input.sessions],
  );
  const visibleSessionLabelById = useMemo(
    () => new Map(visibleSessions.map((session) => [session.sessionId, formatSessionLabel(session)])),
    [visibleSessions],
  );
  const messages = useMemo(() => flattenThreadMessages(input.thread), [input.thread]);

  return {
    selectedProjectId: input.selectedProjectId,
    setSelectedProjectId: input.setSelectedProjectId,
    selectedFolderId: input.selectedFolderId,
    setSelectedFolderId: input.setSelectedFolderId,
    selectedTag: input.selectedTag,
    setSelectedTag: input.setSelectedTag,
    historyView: input.historyView,
    setHistoryView: input.setHistoryView,
    selectedSessionId: input.selectedSessionId,
    setSelectedSessionId: input.setSelectedSessionId,
    selectedTurnId: input.selectedTurnId,
    setSelectedTurnId: input.setSelectedTurnId,
    search: input.search,
    setSearch: input.setSearch,
    followThreadOutput: input.followThreadOutput,
    setFollowThreadOutput: input.setFollowThreadOutput,
    selectedSession,
    selectedProject,
    availableFolders,
    availableTags,
    visibleSessions,
    missionSessions,
    externalSessions,
    workspaceMissionSessionCount,
    boundMissionSessionCount,
    visibleSessionLabelById,
    messages,
    applyFetchedThreadRef: input.applyFetchedThreadRef,
    messageMutationVersionRef: input.messageMutationVersionRef,
  };
}
