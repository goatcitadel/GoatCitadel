import { InlineApprovalPrompt } from "../InlineApprovalPrompt";

export interface ChatPendingApprovalState {
  approvalId: string;
  toolName?: string;
  reason?: string;
  expiresAt?: string;
}

export function ChatPendingApprovalPanel(props: {
  pendingApproval: ChatPendingApprovalState | null;
  pending: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const { pendingApproval, pending, onApprove, onDeny } = props;
  if (!pendingApproval) {
    return null;
  }
  return (
    <InlineApprovalPrompt
      approvalId={pendingApproval.approvalId}
      toolName={pendingApproval.toolName}
      reason={pendingApproval.reason}
      expiresAt={pendingApproval.expiresAt}
      pending={pending}
      onApprove={onApprove}
      onDeny={onDeny}
    />
  );
}
