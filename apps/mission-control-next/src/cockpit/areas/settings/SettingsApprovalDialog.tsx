import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { presentRiskLevel } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { queryKeys } from "../../data/query-keys";
import { ApprovalDecisionBar } from "../inbox/ApprovalDecisionBar";
import { ApprovalReviewSummary } from "../inbox/ApprovalReviewSummary";
import { nullWhenMissing } from "../inbox/inbox-record-read";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { StatusBadge } from "../../ui/StatusBadge";

// Approvals already offered in this app session, so a re-render or remount never reopens one the operator closed.
const offered = new Set<string>();

/**
 * The approval for a Settings save, decided where the operator saved it. It opens on its own once, shows the change
 * in one line with the full review behind "Show details", and approves in one click at any level below nuclear. It
 * mounts the shared decision bar, so the pre-dispatch re-read, risk gate and idempotency lock match the Inbox.
 */
export function SettingsApprovalDialog({
  approvalId,
  workspaceId = "default",
  onResolved,
}: {
  approvalId: string;
  workspaceId?: string;
  onResolved: () => Promise<unknown> | void;
}) {
  const access = useProjectAccess(workspaceId);
  const queryClient = useQueryClient();
  const queryKey = ["approvals", "record", workspaceId, approvalId, access.identity];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => nullWhenMissing(fetchApproval(approvalId, { workspaceId, signal })),
    staleTime: 15_000,
  });
  const approval = query.data;
  const pending = approval?.status === "pending";
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    if (!pending || offered.has(approvalId)) return;
    offered.add(approvalId);
    setOpen(true);
  }, [approvalId, pending]);

  const settle = (text?: string) => {
    setMessage(text);
    void queryClient.resetQueries({ queryKey, exact: true });
    void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) });
  };

  if (query.isError)
    return (
      <p role="alert" className="text-sm text-status-failed">
        The approval for this change could not be loaded. Use Refresh change status, or decide it in Inbox.
      </p>
    );
  // Once decided, the change's own status line reports the result; the decision wording is not repeated here.
  if (!pending) return null;
  const preview = approval.preview as { title?: unknown; summary?: unknown; impact?: unknown } | undefined;
  const line = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
  return (
    <>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
        Review approval
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={line(preview?.title) ?? "Approve this Settings change?"}
        description={line(preview?.summary)}
      >
        <div className="space-y-3 text-sm text-fg-secondary">
          <div className="flex flex-wrap items-center gap-2">
            {approval.riskLevel ? <StatusBadge status={presentRiskLevel(approval.riskLevel)} /> : null}
            {line(preview?.impact) ? <p>{line(preview?.impact)}</p> : null}
          </div>
          <details>
            <summary className="cursor-pointer font-medium text-fg">Show details</summary>
            <div className="mt-2 max-h-72 overflow-y-auto">
              <ApprovalReviewSummary approval={approval} workspaceId={workspaceId} />
            </div>
          </details>
          <ApprovalDecisionBar
            compact
            reviewedInPlace
            approval={approval}
            workspaceId={workspaceId}
            onResolved={() => {
              setOpen(false);
              settle();
              void onResolved();
            }}
            onInvalidated={(text) =>
              settle(text ?? "The approval changed. Review the refreshed record before deciding.")
            }
          />
          {message ? <p className="text-fg-muted">{message}</p> : null}
        </div>
      </Dialog>
    </>
  );
}

export function __resetSettingsApprovalDialogsForTests() {
  offered.clear();
}
