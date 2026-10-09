import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { listCitadels } from "@goatcitadel/mission-control-shared/api/citadels";
import { fetchWorkspaces } from "@goatcitadel/mission-control-shared/api/workspaces";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { hasCitadelRecord } from "../../features/native-routes/settings/directory-lifecycle-binding";
import { hasWorkspaceBinding } from "../../features/native-routes/settings/workspace-editor-state";
import { recordView } from "../data/record-view";
import { cockpitHref, readCockpitHistory, subscribeCockpitHistory } from "./cockpit-history";
import { useCockpitNavigation } from "./cockpit-navigation-context";
import { useCockpitRoute } from "./use-cockpit-route";

/** Presentation scope only. Existing owners still enforce every runtime read and mutation. */
export function useCockpitScope(
  open: boolean,
  choice: { citadelId: string; workspaceId: string },
  closePicker: () => void,
  destination?: string,
) {
  const preferences = useUiPreferences();
  const { isTransitionPending } = useCockpitNavigation();
  const { area, requestTransition } = useCockpitRoute();
  const installation = getGatewayApiBaseUrl();
  const history = useSyncExternalStore(subscribeCockpitHistory, readCockpitHistory, () => "server");
  const identity = JSON.stringify([installation, preferences.activeCitadelId, preferences.activeWorkspaceId]);
  const editorIdentity = JSON.stringify([identity, history, choice.citadelId, choice.workspaceId, open, destination]);
  const token = useRef({ identity: editorIdentity, alive: true, ownedClose: null as string | null });
  if (token.current.identity !== editorIdentity) {
    if (token.current.ownedClose === editorIdentity) {
      token.current.identity = editorIdentity;
      token.current.ownedClose = null;
    } else {
      token.current.alive = false;
      token.current = { identity: editorIdentity, alive: true, ownedClose: null };
    }
  }
  const renderedToken = token.current;
  const activeRead = useRef<{ token: typeof renderedToken; controller: AbortController } | null>(null);
  useLayoutEffect(() => {
    renderedToken.alive = true;
    return () => {
      renderedToken.alive = false;
      if (activeRead.current?.token === renderedToken) activeRead.current.controller.abort();
    };
  }, [renderedToken]);
  const [feedback, setFeedback] = useState({ token: renderedToken, busy: false, error: "" });
  const citadels = useQuery({
    queryKey: ["system", "directory", "scope-citadels", installation],
    queryFn: ({ signal }) => listCitadels("active", 500, { signal }),
    enabled: open,
    staleTime: 0,
  });
  const workspaces = useQuery({
    queryKey: ["system", "directory", "scope-workspaces", installation, choice.citadelId],
    queryFn: ({ signal }) => fetchWorkspaces("active", 500, choice.citadelId, { signal }),
    enabled: open && Boolean(choice.citadelId),
    staleTime: 0,
  });
  // The last good directory stays listed while it is read again; switching re-reads it anyway.
  const citadelView = recordView(citadels, (data) => data.items);
  const workspaceView = recordView(workspaces, (data) => data.items);
  const checking = citadelView.phase === "checking" || workspaceView.phase === "checking";
  const citadelRecords = citadelView.record;
  const workspaceRecords = workspaceView.record;
  const citadelsListed =
    Array.isArray(citadelRecords) &&
    citadelRecords.every((item) => hasCitadelRecord(item) && item.lifecycleStatus === "active") &&
    new Set(citadelRecords.map((item) => item.citadelId)).size === citadelRecords.length;
  const workspacesListed =
    Boolean(choice.citadelId) &&
    Array.isArray(workspaceRecords) &&
    workspaceRecords.every(
      (item) => hasWorkspaceBinding(item, choice.citadelId) && item.lifecycleStatus === "active",
    ) &&
    new Set(workspaceRecords.map((item) => item.workspaceId)).size === workspaceRecords.length;
  const availableCitadels = citadelsListed ? citadelRecords! : [];
  const availableWorkspaces = workspacesListed ? workspaceRecords! : [];
  function select(citadelId: string, workspaceId: string) {
    if (
      isTransitionPending() ||
      token.current !== renderedToken ||
      !renderedToken.alive ||
      renderedToken.identity !== editorIdentity ||
      getGatewayApiBaseUrl() !== installation ||
      readCockpitHistory() !== history ||
      !open ||
      choice.citadelId !== citadelId ||
      choice.workspaceId !== workspaceId ||
      !availableCitadels.some((item) => item.citadelId === citadelId) ||
      !availableWorkspaces.some((item) => item.workspaceId === workspaceId && item.citadelId === citadelId)
    )
      return;
    if (citadelId === preferences.activeCitadelId && workspaceId === preferences.activeWorkspaceId) return;
    // This single owner-commanded close allows the shared leave dialog to replace the picker.
    // Reopening, changing the choice, leaving the route/scope, or unmounting creates a new token.
    renderedToken.ownedClose = JSON.stringify([identity, history, choice.citadelId, choice.workspaceId, false, destination]);
    closePicker();
    requestTransition(async (review) => {
      const controller = new AbortController();
      const current = () =>
        review.isCurrent() &&
        !review.signal.aborted &&
        !controller.signal.aborted &&
        token.current === renderedToken &&
        renderedToken.alive &&
        getGatewayApiBaseUrl() === installation &&
        readCockpitHistory() === history;
      if (!current()) return;
      const abort = () => controller.abort();
      review.signal.addEventListener("abort", abort, { once: true });
      const read = { token: renderedToken, controller };
      activeRead.current = read;
      setFeedback({ token: renderedToken, busy: true, error: "" });
      try {
        const [freshCitadels, freshWorkspaces] = await Promise.all([
          listCitadels("active", 500, { signal: controller.signal }),
          fetchWorkspaces("active", 500, citadelId, { signal: controller.signal }),
        ]);
        if (!current()) return;
        if (
          !Array.isArray(freshCitadels.items) ||
          !freshCitadels.items.every((item) => hasCitadelRecord(item) && item.lifecycleStatus === "active") ||
          new Set(freshCitadels.items.map((item) => item.citadelId)).size !== freshCitadels.items.length ||
          !Array.isArray(freshWorkspaces.items) ||
          !freshWorkspaces.items.every(
            (item) => hasWorkspaceBinding(item, citadelId) && item.lifecycleStatus === "active",
          ) ||
          new Set(freshWorkspaces.items.map((item) => item.workspaceId)).size !== freshWorkspaces.items.length
        )
          throw new Error("The current scope directory could not be verified. Reopen the picker before switching.");
        const citadel = freshCitadels.items.find((item) => item.citadelId === citadelId);
        const workspace = freshWorkspaces.items.find((item) => item.workspaceId === workspaceId);
        if (
          !citadel ||
          !hasCitadelRecord(citadel) ||
          citadel.lifecycleStatus !== "active" ||
          !workspace ||
          !hasWorkspaceBinding(workspace, citadelId) ||
          workspace.lifecycleStatus !== "active"
        )
          throw new Error(
            "This workspace is no longer available in the selected Citadel. Reopen the scope picker and review its current directory.",
          );
        const target = new URL((destination && cockpitHref(destination)) || `/${area === "gallery" ? "chat" : area}?shell=cockpit`, window.location.origin);
        // Incoming links are requests only. Rewrite their scope after the directory review succeeds.
        if (target.searchParams.has("citadelId")) target.searchParams.set("citadelId", citadelId);
        if (target.searchParams.has("workspaceId")) target.searchParams.set("workspaceId", workspaceId);
        const href = target.pathname + target.search + target.hash;
        const sameRoute =
          cockpitHref(window.location.pathname + window.location.search + window.location.hash) === href;
        if (!sameRoute && !review.navigate(href, { replace: true })) return;
        preferences.setActiveScope({ citadelId, workspaceId });
      } catch (cause) {
        if (current()) setFeedback({ token: renderedToken, busy: false, error: describeApiError(cause).summary });
      } finally {
        review.signal.removeEventListener("abort", abort);
        if (activeRead.current === read) activeRead.current = null;
        if (current()) setFeedback((value) => (value.token === renderedToken ? { ...value, busy: false } : value));
      }
    });
    return true;
  }
  return {
    select,
    isTransitionPending,
    citadels: availableCitadels,
    workspaces: availableWorkspaces,
    ready: citadelsListed && workspacesListed && !checking && !citadels.isError && !workspaces.isError,
    loading: citadelView.phase === "loading" || workspaceView.phase === "loading",
    checking,
    directoryError:
      citadels.isError || workspaces.isError ? "The scope directory is unavailable. Reopen to retry." : "",
    busy: feedback.token === renderedToken && feedback.busy,
    error: feedback.token === renderedToken ? feedback.error : "",
  };
}
