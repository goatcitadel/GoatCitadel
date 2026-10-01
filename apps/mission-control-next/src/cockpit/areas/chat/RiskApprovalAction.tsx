import { useEffect, useRef, useState } from "react";
import type { ChatPendingApprovalState } from "@goatcitadel/mission-control-shared/components/chat/ChatPendingApprovalPanel";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

const HOLD_MS = 1_000;

export function RiskApprovalAction({ approval, pending, onApprove }: {
  approval: ChatPendingApprovalState;
  pending: boolean;
  onApprove: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const disabled = pending || Boolean(approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now());
  const start = () => {
    if (disabled || timer.current) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      onApprove();
    }, HOLD_MS);
  };

  if (!approval.riskLevel) return <p className="text-xs text-fg-muted">Risk is unavailable. Review the persisted approval before deciding.</p>;
  if (approval.kind === "remote_worker.native_runtime") return <p className="text-xs text-fg-muted">This runtime request needs the native review shown in current approvals.</p>;
  if (approval.riskLevel === "nuclear") return <Button type="button" variant="danger" size="sm" disabled={disabled}
    onPointerDown={start} onPointerUp={clear} onPointerLeave={clear} onPointerCancel={clear}
    onKeyDown={(event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); if (!event.repeat) start(); } }}
    onKeyUp={(event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); clear(); } }}
    onClick={(event) => event.preventDefault()} aria-label="Hold to approve nuclear risk action">
    {holding ? "Keep holding…" : "Hold 1 second to approve once"}
  </Button>;
  if (approval.riskLevel === "danger") return <>
    <Button type="button" variant="danger" size="sm" disabled={disabled} onClick={() => setConfirmOpen(true)}>Review approval</Button>
    <Dialog open={confirmOpen} onOpenChange={setConfirmOpen} title="Confirm danger risk action" description="Approval may change project, account, or external state. Review the persisted record before deciding.">
      <p className="mb-3 whitespace-pre-wrap text-sm text-fg-secondary">{approval.toolName ?? approval.kind ?? "Action request"}{approval.reason ? ` · ${approval.reason}` : ""}</p>
      <div className="flex flex-wrap gap-2"><Button variant="danger" disabled={disabled} onClick={() => { setConfirmOpen(false); onApprove(); }}>Approve once</Button><Button onClick={() => setConfirmOpen(false)}>Cancel</Button></div>
    </Dialog>
  </>;
  return <Button type="button" size="sm" variant="primary" disabled={disabled} onClick={onApprove}>Approve once</Button>;
}
