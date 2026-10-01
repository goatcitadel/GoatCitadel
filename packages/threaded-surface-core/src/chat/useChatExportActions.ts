import { useCallback } from "react";
import type {
  ChatSessionRecord,
  ChatMode,
  ChatSessionPrefsRecord,
  ChatSessionBindingRecord,
  ChatThreadResponse,
  ChatThreadTurnRecord,
} from "@goatcitadel/contracts";
import { fetchRuntimeLifecycleExport } from "@goatcitadel/mission-control-shared/api/client";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";

type Input = {
  selectedSession: ChatSessionRecord | null;
  messageMode: ChatMode;
  prefs: ChatSessionPrefsRecord | null;
  binding: ChatSessionBindingRecord | null;
  thread: ChatThreadResponse | null;
  selectedTurn: ChatThreadTurnRecord | null;
  setUiError: (value: string | null) => void;
  pushLocalNotice: (content: string, tone?: ChatThreadNotice["tone"]) => void;
};

export function useChatExportActions({
  selectedSession,
  messageMode,
  prefs,
  binding,
  thread,
  selectedTurn,
  setUiError,
  pushLocalNotice,
}: Input) {
  const handleExportSessionSnapshot = useCallback(() => {
    if (typeof window === "undefined" || !selectedSession) {
      return;
    }
    const snapshot = {
      exportedAt: new Date().toISOString(),
      session: selectedSession,
      mode: messageMode,
      prefs,
      binding,
      thread,
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(selectedSession.title?.trim() || selectedSession.sessionId).replace(/[^a-z0-9_-]+/gi, "-")}-snapshot.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
    pushLocalNotice("Session snapshot exported locally.", "success");
  }, [binding, messageMode, prefs, pushLocalNotice, selectedSession, thread]);

  const handleExportRunBundle = useCallback(async () => {
    if (typeof window === "undefined" || !selectedSession) {
      return;
    }
    try {
      const bundle = await fetchRuntimeLifecycleExport({
        sessionId: selectedSession.sessionId,
        turnId: selectedTurn?.turnId,
        runId: selectedTurn?.trace.durable?.runId,
        approvalId: selectedTurn?.trace.toolRuns.find((toolRun) => toolRun.approvalId)?.approvalId,
        includeTranscript: true,
        includeTimeline: true,
        timelineLimit: 200,
      });
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${(selectedSession.title?.trim() || selectedSession.sessionId).replace(/[^a-z0-9_-]+/gi, "-")}-${selectedTurn?.turnId ?? "runtime"}-bundle.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      pushLocalNotice("Runtime lifecycle bundle exported locally.", "success");
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Unable to export runtime lifecycle bundle.");
    }
  }, [pushLocalNotice, selectedSession, selectedTurn, setUiError]);

  return { handleExportSessionSnapshot, handleExportRunBundle };
}
