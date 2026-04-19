import type { ChatMode, ChatThreadResponse } from "@goatcitadel/contracts";
import {
  ChatPendingApprovalPanel,
  type ChatPendingApprovalState,
} from "../../components/chat/ChatPendingApprovalPanel";
import { SurfaceReconnectBanner } from "../../components/chat/SurfaceReconnectBanner";
import { ChatThreadView, type ChatThreadNotice } from "../../components/chat/ChatThreadView";
import type { ChatStreamStatus } from "../../components/chat/ChatStreamStatusBar";
import type { EventStreamStatus } from "../../api/shell-client";
import type { ActiveChatDelegationRun } from "./useChatDelegationPolicyActions";

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
  workspaceId?: string;
  approvalPending: boolean;
  eventStreamStatus: EventStreamStatus;
  onBottomStateChange: (atBottom: boolean) => void;
  onSelectTurn: (turnId: string | null) => void;
  onSwitchBranch: (turnId: string) => void;
  onRetryTurn: (turnId: string) => void;
  onEditTurn: (turnId: string) => void;
  onOpenRunDetails: (turnId: string) => void;
  onApprovePending: (allowScope: "once" | "session" | "workspace") => void;
  onDenyPending: () => void;
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
    workspaceId,
    approvalPending,
    eventStreamStatus,
    onBottomStateChange,
    onSelectTurn,
    onSwitchBranch,
    onRetryTurn,
    onEditTurn,
    onOpenRunDetails,
    onApprovePending,
    onDenyPending,
    onRefresh,
  } = props;

  return (
    <div className={`chat-v11-thread-shell mode-${mode}`}>
      <div className="chat-v11-thread-status-lane">
        <SurfaceReconnectBanner status={eventStreamStatus} onRefresh={onRefresh} />
      </div>

      <div className="chat-v11-thread-scroll">
        <ChatThreadView
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
        />
      </div>

      <ChatPendingApprovalPanel
        pendingApproval={pendingApproval}
        workspaceId={workspaceId}
        pending={approvalPending}
        onApprove={onApprovePending}
        onDeny={onDenyPending}
      />
    </div>
  );
}
