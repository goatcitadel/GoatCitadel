// Approvals that a dialog on screen is already offering to decide where the change was made. The notification for
// such an approval (an Inbox toast with "Open Inbox item") would sit on top of that dialog, so it is not shown.
const mounted = new Map<string, number>();

/** Called while a dialog for the approval is mounted. Returns what ends it. */
export function registerApprovalHandledInPlace(approvalId: string): () => void {
  mounted.set(approvalId, (mounted.get(approvalId) ?? 0) + 1);
  return () => {
    const left = (mounted.get(approvalId) ?? 1) - 1;
    if (left > 0) mounted.set(approvalId, left);
    else mounted.delete(approvalId);
  };
}

export function isApprovalHandledInPlace(approvalId: string): boolean {
  return mounted.has(approvalId);
}

export function __resetApprovalsHandledInPlaceForTests() {
  mounted.clear();
}
