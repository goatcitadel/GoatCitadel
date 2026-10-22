import type { ApprovalRequest } from "@goatcitadel/contracts";
import { buildApprovalRequestReviewEvidenceModel } from "@goatcitadel/mission-control-shared/content/approval-helpers";
// Tool names and approval kinds are open strings; the chat presenter names the known ones.
import { presentApprovalAction } from "../chat/chat-vocabulary";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useWorkspaceNameLookup } from "../../data/use-workspace-name";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
/** `showExpiry={false}` when the surrounding view already states the expiry once (IN-R04). */
export function ApprovalReviewSummary({
  approval,
  workspaceId,
  showExpiry = true,
}: {
  approval: ApprovalRequest;
  workspaceId: string;
  showExpiry?: boolean;
}) {
  const evidence = buildApprovalRequestReviewEvidenceModel(approval);
  const { activeCitadelId } = useUiPreferences();
  const workspaceName = useWorkspaceNameLookup(activeCitadelId);
  const scopeWorkspaceId = approval.linkage?.workspaceId ?? workspaceId;
  const sessionId = approval.linkage?.sessionId;
  const workspaceLabel =
    workspaceName(scopeWorkspaceId) ?? (scopeWorkspaceId === workspaceId ? "This workspace" : "Another workspace");
  const scope = evidence?.scopeSummary ?? `${workspaceLabel}${sessionId ? " · one linked conversation" : ""}.`;
  return (
    <section
      aria-label="Approval scope and consequences"
      className="min-w-0 max-w-full space-y-2 wrap-anywhere text-sm text-fg-secondary"
    >
      <p>
        <strong>Action:</strong> {presentApprovalAction(approval.linkage?.toolName, approval.kind)}
      </p>
      <p>
        <strong>Scope:</strong> {scope} This decision authorizes this request once.
      </p>
      {showExpiry ? (
        <p>
          <strong>Expiry:</strong>{" "}
          {approval.expiresAt ? <TimeText value={approval.expiresAt} absolute /> : "No expiry set"}
          {approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now() ? " · Expired" : ""}
        </p>
      ) : null}
      {/* Generic targets arrive already labelled ("Path", "Target"); purpose-specific ones are bare values. */}
      {(evidence?.targetEntries ?? evidence?.targets.map((value) => ({ label: "Target", value })))?.map((target) => (
        <p key={target.label + target.value}>
          <strong>{target.label}:</strong> {target.value}
        </p>
      ))}
      {evidence?.commands.map((command) => (
        <pre
          key={command}
          className="min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-sunken p-2"
        >
          {command}
        </pre>
      ))}
      {evidence?.supporting.map((detail) => (
        <p key={detail}>{detail}</p>
      ))}
      {evidence?.changes.map((change) => (
        <details
          key={change.label + change.content}
          open={/^(Memory content|Requested memory|Knowledge |Message: )/.test(change.label)}
        >
          <summary>{change.label}</summary>
          <pre className="min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-sunken p-2">
            {change.content}
          </pre>
        </details>
      ))}
      {evidence?.technicalDetails?.map((detail) => (
        <TechnicalDetails key={detail.label + detail.content} label={detail.label}>
          <pre className="min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-sunken p-2">
            {detail.content}
          </pre>
        </TechnicalDetails>
      ))}
      <p>
        <strong>Consequence:</strong>{" "}
        {evidence?.consequence ??
          approval.explanation?.riskExplanation ??
          "After approval, the exact reviewed action may run; denying withholds it. The decision alone does not show the work resumed or completed."}
      </p>
      <TechnicalDetails label="Scope identifiers">
        <p className="break-all font-mono text-xs">
          Workspace {scopeWorkspaceId}
          {sessionId ? ` · Conversation ${sessionId}` : ""}
          {approval.expiresAt ? ` · Expires ${approval.expiresAt}` : ""}
        </p>
      </TechnicalDetails>
      {approval.rollbackNote ? (
        <p>
          <strong>Recovery:</strong> {approval.rollbackNote}
        </p>
      ) : null}
    </section>
  );
}
