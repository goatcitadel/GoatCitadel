import type { ChangePlanRecord } from "@goatcitadel/contracts";
import type { DraftControls } from "./ChatExpiredApprovalRecovery";
import { ChatExpiredApprovalRecoveryControl } from "./ChatExpiredApprovalRecoveryControl";

/** A failed setup receipt is not a pending tool approval. Its exact saved
 * approval still goes through the same read-only inspection and renewal owner. */
export function ChatChangePlanRecovery({
  plan,
  sessionId,
  pendingApprovalId,
  draftControls,
  onUpdated,
}: {
  plan: ChangePlanRecord;
  sessionId?: string;
  pendingApprovalId?: string;
  draftControls: DraftControls;
  onUpdated: () => void;
}) {
  const approvalId = plan.approvalRefs?.at(-1);
  if (
    plan.kind !== "runtime_configuration" ||
    !["failed", "cancelled", "manual_required"].includes(plan.status) ||
    !approvalId ||
    !plan.origin?.workspaceId ||
    approvalId === pendingApprovalId ||
    !sessionId ||
    plan.origin?.sessionId !== sessionId
  ) return null;
  return (
    <ChatExpiredApprovalRecoveryControl
      props={draftControls}
      sessionId={sessionId}
      workspaceId={plan.origin.workspaceId}
      approvalId={approvalId}
      turnId={plan.origin.turnId}
      showExpiredNotice={false}
      onUpdated={onUpdated}
    />
  );
}
