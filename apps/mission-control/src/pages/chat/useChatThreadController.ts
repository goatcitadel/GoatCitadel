import type { ChatSessionRecord, ChatThreadResponse } from "@goatcitadel/contracts";
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
  routeSearch: string;
  sessions?: SessionListItem[];
  projects?: ProjectListItem[];
  thread: ChatThreadResponse | null;
  selectedProjectId: string;
  setSelectedProjectId: Dispatch<SetStateAction<string>>;
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

  useEffect(() => {
    if (!input.routeSearch) {
      appliedRouteSelectionKeyRef.current = null;
      pendingRouteTurnSelectionRef.current = null;
      return;
    }
    const params = new URLSearchParams(input.routeSearch);
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
    if (!(input.sessions ?? []).some((item) => item.sessionId === routeSessionId)) {
      return;
    }
    appliedRouteSelectionKeyRef.current = routeSelectionKey;
    pendingRouteTurnSelectionRef.current = routeTurnId || null;
    input.setSelectedSessionId(routeSessionId);
    input.setSelectedTurnId(routeTurnId || null);
  }, [input.routeSearch, input.sessions, input.setSelectedSessionId, input.setSelectedTurnId]);

  useEffect(() => {
    input.setSelectedTurnId((current) => {
      const pendingRouteTurnId = pendingRouteTurnSelectionRef.current;
      const nextTurnId = resolveSelectedTurnId(input.thread, current, pendingRouteTurnId);
      if (input.thread?.turns.length && pendingRouteTurnId) {
        pendingRouteTurnSelectionRef.current = null;
      }
      return nextTurnId;
    });
  }, [input.setSelectedTurnId, input.thread]);

  useEffect(() => {
    input.setFollowThreadOutput(true);
  }, [input.selectedSessionId, input.setFollowThreadOutput]);

  const selectedSession = useMemo(
    () => input.sessions?.find((item) => item.sessionId === input.selectedSessionId) ?? null,
    [input.selectedSessionId, input.sessions],
  );
  const selectedProject = useMemo(
    () => input.projects?.find((item) => item.projectId === selectedSession?.projectId) ?? null,
    [input.projects, selectedSession?.projectId],
  );
  const visibleSessions = useMemo(() => {
    const all = input.sessions ?? [];
    const q = input.search.trim().toLowerCase();
    return all.filter((item) => {
      if (input.selectedProjectId !== "all") {
        if (input.selectedProjectId === "none") {
          if (item.projectId) {
            return false;
          }
        } else if (item.projectId !== input.selectedProjectId) {
          return false;
        }
      }
      if (!q) {
        return true;
      }
      const haystack = [item.title, item.sessionKey, item.projectName, item.channel, item.account]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [input.search, input.selectedProjectId, input.sessions]);

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
