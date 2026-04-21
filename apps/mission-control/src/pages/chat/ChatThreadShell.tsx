import type { ChatMode, ChatThreadResponse } from "@goatcitadel/contracts";
import {
  ChatPendingApprovalPanel,
  type ChatPendingApprovalState,
} from "../../components/chat/ChatPendingApprovalPanel";
import { ChatPendingUserInputPanel } from "../../components/chat/ChatPendingUserInputPanel";
import { SurfaceReconnectBanner } from "../../components/chat/SurfaceReconnectBanner";
import { ChatThreadView, type ChatThreadNotice } from "../../components/chat/ChatThreadView";
import type { ChatStreamStatus } from "../../components/chat/ChatStreamStatusBar";
import type { EventStreamStatus } from "../../api/shell-client";
import type { ActiveChatDelegationRun } from "./useChatDelegationPolicyActions";
import type { PendingUserInputState } from "./useChatOutboundExecution";

export function ChatThreadShell(props: {
  mode: ChatMode;
  loading: boolean;
  thread: ChatThreadResponse | null;
  selectedTurnId: string | null;
  delegationRun: ActiveChatDelegationRun | null;
  notices: ChatThreadNotice[];
  followOutput: boolean;
  streamStatus: ChatStreamStatus;
  queuedCount: number;
  streamError: string | null;
  pendingApproval: ChatPendingApprovalState | null;
  pendingUserInput: PendingUserInputState | null;
  workspaceId?: string;
  approvalPending: boolean;
  userInputPending: boolean;
  eventStreamStatus: EventStreamStatus;
  onBottomStateChange: (atBottom: boolean) => void;
  onSelectTurn: (turnId: string | null) => void;
  onSwitchBranch: (turnId: string) => void;
  onRetryTurn: (turnId: string) => void;
  onEditTurn: (turnId: string) => void;
  onOpenRunDetails: (turnId: string) => void;
  onOpenGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifactVersion: (turnId: string) => void;
  onApprovePending: (allowScope: "once" | "session" | "workspace") => void;
  onDenyPending: () => void;
  onSubmitUserInput: (response: { kind: "single_select"; optionId: string } | { kind: "text"; text: string }) => void;
  onRefresh: () => void;
}) {
  const {
    mode,
    loading,
    thread,
    selectedTurnId,
    delegationRun,
    notices,
    followOutput,
    streamStatus,
    queuedCount,
    streamError,
    pendingApproval,
    pendingUserInput,
    workspaceId,
    approvalPending,
    userInputPending,
    eventStreamStatus,
    onBottomStateChange,
    onSelectTurn,
    onSwitchBranch,
    onRetryTurn,
    onEditTurn,
    onOpenRunDetails,
    onOpenGeneratedArtifact,
    onCreateGeneratedArtifactVersion,
    onApprovePending,
    onDenyPending,
    onSubmitUserInput,
    onRefresh,
  } = props;

  return (
    <div className={`chat-v11-thread-shell mode-${mode}`}>
      <div className="chat-v11-thread-status-lane">
        <SurfaceReconnectBanner mode={mode} status={eventStreamStatus} onRefresh={onRefresh} />
      </div>

      <div className="chat-v11-thread-scroll">
        <ChatThreadView
          mode={mode}
          loading={loading}
          thread={thread}
          selectedTurnId={selectedTurnId}
          delegationRun={delegationRun}
          notices={notices}
          followOutput={followOutput}
          streamStatus={streamStatus}
          queuedCount={queuedCount}
          streamError={streamError}
          onBottomStateChange={onBottomStateChange}
          onSelectTurn={onSelectTurn}
          onSwitchBranch={onSwitchBranch}
          onRetryTurn={onRetryTurn}
          onEditTurn={onEditTurn}
          onOpenRunDetails={onOpenRunDetails}
          onOpenGeneratedArtifact={onOpenGeneratedArtifact}
          onCreateGeneratedArtifactVersion={onCreateGeneratedArtifactVersion}
        />
      </div>

      {pendingApproval ? (
        <ChatPendingApprovalPanel
          pendingApproval={pendingApproval}
          workspaceId={workspaceId}
          pending={approvalPending}
          onApprove={onApprovePending}
          onDeny={onDenyPending}
        />
      ) : (
        <ChatPendingUserInputPanel
          pendingUserInput={pendingUserInput}
          pending={userInputPending}
          onSubmit={onSubmitUserInput}
        />
      )}
    </div>
  );
}
