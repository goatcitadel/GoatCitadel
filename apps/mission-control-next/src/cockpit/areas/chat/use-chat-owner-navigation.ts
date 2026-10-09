import { preserveChannelPlanReviewHref } from "@goatcitadel/mission-control-shared/api/channel-plan-handoff";
import { useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { canonicalJsonString, type ChatMode } from "@goatcitadel/contracts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { CockpitNavigationContext } from "../../app/cockpit-navigation-context";
import { cockpitHref, commitCockpitNavigation, readCockpitHistory } from "../../app/cockpit-history";
import { chatSelectionHref, chatSelectionMatches, type ChatLocationSelection, type ChatSelectionEvidence } from "./chat-selection-evidence";
import { useCockpitRoute } from "../../app/use-cockpit-route";

/** Review before invoking the controller; cancellation cannot change selection or create a session. */
export function useChatSelectionReview(identity: string) {
  const { requestTransition } = useCockpitRoute();
  const selection = useRef({ identity });
  if (selection.current.identity !== identity) selection.current = { identity };
  const renderedSelection = selection.current;
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return (action: () => Promise<void> | void) => requestTransition(async ({ isCurrent }) => {
    if (!isCurrent() || !mounted.current || selection.current !== renderedSelection) return;
    await action();
  });
}

/**
 * The controller has already selected these records. Publish its URL only after
 * the same mounted Chat owner renders the exact canonical selection. User exits
 * and explicit selection/creation actions retain their separate leave review.
 */
export function useChatOwnerNavigation(workspaceId: string, citadelId?: string) {
  const provider = useContext(CockpitNavigationContext);
  const available = provider !== null;
  const installation = getGatewayApiBaseUrl();
  const identity = canonicalJsonString([installation, citadelId, workspaceId]);
  const scope = useRef({ identity });
  if (scope.current.identity !== identity) scope.current = { identity };
  const renderedScope = scope.current;
  const mounted = useRef(true);
  const pending = useRef<{ selection: ChatLocationSelection; history: string; scope: object; href: string } | null>(null);
  const [, changed] = useState(0);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current = null; };
  }, []);
  const current = useCallback(() => available && mounted.current && scope.current === renderedScope &&
    getGatewayApiBaseUrl() === installation && window.location.pathname === "/chat", [available, installation, renderedScope]);
  const request = useCallback((_surface: ChatMode, selection: ChatLocationSelection = {}) => {
    if (!current()) return;
    const href = preserveChannelPlanReviewHref(chatSelectionHref(selection), window.location.search, workspaceId);
    if (cockpitHref(window.location.pathname + window.location.search + window.location.hash) === href) return;
    pending.current = { selection: { ...selection }, history: readCockpitHistory(), scope: renderedScope, href };
    changed((version) => version + 1);
  }, [current, renderedScope, workspaceId]);
  const publish = useCallback((evidence: ChatSelectionEvidence) => {
    const request = pending.current;
    if (!request) return;
    if (!current() || request.scope !== renderedScope || request.history !== readCockpitHistory()) {
      pending.current = null;
      return;
    }
    if (!chatSelectionMatches(request.selection, evidence, workspaceId)) return;
    pending.current = null;
    // No arbitrary href is accepted: the only destination is the bound current Chat selection.
    commitCockpitNavigation(request.href);
  }, [current, renderedScope, workspaceId]);
  return { request, publish };
}
