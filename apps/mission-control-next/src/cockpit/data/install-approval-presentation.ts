import { useLayoutEffect, useRef, type RefObject } from "react";
import { SKILL_HUB_LIFECYCLE_APPROVAL_KIND } from "@goatcitadel/contracts";
import { isApprovalHandledInPlace, subscribeApprovalsHandledInPlace } from "./approvals-handled-in-place";

const APPROVAL_KINDS_BY_PANEL = {
  connector: ["change_plan_effect"],
  plugin: ["change_plan_effect", SKILL_HUB_LIFECYCLE_APPROVAL_KIND],
  skill: [SKILL_HUB_LIFECYCLE_APPROVAL_KIND],
} as const;

type InstallPanel = keyof typeof APPROVAL_KINDS_BY_PANEL;
type Presentation = {
  panel: InstallPanel;
  root: RefObject<HTMLDivElement | null>;
  approvalId: string | undefined;
  requesting: boolean;
};

const presentations = new Set<Presentation>();
const listeners = new Set<() => void>();

export function subscribeInstallApprovalPresentation(listener: () => void): () => void {
  listeners.add(listener);
  const stopFollowingReview = subscribeApprovalsHandledInPlace(listener);
  return () => {
    listeners.delete(listener);
    stopFollowingReview();
  };
}

function publish() {
  for (const listener of listeners) listener();
}

/** Register only the rendered install progress, so an install followed in the background cannot own the toast. */
export function useInstallApprovalPresentation(
  panel: InstallPanel,
  approvalId: string | undefined,
  requesting: boolean,
) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!approvalId && !requesting) return;
    const presentation = { panel, root, approvalId, requesting };
    presentations.add(presentation);
    publish();
    return () => {
      presentations.delete(presentation);
      // Let a render that replaces the request with its receipt commit the new entry first.
      queueMicrotask(publish);
    };
  }, [panel, approvalId, requesting]);
  return root;
}

function canPresent(entry: Presentation, approvalKind: unknown): boolean {
  const node = entry.root.current;
  return Boolean(
    node?.isConnected &&
    node.closest('[data-inspector-body="true"]') &&
    !node.closest('[hidden], [inert], [aria-hidden="true"]') &&
    APPROVAL_KINDS_BY_PANEL[entry.panel].some((kind) => kind === approvalKind),
  );
}

export function isInstallApprovalPresented(approvalId: string, approvalKind: unknown): boolean {
  if (!isApprovalHandledInPlace(approvalId)) return false;
  for (const entry of presentations) {
    if (entry.approvalId === approvalId && canPresent(entry, approvalKind)) return true;
  }
  return false;
}

function hasWaitingPanel(approvalId: string, approvalKind: unknown): boolean {
  return [...presentations].some(
    (entry) => (entry.requesting || entry.approvalId === approvalId) && canPresent(entry, approvalKind),
  );
}

/** Realtime can precede both the install receipt and the validated review of its approval. */
export function waitForInstallApprovalPresentation(
  approvalId: string,
  approvalKind: unknown,
): Promise<void> | undefined {
  if (isInstallApprovalPresented(approvalId, approvalKind)) return undefined;
  if (!hasWaitingPanel(approvalId, approvalKind)) return undefined;
  return new Promise((resolve) => {
    // An unrelated decision must still notify even when the install request has stalled.
    const timer = setTimeout(finish, 1_000);
    const stop = subscribeInstallApprovalPresentation(check);
    function finish() {
      clearTimeout(timer);
      stop();
      resolve();
    }
    function check() {
      if (isInstallApprovalPresented(approvalId, approvalKind) || !hasWaitingPanel(approvalId, approvalKind)) finish();
    }
  });
}
