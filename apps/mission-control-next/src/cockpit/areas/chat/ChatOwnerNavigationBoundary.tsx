import { useLayoutEffect, type ReactNode } from "react";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { useChatSelectionReview, type useChatOwnerNavigation } from "./use-chat-owner-navigation";

export function ChatOwnerNavigationBoundary({ input, owner, children }: {
  input: MissionThreadedRenderSurfaceInput;
  owner: ReturnType<typeof useChatOwnerNavigation>;
  children: (input: MissionThreadedRenderSurfaceInput) => ReactNode;
}) {
  const active = input.activeSessionSurfaceProps;
  const identity = JSON.stringify([input.sessionRail.selectedSessionId, active?.workspaceId,
    active?.selectedTurnId, active?.activeGeneratedArtifact?.artifactId]);
  const review = useChatSelectionReview(identity);
  useLayoutEffect(() => {
    owner.publish({ selectedSessionId: input.sessionRail.selectedSessionId,
      sessions: [...input.sessionRail.missionSessions, ...input.sessionRail.externalSessions], active });
  }, [active, input.sessionRail, owner]);
  const onCreateSession = () => review(input.sessionRail.onCreateSession);
  return children({
    ...input,
    activeSessionSurfaceProps: active ? { ...active, onReturnToLatest: () => {
      active.onReturnToLatest();
      owner.request("chat", { sessionId: active.selectedSessionId, turnId: null, artifactId: null });
    } } : null,
    sessionRail: {
      ...input.sessionRail,
      onCreateSession,
      onSelectSession: (sessionId, options) => review(() => input.sessionRail.onSelectSession(sessionId, options)),
    },
    emptyStateProps: { ...input.emptyStateProps, onCreateSession },
  });
}
