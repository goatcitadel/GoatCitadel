import { useId, useState } from "react";
import type { ChangePlanRecord, ChangePlanRequiredAction } from "@goatcitadel/contracts";

const TERMINAL_CHANGE_PLAN_STATUSES = new Set<ChangePlanRecord["status"]>([
  "completed",
  "applied",
  "manual_required",
  "failed",
  "cancelled",
  "rolled_back",
  "rollback_failed",
]);

function formatKind(kind: ChangePlanRecord["kind"]): string {
  switch (kind) {
    case "session_model":
      return "This chat";
    case "installation_default_model":
      return "Future chats";
    case "provider_connection":
      return "Provider connection";
    case "runtime_configuration":
      return "Runtime configuration";
    case "channel_connection":
      return "Channel connection";
    case "runtime_remediation":
      return "Runtime repair";
    case "capability_candidate":
      return "Capability candidate";
    case "improvement_candidate":
      return "Improvement";
    case "managed_source_registration":
      return "Managed source install";
    case "product_source_update":
      return "GoatCitadel source";
  }

  return "Change";
}

function formatStatus(status: ChangePlanRecord["status"]): string {
  return status.replaceAll("_", " ");
}

export interface ChatChangePlanCardProps {
  readonly plan: ChangePlanRecord;
  readonly onReview?: (plan: ChangePlanRecord) => void;
  readonly onCancel?: (plan: ChangePlanRecord) => void;
  readonly onMakeDefault?: (plan: ChangePlanRecord) => void;
  /**
   * A presentation-only acknowledgement for terminal receipts. Callers may
   * persist this locally by plan ID/revision/status; it never changes the
   * Gateway-owned plan or its evidence.
   */
  readonly onDismiss?: (plan: ChangePlanRecord) => void;
  /** Called when an operator opens the compact receipt's details. */
  readonly onOpenDetails?: (plan: ChangePlanRecord) => void;
  /** Allows a host-owned local dismissal store to keep a terminal receipt hidden. */
  readonly dismissed?: boolean;
  readonly pending?: boolean;
}

/**
 * A compact, transcript-adjacent receipt for a Gateway-owned change plan.
 * It deliberately renders only the sanitized plan envelope; credentials,
 * OAuth values, source paths, patches, and shell commands have no rendering
 * path through this component.
 */
export function ChatChangePlanCard(props: ChatChangePlanCardProps) {
  const identity = `${props.plan.planId}:${props.plan.revision}:${props.plan.status}`;
  return <ChatChangePlanCardContents key={identity} {...props} />;
}

