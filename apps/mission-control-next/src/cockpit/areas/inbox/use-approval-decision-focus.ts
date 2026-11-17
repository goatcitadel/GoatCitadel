import { useEffect, useRef } from "react";

export function useApprovalDecisionFocus(
  focusAction: "approve" | "deny" | undefined,
  approvalId: string,
  hasPreview: boolean,
  specialistReady: boolean,
) {
  const approveRef = useRef<HTMLDivElement>(null);
  const approveFocus = useRef<{ origin: Element | null; cancel: () => void } | null>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusAction !== "approve") return;
    const origin = document.activeElement;
    const cancel = () => {
      approveFocus.current = null;
      document.removeEventListener("focusin", onFocus);
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target !== origin) cancel();
    };
    // An explicit keyboard request can outlive a cold preview. Moving focus gives it up.
    approveFocus.current = { origin, cancel };
    document.addEventListener("focusin", onFocus);
    return cancel;
  }, [focusAction, approvalId]);
  useEffect(() => {
    const request = approveFocus.current;
    if (!request || !hasPreview) return;
    if (document.activeElement !== request.origin || request.origin === denyRef.current) {
      request.cancel();
      return;
    }
    const button = approveRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if (!button) return;
    request.cancel();
    button.focus();
  }, [focusAction, approvalId, hasPreview, specialistReady]);
  useEffect(() => {
    if (focusAction === "deny") denyRef.current?.focus();
  }, [focusAction, approvalId]);

  return { approveRef, denyRef };
}
