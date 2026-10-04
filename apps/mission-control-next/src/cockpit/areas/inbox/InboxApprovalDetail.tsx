import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { fetchApprovals } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { buildApprovalEvidenceModel } from "@goatcitadel/mission-control-shared/content/approval-helpers";
import { presentApprovalStatus, presentRiskLevel } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { approvalExpiryLabel, approvalExplanationLine } from "./approval-preview";
import { InboxApprovalActions } from "./InboxApprovalActions";

export function InboxApprovalDetail({ item, workspaceId, focusAction }: {
  item: OperatorInboxItem; workspaceId: string; focusAction?: "approve" | "deny";
}) {
  const [decisionNotice, setDecisionNotice] = useState("");
  const approvalId = item.source.approvalId;
  const query = useQuery({ queryKey: ["approvals", "inbox-detail", workspaceId, approvalId],
    queryFn: () => fetchApprovals({ status: "pending", workspaceId, limit: 200 }), enabled: Boolean(approvalId), staleTime: 0 });
  const approval = query.isFetching || query.isError
    ? undefined
    : query.data?.items.find((record) => record.approvalId === approvalId);
  const evidence = approval ? buildApprovalEvidenceModel(approval.preview) : null;
  return <section aria-label="Current approval" className="space-y-3 border-t border-line-subtle pt-3 text-sm">
    <div className="flex items-center justify-between gap-2"><h3 className="font-display font-semibold text-fg">Current approval</h3>
      <Button size="sm" onClick={() => { setDecisionNotice(""); void query.refetch(); }} disabled={query.isFetching || !approvalId}>Refresh</Button></div>
    {query.isFetching ? <p role="status" className="text-fg-muted">Loading the current approval…</p> : null}
    {query.isError ? <p role="alert" className="text-fg-secondary">{describeApiError(query.error).summary}</p> : null}
    {decisionNotice ? <p role="status" className="text-fg-secondary">{decisionNotice}</p> : null}
    {!query.isFetching && !query.isError && !approval ? <p className="text-fg-muted">This approval was not found in the first page of this workspace&apos;s pending queue{query.data?.nextCursor ? "; more records are available" : ""}. Open Approvals for the current record and outcome.</p> : null}
    {approval ? <>
      <div className="flex flex-wrap gap-2"><StatusBadge status={presentRiskLevel(approval.riskLevel)} /><StatusBadge status={presentApprovalStatus(approval.status)} /></div>
      {approval.expiresAt ? <p className="text-fg-muted">{approvalExpiryLabel(approval.expiresAt)}</p> : null}
      <p className="text-fg-secondary">{approvalExplanationLine(approval.explanation?.summary, approval.explanationStatus)}</p>
      {approval.explanation?.riskExplanation ? <p className="text-fg-secondary">{approval.explanation.riskExplanation}</p> : null}
      {approval.explanation?.saferAlternative ? <p className="text-fg-secondary">Safer option: {approval.explanation.saferAlternative}</p> : null}
      {evidence ? <section aria-label="Action preview" className="space-y-2 rounded-md border border-line bg-sunken p-3">
        <h4 className="font-medium text-fg">Action preview</h4>
        {evidence.targets.length ? <ul className="list-disc space-y-1 pl-5 text-fg-secondary">{evidence.targets.map((target) => <li key={target}>{target}</li>)}</ul> : null}
        {evidence.commands.length ? <ul className="space-y-1">{evidence.commands.map((command) => <li key={command}><code className="block overflow-x-auto rounded bg-raised p-2 font-mono text-xs text-fg">{command}</code></li>)}</ul> : null}
        {evidence.supporting.length ? <ul className="list-disc space-y-1 pl-5 text-fg-secondary">{evidence.supporting.map((support) => <li key={support}>{support}</li>)}</ul> : null}
        {evidence.changes.map((change) => <details key={change.label} className="text-fg-secondary"><summary className="cursor-pointer">{change.label}</summary><pre className="mt-1 overflow-x-auto rounded bg-raised p-2 text-xs">{change.content}</pre></details>)}
      </section> : <p className="text-fg-muted">A structured preview is not available here. Open the full approval record before deciding.</p>}
      {approval.rollbackNote ? <p className="text-fg-secondary">Recovery: {approval.rollbackNote}</p> : null}
      {evidence ? <InboxApprovalActions item={item} approval={approval} workspaceId={workspaceId} focusAction={focusAction}
        onResolved={(message) => { setDecisionNotice(message); void query.refetch(); }}
        onInvalidated={() => { setDecisionNotice("The approval changed. Review the refreshed record before deciding."); void query.refetch(); }} /> : null}
      <p className="text-xs text-fg-muted">This is a workspace-scoped read of the canonical pending queue. The full decision and follow-on record remain in Approvals.</p>
    </> : null}
  </section>;
}
