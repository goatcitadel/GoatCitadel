import { useEffect, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { presentRiskLevel } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
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
// Asks to open an offered approval again, counted per approval so a dialog on screen sees each new one.
const reopenAsks = new Map<string, number>();
const reopenListeners = new Set<() => void>();

function subscribeReopenAsks(listener: () => void) {
  reopenListeners.add(listener);
  return () => {
    reopenListeners.delete(listener);
  };
}

/**
 * Opens an approval's dialog again although it was offered already: at once where it is on screen, or as soon as it
 * mounts. For a control outside the dialog that asks to review the change, such as a skill row's Review button.
 */
export function reopenSettingsApproval(approvalId: string) {
  offered.delete(approvalId);
  reopenAsks.set(approvalId, (reopenAsks.get(approvalId) ?? 0) + 1);
  for (const listener of reopenListeners) listener();
}

/**
 * The approval for a change, decided where the operator asked for it: a Settings save, or a skill switched in its
 * panel. It opens on its own once, shows the change in one line with the full review behind "Show details", and
 * approves in one click at any level below nuclear. It mounts the shared decision bar, so the pre-dispatch re-read,
 * risk gate and idempotency lock match the Inbox.
 *
 * A Settings change belongs to its workspace and is read there. A skill change belongs to no workspace
 * (`workspaceId={null}`), so every read of it is unscoped: scoped to any workspace, it would not be found.
 *
 * Once closed it stays closed; its own button (`reviewLabel`) or `reopenSettingsApproval` opens it again.
 */
export function SettingsApprovalDialog({
  approvalId,
  workspaceId = "default",
  title = "Approve this Settings change?",
  summary,
  reviewLabel = "Review approval",
  loadFailureHint = "Use Refresh change status, or decide it in Inbox.",
  onResolved,
}: {
  approvalId: string;
  /** The approval's workspace, or `null` for one that belongs to none (a skill change). */
  workspaceId?: string | null;
  /** The title when the approval's own preview has none. */
  title?: string;
  /**
   * A line under the title naming what the approval is for, in the owner's words (a skill panel: "Turn Planner on").
   * Shown only when the approval's own preview has no summary; it never replaces what the approval says.
   */
  summary?: string;
  /** The words of the button that opens the dialog again. */
  reviewLabel?: string;
  /** What to do when the approval can't be read, after the sentence that says so. */
  loadFailureHint?: string;
  /** Called after a decision with the approval's re-read status, so the owner can report a denial as a denial. */
  onResolved: (status: ApprovalRequest["status"] | undefined) => Promise<unknown> | void;
}) {
  const { activeWorkspaceId } = useUiPreferences();
  // Where a detached approval is shown from: the workspace on screen names the review and the Inbox it lands in.
  const scope = workspaceId ?? activeWorkspaceId ?? "default";
  const readScope = workspaceId === null ? {} : { workspaceId };
  const access = useProjectAccess(scope);
  const queryClient = useQueryClient();
  const queryKey = ["approvals", "record", workspaceId, approvalId, access.identity];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => nullWhenMissing(fetchApproval(approvalId, { ...readScope, signal })),
    staleTime: 15_000,
  });
  const approval = query.data;
  const pending = approval?.status === "pending";
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string>();
  const reopenAsk = useSyncExternalStore(
    subscribeReopenAsks,
    () => reopenAsks.get(approvalId) ?? 0,
    () => 0,
  );

  // Opens once per approval, and again after each ask to reopen it (which clears it from `offered`).
  useEffect(() => {
    if (!pending || offered.has(approvalId)) return;
    offered.add(approvalId);
    setOpen(true);
  }, [approvalId, pending, reopenAsk]);

  const settle = (text?: string) => {
    setMessage(text);
    void queryClient.resetQueries({ queryKey, exact: true });
    void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(scope) });
  };

  // Not a live region: the cockpit live-region budget only goes down, and this sits under the change's own status.
  if (query.isError)
    return (
      <p className="text-sm text-status-failed">The approval for this change could not be loaded. {loadFailureHint}</p>
    );
  // Once decided, the change's own status line reports the result; the decision wording is not repeated here.
  if (!pending) return null;
  const preview = approval.preview as { title?: unknown; summary?: unknown; impact?: unknown } | undefined;
  const line = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
  return (
    <>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
        {reviewLabel}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={line(preview?.title) ?? title}
        description={line(preview?.summary) ?? line(summary)}
      >
        <div className="space-y-3 text-sm text-fg-secondary">
          <div className="flex flex-wrap items-center gap-2">
            {approval.riskLevel ? <StatusBadge status={presentRiskLevel(approval.riskLevel)} /> : null}
            {line(preview?.impact) ? <p>{line(preview?.impact)}</p> : null}
          </div>
          <details>
            <summary className="cursor-pointer font-medium text-fg">Show details</summary>
            <div className="mt-2 max-h-72 overflow-y-auto">
              <ApprovalReviewSummary approval={approval} workspaceId={scope} />
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
              void fetchApproval(approvalId, readScope)
                .then((record) => record.status)
                .catch(() => undefined)
                .then((status) => onResolved(status));
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
  reopenAsks.clear();
}
