import { useEffect, useRef } from "react";
import { ChatChangePlanCard, type ChatChangePlanCardProps } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanCard";
import type { DraftControls } from "./ChatExpiredApprovalRecovery";
import { ChatChangePlanRecovery } from "./ChatChangePlanRecovery";

/** Keep focus across a canonical receipt replacement, including when a fresh
 * plan removes the old recovery component altogether. */
export function ChatChangePlanReceipt({ receipt, sessionId, pendingApprovalId, draftControls, onUpdated }: {
  receipt: ChatChangePlanCardProps;
  sessionId?: string;
  pendingApprovalId?: string;
  draftControls: DraftControls;
  onUpdated: () => void;
}) {
  const element = useRef<HTMLDivElement>(null), focusWithin = useRef(false);
  const scope = JSON.stringify([receipt.plan.origin?.workspaceId ?? null, sessionId]);
  const previousScope = useRef(scope);
  useEffect(() => {
    if (previousScope.current !== scope) {
      previousScope.current = scope;
      focusWithin.current = false;
      return;
    }
    if (!focusWithin.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) {
      if (!element.current?.contains(active)) focusWithin.current = false;
      return;
    }
    const target = element.current?.querySelector<HTMLButtonElement>("button:not([disabled])") ?? element.current;
    target?.focus({ preventScroll: true });
  }, [scope, receipt.plan.planId, receipt.plan.revision, receipt.plan.status]);
  return (
    <div
      ref={element}
      className="min-w-0 outline-none"
      role="group"
      aria-label="Setup review"
      tabIndex={-1}
      onFocusCapture={() => { focusWithin.current = true; }}
      onBlurCapture={event => {
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) focusWithin.current = false;
      }}
    >
      <ChatChangePlanCard {...receipt} />
      <ChatChangePlanRecovery plan={receipt.plan} sessionId={sessionId} pendingApprovalId={pendingApprovalId} draftControls={draftControls} onUpdated={onUpdated} />
    </div>
  );
}