function ChatChangePlanCardContents({
  plan,
  onReview,
  onCancel,
  onMakeDefault,
  onDismiss,
  onOpenDetails,
  dismissed = false,
  pending = false,
}: ChatChangePlanCardProps) {
  const actionable = ["awaiting_input", "awaiting_confirmation", "awaiting_approval"].includes(plan.status);
  const terminal = plan.phase === "terminal" || TERMINAL_CHANGE_PLAN_STATUSES.has(plan.status);
  const evidenceRefs = [...new Set([...(plan.evidenceRefs ?? []), ...(plan.result?.evidenceRefs ?? [])])];
  const evidence = evidenceRefs.length ? evidenceRefs.join(", ") : null;
  const actionLabel = plan.requiredAction ? requiredActionLabel(plan.requiredAction.kind) : "Continue";
  const detailId = useId();
  const moreOptionsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [moreOptionsOpen, setMoreOptionsOpen] = useState(false);
  const [locallyDismissedKey, setLocallyDismissedKey] = useState<string | null>(null);
  const dismissalKey = `${plan.planId}:${plan.revision}:${plan.status}`;
  const hasSecondaryActions =
    actionable && Boolean(onCancel || (plan.request.kind === "session_model" && onMakeDefault));
  const isDismissed = terminal && (dismissed || locallyDismissedKey === dismissalKey);

  if (isDismissed) {
    return null;
  }

  const toggleDetails = () => {
    const nextOpen = !detailsOpen;
    setDetailsOpen(nextOpen);
    if (nextOpen) {
      onOpenDetails?.(plan);
    }
  };

  const dismiss = () => {
    setLocallyDismissedKey(dismissalKey);
    onDismiss?.(plan);
  };

  if (terminal) {
    return (
      <aside
        className="chat-change-plan-card chat-change-plan-card--terminal"
        aria-label={`Change plan receipt: ${plan.title}`}
        data-status={plan.status}
      >
        <div className="chat-change-plan-receipt">
          <p className="chat-change-plan-receipt-title">
            <strong>{terminalReceiptTitle(plan)}</strong>
            <span>{formatStatus(plan.status)}</span>
          </p>
          <div className="chat-change-plan-receipt-actions">
            <button type="button" aria-expanded={detailsOpen} aria-controls={detailId} onClick={toggleDetails}>
              Details
            </button>
            <button type="button" onClick={dismiss}>
              Dismiss
            </button>
          </div>
        </div>
        <ChangePlanDetails plan={plan} evidence={evidence} id={detailId} hidden={!detailsOpen} />
      </aside>
    );
  }

  return (
    <aside className="chat-change-plan-card" aria-label={`Change plan: ${plan.title}`} data-status={plan.status}>
      <header className="chat-change-plan-header">
        <strong>{plan.title}</strong>
        <span>{formatStatus(plan.status)}</span>
      </header>
      <p className="chat-change-plan-summary">{plan.summary}</p>
      <div className="chat-change-plan-actions">
        {actionable ? (
          <>
            <button type="button" onClick={() => onReview?.(plan)} disabled={!onReview || pending}>
              {actionLabel}
            </button>
            {hasSecondaryActions ? (
              <button
                type="button"
                aria-expanded={moreOptionsOpen}
                aria-controls={moreOptionsId}
                onClick={() => setMoreOptionsOpen((open) => !open)}
                disabled={pending}
              >
                More
              </button>
            ) : null}
          </>
        ) : null}
        <button type="button" aria-expanded={detailsOpen} aria-controls={detailId} onClick={toggleDetails}>
          Details
        </button>
      </div>
      <ChangePlanDetails plan={plan} evidence={evidence} id={detailId} hidden={!detailsOpen} />
      {hasSecondaryActions ? (
        <div className="chat-change-plan-secondary-actions" id={moreOptionsId} hidden={!moreOptionsOpen}>
          {onCancel ? (
            <button type="button" onClick={() => onCancel(plan)} disabled={pending}>
              Cancel plan
            </button>
          ) : null}
          {plan.request.kind === "session_model" && onMakeDefault ? (
            <button type="button" onClick={() => onMakeDefault(plan)} disabled={pending}>
              Make this my default
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function ChangePlanDetails({
  plan,
  evidence,
  id,
  hidden,
}: {
  readonly plan: ChangePlanRecord;
  readonly evidence: string | null;
  readonly id: string;
  readonly hidden: boolean;
}) {
  return (
    <div className="chat-change-plan-details" id={id} hidden={hidden}>
      <dl>
        <div>
          <dt>Scope</dt>
          <dd>{formatKind(plan.kind)}</dd>
        </div>
        <div>
          <dt>Plan revision</dt>
          <dd>{plan.revision}</dd>
        </div>
        <div>
          <dt>Risk</dt>
          <dd>{plan.risk}</dd>
        </div>
        {plan.request.kind === "session_model" ? (
          <div>
            <dt>Model</dt>
            <dd>{[plan.request.providerId, plan.request.model].filter(Boolean).join(" / ") || "Current selection"}</dd>
          </div>
        ) : null}
        {plan.request.kind === "session_model" && plan.request.thinkingLevel ? (
          <div>
            <dt>Effort</dt>
            <dd>{plan.request.thinkingLevel}</dd>
          </div>
        ) : null}
      </dl>
      <p className="chat-change-plan-impact">Impact: {plan.impact}</p>
      {plan.result?.summary ? <p className="chat-change-plan-result">{plan.result.summary}</p> : null}
      {evidence ? <p className="chat-change-plan-evidence">Evidence: {evidence}</p> : null}
    </div>
  );
}

function terminalReceiptTitle(plan: ChangePlanRecord): string {
  const model = plan.request.kind === "session_model" ? plan.request.model : undefined;

  switch (plan.status) {
    case "completed":
    case "applied":
      return model ? `Model changed to ${model}` : plan.result?.summary || plan.title;
    case "manual_required":
      return `${plan.title} needs your attention`;
    case "failed":
      return `${plan.title} could not be completed`;
    case "cancelled":
      return `${plan.title} was cancelled`;
    case "rolled_back":
      return `${plan.title} was rolled back`;
    case "rollback_failed":
      return `${plan.title} could not be rolled back`;
    default:
      return plan.result?.summary || plan.title;
  }
}

function requiredActionLabel(kind: ChangePlanRequiredAction["kind"] | undefined): string {
  switch (kind) {
    case "public_form":
      return "Provide details";
    case "secure_input":
      return "Open secure input";
    case "oauth":
      return "Continue to OAuth";
    case "native_path_picker":
      return "Choose source install";
    case "approval":
      return "Review approval";
    case "artifact_review":
      return "Review artifacts";
    case "confirmation":
      return "Review and confirm";
    default:
      return "Continue";
  }
}
