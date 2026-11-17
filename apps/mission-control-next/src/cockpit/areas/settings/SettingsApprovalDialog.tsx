import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { presentRiskLevel } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { registerApprovalHandledInPlace } from "../../data/approvals-handled-in-place";
import { queryKeys } from "../../data/query-keys";
import { ApprovalDecisionBar } from "../inbox/ApprovalDecisionBar";
import { ApprovalReviewSummary } from "../inbox/ApprovalReviewSummary";
import { nullWhenMissing } from "../inbox/inbox-record-read";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { restoreFocusAfterClose } from "../../ui/focus-return";
import { DisclosureSummary } from "../../ui/DisclosureSummary";
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
 * mounts. For a control outside the dialog that asks to review the change.
 */
export function reopenSettingsApproval(approvalId: string) {
  offered.delete(approvalId);
  reopenAsks.set(approvalId, (reopenAsks.get(approvalId) ?? 0) + 1);
  for (const listener of reopenListeners) listener();
}

/**
 * The approval for a change, decided where the operator asked for it: a Settings save, or a skill switched in its
 * panel. The dialog opens on its own once. An inline review stays next to the originating control.
 * Both use the shared decision bar and its pre-dispatch re-read, risk gate and idempotency lock.
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
  installationSetting = false,
  dangerReview = false,
  presentation = "dialog",
  installationPlanId,
  returnFocus,
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
  summary?: string | ((approval: ApprovalRequest) => string);
  /** The words of the button that opens the dialog again. */
  reviewLabel?: string;
  /** What to do when the approval can't be read, after the sentence that says so. */
  loadFailureHint?: ReactNode;
  presentation?: "dialog" | "inline";
  /** An installation-wide connector plan, stored and reviewed in the default workspace. */
  installationPlanId?: string;
  /** Restores focus to the originating control when the inline decision dismisses itself. */
  returnFocus?: () => void;
  /**
   * The change applies to the whole installation (a Settings change), so it is decided here from any selected
   * workspace. The bar still checks that the approval itself is the install-wide Settings shape.
   */
  installationSetting?: boolean;
  /**
   * A danger-level approval keeps its two-step review here: the red "Review danger approval" button and then its
   * confirmation, as in Inbox. Caution still approves in one click and nuclear keeps its typed confirmation. For a
   * change the operator asked for that was decided in Inbox before it opened in place (a connector install, the tool
   * approval rule, filesystem access); dialogs that don't set it keep the one-click danger approval.
   */
  dangerReview?: boolean;
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
  const mismatched = Boolean(
    installationPlanId &&
    query.isSuccess &&
    (approval?.approvalId !== approvalId ||
      approval.kind !== "change_plan_effect" ||
      approval.payload?.planId !== installationPlanId),
  );
  const pending = approval?.status === "pending" && !mismatched;
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string>();
  // Where focus was when the dialog opened, so a decision (which removes the Review button) hands it back to the setting.
  const origin = useRef<{ opener: HTMLElement | null; region: HTMLElement | null }>({ opener: null, region: null });
  // A decision was made and focus has not been handed back yet. The owner often drops this dialog from its own
  // `onResolved`, so the unmount hands focus back too; whichever comes first does it, once.
  const owed = useRef(false);
  const restoreDialogFocus = () => {
    if (!owed.current) return;
    owed.current = false;
    restoreFocusAfterClose(origin.current.opener, origin.current.region);
  };
  const returnFocusRef = useRef(restoreDialogFocus);
  returnFocusRef.current = restoreDialogFocus;
  useEffect(() => () => returnFocusRef.current(), []);
  const rememberOrigin = () => {
    owed.current = false;
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    origin.current = { opener, region: opener?.closest("section") ?? null };
  };
  const reviewTitleId = useId();
  const inlineReview = useRef<HTMLElement>(null);
  const inlineFocus = useRef(false);
  const reopenAsk = useSyncExternalStore(
    subscribeReopenAsks,
    () => reopenAsks.get(approvalId) ?? 0,
    () => 0,
  );

  // Register only while the exact pending review is offered. A closed dialog or failed read leaves Inbox available.
  const reviewOpen = presentation === "inline" || open;
  useEffect(
    () => (pending && reviewOpen ? registerApprovalHandledInPlace(approvalId) : undefined),
    [approvalId, pending, reviewOpen],
  );

  // Opens once per approval, and again after each ask to reopen it (which clears it from `offered`).
  useEffect(() => {
    if (presentation === "inline" || !pending || offered.has(approvalId)) return;
    offered.add(approvalId);
    rememberOrigin();
    setOpen(true);
  }, [approvalId, pending, presentation, reopenAsk]);

  const settle = (text?: string) => {
    // A disabled decision button can send focus to the body or to its containing sheet.
    const focused = document.activeElement;
    const section = inlineReview.current;
    if (
      inlineFocus.current &&
      section &&
      (focused === document.body || focused === section.closest('[role="dialog"]') || section.contains(focused))
    ) {
      returnFocus?.();
    }
    setMessage(text);
    void queryClient.resetQueries({ queryKey, exact: true });
    void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(scope) });
  };

  // Not a live region: the cockpit live-region budget only goes down, and this sits under the change's own status.
  if (query.isError || mismatched)
    return (
      <p className="text-sm text-status-failed">The approval for this change could not be loaded. {loadFailureHint}</p>
    );
  // Once decided, the change's own status line reports the result; the decision wording is not repeated here.
  if (!pending) return null;
  const preview = approval.preview as { title?: unknown; summary?: unknown; impact?: unknown } | undefined;
  const line = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
  const reviewTitle = line(preview?.title) ?? title;
  const description = line(preview?.summary) ?? line(typeof summary === "function" ? summary(approval) : summary);
  const impact =
    line(preview?.impact) ??
    (presentation === "inline" && workspaceId === null ? "Applies to every workspace." : undefined);
  const needsDangerReview = dangerReview && approval.riskLevel === "danger";
  const review = (
    <div
      className={
        presentation === "inline" ? "space-y-2 text-sm text-fg-secondary" : "space-y-3 text-sm text-fg-secondary"
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {approval.riskLevel ? <StatusBadge status={presentRiskLevel(approval.riskLevel)} /> : null}
        {impact ? <p>{impact}</p> : null}
      </div>
      <details>
        <DisclosureSummary className="cursor-pointer whitespace-nowrap font-medium text-fg">
          Show details
        </DisclosureSummary>
        <div className="mt-2 max-h-72 overflow-y-auto">
          <ApprovalReviewSummary approval={approval} workspaceId={scope} />
        </div>
      </details>
      <ApprovalDecisionBar
        compact
        reviewedInPlace={!needsDangerReview}
        inlineDangerReview={presentation === "inline" && needsDangerReview}
        installationSetting={installationSetting}
        approval={approval}
        workspaceId={workspaceId}
        onResolved={() => {
          if (presentation === "dialog") owed.current = true;
          setOpen(false);
          settle();
          void fetchApproval(approvalId, readScope)
            .then((record) => record.status)
            .catch(() => undefined)
            .then((status) => onResolved(status))
            .finally(restoreDialogFocus);
        }}
        onInvalidated={(text) => settle(text ?? "The approval changed. Review the refreshed record before deciding.")}
      />
      {message ? <p className="text-fg-muted">{message}</p> : null}
    </div>
  );
  if (presentation === "inline") {
    return (
      <section
        ref={inlineReview}
        aria-labelledby={reviewTitleId}
        className="space-y-2 border-t border-line-subtle pt-3"
        onFocusCapture={() => {
          inlineFocus.current = true;
        }}
        onBlurCapture={(event) => {
          const { currentTarget, relatedTarget } = event;
          if (
            relatedTarget &&
            relatedTarget !== currentTarget.closest('[role="dialog"]') &&
            !currentTarget.contains(relatedTarget)
          )
            inlineFocus.current = false;
        }}
      >
        <h3 id={reviewTitleId} className="text-sm font-semibold text-fg">
          {reviewTitle}
        </h3>
        {description ? <p className="text-sm text-fg-secondary">{description}</p> : null}
        {review}
      </section>
    );
  }
  return (
    <>
      <Button
        size="sm"
        variant="primary"
        onClick={() => {
          rememberOrigin();
          setOpen(true);
        }}
      >
        {reviewLabel}
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title={reviewTitle} description={description}>
        {review}
      </Dialog>
    </>
  );
}

export function __resetSettingsApprovalDialogsForTests() {
  offered.clear();
  reopenAsks.clear();
}
