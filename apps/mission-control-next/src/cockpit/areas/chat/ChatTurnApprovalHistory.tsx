import type { ChatThreadTurnRecord, ChatToolRunRecord } from "@goatcitadel/contracts";
import { chatToolDisplayName } from "@goatcitadel/mission-control-shared/components/chat/chat-tool-display-name";
import { formatAbsoluteTime } from "@goatcitadel/mission-control-shared/content/format";
import { presentApprovalStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { approvalDecisionText, useApprovalRecord } from "./ChatToolApprovalLine";
import { presentApprovalAction } from "./chat-vocabulary";

/** One approval the turn asked for, as its persisted record states it: what, the decision, who and when. */
function ApprovalHistoryItem({ approvalId, tool }: { approvalId: string; tool: ChatToolRunRecord }) {
  const { record, unavailable } = useApprovalRecord(approvalId, true);
  const action = record ? presentApprovalAction(record.linkage?.toolName, record.kind) : chatToolDisplayName(tool);
  return (
    <li className="py-2 text-sm">
      <p className="font-medium text-fg">{action}</p>
      <p className="text-fg-secondary">
        {record ? (
          record.status === "pending" ? (
            presentApprovalStatus("pending").label
          ) : (
            <>
              {approvalDecisionText(record)}
              {record.resolvedAt ? (
                <>
                  {" · "}
                  <time dateTime={record.resolvedAt}>{formatAbsoluteTime(record.resolvedAt)}</time>
                </>
              ) : null}
            </>
          )
        ) : unavailable ? (
          "The decision record could not be loaded."
        ) : (
          "Reading the decision record…"
        )}
      </p>
    </li>
  );
}

/**
 * The Run tab's approval history (#499): every approval the turn's tool calls asked for, read from the approval
 * records themselves. A decision states the decision only; the tool rows say whether the work then ran.
 */
export function ChatTurnApprovalHistory({ turn }: { turn: ChatThreadTurnRecord | undefined }) {
  if (!turn) return null;
  const firstToolByApproval = new Map<string, ChatToolRunRecord>();
  for (const tool of turn.toolRuns) {
    if (tool.approvalId && !firstToolByApproval.has(tool.approvalId)) firstToolByApproval.set(tool.approvalId, tool);
  }
  return (
    <section aria-label="Approvals for this response" className="mt-4 space-y-1">
      <h3 className="text-sm font-semibold text-fg">Approvals</h3>
      {firstToolByApproval.size ? (
        <ol className="divide-y divide-line-subtle">
          {[...firstToolByApproval].map(([approvalId, tool]) => (
            <ApprovalHistoryItem key={approvalId} approvalId={approvalId} tool={tool} />
          ))}
        </ol>
      ) : (
        <p className="text-sm text-fg-muted">No approvals were recorded for this response.</p>
      )}
    </section>
  );
}
