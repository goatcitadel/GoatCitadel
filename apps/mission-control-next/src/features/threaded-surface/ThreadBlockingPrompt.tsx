import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import {
  ChatPendingApprovalPanel,
  type ChatPendingApprovalState,
} from "@goatcitadel/mission-control-shared/components/chat/ChatPendingApprovalPanel";
import { ChatPendingUserInputPanel } from "@goatcitadel/mission-control-shared/components/chat/ChatPendingUserInputPanel";

/** Keep durable decisions beside the turn that is waiting for them. */
export function ThreadBlockingPrompt({ props }: { props: MissionThreadedActiveSessionSurfaceProps }) {
  const pendingApproval = props.pendingApproval as ChatPendingApprovalState | null;
  if (pendingApproval) {
    return (
      <div className="mc-next-thread-blocking-prompt" data-blocker-kind="approval">
        <ChatPendingApprovalPanel
          pendingApproval={pendingApproval}
          workspaceId={props.workspaceId}
          approvalsHref={`/ops/approvals?approvalId=${encodeURIComponent(pendingApproval.approvalId)}`}
          pending={props.approvalPending}
          variant="compact"
          onApprove={props.onApprovePending}
          onDeny={props.onDenyPending}
        />
      </div>
    );
  }

  if (props.pendingUserInput) {
    return (
      <div className="mc-next-thread-blocking-prompt" data-blocker-kind="user-input">
        <ChatPendingUserInputPanel
          pendingUserInput={props.pendingUserInput}
          pending={props.userInputPending}
          variant="compact"
          onSubmit={props.onSubmitUserInput}
        />
      </div>
    );
  }
  return null;
}
