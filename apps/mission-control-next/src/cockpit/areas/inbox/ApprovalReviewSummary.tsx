import type { ApprovalRequest } from "@goatcitadel/contracts";
import { buildApprovalRequestReviewEvidenceModel } from "@goatcitadel/mission-control-shared/content/approval-helpers";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
export function ApprovalReviewSummary({ approval, workspaceId }: { approval: ApprovalRequest; workspaceId: string }) {
  const evidence = buildApprovalRequestReviewEvidenceModel(approval);
  const scope = evidence?.scopeSummary ?? `workspace ${approval.linkage?.workspaceId ?? workspaceId}${approval.linkage?.sessionId ? ` · conversation ${approval.linkage.sessionId}` : ""}.`;
  return (
    <section
      aria-label="Approval scope and consequences"
      className="min-w-0 max-w-full space-y-2 wrap-anywhere text-sm text-fg-secondary"
    >
      <p>
        <strong>Action:</strong> {humanizeToken(approval.linkage?.toolName ?? approval.kind)}
      </p>
      <p>
        <strong>Scope:</strong> {scope} This decision authorizes this request once.
      </p>
      <p>
        <strong>Expiry:</strong> {approval.expiresAt ?? "No expiry recorded by Gateway"}
        {approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now() ? " · Expired" : ""}
      </p>
      {/* Generic targets arrive already labelled ("Path", "Target"); purpose-specific ones are bare values. */}
      {(evidence?.targetEntries ?? evidence?.targets.map((value) => ({ label: "Target", value })))?.map((target) => (
        <p key={target.label + target.value}>
          <strong>{target.label}:</strong> {target.value}
        </p>
      ))}
      {evidence?.commands.map((command) => (
        <pre
          key={command}
          className="min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded bg-sunken p-2"
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
          <pre className="min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded bg-sunken p-2">
            {change.content}
          </pre>
        </details>
      ))}
      {evidence?.technicalDetails?.map((detail) => (
        <TechnicalDetails key={detail.label + detail.content} label={detail.label}>
          <pre className="min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded bg-sunken p-2">
            {detail.content}
          </pre>
        </TechnicalDetails>
      ))}
      <p>
        <strong>Consequence:</strong>{" "}
        {evidence?.consequence ?? approval.explanation?.riskExplanation ??
          "Gateway may execute the exact reviewed action after approval; deny withholds authorization. The decision alone does not prove work resumed or completed."}
      </p>
      {approval.rollbackNote ? (
        <p>
          <strong>Recovery:</strong> {approval.rollbackNote}
        </p>
      ) : null}
    </section>
  );
}
