import { InlineApprovalPrompt } from "../InlineApprovalPrompt";

export interface ChatPendingApprovalState {
  approvalId: string;
  kind?: string;
  toolName?: string;
  reason?: string;
  riskLevel?: "safe" | "caution" | "danger" | "nuclear";
  expiresAt?: string;
  codeHash?: string;
  wrapperManifestHash?: string;
  capabilitySnapshotId?: string;
  inspectPath?: string;
  requestedOutputIntent?: string;
  saveCandidateOnSuccess?: boolean;
  remainingCount?: number;
  affectedResources?: string[];
  codePreview?: string;
}

export function ChatPendingApprovalPanel(props: {
  pendingApproval: ChatPendingApprovalState | null;
  workspaceId?: string;
  pending: boolean;
  onApprove: (allowScope: "once" | "session" | "workspace") => void;
  onDeny: () => void;
}) {
  const { pendingApproval, workspaceId, pending, onApprove, onDeny } = props;
  if (!pendingApproval) {
    return null;
  }
  return (
    <InlineApprovalPrompt
      approvalId={pendingApproval.approvalId}
      kind={pendingApproval.kind}
      toolName={pendingApproval.toolName}
      reason={pendingApproval.reason}
      riskLevel={pendingApproval.riskLevel}
      expiresAt={pendingApproval.expiresAt}
      codeHash={pendingApproval.codeHash}
      wrapperManifestHash={pendingApproval.wrapperManifestHash}
      capabilitySnapshotId={pendingApproval.capabilitySnapshotId}
      inspectPath={pendingApproval.inspectPath}
      requestedOutputIntent={pendingApproval.requestedOutputIntent}
      saveCandidateOnSuccess={pendingApproval.saveCandidateOnSuccess}
      remainingCount={pendingApproval.remainingCount}
      affectedResources={pendingApproval.affectedResources}
      codePreview={pendingApproval.codePreview}
      pending={pending}
      approvalsHref={`?space=operate&page=approvals&approvalId=${encodeURIComponent(pendingApproval.approvalId)}`}
      workspaceAllowAvailable={Boolean(workspaceId?.trim())}
      onApproveOnce={() => onApprove("once")}
      onApproveInSession={() => onApprove("session")}
      onApproveInWorkspace={() => onApprove("workspace")}
      onDeny={onDeny}
    />
  );
}
