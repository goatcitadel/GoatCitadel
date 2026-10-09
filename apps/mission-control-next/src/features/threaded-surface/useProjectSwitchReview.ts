import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";

import { getGatewayAccessRevision, subscribeGatewayAccessChange, getGatewayCallerScope, subscribeGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";

type Props = Pick<MissionThreadedActiveSessionSurfaceProps,
  "projectSwitchContext" | "selectedSessionId" | "draft" | "pendingAttachments" | "sending" |
  "hasActiveStream" | "historicalReadOnly" | "sessionControlBanner" | "editingTurnId" |
  "pendingApproval" | "pendingUserInput" | "composerPalette">;
type Item = MissionThreadedActiveSessionSurfaceProps["commandSuggestions"][number];
type Transition = (action: () => void) => void;

export function projectSwitchReviewIdentity(props: Props) {
  return JSON.stringify([getGatewayApiBaseUrl(), props.selectedSessionId, props.projectSwitchContext,
    props.draft, props.pendingAttachments, props.editingTurnId]);
}

/** Shared presentation review. Only the existing palette callback can persist an assignment. */
export function useProjectSwitchReview(props: Props, composing = false) {
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const accessRevision = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, () => 0);
  const caller = useSyncExternalStore(subscribeGatewayCallerScope, getGatewayCallerScope, () => "");
  const identity = JSON.stringify([caller, accessRevision, activeCitadelId, activeWorkspaceId, projectSwitchReviewIdentity(props)]);
  const busy = composing || props.sending || props.hasActiveStream || props.historicalReadOnly ||
    Boolean(props.sessionControlBanner || props.editingTurnId || props.pendingApproval || props.pendingUserInput ||
      props.projectSwitchContext?.mutationPending);
  const scope = useRef({ identity, busy });
  if (scope.current.identity !== identity || scope.current.busy !== busy) scope.current = { identity, busy };
  const current = useRef({ identity, props, busy });
  current.current = { identity, props, busy };
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [candidate, setCandidate] = useState<{ item: Item; scope: object; installation: string; message: string } | null>(null);
  const pending = useRef<typeof candidate>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const begin = (item: Item) => {
    if (item.action?.type !== "switch_project") return false;
    const action = item.action;
    const context = props.projectSwitchContext;
    const destination = context?.projects.find((project) => project.projectId === action.projectId);
    if (busy || !context || context.session.sessionId !== props.selectedSessionId || !destination ||
      (context.session.workspaceId ?? "default") !== context.workspaceId ||
      context.workspaceId !== activeWorkspaceId ||
      destination.lifecycleStatus !== "active" ||
      (destination.workspaceId && destination.workspaceId !== context.session.workspaceId)) {
      setNotice("Project reassignment is unavailable while this conversation is busy or its current context is unavailable. Your draft is preserved.");
      return true;
    }
    setNotice(null);
    const review = { item, scope: scope.current, installation: getGatewayApiBaseUrl(),
      message: `Switch to ${destination.name} in workspace ${context.session.workspaceId ?? "default"}? Project context for future turns will use ${destination.workspacePath || "the destination project"}. Existing turns, your current draft and attachments stay in this conversation. The Gateway resets this conversation's workbench file, worktree, diff, output and validation context. Review any draft or attached context that still refers to the previous project.` };
    pending.current = review;
    setCandidate(review);
    props.composerPalette?.onClose();
    return true;
  };
  const confirm = (transition?: Transition) => {
    const selected = pending.current;
    pending.current = null;
    setCandidate(null);
    if (!selected) return;
    const apply = () => {
      const latest = current.current;
      if (!mounted.current || latest.busy || scope.current !== selected.scope ||
        getGatewayApiBaseUrl() !== selected.installation || getGatewayAccessRevision() !== accessRevision || getGatewayCallerScope() !== caller) {
        if (mounted.current) setNotice("The conversation, project context or draft changed. Review the project again before switching.");
        return;
      }
      latest.props.composerPalette?.onSelect(selected.item);
    };
    if (transition) transition(apply);
    else apply();
  };
  return { identity, candidate, notice, begin, confirm, cancel: () => { pending.current = null; setCandidate(null); } };
}
