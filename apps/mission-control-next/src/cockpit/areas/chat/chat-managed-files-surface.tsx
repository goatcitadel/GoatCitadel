import { useQueryClient } from "@tanstack/react-query";
import type { ChatApprovalModeState, ChatSessionRecord } from "@goatcitadel/contracts";
import { chatApprovalModeQueryKey } from "@goatcitadel/mission-control-shared/api/chat-managed-files";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { ChatManagedFiles } from "./ChatManagedFiles";

export function useChatApprovalModeIntent(workspaceId: string) {
  const queryClient = useQueryClient();
  return (session: ChatSessionRecord) => {
    if (!session.projectId || session.scope === "external") return undefined;
    const query = queryClient.getQueryState<ChatApprovalModeState>(
      chatApprovalModeQueryKey(workspaceId, session.sessionId, session.projectId),
    );
    const observed = query?.data;
    if (!observed?.autoAvailable || observed.projectId !== session.projectId || observed.workspaceId !== workspaceId) {
      return undefined;
    }
    return {
      mode: observed.mode,
      modeRevision: observed.modeRevision,
      uncertain: observed.mode === "auto" && query?.status === "error",
    };
  };
}

export function ChatManagedFilesSlot({
  active,
  selectedSessionId,
  session,
  workspaceId,
  latestTurnId,
}: {
  active: MissionThreadedActiveSessionSurfaceProps | null;
  selectedSessionId: string | undefined;
  session: ChatSessionRecord | undefined;
  workspaceId: string;
  latestTurnId: string | undefined;
}) {
  if (
    !active ||
    !selectedSessionId ||
    active.selectedSessionId !== selectedSessionId ||
    !session?.projectId ||
    session.scope === "external"
  )
    return null;
  return (
    <ChatManagedFiles
      sessionId={selectedSessionId}
      workspaceId={workspaceId}
      projectId={session.projectId}
      projectName={session.projectName}
      turnId={latestTurnId}
      turnActive={active.sending || active.hasActiveStream}
      canMutate={!active.historicalReadOnly}
      sendError={active.streamError}
    />
  );
}
