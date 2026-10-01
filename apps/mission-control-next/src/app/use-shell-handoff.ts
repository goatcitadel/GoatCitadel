import { createElement, useLayoutEffect, useRef, useState } from "react";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { DraftLeaveDialog, useDraftLeave, type DraftLeaveDialogProps } from "../features/native-routes/library/DraftLeaveDialog";
import { switchShell, type ShellPreference } from "../shell-preference";
import { SHELL_NAVIGATION_EVENTS } from "./shell-transition";

/** A reviewed presentation transition; runtime owners and their session locks remain in the document. */
export function useShellHandoff(scope: unknown) {
  const leave = useDraftLeave();
  const identity = canonicalJsonString(scope);
  const renderedInstallation = getGatewayApiBaseUrl();
  const renderedOrigin = typeof window === "undefined" ? null : window.location.href;
  const scopeToken = useRef({ identity });
  if (scopeToken.current.identity !== identity) scopeToken.current = { identity };
  const renderedScope = scopeToken.current;
  const navigationToken = useRef({});
  const renderedNavigation = navigationToken.current;
  const live = useRef({ identity, mounted: true, epoch: 0 });
  const controller = useRef<AbortController | null>(null);
  const review = useRef<{ isCurrent: () => boolean } | null>(null);
  const cancelReview = useRef(leave.dialogProps.onCancel);
  cancelReview.current = leave.dialogProps.onCancel;
  const [feedback, setFeedback] = useState({ identity, epoch: 0, opening: false, error: null as string | null });
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.epoch++;
  }
  useLayoutEffect(() => {
    const view = live.current;
    view.mounted = true;
    if (!review.current?.isCurrent()) {
      review.current = null;
      cancelReview.current();
    }
    const invalidate = () => {
      navigationToken.current = {};
      view.epoch++;
      review.current = null;
      controller.current?.abort();
      cancelReview.current();
      setFeedback({ identity: view.identity, epoch: view.epoch, opening: false, error: null });
    };
    for (const event of SHELL_NAVIGATION_EVENTS) window.addEventListener(event, invalidate);
    return () => {
      view.mounted = false;
      view.epoch++;
      review.current = null;
      controller.current?.abort();
      for (const event of SHELL_NAVIGATION_EVENTS) window.removeEventListener(event, invalidate);
    };
  }, [identity]);
  function requestTransition(transition: (options: { isCurrent: () => boolean; signal: AbortSignal }) => Promise<unknown> | void) {
    if (controller.current || review.current || leave.dialogProps.open) return;
    const epoch = live.current.epoch,
      origin = window.location.href,
      installation = renderedInstallation;
    const current = () =>
      live.current.mounted &&
      scopeToken.current === renderedScope &&
      navigationToken.current === renderedNavigation &&
      window.location.href === renderedOrigin &&
      live.current.identity === identity &&
      live.current.epoch === epoch &&
      getGatewayApiBaseUrl() === installation &&
      window.location.href === origin;
    if (!current()) return;
    const pending = { isCurrent: current };
    review.current = pending;
    leave.request(() => {
      if (review.current !== pending || !current() || controller.current) return;
      review.current = null;
      const attempt = new AbortController();
      controller.current = attempt;
      setFeedback({ identity, epoch, opening: true, error: null });
      void (async () => { await transition({ isCurrent: current, signal: attempt.signal }); })()
        .catch(() => {
          if (current())
            setFeedback({
              identity,
              epoch,
              opening: false,
              error: "The view could not open. Your current drafts are still available.",
            });
        })
        .finally(() => {
          if (controller.current !== attempt) return;
          controller.current = null;
          if (live.current.mounted) setFeedback((value) =>
            value.identity === identity && value.epoch === epoch ? { ...value, opening: false } : value);
        });
    });
  }
  const pending = review.current;
  const reviewCurrent = () => Boolean(pending && review.current === pending && pending.isCurrent());
  const completeReview = (action: () => void) => {
    if (!reviewCurrent()) return;
    action();
    if (review.current === pending) review.current = null;
  };
  const dialogProps: DraftLeaveDialogProps = {
    ...leave.dialogProps,
    open: leave.dialogProps.open && reviewCurrent(),
    isCurrent: reviewCurrent,
    onContinue: () => completeReview(leave.dialogProps.onContinue),
    onDiscard: () => completeReview(leave.dialogProps.onDiscard!),
    onCancel: () => completeReview(leave.dialogProps.onCancel),
  };
  function request(shell: ShellPreference, options?: { sessionId?: string | null; href?: string }) {
    requestTransition((guard) => switchShell(shell, { ...options, ...guard }));
  }
  function requestNavigation(href: string, navigate: (href: string) => void) {
    requestTransition(({ isCurrent }) => {
      if (isCurrent()) navigate(href);
    });
  }
  const visible = feedback.identity === identity && feedback.epoch === live.current.epoch;
  return {
    request,
    requestNavigation,
    requestTransition,
    isTransitionPending: () => Boolean(controller.current || review.current || leave.dialogProps.open),
    opening: visible && feedback.opening,
    error: visible ? feedback.error : null,
    dialog: createElement(DraftLeaveDialog, dialogProps),
    dialogProps,
  };
}
