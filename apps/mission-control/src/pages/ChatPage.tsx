import { type ComponentProps, type ReactNode } from "react";
import type { ChatMode } from "@goatcitadel/contracts";
import {
  MissionThreadedControllerHost,
  formatSessionLabel,
  getCapabilitySuggestionConfirmationCopy,
  getDeleteSessionConfirmationMessage,
  looksMachineSessionLabel,
  revealGeneratedArtifactInSurface,
  resolveSelectedTurnId,
  resolveChatRefreshPlan,
  resolveOptimisticChatPrefs,
  shouldApplyFetchedMessagesAfterStream,
  shouldExecuteLocalChatCommand,
  shouldShowLearnedMemoryPanel,
  shouldShowSuggestionsPanel,
  shouldShowTracePanel,
  type MissionThreadedEmptyStateProps,
  type MissionThreadedRenderSurfaceInput,
  type MissionThreadedSessionRailData,
  type MissionThreadedWorkflowPanel,
} from "@goatcitadel/threaded-surface-core";
import { ChatContextDockPanels } from "./chat/ChatContextDockPanels";
import { ChatSurfaceLayout } from "./chat/ChatSurfaceLayout";
import { ChatSessionSidebar } from "./chat/ChatSessionSidebar";
import { MissionControlActiveSessionSurface } from "./chat/MissionControlActiveSessionSurface";
import type { MissionControlActiveSessionSurfaceProps as LegacyMissionControlActiveSessionSurfaceProps } from "./chat/MissionControlActiveSessionSurface";
import { MissionControlEmptyState } from "./chat/MissionControlEmptyState";
import { ChatWorkSurface, CodeWorkSurface, CoworkWorkSurface } from "./chat/MissionControlWorkSurfaces";
import "../styles/chat.css";
import "../styles/chat-motion.css";
import "../styles/chat-surface.css";

export {
  formatSessionLabel,
  getCapabilitySuggestionConfirmationCopy,
  getDeleteSessionConfirmationMessage,
  looksMachineSessionLabel,
  revealGeneratedArtifactInSurface,
  resolveSelectedTurnId,
  resolveChatRefreshPlan,
  resolveOptimisticChatPrefs,
  shouldApplyFetchedMessagesAfterStream,
  shouldExecuteLocalChatCommand,
  shouldShowLearnedMemoryPanel,
  shouldShowSuggestionsPanel,
  shouldShowTracePanel,
};

export type ChatPageSessionRailData = MissionThreadedSessionRailData;
export type ChatPageWorkflowPanel = MissionThreadedWorkflowPanel;
export type ChatPageRenderSurfaceInput = MissionThreadedRenderSurfaceInput;

type MissionThreadedHostProps = Omit<ComponentProps<typeof MissionThreadedControllerHost>, "renderSurface">;

export function ChatPage({
  renderSurface,
  ...props
}: MissionThreadedHostProps & { renderSurface?: (input: ChatPageRenderSurfaceInput) => ReactNode }) {
  return (
    <MissionThreadedControllerHost
      {...props}
      renderSurface={(input) => (renderSurface ? renderSurface(input) : renderLegacySurface(input))}
    />
  );
}

function renderLegacySurface(input: ChatPageRenderSurfaceInput): ReactNode {
  const hasActiveSession = Boolean(input.activeSessionSurfaceProps);
  const sessionRail = <ChatSessionSidebar {...input.sessionRail} />;
  const primaryColumn = input.activeSessionSurfaceProps ? (
    <MissionControlActiveSessionSurface
      {...(input.activeSessionSurfaceProps as unknown as LegacyMissionControlActiveSessionSurfaceProps)}
    />
  ) : (
    <MissionControlEmptyState {...(input.emptyStateProps as MissionThreadedEmptyStateProps)} />
  );
  const contextDock = input.contextDockProps ? <ChatContextDockPanels {...input.contextDockProps} /> : <></>;
  const baseProps = {
    mode: input.messageMode,
    sessionRail,
    primaryColumn,
    contextDock,
    dockOpen: hasActiveSession ? input.dockOpen : false,
    onDockOpenChange: input.onDockOpenChange,
    hasActiveSession,
    sessionRailOpen: input.sessionRailOpen,
    onSessionRailOpenChange: input.onSessionRailOpenChange,
  };

  if (hasActiveSession && input.workflowPanel?.kind === "cowork") {
    return <CoworkWorkSurface {...baseProps} coworkPanel={input.workflowPanel.props} />;
  }

  if (hasActiveSession && input.workflowPanel?.kind === "code") {
    return <CodeWorkSurface {...baseProps} codePanel={input.workflowPanel.props} />;
  }

  if (input.messageMode === "cowork" || input.messageMode === "code") {
    return (
      <ChatSurfaceLayout
        mode={input.messageMode as ChatMode}
        sessionRail={sessionRail}
        primaryColumn={null}
        workflowColumn={primaryColumn}
        contextDock={contextDock}
        dockOpen={false}
        onDockOpenChange={input.onDockOpenChange}
        hasActiveSession={hasActiveSession}
        sessionRailOpen={input.sessionRailOpen}
        onSessionRailOpenChange={input.onSessionRailOpenChange}
      />
    );
  }

  return <ChatWorkSurface {...baseProps} />;
}
