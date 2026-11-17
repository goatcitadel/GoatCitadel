import { isInstallWideApproval, type ApprovalRequest } from "@goatcitadel/contracts";
import type { ApprovalEvidenceModel } from "@goatcitadel/mission-control-shared/content/approval-helpers";
// Tool names and approval kinds are open strings; the chat presenter names the known ones.
import { presentApprovalAction } from "../chat/chat-vocabulary";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useWorkspaceNameLookup } from "../../data/use-workspace-name";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { splitApprovalExplanation, splitApprovalSupport } from "./approval-preview";

export function reviewsMemoryWrite(approval: ApprovalRequest): boolean {
  return ["memory.write", "memory.upsert"].some(
    (tool) => tool === approval.kind || tool === approval.linkage?.toolName,
  );
}

/** `showExpiry={false}` when the surrounding view already states the expiry once (IN-R04). */
export function ApprovalReviewSummaryContent({
  approval,
  evidence,
  workspaceId,
  showExpiry = true,
}: {
  approval: ApprovalRequest;
  evidence: ApprovalEvidenceModel | null;
  workspaceId: string;
  showExpiry?: boolean;
}) {
  const { activeCitadelId } = useUiPreferences();
  const workspaceName = useWorkspaceNameLookup(activeCitadelId);
  // An approval of no workspace (a skill change) is decided once for the whole install, not in the active workspace.
  const installWide = isInstallWideApproval(approval);
  const scopeWorkspaceId = approval.linkage?.workspaceId ?? workspaceId;
  const sessionId = approval.linkage?.sessionId;
  const workspaceLabel =
    workspaceName(scopeWorkspaceId) ?? (scopeWorkspaceId === workspaceId ? "This workspace" : "Another workspace");
  const support = splitApprovalSupport(evidence?.supporting ?? []);
  const scope =
    evidence?.scopeSummary ??
    (installWide
      ? "Every workspace on this install."
      : `${workspaceLabel}${sessionId ? " · one linked conversation" : ""}.`);
  // An install-wide approval names no workspace, so with nothing else recorded there are no identifiers to show.
  const hasScopeIdentifiers = !installWide || Boolean(sessionId) || Boolean(approval.expiresAt);
  const { owner: ownerExplanation, model: modelExplanation } = splitApprovalExplanation(approval);
  const memoryWrite = reviewsMemoryWrite(approval);
  const memoryContent = memoryWrite ? evidence?.changes.find((change) => change.label === "Memory content") : undefined;
  const preference =
    typeof approval.preview?.title === "string" && /^Operator preference:/iu.test(approval.preview.title);
  const memoryTitle = memoryWrite ? support.visible.find((detail) => detail.startsWith("Title: ")) : undefined;
  const recordedDetails = support.visible
    .filter((detail) => detail !== memoryTitle)
    .map((detail) => <p key={detail}>{detail}</p>);
  return (
    <section
      aria-label="Approval scope and consequences"
      className="min-w-0 max-w-full space-y-2 wrap-anywhere text-sm text-fg-secondary"
    >
      {memoryWrite ? (
        <h4 className="font-medium text-fg">{preference ? "Save this preference to memory?" : "Save to memory?"}</h4>
      ) : (
        <p>
          <strong>Action:</strong> {presentApprovalAction(approval.linkage?.toolName, approval.kind)}
        </p>
      )}
      {memoryWrite ? (
        <>
          {memoryTitle ? <p>{memoryTitle}</p> : null}
          {(evidence?.targetEntries ?? evidence?.targets.map((value) => ({ label: "Target", value })))?.map(
            (target) => (
              <p key={target.label + target.value}>
                <strong>Storage target:</strong> {target.value}
              </p>
            ),
          )}
          {memoryContent ? (
            <details open>
              <summary className="cursor-pointer">Memory content</summary>
              <pre
                tabIndex={0}
                className="max-h-40 min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-sunken p-2"
              >
                {memoryContent.content}
              </pre>
            </details>
          ) : (
            <p>Memory content is unavailable in this preview.</p>
          )}
          <p>
            <strong>Requested from:</strong>{" "}
            {sessionId
              ? scopeWorkspaceId === workspaceId
                ? "A conversation in this workspace."
                : "A conversation in another workspace."
              : "Outside a conversation."}
          </p>
        </>
      ) : null}
      <p>
        <strong>Scope:</strong>{" "}
        {memoryWrite ? "Approval permits this write once." : `${scope} This decision authorizes this request once.`}
      </p>
      {showExpiry ? (
        <p>
          <strong>Expiry:</strong>{" "}
          {approval.expiresAt ? <TimeText value={approval.expiresAt} absolute /> : "No expiry set"}
          {approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now() ? " · Expired" : ""}
        </p>
      ) : null}
      {/* Generic targets arrive already labelled ("Path", "Target"); purpose-specific ones are bare values. */}
      {!memoryWrite &&
        (evidence?.targetEntries ?? evidence?.targets.map((value) => ({ label: "Target", value })))?.map((target) => (
          <p key={target.label + target.value}>
            <strong>{target.label}:</strong> {target.value}
          </p>
        ))}
      {approval.preview?.outsideRootRead === true ? (
        <p>
          <strong>Outside the workspace:</strong> this reads a file outside the workspace and project folders. Approve
          only if you meant to share it.
        </p>
      ) : null}
      {evidence?.commands.map((command) => (
        <pre
          key={command}
          className="min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-sunken p-2"
        >
          {command}
        </pre>
      ))}
      {!memoryWrite ? recordedDetails : null}
      {support.technical.length ? (
        <TechnicalDetails label="Recorded request details">
          {support.technical.map((detail) => (
            <p key={detail} className="break-all font-mono text-xs">
              {detail}
            </p>
          ))}
        </TechnicalDetails>
      ) : null}
      {evidence?.changes
        .filter((change) => change !== memoryContent)
        .map((change) => (
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
        <strong>{memoryWrite ? "What happens next:" : "Consequence:"}</strong>{" "}
        {evidence?.consequence ??
          ownerExplanation?.riskExplanation ??
          (memoryWrite
            ? "After your decision, check the recorded outcome to see whether the write ran."
            : "After approval, the exact reviewed action may run; denying withholds it. The decision alone does not show the work resumed or completed.")}
      </p>
      {memoryWrite && recordedDetails.length ? (
        <details>
          <summary className="cursor-pointer">More request details</summary>
          <div className="mt-1 space-y-1">{recordedDetails}</div>
        </details>
      ) : null}
      {modelExplanation?.riskExplanation ? (
        <p>
          <strong>Model explanation:</strong> {modelExplanation.riskExplanation}{" "}
          <span className="text-fg-muted">Written by a model after the request; advisory only.</span>
        </p>
      ) : null}
      {hasScopeIdentifiers ? (
        <TechnicalDetails label="Scope identifiers">
          <p className="break-all font-mono text-xs">
            {[
              installWide ? undefined : `Workspace ${scopeWorkspaceId}`,
              sessionId ? `Conversation ${sessionId}` : undefined,
              approval.expiresAt ? `Expires ${approval.expiresAt}` : undefined,
            ]
              .filter((part): part is string => part !== undefined)
              .join(" · ")}
          </p>
        </TechnicalDetails>
      ) : null}
      {approval.rollbackNote ? (
        <p>
          <strong>Recovery:</strong> {approval.rollbackNote}
        </p>
      ) : null}
    </section>
  );
}
