import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useShellHandoff } from "../../app/use-shell-handoff";
import { ShellSwitchFeedback } from "./use-cockpit-shell-switch";
import { CockpitNavigationContext, type CockpitNavigationOwner } from "./cockpit-navigation-context";
import {
  cockpitHref, commitCockpitNavigation, readCockpitHistory, retainsSettingsPage, subscribeCockpitHistory,
} from "./cockpit-history";

/** One presentation leave owner for the frame and all imperative native route callbacks. */
export function CockpitNavigationProvider({ children }: { children: ReactNode }) {
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const installation = getGatewayApiBaseUrl();
  const identity = canonicalJsonString([installation, activeCitadelId, activeWorkspaceId]);
  const history = useSyncExternalStore(subscribeCockpitHistory, readCockpitHistory, () => "server");
  const view = useRef({ identity, history });
  if (view.current.identity !== identity || view.current.history !== history) view.current = { identity, history };
  const renderedView = view.current;
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const handoff = useShellHandoff([identity, history]);
  const isCurrent = () => mounted.current && view.current === renderedView &&
    getGatewayApiBaseUrl() === installation && readCockpitHistory() === history;
  const requestTransition: CockpitNavigationOwner["requestTransition"] = (action) => {
    if (!isCurrent()) return;
    handoff.requestTransition((review) => {
      const current = () => isCurrent() && review.isCurrent() && !review.signal.aborted;
      if (!current()) return;
      return action({
        isCurrent: current,
        signal: review.signal,
        navigate: (href, options) => current() && commitCockpitNavigation(href, options),
      });
    });
  };
  const navigate: CockpitNavigationOwner["navigate"] = (href, options) => {
    const destination = cockpitHref(href);
    if (!destination || !isCurrent()) return;
    const source = window.location.pathname + window.location.search + window.location.hash;
    if (cockpitHref(source) === destination) return;
    if (retainsSettingsPage(source, destination)) {
      commitCockpitNavigation(destination, options);
      return;
    }
    requestTransition((review) => { review.navigate(destination, options); });
  };
  return (
    <CockpitNavigationContext.Provider value={{ navigate, requestTransition, isTransitionPending: handoff.isTransitionPending }}>
      {children}
      <ShellSwitchFeedback owner={handoff} />
    </CockpitNavigationContext.Provider>
  );
}
