import { approvalTargetLine } from "@goatcitadel/contracts/approval-target";

export function ChatApprovalTarget({ kind, preview }: { kind?: string; preview: Record<string, unknown> }) {
  const target = approvalTargetLine(kind, preview);
  return target ? <p className="mt-1 text-xs text-fg-secondary wrap-anywhere">{target}</p> : null;
}
