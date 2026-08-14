import type { ChangePlanRecord, ChangePlanRequiredAction } from "@goatcitadel/contracts";

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
  readonly pending?: boolean;
}

/**
 * A compact, transcript-adjacent receipt for a Gateway-owned change plan.
 * It deliberately renders only the sanitized plan envelope; credentials,
 * OAuth values, source paths, patches, and shell commands have no rendering
 * path through this component.
 */
export function ChatChangePlanCard({
  plan,
  onReview,
  onCancel,
  onMakeDefault,
  pending = false,
}: ChatChangePlanCardProps) {
  const actionable = ["awaiting_input", "awaiting_confirmation", "awaiting_approval"].includes(plan.status);
  const evidenceRefs = [...new Set([...(plan.evidenceRefs ?? []), ...(plan.result?.evidenceRefs ?? [])])];
  const evidence = evidenceRefs.length ? evidenceRefs.join(", ") : null;
  const actionLabel = plan.requiredAction ? requiredActionLabel(plan.requiredAction.kind) : "Continue";

  return (
    <aside className="chat-change-plan-card" aria-label={`Change plan: ${plan.title}`} data-status={plan.status}>
      <header>
        <strong>{plan.title}</strong>
        <span>{formatStatus(plan.status)}</span>
      </header>
      <p>{plan.summary}</p>
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
      {actionable ? (
        <div className="chat-change-plan-actions">
          <button type="button" onClick={() => onReview?.(plan)} disabled={!onReview || pending}>
            {actionLabel}
          </button>
          <button type="button" onClick={() => onCancel?.(plan)} disabled={!onCancel || pending}>
            Cancel plan
          </button>
          {plan.request.kind === "session_model" ? (
            <button type="button" onClick={() => onMakeDefault?.(plan)} disabled={!onMakeDefault || pending}>
              Make this my default
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
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
